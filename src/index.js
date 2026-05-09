"use strict";

require("dotenv").config();

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const qrcode = require("qrcode-terminal");
const { Telegraf, Input } = require("telegraf");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { loadConfig } = require("./config");

const cfg = loadConfig();
const tg = new Telegraf(cfg.tgToken);
const topicToWa = Object.fromEntries(Object.entries(cfg.waGroupToTopic).map(([waId, topicId]) => [String(topicId), waId]));
const topicCatalog = new Map();
const recentBridgeOutboundMessages = new Map();
let lastWhatsAppGroups = [];

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

function writeSnapshotFile(groups) {
  const sortedGroups = [...groups].sort((a, b) => a.name.localeCompare(b.name));
  const sortedTopics = [...topicCatalog.values()].sort((a, b) => Number(a.id) - Number(b.id));
  const lines = [
    `Updated: ${new Date().toISOString()}`,
    "",
    "WhatsApp groups:",
    ...sortedGroups.map((group) => `${group.name} => ${group.id._serialized}`)
  ];

  lines.push("", "Telegram topics:");

  if (sortedTopics.length === 0) {
    lines.push("(none detected yet)");
  } else {
    sortedTopics.forEach((topic) => {
      const label = topic.name || "(name unknown yet)";
      const source = topic.source ? ` [${topic.source}]` : "";
      lines.push(`${label} => ${topic.id}${source}`);
    });
  }

  fs.mkdirSync(path.dirname(cfg.waGroupsListPath), { recursive: true });
  fs.writeFileSync(cfg.waGroupsListPath, `${lines.join("\n")}\n`, "utf8");
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
    writeSnapshotFile(lastWhatsAppGroups);
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
    writeSnapshotFile(lastWhatsAppGroups);
  }
}

function rememberBridgeOutboundMessage(waGroupId, text) {
  const key = String(waGroupId);
  const queue = recentBridgeOutboundMessages.get(key) || [];

  queue.push({
    text: text || "",
    expiresAt: Date.now() + 2 * 60 * 1000
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

async function relayWhatsAppMessageToTelegram(msg) {
  if (!msg.from.endsWith("@g.us")) return;

  const topicId = cfg.waGroupToTopic[msg.from];
  if (!topicId) return;

  const rawText = msg.body || msg.caption || "";

  if (msg.fromMe && isRecentBridgeOutboundMessage(msg.from, rawText)) {
    return;
  }

  try {
    const contact = await msg.getContact();
    const sender = msg.fromMe
      ? (contact.pushname || contact.name || "Me")
      : (contact.pushname || contact.name || msg.author || "Unknown");
    const safeSender = escapeMarkdownV2(sender.replace("@c.us", ""));
    const safeBody = escapeMarkdownV2(rawText);
    const prefix = `*${safeSender}*`;

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      await sendMediaToTelegram(topicId, media, safeBody ? `${prefix}\n${safeBody}` : prefix);
    } else if (rawText) {
      await sendToTelegramTopic(topicId, `${prefix}\n${safeBody}`);
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

  writeSnapshotFile(groups);
  log("info", `WhatsApp groups list updated in ${cfg.waGroupsListPath}`);
}

async function sendToTelegramTopic(topicId, text) {
  return tg.telegram.sendMessage(cfg.tgGroupId, text, {
    message_thread_id: topicId,
    parse_mode: "MarkdownV2"
  });
}

async function sendMediaToTelegram(topicId, media, caption) {
  const ext = media.mimetype.split("/")[1]?.split(";")[0] || "bin";
  const filePath = path.join(os.tmpdir(), `wa-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);

  fs.writeFileSync(filePath, Buffer.from(media.data, "base64"));

  const opts = {
    message_thread_id: topicId,
    caption,
    parse_mode: "MarkdownV2"
  };

  try {
    if (media.mimetype.startsWith("image/")) {
      await tg.telegram.sendPhoto(cfg.tgGroupId, Input.fromLocalFile(filePath), opts);
    } else if (media.mimetype.startsWith("video/")) {
      await tg.telegram.sendVideo(cfg.tgGroupId, Input.fromLocalFile(filePath), opts);
    } else if (media.mimetype.startsWith("audio/") || media.mimetype === "application/ogg") {
      await tg.telegram.sendVoice(cfg.tgGroupId, Input.fromLocalFile(filePath), opts);
    } else {
      await tg.telegram.sendDocument(cfg.tgGroupId, Input.fromLocalFile(filePath), opts);
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

wa.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
  log("info", "Scan the QR code in WhatsApp > Linked devices.");
});

wa.on("ready", async () => {
  log("info", "WhatsApp client is ready.");
  await refreshWhatsAppGroupsSnapshot();

  if (cfg.waGroupsListRefreshMinutes > 0) {
    const refreshMs = cfg.waGroupsListRefreshMinutes * 60 * 1000;
    setInterval(async () => {
      try {
        await refreshWhatsAppGroupsSnapshot();
      } catch (error) {
        log("error", "Failed to refresh WhatsApp groups list", error.message);
      }
    }, refreshMs).unref();

    log("info", `WhatsApp groups list refresh enabled every ${cfg.waGroupsListRefreshMinutes} minute(s).`);
  }

  await tg.telegram.sendMessage(
    cfg.tgGroupId,
    "Bridge WhatsApp <-> Telegram is running."
  );
});

wa.on("message_create", relayWhatsAppMessageToTelegram);

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

  try {
    if (tgMsg.photo) {
      const fileId = tgMsg.photo[tgMsg.photo.length - 1].file_id;
      const fileUrl = await tg.telegram.getFileLink(fileId);
      const media = await MessageMedia.fromUrl(fileUrl.toString());
      rememberBridgeOutboundMessage(waGroupId, bridgedText);
      await wa.sendMessage(waGroupId, media, { caption: bridgedText });
    } else if (tgMsg.document || tgMsg.video || tgMsg.audio || tgMsg.voice) {
      const file = tgMsg.document || tgMsg.video || tgMsg.audio || tgMsg.voice;
      const fileUrl = await tg.telegram.getFileLink(file.file_id);
      const media = await MessageMedia.fromUrl(fileUrl.toString());
      rememberBridgeOutboundMessage(waGroupId, bridgedText);
      await wa.sendMessage(waGroupId, media, { caption: bridgedText });
    } else if (text) {
      rememberBridgeOutboundMessage(waGroupId, bridgedText);
      await wa.sendMessage(waGroupId, bridgedText);
    }
  } catch (error) {
    log("error", "Failed to relay message from Telegram to WhatsApp", error.message);
  }
});

tg.catch((error) => {
  log("error", "Telegram handler error", error.message);
});

tg.launch().catch((error) => {
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
  process.exitCode = 1;
});
