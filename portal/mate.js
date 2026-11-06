/* Grady's mate — the little site worker in the corner of the portal (Grady,
 * 6 Nov 2026: "an avatar of Grady that acts more like the old Microsoft Office
 * paper clip with gestures made while he works" — "just for fun").
 *
 * PURE and DOM-free on purpose, like estimates-schema.js: inlined into
 * portal-shell.html by scripts/assemble-portal.mjs and run in plain Node by
 * scripts/verify.mjs. The shell draws the figure and plays the pose; THIS file
 * decides what the figure does and says. Every line it speaks is built from a
 * fact the app already computed and handed over in the event — nothing is
 * invented, no joke names a person or a project the event did not.
 *
 * Clippy was hated because it interrupted. Rules: one bubble at a time, only
 * on an event, never twice for the same fact within MATE_REPEAT_MS, a ✕ on
 * every bubble, a Settings switch, and nothing it does changes a figure on a
 * quote.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** The localStorage key the apps write an event to; the shell listens for the `storage` event it fires. */
  const MATE_EVENT_KEY = "gradcon-mate-event";
  /** Every pose the figure can play (the shell's CSS keys on data-pose). */
  const MATE_POSES = ["idle", "wave", "point", "nod", "thumbs", "scratch", "wrist", "celebrate", "sleep"];
  const MATE_REPEAT_MS = 10 * 60 * 1000;   // the same fact is said once in ten minutes
  const MATE_IDLE_MS = 10 * 60 * 1000;     // ten minutes without a click or a key → asleep
  const MATE_BUBBLE_MS = 9000;             // a bubble shows this long, then the pose returns to idle

  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const plural = (count, one, many) => `${count} ${count === 1 ? one : (many || one + "s")}`;
  const trim = (s, max) => { const t = String(s == null ? "" : s).trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; };

  /** A stored event, or null for anything that is not one. */
  function parseMateEvent(raw) {
    try {
      const e = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!e || typeof e !== "object" || typeof e.kind !== "string" || !e.kind) return null;
      return { id: String(e.id || ""), kind: e.kind, detail: e.detail && typeof e.detail === "object" ? e.detail : {}, at: n(e.at) };
    } catch { return null; }
  }

  /**
   * What the figure does for an event: {pose, text, sig} or null (nothing to
   * say). `sig` is the fact's signature — the dedupe key. `facts` is the
   * shell's welcome facts (quotes due today / this week) for the sign-in line.
   */
  function mateReaction(ev, facts) {
    const e = parseMateEvent(ev); if (!e) return null;
    const d = e.detail; const f = facts || {};
    const R = (pose, text, sig) => ({ pose, text, sig: sig || `${e.kind}:${text}` });
    switch (e.kind) {
      case "signin": {
        const name = trim(d.name || "", 24) || "there";
        const today = Array.isArray(f.dueToday) ? f.dueToday.length : 0;
        const week = Array.isArray(f.dueWeek) ? f.dueWeek.length : 0;
        if (today) return R("wrist", `G'day ${name}. ${plural(today, "quote is", "quotes are")} due TODAY: ${trim(f.dueToday.join(", "), 80)}.`, `signin:today:${today}`);
        if (week) return R("wave", `G'day ${name}. ${plural(week, "quote", "quotes")} due this week — ${trim(f.dueWeek[0], 50)} first.`, `signin:week:${week}`);
        return R("wave", `G'day ${name}. Nothing due this week. Ready when you are.`, "signin");
      }
      case "open": {
        const project = trim(d.project || "", 48) || "this project";
        const unpriced = n(d.unpriced), expiring = n(d.expiring), total = n(d.total), done = n(d.done);
        if (unpriced > 0) return R("scratch", `${plural(unpriced, "quote row")} on ${project} still ${unpriced === 1 ? "has" : "have"} no amount — ${unpriced === 1 ? "it prices" : "they price"} at $0 until the quote is typed.`, `open:${d.project}:unpriced:${unpriced}`);
        if (expiring > 0) return R("scratch", `${plural(expiring, "supplier rate")} expiring or expired — check the notice at the top.`, `open:expiring:${expiring}`);
        if (total === 0) return R("wave", `${project} — a blank quote. Add the first element.`, `open:${d.project}:blank`);
        if (done >= total) return R("thumbs", `Every element on ${project} is ticked done.`, `open:${d.project}:alldone`);
        if (d.next) return R("point", `Back on ${project}. Next up: ${trim(d.next, 48)}.`, `open:${d.project}:${d.next}`);
        return R("nod", `Back on ${project}. ${done} of ${total} done.`, `open:${d.project}:${done}/${total}`);
      }
      case "done": {
        const label = trim(d.label || "", 48) || "That one";
        const total = n(d.total), done = n(d.done);
        if (total > 0 && done >= total) return R("celebrate", `${label} ticked — that's every element. ${total} of ${total}.`, `done:all:${total}`);
        return R("nod", `${label} ticked. ${done} of ${total} done.${d.next ? ` Next up: ${trim(d.next, 48)}.` : ""}`, `done:${label}:${done}`);
      }
      case "saved": return R("thumbs", `Saved — a version of ${trim(d.project || "the quote", 48)} kept for good.`, `saved:${d.project}:${Math.floor(e.at / 60000)}`);
      case "rfq": {
        const count = n(d.count); if (!count) return null;
        return R("wave", `${plural(count, "RFQ")} sent${d.packages ? ` — ${trim(d.packages, 60)}` : ""}. Checklist step 05 ticked.`, `rfq:${count}:${d.packages || ""}`);
      }
      case "status": {
        const s = String(d.status || "");
        if (s === "Successful") return R("celebrate", `WON. ${trim(d.project || "", 48) || "This one"} is Gradcon's. Nice one.`, `status:${d.project}:won`);
        if (s === "Submitted" || s === "Tendered") return R("celebrate", `${trim(d.project || "The quote", 48)} is out the door. The deadline clock stops here.`, `status:${d.project}:out`);
        if (s === "Completed Estimating") return R("thumbs", `Estimating complete on ${trim(d.project || "the quote", 48)} — the rates are pinned from here.`, `status:${d.project}:complete`);
        if (s === "Unsuccessful") return R("scratch", `Not this one. On to the next.`, `status:${d.project}:lost`);
        if (s === "Deadline Missed") return R("wrist", `Deadline missed on ${trim(d.project || "that one", 48)}. Closed as it stood.`, `status:${d.project}:missed`);
        return null;
      }
      case "checklist": {
        if (!d.complete) return null;
        return R("celebrate", `Tender checklist complete — all ${n(d.total) || 12} steps.`, `checklist:${d.project}:complete`);
      }
      case "jump": return R("point", `${trim(d.label || "", 48) || "That element"} — right there.`, `jump:${d.label}:${Math.floor(e.at / 5000)}`);
      default: return null;
    }
  }

  /** Say it unless the same fact was said within MATE_REPEAT_MS. */
  function shouldSpeak(reaction, lastSig, lastAt, now) {
    if (!reaction) return false;
    if (reaction.sig && reaction.sig === lastSig && n(now) - n(lastAt) < MATE_REPEAT_MS) return false;
    return true;
  }

  /** Asleep after MATE_IDLE_MS without a click or a key, else idle. */
  function idlePose(lastActiveAt, now) {
    return n(now) - n(lastActiveAt) >= MATE_IDLE_MS ? "sleep" : "idle";
  }

  /** On unless Settings turned it off (an explicit false). */
  function mateEnabled(prefs) { return !(prefs && prefs.mateOn === false); }

  /** Subcontract quote rows with a quantity but no amount typed on the element — the handover's own test. */
  function countUnpricedQuoteRows(items) {
    return (items || []).reduce((acc, it) => acc + Object.entries((it && it.qtys) || {}).filter(([k, v]) => /::quote$/.test(k) && Number(v) > 0 && !(it.rateOverrides && it.rateOverrides[k] && Number(it.rateOverrides[k].unitCost) > 0)).length, 0);
  }

  return { MATE_EVENT_KEY, MATE_POSES, MATE_REPEAT_MS, MATE_IDLE_MS, MATE_BUBBLE_MS, parseMateEvent, mateReaction, shouldSpeak, idlePose, mateEnabled, countUnpricedQuoteRows };
});
