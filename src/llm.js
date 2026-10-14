/**
 * llm.js — OpenAI-compatible Chat Completions client.
 *
 * Works with any provider that implements `POST {API_BASE_URL}/chat/completions`
 * and answers with `choices[0].message.content`. No provider is hardcoded, no
 * streaming, no tools, no provider-specific extensions.
 *
 * The API key is only ever used in the `Authorization` request header. Error
 * messages are scrubbed of it before they are logged or shown to anyone.
 *
 * Runs on the Cloudflare Workers runtime (native fetch / URL / AbortSignal only,
 * no Node.js APIs).
 */

/** Wall-clock budget for one model call. Bounded: never retried in a loop. */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

const CHAT_COMPLETIONS_PATH = "/chat/completions";

/**
 * Error kinds produced by this module:
 *  - "config"           → a required setting is missing or unusable
 *  - "timeout"          → the provider did not answer in time
 *  - "network"          → DNS/TLS/connection failure
 *  - "http"             → non-2xx response (see `.status`)
 *  - "invalid-response" → body is not the expected JSON shape
 *  - "empty-response"   → valid JSON, but no usable content
 */
export class LlmError extends Error {
  /**
   * @param {string} message Technical detail, safe to log (already scrubbed).
   * @param {object} [info]
   * @param {string} [info.kind]
   * @param {number|null} [info.status]
   * @param {string} [info.userMessage] Short, non-technical text for the Telegram user.
   * @param {string|null} [info.providerDetail] Extra detail from the provider, for logs only.
   */
  constructor(message, info = {}) {
    super(message);
    this.name = "LlmError";
    this.kind = info.kind ?? "unknown";
    this.status = info.status ?? null;
    this.userMessage = info.userMessage ?? "The model request failed. Please try again.";
    this.providerDetail = info.providerDetail ?? null;
  }
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

/** Remove a secret from any text we might log or display. */
function scrub(text, secret) {
  let out = typeof text === "string" ? text : "";
  if (secret && out.includes(secret)) {
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/**
 * Build the Chat Completions endpoint from a configured base URL.
 *
 * Accepts "https://api.example.com/v1", "https://api.example.com/v1/",
 * "https://api.example.com/v1/chat/completions" and nested paths, and always
 * produces exactly one "/chat/completions" suffix. Existing query parameters
 * (some providers need them, e.g. an api-version) are preserved.
 *
 * @param {string} baseUrl
 * @returns {string}
 * @throws {LlmError} kind "config"
 */
export function buildChatCompletionsUrl(baseUrl) {
  const raw = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (raw === "") {
    throw new LlmError("API_BASE_URL is not configured.", {
      kind: "config",
      userMessage: "The bot is not configured yet (API_BASE_URL is missing).",
    });
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new LlmError(`API_BASE_URL is not a valid absolute URL (got ${raw.length} characters).`, {
      kind: "config",
      userMessage: "The bot is not configured correctly (API_BASE_URL is not a valid URL).",
    });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LlmError(`API_BASE_URL must start with https:// or http:// (got "${url.protocol}").`, {
      kind: "config",
      userMessage: "The bot is not configured correctly (API_BASE_URL must be http/https).",
    });
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (!path.toLowerCase().endsWith(CHAT_COMPLETIONS_PATH)) {
    url.pathname = `${path}${CHAT_COMPLETIONS_PATH}`;
  } else {
    url.pathname = path;
  }
  url.hash = "";

  return url.toString();
}

/**
 * Send one non-streaming chat completion request.
 *
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {string} params.apiKey
 * @param {string} params.model
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {number} [params.timeoutMs]
 * @param {typeof fetch} [params.fetchImpl] Injectable for tests.
 * @returns {Promise<{content: string, finishReason: string|null, model: string|null}>}
 * @throws {LlmError}
 */
export async function createChatCompletion(params) {
  const { baseUrl, apiKey, model, messages } = params;
  const timeoutMs = params.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const fetchImpl = params.fetchImpl ?? fetch;

  const url = buildChatCompletionsUrl(baseUrl);

  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new LlmError("API_KEY is not configured.", {
      kind: "config",
      userMessage: "The bot is not configured yet (API_KEY is missing).",
    });
  }
  if (typeof model !== "string" || model.trim() === "") {
    throw new LlmError("MODEL is not configured.", {
      kind: "config",
      userMessage: "The bot is not configured yet (MODEL is missing).",
    });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new LlmError("No messages were provided for the model request.", { kind: "config" });
  }

  const body = { model, messages, stream: false };

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new LlmError(`Model request timed out after ${timeoutMs} ms.`, {
        kind: "timeout",
        userMessage: `The model did not answer within ${Math.round(timeoutMs / 1000)} seconds. Please try again.`,
      });
    }
    throw new LlmError(`Model request could not be sent: ${scrub(String(error?.message ?? error), apiKey)}`, {
      kind: "network",
      userMessage: "I could not reach the model provider. Check API_BASE_URL and try again later.",
    });
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response, apiKey);
    throw new LlmError(`Model provider returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`, {
      kind: "http",
      status: response.status,
      providerDetail: detail,
      userMessage: userMessageForStatus(response.status),
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new LlmError("Model provider returned a body that is not valid JSON.", {
      kind: "invalid-response",
      userMessage: "The model provider sent an unreadable response. Please try again.",
    });
  }

  const content = extractContent(payload);
  if (content === "") {
    const finishReason = readFinishReason(payload);
    throw new LlmError(
      `Model provider returned no content${finishReason ? ` (finish_reason: ${finishReason})` : ""}.`,
      {
        kind: "empty-response",
        userMessage:
          finishReason === "length"
            ? "The model hit its output token limit before producing an answer. Try a shorter prompt."
            : "The model returned an empty answer. Please try again.",
      },
    );
  }

  return {
    content,
    finishReason: readFinishReason(payload),
    model: payload && typeof payload.model === "string" ? payload.model : null,
  };
}

/** Short, non-technical explanation for a user, based only on the HTTP status. */
export function userMessageForStatus(status) {
  if (status === 401 || status === 403) {
    return "The model provider rejected the API key. The bot owner needs to check API_KEY.";
  }
  if (status === 404) {
    return "The model provider did not recognise the endpoint or model name. The bot owner needs to check API_BASE_URL and MODEL.";
  }
  if (status === 413) {
    return "The conversation is too large for the model provider. Send /new to start over.";
  }
  if (status === 429) {
    return "The model provider is rate limiting requests right now. Please try again in a minute.";
  }
  if (status >= 500) {
    return "The model provider is currently failing (server error). Please try again later.";
  }
  return `The model provider returned an error (HTTP ${status}). Please try again later.`;
}

async function readErrorDetail(response, apiKey) {
  const raw = await response.text().catch(() => "");
  if (!raw) return null;

  let text = null;
  try {
    const data = JSON.parse(raw);
    const error = data?.error;
    if (typeof error === "string") text = error;
    else if (error && typeof error.message === "string") text = error.message;
    else if (typeof data?.message === "string") text = data.message;
    else if (typeof data?.detail === "string") text = data.detail;
  } catch {
    text = null;
  }

  if (text === null) text = raw.replace(/\s+/g, " ");
  return scrub(text, apiKey).slice(0, 200);
}

/**
 * Read `choices[0].message.content` defensively.
 * Accepts a plain string, or an array of `{type:"text", text:"..."}` parts.
 * @returns {string} trimmed content, or "" when nothing usable was returned.
 */
export function extractContent(payload) {
  if (!payload || typeof payload !== "object") return "";
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";

  const message = choices[0]?.message;
  if (!message || typeof message !== "object") return "";

  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && typeof part === "object" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  return "";
}

function readFinishReason(payload) {
  const reason = payload?.choices?.[0]?.finish_reason;
  return typeof reason === "string" ? reason : null;
}
