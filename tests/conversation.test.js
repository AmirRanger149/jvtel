import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createHistoryStore,
  createUpdateDedupe,
  HISTORY_TTL_SECONDS,
  historyKey,
  MAX_HISTORY_CHARS,
  trimHistory,
  UPDATE_DEDUPE_TTL_SECONDS,
  updateKey,
} from "../src/conversation.js";
import { createMockKv } from "./support/mocks.js";

const CHAT = 424242;

// ---------------------------------------------------------------
// Keys
// ---------------------------------------------------------------

test("history keys are stable and separated per chat", () => {
  assert.equal(historyKey(424242), "chat:424242");
  assert.equal(historyKey(-1001234567890), "chat:-1001234567890");
  assert.notEqual(historyKey(111), historyKey(222));
  assert.equal(updateKey(1001), "update:1001");
});

// ---------------------------------------------------------------
// trimHistory
// ---------------------------------------------------------------

test("trimHistory keeps only user and assistant messages with string content", () => {
  const trimmed = trimHistory([
    { role: "system", content: "ignored" },
    { role: "user", content: "hello" },
    { role: "tool", content: "ignored" },
    { role: "assistant", content: "hi" },
    { role: "user", content: 42 },
    { role: "user" },
    null,
    "junk",
  ]);
  assert.deepEqual(trimmed, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]);
});

test("trimHistory keeps the newest MAX_HISTORY_MESSAGES entries", () => {
  const messages = [];
  for (let index = 0; index < 10; index += 1) {
    messages.push({ role: "user", content: `question ${index}` });
    messages.push({ role: "assistant", content: `answer ${index}` });
  }
  const trimmed = trimHistory(messages, 12);
  assert.equal(trimmed.length, 12);
  assert.deepEqual(trimmed[0], { role: "user", content: "question 4" });
  assert.deepEqual(trimmed[11], { role: "assistant", content: "answer 9" });
});

test("trimHistory with 0 keeps nothing usable and falls back to the newest exchange", () => {
  // 0 is not a valid message budget; the default protects against a bad value.
  const trimmed = trimHistory(
    [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ],
    0,
  );
  assert.equal(trimmed.length, 3);
});

test("trimHistory enforces the character budget, oldest first", () => {
  const messages = [
    { role: "user", content: "x".repeat(500) },
    { role: "assistant", content: "y".repeat(500) },
    { role: "user", content: "z".repeat(100) },
    { role: "assistant", content: "w".repeat(100) },
  ];
  const trimmed = trimHistory(messages, 12, 300);
  assert.ok(trimmed.length < messages.length);
  assert.deepEqual(trimmed, [
    { role: "user", content: "z".repeat(100) },
    { role: "assistant", content: "w".repeat(100) },
  ]);
});

test("trimHistory never returns more than the character budget", () => {
  const messages = [{ role: "user", content: "x".repeat(MAX_HISTORY_CHARS * 2) }];
  const trimmed = trimHistory(messages, 12, MAX_HISTORY_CHARS);
  assert.equal(trimmed.length, 1);
  assert.ok(trimmed[0].content.length <= MAX_HISTORY_CHARS);
});

test("trimHistory rejects non-arrays", () => {
  assert.deepEqual(trimHistory(null), []);
  assert.deepEqual(trimHistory(undefined), []);
  assert.deepEqual(trimHistory({ role: "user" }), []);
  assert.deepEqual(trimHistory("nope"), []);
});

// ---------------------------------------------------------------
// KV-backed store
// ---------------------------------------------------------------

test("a KV store reports mode kv, loads empty history and round-trips an exchange", async () => {
  const kv = createMockKv();
  const store = createHistoryStore({ kv, maxMessages: 12 });
  assert.equal(store.mode, "kv");

  assert.deepEqual(await store.load(CHAT), []);

  await store.append(CHAT, "Hello", "Hi there");
  assert.deepEqual(await store.load(CHAT), [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
  ]);
  assert.deepEqual(JSON.parse(kv.store.get("chat:424242")), [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
  ]);
});

test("history is written with an expiry so KV cannot grow forever", async () => {
  const kv = createMockKv();
  const store = createHistoryStore({ kv });
  await store.append(CHAT, "a", "b");

  const put = kv.log.find((entry) => entry.op === "put");
  assert.equal(put.options.expirationTtl, HISTORY_TTL_SECONDS);
  assert.ok(HISTORY_TTL_SECONDS >= 60, "KV rejects a TTL below 60 seconds");
});

test("history is trimmed to MAX_HISTORY_MESSAGES on every append", async () => {
  const kv = createMockKv();
  const store = createHistoryStore({ kv, maxMessages: 4 });

  for (let index = 0; index < 6; index += 1) {
    await store.append(CHAT, `q${index}`, `a${index}`);
  }

  const stored = kv.history(CHAT);
  assert.equal(stored.length, 4);
  assert.deepEqual(stored, [
    { role: "user", content: "q4" },
    { role: "assistant", content: "a4" },
    { role: "user", content: "q5" },
    { role: "assistant", content: "a5" },
  ]);
});

test("histories of different chats never mix", async () => {
  const kv = createMockKv();
  const store = createHistoryStore({ kv });

  await store.append(111, "private question", "private answer");
  await store.append(-100999, "group question", "group answer");

  assert.deepEqual(await store.load(111), [
    { role: "user", content: "private question" },
    { role: "assistant", content: "private answer" },
  ]);
  assert.deepEqual(await store.load(-100999), [
    { role: "user", content: "group question" },
    { role: "assistant", content: "group answer" },
  ]);
});

test("/new style clear deletes the stored conversation", async () => {
  const kv = createMockKv();
  const store = createHistoryStore({ kv });
  await store.append(CHAT, "a", "b");
  assert.equal(kv.store.has("chat:424242"), true);

  await store.clear(CHAT);
  assert.equal(kv.store.has("chat:424242"), false);
  assert.deepEqual(await store.load(CHAT), []);
  assert.ok(kv.log.some((entry) => entry.op === "delete" && entry.key === "chat:424242"));
});

test("clearing an unknown chat is harmless", async () => {
  const kv = createMockKv();
  const store = createHistoryStore({ kv });
  await store.clear(999);
  assert.deepEqual(await store.load(999), []);
});

test("a corrupt stored value loads as an empty history", async () => {
  const kv = createMockKv();
  kv.store.set("chat:424242", "{not json");
  const store = createHistoryStore({ kv });
  assert.deepEqual(await store.load(CHAT), []);
});

test("a stored value in an unexpected shape is sanitised", async () => {
  const kv = createMockKv();
  kv.store.set("chat:424242", JSON.stringify({ nonsense: true }));
  const store = createHistoryStore({ kv });
  assert.deepEqual(await store.load(CHAT), []);
});

test("KV read and write failures surface as HistoryError", async () => {
  const failingGet = createMockKv({ failOn: "get" });
  const failingPut = createMockKv({ failOn: "put" });
  const failingDelete = createMockKv({ failOn: "delete" });

  await assert.rejects(createHistoryStore({ kv: failingGet }).load(CHAT), { name: "HistoryError" });
  await assert.rejects(createHistoryStore({ kv: failingPut }).append(CHAT, "a", "b"), { name: "HistoryError" });
  await assert.rejects(createHistoryStore({ kv: failingDelete }).clear(CHAT), { name: "HistoryError" });
});

// ---------------------------------------------------------------
// In-memory fallback store
// ---------------------------------------------------------------

test("without KV the store runs in memory mode and still separates chats", async () => {
  const store = createHistoryStore({ memory: new Map() });
  assert.equal(store.mode, "memory");

  await store.append(111, "q", "a");
  assert.deepEqual(await store.load(111), [
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
  ]);
  assert.deepEqual(await store.load(222), []);

  await store.clear(111);
  assert.deepEqual(await store.load(111), []);
});

test("the in-memory store is bounded and evicts the oldest chats", async () => {
  const memory = new Map();
  const store = createHistoryStore({ memory, memoryMaxChats: 3 });

  for (const chatId of [1, 2, 3, 4, 5]) {
    await store.append(chatId, `q${chatId}`, `a${chatId}`);
  }

  assert.ok(memory.size <= 3, `memory grew to ${memory.size}`);
  assert.deepEqual(await store.load(1), []); // evicted
  assert.equal((await store.load(5)).length, 2); // newest survives
});

test("the default in-memory store is not shared with the KV mode", async () => {
  const kv = createMockKv();
  const kvStore = createHistoryStore({ kv });
  const memoryStore = createHistoryStore({});

  await kvStore.append(CHAT, "kv only", "kv only answer");
  assert.deepEqual(await memoryStore.load(CHAT), []);
});

// ---------------------------------------------------------------
// Duplicate update detection
// ---------------------------------------------------------------

test("with KV an update_id is remembered", async () => {
  const kv = createMockKv();
  const dedupe = createUpdateDedupe({ kv });
  assert.equal(dedupe.enabled, true);

  assert.equal(await dedupe.isSeen(1001), false);
  assert.equal(await dedupe.markSeen(1001), true);
  assert.equal(await dedupe.isSeen(1001), true);
  assert.equal(await dedupe.isSeen(1002), false);
  assert.equal(kv.log.find((entry) => entry.op === "put").options.expirationTtl, UPDATE_DEDUPE_TTL_SECONDS);
});

test("without KV duplicate detection is honestly reported as disabled", async () => {
  const dedupe = createUpdateDedupe({});
  assert.equal(dedupe.enabled, false);
  assert.equal(await dedupe.isSeen(1001), false);
  assert.equal(await dedupe.markSeen(1001), false);
  assert.equal(await dedupe.isSeen(1001), false);
});

test("KV failures never break duplicate detection", async () => {
  const kv = createMockKv({ failOn: "get" });
  const dedupe = createUpdateDedupe({ kv });
  assert.equal(await dedupe.isSeen(1001), false);

  const failingPut = createMockKv({ failOn: "put" });
  assert.equal(await createUpdateDedupe({ kv: failingPut }).markSeen(1001), false);
});

test("a non-numeric update_id is ignored", async () => {
  const kv = createMockKv();
  const dedupe = createUpdateDedupe({ kv });
  assert.equal(await dedupe.isSeen("abc"), false);
  assert.equal(await dedupe.markSeen(undefined), false);
  assert.equal(kv.log.length, 0);
});
