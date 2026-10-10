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
 *   OPENAI_API_KEY      OPENAI_MODEL     (default gpt-5)
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
  { id: "openai", label: "OpenAI", keyVar: "OPENAI_API_KEY", modelVar: "OPENAI_MODEL", defaultModel: "gpt-5", base: "https://api.openai.com/v1" },
  { id: "deepseek", label: "DeepSeek", keyVar: "DEEPSEEK_API_KEY", modelVar: "DEEPSEEK_MODEL", defaultModel: "deepseek-chat", base: "https://api.deepseek.com/v1" },
];

const spec = (id) => PROVIDERS.find((p) => p.id === id) || null;
const modelFor = (p, env) => (env[p.modelVar] && String(env[p.modelVar]).trim()) || p.defaultModel;

/** The provider a job uses when the caller names none: AI_PROVIDER if it is configured, else the first configured one, else null. */
export function defaultProviderId(env = process.env) {
  const want = String(env.AI_PROVIDER || "").trim().toLowerCase();
  const wanted = spec(want);
  if (wanted && env[wanted.keyVar]) return wanted.id;
  const first = PROVIDERS.find((p) => !!env[p.keyVar]);
  return first ? first.id : null;
}

/** Safe to return to the browser: which providers have a key and which model each uses. No key material, ever. */
export function providerStatus(env = process.env) {
  const def = defaultProviderId(env);
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    configured: !!env[p.keyVar],
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
  const apiKey = env[p.keyVar];
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

/** The Settings panel's "Test": a one-word round trip that proves the key, the model name and the network. */
export async function pingProvider(id, env = process.env) {
  const r = await callText(id, { prompt: "Reply with exactly the word OK and nothing else.", maxTokens: 16, timeoutMs: 30000, env });
  return { ...r, ok: /\bOK\b/i.test(r.text) };
}
