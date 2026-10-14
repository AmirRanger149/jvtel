# jvTEL — a minimal Telegram AI chatbot for Cloudflare Workers

A small, reliable Telegram bot that forwards your text messages to any
**OpenAI-compatible** Chat Completions API and sends the answer back to the chat.
It runs entirely on Cloudflare's edge: no server, no database, no build step, no
framework, and only one dev dependency (`wrangler`).

This is a **chatbot, not an agent**. No tool calling, no streaming, no browser
search, no media handling, no dashboard, no plugins.

---

## ⚠️ Read this first: credentials

The bot is configured by editing a block called **`USER_CONFIG`** at the very top
of [`src/index.js`](src/index.js). That block ships with harmless placeholders.

> **Never commit real credentials to a repository — especially a public one.**
> If you paste a real API key or bot token into `src/index.js` and push it, the
> key is public forever (Git history keeps it even after you delete the line),
> and bots scrape GitHub for leaked keys within minutes.
>
> **The safe way:** keep the placeholders in `src/index.js` and store the real
> values as **Cloudflare Secrets**. Any environment binding or Secret with the
> same name **overrides** the value in the file, so the code never changes:
>
> ```bash
> npx wrangler secret put API_KEY
> npx wrangler secret put TELEGRAM_BOT_TOKEN
> npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
> ```
>
> For local development use `.dev.vars` (already in `.gitignore`); only
> `.dev.vars.example` is tracked. If a credential ever leaks, **revoke it**:
> BotFather → `/revoke`, and your provider's dashboard → delete the API key.

Precedence, highest first: **Cloudflare Secret → `wrangler.toml` `[vars]` /
`.dev.vars` → `USER_CONFIG` in `src/index.js`.**

---

## Contents

1. [What it does](#what-it-does)
2. [Project layout](#project-layout)
3. [Prerequisites](#prerequisites)
4. [Step 1 — Create the Telegram bot](#step-1--create-the-telegram-bot-with-botfather)
5. [Step 2 — Edit the configuration block](#step-2--edit-the-configuration-block)
6. [Step 3 — Install and run the tests](#step-3--install-and-run-the-tests)
7. [Step 4 — Run it locally](#step-4--run-it-locally)
8. [Step 5 — Optional: persistent history with KV](#step-5--optional-persistent-history-with-kv)
9. [Step 6 — Deploy to Cloudflare Workers](#step-6--deploy-to-cloudflare-workers)
10. [Step 7 — Register the Telegram webhook](#step-7--register-the-telegram-webhook)
11. [Step 8 — Test the deployed bot](#step-8--test-the-deployed-bot)
12. [Deploying on Cloudflare Pages instead](#deploying-on-cloudflare-pages-instead)
13. [Changing provider, model or key](#changing-provider-model-or-api-key)
14. [Behaviour, limits and honest guarantees](#behaviour-limits-and-honest-guarantees)
15. [Troubleshooting](#troubleshooting)
16. [Security notes](#security-notes)
17. [Verification status](#verification-status)

---

## What it does

```
Telegram ──POST /telegram-webhook──▶ Cloudflare Worker
                                        │  1. method + secret-token check
                                        │  2. configuration check (fail fast)
                                        │  3. ignore non-message updates
                                        │  4. ACK 200 immediately, work in background
                                        │  5. access control (ALLOWED_USER_IDS)
                                        │  6. duplicate update_id check (KV)
                                        │  7. /start /help /new /model  ── or ──
                                        │  8. load history (KV or memory)
                                        │  9. POST {API_BASE_URL}/chat/completions
                                        │ 10. sendMessage (split at 4096 chars)
                                        │ 11. save history
                                        ▼
                                     Telegram chat
```

Commands: `/start`, `/help`, `/new` (clear this conversation), `/model`
(shows the configured model and endpoint). Any other plain-text message is sent
to the model.

Routes exposed by the Worker:

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Human-readable configuration status page (secrets are masked) |
| `/status` | GET | The same information as JSON |
| `/telegram-webhook` | POST | Telegram webhook, requires the secret-token header |

Everything else returns `404`. **No route can read or change a credential** —
the status page only reports whether a secret is `missing`, a `placeholder`, or
`set (N characters)`.

## Project layout

```
src/
  index.js         ← USER_CONFIG lives at the top; routing, validation, update handling
  llm.js           ← OpenAI-compatible Chat Completions client
  telegram.js      ← Telegram Bot API client + 4096-char message splitting
  conversation.js  ← history store (KV or in-memory) + duplicate-update detection
functions/
  [[path]].js      ← optional Cloudflare Pages adapter (Workers users can ignore it)
public/
  robots.txt       ← Pages needs an output directory; this keeps crawlers away
tests/             ← 173 tests, no network access, no real credentials needed
  support/mocks.js ← mocked fetch / KV / ExecutionContext fixtures
wrangler.toml      ← Worker name, entry point, optional KV binding
package.json       ← dev + test + deploy scripts (wrangler is the only dependency)
.dev.vars.example  ← placeholder-only template for local development
.gitignore         ← keeps .dev.vars, .env and build output out of Git
```

## Prerequisites

- **Node.js 18.17+** (20 or 22 recommended) — only for Wrangler and the tests.
  The deployed Worker itself uses no Node.js APIs.
- A **Cloudflare account** (the free plan is enough: Workers free tier + KV free
  tier).
- An **API key for an OpenAI-compatible provider** — OpenAI, OpenRouter, Groq,
  Together, DeepInfra, Mistral, or a self-hosted vLLM/Ollama gateway. Anything
  that serves `POST {base}/chat/completions`.
- A **Telegram account** to create the bot.

Check your toolchain:

```bash
node --version     # v18.17 or newer
npm --version
```

## Step 1 — Create the Telegram bot with BotFather

1. In Telegram, search for **@BotFather** (the one with the blue checkmark).
2. Send `/newbot`.
3. Choose a display name, e.g. `My jvTEL bot`.
4. Choose a username ending in `bot`, e.g. `my_jvtel_bot`.
5. BotFather replies with the **HTTP API token**, shaped like
   `123456789:AA...` — copy it. This is `TELEGRAM_BOT_TOKEN`.

Optional but recommended (still in BotFather):

- `/setprivacy` → **Enable**. With privacy mode on, the bot only receives group
  messages that mention it or reply to it, which is what you want if you later
  turn on `RESPOND_IN_GROUPS`.
- `/setdescription` and `/setuserpic` to make the bot recognisable.

> Keep the token secret: anyone holding it fully controls the bot. Never put it
> in a URL you share, a screenshot, or a commit.

## Step 2 — Edit the configuration block

Open [`src/index.js`](src/index.js). The first thing in the file is
`USER_CONFIG`:

```js
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
  MAX_HISTORY_MESSAGES: 12,
  MAX_INPUT_CHARS: 8000,

  // ---- Optional / advanced ----
  LLM_TIMEOUT_MS: 30000,
  RESPOND_IN_GROUPS: false
};
```

| Setting | Required | Where to get it | Notes |
| --- | --- | --- | --- |
| `API_BASE_URL` | ✅ | Your provider's docs/dashboard | The part **before** `/chat/completions`. OpenAI: `https://api.openai.com/v1`. OpenRouter: `https://openrouter.ai/api/v1`. Trailing slashes are normalised, and an already-complete endpoint URL is accepted as-is. |
| `API_KEY` | ✅ | Provider dashboard | Sent only as `Authorization: Bearer …`. **Use a Secret in production.** |
| `MODEL` | ✅ | Provider's model list | e.g. `gpt-4o-mini`, `llama-3.1-70b-versatile`. Nothing is hardcoded. |
| `TELEGRAM_BOT_TOKEN` | ✅ | @BotFather | **Use a Secret in production.** |
| `TELEGRAM_WEBHOOK_SECRET` | ✅ | You invent it | Random string, 16+ characters. Telegram echoes it in the `X-Telegram-Bot-Api-Secret-Token` header; requests without a match are rejected with `401`. Generate one locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` or `openssl rand -hex 32`. |
| `ALLOWED_USER_IDS` | ✅ (a decision) | Your own Telegram user ID | Comma-separated **numeric** IDs, e.g. `"11111111,22222222"`. Usernames are never accepted. Set it to `""` to allow anyone — see the warning below. |
| `SYSTEM_PROMPT` | optional | You | Prepended fresh on every request, so editing it applies immediately and it can never be overwritten by stored history. |
| `MAX_HISTORY_MESSAGES` | optional | You | `12` = the last 6 exchanges. `0` disables memory entirely. |
| `MAX_INPUT_CHARS` | optional | You | Longer messages are **rejected with an explanation**, never silently truncated. Telegram itself caps an incoming message at 4096 characters, so this mainly protects your token budget. |
| `LLM_TIMEOUT_MS` | optional | You | Bounded wall-clock limit for one model call (default 30000). There are **no automatic retries**. |
| `RESPOND_IN_GROUPS` | optional | You | `false` (default): private chats only; group messages are ignored. `true`: also answer in groups/supergroups, with history separated per chat. |

**Finding your Telegram user ID.** Deploy or run the bot with
`ALLOWED_USER_IDS` left as-is, then message the bot once. If you are not on the
list, the bot replies with *your own numeric ID* — add it and redeploy. (You can
also use any "@userinfobot"-style bot; the numeric ID is not a secret.)

> **`ALLOWED_USER_IDS: ""` means public access.** Anyone who discovers the bot
> can spend your API credits and generate content in your name. Telegram bots are
> easy to find via username guessing, and public bots do get abused. Restrict it
> unless you have a deliberate reason not to, and watch your provider's spend
> limit. Set a hard budget in your provider dashboard either way.

**What happens when the configuration is incomplete.** If a required value is
missing or still holds one of the shipped placeholders, the Worker *fails fast*:

- `GET /` and `GET /status` list the offending setting **names** and reasons
  (`missing`, `placeholder`, `invalid`) — never their values.
- `POST /telegram-webhook` returns `503` with the same list and calls neither the
  model nor Telegram.
- Worker logs print the key names only.

## Step 3 — Install and run the tests

```bash
npm install
npm test          # 173 tests, no network, no credentials required
npm run check     # bundling/deploy validation: wrangler deploy --dry-run
```

The tests use Node's built-in test runner and mocked `fetch`, KV and execution
context, so they never contact Telegram or a model provider. They cover
configuration validation, endpoint construction, model success/HTTP/timeout/
malformed/empty responses, history limits and `/new`, access control, webhook
secret rejection, duplicate updates, long-reply splitting and Telegram API
errors.

## Step 4 — Run it locally

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars with your real values (it is git-ignored)
npm run dev       # = npx wrangler dev
```

Wrangler prints `Ready on http://localhost:8787`. Open it in a browser: you
should see the jvTEL status page. If it says **CONFIGURATION INCOMPLETE**, it
lists exactly what to fix.

Telegram cannot reach `localhost`, so drive the webhook yourself with `curl`
(`$SECRET` and `$TOKEN` are the values from `.dev.vars`):

```bash
# status page and JSON status
curl -s http://localhost:8787/status | head -30

# rejected: wrong secret token
curl -i -X POST http://localhost:8787/telegram-webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: wrong' \
  -d '{"update_id":1,"message":{"message_id":1,"date":1,"text":"hi","chat":{"id":1,"type":"private"},"from":{"id":1}}}'

# accepted: correct secret token (replace $SECRET and use your own user id)
curl -s -X POST http://localhost:8787/telegram-webhook \
  -H 'Content-Type: application/json' \
  -H "X-Telegram-Bot-Api-Secret-Token: $SECRET" \
  -d '{"update_id":2,"message":{"message_id":2,"date":1,"text":"Hello!","chat":{"id":YOUR_ID,"type":"private"},"from":{"id":YOUR_ID,"is_bot":false}}}'
```

The Worker acknowledges with `200 {"ok":true,"status":"accepted"}` and finishes
the work in the background, so the reply lands in your Telegram chat a moment
later (local `wrangler dev` **can** reach the real Telegram API, so this works
end to end). Watch the logs in the `wrangler dev` terminal.

> Local notes: history is kept in the Worker's memory unless you bind KV (see
> Step 5); `wrangler dev` reads `.dev.vars` automatically; stop it with Ctrl-C.

## Step 5 — Optional: persistent history with KV

Without KV the bot still works — each message is answered — but conversation
memory lives only inside one Worker isolate and disappears when that isolate is
recycled (often). It is a development convenience, **not** persistence. The bot
says so in `/start`, `/help`, `/model`, on the status page, and in the Worker
logs.

To get real memory:

```bash
npx wrangler kv namespace create CHAT_HISTORY
```

Copy the printed `id` into `wrangler.toml` and uncomment the block:

```toml
[[kv_namespaces]]
binding = "CHAT_HISTORY"
id = "PASTE_THE_ID_FROM_THE_COMMAND_HERE"
```

Then redeploy. The binding name **must** be `CHAT_HISTORY` — that is what the
code looks for. Nothing else changes: the bot detects the binding at runtime and
switches from `memory` to `kv` mode (visible on `GET /status`).

What KV stores, per chat: `chat:<chat_id>` → a JSON array of the last
`MAX_HISTORY_MESSAGES` user/assistant messages (each capped so a KV value stays
bounded, 30-day expiry refreshed on use), and `update:<update_id>` → a marker
used for duplicate detection (1-hour expiry). `/new` deletes the `chat:` key.

Costs: on the free tier KV allows 1,000 writes/day. One message costs ~2 writes
(duplicate marker + history) and ~2 reads. That is roughly 500 messages/day —
plenty for a personal bot, but keep it in mind if you open the bot to the public.

## Step 6 — Deploy to Cloudflare Workers

```bash
npx wrangler login                       # opens a browser, one time
npx wrangler whoami                      # confirm the right account

# 1) secrets (production values — never in Git)
npx wrangler secret put API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

# 2) optional, non-secret overrides
npx wrangler secret put MODEL            # or use [vars] in wrangler.toml

# 3) deploy
npx wrangler deploy
```

Wrangler prints your URL, e.g. `https://jvtel.<your-subdomain>.workers.dev`.
Open it — the status page should say **CONFIGURATION OK**. If it lists problems,
fix them and deploy again.

Notes:

- `wrangler deploy` uses `wrangler.toml` (`name`, `main = "src/index.js"`,
  `compatibility_date`). No `nodejs_compat` flag is needed or wanted: the code
  uses only standard Web APIs.
- A custom domain works too (Workers → your Worker → Settings → Domains &
  Routes). Telegram requires HTTPS, which `*.workers.dev` and custom domains
  both provide.
- Live logs: `npx wrangler tail` (or dashboard → Workers → Logs).

## Step 7 — Register the Telegram webhook

Telegram needs to be told where to deliver updates. Run this **once per bot**,
from your own machine, after deploying:

```bash
TOKEN="PASTE_YOUR_TELEGRAM_BOT_TOKEN"
SECRET="PASTE_THE_SAME_TELEGRAM_WEBHOOK_SECRET"
WORKER_URL="https://jvtel.YOUR-SUBDOMAIN.workers.dev"

curl -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"${WORKER_URL}/telegram-webhook\",\"secret_token\":\"${SECRET}\",\"allowed_updates\":[\"message\"]}"
```

Expected reply: `{"ok":true,"result":true,"description":"Webhook was set"}`.

- `secret_token` must be **exactly** the value of `TELEGRAM_WEBHOOK_SECRET`.
  Telegram then sends it in the `X-Telegram-Bot-Api-Secret-Token` header on every
  delivery, and the Worker rejects anything that does not match. This is what
  stops strangers from calling your webhook directly and burning your API credits.
- `allowed_updates: ["message"]` keeps Telegram from delivering edits, channel
  posts, callback queries and other update types the bot ignores anyway.
- The webhook URL is your Worker URL + `/telegram-webhook`.

Verify and manage it:

```bash
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"
# look at: "url", "pending_update_count", "last_error_message", "secret_token" is not returned

curl -s -X POST "https://api.telegram.org/bot${TOKEN}/deleteWebhook"   # to detach
```

## Step 8 — Test the deployed bot

1. Open `https://jvtel.YOUR-SUBDOMAIN.workers.dev/` → **CONFIGURATION OK**,
   and check the reported storage mode (`kv` or `memory`).
2. In Telegram, message your bot `/start` → welcome text.
3. `/model` → the model name and the derived endpoint (no key is ever shown).
4. Send `Hello` → an answer from your model. Watch `npx wrangler tail`.
5. Send a follow-up that needs context, e.g. `My name is Ada`, then
   `What is my name?` → with KV bound it remembers; without KV it may not
   (that is the documented in-memory limitation).
6. `/new` → "Conversation cleared", then ask again → memory is gone.
7. Ask a stranger (a second Telegram account not in `ALLOWED_USER_IDS`) to
   message the bot → refused, and no model call appears in your logs or billing.

## Deploying on Cloudflare Pages instead

The same code also runs as a **Cloudflare Pages Function**. The repository
includes the adapter for that: [`functions/[[path]].js`](functions/%5B%5Bpath%5D%5D.js)
is Pages' catch-all route and simply delegates to `handleRequest()` in
`src/index.js`. No logic is duplicated.

**Choose one target.** Workers is the primary, recommended path (simpler, and
`wrangler.toml` already describes it). Use Pages if the bot has to live inside an
existing Pages project.

### Option A — Wrangler (command line)

```bash
npx wrangler login
npx wrangler pages project create jvtel --production-branch main

# secrets for the Pages project
npx wrangler pages secret put API_KEY                --project-name jvtel
npx wrangler pages secret put TELEGRAM_BOT_TOKEN     --project-name jvtel
npx wrangler pages secret put TELEGRAM_WEBHOOK_SECRET --project-name jvtel

# optional non-secret settings (or set them in the dashboard)
npx wrangler pages secret put MODEL                  --project-name jvtel
npx wrangler pages secret put ALLOWED_USER_IDS       --project-name jvtel

# deploy: "public" is the (nearly empty) static output dir, functions/ is picked
# up automatically from the project root
npx wrangler pages deploy public --project-name jvtel
```

You get `https://jvtel.pages.dev`. Local preview:

```bash
cp .dev.vars.example .dev.vars   # fill in real values
npx wrangler pages dev public    # http://localhost:8788
```

### Option B — Dashboard (Git integration)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   *Connect to Git* → pick your repository.
2. Build settings: **Framework preset: None**, build command *(leave empty)*,
   build output directory: `public`.
3. After the first build: **Settings → Environment variables** → add
   `API_BASE_URL`, `MODEL`, `ALLOWED_USER_IDS`, `SYSTEM_PROMPT`, … as plain
   variables, and `API_KEY`, `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET` as **Secret** (encrypted). Use the *same names* as
   in `USER_CONFIG`. Apply to Production (and Preview if you want).
4. **Settings → Functions → Compatibility date**: set a recent date.
5. Redeploy so the variables take effect.

### KV binding on Pages

```bash
npx wrangler kv namespace create CHAT_HISTORY
```

Then in the dashboard: your Pages project → **Settings → Bindings → KV
namespace** → *Add* → variable name **`CHAT_HISTORY`** → select the namespace →
save → redeploy. (Pages bindings are configured in the dashboard; the
`[[kv_namespaces]]` block in `wrangler.toml` applies to the Worker target only.)

### Pages specifics worth knowing

- **Do not add `public/index.html`.** Pages serves static assets *before*
  Functions, so an `index.html` would hide the status page at `/`.
  `public/robots.txt` is the only file there, and it just asks crawlers to stay
  away.
- Then register the webhook exactly as in Step 7, using
  `https://jvtel.pages.dev/telegram-webhook`.
- Pages Functions logs: dashboard → your project → a deployment → **Functions**
  → *View details* → Logs.
- Everything else — routes, commands, access control, history, error handling —
  is identical, because it is the same `src/` code.

## Changing provider, model or API key

There is nothing provider-specific in the code. To switch providers:

1. Set the new `API_BASE_URL` (the part before `/chat/completions`), `MODEL` and
   `API_KEY`.
   - In `USER_CONFIG` for a quick local test, **or** — better — as Cloudflare
     Secrets/vars, which override the file:
     ```bash
     npx wrangler secret put API_KEY
     npx wrangler secret put MODEL
     npx wrangler secret put API_BASE_URL
     ```
2. Redeploy (`npx wrangler deploy`) if you edited the file. Secrets take effect
   immediately and trigger a new deployment automatically.
3. Open `GET /status` and check `chat_completions_endpoint` — it shows the exact
   URL the bot will call, which catches most base-URL mistakes before you send a
   message.

Examples of valid `API_BASE_URL` values — all produce one correct endpoint:

| `API_BASE_URL` | Endpoint called |
| --- | --- |
| `https://api.openai.com/v1` | `https://api.openai.com/v1/chat/completions` |
| `https://openrouter.ai/api/v1/` | `https://openrouter.ai/api/v1/chat/completions` |
| `https://api.groq.com/openai/v1` | `https://api.groq.com/openai/v1/chat/completions` |
| `https://gateway.example/v1/chat/completions` | unchanged (no duplicated path) |
| `https://host/openai?api-version=2024-06-01` | `https://host/openai/chat/completions?api-version=2024-06-01` (query kept) |

## Behaviour, limits and honest guarantees

**Conversation history**

- KV bound → history persists across requests, isolates and deployments, keyed by
  Telegram `chat_id`. Private chats are per user (chat id == user id); groups get
  their own separate history.
- No KV → an in-memory Map, capped at 100 chats and evicted least-recently-used
  first. It **does not** survive isolate recycling. The bot never claims
  otherwise: `/start`, `/help`, `/model` and the status page state the current
  mode.
- `MAX_HISTORY_MESSAGES` limits how many messages are sent to the model
  (`12` = 6 exchanges; `0` = no memory). Stored values are also character-capped,
  and each stored message is shortened if it is huge — the *delivered* reply is
  never shortened, only the remembered copy.
- The system prompt is never stored; it comes from the configuration on every
  request. Stored history therefore cannot override or inject a system prompt.
- KV is **eventually consistent** and `get`/`put` are not atomic. Two messages
  sent at almost the same moment from the same chat can overwrite each other's
  history (last write wins). No exactly-once or strictly-ordered guarantee is
  made or needed for a chatbot.

**Duplicates and Telegram retries**

- Telegram redelivers an update when the webhook does not answer successfully.
  To keep that from double-charging your provider, the Worker **acknowledges with
  `200` as soon as the request is authenticated and parsed**, then finishes the
  work with `ctx.waitUntil(...)`, and records the `update_id` in KV *before*
  calling the model.
- This is **best effort**, not a guarantee: the check-then-write is not atomic, so
  two simultaneous deliveries of the same `update_id` can both slip through; the
  marker expires after 1 hour; and without KV there is no duplicate detection at
  all (an in-memory set would not survive an isolate restart, so it is
  deliberately not used).
- Deliberate trade-off: once an update is accepted, a failure further down the
  line (model error, Telegram error) is reported **to the user in the chat** and
  logged — it does not turn into an error response that would make Telegram
  redeliver and re-charge the model.

**Message size**

- Replies longer than Telegram's 4096-character limit are split at paragraph
  breaks, then line breaks, then word breaks, and hard-cut only if a single word
  is longer than the limit. Nothing is dropped.
- Messages are sent as **plain text** (no `parse_mode`), because model output
  routinely contains characters that break Markdown/HTML parsing.
- Chunks are sent sequentially, so order is preserved. If delivery fails halfway,
  the bot logs how many chunks arrived and does not store an exchange the user
  never received.
- Incoming messages longer than `MAX_INPUT_CHARS` are rejected with an
  explanation instead of being truncated.

**Timeouts and failures**

- One bounded timeout per model call (`LLM_TIMEOUT_MS`, default 30 s) and per
  Telegram call (15 s), via `AbortSignal`. **No retry loops** — a retry would
  multiply your API costs and Telegram already retries at the webhook level.
- Provider failures are translated into short, non-technical messages
  (`401` → "the API key was rejected", `404` → "check API_BASE_URL and MODEL",
  `429` → "rate limited, try again in a minute", `5xx` → "provider is failing").
  Technical detail goes to the Worker logs only.
- A KV outage degrades gracefully: the bot answers without history and logs the
  problem.
- Media, documents, stickers and voice notes get a one-line explanation that only
  plain text is supported. `edited_message`, `channel_post`, `callback_query`,
  `inline_query` and friends are ignored with `200` so Telegram stops retrying.

## Troubleshooting

Start here in every case: open **`https://<your-worker>/`** (the status page) and
run **`npx wrangler tail`** while you message the bot.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Status page says **CONFIGURATION INCOMPLETE** | Placeholders still in `USER_CONFIG`, or Secrets not set / not applied to the right environment | Set the listed keys (Secrets win over the file) and redeploy |
| Webhook returns `503 {"error":"configuration"}` | Same as above — the bot refuses to call the model with unusable settings | Fix the listed settings, then send a new message |
| Webhook returns `401 {"error":"unauthorized"}` | `secret_token` used in `setWebhook` ≠ `TELEGRAM_WEBHOOK_SECRET` | Re-run `setWebhook` with the identical string |
| Webhook returns `405` | You opened it in a browser / sent a GET | It only accepts `POST` from Telegram |
| Bot never replies, no logs at all | Webhook not registered, or registered to the wrong URL | `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` and check `url` |
| `getWebhookInfo` shows `last_error_message` | Worker returned non-2xx or timed out | Read the message; usually configuration (`503`) or auth (`401`) |
| Bot replies "not allowed to use this bot" | Your ID is not in `ALLOWED_USER_IDS` | The refusal message contains your numeric ID — add it |
| Bot replies to nobody, and IDs look right | IDs entered as usernames, or with spaces/typos | Only comma-separated digits are accepted; the status page reports ignored entries |
| "The model provider rejected the API key" | Wrong/expired `API_KEY`, or a key for a different provider | Re-set the Secret; check it in the provider dashboard |
| "did not recognise the endpoint or model name" (404) | `API_BASE_URL` missing/extra path segment, or wrong `MODEL` | Compare with `chat_completions_endpoint` on the status page |
| "rate limiting" (429) / "server error" (5xx) | Provider-side limits or outage | Wait, or lower concurrency; check the provider's status page |
| "The model did not answer within N seconds" | Slow model or too-short `LLM_TIMEOUT_MS` | Raise `LLM_TIMEOUT_MS`; note very long values can exceed Telegram's webhook patience |
| "returned an empty answer" | Provider replied `200` with no `choices[0].message.content` (e.g. content filter, or a reasoning-only response) | Try another prompt/model; check the provider's docs |
| It forgets everything between messages | No `CHAT_HISTORY` KV binding (memory mode), or `MAX_HISTORY_MESSAGES` is `0` | Bind KV (Step 5); the status page shows the active mode |
| History works locally but not deployed | `.dev.vars`/local KV only, or the binding was not added to the deployed Worker | Add `[[kv_namespaces]]` to `wrangler.toml` (Workers) or bind in dashboard (Pages), then redeploy |
| Replies arrive in several messages | Normal: Telegram's 4096-character limit | Expected behaviour, split at paragraph/line/word boundaries |
| Nothing happens in a group | `RESPOND_IN_GROUPS` is `false` (default) | Set it to `true`; also enable BotFather privacy mode so the bot is not flooded |
| Duplicate answers | Update delivered twice without KV dedupe | Bind KV; see the duplicate-detection limits above |
| `wrangler deploy` fails with "authentication error" | Not logged in / wrong account | `npx wrangler login`, then `npx wrangler whoami` |
| Worker fails to start with *"Incorrect type for map entry 'X': … not of type 'function or ExportedHandler'"* | A non-function export was added to `src/index.js` | The entry module may only export functions/handlers — keep constants private (or move them to `llm.js`/`telegram.js`/`conversation.js`) |
| `wrangler dev` warns "Unable to fetch the Request.cf object" | Sandbox/offline environment cannot reach Cloudflare metadata | Harmless locally; ignore |

## Security notes

- **Webhook authentication**: every `POST /telegram-webhook` must carry
  `X-Telegram-Bot-Api-Secret-Token` equal to `TELEGRAM_WEBHOOK_SECRET`
  (compared in constant time). Authentication happens *before* the configuration
  report, so an unauthenticated caller cannot probe your settings. Unsupported
  methods are rejected with `405`.
- **Authorization** is by numeric Telegram user ID only. Usernames are mutable and
  spoofable and are never used. Unauthorized users are rejected **before** any
  storage read or model call.
- **No credential ever leaves the Worker.** API keys and tokens appear only in
  request headers/URLs toward their own provider. Error messages, Worker logs and
  HTTP responses are scrubbed; the status page reports secrets as
  `missing` / `placeholder` / `set (N characters)` and redacts credentials
  embedded in a base URL.
- **No remote reconfiguration.** Nothing in a Telegram message can change the API
  key, base URL, model, allowlist or prompt. A message containing
  `API_KEY=...` is just text to the model.
- **No public config endpoint.** `/` and `/status` are read-only, expose no
  secret values and no user IDs, and cannot be written to (`405`).
- **Logging hygiene**: logs contain key *names*, error kinds, HTTP statuses,
  Telegram method names and chat IDs — never tokens, keys, secret headers, or the
  text of your conversations.
- **Least privilege**: create a provider API key with the lowest spend limit you
  can live with, and revoke it immediately if the repository is ever made public
  with a real value committed.

## Verification status

Verified locally in this repository (repeat it yourself with `npm test`,
`npm run check`, `npm run dev`):

- ✅ **173 unit/integration tests pass** (`npm test`, Node's built-in runner,
  mocked `fetch`/KV/execution context — no real credentials, no real Telegram or
  provider traffic).
- ✅ **`wrangler deploy --dry-run`** bundles cleanly (≈52 KiB, no warnings).
- ✅ **`wrangler dev` (workerd)** boots and serves `/`, `/status`, `404` and
  `405` correctly.
- ✅ **Full message round trip inside workerd** against local mock servers:
  model called with `Bearer` auth, `stream:false`, system + user messages;
  reply delivered via `sendMessage`; `sendChatAction` typing indicator; KV
  history grows `2 → 4 → 6 → 8` messages across turns; `/new` clears it;
  a redelivered `update_id` is skipped (`skipped duplicate update_id`);
  a 25 000-character reply is split into 8 chunks of ≤ 4096 characters;
  a hanging provider trips the bounded timeout after exactly
  `LLM_TIMEOUT_MS`; unauthorized users and wrong secrets are rejected without a
  model call.
- ✅ **`wrangler pages functions build`** compiles the Pages adapter and
  registers the catch-all route (`/:path*`, all methods).

**Not** verified (this sandbox has no Cloudflare account and no outbound access
to `api.telegram.org` or any model provider):

- ❌ A real `wrangler deploy` / `wrangler pages deploy` to a Cloudflare account.
- ❌ Real Telegram webhook registration and live message delivery.
- ❌ Real calls to a live model provider (OpenAI, OpenRouter, Groq, …).
- ❌ Real KV quota/latency behaviour in production.

So: the code paths are tested and the Worker is confirmed to run on the Workers
runtime, but **production deployment and live Telegram/provider integration have
not been performed here.** Expect to do Step 6–8 yourself, and treat the first
live message as the real acceptance test.

---

## Development notes

- ES modules everywhere; `"type": "module"` in `package.json`.
- The Worker entry module (`src/index.js`) exports **functions only** — a workerd
  requirement. `USER_CONFIG` and the route constants are module-private; the test
  suite reads the shipped defaults through `resolveConfig({})`.
- `USER_CONFIG` sits above the `import` statements on purpose, so the settings are
  the first thing you see. ES module imports are hoisted, so their position does
  not affect behaviour.
- Only standard Web APIs are used (`fetch`, `Request`, `Response`, `Headers`,
  `URL`, `URLSearchParams`, `AbortSignal`, `Map`, `console`). No Node.js built-ins
  in `src/`, so no `nodejs_compat` flag is required.
- Tests inject `fetch`, KV and the execution context; no test touches the network.
- Run a single test file with `node --test tests/llm.test.js`.

## License / maintenance

Small enough for one person to own: ~1 000 lines in `src/index.js` (including the
configuration docs and the status page) plus three focused modules. Read
`src/index.js` top-to-bottom once and you know the whole bot.
