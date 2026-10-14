/**
 * conversation.js — conversation history + webhook update de-duplication.
 *
 * Two storage modes:
 *
 *   "kv"     → a Cloudflare KV namespace bound as CHAT_HISTORY.
 *              History survives across requests and deployments.
 *   "memory" → a module-level Map, used when KV is not bound. It only lives
 *              inside one Worker isolate, so it disappears whenever that
 *              isolate is recycled. It is a local-development convenience, not
 *              a persistence guarantee.
 *
 * Both stores are deliberately bounded (message count, stored characters, and —
 * for memory — number of chats) so nothing can grow without limit.
 *
 * KV is eventually consistent and `get`/`put` are not atomic, so this module
 * never claims ordered or exactly-once behaviour: concurrent messages from the
 * same chat can overwrite each other, and duplicate-update detection is
 * best-effort only.
 */

export const HISTORY_KEY_PREFIX = "chat:";
export const UPDATE_KEY_PREFIX = "update:";

export const DEFAULT_MAX_HISTORY_MESSAGES = 12;

/** Hard cap on the characters stored for one chat, independent of the message cap. */
export const MAX_HISTORY_CHARS = 24_000;

/** Histories expire after this long of inactivity (KV minimum TTL is 60 s). */
export const HISTORY_TTL_SECONDS = 30 * 24 * 60 * 60;

/** How long an `update_id` is remembered for duplicate detection. */
export const UPDATE_DEDUPE_TTL_SECONDS = 60 * 60;

/** Maximum number of chats kept in the in-memory fallback store. */
export const MEMORY_MAX_CHATS = 100;

/**
 * Shared in-memory store. Module-level so it can survive *within* one isolate.
 * Kept small on purpose: a Worker isolate has limited RAM and is recycled often.
 */
const sharedMemoryHistory = new Map();

/**
 * Build the KV key for a chat.
 * Private chats: Telegram's chat id equals the user id → per-user history.
 * Groups: the chat id is the group's → history stays separated per chat.
 */
export function historyKey(chatId) {
  return `${HISTORY_KEY_PREFIX}${chatId}`;
}

export function updateKey(updateId) {
  return `${UPDATE_KEY_PREFIX}${updateId}`;
}

/**
 * Keep only well-formed user/assistant messages, newest `maxMessages` of them,
 * and at most `maxChars` characters in total. The system prompt is never stored:
 * it is prepended fresh on every request so config changes apply immediately.
 *
 * @param {unknown} messages
 * @param {number} maxMessages
 * @param {number} [maxChars]
 * @returns {Array<{role: "user"|"assistant", content: string}>}
 */
export function trimHistory(messages, maxMessages = DEFAULT_MAX_HISTORY_MESSAGES, maxChars = MAX_HISTORY_CHARS) {
  if (!Array.isArray(messages)) return [];

  const limit = Number.isInteger(maxMessages) && maxMessages > 0 ? maxMessages : DEFAULT_MAX_HISTORY_MESSAGES;
  const charLimit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : MAX_HISTORY_CHARS;

  // A single message is capped at half the budget, so the newest exchange always
  // fits. Only the *stored* copy is shortened — the user still receives the full
  // reply on Telegram.
  const perMessageLimit = Math.max(1000, Math.floor(charLimit / 2));

  const clean = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
    if (!role) continue; // system/tool/anything else is never persisted
    if (typeof message.content !== "string") continue;
    const content = message.content.slice(0, perMessageLimit);
    if (content.trim() === "") continue;
    clean.push({ role, content });
  }

  let trimmed = clean.slice(-limit);

  // Then enforce the character budget, oldest first, but always keep the newest
  // exchange (2 messages) so the model has something to work with.
  while (trimmed.length > 2 && totalChars(trimmed) > charLimit) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.length > 0 && totalChars(trimmed) > charLimit) {
    // Only reachable with an unusually small budget: shorten the newest message.
    const newest = trimmed[trimmed.length - 1];
    trimmed = [{ role: newest.role, content: newest.content.slice(0, charLimit) }];
  }

  return trimmed;
}

function totalChars(messages) {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

/**
 * @param {object} [options]
 * @param {{get: Function, put: Function, delete: Function}|null} [options.kv] CHAT_HISTORY binding.
 * @param {number} [options.maxMessages]
 * @param {number} [options.maxChars]
 * @param {Map<string, unknown>} [options.memory] Injectable for tests.
 * @param {number} [options.memoryMaxChats]
 */
export function createHistoryStore(options = {}) {
  const kv = options.kv ?? null;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
  const maxChars = options.maxChars ?? MAX_HISTORY_CHARS;
  const memory = options.memory ?? sharedMemoryHistory;
  const memoryMaxChats = options.memoryMaxChats ?? MEMORY_MAX_CHATS;
  const ttlSeconds = options.ttlSeconds ?? HISTORY_TTL_SECONDS;

  const mode = kv ? "kv" : "memory";

  // MAX_HISTORY_MESSAGES = 0 disables memory completely: nothing is read and
  // nothing is written, so every message is answered on its own.
  const historyEnabled = Number.isInteger(maxMessages) ? maxMessages > 0 : true;

  function touchMemory(key, value) {
    // Re-insert on access so eviction order is least-recently-used-ish.
    memory.delete(key);
    memory.set(key, value);
    while (memory.size > memoryMaxChats) {
      const oldest = memory.keys().next();
      if (oldest.done) break;
      memory.delete(oldest.value);
    }
  }

  async function load(chatId) {
    if (!historyEnabled) return [];

    const key = historyKey(chatId);
    let raw = null;

    if (kv) {
      try {
        raw = await kv.get(key);
      } catch (error) {
        throw new HistoryError(`Could not read conversation history from KV: ${error?.name ?? "error"}`);
      }
    } else {
      const stored = memory.get(key);
      raw = typeof stored === "string" ? stored : null;
      if (raw !== null) touchMemory(key, raw);
    }

    if (!raw) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return []; // corrupt value → start clean rather than fail the request
    }
    return trimHistory(parsed, maxMessages, maxChars);
  }

  /**
   * Persist one exchange (user message + assistant reply).
   * Read-modify-write: NOT atomic. Two concurrent messages from the same chat can
   * lose one of the two exchanges.
   */
  async function append(chatId, userText, assistantText) {
    if (!historyEnabled) return 0;

    const key = historyKey(chatId);
    const existing = await load(chatId);
    const next = trimHistory(
      [...existing, { role: "user", content: userText }, { role: "assistant", content: assistantText }],
      maxMessages,
      maxChars,
    );
    const value = JSON.stringify(next);

    if (kv) {
      try {
        await kv.put(key, value, { expirationTtl: ttlSeconds });
      } catch (error) {
        throw new HistoryError(`Could not write conversation history to KV: ${error?.name ?? "error"}`);
      }
      return next.length;
    }

    touchMemory(key, value);
    return next.length;
  }

  async function clear(chatId) {
    const key = historyKey(chatId);
    if (kv) {
      try {
        await kv.delete(key);
      } catch (error) {
        throw new HistoryError(`Could not delete conversation history from KV: ${error?.name ?? "error"}`);
      }
      return true;
    }
    return memory.delete(key);
  }

  return { mode, load, append, clear, maxMessages, enabled: historyEnabled };
}

export class HistoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "HistoryError";
  }
}

/**
 * Best-effort duplicate-update detection using `update_id`.
 *
 * Without KV this is a no-op: an in-memory Set could not survive isolate
 * recycling or span isolates, so it would give a false sense of safety.
 *
 * @param {object} [options]
 * @param {{get: Function, put: Function}|null} [options.kv]
 * @param {number} [options.ttlSeconds]
 */
export function createUpdateDedupe(options = {}) {
  const kv = options.kv ?? null;
  const ttlSeconds = options.ttlSeconds ?? UPDATE_DEDUPE_TTL_SECONDS;
  const enabled = Boolean(kv);

  async function isSeen(updateId) {
    if (!enabled || !Number.isFinite(updateId)) return false;
    try {
      const value = await kv.get(updateKey(updateId));
      return value !== null && value !== undefined;
    } catch {
      return false; // storage trouble must not break message handling
    }
  }

  async function markSeen(updateId) {
    if (!enabled || !Number.isFinite(updateId)) return false;
    try {
      await kv.put(updateKey(updateId), "1", { expirationTtl: ttlSeconds });
      return true;
    } catch {
      return false;
    }
  }

  return { enabled, isSeen, markSeen, ttlSeconds };
}
