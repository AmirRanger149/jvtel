/**
 * Test helpers: mocked fetch, KV namespace, execution context and fixtures.
 *
 * These are support files, not test files (the runner only picks up *.test.js).
 * No test needs a real API key, a real bot token, or network access.
 */

export const TEST_SECRET = "super-secret-token-1234567890";
export const TEST_BOT_TOKEN = "111111:TESTTOKENTESTTOKENTESTTOKEN";
export const TEST_API_KEY = "sk-test-KEY-VALUE-abcdef0123456789";
export const TEST_USER_ID = 424242;
export const TEST_CHAT_ID = 424242;
export const TELEGRAM_HOST = "api.telegram.org";

/** A fully valid environment (Cloudflare bindings/Secrets) for tests. */
export function validEnv(overrides = {}) {
  return {
    API_BASE_URL: "https://llm.test/v1",
    API_KEY: TEST_API_KEY,
    MODEL: "test-model",
    TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: TEST_SECRET,
    ALLOWED_USER_IDS: String(TEST_USER_ID),
    ...overrides,
  };
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain" } });
}

/** A successful OpenAI-compatible chat completion response. */
export function llmOk(content, extra = {}) {
  return jsonResponse({
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...extra,
  });
}

/**
 * A fetch double that routes Telegram and model calls to handlers you control
 * and records every call for assertions.
 *
 * @param {object} [options]
 * @param {Function|Response} [options.llm]       handler(record) → Response
 * @param {Function|Response} [options.telegram]  handler(record) → Response
 */
export function createFetchMock(options = {}) {
  const calls = [];

  const resolve = (handler, record) => {
    if (typeof handler === "function") return handler(record);
    if (handler instanceof Response) return handler;
    return undefined;
  };

  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const record = {
      url,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: typeof init.body === "string" ? init.body : null,
      signal: init.signal ?? null,
      json() {
        try {
          return JSON.parse(record.body ?? "null");
        } catch {
          return null;
        }
      },
    };

    if (url.includes(TELEGRAM_HOST)) {
      record.kind = "telegram";
      record.telegramMethod = url.split("/").pop();
      record.payload = record.json();
    } else {
      record.kind = "llm";
    }
    calls.push(record);

    const handler = record.kind === "telegram" ? options.telegram : options.llm;
    const response = resolve(handler, record);
    if (response !== undefined) return response;

    if (record.kind === "telegram") return jsonResponse({ ok: true, result: { message_id: calls.length } });
    return llmOk("default mocked reply");
  };

  return {
    fetch: fetchImpl,
    calls,
    llmCalls: () => calls.filter((call) => call.kind === "llm"),
    telegramCalls: () => calls.filter((call) => call.kind === "telegram"),
    sentTexts: () =>
      calls
        .filter((call) => call.kind === "telegram" && call.telegramMethod === "sendMessage")
        .map((call) => call.payload?.text),
  };
}

/** In-memory stand-in for a Cloudflare KV namespace binding. */
export function createMockKv(options = {}) {
  const store = new Map();
  const log = [];

  return {
    store,
    log,
    async get(key) {
      log.push({ op: "get", key });
      if (options.failOn === "get") throw new Error("KV unavailable");
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, putOptions) {
      log.push({ op: "put", key, value, options: putOptions });
      if (options.failOn === "put") throw new Error("KV unavailable");
      store.set(key, value);
    },
    async delete(key) {
      log.push({ op: "delete", key });
      if (options.failOn === "delete") throw new Error("KV unavailable");
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true };
    },
    history(chatId) {
      const raw = store.get(`chat:${chatId}`);
      return raw ? JSON.parse(raw) : null;
    },
  };
}

/** ExecutionContext double: collects waitUntil work so tests can drain it. */
export function createMockCtx() {
  const tasks = [];
  return {
    tasks,
    scheduledCount: 0,
    waitUntil(promise) {
      this.scheduledCount += 1;
      tasks.push(promise);
    },
    passThroughOnException() {},
    async drain() {
      await Promise.allSettled(tasks);
      tasks.length = 0;
    },
  };
}

/** A Telegram Update carrying a plain text message. */
export function textUpdate(options = {}) {
  const {
    updateId = 1001,
    text = "Hello there",
    chatId = TEST_CHAT_ID,
    userId = TEST_USER_ID,
    chatType = "private",
  } = options;

  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      text,
      chat: { id: chatId, type: chatType, first_name: "Test" },
      from: { id: userId, is_bot: false, first_name: "Test", username: "testuser" },
    },
  };
}

/** A webhook Request for an update, with (or without) the secret header. */
export function webhookRequest(update, options = {}) {
  const {
    secret = TEST_SECRET,
    method = "POST",
    url = "https://jvtel.test/telegram-webhook",
    rawBody = null,
  } = options;

  const headers = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;

  return new Request(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : rawBody ?? JSON.stringify(update),
  });
}

/** Collect console.error/warn output so tests can assert on logging hygiene. */
export function captureConsole() {
  const lines = [];
  const original = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...args) => lines.push(args.map(String).join(" "));
  console.warn = (...args) => lines.push(args.map(String).join(" "));
  console.log = (...args) => lines.push(args.map(String).join(" "));
  return {
    lines,
    text: () => lines.join("\n"),
    restore() {
      console.error = original.error;
      console.warn = original.warn;
      console.log = original.log;
    },
  };
}
