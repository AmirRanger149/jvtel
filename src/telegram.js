/**
 * telegram.js — a tiny Telegram Bot API client.
 *
 * Only the calls this bot needs are implemented: sendMessage and sendChatAction.
 * Nothing in this file may ever put the bot token into an error message, a log
 * line, or a response body: the token lives in the request URL, so error text is
 * built from the API *method name* instead of the URL.
 *
 * Runs on the Cloudflare Workers runtime (native fetch / URL / AbortSignal only,
 * no Node.js APIs).
 */

export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Telegram rejects sendMessage text longer than this (after entity parsing). */
export const TELEGRAM_MESSAGE_TEXT_LIMIT = 4096;

/** Wall-clock budget for a single Telegram API call. */
export const TELEGRAM_TIMEOUT_MS = 15_000;

export class TelegramApiError extends Error {
  /**
   * @param {string} message Technical detail (safe to log, never contains the token).
   * @param {object} [info]
   * @param {string} [info.method] Telegram API method, e.g. "sendMessage".
   * @param {number|null} [info.status] HTTP status returned by Telegram.
   * @param {number|null} [info.errorCode] Telegram's `error_code`.
   * @param {string|null} [info.description] Telegram's `description`.
   */
  constructor(message, info = {}) {
    super(message);
    this.name = "TelegramApiError";
    this.method = info.method ?? null;
    this.status = info.status ?? null;
    this.errorCode = info.errorCode ?? null;
    this.description = info.description ?? null;
  }
}

/** Remove the bot token from any text we might log or surface. */
function scrubSecret(text, secret) {
  let out = typeof text === "string" ? text : "";
  if (secret && out.includes(secret)) out = out.split(secret).join("[REDACTED]");
  return out;
}

function isAbortError(error) {
  return (
    error &&
    (error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      error.code === 20 ||
      error.code === "ABORT_ERR")
  );
}

/**
 * Call one Telegram Bot API method.
 *
 * @param {string} botToken
 * @param {string} method e.g. "sendMessage"
 * @param {object} [payload] JSON body
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] Injectable for tests.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<unknown>} Telegram's `result` field.
 * @throws {TelegramApiError}
 */
export async function callTelegramApi(botToken, method, payload = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TELEGRAM_TIMEOUT_MS;

  if (typeof botToken !== "string" || botToken.trim() === "") {
    throw new TelegramApiError(`Cannot call Telegram "${method}": TELEGRAM_BOT_TOKEN is not configured.`, {
      method,
    });
  }

  // The token is part of the URL — keep the URL local to this function.
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new TelegramApiError(`Telegram "${method}" timed out after ${timeoutMs} ms.`, { method });
    }
    throw new TelegramApiError(`Could not reach the Telegram API while calling "${method}".`, { method });
  }

  const raw = await response.text().catch(() => "");
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  const ok = response.ok && data && data.ok === true;
  if (!ok) {
    const description =
      data && typeof data.description === "string"
        ? scrubSecret(data.description, botToken).slice(0, 300)
        : `unexpected HTTP ${response.status}`;
    throw new TelegramApiError(`Telegram "${method}" failed: ${description}`, {
      method,
      status: response.status,
      errorCode: data && typeof data.error_code === "number" ? data.error_code : null,
      description,
    });
  }

  return data.result;
}

/**
 * Send one plain-text message (no parse_mode: plain text avoids Markdown
 * entity parsing failures on arbitrary model output).
 */
export async function sendMessage(botToken, chatId, text, options = {}) {
  return callTelegramApi(
    botToken,
    "sendMessage",
    { chat_id: chatId, text },
    options,
  );
}

/** Best-effort "typing…" indicator. Callers should swallow errors. */
export async function sendChatAction(botToken, chatId, action = "typing", options = {}) {
  return callTelegramApi(botToken, "sendChatAction", { chat_id: chatId, action }, options);
}

/**
 * Split text into Telegram-safe chunks.
 *
 * Prefers paragraph breaks, then line breaks, then word breaks, and only hard
 * cuts when a single word is longer than the limit. Never returns an empty
 * chunk and never returns a chunk longer than `limit`.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function splitLongText(text, limit = TELEGRAM_MESSAGE_TEXT_LIMIT) {
  const input = typeof text === "string" ? text : String(text ?? "");
  if (input.trim() === "") return [];
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RangeError("splitLongText: limit must be a number >= 1");
  }
  if (input.length <= limit) return [input];

  const chunks = [];
  let remaining = input;

  while (remaining.length > limit) {
    const cut = findCutPoint(remaining, limit);
    const piece = remaining.slice(0, cut).replace(/\s+$/, "");
    if (piece !== "") chunks.push(piece);
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }

  const tail = remaining.replace(/\s+$/, "");
  if (tail !== "") chunks.push(tail);
  return chunks;
}

/** Index (exclusive) at which `text` should be cut. Always >= 1. */
function findCutPoint(text, limit) {
  const window = text.slice(0, limit);
  const minimum = Math.floor(limit / 2); // avoid uselessly small chunks

  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= minimum) return paragraph + 2;

  const line = window.lastIndexOf("\n");
  if (line >= minimum) return line + 1;

  const space = window.lastIndexOf(" ");
  if (space >= minimum) return space + 1;

  return limit; // one oversized word: hard cut is the only option
}

/**
 * Send a long reply as several messages.
 *
 * Chunks are sent sequentially so the order is preserved. This does not throw on
 * a Telegram failure: it reports how many chunks were delivered so the caller can
 * decide whether the exchange is worth storing in the conversation history.
 *
 * @returns {Promise<{sent: number, total: number, error: TelegramApiError|null}>}
 */
export async function sendLongMessage(botToken, chatId, text, options = {}) {
  const chunks = splitLongText(text, options.limit);
  let sent = 0;

  for (const chunk of chunks) {
    try {
      await sendMessage(botToken, chatId, chunk, options);
      sent += 1;
    } catch (error) {
      return { sent, total: chunks.length, error: asTelegramError(error) };
    }
  }

  return { sent, total: chunks.length, error: null };
}

function asTelegramError(error) {
  if (error instanceof TelegramApiError) return error;
  return new TelegramApiError(
    `Unexpected error while sending a Telegram message: ${error?.name ?? "Error"}`,
  );
}
