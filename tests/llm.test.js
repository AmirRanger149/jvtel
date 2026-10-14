import { test } from "node:test";
import assert from "node:assert/strict";

import { buildChatCompletionsUrl, createChatCompletion, extractContent, LlmError, userMessageForStatus } from "../src/llm.js";
import { createFetchMock, jsonResponse, llmOk, TEST_API_KEY, textResponse } from "./support/mocks.js";

const BASE = "https://llm.test/v1";
const MESSAGES = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "Hello" },
];

function call(overrides = {}, fetchOverrides = {}) {
  const mock = createFetchMock(fetchOverrides);
  const promise = createChatCompletion({
    baseUrl: BASE,
    apiKey: TEST_API_KEY,
    model: "test-model",
    messages: MESSAGES,
    timeoutMs: 5000,
    fetchImpl: mock.fetch,
    ...overrides,
  });
  return { mock, promise };
}

// ---------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------

test("buildChatCompletionsUrl appends the endpoint to a versioned base URL", () => {
  assert.equal(buildChatCompletionsUrl("https://api.example.com/v1"), "https://api.example.com/v1/chat/completions");
});

test("buildChatCompletionsUrl normalises trailing slashes", () => {
  assert.equal(buildChatCompletionsUrl("https://api.example.com/v1/"), "https://api.example.com/v1/chat/completions");
  assert.equal(buildChatCompletionsUrl("https://api.example.com/v1///"), "https://api.example.com/v1/chat/completions");
});

test("buildChatCompletionsUrl does not duplicate an existing endpoint path", () => {
  assert.equal(
    buildChatCompletionsUrl("https://api.example.com/v1/chat/completions"),
    "https://api.example.com/v1/chat/completions",
  );
  assert.equal(
    buildChatCompletionsUrl("https://api.example.com/v1/chat/completions/"),
    "https://api.example.com/v1/chat/completions",
  );
});

test("buildChatCompletionsUrl matches the endpoint path case-insensitively", () => {
  assert.equal(
    buildChatCompletionsUrl("https://api.example.com/v1/Chat/Completions"),
    "https://api.example.com/v1/Chat/Completions",
  );
});

test("buildChatCompletionsUrl handles a bare host and nested paths", () => {
  assert.equal(buildChatCompletionsUrl("https://gateway.internal"), "https://gateway.internal/chat/completions");
  assert.equal(
    buildChatCompletionsUrl("https://gateway.internal/api/openai/v1"),
    "https://gateway.internal/api/openai/v1/chat/completions",
  );
  assert.equal(buildChatCompletionsUrl("http://127.0.0.1:8000/v1"), "http://127.0.0.1:8000/v1/chat/completions");
});

test("buildChatCompletionsUrl keeps provider query parameters and drops the fragment", () => {
  assert.equal(
    buildChatCompletionsUrl("https://llm.test/openai?api-version=2024-06-01#frag"),
    "https://llm.test/openai/chat/completions?api-version=2024-06-01",
  );
});

test("buildChatCompletionsUrl rejects unusable base URLs", () => {
  for (const bad of ["", "   ", "not a url", "llm.test/v1", "ftp://llm.test/v1", "file:///etc/passwd"]) {
    assert.throws(() => buildChatCompletionsUrl(bad), LlmError, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  try {
    buildChatCompletionsUrl("");
  } catch (error) {
    assert.equal(error.kind, "config");
    assert.match(error.userMessage, /API_BASE_URL/);
  }
});

// ---------------------------------------------------------------
// Successful calls
// ---------------------------------------------------------------

test("a successful completion returns the message content", async () => {
  const { promise } = call({}, { llm: () => llmOk("Hello! How can I help?") });
  const result = await promise;
  assert.equal(result.content, "Hello! How can I help?");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.model, "test-model");
});

test("the request is a POST to the derived endpoint with a Bearer key and stream:false", async () => {
  const { mock, promise } = call({}, { llm: () => llmOk("ok") });
  await promise;

  assert.equal(mock.calls.length, 1);
  const [request] = mock.calls;
  assert.equal(request.url, "https://llm.test/v1/chat/completions");
  assert.equal(request.method, "POST");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.headers.Authorization, `Bearer ${TEST_API_KEY}`);

  const body = request.json();
  assert.equal(body.model, "test-model");
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, MESSAGES);
});

test("the request body never contains the API key", async () => {
  const { mock, promise } = call({}, { llm: () => llmOk("ok") });
  await promise;
  assert.equal(mock.calls[0].body.includes(TEST_API_KEY), false);
});

test("a bounded AbortSignal is attached to the request", async () => {
  const { mock, promise } = call({}, { llm: () => llmOk("ok") });
  await promise;
  assert.ok(mock.calls[0].signal instanceof AbortSignal, "expected an AbortSignal on the fetch init");
});

test("the provider URL from the config is used verbatim (no hardcoded provider)", async () => {
  const { mock, promise } = call({ baseUrl: "https://openrouter.ai/api/v1/" }, { llm: () => llmOk("ok") });
  await promise;
  assert.equal(mock.calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
});

test("leading and trailing whitespace in the content is trimmed", async () => {
  const { promise } = call({}, { llm: () => llmOk("\n\n  spaced answer \n") });
  assert.equal((await promise).content, "spaced answer");
});

// ---------------------------------------------------------------
// Response shape handling
// ---------------------------------------------------------------

test("extractContent reads choices[0].message.content defensively", () => {
  assert.equal(extractContent({ choices: [{ message: { content: "hi" } }] }), "hi");
  assert.equal(extractContent({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] }), "a\nb");
  assert.equal(extractContent({ choices: [] }), "");
  assert.equal(extractContent({ choices: [{}] }), "");
  assert.equal(extractContent({ choices: [{ message: {} }] }), "");
  assert.equal(extractContent({ choices: [{ message: { content: null } }] }), "");
  assert.equal(extractContent({ choices: [{ message: { content: 42 } }] }), "");
  assert.equal(extractContent({}), "");
  assert.equal(extractContent(null), "");
  assert.equal(extractContent("nope"), "");
});

test("a malformed JSON body is reported as invalid-response", async () => {
  const { promise } = call({}, { llm: () => textResponse("<html>not json</html>") });
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.kind, "invalid-response");
    assert.match(error.userMessage, /unreadable response/i);
    return true;
  });
});

test("a valid JSON body without choices is reported as empty-response", async () => {
  const { promise } = call({}, { llm: () => jsonResponse({ id: "x", data: [] }) });
  await assert.rejects(promise, (error) => {
    assert.equal(error.kind, "empty-response");
    return true;
  });
});

test("missing content is reported as empty-response", async () => {
  const { promise } = call({}, { llm: () => jsonResponse({ choices: [{ message: { role: "assistant" } }] }) });
  await assert.rejects(promise, (error) => {
    assert.equal(error.kind, "empty-response");
    assert.match(error.userMessage, /empty answer/i);
    return true;
  });
});

test("a length-truncated empty completion tells the user to shorten the prompt", async () => {
  const { promise } = call({}, { llm: () => jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) });
  await assert.rejects(promise, (error) => {
    assert.equal(error.kind, "empty-response");
    assert.match(error.userMessage, /token limit/i);
    return true;
  });
});

// ---------------------------------------------------------------
// HTTP failures
// ---------------------------------------------------------------

test("HTTP 401 points at the API key without echoing it", async () => {
  const { promise } = call({}, { llm: () => jsonResponse({ error: { message: `Invalid auth header ${TEST_API_KEY}` } }, 401) });
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.kind, "http");
    assert.equal(error.status, 401);
    assert.match(error.userMessage, /API key/i);
    assert.equal(error.userMessage.includes(TEST_API_KEY), false);
    assert.equal(error.message.includes(TEST_API_KEY), false);
    assert.equal(error.providerDetail.includes(TEST_API_KEY), false);
    assert.match(error.providerDetail, /\[REDACTED\]/);
    return true;
  });
});

test("HTTP 404 points at the endpoint or model name", async () => {
  const { promise } = call({}, { llm: () => jsonResponse({ error: { message: "model not found" } }, 404) });
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, 404);
    assert.match(error.userMessage, /API_BASE_URL and MODEL/);
    return true;
  });
});

test("HTTP 429 is reported as rate limiting", async () => {
  const { promise } = call({}, { llm: () => jsonResponse({ error: { message: "slow down" } }, 429) });
  await assert.rejects(promise, (error) => {
    assert.equal(error.kind, "http");
    assert.match(error.userMessage, /rate limit/i);
    return true;
  });
});

test("HTTP 500 with a non-JSON body still produces a usable error", async () => {
  const { promise } = call({}, { llm: () => textResponse("Bad Gateway", 502) });
  await assert.rejects(promise, (error) => {
    assert.equal(error.kind, "http");
    assert.equal(error.status, 502);
    assert.match(error.message, /Bad Gateway/);
    assert.match(error.userMessage, /server error/i);
    return true;
  });
});

test("no retry is attempted after a failure", async () => {
  const { mock, promise } = call({}, { llm: () => jsonResponse({ error: { message: "boom" } }, 500) });
  await assert.rejects(promise, LlmError);
  assert.equal(mock.llmCalls().length, 1);
});

test("userMessageForStatus covers the common statuses", () => {
  assert.match(userMessageForStatus(401), /API key/);
  assert.match(userMessageForStatus(403), /API key/);
  assert.match(userMessageForStatus(404), /endpoint or model/);
  assert.match(userMessageForStatus(413), /too large/);
  assert.match(userMessageForStatus(429), /rate limit/i);
  assert.match(userMessageForStatus(503), /server error/i);
  assert.match(userMessageForStatus(418), /HTTP 418/);
});

// ---------------------------------------------------------------
// Network and timeout failures
// ---------------------------------------------------------------

test("a connection failure is reported as a network error", async () => {
  const { promise } = call({}, { llm: () => Promise.reject(new TypeError("Failed to fetch")) });
  await assert.rejects(promise, (error) => {
    assert.equal(error.kind, "network");
    assert.match(error.userMessage, /could not reach the model provider/i);
    return true;
  });
});

test("the API key is scrubbed from a network error message", async () => {
  const { promise } = call({}, { llm: () => Promise.reject(new Error(`connect failed while sending ${TEST_API_KEY}`)) });
  await assert.rejects(promise, (error) => {
    assert.equal(error.message.includes(TEST_API_KEY), false);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
});

test("an aborted request is reported as a timeout", async () => {
  const timeoutError = new Error("The operation was aborted due to timeout");
  timeoutError.name = "TimeoutError";
  const { promise } = call({}, { llm: () => Promise.reject(timeoutError) });
  await assert.rejects(promise, (error) => {
    assert.equal(error.kind, "timeout");
    assert.match(error.userMessage, /did not answer within 5 seconds/);
    return true;
  });
});

test("a real AbortSignal.timeout fires and surfaces as a timeout", async () => {
  // The mock hands handlers a call record; record.signal is the AbortSignal the
  // client attached, so this exercises the real timeout wiring end to end.
  const slowFetch = (record) =>
    new Promise((resolve, reject) => {
      record.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "TimeoutError";
        reject(error);
      });
    });

  // AbortSignal.timeout() uses an unref'd timer under Node, so hold the event
  // loop open until it fires. The Workers runtime keeps the request alive
  // anyway; this is a Node test-runner detail, not production behaviour.
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const { mock, promise } = call({ timeoutMs: 25 }, { llm: slowFetch });
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.kind, "timeout");
      return true;
    });
    assert.ok(mock.llmCalls()[0].signal instanceof AbortSignal);
  } finally {
    clearTimeout(keepAlive);
  }
});

// ---------------------------------------------------------------
// Configuration guards
// ---------------------------------------------------------------

test("missing credentials are rejected before any network call", async () => {
  const mock = createFetchMock();
  const cases = [
    { apiKey: "", expected: /API_KEY/ },
    { model: "", expected: /MODEL/ },
    { baseUrl: "", expected: /API_BASE_URL/ },
    { messages: [], expected: /messages/i },
  ];

  for (const testCase of cases) {
    const promise = createChatCompletion({
      baseUrl: BASE,
      apiKey: TEST_API_KEY,
      model: "test-model",
      messages: MESSAGES,
      fetchImpl: mock.fetch,
      ...testCase,
    });
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.kind, "config");
      assert.match(error.message, testCase.expected);
      return true;
    });
  }
  assert.equal(mock.calls.length, 0, "no request should have been attempted");
});
