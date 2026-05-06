"use strict";

require("dotenv").config();

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const qrcode = require("qrcode-terminal");
const TelegramBot = require("node-telegram-bot-api");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { loadConfig } = require("./config");

const cfg = loadConfig();
const tg = new TelegramBot(cfg.tgToken, { polling: true });
const topicToWa = Object.fromEntries(Object.entries(cfg.waGroupToTopic).map(([waId, topicId]) => [String(topicId), waId]));

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

async function sendToTelegramTopic(topicId, text) {
  return tg.sendMessage(cfg.tgGroupId, text, {
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
      await tg.sendPhoto(cfg.tgGroupId, filePath, opts);
    } else if (media.mimetype.startsWith("video/")) {
      await tg.sendVideo(cfg.tgGroupId, filePath, opts);
    } else if (media.mimetype.startsWith("audio/") || media.mimetype === "application/ogg") {
      await tg.sendVoice(cfg.tgGroupId, filePath, opts);
    } else {
      await tg.sendDocument(cfg.tgGroupId, filePath, opts);
    }
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

wa.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
  log("info", "Scan the QR code in WhatsApp > Linked devices.");
});

wa.on("ready", async () => {
  log("info", "WhatsApp client is ready.");
  const chats = await wa.getChats();
  const groups = chats.filter((chat) => chat.isGroup);

  log("info", "Detected WhatsApp groups:");
  groups.forEach((group) => {
    log("info", `${group.name} => ${group.id._serialized}`);
  });

  await tg.sendMessage(
    cfg.tgGroupId,
    "Bridge WhatsApp <-> Telegram is running."
  );
});

wa.on("message", async (msg) => {
  if (!msg.from.endsWith("@g.us")) return;

  const topicId = cfg.waGroupToTopic[msg.from];
  if (!topicId) return;

  try {
    const contact = await msg.getContact();
    const sender = contact.pushname || contact.name || msg.author || "Unknown";
    const safeSender = escapeMarkdownV2(sender.replace("@c.us", ""));
    const safeBody = escapeMarkdownV2(msg.body || "");
    const prefix = `*${safeSender}*`;

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      await sendMediaToTelegram(topicId, media, safeBody ? `${prefix}\n${safeBody}` : prefix);
    } else if (msg.body) {
      await sendToTelegramTopic(topicId, `${prefix}\n${safeBody}`);
    }
  } catch (error) {
    log("error", "Failed to relay message from WhatsApp to Telegram", error.message);
  }
});

tg.on("message", async (tgMsg) => {
  if (String(tgMsg.chat.id) !== String(cfg.tgGroupId)) return;

  const topicId = tgMsg.message_thread_id;
  if (!topicId) return;

  const waGroupId = topicToWa[String(topicId)];
  if (!waGroupId) return;

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
      const fileUrl = await tg.getFileLink(fileId);
      const media = await MessageMedia.fromUrl(fileUrl);
      await wa.sendMessage(waGroupId, media, { caption: bridgedText });
    } else if (tgMsg.document || tgMsg.video || tgMsg.audio || tgMsg.voice) {
      const file = tgMsg.document || tgMsg.video || tgMsg.audio || tgMsg.voice;
      const fileUrl = await tg.getFileLink(file.file_id);
      const media = await MessageMedia.fromUrl(fileUrl);
      await wa.sendMessage(waGroupId, media, { caption: bridgedText });
    } else if (text) {
      await wa.sendMessage(waGroupId, bridgedText);
    }
  } catch (error) {
    log("error", "Failed to relay message from Telegram to WhatsApp", error.message);
  }
});

wa.initialize().catch((error) => {
  log("error", "WhatsApp initialization failed", error.message);
  process.exitCode = 1;
});
