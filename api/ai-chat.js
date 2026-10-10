/**
 * Vercel serverless function behind the portal's Gradcon AI chat (the
 * floating panel every signed-in account sees). POST {provider?, messages,
 * context} → {reply, actions, provider, model, latencyMs}.
 *
 * `context` is what the browser holds of every section — quotes summaries,
 * takeoffs, rates and their validity, the Rates Library's global figures, AI
 * Engine jobs — gathered read-only by assistantContext() in the portal
 * shell. The assistant answers from it and may PROPOSE actions as buttons
 * (open an app, open a project or takeoff); it never performs one. Grady,
 * 10 Oct 2026: "let the api have access to all sections but must not be
 * autonomous except asked by me". Nothing here writes anywhere.
 */
import { callChat, resolveProviderId, providerStatus } from "./_providers.js";
import * as Gm from "./_google.js";

export const config = { maxDuration: 60 };

const MAX_CONTEXT_CHARS = 90000;

function fromOwnOrigin(req) {
  const host = String(req.headers.host || "").toLowerCase();
  const from = String(req.headers.origin || req.headers.referer || "");
  if (!from) return null;
  try { return new URL(from).host.toLowerCase() === host; } catch { return false; }
}

export function chatSystem(context) {
  const ctx = JSON.stringify(context || {});
  return `You are Gradcon AI, the assistant inside Gradcon Concrete Constructions' estimating portal (Melbourne, Australia). The person is an estimator or Grady, the owner. Today is ${(context && context.today) || "unknown"}.

You can SEE the portal's data below (read-only): every Quotes project (name, client, status, deadline, days to deadline, elements, scope, whether its rates are pinned), every Estimates takeoff (elements, review status, AI drafts), the live rates' validity dates, the Rates Library's global figures, Cost Planner projects, AI Engine jobs and — when a Google mailbox is connected — the newest emails of the last two weeks under "mail" (sender, subject, date, snippet, attachment names; the full text is read in the AI Engine's Mail tab). Answer from it precisely — name the project, the date, the count. Status meanings: Queued/Estimating are open work; Completed Estimating/Quoting are finished pricing; Submitted/Tendered went out; Successful/Unsuccessful/Deadline Missed are closed; On Hold is paused. A negative daysToDeadline is overdue. rateValidity.daysLeft under 14 means a supplier notice is due.

Rules:
- You NEVER act on your own. You cannot change a quote, a takeoff, a rate or a status, and you must not claim to. When asked to change something, say what the person can do in the app, and offer to open the right place.
- To offer navigation, end your reply with ONE line exactly in this form (no other text after it):
  ACTIONS: [{"app":"quotes"|"estimates"|"planner"|"folder"|"rateslibrary"|"costplanner"|"aiengine"|"mail","id":"<project id, takeoff id, mail message id or null>","label":"<button text>"}]
  Use a project's "id" from the data for quotes/planner/folder, a takeoff's "id" for estimates, a message "id" from mail for "mail" (opens that email in the AI Engine's Mail tab, where its PDF attachments can become a takeoff or specification job). At most 3 actions, only when useful. Omit the line otherwise.
- Be brief and plain: a few sentences, a short list when listing projects. Use Australian terms and units. Do not invent figures, standards clauses or data that is not in the context; if something is not in the data, say so and say where it would be.
- The AI Engine (tile 07) reads drawings and specifications into DRAFTS for review; it exports to Estimates' "AI drafts" group only when the person clicks Export.

DATA (JSON):
${ctx}`;
}

export function parseReply(text) {
  const t = String(text || "");
  const m = t.match(/\n?\s*ACTIONS:\s*(\[[\s\S]*\])\s*$/);
  if (!m) return { reply: t.trim(), actions: [] };
  let actions = [];
  try { actions = JSON.parse(m[1]); } catch { actions = []; }
  if (!Array.isArray(actions)) actions = [];
  actions = actions.filter((a) => a && typeof a === "object" && typeof a.app === "string").slice(0, 3).map((a) => ({ app: String(a.app).toLowerCase(), id: a.id == null ? null : String(a.id), label: String(a.label || "Open").slice(0, 60) }));
  return { reply: t.slice(0, m.index).trim(), actions };
}

/** Recent mail for the context when the mailbox is connected; never a failure — the chat answers without mail. `deps.mail` is the test seam. */
export async function mailForContext(env = process.env, deps = {}) {
  if (!Gm.googleConfigured(env)) return null;
  try { return await (deps.mail || Gm.mailSummaries)(env, { days: 14, max: 25 }); }
  catch (e) { return { error: String(e.message || e).slice(0, 160) }; }
}

export async function runChat(body, env = process.env, deps = {}) {
  const { provider, messages } = body || {};
  let context = (body && body.context) || {};
  if (!Array.isArray(messages) || !messages.length) return { status: 400, body: { error: "messages must be a non-empty array" } };
  const ctxJson = JSON.stringify(context || {});
  if (ctxJson.length > MAX_CONTEXT_CHARS) return { status: 413, body: { error: "The portal sent too much context — reload and try again" } };
  const mail = await mailForContext(env, deps);
  if (mail) context = { ...context, mail };
  const id = resolveProviderId(provider, env);
  if (!id) return { status: 503, body: { error: "No AI provider is configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY in the Vercel project's Environment Variables." } };
  let r;
  try {
    r = await callChat(id, { system: chatSystem(context), messages, maxTokens: 1200, env });
  } catch (e) {
    const st = providerStatus(env).find((p) => p.id === id);
    return { status: e.status && e.status >= 400 && e.status < 600 ? e.status : 502, body: { error: e.message, detail: e.detail || null, provider: id, model: st ? st.model : null } };
  }
  const parsed = parseReply(r.text);
  return { status: 200, body: { reply: parsed.reply, actions: parsed.actions, provider: r.provider, model: r.model, latencyMs: r.latencyMs } };
}

export default async function handler(req, res) {
  const own = fromOwnOrigin(req);
  if (own !== true) { res.status(403).json({ error: "The chat runs from the Gradcon portal only." }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const out = await runChat(req.body || {});
  res.setHeader("cache-control", "no-store");
  res.status(out.status).json(out.body);
}
