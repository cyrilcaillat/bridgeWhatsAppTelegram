"use strict";

require("dotenv").config();

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const qrcode = require("qrcode-terminal");
const { Telegraf, Input } = require("telegraf");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { loadConfig } = require("./config");

const cfg = loadConfig();
const tg = new Telegraf(cfg.tgToken);
const topicToWa = Object.fromEntries(Object.entries(cfg.waGroupToTopic).map(([waId, topicId]) => [String(topicId), waId]));
const topicCatalog = new Map();
const recentBridgeOutboundMessages = new Map();
const waToTgMessageLinks = new Map();
const tgToWaMessageLinks = new Map();
const recentProcessedWaMessages = new Map();
const waUserDisplayMap = new Map();
const WA_USER_MAPPING_NONE = "none";
const MESSAGE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PROCESSED_WA_MESSAGE_TTL_MS = 5 * 60 * 1000;
const RECENT_OUTBOUND_TTL_MS = 2 * 60 * 1000;
const WA_RECONNECT_DELAY_MS = 5000;
const WA_RECONNECT_RETRY_DELAY_MS = 15000;
const BRIDGE_STATE_PATH = process.env.BRIDGE_STATE_PATH || "./bridge-state.json";
let lastWhatsAppGroups = [];
let waReconnectTimer = null;
let waReconnectInProgress = false;
let loadedStateSignature = null;

function computeStateSignature(raw) {
  return crypto.createHash("sha1").update(String(raw || "")).digest("hex");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeString(value) {
  return isNonEmptyString(value) ? value.trim() : "";
}

function readStateFromDisk() {
  if (!fs.existsSync(BRIDGE_STATE_PATH)) return null;

  const raw = fs.readFileSync(BRIDGE_STATE_PATH, "utf8");
  return {
    parsed: JSON.parse(raw),
    signature: computeStateSignature(raw)
  };
}

function loadState() {
  try {
    const diskState = readStateFromDisk();
    if (!diskState) return;

    const raw = diskState.parsed;
    const now = Date.now();
    loadedStateSignature = diskState.signature;

    for (const [k, v] of Object.entries(raw.messageLinks?.waToTg || {})) {
      if (v.expiresAt > now) waToTgMessageLinks.set(k, v);
    }
    for (const [k, v] of Object.entries(raw.messageLinks?.tgToWa || {})) {
      if (v.expiresAt > now) tgToWaMessageLinks.set(k, v);
    }

    let topicsLoaded = 0;
    for (const [key, entry] of Object.entries(raw.topics || {})) {
      const existing = topicCatalog.get(key);
      if (existing) {
        if (entry.name && !existing.name) {
          existing.name = entry.name;
          topicCatalog.set(key, existing);
          topicsLoaded++;
        }
      } else {
        topicCatalog.set(key, { id: key, name: entry.name || null, source: null });
        topicsLoaded++;
      }
    }

    let waUserMappingsLoaded = 0;
    for (const [jid, displayName] of Object.entries(raw.waUserMappings || {})) {
      const normalizedName = normalizeString(displayName);
      if (!jid || !normalizedName) continue;
      waUserDisplayMap.set(String(jid), normalizedName);
      waUserMappingsLoaded++;
    }

    log("info", `State loaded from ${BRIDGE_STATE_PATH} (${waToTgMessageLinks.size} message links, ${topicsLoaded} topics, ${waUserMappingsLoaded} user mappings)`);
  } catch (error) {
    log("warn", `Failed to load state from ${BRIDGE_STATE_PATH}`, error.message);
  }
}

function saveState() {
  try {
    let diskState = null;
    try {
      diskState = readStateFromDisk();
    } catch (error) {
      log("warn", `Failed to read current state from ${BRIDGE_STATE_PATH} before save`, error.message);
    }

    if (diskState && loadedStateSignature && diskState.signature !== loadedStateSignature) {
      log("warn", `State file changed on disk since load; applying safe merge for ${BRIDGE_STATE_PATH}`);
    }

    const mergedWaUserMappings = new Map(waUserDisplayMap);
    for (const [jid, displayName] of Object.entries(diskState?.parsed?.waUserMappings || {})) {
      const normalizedName = normalizeString(displayName);
      if (!jid || !normalizedName) continue;
      // Keep manual edits from disk if the file changed externally.
      mergedWaUserMappings.set(String(jid), normalizedName);
    }

    waUserDisplayMap.clear();
    for (const [jid, displayName] of mergedWaUserMappings.entries()) {
      waUserDisplayMap.set(jid, displayName);
    }

    const topics = Object.fromEntries(
      [...topicCatalog.entries()].map(([key, entry]) => [key, { id: entry.id, name: entry.name || null }])
    );

    const data = {
      topics,
      waGroups: lastWhatsAppGroups.map((g) => ({ name: g.name, id: g.id._serialized })),
      waUserMappings: Object.fromEntries(waUserDisplayMap),
      messageLinks: {
        waToTg: Object.fromEntries(waToTgMessageLinks),
        tgToWa: Object.fromEntries(tgToWaMessageLinks)
      }
    };

    const serialized = JSON.stringify(data);
    fs.writeFileSync(BRIDGE_STATE_PATH, serialized, "utf8");
    loadedStateSignature = computeStateSignature(serialized);
  } catch (error) {
    log("warn", `Failed to save state to ${BRIDGE_STATE_PATH}`, error.message);
  }
}

function isWaNoneMapping(value) {
  return normalizeString(value).toLowerCase() === WA_USER_MAPPING_NONE;
}

function resolveWhatsAppSenderName(msg, contact) {
  if (msg.fromMe) {
    return contact.pushname || contact.name || "Me";
  }

  if (contact.pushname || contact.name) {
    return contact.pushname || contact.name;
  }

  const authorJid = msg.author ? String(msg.author) : "";
  if (!authorJid) return "Unknown";

  const mappedName = waUserDisplayMap.get(authorJid);
  const normalizedMappedName = normalizeString(mappedName);
  if (normalizedMappedName) {
    return isWaNoneMapping(normalizedMappedName) ? authorJid : normalizedMappedName;
  }

  waUserDisplayMap.set(authorJid, WA_USER_MAPPING_NONE);
  saveState();
  log("info", `Unknown WhatsApp JID tracked in state file: ${authorJid}`);
  return authorJid;
}

Object.entries(cfg.waGroupToTopic).forEach(([waId, topicId]) => {
  topicCatalog.set(String(topicId), {
    id: String(topicId),
    name: null,
    source: `configured for ${waId}`
  });
});

const wa = new Client({
  authStrategy: new LocalAuth({ dataPath: ".session" }),
  puppeteer: {
    headless: cfg.headless,
    executablePath: cfg.puppeteerExecutablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  }
});

function log(level, message, meta) {
  const levels = ["error", "warn", "info", "debug"];
  if (levels.indexOf(level) > levels.indexOf(cfg.logLevel)) return;

  if (meta) {
    console.log(`[${level.toUpperCase()}] ${message}`, meta);
  } else {
    console.log(`[${level.toUpperCase()}] ${message}`);
  }
}

function escapeMarkdownV2(text) {
  if (!text) return "";
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function getWhatsAppGroups(chats) {
  return chats.filter((chat) => chat.isGroup);
}

function extractTelegramTopicName(msg) {
  return msg.forum_topic_created?.name
    || msg.reply_to_message?.forum_topic_created?.name
    || null;
}

function upsertTelegramTopic(topicId, name, source) {
  const key = String(topicId);
  const existing = topicCatalog.get(key);

  if (!existing) {
    topicCatalog.set(key, {
      id: key,
      name: name || null,
      source: source || null
    });
    saveState();
    return;
  }

  let changed = false;

  if (name && !existing.name) {
    existing.name = name;
    changed = true;
  }

  if (source && existing.source !== source) {
    existing.source = source;
    changed = true;
  }

  if (changed) {
    topicCatalog.set(key, existing);
    saveState();
  }
}

function rememberBridgeOutboundMessage(waGroupId, text) {
  const key = String(waGroupId);
  const queue = recentBridgeOutboundMessages.get(key) || [];

  queue.push({
    text: text || "",
    expiresAt: Date.now() + RECENT_OUTBOUND_TTL_MS
  });

  recentBridgeOutboundMessages.set(key, queue);
}

function isRecentBridgeOutboundMessage(waGroupId, text) {
  const key = String(waGroupId);
  const now = Date.now();
  const queue = (recentBridgeOutboundMessages.get(key) || []).filter((entry) => entry.expiresAt > now);

  if (queue.length === 0) {
    recentBridgeOutboundMessages.delete(key);
    return false;
  }

  const matchIndex = queue.findIndex((entry) => entry.text === (text || ""));

  if (matchIndex === -1) {
    recentBridgeOutboundMessages.set(key, queue);
    return false;
  }

  queue.splice(matchIndex, 1);

  if (queue.length === 0) {
    recentBridgeOutboundMessages.delete(key);
  } else {
    recentBridgeOutboundMessages.set(key, queue);
  }

  return true;
}

function buildWaMessageKey(waGroupId, waMessageId) {
  return `${String(waGroupId)}:${String(waMessageId)}`;
}

function extractWaStableMessageId(waMessageIdOrObject) {
  if (!waMessageIdOrObject) return null;

  if (typeof waMessageIdOrObject === "object") {
    if (waMessageIdOrObject.id) return String(waMessageIdOrObject.id);
    if (waMessageIdOrObject._serialized) return extractWaStableMessageId(waMessageIdOrObject._serialized);
    return null;
  }

  const serialized = String(waMessageIdOrObject);
  const parts = serialized.split("_");

  if (parts.length >= 3 && (parts[0] === "true" || parts[0] === "false")) {
    return parts[2] || null;
  }

  return null;
}

function buildTgMessageKey(tgMessageId) {
  return `${String(cfg.tgGroupId)}:${String(tgMessageId)}`;
}

function pruneExpiredMessageLinks() {
  const now = Date.now();

  for (const [key, value] of waToTgMessageLinks.entries()) {
    if (value.expiresAt <= now) waToTgMessageLinks.delete(key);
  }

  for (const [key, value] of tgToWaMessageLinks.entries()) {
    if (value.expiresAt <= now) tgToWaMessageLinks.delete(key);
  }
}

function pruneRecentProcessedWaMessages() {
  const now = Date.now();

  for (const [key, expiresAt] of recentProcessedWaMessages.entries()) {
    if (expiresAt <= now) recentProcessedWaMessages.delete(key);
  }
}

function shouldProcessWaMessage(msg) {
  const msgId = msg?.id?._serialized;
  if (!msgId) return true;

  pruneRecentProcessedWaMessages();

  if (recentProcessedWaMessages.has(msgId)) {
    return false;
  }

  recentProcessedWaMessages.set(msgId, Date.now() + PROCESSED_WA_MESSAGE_TTL_MS);
  return true;
}

function isDetachedFrameError(error) {
  return String(error?.message || "").includes("detached Frame");
}

function scheduleWhatsAppReconnect(reason) {
  if (waReconnectTimer || waReconnectInProgress) {
    log("warn", `WhatsApp reconnect already scheduled/in progress (${reason})`);
    return;
  }

  waReconnectTimer = setTimeout(async () => {
    waReconnectTimer = null;
    waReconnectInProgress = true;
    let retryDelayMs = 0;

    try {
      log("warn", `Reinitializing WhatsApp client (${reason})`);
      await wa.destroy().catch(() => undefined);
      await wa.initialize();
    } catch (error) {
      log("error", "WhatsApp reinitialization failed", error.message);
        retryDelayMs = WA_RECONNECT_RETRY_DELAY_MS;
    } finally {
      waReconnectInProgress = false;
    }

    if (retryDelayMs > 0) {
      waReconnectTimer = setTimeout(() => {
        waReconnectTimer = null;
        scheduleWhatsAppReconnect("retry_after_failed_reinit");
      }, retryDelayMs);
      waReconnectTimer.unref?.();
    }
  }, WA_RECONNECT_DELAY_MS);

  waReconnectTimer.unref?.();
}

function rememberMessageLink(waGroupId, waMessageId, topicId, tgMessageId, waStableMessageId) {
  if (!waMessageId || !tgMessageId) return;

  pruneExpiredMessageLinks();

  const expiresAt = Date.now() + MESSAGE_LINK_TTL_MS;
  const waKey = buildWaMessageKey(waGroupId, waMessageId);
  const tgKey = buildTgMessageKey(tgMessageId);
  const stableId = waStableMessageId || extractWaStableMessageId(waMessageId);

  waToTgMessageLinks.set(waKey, {
    topicId: String(topicId),
    tgMessageId,
    expiresAt
  });

  if (stableId) {
    waToTgMessageLinks.set(buildWaMessageKey(waGroupId, `id:${stableId}`), {
      topicId: String(topicId),
      tgMessageId,
      expiresAt
    });
  }

  tgToWaMessageLinks.set(tgKey, {
    waGroupId: String(waGroupId),
    waMessageId,
    expiresAt
  });

  saveState();
}

async function resolveTelegramReplyMessageId(msg) {
  if (!msg.hasQuotedMsg) return null;

  const waGroupId = msg.from?.endsWith("@g.us")
    ? msg.from
    : (msg.to?.endsWith("@g.us") ? msg.to : null);
  if (!waGroupId) return null;

  try {
    const quoted = await msg.getQuotedMessage();
    const quotedWaMessageId = quoted?.id?._serialized;
    if (!quotedWaMessageId) return null;

    pruneExpiredMessageLinks();

    const quotedStableId = extractWaStableMessageId(quoted);
    const link = waToTgMessageLinks.get(buildWaMessageKey(waGroupId, quotedWaMessageId))
      || (quotedStableId ? waToTgMessageLinks.get(buildWaMessageKey(waGroupId, `id:${quotedStableId}`)) : null);
    return link?.tgMessageId || null;
  } catch (error) {
    log("debug", "Failed to resolve Telegram reply target from WhatsApp message", error.message);
    return null;
  }
}

function resolveWhatsAppQuotedMessageId(tgMsg, waGroupId) {
  const replied = tgMsg.reply_to_message;
  if (!replied?.message_id) return null;

  pruneExpiredMessageLinks();

  const link = tgToWaMessageLinks.get(buildTgMessageKey(replied.message_id));
  if (!link) return null;
  if (String(link.waGroupId) !== String(waGroupId)) return null;

  return link.waMessageId;
}

function extractWaGroupIdFromSerializedMessageId(serializedId) {
  if (!serializedId) return null;
  const parts = String(serializedId).split("_");
  if (parts.length < 2) return null;
  const maybeGroupId = parts[1];
  return maybeGroupId.endsWith("@g.us") ? maybeGroupId : null;
}

function extractWaMessageInfoFromReaction(reaction) {
  const parentMsgId = reaction?.msgId;
  if (!parentMsgId) return { waGroupId: null, waMessageId: null };

  const waMessageId = parentMsgId._serialized || null;
  const waGroupId = parentMsgId.remote?._serialized
    || parentMsgId.remote
    || extractWaGroupIdFromSerializedMessageId(waMessageId);

  return {
    waGroupId: waGroupId ? String(waGroupId) : null,
    waMessageId: waMessageId ? String(waMessageId) : null
  };
}

function extractTelegramEmojiReaction(reactions) {
  const emojiReaction = (reactions || []).find((entry) => entry?.type === "emoji" && entry?.emoji);
  return emojiReaction?.emoji || "";
}

async function relayWhatsAppReactionToTelegram(reaction) {
  try {
    const { waGroupId, waMessageId } = extractWaMessageInfoFromReaction(reaction);
    if (!waGroupId || !waMessageId) return;
    if (!waGroupId.endsWith("@g.us")) return;

    const topicId = cfg.waGroupToTopic[waGroupId];
    if (!topicId) return;

    pruneExpiredMessageLinks();
    const stableId = extractWaStableMessageId(reaction?.msgId);
    const link = waToTgMessageLinks.get(buildWaMessageKey(waGroupId, waMessageId))
      || (stableId ? waToTgMessageLinks.get(buildWaMessageKey(waGroupId, `id:${stableId}`)) : null);
    if (!link?.tgMessageId) return;

    const emoji = reaction?.reaction || "";
    const tgReaction = emoji ? [{ type: "emoji", emoji }] : [];

    await tg.telegram.setMessageReaction(cfg.tgGroupId, link.tgMessageId, tgReaction);
  } catch (error) {
    log("warn", "Failed to relay reaction from WhatsApp to Telegram", error.message);
  }
}

async function relayTelegramReactionToWhatsApp(ctx) {
  const reactionUpdate = ctx.update?.message_reaction;
  if (!reactionUpdate) return;
  if (String(reactionUpdate.chat?.id) !== String(cfg.tgGroupId)) return;
  if (reactionUpdate.user?.is_bot) return;

  pruneExpiredMessageLinks();

  const link = tgToWaMessageLinks.get(buildTgMessageKey(reactionUpdate.message_id));
  if (!link?.waMessageId) {
    log("debug", `No WA mapping found for Telegram reaction target message ${reactionUpdate.message_id}`);
    return;
  }

  const emoji = extractTelegramEmojiReaction(reactionUpdate.new_reaction);

  try {
    await wa.sendReaction(link.waMessageId, emoji);
    log("debug", `Reaction relayed Telegram -> WhatsApp for message ${reactionUpdate.message_id}`);
  } catch (error) {
    log("warn", "Failed to relay reaction from Telegram to WhatsApp", error.message);
  }
}

async function relayWhatsAppMessageToTelegram(msg) {
  const waGroupId = msg.from?.endsWith("@g.us")
    ? msg.from
    : (msg.to?.endsWith("@g.us") ? msg.to : null);
  if (!waGroupId) return;

  const topicId = cfg.waGroupToTopic[waGroupId];
  if (!topicId) return;

  const rawText = msg.body || msg.caption || "";
  const hasRelayablePayload = msg.hasMedia || Boolean(rawText);
  if (!hasRelayablePayload) return;

  if (msg.fromMe && isRecentBridgeOutboundMessage(waGroupId, rawText)) {
    return;
  }

  if (!shouldProcessWaMessage(msg)) return;

  try {
    const replyToMessageId = await resolveTelegramReplyMessageId(msg);
    const contact = await msg.getContact();
    const sender = resolveWhatsAppSenderName(msg, contact);
    const safeSender = escapeMarkdownV2(sender.replace("@c.us", ""));
    const safeBody = escapeMarkdownV2(rawText);
    const prefix = `*${safeSender}*`;
    let sentTelegramMessage = null;

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      sentTelegramMessage = await sendMediaToTelegram(topicId, media, prefix, replyToMessageId);

      // Captions from some WhatsApp media types can be flaky on Telegram.
      // Send text as a separate message replying to the media to keep content visible.
      if (safeBody && sentTelegramMessage?.message_id) {
        await sendToTelegramTopic(topicId, `${prefix}\n${safeBody}`, sentTelegramMessage.message_id);
      }
    } else if (rawText) {
      sentTelegramMessage = await sendToTelegramTopic(topicId, `${prefix}\n${safeBody}`, replyToMessageId);
    }

    if (sentTelegramMessage?.message_id && msg.id?._serialized) {
      rememberMessageLink(waGroupId, msg.id._serialized, topicId, sentTelegramMessage.message_id, msg.id?.id);
    }
  } catch (error) {
    log("error", "Failed to relay message from WhatsApp to Telegram", error.message);
  }
}

async function refreshWhatsAppGroupsSnapshot() {
  const chats = await wa.getChats();
  const groups = getWhatsAppGroups(chats);
  lastWhatsAppGroups = groups;

  log("info", "Detected WhatsApp groups:");
  groups.forEach((group) => {
    log("info", `${group.name} => ${group.id._serialized}`);
  });

  saveState();
  log("info", "WhatsApp groups state updated in bridge-state.json");
}

async function sendToTelegramTopic(topicId, text, replyToMessageId) {
  return tg.telegram.sendMessage(cfg.tgGroupId, text, {
    message_thread_id: topicId,
    reply_to_message_id: replyToMessageId || undefined,
    parse_mode: "MarkdownV2"
  });
}

async function sendMediaToTelegram(topicId, media, caption, replyToMessageId) {
  const ext = media.mimetype.split("/")[1]?.split(";")[0] || "bin";
  const filePath = path.join(os.tmpdir(), `wa-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);

  fs.writeFileSync(filePath, Buffer.from(media.data, "base64"));

  const opts = {
    message_thread_id: topicId,
    reply_to_message_id: replyToMessageId || undefined,
    caption,
    parse_mode: "MarkdownV2"
  };

  try {
    if (media.mimetype.startsWith("image/")) {
      return await tg.telegram.sendPhoto(cfg.tgGroupId, Input.fromLocalFile(filePath), opts);
    } else if (media.mimetype.startsWith("video/")) {
      return await tg.telegram.sendVideo(cfg.tgGroupId, Input.fromLocalFile(filePath), opts);
    } else if (media.mimetype.startsWith("audio/") || media.mimetype === "application/ogg") {
      return await tg.telegram.sendVoice(cfg.tgGroupId, Input.fromLocalFile(filePath), opts);
    } else {
      return await tg.telegram.sendDocument(cfg.tgGroupId, Input.fromLocalFile(filePath), opts);
    }
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

async function sendWhatsAppReadReceiptIfEnabled(waGroupId, tgMsg) {
  if (!cfg.tgToWaSendReadReceiptOnActivity) return;
  if (tgMsg.from?.is_bot) return;

  try {
    await wa.sendSeen(waGroupId);
    log("debug", `Read receipt sent to WhatsApp group ${waGroupId}`);
  } catch (error) {
    log("warn", `Failed to send read receipt to WhatsApp group ${waGroupId}`, error.message);
  }
}

loadState();

wa.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
  log("info", "Scan the QR code in WhatsApp > Linked devices.");
});

wa.on("ready", async () => {
  log("info", "WhatsApp client is ready.");
  try {
    await refreshWhatsAppGroupsSnapshot();
  } catch (error) {
    if (isDetachedFrameError(error)) {
      log("warn", "WhatsApp groups snapshot skipped because browser frame was reloaded");
    } else {
      throw error;
    }
  }

  await tg.telegram.sendMessage(
    cfg.tgGroupId,
    "Bridge WhatsApp <-> Telegram is running."
  );
});

wa.on("message_create", relayWhatsAppMessageToTelegram);
wa.on("message", relayWhatsAppMessageToTelegram);
wa.on("message_reaction", relayWhatsAppReactionToTelegram);
wa.on("disconnected", (reason) => {
  log("warn", "WhatsApp disconnected", reason);
  scheduleWhatsAppReconnect(`disconnected: ${reason || "unknown"}`);
});
wa.on("auth_failure", (message) => {
  log("error", "WhatsApp auth failure", message);
  scheduleWhatsAppReconnect("auth_failure");
});
wa.on("change_state", (state) => {
  log("info", `WhatsApp state changed to ${state}`);
  if (["UNPAIRED", "UNPAIRED_IDLE", "CONFLICT", "TIMEOUT"].includes(String(state))) {
    scheduleWhatsAppReconnect(`state: ${state}`);
  }
});

tg.on("message", async (ctx) => {
  const tgMsg = ctx.message;
  if (String(tgMsg.chat.id) !== String(cfg.tgGroupId)) return;

  const topicId = tgMsg.message_thread_id;
  if (!topicId) return;

  const topicName = extractTelegramTopicName(tgMsg);
  upsertTelegramTopic(topicId, topicName, "detected from Telegram messages");

  const waGroupId = topicToWa[String(topicId)];
  if (!waGroupId) return;

  await sendWhatsAppReadReceiptIfEnabled(waGroupId, tgMsg);

  const text = tgMsg.text || tgMsg.caption || "";
  const profileName = [tgMsg.from?.first_name, tgMsg.from?.last_name].filter(Boolean).join(" ").trim();
  const fromName = profileName || (tgMsg.from?.username ? `@${tgMsg.from.username}` : "Telegram");
  const senderText = cfg.tgToWaIncludeUsername ? (text ? `${fromName}: ${text}` : fromName) : text;
  const bridgedText = cfg.tgToWaIncludePrefix
    ? `${cfg.tgToWaPrefix}${senderText ? ` ${senderText}` : ""}`
    : senderText;
  const quotedMessageId = resolveWhatsAppQuotedMessageId(tgMsg, waGroupId);

  try {
    let sentWhatsAppMessage = null;

    if (tgMsg.photo) {
      const fileId = tgMsg.photo[tgMsg.photo.length - 1].file_id;
      const fileUrl = await tg.telegram.getFileLink(fileId);
      const media = await MessageMedia.fromUrl(fileUrl.toString());
      rememberBridgeOutboundMessage(waGroupId, bridgedText);
      sentWhatsAppMessage = await wa.sendMessage(waGroupId, media, {
        caption: bridgedText,
        quotedMessageId: quotedMessageId || undefined
      });
    } else if (tgMsg.document || tgMsg.video || tgMsg.audio || tgMsg.voice) {
      const file = tgMsg.document || tgMsg.video || tgMsg.audio || tgMsg.voice;
      const fileUrl = await tg.telegram.getFileLink(file.file_id);
      const media = await MessageMedia.fromUrl(fileUrl.toString());
      rememberBridgeOutboundMessage(waGroupId, bridgedText);
      sentWhatsAppMessage = await wa.sendMessage(waGroupId, media, {
        caption: bridgedText,
        quotedMessageId: quotedMessageId || undefined
      });
    } else if (text) {
      rememberBridgeOutboundMessage(waGroupId, bridgedText);
      sentWhatsAppMessage = await wa.sendMessage(
        waGroupId,
        bridgedText,
        quotedMessageId ? { quotedMessageId } : undefined
      );
    }

    if (sentWhatsAppMessage?.id?._serialized && tgMsg.message_id) {
      rememberMessageLink(waGroupId, sentWhatsAppMessage.id._serialized, topicId, tgMsg.message_id, sentWhatsAppMessage.id?.id);
    }
  } catch (error) {
    log("error", "Failed to relay message from Telegram to WhatsApp", error.message);
  }
});

tg.on("message_reaction", relayTelegramReactionToWhatsApp);

tg.catch((error) => {
  log("error", "Telegram handler error", error.message);
});

tg.launch({
  allowedUpdates: ["message", "message_reaction"]
}).catch((error) => {
  log("error", "Telegram initialization failed", error.message);
  process.exitCode = 1;
});

process.once("SIGINT", () => {
  tg.stop("SIGINT");
});

process.once("SIGTERM", () => {
  tg.stop("SIGTERM");
});

wa.initialize().catch((error) => {
  log("error", "WhatsApp initialization failed", error.message);
  scheduleWhatsAppReconnect("initialization_failure");
});
