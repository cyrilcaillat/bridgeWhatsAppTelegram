"use strict";

function parseBool(value, defaultValue) {
  if (value == null) return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseGroupMap(raw) {
  if (!raw || !raw.trim()) return {};

  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const [waIdRaw, topicIdRaw] = pair.split(":");
      const waId = (waIdRaw || "").trim();
      const topicId = Number((topicIdRaw || "").trim());

      if (!waId || Number.isNaN(topicId)) {
        throw new Error(`Invalid WA_GROUP_IDS entry: ${pair}`);
      }

      acc[waId] = topicId;
      return acc;
    }, {});
}

function loadConfig() {
  const requiredVars = ["TG_TOKEN", "TG_GROUP_ID"];
  const missing = requiredVars.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }

  return {
    tgToken: process.env.TG_TOKEN,
    tgGroupId: process.env.TG_GROUP_ID,
    waGroupToTopic: parseGroupMap(process.env.WA_GROUP_IDS || ""),
    tgToWaIncludePrefix: parseBool(process.env.TG_TO_WA_INCLUDE_PREFIX, false),
    tgToWaSendReadReceiptOnActivity: parseBool(process.env.TG_TO_WA_SEND_READ_RECEIPT_ON_ACTIVITY, false),
    tgToWaPrefix: process.env.TG_TO_WA_PREFIX || "[Bridge Telegram]",
    tgToWaIncludeUsername: parseBool(process.env.TG_TO_WA_INCLUDE_USERNAME, true),
    puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: parseBool(process.env.HEADLESS, true),
    logLevel: (process.env.LOG_LEVEL || "info").toLowerCase()
  };
}

module.exports = {
  loadConfig
};
