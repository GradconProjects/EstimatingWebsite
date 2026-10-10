/**
 * The ONE place the AI provider keys are read. Server-side only (a Vercel
 * function module; the leading underscore keeps Vercel from exposing it as an
 * endpoint of its own). Never import this from src/ or portal/ — those ship to
 * every browser.
 *
 * Keys and models come from the Vercel project's Environment Variables
 * (Project → Settings → Environment Variables), NEVER prefixed with VITE_:
 *
 *   ANTHROPIC_API_KEY   ANTHROPIC_MODEL  (default claude-opus-5-5)
 *   OPENAI_API_KEY      OPENAI_MODEL     (default gpt-5)   — OPEN_AI_KEY is accepted as the same thing
 *   DEEPSEEK_API_KEY    DEEPSEEK_MODEL   (default deepseek-chat)
 *   AI_PROVIDER         which configured provider is the default
 *                       (anthropic | openai | deepseek; else the first with a key)
 *
 * providerStatus() reports what is configured without ever returning key
 * material; callText() runs one prompt on one provider; pingProvider() is
 * the Settings panel's "Test" button. Every job that reads a drawing or a
 * tender document will go through callText() so the provider stays a config
 * choice, not a rewrite.
 */
import Anthropic from "@anthropic-ai/sdk";

export const PROVIDERS = [
  { id: "anthropic", label: "Claude (Anthropic)", keyVar: "ANTHROPIC_API_KEY", modelVar: "ANTHROPIC_MODEL", defaultModel: "claude-opus-5-5" },
  { id: "openai", label: "OpenAI", keyVar: "OPENAI_API_KEY", keyAliases: ["OPEN_AI_KEY", "OPENAI_KEY"], modelVar: "OPENAI_MODEL", defaultModel: "gpt-5", base: "https://api.openai.com/v1" },
  { id: "deepseek", label: "DeepSeek", keyVar: "DEEPSEEK_API_KEY", modelVar: "DEEPSEEK_MODEL", defaultModel: "deepseek-chat", base: "https://api.deepseek.com/v1" },
];

const spec = (id) => PROVIDERS.find((p) => p.id === id) || null;
/** The key for a provider: its documented variable, else one of the spellings a person is likely to type (OPEN_AI_KEY was set on 10 Oct 2026). */
const keyFor = (p, env) => [p.keyVar, ...(p.keyAliases || [])].map((v) => env[v] && String(env[v]).trim()).find(Boolean) || "";
const modelFor = (p, env) => (env[p.modelVar] && String(env[p.modelVar]).trim()) || p.defaultModel;

/** The provider a job uses when the caller names none: AI_PROVIDER if it is configured, else the first configured one, else null. */
export function defaultProviderId(env = process.env) {
  const want = String(env.AI_PROVIDER || "").trim().toLowerCase();
  const wanted = spec(want);
  if (wanted && keyFor(wanted, env)) return wanted.id;
  const first = PROVIDERS.find((p) => !!keyFor(p, env));
  return first ? first.id : null;
}

/** Safe to return to the browser: which providers have a key and which model each uses. No key material, ever. */
export function providerStatus(env = process.env) {
  const def = defaultProviderId(env);
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    configured: !!keyFor(p, env),
    model: modelFor(p, env),
    keyVar: p.keyVar,
    modelVar: p.modelVar,
    isDefault: p.id === def,
  }));
}

function fail(message, status, detail) {
  const err = new Error(message);
  err.status = status;
  if (detail) err.detail = String(detail).slice(0, 300);
  return err;
}

/**
 * One prompt → text on one provider. `system` is optional. Throws an Error
 * carrying `.status` (HTTP-like) and a truncated `.detail` that never
 * includes the key.
 */
export async function callText(id, { system, prompt, maxTokens = 1024, timeoutMs = 60000, env = process.env } = {}) {
  const p = spec(id);
  if (!p) throw fail(`Unknown provider "${id}"`, 400);
  const apiKey = keyFor(p, env);
  if (!apiKey) throw fail(`${p.label} is not configured — set ${p.keyVar} in the Vercel project's Environment Variables (server-side, no VITE_ prefix).`, 503);
  const model = modelFor(p, env);
  const started = Date.now();

  if (p.id === "anthropic") {
    const client = new Anthropic({ apiKey, timeout: timeoutMs });
    let r;
    try {
      // Server-side refusal fallback: if a safety classifier declines, the API
      // re-runs the request on a fallback model inside the same call.
      r = await client.beta.messages.create({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: prompt }],
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (e) {
      throw fail(`${p.label} request failed`, (e && e.status) || 502, e && e.message);
    }
    if (r.stop_reason === "refusal") throw fail(`${p.label} declined the request`, 422, r.stop_details && r.stop_details.explanation);
    const text = (r.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return { text, model: r.model || model, latencyMs: Date.now() - started, provider: p.id };
  }

  // OpenAI and DeepSeek share the chat-completions shape.
  let res;
  try {
    res = await fetch(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw fail(`${p.label} could not be reached`, 502, e && e.message);
  }
  if (!res.ok) throw fail(`${p.label} request failed (${res.status})`, res.status, await res.text().catch(() => ""));
  const data = await res.json();
  const text = (((data.choices || [])[0] || {}).message || {}).content || "";
  return { text: String(text), model: data.model || model, latencyMs: Date.now() - started, provider: p.id };
}

/** The provider the browser asked for (Settings → AI providers → "Use"), when it is configured; else the default. */
export function resolveProviderId(requested, env = process.env) {
  const p = spec(String(requested || "").trim().toLowerCase());
  if (p && keyFor(p, env)) return p.id;
  return defaultProviderId(env);
}

/** Which providers can read a PDF document straight from a URL. DeepSeek's chat API takes text only. */
export const DOCUMENT_PROVIDERS = ["anthropic", "openai"];

/**
 * One prompt over one or more PDF documents (public URLs) → text. Claude reads
 * the PDF itself (document blocks, up to 100 pages / 32 MB each request);
 * OpenAI through the Responses API's input_file; DeepSeek cannot read a PDF
 * and fails with 501 so the caller can say "switch provider" instead of
 * sending the model nothing.
 */
export async function callDocuments(id, { system, prompt, documents = [], maxTokens = 8000, timeoutMs = 280000, env = process.env } = {}) {
  const p = spec(id);
  if (!p) throw fail(`Unknown provider "${id}"`, 400);
  if (!DOCUMENT_PROVIDERS.includes(p.id)) throw fail(`${p.label} cannot read PDF documents — switch to Claude or OpenAI in Settings → AI providers for this job.`, 501);
  const apiKey = keyFor(p, env);
  if (!apiKey) throw fail(`${p.label} is not configured — set ${p.keyVar} in the Vercel project's Environment Variables (server-side, no VITE_ prefix).`, 503);
  if (!Array.isArray(documents) || documents.length === 0) throw fail("No documents to read", 400);
  const model = modelFor(p, env);
  const started = Date.now();

  if (p.id === "anthropic") {
    const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
    let r;
    try {
      r = await client.beta.messages.create({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{
          role: "user",
          content: [
            ...documents.map((d) => ({ type: "document", source: { type: "url", url: d.url }, title: String(d.name || "document").slice(0, 200) })),
            { type: "text", text: prompt },
          ],
        }],
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (e) {
      throw fail(`${p.label} request failed`, (e && e.status) || 502, e && e.message);
    }
    if (r.stop_reason === "refusal") throw fail(`${p.label} declined the request`, 422, r.stop_details && r.stop_details.explanation);
    const text = (r.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const usage = r.usage ? { input: r.usage.input_tokens, output: r.usage.output_tokens } : null;
    return { text, model: r.model || model, latencyMs: Date.now() - started, provider: p.id, usage, truncated: r.stop_reason === "max_tokens" };
  }

  // OpenAI: the Responses API reads a PDF from a URL.
  let res;
  try {
    res = await fetch(`${p.base}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_output_tokens: maxTokens,
        ...(system ? { instructions: system } : {}),
        input: [{
          role: "user",
          content: [
            ...documents.map((d) => ({ type: "input_file", file_url: d.url })),
            { type: "input_text", text: prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw fail(`${p.label} could not be reached`, 502, e && e.message);
  }
  if (!res.ok) throw fail(`${p.label} request failed (${res.status})`, res.status, await res.text().catch(() => ""));
  const data = await res.json();
  let text = typeof data.output_text === "string" ? data.output_text : "";
  if (!text) text = (data.output || []).flatMap((o) => o.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("");
  const usage = data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens } : null;
  return { text: String(text), model: data.model || model, latencyMs: Date.now() - started, provider: p.id, usage, truncated: data.status === "incomplete" };
}

/**
 * A conversation → text on one provider: `messages` is the alternating
 * user / assistant history (strings), `system` the standing instructions.
 * Backs the portal's chat (api/ai-chat.js).
 */
export async function callChat(id, { system, messages = [], maxTokens = 1200, timeoutMs = 80000, env = process.env } = {}) {
  const p = spec(id);
  if (!p) throw fail(`Unknown provider "${id}"`, 400);
  const apiKey = keyFor(p, env);
  if (!apiKey) throw fail(`${p.label} is not configured — set ${p.keyVar} in the Vercel project's Environment Variables (server-side, no VITE_ prefix).`, 503);
  const model = modelFor(p, env);
  const started = Date.now();
  const turns = messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()).map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!turns.length || turns[turns.length - 1].role !== "user") throw fail("The conversation must end with a user message", 400);
  if (p.id === "anthropic") {
    const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
    let r;
    try {
      r = await client.beta.messages.create({ model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: turns, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    } catch (e) {
      throw fail(`${p.label} request failed`, (e && e.status) || 502, e && e.message);
    }
    if (r.stop_reason === "refusal") throw fail(`${p.label} declined the request`, 422, r.stop_details && r.stop_details.explanation);
    const text = (r.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return { text, model: r.model || model, latencyMs: Date.now() - started, provider: p.id };
  }
  let res;
  try {
    res = await fetch(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [...(system ? [{ role: "system", content: system }] : []), ...turns] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw fail(`${p.label} could not be reached`, 502, e && e.message);
  }
  if (!res.ok) throw fail(`${p.label} request failed (${res.status})`, res.status, await res.text().catch(() => ""));
  const data = await res.json();
  const text = (((data.choices || [])[0] || {}).message || {}).content || "";
  return { text: String(text), model: data.model || model, latencyMs: Date.now() - started, provider: p.id };
}

/** The ONE loose JSON reader for model replies: strips code fences and takes the outermost {...}. Returns null when nothing parses. */
export function parseJsonLoose(text) {
  const t = String(text || "").replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

/** The Settings panel's "Test": a one-word round trip that proves the key, the model name and the network. */
export async function pingProvider(id, env = process.env) {
  const r = await callText(id, { prompt: "Reply with exactly the word OK and nothing else.", maxTokens: 16, timeoutMs: 30000, env });
  return { ...r, ok: /\bOK\b/i.test(r.text) };
}
