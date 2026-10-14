import { test } from "node:test";
import assert from "node:assert/strict";

import {
  callTelegramApi,
  sendChatAction,
  sendLongMessage,
  sendMessage,
  splitLongText,
  TelegramApiError,
  TELEGRAM_MESSAGE_TEXT_LIMIT,
} from "../src/telegram.js";
import { createFetchMock, jsonResponse, TEST_BOT_TOKEN, textResponse } from "./support/mocks.js";

const CHAT_ID = 424242;

function telegramCall(handler) {
  const mock = createFetchMock({ telegram: handler });
  return { mock, api: { fetchImpl: mock.fetch, timeoutMs: 5000 } };
}

// ---------------------------------------------------------------
// callTelegramApi
// ---------------------------------------------------------------

test("callTelegramApi posts JSON to the Bot API method URL", async () => {
  const { mock, api } = telegramCall(() => jsonResponse({ ok: true, result: { message_id: 7 } }));
  const result = await callTelegramApi(TEST_BOT_TOKEN, "sendMessage", { chat_id: CHAT_ID, text: "hi" }, api);

  assert.deepEqual(result, { message_id: 7 });
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].url, `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`);
  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(mock.calls[0].json(), { chat_id: CHAT_ID, text: "hi" });
  assert.ok(mock.calls[0].signal instanceof AbortSignal);
});

test("sendMessage sends plain text with no parse_mode", async () => {
  const { mock, api } = telegramCall(undefined);
  await sendMessage(TEST_BOT_TOKEN, CHAT_ID, "*not* markdown", api);

  const payload = mock.telegramCalls()[0].payload;
  assert.deepEqual(payload, { chat_id: CHAT_ID, text: "*not* markdown" });
  assert.equal("parse_mode" in payload, false);
});

test("sendChatAction asks for the typing indicator", async () => {
  const { mock, api } = telegramCall(undefined);
  await sendChatAction(TEST_BOT_TOKEN, CHAT_ID, "typing", api);
  assert.equal(mock.telegramCalls()[0].telegramMethod, "sendChatAction");
  assert.deepEqual(mock.telegramCalls()[0].payload, { chat_id: CHAT_ID, action: "typing" });
});

test("ok:false raises a TelegramApiError carrying Telegram's description", async () => {
  const { api } = telegramCall(() => jsonResponse({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400));

  await assert.rejects(sendMessage(TEST_BOT_TOKEN, CHAT_ID, "hi", api), (error) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.status, 400);
    assert.equal(error.errorCode, 400);
    assert.equal(error.method, "sendMessage");
    assert.match(error.message, /chat not found/);
    return true;
  });
});

test("Telegram error text never contains the bot token", async () => {
  // Even if a proxy or error page echoed the token back, it must not travel on.
  const { api } = telegramCall(() =>
    jsonResponse({ ok: false, error_code: 401, description: `Unauthorized token ${TEST_BOT_TOKEN}` }, 401),
  );

  await assert.rejects(sendMessage(TEST_BOT_TOKEN, CHAT_ID, "hi", api), (error) => {
    assert.equal(error.message.includes(TEST_BOT_TOKEN), false);
    assert.equal(error.description.includes(TEST_BOT_TOKEN), false);
    assert.match(error.description, /\[REDACTED\]/);
    return true;
  });
});

test("a non-JSON error body still produces a usable error", async () => {
  const { api } = telegramCall(() => textResponse("<html>502 Bad Gateway</html>", 502));
  await assert.rejects(sendMessage(TEST_BOT_TOKEN, CHAT_ID, "hi", api), (error) => {
    assert.ok(error instanceof TelegramApiError);
    assert.match(error.message, /unexpected HTTP 502/);
    return true;
  });
});

test("HTTP 200 with ok:false is treated as a failure", async () => {
  const { api } = telegramCall(() => jsonResponse({ ok: false, description: "Forbidden: bot was blocked by the user" }));
  await assert.rejects(sendMessage(TEST_BOT_TOKEN, CHAT_ID, "hi", api), TelegramApiError);
});

test("a missing bot token fails before any network call", async () => {
  const mock = createFetchMock();
  await assert.rejects(sendMessage("", CHAT_ID, "hi", { fetchImpl: mock.fetch }), (error) => {
    assert.ok(error instanceof TelegramApiError);
    assert.match(error.message, /TELEGRAM_BOT_TOKEN/);
    return true;
  });
  assert.equal(mock.calls.length, 0);
});

test("a network failure is reported with the method name only", async () => {
  const { api } = telegramCall(() => Promise.reject(new TypeError("Failed to fetch")));
  await assert.rejects(sendMessage(TEST_BOT_TOKEN, CHAT_ID, "hi", api), (error) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.method, "sendMessage");
    assert.match(error.message, /Could not reach the Telegram API/);
    assert.equal(error.message.includes(TEST_BOT_TOKEN), false);
    return true;
  });
});

test("a timeout is reported as such", async () => {
  const timeoutError = new Error("timed out");
  timeoutError.name = "TimeoutError";
  const { api } = telegramCall(() => Promise.reject(timeoutError));
  await assert.rejects(sendMessage(TEST_BOT_TOKEN, CHAT_ID, "hi", api), (error) => {
    assert.match(error.message, /timed out after 5000 ms/);
    return true;
  });
});

// ---------------------------------------------------------------
// splitLongText
// ---------------------------------------------------------------

test("short text is returned as a single chunk", () => {
  assert.deepEqual(splitLongText("hello"), ["hello"]);
  assert.deepEqual(splitLongText("x".repeat(TELEGRAM_MESSAGE_TEXT_LIMIT)), ["x".repeat(TELEGRAM_MESSAGE_TEXT_LIMIT)]);
});

test("empty and whitespace-only text produces no chunks", () => {
  assert.deepEqual(splitLongText(""), []);
  assert.deepEqual(splitLongText("   \n\n  "), []);
  assert.deepEqual(splitLongText(null), []);
  assert.deepEqual(splitLongText(undefined), []);
});

test("an invalid limit is rejected", () => {
  assert.throws(() => splitLongText("abc", 0), RangeError);
  assert.throws(() => splitLongText("abc", -1), RangeError);
  assert.throws(() => splitLongText("abc", Number.NaN), RangeError);
});

test("long text is split into chunks that all fit the Telegram limit", () => {
  const paragraph = "The quick brown fox jumps over the lazy dog. ".repeat(70); // ~3150 chars
  const text = [paragraph, paragraph, paragraph].join("\n\n");
  assert.ok(text.length > TELEGRAM_MESSAGE_TEXT_LIMIT * 2);

  const chunks = splitLongText(text);
  assert.ok(chunks.length >= 3, `expected at least 3 chunks, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= TELEGRAM_MESSAGE_TEXT_LIMIT, `chunk too long: ${chunk.length}`);
    assert.ok(chunk.length > 0, "chunks must not be empty");
  }
  // No words are lost or duplicated.
  assert.equal(
    chunks.join(" ").replace(/\s+/g, " ").trim(),
    text.replace(/\s+/g, " ").trim(),
  );
});

test("splits prefer paragraph breaks over mid-sentence cuts", () => {
  const first = "A".repeat(3000);
  const second = "B".repeat(3000);
  const chunks = splitLongText(`${first}\n\n${second}`, 4096);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], first);
  assert.equal(chunks[1], second);
});

test("splits prefer line breaks when there is no paragraph break", () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index} ${"x".repeat(30)}`);
  const text = lines.join("\n");
  const chunks = splitLongText(text, 500);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 500);
    const chunkLines = chunk.split("\n");
    for (const line of chunkLines) {
      assert.ok(lines.includes(line), `chunk contains a partial line: ${JSON.stringify(line.slice(0, 40))}`);
    }
  }
});

test("splits on word boundaries when a paragraph has no breaks", () => {
  const text = "word ".repeat(2000).trim();
  const chunks = splitLongText(text, 100);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
    assert.equal(chunk.endsWith("word") || chunk === "word", true, `chunk ends mid-word: ${JSON.stringify(chunk.slice(-12))}`);
  }
  assert.equal(chunks.join(" "), text);
});

test("a single oversized word is hard-cut rather than dropped", () => {
  const text = "x".repeat(10000);
  const chunks = splitLongText(text, 4096);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(""), text);
  for (const chunk of chunks) assert.ok(chunk.length <= 4096);
});

test("splitting respects a custom limit", () => {
  const chunks = splitLongText("alpha beta gamma delta", 11);
  assert.deepEqual(chunks, ["alpha beta", "gamma delta"]);
});

// ---------------------------------------------------------------
// sendLongMessage
// ---------------------------------------------------------------

test("sendLongMessage sends each chunk in order", async () => {
  const { mock, api } = telegramCall(undefined);
  const text = ["first part", "second part", "third part"].join("\n\n");

  const result = await sendLongMessage(TEST_BOT_TOKEN, CHAT_ID, text, { ...api, limit: 12 });

  assert.equal(result.error, null);
  assert.equal(result.sent, 3);
  assert.equal(result.total, 3);
  assert.deepEqual(mock.sentTexts(), ["first part", "second part", "third part"]);
});

test("sendLongMessage reports a partial delivery instead of throwing", async () => {
  let call = 0;
  const { mock, api } = telegramCall(() => {
    call += 1;
    if (call === 2) return jsonResponse({ ok: false, error_code: 429, description: "Too Many Requests" }, 429);
    return jsonResponse({ ok: true, result: { message_id: call } });
  });

  const result = await sendLongMessage(TEST_BOT_TOKEN, CHAT_ID, "a\n\nb\n\nc", { ...api, limit: 1 });
  assert.equal(result.sent, 1);
  assert.equal(result.total, 3);
  assert.ok(result.error instanceof TelegramApiError);
  assert.equal(result.error.status, 429);
  assert.equal(mock.telegramCalls().length, 2, "sending should stop after the failure");
});

test("sendLongMessage sends nothing for an empty reply", async () => {
  const { mock, api } = telegramCall(undefined);
  const result = await sendLongMessage(TEST_BOT_TOKEN, CHAT_ID, "", api);
  assert.deepEqual(result, { sent: 0, total: 0, error: null });
  assert.equal(mock.telegramCalls().length, 0);
});

test("a long model reply is delivered as several Telegram messages", async () => {
  const { mock, api } = telegramCall(undefined);
  const longReply = "Sentence number one. ".repeat(1200); // ~25k characters
  const result = await sendLongMessage(TEST_BOT_TOKEN, CHAT_ID, longReply, api);

  assert.equal(result.error, null);
  assert.ok(result.sent >= 6, `expected several chunks, got ${result.sent}`);
  const texts = mock.sentTexts();
  for (const text of texts) assert.ok(text.length <= TELEGRAM_MESSAGE_TEXT_LIMIT);
  assert.equal(texts.join(" ").replace(/\s+/g, " ").trim(), longReply.replace(/\s+/g, " ").trim());
});
