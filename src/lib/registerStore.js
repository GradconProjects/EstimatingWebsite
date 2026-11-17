/**
 * The Register (portal tile 08) as the Quotes app reads it: the `gradcon-register`
 * row — the cloud copy when Supabase is configured, else this browser's mirror
 * (the Register app writes the same localStorage key). The ONE write from here is
 * `recordRegisterContacts`: after an RFQ or an email has actually been SENT, the
 * organisation's last contact moves to today (Gradcon wrote), the subject joins
 * its recent subjects and the change is logged — merged per organisation, the way
 * the Register app merges, so an edit made there at the same time survives.
 */
import { supabase, supabaseEnabled } from "./supabaseClient.js";
import { applyStandingRfqCopies, setRfqCopies, RFQ_STANDING_VER } from "./rfq.js";

export const REGISTER_KEY = "gradcon-register";
const TABLE = "estimator_kv";

function readLocal() {
  try { const v = JSON.parse(localStorage.getItem(REGISTER_KEY) || "null"); return v && Array.isArray(v.orgs) ? v : null; } catch { return null; }
}
function writeLocal(v) { try { localStorage.setItem(REGISTER_KEY, JSON.stringify(v)); } catch { /* quota / private mode */ } }

export async function readRegister({ client = supabase, enabled = supabaseEnabled } = {}) {
  if (enabled && client) {
    try {
      const { data, error } = await client.from(TABLE).select("value").eq("key", REGISTER_KEY).maybeSingle();
      if (!error && data && data.value && Array.isArray(data.value.orgs)) { writeLocal(data.value); return data.value; }
    } catch { /* fall through to the mirror */ }
  }
  return readLocal();
}
export const registerOrgs = (reg) => (reg && Array.isArray(reg.orgs) ? reg.orgs : []);

/** "Save to Register" in the RFQ composer: `emails` become the organisation's RFQ copies (lib/rfq.js `setRfqCopies`).
 * The row is read fresh, the coded-in standing copies are applied first when the Register page has not moved this row
 * yet (so a save can never be undone by that one-off move), the change is logged, and every organisation touched gets
 * a new `updatedAt` — the Register page's per-organisation merge keeps the newer copy. → the register as saved, or
 * null when it could not be read or the organisation is not on it; `saved: false` rides on it when the cloud write failed. */
export async function saveRfqCopies(orgId, emails, by = "quotes", { client = supabase, enabled = supabaseEnabled, now = new Date() } = {}) {
  const reg = await readRegister({ client, enabled });
  if (!reg) return null;
  const at = now.toISOString();
  reg.log = Array.isArray(reg.log) ? reg.log : [];
  if ((Number(reg.rfqStandingVersion) || 0) < RFQ_STANDING_VER) {
    const moved = applyStandingRfqCopies(reg);
    reg.orgs = moved.map((o, i) => (o === reg.orgs[i] ? o : { ...o, updatedAt: at, updatedBy: "standing request" }));
    reg.rfqStandingVersion = RFQ_STANDING_VER;
  }
  const i = reg.orgs.findIndex((o) => o && o.id === orgId);
  if (i < 0) return null;
  const res = setRfqCopies(reg.orgs[i], emails);
  if (res.changed) {
    reg.orgs[i] = { ...res.org, updatedAt: at, updatedBy: by };
    const parts = [res.on.length ? `ticked for ${res.on.join(", ")}` : "", res.off.length ? `unticked for ${res.off.join(", ")}` : ""].filter(Boolean).join("; ");
    reg.log.push({ at, by, orgId, org: res.org.name, text: `RFQ copy ${parts || "saved"} — saved from the RFQ composer` });
    if (reg.log.length > 600) reg.log = reg.log.slice(-600);
  }
  reg.updatedAt = at; reg.updatedBy = by;
  writeLocal(reg);
  let saved = true;
  if (enabled && client) {
    try { const { error } = await client.from(TABLE).upsert({ key: REGISTER_KEY, value: reg, updated_at: at }); if (error) saved = false; } catch { saved = false; }
  }
  return { ...reg, saved };
}

/** entries: [{orgId, subject, threadId?, messageId?, day}] — one per message sent. */
export async function recordRegisterContacts(entries, by = "quotes", { client = supabase, enabled = supabaseEnabled, now = new Date() } = {}) {
  const reg = await readRegister({ client, enabled });
  if (!reg) return false;
  const at = now.toISOString(); const day = at.slice(0, 10);
  reg.log = Array.isArray(reg.log) ? reg.log : [];
  let touched = 0;
  for (const e of entries || []) {
    const o = reg.orgs.find((x) => x.id === e.orgId); if (!o) continue;
    const d = e.day || day;
    if (!o.lastContact || d >= o.lastContact) { o.lastContact = d; o.lastContactDir = "out"; if (e.messageId) o.lastMailId = e.messageId; }
    o.threads = Array.isArray(o.threads) ? o.threads : [];
    const subject = String(e.subject || "").replace(/^((re|fw|fwd)\s*:\s*)+/i, "").trim();
    if (subject && !o.threads.some((t) => t.subject === subject)) o.threads.unshift({ subject, day: d, threadId: e.threadId || "" });
    o.threads = o.threads.slice(0, 12);
    o.updatedAt = at; o.updatedBy = by; touched++;
    reg.log.push({ at, by, orgId: o.id, org: o.name, text: "Sent from Quotes: " + subject });
  }
  if (!touched) return false;
  if (reg.log.length > 600) reg.log = reg.log.slice(-600);
  reg.updatedAt = at; reg.updatedBy = by;
  writeLocal(reg);
  if (enabled && client) {
    try { await client.from(TABLE).upsert({ key: REGISTER_KEY, value: reg, updated_at: at }); } catch { /* the mirror holds it; the Register app merges on its next read */ }
  }
  return true;
}
