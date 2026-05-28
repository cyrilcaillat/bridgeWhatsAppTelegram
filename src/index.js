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
const tg = new Telegraf(
  cfg.tgToken,
  cfg.tgApiBaseUrl ? { telegram: { apiRoot: cfg.tgApiBaseUrl } } : undefined
);
const topicToWaGroups = Object.entries(cfg.waGroupToTopic).reduce((acc, [waId, topicId]) => {
  const key = String(topicId);
  const groups = acc[key] || [];
  groups.push(waId);
  acc[key] = groups;
  return acc;
}, {});
const topicCatalog = new Map();
const waGroupLastMessageAt = new Map();
const waGroupNameOverrides = new Map();
const recentBridgeOutboundMessages = new Map();
const waToTgMessageLinks = new Map();
const tgToWaMessageLinks = new Map();
const recentProcessedWaMessages = new Map();
const waUserDisplayMap = new Map();
const WA_USER_MAPPING_NONE = "none";
const MESSAGE_LINK_TTL_MS = cfg.messageLinkTtlMs;
const PROCESSED_WA_MESSAGE_TTL_MS = cfg.processedWaMessageTtlMs;
const RECENT_OUTBOUND_TTL_MS = cfg.recentOutboundTtlMs;
const WA_RECONNECT_DELAY_MS = cfg.waReconnectDelayMs;
const WA_RECONNECT_RETRY_DELAY_MS = cfg.waReconnectRetryDelayMs;
const WA_BACKFILL_WINDOW_MS = cfg.waBackfillWindowMs;
const WA_BACKFILL_LIMIT = cfg.waBackfillLimit;
const WA_BACKFILL_SEND_DELAY_MS = cfg.waBackfillSendDelayMs;
const BRIDGE_STATE_PATH = cfg.bridgeStatePath;
const WA_READY_WAIT_TIMEOUT_MS = Math.max(WA_RECONNECT_DELAY_MS + WA_RECONNECT_RETRY_DELAY_MS + 10000, 30000);
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

function normalizeIsoTimestamp(value) {
  if (!value) return null;
  const asString = String(value);
  const parsed = Date.parse(asString);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
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
          topicsLoaded++;
        }

        const normalizedLastMessageAt = normalizeIsoTimestamp(entry.lastMessageAt);
        if (normalizedLastMessageAt && existing.lastMessageAt !== normalizedLastMessageAt) {
          existing.lastMessageAt = normalizedLastMessageAt;
          topicsLoaded++;
        }

        topicCatalog.set(key, existing);
      } else {
        topicCatalog.set(key, {
          id: key,
          name: entry.name || null,
          source: null,
          lastMessageAt: normalizeIsoTimestamp(entry.lastMessageAt)
        });
        topicsLoaded++;
      }
    }

    for (const entry of raw.waGroups || []) {
      const groupId = String(entry?.id || "");
      if (!groupId) continue;
      const normalizedLastMessageAt = normalizeIsoTimestamp(entry?.lastMessageAt);
      if (normalizedLastMessageAt) waGroupLastMessageAt.set(groupId, normalizedLastMessageAt);
      const groupName = normalizeString(entry?.name);
      if (groupName) waGroupNameOverrides.set(groupId, groupName);
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

    // Merge manual topic name edits from disk.
    for (const [key, diskEntry] of Object.entries(diskState?.parsed?.topics || {})) {
      const diskName = normalizeString(diskEntry?.name);
      if (!diskName) continue;
      const existing = topicCatalog.get(key);
      if (existing && existing.name !== diskName) {
        existing.name = diskName;
        topicCatalog.set(key, existing);
      }
    }

    // Merge manual group name edits from disk.
    for (const diskGroup of diskState?.parsed?.waGroups || []) {
      const diskGroupId = String(diskGroup?.id || "");
      const diskGroupName = normalizeString(diskGroup?.name);
      if (diskGroupId && diskGroupName) {
        waGroupNameOverrides.set(diskGroupId, diskGroupName);
      }
    }

    const topics = Object.fromEntries(
      [...topicCatalog.entries()].map(([key, entry]) => [key, {
        id: entry.id,
        name: entry.name || null,
        lastMessageAt: entry.lastMessageAt || null
      }])
    );

    const data = {
      topics,
      waGroups: lastWhatsAppGroups.map((g) => {
        const groupId = String(g.id._serialized);
        return {
          name: waGroupNameOverrides.get(groupId) || g.name,
          id: groupId,
          lastMessageAt: waGroupLastMessageAt.get(groupId) || null
        };
      }),
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
    source: `configured for ${waId}`,
    lastMessageAt: null
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
      source: source || null,
      lastMessageAt: null
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

async function resolveWhatsAppGroupName(waGroupId) {
  try {
    const chat = await wa.getChatById(waGroupId);
    if (chat?.name) return chat.name;
  } catch (error) {
    log("debug", "Failed to resolve WhatsApp group name", { waGroupId, message: error.message });
  }
  return waGroupId.replace("@g.us", "");
}

async function createTelegramTopicForGroup(waGroupId) {
  const topicName = await resolveWhatsAppGroupName(waGroupId);

  const result = await callTelegramWithRetry(
    () => tg.telegram.createForumTopic(cfg.tgGroupId, topicName),
    `create_topic:${waGroupId}`
  );

  const newTopicId = result.message_thread_id;
  log("info", "Auto-created Telegram topic for unmapped WhatsApp group", {
    waGroupId,
    topicId: newTopicId,
    topicName
  });

  cfg.waGroupToTopic[waGroupId] = newTopicId;

  const key = String(newTopicId);
  const groups = topicToWaGroups[key] || [];
  groups.push(waGroupId);
  topicToWaGroups[key] = groups;

  upsertTelegramTopic(newTopicId, topicName, `auto-created for ${waGroupId}`);

  return newTopicId;
}

function rememberRecentGroupAndTopicActivity(waGroupId, topicId, timestampMs = Date.now()) {
  const normalizedTimestamp = new Date(Number.isFinite(timestampMs) ? timestampMs : Date.now()).toISOString();
  const groupKey = String(waGroupId || "");
  const topicKey = String(topicId || "");

  let changed = false;

  if (groupKey && waGroupLastMessageAt.get(groupKey) !== normalizedTimestamp) {
    waGroupLastMessageAt.set(groupKey, normalizedTimestamp);
    changed = true;
  }

  if (topicKey) {
    const existingTopic = topicCatalog.get(topicKey);
    if (existingTopic && existingTopic.lastMessageAt !== normalizedTimestamp) {
      existingTopic.lastMessageAt = normalizedTimestamp;
      topicCatalog.set(topicKey, existingTopic);
      changed = true;
    }
  }

  if (changed) saveState();
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
  const fallbackKey = [
    msg?.from || "",
    msg?.to || "",
    msg?.author || "",
    msg?.timestamp || "",
    msg?.type || "",
    msg?.body || msg?.caption || "",
    msg?.hasMedia ? "1" : "0"
  ].join("|");
  const processingKey = msgId || `fallback:${fallbackKey}`;

  pruneRecentProcessedWaMessages();

  if (recentProcessedWaMessages.has(processingKey)) {
    return false;
  }

  recentProcessedWaMessages.set(processingKey, Date.now() + PROCESSED_WA_MESSAGE_TTL_MS);
  return true;
}

function summarizeWaMessage(msg) {
  return {
    id: msg?.id?._serialized || null,
    from: msg?.from || null,
    to: msg?.to || null,
    author: msg?.author || null,
    fromMe: Boolean(msg?.fromMe),
    type: msg?.type || null,
    hasMedia: Boolean(msg?.hasMedia),
    bodyLength: (msg?.body || msg?.caption || "").length
  };
}

function isDetachedFrameError(error) {
  return String(error?.message || "").includes("detached Frame");
}

function isWhatsAppRecoverableError(error) {
  const message = String(error?.message || "");
  return isDetachedFrameError(error)
    || message.includes("Cannot read properties of null (reading 'evaluate')")
    || message.includes("Execution context was destroyed")
    || message.includes("Target closed");
}

function isTelegramPayloadTooLargeError(error) {
  const message = String(error?.message || "");
  return message.includes("413") || message.toLowerCase().includes("request entity too large");
}

function isTelegramRetryAfterError(error) {
  return Number(error?.response?.error_code) === 429 || Number(error?.code) === 429;
}

function getTelegramRetryDelayMs(error) {
  const retryAfterSeconds = Number(error?.response?.parameters?.retry_after);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  return 1000;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callTelegramWithRetry(action, reason) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (!isTelegramRetryAfterError(error) || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = getTelegramRetryDelayMs(error);
      log("warn", `Telegram rate limit hit during ${reason}; retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`);
      await wait(delayMs);
    }
  }

  throw new Error(`Telegram retry loop exhausted during ${reason}`);
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

function waitForWhatsAppReady() {
  return new Promise((resolve, reject) => {
    const handleReady = () => {
      clearTimeout(timeout);
      wa.off("ready", handleReady);
      resolve();
    };

    const timeout = setTimeout(() => {
      wa.off("ready", handleReady);
      reject(new Error(`Timed out waiting for WhatsApp client readiness after ${WA_READY_WAIT_TIMEOUT_MS}ms`));
    }, WA_READY_WAIT_TIMEOUT_MS);

    wa.once("ready", handleReady);
  });
}

async function runWithWhatsAppRecovery(action, reason) {
  try {
    return await action();
  } catch (error) {
    if (!isWhatsAppRecoverableError(error)) throw error;

    log("warn", `Recoverable WhatsApp client failure during ${reason}; reconnect scheduled`, error.message);
    scheduleWhatsAppReconnect(reason);
    await waitForWhatsAppReady();
    return action();
  }
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

  const existingTgLinks = tgToWaMessageLinks.get(tgKey);
  const normalizedTgLinks = Array.isArray(existingTgLinks)
    ? existingTgLinks.filter((entry) => entry?.waGroupId && entry?.waMessageId)
    : (existingTgLinks?.waGroupId && existingTgLinks?.waMessageId ? [existingTgLinks] : []);
  const nextTgLinks = normalizedTgLinks.filter((entry) => String(entry.waGroupId) !== String(waGroupId));

  nextTgLinks.push({
    waGroupId: String(waGroupId),
    waMessageId,
    expiresAt
  });

  tgToWaMessageLinks.set(tgKey, nextTgLinks);

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

  const links = Array.isArray(link) ? link : [link];
  const matchingLink = links.find((entry) => String(entry?.waGroupId) === String(waGroupId));

  return matchingLink?.waMessageId || null;
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
  const links = Array.isArray(link) ? link : (link ? [link] : []);
  const targetLinks = links.filter((entry) => entry?.waMessageId);

  if (targetLinks.length === 0) {
    log("debug", `No WA mapping found for Telegram reaction target message ${reactionUpdate.message_id}`);
    return;
  }

  const emoji = extractTelegramEmojiReaction(reactionUpdate.new_reaction);

  try {
    await Promise.all(targetLinks.map((entry) => runWithWhatsAppRecovery(
      () => wa.sendReaction(entry.waMessageId, emoji),
      `relay_reaction:${entry.waGroupId}:${reactionUpdate.message_id}`
    )));
    log("debug", `Reaction relayed Telegram -> WhatsApp for message ${reactionUpdate.message_id}`);
  } catch (error) {
    log("warn", "Failed to relay reaction from Telegram to WhatsApp", error.message);
  }
}

async function relayWhatsAppMessageToTelegram(msg, source = "unknown") {
  log("debug", "WA->TG event received", { source, ...summarizeWaMessage(msg) });

  const waGroupId = msg.from?.endsWith("@g.us")
    ? msg.from
    : (msg.to?.endsWith("@g.us") ? msg.to : null);
  if (!waGroupId) {
    log("debug", "WA->TG skip: message is not tied to a mapped group", { source, ...summarizeWaMessage(msg) });
    return;
  }

  let topicId = cfg.waGroupToTopic[waGroupId];
  if (!topicId) {
    try {
      topicId = await createTelegramTopicForGroup(waGroupId);
    } catch (error) {
      log("error", "Failed to auto-create Telegram topic for unmapped group", {
        source,
        waGroupId,
        message: error.message,
        ...summarizeWaMessage(msg)
      });
      return;
    }
  }

  const rawText = msg.body || msg.caption || "";
  const hasRelayablePayload = msg.hasMedia || Boolean(rawText);
  if (!hasRelayablePayload) {
    log("debug", "WA->TG skip: no relayable payload", { source, waGroupId, ...summarizeWaMessage(msg) });
    return;
  }

  rememberRecentGroupAndTopicActivity(waGroupId, topicId, (msg?.timestamp || 0) * 1000 || Date.now());

  if (msg.fromMe && isRecentBridgeOutboundMessage(waGroupId, rawText)) {
    log("debug", "WA->TG skip: detected recent bridge outbound echo", { source, waGroupId, ...summarizeWaMessage(msg) });
    return;
  }

  if (!shouldProcessWaMessage(msg)) {
    log("debug", "WA->TG skip: duplicate event id in debounce window", { source, waGroupId, ...summarizeWaMessage(msg) });
    return;
  }

  try {
    const replyToMessageId = await resolveTelegramReplyMessageId(msg);
    let contact = null;
    try {
      if (!msg.fromMe) {
        contact = await msg.getContact();
      }
    } catch (contactError) {
      log("warn", "WA contact lookup failed, using sender fallback", {
        source,
        waGroupId,
        waMessageId: msg.id?._serialized || null,
        message: contactError.message
      });
    }

    const sender = contact
      ? resolveWhatsAppSenderName(msg, contact)
      : (msg.fromMe ? "Me" : (msg.author || msg.from || "Unknown"));
    const safeSender = escapeMarkdownV2(sender.replace("@c.us", ""));
    const safeBody = escapeMarkdownV2(rawText);
    const prefix = `*${safeSender}*`;
    let sentTelegramMessage = null;

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      try {
        sentTelegramMessage = await sendMediaToTelegram(topicId, media, prefix, replyToMessageId);
      } catch (error) {
        if (!isTelegramPayloadTooLargeError(error)) throw error;

        const fallbackNotice = escapeMarkdownV2("Media non transfere: fichier trop volumineux (Telegram 413)");
        const fallbackText = safeBody
          ? `${prefix}\n${fallbackNotice}\n${safeBody}`
          : `${prefix}\n${fallbackNotice}`;

        sentTelegramMessage = await sendToTelegramTopic(topicId, fallbackText, replyToMessageId);
        log("warn", "WA->TG media fallback applied after Telegram 413", {
          source,
          waGroupId,
          topicId,
          waMessageId: msg.id?._serialized || null,
          mediaType: msg.type || null
        });
      }

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

    log("debug", "WA->TG relayed", {
      source,
      waGroupId,
      topicId,
      waMessageId: msg.id?._serialized || null,
      tgMessageId: sentTelegramMessage?.message_id || null,
      ...summarizeWaMessage(msg)
    });
  } catch (error) {
    log("error", "Failed to relay message from WhatsApp to Telegram", {
      source,
      waGroupId,
      topicId,
      message: error.message,
      ...summarizeWaMessage(msg)
    });
  }
}

async function backfillRecentWhatsAppMessages(passLabel = "initial") {
  const minTimestampMs = Date.now() - WA_BACKFILL_WINDOW_MS;
  let relayedCount = 0;

  pruneExpiredMessageLinks();

  for (const waGroupId of Object.keys(cfg.waGroupToTopic)) {
    try {
      const chat = await runWithWhatsAppRecovery(
        () => wa.getChatById(waGroupId),
        `backfill_get_chat:${passLabel}:${waGroupId}`
      );
      const messages = await chat.fetchMessages({ limit: WA_BACKFILL_LIMIT });
      const recentMessages = messages
        .filter((msg) => (msg.timestamp * 1000) >= minTimestampMs)
        .sort((a, b) => a.timestamp - b.timestamp);
      let groupRelayedCount = 0;

      log("debug", "WA backfill scan", {
        pass: passLabel,
        waGroupId,
        fetchedCount: messages.length,
        inWindowCount: recentMessages.length,
        windowMs: WA_BACKFILL_WINDOW_MS,
        limit: WA_BACKFILL_LIMIT
      });

      for (const msg of recentMessages) {
        const waMessageId = msg.id?._serialized;
        if (!waMessageId) continue;

        const stableId = extractWaStableMessageId(waMessageId);
        const existingLink = waToTgMessageLinks.get(buildWaMessageKey(waGroupId, waMessageId))
          || (stableId ? waToTgMessageLinks.get(buildWaMessageKey(waGroupId, `id:${stableId}`)) : null);

        if (existingLink?.tgMessageId) continue;

        await relayWhatsAppMessageToTelegram(msg, `backfill:${passLabel}`);
        relayedCount += 1;
        groupRelayedCount += 1;
        if (WA_BACKFILL_SEND_DELAY_MS > 0) await wait(WA_BACKFILL_SEND_DELAY_MS);
      }

      log("debug", "WA backfill group completed", {
        pass: passLabel,
        waGroupId,
        relayedCount: groupRelayedCount
      });
    } catch (error) {
      log("warn", `Failed to backfill messages for ${waGroupId}`, error.message);
    }
  }

  log("info", `WhatsApp backfill (${passLabel}) completed (${relayedCount} message(s) relayed).`);
}

async function runStartupBackfill() {
  await backfillRecentWhatsAppMessages("initial");
}

async function refreshWhatsAppGroupsSnapshot() {
  const chats = await runWithWhatsAppRecovery(
    () => wa.getChats(),
    "refresh_groups_snapshot"
  );
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
  return callTelegramWithRetry(
    () => tg.telegram.sendMessage(cfg.tgGroupId, text, {
      message_thread_id: topicId,
      reply_to_message_id: replyToMessageId || undefined,
      parse_mode: "MarkdownV2"
    }),
    `send_message:${topicId}`
  );
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
      return await callTelegramWithRetry(
        () => tg.telegram.sendPhoto(cfg.tgGroupId, Input.fromLocalFile(filePath), opts),
        `send_photo:${topicId}`
      );
    } else if (media.mimetype.startsWith("video/")) {
      return await callTelegramWithRetry(
        () => tg.telegram.sendVideo(cfg.tgGroupId, Input.fromLocalFile(filePath), opts),
        `send_video:${topicId}`
      );
    } else if (media.mimetype.startsWith("audio/") || media.mimetype === "application/ogg") {
      return await callTelegramWithRetry(
        () => tg.telegram.sendVoice(cfg.tgGroupId, Input.fromLocalFile(filePath), opts),
        `send_voice:${topicId}`
      );
    } else {
      return await callTelegramWithRetry(
        () => tg.telegram.sendDocument(cfg.tgGroupId, Input.fromLocalFile(filePath), opts),
        `send_document:${topicId}`
      );
    }
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

function inferTelegramMediaMimeType(tgMsg) {
  if (tgMsg.photo) {
    return "image/jpeg";
  }

  if (tgMsg.video) {
    return tgMsg.video.mime_type || "video/mp4";
  }

  if (tgMsg.audio) {
    return tgMsg.audio.mime_type || "audio/mpeg";
  }

  if (tgMsg.voice) {
    return tgMsg.voice.mime_type || "audio/ogg";
  }

  if (tgMsg.document) {
    return tgMsg.document.mime_type || "application/octet-stream";
  }

  return "application/octet-stream";
}

function inferTelegramMediaFilename(tgMsg) {
  if (tgMsg.photo) return "telegram-photo.jpg";
  if (tgMsg.video) return tgMsg.video.file_name || "telegram-video.mp4";
  if (tgMsg.audio) return tgMsg.audio.file_name || "telegram-audio.mp3";
  if (tgMsg.voice) return "telegram-voice.ogg";
  if (tgMsg.document) return tgMsg.document.file_name || "telegram-document.bin";
  return "telegram-file.bin";
}

async function buildWhatsAppMediaFromTelegramMessage(tgMsg) {
  const fileId = tgMsg.photo?.[tgMsg.photo.length - 1]?.file_id
    || tgMsg.document?.file_id
    || tgMsg.video?.file_id
    || tgMsg.audio?.file_id
    || tgMsg.voice?.file_id;

  if (!fileId) return null;

  try {
    const mimeType = inferTelegramMediaMimeType(tgMsg);
    const filename = inferTelegramMediaFilename(tgMsg);

    const file = await tg.telegram.getFile(fileId);
    const rawFilePath = String(file.file_path || "");
    const rawFilePathNoLeadingSlash = rawFilePath.replace(/^\/+/, "");
    const localDirPrefix = "var/lib/telegram-bot-api/";
    const localFilePathSuffix = rawFilePathNoLeadingSlash.startsWith(localDirPrefix)
      ? rawFilePathNoLeadingSlash.slice(localDirPrefix.length)
      : rawFilePathNoLeadingSlash;

    if (cfg.tgLocalFilesPath && localFilePathSuffix) {
      const localFilePath = path.resolve(cfg.tgLocalFilesPath, localFilePathSuffix);
      const localRoot = path.resolve(cfg.tgLocalFilesPath) + path.sep;
      if (localFilePath.startsWith(localRoot) && fs.existsSync(localFilePath)) {
        const base64Data = fs.readFileSync(localFilePath).toString("base64");
        log("debug", "Telegram media loaded from local filesystem", { filePath: localFilePathSuffix });
        return new MessageMedia(mimeType, base64Data, filename);
      }
    }

    // Fallback 1: public Telegram API (works independently from local Bot API filesystem permissions).
    const publicGetFileRes = await fetch(
      `https://api.telegram.org/bot${cfg.tgToken}/getFile?file_id=${encodeURIComponent(fileId)}`
    );
    if (publicGetFileRes.ok) {
      const publicGetFileData = await publicGetFileRes.json();
      const publicFilePath = String(publicGetFileData?.result?.file_path || "").replace(/^\/+/, "");
      if (publicGetFileData.ok && publicFilePath) {
        const publicFileUrl = `https://api.telegram.org/file/bot${cfg.tgToken}/${publicFilePath}`;
        const publicFileRes = await fetch(publicFileUrl);
        if (publicFileRes.ok) {
          const publicArrayBuffer = await publicFileRes.arrayBuffer();
          const publicBase64Data = Buffer.from(publicArrayBuffer).toString("base64");
          log("debug", "Telegram media downloaded from public API", { filePath: publicFilePath });
          return new MessageMedia(mimeType, publicBase64Data, filename);
        }
      }
    }

    // Fallback 2: local Bot API HTTP endpoint.
    const apiBase = cfg.tgApiBaseUrl || "https://api.telegram.org";
    const fileUrl = `${apiBase}/file/bot${cfg.tgToken}/${localFilePathSuffix}`;
    const response = await fetch(fileUrl);

    if (!response.ok) {
      throw new Error(`Telegram file download failed: HTTP ${response.status} for ${localFilePathSuffix}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString("base64");

    return new MessageMedia(mimeType, base64Data, filename);
  } catch (error) {
    throw new Error(`Failed to build WhatsApp media from Telegram message: ${error.message}`);
  }
}

async function sendWhatsAppReadReceiptIfEnabled(waGroupId, tgMsg) {
  if (!cfg.tgToWaSendReadReceiptOnActivity) return;
  if (tgMsg.from?.is_bot) return;

  try {
    await runWithWhatsAppRecovery(
      () => wa.sendSeen(waGroupId),
      `send_read_receipt:${waGroupId}`
    );
    log("debug", `Read receipt sent to WhatsApp group ${waGroupId}`);
  } catch (error) {
    log("warn", `Failed to send read receipt to WhatsApp group ${waGroupId}`, error.message);
  }
}

async function relayWhatsAppEditToTelegram(msg, source = "message_edit") {
  try {
    const waGroupId = msg.from?.endsWith("@g.us")
      ? msg.from
      : (msg.to?.endsWith("@g.us") ? msg.to : null);
    if (!waGroupId) return;

    const topicId = cfg.waGroupToTopic[waGroupId];
    if (!topicId) return;

    const waMessageId = msg.id?._serialized;
    if (!waMessageId) return;

    pruneExpiredMessageLinks();
    const stableId = extractWaStableMessageId(waMessageId);
    const link = waToTgMessageLinks.get(buildWaMessageKey(waGroupId, waMessageId))
      || (stableId ? waToTgMessageLinks.get(buildWaMessageKey(waGroupId, `id:${stableId}`)) : null);
    if (!link?.tgMessageId) return;

    const newBody = msg.body || "";
    if (!newBody) return;

    let contact = null;
    try {
      if (!msg.fromMe) contact = await msg.getContact();
    } catch (_) { /* fallback below */ }

    const sender = contact
      ? resolveWhatsAppSenderName(msg, contact)
      : (msg.fromMe ? "Me" : (msg.author || msg.from || "Unknown"));
    const safeSender = escapeMarkdownV2(sender.replace("@c.us", ""));
    const safeBody = escapeMarkdownV2(newBody);
    const editedText = `*${safeSender}*\n${safeBody}`;

    await callTelegramWithRetry(
      () => tg.telegram.editMessageText(
        cfg.tgGroupId,
        link.tgMessageId,
        undefined,
        editedText,
        { parse_mode: "MarkdownV2" }
      ),
      `edit_message:${topicId}`
    );

    log("debug", "WA->TG edit relayed", {
      source,
      waGroupId,
      topicId,
      waMessageId,
      tgMessageId: link.tgMessageId
    });
  } catch (error) {
    log("warn", "Failed to relay edit from WhatsApp to Telegram", error.message);
  }
}

async function relayWhatsAppDeleteToTelegram(msg, revokedMsg) {
  try {
    const waGroupId = msg.from?.endsWith("@g.us")
      ? msg.from
      : (msg.to?.endsWith("@g.us") ? msg.to : null);
    if (!waGroupId) return;

    const topicId = cfg.waGroupToTopic[waGroupId];
    if (!topicId) return;

    const waMessageId = revokedMsg?.id?._serialized || msg.id?._serialized;
    if (!waMessageId) return;

    pruneExpiredMessageLinks();
    const stableId = extractWaStableMessageId(waMessageId);
    const link = waToTgMessageLinks.get(buildWaMessageKey(waGroupId, waMessageId))
      || (stableId ? waToTgMessageLinks.get(buildWaMessageKey(waGroupId, `id:${stableId}`)) : null);
    if (!link?.tgMessageId) return;

    await callTelegramWithRetry(
      () => tg.telegram.deleteMessage(cfg.tgGroupId, link.tgMessageId),
      `delete_message:${topicId}`
    );

    log("debug", "WA->TG delete relayed", {
      waGroupId,
      topicId,
      waMessageId,
      tgMessageId: link.tgMessageId
    });
  } catch (error) {
    log("warn", "Failed to relay delete from WhatsApp to Telegram", error.message);
  }
}

async function relayTelegramEditToWhatsApp(ctx) {
  try {
    const tgMsg = ctx.update?.edited_message;
    if (!tgMsg) return;
    if (String(tgMsg.chat?.id) !== String(cfg.tgGroupId)) return;
    if (tgMsg.from?.is_bot) return;

    const topicId = tgMsg.message_thread_id;
    if (!topicId) return;

    const waGroupIds = topicToWaGroups[String(topicId)] || [];
    if (waGroupIds.length === 0) return;

    pruneExpiredMessageLinks();

    const newText = tgMsg.text || tgMsg.caption || "";
    if (!newText) return;

    const profileName = [tgMsg.from?.first_name, tgMsg.from?.last_name].filter(Boolean).join(" ").trim();
    const fromName = profileName || (tgMsg.from?.username ? `@${tgMsg.from.username}` : "Telegram");
    const editedText = cfg.tgToWaIncludeUsername ? `${fromName}: ${newText}` : newText;

    await Promise.all(waGroupIds.map(async (waGroupId) => {
      const link = tgToWaMessageLinks.get(buildTgMessageKey(tgMsg.message_id));
      const links = Array.isArray(link) ? link : (link ? [link] : []);
      const matchingLink = links.find((entry) => String(entry?.waGroupId) === String(waGroupId));
      if (!matchingLink?.waMessageId) return;

      await runWithWhatsAppRecovery(
        () => wa.editMessage(matchingLink.waMessageId, editedText),
        `relay_edit:${waGroupId}:${tgMsg.message_id}`
      );

      log("debug", "TG->WA edit relayed", {
        topicId,
        waGroupId,
        tgMessageId: tgMsg.message_id,
        waMessageId: matchingLink.waMessageId
      });
    }));
  } catch (error) {
    log("warn", "Failed to relay edit from Telegram to WhatsApp", error.message);
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
    await runStartupBackfill();
  } catch (error) {
    if (isDetachedFrameError(error)) {
      log("warn", "WhatsApp groups snapshot skipped because browser frame was reloaded");
    } else {
      throw error;
    }
  }

  try {
    await callTelegramWithRetry(
      () => tg.telegram.sendMessage(
        cfg.tgGroupId,
        "Bridge WhatsApp <-> Telegram is running."
      ),
      "startup_notification"
    );
  } catch (error) {
    log("warn", "Failed to send Telegram startup notification", error.message);
  }
});

wa.on("message_create", (msg) => relayWhatsAppMessageToTelegram(msg, "message_create"));
wa.on("message_reaction", relayWhatsAppReactionToTelegram);
wa.on("message_edit", (msg) => relayWhatsAppEditToTelegram(msg, "message_edit"));
wa.on("message_revoke_everyone", (msg, revokedMsg) => relayWhatsAppDeleteToTelegram(msg, revokedMsg));
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
  if (tgMsg.from?.is_bot) return;

  const topicId = tgMsg.message_thread_id;
  if (!topicId) return;

  const topicName = extractTelegramTopicName(tgMsg);
  upsertTelegramTopic(topicId, topicName, "detected from Telegram messages");

  const waGroupIds = topicToWaGroups[String(topicId)] || [];
  if (waGroupIds.length === 0) return;

  await Promise.all(waGroupIds.map((waGroupId) => sendWhatsAppReadReceiptIfEnabled(waGroupId, tgMsg)));

  const text = tgMsg.text || tgMsg.caption || "";
  const profileName = [tgMsg.from?.first_name, tgMsg.from?.last_name].filter(Boolean).join(" ").trim();
  const fromName = profileName || (tgMsg.from?.username ? `@${tgMsg.from.username}` : "Telegram");
  const senderText = cfg.tgToWaIncludeUsername ? (text ? `${fromName}: ${text}` : fromName) : text;
  const bridgedText = cfg.tgToWaIncludePrefix
    ? `${cfg.tgToWaPrefix}${senderText ? ` ${senderText}` : ""}`
    : senderText;

  try {
    const media = await buildWhatsAppMediaFromTelegramMessage(tgMsg);

    await Promise.all(waGroupIds.map(async (waGroupId) => {
      const quotedMessageId = resolveWhatsAppQuotedMessageId(tgMsg, waGroupId);
      let sentWhatsAppMessage = null;

      if (media) {
        rememberBridgeOutboundMessage(waGroupId, bridgedText);
        sentWhatsAppMessage = await runWithWhatsAppRecovery(
          () => wa.sendMessage(waGroupId, media, {
            caption: bridgedText,
            quotedMessageId: quotedMessageId || undefined
          }),
          `relay_media_message:${waGroupId}:${tgMsg.message_id}`
        );
      } else if (text) {
        rememberBridgeOutboundMessage(waGroupId, bridgedText);
        sentWhatsAppMessage = await runWithWhatsAppRecovery(
          () => wa.sendMessage(
            waGroupId,
            bridgedText,
            quotedMessageId ? { quotedMessageId } : undefined
          ),
          `relay_text_message:${waGroupId}:${tgMsg.message_id}`
        );
      }

      if (sentWhatsAppMessage?.id?._serialized && tgMsg.message_id) {
        rememberMessageLink(waGroupId, sentWhatsAppMessage.id._serialized, topicId, tgMsg.message_id, sentWhatsAppMessage.id?.id);
        log("info", "TG->WA relay success", {
          topicId,
          waGroupId,
          tgMessageId: tgMsg.message_id,
          hasMedia: Boolean(media),
          waMessageId: sentWhatsAppMessage.id._serialized
        });
      }
    }));
  } catch (error) {
    log("error", "Failed to relay message from Telegram to WhatsApp", error.message);
  }
});

tg.on("message_reaction", relayTelegramReactionToWhatsApp);
tg.on("edited_message", relayTelegramEditToWhatsApp);

tg.catch((error) => {
  log("error", "Telegram handler error", error.message);
});

tg.launch({
  allowedUpdates: ["message", "edited_message", "message_reaction"]
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
