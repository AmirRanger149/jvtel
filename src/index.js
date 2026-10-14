// ==================================================
// jvTEL — CONFIGURATION  (USER_CONFIG)
// --------------------------------------------------
// This is the ONLY block you need to edit to run the bot.
// Everything below it is implementation — leave it alone.
//
//   ⚠️  SECURITY WARNING
//   Real credentials pasted here end up in your source file. Never commit them
//   to a public repository and never share screenshots of this block filled in.
//   For anything deployed, prefer Cloudflare Secrets (see README → "Safer
//   deployment with Cloudflare Secrets"). Any environment binding or Secret with
//   the same name overrides the value below, so you can keep placeholders here
//   and store the real values in Cloudflare.
//
//   Where each value comes from:
//     API_BASE_URL / API_KEY / MODEL
//         Your LLM provider's dashboard. The base URL is the part before
//         "/chat/completions" — for OpenAI that is "https://api.openai.com/v1".
//         Any OpenAI-compatible provider works (OpenRouter, Groq, Together,
//         DeepInfra, a local vLLM/Ollama gateway, ...). No provider is hardcoded.
//     TELEGRAM_BOT_TOKEN
//         Message @BotFather on Telegram → /newbot → copy the token
//         (it looks like "123456789:AA..." — the value below is a placeholder).
//     TELEGRAM_WEBHOOK_SECRET
//         Invent it yourself: any random string of 16+ characters. Telegram sends
//         it back in the X-Telegram-Bot-Api-Secret-Token header, and this Worker
//         rejects webhook calls that do not carry it. Create one with:
//           node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
//         (run that on your own machine, not inside the Worker)
//     ALLOWED_USER_IDS
//         Comma-separated numeric Telegram user IDs allowed to use the model,
//         e.g. "12345,67890". Find yours by messaging the bot once: an
//         unauthorized user is told their own numeric ID. Usernames are never
//         used for authorization — they can be changed or stolen.
//         Leave it as an empty string ("") to allow ANYONE who finds the bot to
//         use it. That is public access: strangers can spend your API credits and
//         abuse the model in your name. Only do it deliberately. (An empty string
//         set as a Cloudflare var/Secret is honoured too — unlike the other keys,
//         where an empty value means "keep the value from this file".)
//
//   Required:  API_BASE_URL, API_KEY, MODEL,
//              TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ALLOWED_USER_IDS
//              (a decision is required — real IDs or an empty string)
//   Optional:  SYSTEM_PROMPT, MAX_HISTORY_MESSAGES, MAX_INPUT_CHARS,
//              LLM_TIMEOUT_MS, RESPOND_IN_GROUPS — the defaults below work.
//
//   If a required value is missing or still holds one of the example
//   placeholders, the Worker refuses to call the model and lists the setting
//   names on GET / and GET /status. It never prints the values themselves.
// ==================================================

const USER_CONFIG = {
  // ---- LLM provider (OpenAI-compatible Chat Completions API) ----
  API_BASE_URL: "https://api.example.com/v1",
  API_KEY: "PASTE_YOUR_API_KEY_HERE",
  MODEL: "your-model-name",

  // ---- Telegram ----
  TELEGRAM_BOT_TOKEN: "PASTE_YOUR_TELEGRAM_BOT_TOKEN_HERE",
  TELEGRAM_WEBHOOK_SECRET: "REPLACE_WITH_A_RANDOM_SECRET",
  ALLOWED_USER_IDS: "123456789",

  // ---- Conversation behaviour (all optional) ----
  SYSTEM_PROMPT: "You are jvTEL, a helpful assistant on Telegram. Answer in plain text.",
  MAX_HISTORY_MESSAGES: 12, // 0 = no memory, 12 = last 6 exchanges
  MAX_INPUT_CHARS: 8000, // longer user messages are rejected, not truncated

  // ---- Optional / advanced ----
  LLM_TIMEOUT_MS: 30000, // bounded timeout for one model call; never retried
  RESPOND_IN_GROUPS: false // true = also answer in groups/supergroups
};

// NOTE: imports follow the configuration block on purpose, so that the settings
// above are the first thing you see when opening this file. ES module imports
// are hoisted, so their position does not change behaviour.
import { createChatCompletion, buildChatCompletionsUrl, LlmError } from "./llm.js";
import {
  sendChatAction,
  sendLongMessage,
  TelegramApiError,
  TELEGRAM_MESSAGE_TEXT_LIMIT,
} from "./telegram.js";
import { createHistoryStore, createUpdateDedupe, HistoryError } from "./conversation.js";

// ==================================================
// Implementation — nothing below this line needs editing.
// ==================================================

// IMPORTANT (workerd constraint): this file is the Worker's *entry module*, and
// the Workers runtime only accepts functions or handler objects as exports from
// it. A non-function export such as `export const WEBHOOK_PATH = ...` makes the
// whole Worker fail to start with
//   "Incorrect type for map entry 'WEBHOOK_PATH': the provided value is not of
//    type 'function or ExportedHandler'".
// So every constant below stays module-private, and only functions are exported.
// (The helper modules llm.js / telegram.js / conversation.js are plain imports,
// so they may export constants freely.)
const WEBHOOK_PATH = "/telegram-webhook";
const WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";

const BOT_NAME = "jvTEL";

/** Names a beginner may change; used for validation and status reporting. */
const CONFIG_KEYS = {
  required: [
    "API_BASE_URL",
    "API_KEY",
    "MODEL",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "ALLOWED_USER_IDS",
  ],
  secret: ["API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"],
  optional: ["SYSTEM_PROMPT", "MAX_HISTORY_MESSAGES", "MAX_INPUT_CHARS", "LLM_TIMEOUT_MS", "RESPOND_IN_GROUPS"],
};

// Example values shipped in USER_CONFIG. If one of them is still in place, the
// bot has not been configured yet, so it fails fast instead of calling an API
// with junk credentials.
const PLACEHOLDER_EXACT = new Set(["123456789", "changeme", "change_me", "todo", "tbd", "xxx"]);
const PLACEHOLDER_PATTERNS = [/^paste[_-]/i, /^replace[_-]/i, /^your[_-]/i, /^enter[_-]/i, /[_-]here$/i, /^x{3,}$/i];

/**
 * True when a value looks like an untouched example placeholder.
 * Only the *fact* that it is a placeholder is ever reported — never the value.
 */
export function isPlaceholderValue(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (normalized === "") return false; // "empty" is reported separately
  if (PLACEHOLDER_EXACT.has(normalized.toLowerCase())) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** API_BASE_URL needs a host check as well, because it is a full URL. */
function isPlaceholderBaseUrl(value) {
  if (isPlaceholderValue(value)) return true;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "example.com" || host.endsWith(".example.com") || host.endsWith(".example.org") || host.includes("your-");
  } catch {
    return false;
  }
}

function readEnvValue(env, key) {
  if (!env || typeof env !== "object") return undefined;
  const value = env[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function parseBoundedInt(raw, min, max) {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max) return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (parsed >= min && parsed <= max) return parsed;
  }
  return null;
}

function parseBoolean(raw, fallback) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(value)) return true;
    if (["false", "0", "no", "off"].includes(value)) return false;
  }
  return fallback;
}

/**
 * Parse ALLOWED_USER_IDS into a list of numeric Telegram user IDs (as strings,
 * to avoid any float precision surprises with large IDs).
 */
export function parseAllowedUserIds(raw) {
  const value = typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : String(raw);
  const tokens = value.split(/[,\s;]+/).filter((token) => token !== "");
  const ids = [];
  let invalid = 0;
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      if (!ids.includes(token)) ids.push(token);
    } else {
      invalid += 1;
    }
  }
  return { raw: value.trim(), ids, invalid };
}

/**
 * Merge Cloudflare environment bindings / Secrets over USER_CONFIG.
 * Environment values always win, so real credentials can live in Cloudflare
 * while this file keeps placeholders.
 *
 * @param {object} [env]
 */
export function resolveConfig(env = {}) {
  const pick = (key, fallback) => readEnvValue(env, key) ?? fallback;

  // ALLOWED_USER_IDS is special: an empty string is a meaningful value
  // ("no restriction, public access"), so it must not be treated as "unset".
  const pickAllowingEmpty = (key, fallback) => {
    const value = env && typeof env === "object" ? env[key] : undefined;
    if (typeof value === "string") return value.trim();
    if (value === undefined || value === null) return fallback;
    return String(value);
  };

  const allowlist = parseAllowedUserIds(pickAllowingEmpty("ALLOWED_USER_IDS", USER_CONFIG.ALLOWED_USER_IDS));

  return {
    // provider
    apiBaseUrl: String(pick("API_BASE_URL", USER_CONFIG.API_BASE_URL) ?? "").trim(),
    apiKey: String(pick("API_KEY", USER_CONFIG.API_KEY) ?? ""),
    model: String(pick("MODEL", USER_CONFIG.MODEL) ?? "").trim(),
    llmTimeoutMs: parseBoundedInt(pick("LLM_TIMEOUT_MS", USER_CONFIG.LLM_TIMEOUT_MS), 1000, 120000),

    // telegram
    botToken: String(pick("TELEGRAM_BOT_TOKEN", USER_CONFIG.TELEGRAM_BOT_TOKEN) ?? ""),
    webhookSecret: String(pick("TELEGRAM_WEBHOOK_SECRET", USER_CONFIG.TELEGRAM_WEBHOOK_SECRET) ?? ""),
    allowedUserIds: allowlist.ids,
    allowedUserIdsRaw: allowlist.raw,
    allowedUserIdsInvalidCount: allowlist.invalid,
    respondInGroups: parseBoolean(pick("RESPOND_IN_GROUPS", USER_CONFIG.RESPOND_IN_GROUPS), false),

    // conversation
    systemPrompt: String(pick("SYSTEM_PROMPT", USER_CONFIG.SYSTEM_PROMPT) ?? "").trim(),
    maxHistoryMessages: parseBoundedInt(pick("MAX_HISTORY_MESSAGES", USER_CONFIG.MAX_HISTORY_MESSAGES), 0, 100),
    maxInputChars: parseBoundedInt(pick("MAX_INPUT_CHARS", USER_CONFIG.MAX_INPUT_CHARS), 1, 100000),

    // storage binding (optional)
    kv: env && typeof env === "object" && env.CHAT_HISTORY ? env.CHAT_HISTORY : null,
  };
}

/** Last-resort limits, used only if USER_CONFIG itself was edited into nonsense. */
const FALLBACK_LIMITS = { maxHistoryMessages: 12, maxInputChars: 8000, llmTimeoutMs: 30_000 };

/** Effective numeric limits (validated first; these are the safety net). */
function limits(config) {
  return {
    maxHistoryMessages: config.maxHistoryMessages ?? FALLBACK_LIMITS.maxHistoryMessages,
    maxInputChars: config.maxInputChars ?? FALLBACK_LIMITS.maxInputChars,
    llmTimeoutMs: config.llmTimeoutMs ?? FALLBACK_LIMITS.llmTimeoutMs,
  };
}

/**
 * Check the resolved configuration. Reports setting NAMES and reasons only —
 * never a value, and never a part of a secret.
 *
 * @returns {{ok: boolean, problems: Array, warnings: Array}}
 */
export function validateConfig(config) {
  const problems = [];
  const warnings = [];
  const problem = (key, reason, detail) => problems.push({ key, reason, detail });

  // --- required provider settings ---
  if (!config.apiBaseUrl) problem("API_BASE_URL", "missing", "Set the provider base URL, e.g. https://api.openai.com/v1");
  else if (isPlaceholderBaseUrl(config.apiBaseUrl))
    problem("API_BASE_URL", "placeholder", "Still the example URL from the configuration block.");
  else if (!/^https?:\/\//i.test(config.apiBaseUrl))
    problem("API_BASE_URL", "invalid", "Must be an absolute URL starting with https:// or http://");

  if (!config.apiKey) problem("API_KEY", "missing", "Set it in USER_CONFIG or as a Cloudflare Secret named API_KEY.");
  else if (isPlaceholderValue(config.apiKey))
    problem("API_KEY", "placeholder", "Still the example placeholder from the configuration block.");

  if (!config.model) problem("MODEL", "missing", "Set the model name offered by your provider.");
  else if (isPlaceholderValue(config.model))
    problem("MODEL", "placeholder", "Still the example placeholder from the configuration block.");

  // --- required Telegram settings ---
  if (!config.botToken)
    problem("TELEGRAM_BOT_TOKEN", "missing", "Get one from @BotFather, then set it here or as a Cloudflare Secret.");
  else if (isPlaceholderValue(config.botToken))
    problem("TELEGRAM_BOT_TOKEN", "placeholder", "Still the example placeholder from the configuration block.");
  else if (!/^\d{5,}:[\w-]{20,}$/.test(config.botToken))
    warnings.push({
      key: "TELEGRAM_BOT_TOKEN",
      reason: "shape",
      detail: "Does not look like a BotFather token (expected <bot-id>:<35 characters>). It was not rejected, but check it.",
    });

  if (!config.webhookSecret)
    problem("TELEGRAM_WEBHOOK_SECRET", "missing", "Invent a random string (16+ characters) and use the same one in setWebhook.");
  else if (isPlaceholderValue(config.webhookSecret))
    problem("TELEGRAM_WEBHOOK_SECRET", "placeholder", "Still the example placeholder from the configuration block.");
  else if (config.webhookSecret.length < 16)
    warnings.push({ key: "TELEGRAM_WEBHOOK_SECRET", reason: "weak", detail: "Shorter than 16 characters; use a longer random string." });

  // --- access control (a decision is required, empty string is allowed) ---
  if (config.allowedUserIdsRaw === "") {
    warnings.push({
      key: "ALLOWED_USER_IDS",
      reason: "public",
      detail: "Empty: anyone who finds the bot can use it and spend your API credits. Set numeric user IDs to restrict access.",
    });
  } else if (isPlaceholderValue(config.allowedUserIdsRaw)) {
    problem(
      "ALLOWED_USER_IDS",
      "placeholder",
      "Still the example value. Put your own numeric Telegram user IDs (comma-separated), or set it to \"\" for public access.",
    );
  } else if (config.allowedUserIds.length === 0) {
    problem("ALLOWED_USER_IDS", "invalid", "Contains no numeric Telegram user IDs. Usernames are not accepted.");
  } else if (config.allowedUserIdsInvalidCount > 0) {
    warnings.push({
      key: "ALLOWED_USER_IDS",
      reason: "invalid-entries",
      detail: `${config.allowedUserIdsInvalidCount} entr${config.allowedUserIdsInvalidCount === 1 ? "y was" : "ies were"} ignored because they are not numeric Telegram user IDs.`,
    });
  }

  // --- optional numeric settings ---
  if (config.maxHistoryMessages === null)
    problem("MAX_HISTORY_MESSAGES", "invalid", "Must be an integer from 0 (no memory) to 100.");
  if (config.maxInputChars === null)
    problem("MAX_INPUT_CHARS", "invalid", "Must be an integer from 1 to 100000.");
  if (config.llmTimeoutMs === null)
    problem("LLM_TIMEOUT_MS", "invalid", "Must be an integer from 1000 to 120000 milliseconds.");

  // --- storage ---
  if (!config.kv) {
    warnings.push({
      key: "CHAT_HISTORY",
      reason: "no-kv",
      detail:
        "No KV namespace is bound, so conversation history lives only in this Worker isolate's memory and is lost when it restarts. Bind a KV namespace as CHAT_HISTORY for real persistence.",
    });
  }

  return { ok: problems.length === 0, problems, warnings };
}

/** Mask a secret for display: only whether it exists and how long it is. */
function secretState(value) {
  if (!value) return "missing";
  if (isPlaceholderValue(value)) return "placeholder";
  return `set (${value.length} characters)`;
}

/** Show a URL without any credential that might be embedded in it. */
export function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|sig|password|auth/i.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * Non-sensitive configuration report, used by GET /status and GET /.
 * Contains no secret values and no user IDs.
 */
export function buildStatus(config, requestUrl = null) {
  const validation = validateConfig(config);
  const { maxHistoryMessages, maxInputChars, llmTimeoutMs } = limits(config);
  const store = createHistoryStore({ kv: config.kv, maxMessages: maxHistoryMessages });
  const dedupe = createUpdateDedupe({ kv: config.kv });

  let endpoint = "(unusable — see problems)";
  try {
    endpoint = redactUrl(buildChatCompletionsUrl(config.apiBaseUrl));
  } catch {
    endpoint = "(unusable — see problems)";
  }

  return {
    name: BOT_NAME,
    ready: validation.ok,
    problems: validation.problems,
    warnings: validation.warnings,
    settings: {
      API_BASE_URL: config.apiBaseUrl ? redactUrl(config.apiBaseUrl) : "(empty)",
      chat_completions_endpoint: config.apiBaseUrl ? endpoint : "(empty)",
      API_KEY: secretState(config.apiKey),
      MODEL: config.model || "(empty)",
      TELEGRAM_BOT_TOKEN: secretState(config.botToken),
      TELEGRAM_WEBHOOK_SECRET: secretState(config.webhookSecret),
      ALLOWED_USER_IDS: config.allowedUserIds.length
        ? `${config.allowedUserIds.length} user ID(s) configured`
        : config.allowedUserIdsRaw === ""
          ? "empty — PUBLIC ACCESS, anyone can use the bot"
          : "unusable — see problems",
      SYSTEM_PROMPT: config.systemPrompt ? `${config.systemPrompt.length} characters` : "(empty)",
      MAX_HISTORY_MESSAGES: maxHistoryMessages,
      MAX_INPUT_CHARS: maxInputChars,
      LLM_TIMEOUT_MS: llmTimeoutMs,
      RESPOND_IN_GROUPS: config.respondInGroups,
    },
    storage: {
      history: store.mode,
      history_persistence:
        store.mode === "kv"
          ? "persistent across requests and deployments"
          : "in-memory only: lost when this Worker isolate is recycled (bind CHAT_HISTORY KV for persistence)",
      duplicate_update_detection: dedupe.enabled ? `best-effort via KV (update_id remembered ${dedupe.ttlSeconds}s)` : "disabled (requires KV)",
    },
    telegram: {
      webhook_path: WEBHOOK_PATH,
      webhook_secret_header: "X-Telegram-Bot-Api-Secret-Token",
      message_text_limit: TELEGRAM_MESSAGE_TEXT_LIMIT,
    },
    config_block: "src/index.js → USER_CONFIG (Cloudflare Secrets/vars with the same names take precedence)",
    editable_keys: {
      required: CONFIG_KEYS.required,
      should_be_cloudflare_secrets: CONFIG_KEYS.secret,
      optional: CONFIG_KEYS.optional,
    },
    request_url_origin: requestUrl ? safeOrigin(requestUrl) : null,
  };
}

function safeOrigin(requestUrl) {
  try {
    return new URL(requestUrl).origin;
  } catch {
    return null;
  }
}

// --------------------------------------------------
// HTTP entry point
// --------------------------------------------------

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

/**
 * @param {Request} request
 * @param {object} [env]
 * @param {ExecutionContext} [ctx]
 */
export async function handleRequest(request, env = {}, ctx = undefined) {
  const config = resolveConfig(env);
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return textResponse("Bad request URL.", 400);
  }

  const path = url.pathname.replace(/\/+$/, "") || "/";

  // Status: the first thing to open locally (http://localhost:8787/) and the
  // quickest way to see which settings are still missing. No secrets are shown.
  if (path === "/" || path === "/status") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("Method Not Allowed. Use GET.", 405, { Allow: "GET, HEAD" });
    }
    const status = buildStatus(config, request.url);
    if (request.method === "HEAD") return new Response(null, { status: 200 });
    if (path === "/status") return jsonResponse(status);
    return new Response(renderStatusPage(status), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // Telegram webhook.
  if (path === WEBHOOK_PATH) {
    return handleWebhook(request, config, ctx);
  }

  if (path === "/favicon.ico") return new Response(null, { status: 204 });

  return textResponse(
    `Not found.\n\n${BOT_NAME} exposes:\n  GET  /                 configuration status (HTML)\n  GET  /status           configuration status (JSON)\n  POST ${WEBHOOK_PATH}   Telegram webhook`,
    404,
  );
}

/**
 * Validate the webhook request itself: method, secret token, JSON body, and
 * update type. Anything that passes is acknowledged with HTTP 200 so Telegram
 * does not redeliver an update we already accepted — the actual work happens in
 * `processUpdate`.
 */
export async function handleWebhook(request, config = null, ctx = undefined, env = {}) {
  const resolved = config ?? resolveConfig(env);

  if (request.method !== "POST") {
    return textResponse("Method Not Allowed. The Telegram webhook only accepts POST.", 405, { Allow: "POST" });
  }

  const validation = validateConfig(resolved);

  // Authenticate first whenever the webhook secret itself is usable, so an
  // unauthenticated caller cannot probe the rest of the configuration.
  const canAuthenticate = resolved.webhookSecret !== "" && !isPlaceholderValue(resolved.webhookSecret);
  if (canAuthenticate && !timingSafeEqual(request.headers.get(WEBHOOK_SECRET_HEADER) ?? "", resolved.webhookSecret)) {
    console.warn(`[${BOT_NAME}] rejected webhook request: invalid or missing secret token header`);
    return jsonResponse({ ok: false, error: "unauthorized", message: "Invalid Telegram webhook secret token." }, 401);
  }

  // Then fail fast on unusable configuration: report the setting NAMES, never values.
  if (!validation.ok) {
    console.error(
      `[${BOT_NAME}] refusing webhook: configuration problems -> ${validation.problems.map((p) => `${p.key} (${p.reason})`).join(", ")}`,
    );
    return jsonResponse(
      {
        ok: false,
        error: "configuration",
        message: "This bot is not configured yet. Open GET / on this Worker for details.",
        missing_settings: validation.problems.map((problem) => ({
          key: problem.key,
          reason: problem.reason,
          detail: problem.detail,
        })),
      },
      503,
    );
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_body", message: "Request body is not valid JSON." }, 400);
  }

  if (!update || typeof update !== "object" || typeof update.update_id !== "number") {
    return jsonResponse({ ok: false, error: "invalid_update", message: "Body is not a Telegram Update object." }, 400);
  }

  // Only plain `message` updates are supported. Everything else (edited_message,
  // channel_post, callback_query, inline_query, my_chat_member, ...) is ignored
  // with a 200 so Telegram does not retry it.
  if (!update.message || typeof update.message !== "object") {
    const ignored = Object.keys(update).find((key) => key !== "update_id") ?? "unknown";
    return jsonResponse({ ok: true, ignored: `unsupported update type: ${ignored}` }, 200);
  }

  // Acknowledge now, work in the background. Telegram treats a non-2xx as a
  // failed delivery and retries, which would re-run (and re-charge) the model
  // call, so processing is detached with ctx.waitUntil when it is available.
  const work = processUpdate(update, resolved).catch((error) => {
    console.error(`[${BOT_NAME}] unhandled error while processing update ${update.update_id}: ${describeError(error)}`);
  });

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(work);
    return jsonResponse({ ok: true, status: "accepted" }, 200);
  }

  await work;
  return jsonResponse({ ok: true, status: "processed" }, 200);
}

/** Constant-time-ish string compare; only the length difference short-circuits. */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

// --------------------------------------------------
// Update processing
// --------------------------------------------------

/**
 * Handle one accepted `message` update. Never throws: failures are logged and,
 * where possible, reported to the user without revealing any credential.
 *
 * Exported for tests.
 */
export async function processUpdate(update, config, options = {}) {
  const message = update.message;
  const chat = message.chat ?? {};
  const from = message.from ?? {};
  const chatId = chat.id;
  const userId = from.id;

  if (typeof chatId !== "number") {
    console.warn(`[${BOT_NAME}] ignored update ${update.update_id}: no chat id`);
    return { handled: false, reason: "no-chat-id" };
  }

  const chatType = typeof chat.type === "string" ? chat.type : "private";
  const isPrivate = chatType === "private";

  // Private chats by default. Groups need an explicit opt-in so the bot never
  // answers a whole room by accident.
  if (!isPrivate && !config.respondInGroups) {
    return { handled: false, reason: `ignored chat type: ${chatType}` };
  }

  const { maxHistoryMessages, maxInputChars, llmTimeoutMs } = limits(config);
  const store = createHistoryStore({ kv: config.kv, maxMessages: maxHistoryMessages });
  const dedupe = createUpdateDedupe({ kv: config.kv });

  // `options.fetchImpl` exists for the test suite only; in production both the
  // Telegram and the model client use the Worker's global fetch.
  const fetchImpl = options.fetchImpl;
  const telegramOptions = { fetchImpl, timeoutMs: options.telegramTimeoutMs };
  const telegram = {
    sendLong: (text) => sendLongMessage(config.botToken, chatId, text, telegramOptions),
    typing: () => sendChatAction(config.botToken, chatId, "typing", telegramOptions).catch(() => {}),
  };

  // 1. Access control — before any storage read or model call.
  if (!isUserAllowed(userId, config.allowedUserIds)) {
    console.warn(`[${BOT_NAME}] rejected update ${update.update_id}: user id is not in ALLOWED_USER_IDS`);
    await safeSend(
      telegram,
      `Sorry, this ${BOT_NAME} bot is private.\n\nYour Telegram user ID is ${typeof userId === "number" ? userId : "unknown"}.\nThe owner can allow it by adding that ID to ALLOWED_USER_IDS in src/index.js.`,
    );
    await dedupe.markSeen(update.update_id);
    return { handled: true, reason: "unauthorized" };
  }

  // 2. Duplicate delivery (Telegram retries failed webhook calls). Best effort.
  if (await dedupe.isSeen(update.update_id)) {
    console.log(`[${BOT_NAME}] skipped duplicate update_id ${update.update_id}`);
    return { handled: false, reason: "duplicate update_id" };
  }
  await dedupe.markSeen(update.update_id);

  // 3. Only plain text is supported. No media, no documents, no captions.
  const text = typeof message.text === "string" ? message.text : null;
  if (text === null || text.trim() === "") {
    if (isPrivate || config.respondInGroups) {
      await safeSend(
        telegram,
        "I can only read plain text messages. Media, documents, stickers and voice notes are not supported — please type your question instead.",
      );
    }
    return { handled: true, reason: "unsupported content" };
  }

  // 4. Commands.
  const command = parseCommand(text);
  if (command) {
    return runCommand(command, { chatId, config, store, telegram, isPrivate, maxHistoryMessages, maxInputChars });
  }

  // 5. Oversized input is rejected (not silently truncated).
  if (text.length > maxInputChars) {
    await safeSend(
      telegram,
      `That message is ${text.length} characters long, but the limit is ${maxInputChars}. Please shorten it and send it again.`,
    );
    return { handled: true, reason: "input too long" };
  }

  // 6. Model call + reply.
  return runChat({ text, chatId, config, store, telegram, llmTimeoutMs, fetchImpl });
}

/** Authorization is by numeric user id only — never by username. */
export function isUserAllowed(userId, allowedUserIds) {
  if (!Array.isArray(allowedUserIds) || allowedUserIds.length === 0) return true; // public mode
  if (typeof userId !== "number" || !Number.isFinite(userId)) return false;
  return allowedUserIds.includes(String(userId));
}

/**
 * Recognise "/command" and "/command@botname". The @suffix is accepted but not
 * verified (this Worker never calls getMe), which matters only in groups with
 * bot privacy mode disabled.
 */
export function parseCommand(text) {
  const match = /^\s*\/([a-z0-9_]+)(@[a-z0-9_]*)?/i.exec(typeof text === "string" ? text : "");
  if (!match) return null;
  const args = text.slice(match[0].length).trim();
  return { name: match[1].toLowerCase(), mention: match[2] ?? null, args };
}

async function runCommand(command, context) {
  const { chatId, config, store, telegram, isPrivate, maxHistoryMessages, maxInputChars } = context;

  switch (command.name) {
    case "start":
      await safeSend(telegram, welcomeText(config, maxHistoryMessages, isPrivate));
      return { handled: true, command: "start" };

    case "help":
      await safeSend(telegram, helpText(config, maxHistoryMessages, maxInputChars));
      return { handled: true, command: "help" };

    case "new":
    case "reset":
    case "clear": {
      try {
        await store.clear(chatId);
        await safeSend(telegram, "Conversation cleared. We start from scratch with your next message.");
        return { handled: true, command: "new" };
      } catch (error) {
        console.error(`[${BOT_NAME}] could not clear history for chat ${chatId}: ${describeError(error)}`);
        await safeSend(telegram, "I could not clear the stored conversation right now. Please try again in a moment.");
        return { handled: true, command: "new", error: true };
      }
    }

    case "model":
      await safeSend(telegram, modelText(config, maxHistoryMessages));
      return { handled: true, command: "model" };

    default:
      await safeSend(telegram, `Unknown command "/${command.name}". Send /help to see what I can do.`);
      return { handled: true, command: "unknown" };
  }
}

async function runChat({ text, chatId, config, store, telegram, llmTimeoutMs, fetchImpl }) {
  let history = [];
  try {
    history = await store.load(chatId);
  } catch (error) {
    // Storage trouble should not block an answer; continue with no history.
    console.error(`[${BOT_NAME}] history load failed for chat ${chatId}: ${describeError(error)}`);
  }

  const messages = buildMessages(config.systemPrompt, history, text);

  await telegram.typing();

  let completion;
  try {
    completion = await createChatCompletion({
      baseUrl: config.apiBaseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      timeoutMs: llmTimeoutMs,
      fetchImpl,
    });
  } catch (error) {
    await reportLlmFailure(telegram, error, chatId);
    return { handled: true, error: true };
  }

  const delivery = await telegram.sendLong(completion.content);

  if (delivery.error) {
    console.error(
      `[${BOT_NAME}] Telegram delivery failed for chat ${chatId}: ${describeError(delivery.error)} (delivered ${delivery.sent}/${delivery.total} chunks)`,
    );
    if (delivery.sent === 0) {
      await safeSend(telegram, "I got an answer from the model but could not deliver it to this chat. Please try again.");
      return { handled: true, error: true };
    }
  }

  // Only remember the exchange if the user actually received it.
  try {
    await store.append(chatId, text, completion.content);
  } catch (error) {
    console.error(`[${BOT_NAME}] history save failed for chat ${chatId}: ${describeError(error)}`);
  }

  return { handled: true, chunks: delivery.total };
}

async function reportLlmFailure(telegram, error, chatId) {
  if (error instanceof LlmError) {
    // Technical detail (already scrubbed of the API key) goes to the log only.
    console.error(`[${BOT_NAME}] model request failed for chat ${chatId}: kind=${error.kind} status=${error.status ?? "-"} ${error.message}`);
    await safeSend(telegram, error.userMessage);
    return;
  }
  console.error(`[${BOT_NAME}] unexpected model error for chat ${chatId}: ${describeError(error)}`);
  await safeSend(telegram, "Something went wrong while calling the model. Please try again.");
}

/** system prompt + stored history + the new user message */
export function buildMessages(systemPrompt, history, userText) {
  const messages = [];
  if (typeof systemPrompt === "string" && systemPrompt.trim() !== "") {
    messages.push({ role: "system", content: systemPrompt.trim() });
  }
  for (const entry of Array.isArray(history) ? history : []) {
    if (entry && (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string") {
      messages.push({ role: entry.role, content: entry.content });
    }
  }
  messages.push({ role: "user", content: userText });
  return messages;
}

/** Send a message but never let a Telegram failure break update processing. */
async function safeSend(telegram, text) {
  try {
    const delivery = await telegram.sendLong(text);
    if (delivery.error) {
      console.error(`[${BOT_NAME}] could not send a reply (${describeError(delivery.error)})`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[${BOT_NAME}] could not send a reply: ${describeError(error)}`);
    return false;
  }
}

function describeError(error) {
  if (error instanceof TelegramApiError) {
    return `TelegramApiError(${error.method}, status=${error.status ?? "-"}, code=${error.errorCode ?? "-"}): ${error.description ?? error.message}`;
  }
  if (error instanceof LlmError) return `LlmError(${error.kind}): ${error.message}`;
  if (error instanceof HistoryError) return error.message;
  return `${error?.name ?? "Error"}: ${String(error?.message ?? error).slice(0, 200)}`;
}

// --------------------------------------------------
// User-facing texts
// --------------------------------------------------

function storageLine(config, maxHistoryMessages) {
  if (maxHistoryMessages === 0) return "Memory: disabled (MAX_HISTORY_MESSAGES is 0) — every message is answered on its own.";
  if (config.kv) {
    return `Memory: the last ${maxHistoryMessages} messages of this chat, stored in Cloudflare KV (persists across restarts).`;
  }
  return `Memory: best effort only. The last ${maxHistoryMessages} messages are kept in this Worker isolate's RAM and disappear when it restarts. Bind a KV namespace as CHAT_HISTORY for real persistence (see README).`;
}

function welcomeText(config, maxHistoryMessages, isPrivate) {
  return [
    `Welcome to ${BOT_NAME}.`,
    "",
    `I forward your text messages to the configured AI model (${config.model || "unknown model"}) and send the answer back here.`,
    "",
    "Commands:",
    "  /help   — what I can do",
    "  /new    — clear this conversation",
    "  /model  — show the model and provider in use",
    "",
    "Just send me a plain text message to start.",
    "",
    storageLine(config, maxHistoryMessages),
    isPrivate ? "" : "Note: group mode is enabled, so this chat shares one conversation history.",
  ]
    .filter((line) => line !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function helpText(config, maxHistoryMessages, maxInputChars) {
  return [
    `${BOT_NAME} — help`,
    "",
    "Commands:",
    "  /start  — welcome message and setup summary",
    "  /help   — this message",
    "  /new    — clear the current conversation history",
    "  /model  — show the configured model and provider",
    "",
    "Usage: send a plain text message and I will answer with the configured model.",
    "",
    `Limits: up to ${maxInputChars} characters per message; longer replies are split into ${TELEGRAM_MESSAGE_TEXT_LIMIT}-character chunks. Media, files and voice notes are not supported.`,
    storageLine(config, maxHistoryMessages),
  ].join("\n");
}

function modelText(config, maxHistoryMessages) {
  let endpoint = "(not configured)";
  try {
    endpoint = redactUrl(buildChatCompletionsUrl(config.apiBaseUrl));
  } catch {
    endpoint = "(API_BASE_URL is unusable — see GET /status)";
  }
  return [
    `Model: ${config.model || "(not configured)"}`,
    `Endpoint: ${endpoint}`,
    `System prompt: ${config.systemPrompt ? `${config.systemPrompt.length} characters` : "(none)"}`,
    storageLine(config, maxHistoryMessages),
  ].join("\n");
}

// --------------------------------------------------
// Status page (HTML) — no secrets, no user IDs
// --------------------------------------------------

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderStatusPage(status) {
  const badge = status.ready
    ? '<span class="ok">CONFIGURATION OK</span>'
    : '<span class="bad">CONFIGURATION INCOMPLETE</span>';

  const problems = status.problems.length
    ? `<h2>Missing or unusable settings</h2><ol class="problems">${status.problems
        .map((problem) => `<li><code>${escapeHtml(problem.key)}</code> — <strong>${escapeHtml(problem.reason)}</strong>: ${escapeHtml(problem.detail)}</li>`)
        .join("")}</ol>`
    : "";

  const warnings = status.warnings.length
    ? `<h2>Warnings</h2><ul class="warnings">${status.warnings
        .map((warning) => `<li><code>${escapeHtml(warning.key)}</code> — ${escapeHtml(warning.detail)}</li>`)
        .join("")}</ul>`
    : "";

  const rows = Object.entries(status.settings)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(typeof value === "object" ? JSON.stringify(value) : value)}</td></tr>`)
    .join("");

  const origin = status.request_url_origin ?? "https://YOUR-WORKER.example.workers.dev";
  const webhookCommand = [
    `curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"url":"${origin}${WEBHOOK_PATH}","secret_token":"<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["message"]}'`,
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(BOT_NAME)} — configuration status</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0 auto; max-width: 60rem; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
  p.lede { margin: 0 0 1.5rem; opacity: .75; }
  .ok, .bad { display: inline-block; padding: .2rem .6rem; border-radius: .4rem; font-weight: 600; font-size: .8rem; letter-spacing: .04em; }
  .ok { background: #d6f5dd; color: #0b5d24; }
  .bad { background: #ffe0e0; color: #8a1212; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid rgba(128,128,128,.25); vertical-align: top; }
  th { font-weight: 600; white-space: nowrap; width: 1%; }
  td { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; word-break: break-word; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(128,128,128,.15); padding: .1rem .3rem; border-radius: .25rem; }
  pre { background: rgba(128,128,128,.12); padding: .9rem 1rem; border-radius: .5rem; overflow-x: auto; font-size: .82rem; }
  ol.problems li, ul.warnings li { margin-bottom: .35rem; }
  .note { opacity: .75; font-size: .85rem; }
</style>
</head>
<body>
<h1>${escapeHtml(BOT_NAME)} — Telegram AI chatbot</h1>
<p class="lede">Cloudflare Worker status page. ${badge}</p>
<p class="note">This page never shows secret values: API keys, bot tokens and webhook secrets are reported as <code>missing</code>, <code>placeholder</code> or <code>set (N characters)</code> only.</p>

${problems}
${warnings}

<h2>Effective settings</h2>
<table>${rows}</table>

<h2>Storage</h2>
<table>
<tr><th>Conversation history</th><td>${escapeHtml(status.storage.history)} — ${escapeHtml(status.storage.history_persistence)}</td></tr>
<tr><th>Duplicate updates</th><td>${escapeHtml(status.storage.duplicate_update_detection)}</td></tr>
</table>

<h2>Routes</h2>
<table>
<tr><th>GET /</th><td>this page</td></tr>
<tr><th>GET /status</th><td>the same information as JSON</td></tr>
<tr><th>POST ${escapeHtml(WEBHOOK_PATH)}</th><td>Telegram webhook (requires the <code>X-Telegram-Bot-Api-Secret-Token</code> header)</td></tr>
</table>

<h2>Register the webhook</h2>
<p class="note">Run this from your own machine after deploying, replacing both <code>&lt;...&gt;</code> placeholders. Never commit the real values.</p>
<pre>${escapeHtml(webhookCommand)}</pre>

<h2>Where to edit settings</h2>
<p class="note">Non-secret defaults live in <code>src/index.js</code> → <code>USER_CONFIG</code> (top of the file). Cloudflare Secrets or vars named <code>${escapeHtml(CONFIG_KEYS.required.concat(CONFIG_KEYS.optional).join("</code>, <code>"))}</code> override them.</p>
<p class="note">Required: <code>${escapeHtml(CONFIG_KEYS.required.join("</code>, <code>"))}</code>. Store these as Cloudflare Secrets, never in Git: <code>${escapeHtml(CONFIG_KEYS.secret.join("</code>, <code>"))}</code> — <code>npx wrangler secret put NAME</code>. See <code>README.md</code> for the full walkthrough.</p>
</body>
</html>
`;
}

// --------------------------------------------------
// Worker export
// --------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env ?? {}, ctx);
    } catch (error) {
      // Never leak internals (or credentials) through an error response.
      console.error(`[${BOT_NAME}] unhandled request error: ${describeError(error)}`);
      return textResponse("Internal error. See Worker logs.", 500);
    }
  },
};
