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
