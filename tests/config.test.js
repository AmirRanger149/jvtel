import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildStatus,
  handleRequest,
  isPlaceholderValue,
  parseAllowedUserIds,
  redactUrl,
  resolveConfig,
  timingSafeEqual,
  validateConfig,
} from "../src/index.js";
import { TEST_API_KEY, TEST_BOT_TOKEN, TEST_SECRET, validEnv } from "./support/mocks.js";

// USER_CONFIG is private to the entry module (workerd only allows function
// exports there), so the shipped defaults are read through resolveConfig({}).
const SHIPPED = resolveConfig({});

// ---------------------------------------------------------------
// Placeholder detection
// ---------------------------------------------------------------

test("isPlaceholderValue recognises the shipped example values", () => {
  assert.equal(isPlaceholderValue(SHIPPED.apiKey), true);
  assert.equal(isPlaceholderValue(SHIPPED.botToken), true);
  assert.equal(isPlaceholderValue(SHIPPED.webhookSecret), true);
  assert.equal(isPlaceholderValue(SHIPPED.model), true);
  assert.equal(isPlaceholderValue("123456789"), true);
  assert.equal(isPlaceholderValue("CHANGE_ME"), true);
});

test("isPlaceholderValue accepts real-looking values", () => {
  assert.equal(isPlaceholderValue("sk-proj-9f3ab7c2e1"), false);
  assert.equal(isPlaceholderValue("gpt-4o-mini"), false);
  assert.equal(isPlaceholderValue("llama-3.1-70b"), false);
  assert.equal(isPlaceholderValue("7d1f...hex...secret"), false);
  assert.equal(isPlaceholderValue(""), false); // empty is reported as "missing", not "placeholder"
  assert.equal(isPlaceholderValue(undefined), false);
});

// ---------------------------------------------------------------
// resolveConfig: USER_CONFIG defaults + environment precedence
// ---------------------------------------------------------------

test("resolveConfig falls back to USER_CONFIG when the environment is empty", () => {
  const config = resolveConfig({});
  assert.equal(config.apiBaseUrl, SHIPPED.apiBaseUrl);
  assert.equal(config.model, SHIPPED.model);
  assert.equal(config.maxHistoryMessages, 12);
  assert.equal(config.maxInputChars, 8000);
  assert.equal(config.respondInGroups, false);
  assert.equal(config.kv, null);
});

test("environment bindings and Secrets override USER_CONFIG", () => {
  const config = resolveConfig(validEnv());
  assert.equal(config.apiBaseUrl, "https://llm.test/v1");
  assert.equal(config.apiKey, TEST_API_KEY);
  assert.equal(config.model, "test-model");
  assert.equal(config.botToken, TEST_BOT_TOKEN);
  assert.equal(config.webhookSecret, TEST_SECRET);
  assert.deepEqual(config.allowedUserIds, ["424242"]);
});

test("a single Secret overrides only that value", () => {
  const config = resolveConfig({ API_KEY: "sk-only-this-one" });
  assert.equal(config.apiKey, "sk-only-this-one");
  assert.equal(config.model, SHIPPED.model); // still the placeholder
});

test("blank and whitespace-only environment values do not override", () => {
  const config = resolveConfig({ API_KEY: "   ", MODEL: "" });
  assert.equal(config.apiKey, SHIPPED.apiKey);
  assert.equal(config.model, SHIPPED.model);
});

test("numeric and boolean settings accept strings (wrangler vars are strings)", () => {
  const config = resolveConfig({
    MAX_HISTORY_MESSAGES: "6",
    MAX_INPUT_CHARS: "1200",
    LLM_TIMEOUT_MS: "20000",
    RESPOND_IN_GROUPS: "true",
  });
  assert.equal(config.maxHistoryMessages, 6);
  assert.equal(config.maxInputChars, 1200);
  assert.equal(config.llmTimeoutMs, 20000);
  assert.equal(config.respondInGroups, true);
});

test("out-of-range numeric settings resolve to null so validation can report them", () => {
  const config = resolveConfig({ MAX_HISTORY_MESSAGES: "9999", MAX_INPUT_CHARS: "abc", LLM_TIMEOUT_MS: "-5" });
  assert.equal(config.maxHistoryMessages, null);
  assert.equal(config.maxInputChars, null);
  assert.equal(config.llmTimeoutMs, null);
});

test("a CHAT_HISTORY binding is picked up as kv", () => {
  const kv = { get: async () => null, put: async () => {}, delete: async () => {} };
  const config = resolveConfig({ CHAT_HISTORY: kv });
  assert.equal(config.kv, kv);
});

// ---------------------------------------------------------------
// ALLOWED_USER_IDS parsing
// ---------------------------------------------------------------

test("parseAllowedUserIds accepts comma, space and semicolon separated ids", () => {
  assert.deepEqual(parseAllowedUserIds("123, 456;789 101").ids, ["123", "456", "789", "101"]);
});

test("parseAllowedUserIds ignores non-numeric entries and counts them", () => {
  const parsed = parseAllowedUserIds("@alice,12345,bob");
  assert.deepEqual(parsed.ids, ["12345"]);
  assert.equal(parsed.invalid, 2);
});

test("parseAllowedUserIds de-duplicates and keeps ids as strings", () => {
  assert.deepEqual(parseAllowedUserIds("42,42, 42").ids, ["42"]);
  assert.deepEqual(parseAllowedUserIds("9007199254740993").ids, ["9007199254740993"]); // beyond Number.MAX_SAFE_INTEGER
});

// ---------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------

test("the shipped USER_CONFIG is reported as unconfigured, listing every required key", () => {
  const validation = validateConfig(resolveConfig({}));
  assert.equal(validation.ok, false);

  const keys = validation.problems.map((problem) => problem.key);
  for (const required of ["API_BASE_URL", "API_KEY", "MODEL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "ALLOWED_USER_IDS"]) {
    assert.ok(keys.includes(required), `expected ${required} to be reported, got ${keys.join(", ")}`);
  }
  for (const problem of validation.problems) {
    assert.equal(problem.reason, "placeholder", `${problem.key} should be flagged as a placeholder`);
  }
});

test("an example base URL is a placeholder even though it is a valid URL", () => {
  const validation = validateConfig(resolveConfig({ API_BASE_URL: "https://api.example.com/v1", API_KEY: "sk-real" }));
  const problem = validation.problems.find((entry) => entry.key === "API_BASE_URL");
  assert.equal(problem?.reason, "placeholder");
});

test("a complete configuration validates with no problems", () => {
  const validation = validateConfig(resolveConfig(validEnv()));
  assert.deepEqual(validation.problems, []);
  assert.equal(validation.ok, true);
});

test("an empty ALLOWED_USER_IDS is allowed but warns about public access", () => {
  const validation = validateConfig(resolveConfig(validEnv({ ALLOWED_USER_IDS: "" })));
  assert.equal(validation.ok, true);
  const warning = validation.warnings.find((entry) => entry.key === "ALLOWED_USER_IDS");
  assert.equal(warning?.reason, "public");
  assert.match(warning.detail, /anyone/i);
});

test("no KV binding produces a persistence warning, not an error", () => {
  const validation = validateConfig(resolveConfig(validEnv()));
  assert.equal(validation.ok, true);
  const warning = validation.warnings.find((entry) => entry.key === "CHAT_HISTORY");
  assert.equal(warning?.reason, "no-kv");
  assert.match(warning.detail, /memory/i);
});

test("a short webhook secret warns but does not block", () => {
  const validation = validateConfig(resolveConfig(validEnv({ TELEGRAM_WEBHOOK_SECRET: "shortbutreal" })));
  assert.equal(validation.ok, true);
  assert.equal(validation.warnings.some((entry) => entry.key === "TELEGRAM_WEBHOOK_SECRET"), true);
});

test("invalid numeric settings are reported with their key names", () => {
  const validation = validateConfig(resolveConfig(validEnv({ MAX_HISTORY_MESSAGES: "nope", MAX_INPUT_CHARS: "0" })));
  assert.equal(validation.ok, false);
  const keys = validation.problems.map((problem) => problem.key);
  assert.ok(keys.includes("MAX_HISTORY_MESSAGES"));
  assert.ok(keys.includes("MAX_INPUT_CHARS"));
});

test("validation output never contains secret values", () => {
  const validation = validateConfig(resolveConfig(validEnv()));
  const serialized = JSON.stringify(validation);
  assert.equal(serialized.includes(TEST_API_KEY), false);
  assert.equal(serialized.includes(TEST_BOT_TOKEN), false);
  assert.equal(serialized.includes(TEST_SECRET), false);
});

// ---------------------------------------------------------------
// Status reporting
// ---------------------------------------------------------------

test("buildStatus masks secrets but reports that they are set", () => {
  const status = buildStatus(resolveConfig(validEnv()), "https://jvtel.test/status");
  const serialized = JSON.stringify(status);

  assert.equal(status.ready, true);
  assert.equal(serialized.includes(TEST_API_KEY), false);
  assert.equal(serialized.includes(TEST_BOT_TOKEN), false);
  assert.equal(serialized.includes(TEST_SECRET), false);

  assert.match(status.settings.API_KEY, /^set \(\d+ characters\)$/);
  assert.match(status.settings.TELEGRAM_BOT_TOKEN, /^set \(\d+ characters\)$/);
  assert.match(status.settings.TELEGRAM_WEBHOOK_SECRET, /^set \(\d+ characters\)$/);
  assert.equal(status.settings.MODEL, "test-model");
  assert.match(status.settings.ALLOWED_USER_IDS, /1 user ID\(s\) configured/);
});

test("buildStatus shows the derived chat completions endpoint", () => {
  const status = buildStatus(resolveConfig(validEnv()));
  assert.equal(status.settings.chat_completions_endpoint, "https://llm.test/v1/chat/completions");
});

test("buildStatus reports placeholder state and the missing keys when unconfigured", () => {
  const status = buildStatus(resolveConfig({}));
  assert.equal(status.ready, false);
  assert.equal(status.settings.API_KEY, "placeholder");
  assert.equal(status.settings.TELEGRAM_BOT_TOKEN, "placeholder");
  assert.ok(status.problems.length >= 6);
});

test("buildStatus reports the storage mode", () => {
  const withoutKv = buildStatus(resolveConfig(validEnv()));
  assert.equal(withoutKv.storage.history, "memory");
  assert.match(withoutKv.storage.duplicate_update_detection, /disabled/);

  const kv = { get: async () => null, put: async () => {}, delete: async () => {} };
  const withKv = buildStatus(resolveConfig(validEnv({ CHAT_HISTORY: kv })));
  assert.equal(withKv.storage.history, "kv");
  assert.match(withKv.storage.history_persistence, /persistent/);
  assert.match(withKv.storage.duplicate_update_detection, /best-effort/);
});

test("redactUrl hides credentials that may be embedded in a base URL", () => {
  assert.equal(redactUrl("https://user:pass@llm.test/v1"), "https://llm.test/v1");
  assert.equal(
    redactUrl("https://llm.test/v1?api-version=2024&api_key=abc123"),
    "https://llm.test/v1?api-version=2024&api_key=%5BREDACTED%5D",
  );
  assert.equal(redactUrl("not a url"), "not a url");
});

// ---------------------------------------------------------------
// timingSafeEqual
// ---------------------------------------------------------------

test("timingSafeEqual compares secrets correctly", () => {
  assert.equal(timingSafeEqual("abc123", "abc123"), true);
  assert.equal(timingSafeEqual("abc123", "abc124"), false);
  assert.equal(timingSafeEqual("abc123", "abc12"), false);
  assert.equal(timingSafeEqual("", "abc"), false);
  assert.equal(timingSafeEqual(null, "abc"), false);
  assert.equal(timingSafeEqual(undefined, undefined), false);
});

// ---------------------------------------------------------------
// HTTP surface: GET /, GET /status, 404, 405
// ---------------------------------------------------------------

test("GET / renders a status page that lists missing settings when unconfigured", async () => {
  const response = await handleRequest(new Request("https://jvtel.test/"), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);

  const html = await response.text();
  assert.match(html, /CONFIGURATION INCOMPLETE/);
  for (const key of ["API_BASE_URL", "API_KEY", "MODEL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "ALLOWED_USER_IDS"]) {
    assert.ok(html.includes(key), `status page should mention ${key}`);
  }
  assert.match(html, /setWebhook/);
  assert.match(html, /USER_CONFIG/);
  // Placeholders are named as such, never echoed.
  assert.equal(html.includes("PASTE_YOUR_API_KEY_HERE"), false);
  assert.equal(html.includes("PASTE_YOUR_TELEGRAM_BOT_TOKEN_HERE"), false);
});

test("GET / reports a healthy configuration without leaking secrets", async () => {
  const response = await handleRequest(new Request("https://jvtel.test/"), validEnv());
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /CONFIGURATION OK/);
  assert.equal(html.includes(TEST_API_KEY), false);
  assert.equal(html.includes(TEST_BOT_TOKEN), false);
  assert.equal(html.includes(TEST_SECRET), false);
  assert.match(html, /test-model/);
});

test("GET /status returns JSON with the same information", async () => {
  const response = await handleRequest(new Request("https://jvtel.test/status"), validEnv());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);

  const body = await response.json();
  assert.equal(body.ready, true);
  assert.equal(body.name, "jvTEL");
  assert.ok(body.settings);
  assert.ok(body.storage);
});

test("GET /status lists missing settings for an unconfigured worker", async () => {
  const response = await handleRequest(new Request("https://jvtel.test/status"), {});
  const body = await response.json();
  assert.equal(body.ready, false);
  assert.ok(body.problems.length >= 6);
  assert.equal(JSON.stringify(body).includes(TEST_API_KEY), false);
});

test("unknown paths 404 and point at the real routes", async () => {
  const response = await handleRequest(new Request("https://jvtel.test/nope"), validEnv());
  assert.equal(response.status, 404);
  const body = await response.text();
  assert.match(body, /\/telegram-webhook/);
});

test("POST to the status route is rejected with 405", async () => {
  const response = await handleRequest(new Request("https://jvtel.test/", { method: "POST" }), validEnv());
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("HEAD / returns no body", async () => {
  const response = await handleRequest(new Request("https://jvtel.test/", { method: "HEAD" }), validEnv());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});
