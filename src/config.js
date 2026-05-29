"use strict";

function parseBool(value, defaultValue) {
  if (value == null) return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseNonNegativeInt(value, defaultValue) {
  if (value == null || value === "") return defaultValue;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

function parseOptionalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}

function parseOptionalPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
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
    tgApiBaseUrl: parseOptionalUrl(process.env.TG_API_BASE_URL),
    tgLocalFilesPath: parseOptionalPath(process.env.TG_LOCAL_FILES_PATH),
    bridgeStatePath: process.env.BRIDGE_STATE_PATH || "./bridge-state.json",
    waGroupToTopic: parseGroupMap(process.env.WA_GROUP_IDS || ""),
    messageLinkTtlMs: parseNonNegativeInt(process.env.MESSAGE_LINK_TTL_MS, 7 * 24 * 60 * 60 * 1000),
    processedWaMessageTtlMs: parseNonNegativeInt(process.env.PROCESSED_WA_MESSAGE_TTL_MS, 5 * 60 * 1000),
    recentOutboundTtlMs: parseNonNegativeInt(process.env.RECENT_OUTBOUND_TTL_MS, 2 * 60 * 1000),
    waReconnectDelayMs: parseNonNegativeInt(process.env.WA_RECONNECT_DELAY_MS, 5000),
    waReconnectRetryDelayMs: parseNonNegativeInt(process.env.WA_RECONNECT_RETRY_DELAY_MS, 15000),
    waBackfillWindowMs: parseNonNegativeInt(process.env.WA_BACKFILL_WINDOW_MS, 24 * 60 * 60 * 1000),
    waBackfillLimit: parseNonNegativeInt(process.env.WA_BACKFILL_LIMIT, 500),
    waBackfillSendDelayMs: parseNonNegativeInt(process.env.WA_BACKFILL_SEND_DELAY_MS, 300),
    waWatchdogIntervalMs: parseNonNegativeInt(process.env.WA_WATCHDOG_INTERVAL_MS, 15 * 60 * 1000),
    tgToWaIncludePrefix: parseBool(process.env.TG_TO_WA_INCLUDE_PREFIX, false),
    tgToWaSendReadReceiptOnActivity: parseBool(process.env.TG_TO_WA_SEND_READ_RECEIPT_ON_ACTIVITY, false),
    tgToWaPrefix: process.env.TG_TO_WA_PREFIX || "[Bridge Telegram]",
    tgToWaIncludeUsername: parseBool(process.env.TG_TO_WA_INCLUDE_USERNAME, true),
    tgStartupNotification: parseBool(process.env.TG_STARTUP_NOTIFICATION, true),
    waDmMode: ["off", "all"].includes(String(process.env.WA_DM_MODE || "").toLowerCase())
      ? String(process.env.WA_DM_MODE).toLowerCase()
      : "off",
    puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: parseBool(process.env.HEADLESS, true),
    logLevel: (process.env.LOG_LEVEL || "info").toLowerCase()
  };
}

module.exports = {
  loadConfig
};
