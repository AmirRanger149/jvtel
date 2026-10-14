/**
 * Cloudflare PAGES adapter (optional deployment target).
 *
 * Workers users can ignore this file completely — the Worker entry point is
 * src/index.js. This file only exists so the very same bot can also run as a
 * Cloudflare Pages Function.
 *
 * How it works:
 *   - `functions/[[path]].js` is Pages' optional catch-all route, so every
 *     request reaches this module.
 *   - All logic (routing, webhook auth, config validation, model calls, history)
 *     stays in src/index.js. Nothing is duplicated here.
 *   - Pages Functions may only export request handlers, so `onRequest` is the
 *     single export.
 *
 * Environment: set the same variable/secret names as for the Worker
 * (API_BASE_URL, API_KEY, MODEL, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET,
 * ALLOWED_USER_IDS, ...) in the Pages project settings, and bind the KV
 * namespace as CHAT_HISTORY. See README → "Deploying on Cloudflare Pages".
 *
 * @param {object} context Pages Functions context: { request, env, waitUntil, ... }
 */
import { handleRequest } from "../src/index.js";

export async function onRequest(context) {
  const { request, env, waitUntil } = context;

  return handleRequest(request, env ?? {}, {
    // Pages gives waitUntil as a bare function; bind it so it keeps its context.
    waitUntil: typeof waitUntil === "function" ? waitUntil.bind(context) : undefined,
  });
}
