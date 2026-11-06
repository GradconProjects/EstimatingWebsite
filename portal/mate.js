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
  /** Every pose the figure can play (the shell's CSS keys on data-pose). The last three are Grady's own
   *  poses added 6 Nov 2026: measure (kneeling with the tape), hips (hands on hips), clipboard (thumbs up, clipboard). */
  const MATE_POSES = ["idle", "wave", "point", "nod", "thumbs", "scratch", "wrist", "celebrate", "sleep", "measure", "hips", "clipboard"];
  const MATE_REPEAT_MS = 10 * 60 * 1000;   // the same fact is said once in ten minutes
  const MATE_IDLE_MS = 10 * 60 * 1000;     // ten minutes without a click or a key → asleep
  const MATE_BUBBLE_MS = 9000;             // a bubble shows this long, then the pose returns to idle
  const MATE_CHATTER_MIN_DEFAULT = 20;     // a friendly line every N minutes while he is awake (Settings; 0 = off)
  const MATE_CHATTER_OPTIONS = [0, 10, 20, 30, 60];
  const MATE_SIZES = [120, 180, 240, 320]; // the figure's height in px (Settings; 240 = "twice what we had")
  const MATE_SIZE_DEFAULT = 240;
  const MATE_OPACITY_DEFAULT = 100;        // percent (Settings slider, 20–100)

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
        if (done >= total) return R("clipboard", `Every element on ${project} is ticked done.`, `open:${d.project}:alldone`);
        if (d.next && String(d.status || "") === "Taking Off") return R("measure", `Tape out — ${project} is being taken off. Next up: ${trim(d.next, 48)}.`, `open:${d.project}:${d.next}`);
        if (d.next) return R("point", `Back on ${project}. Next up: ${trim(d.next, 48)}.`, `open:${d.project}:${d.next}`);
        return R("hips", `Back on ${project}. ${done} of ${total} done.`, `open:${d.project}:${done}/${total}`);
      }
      case "done": {
        const label = trim(d.label || "", 48) || "That one";
        const total = n(d.total), done = n(d.done);
        if (total > 0 && done >= total) return R("celebrate", `${label} ticked — that's every element. ${total} of ${total}.`, `done:all:${total}`);
        return R("nod", `${label} ticked. ${done} of ${total} done.${d.next ? ` Next up: ${trim(d.next, 48)}.` : ""}`, `done:${label}:${done}`);
      }
      case "saved": return R("clipboard", `Saved — a version of ${trim(d.project || "the quote", 48)} kept for good.`, `saved:${d.project}:${Math.floor(e.at / 60000)}`);
      case "rfq": {
        const count = n(d.count); if (!count) return null;
        return R("wave", `${plural(count, "RFQ")} sent${d.packages ? ` — ${trim(d.packages, 60)}` : ""}. Checklist step 05 ticked.`, `rfq:${count}:${d.packages || ""}`);
      }
      case "status": {
        const s = String(d.status || "");
        if (s === "Successful") return R("celebrate", `WON. ${trim(d.project || "", 48) || "This one"} is Gradcon's. Nice one.`, `status:${d.project}:won`);
        if (s === "Submitted" || s === "Tendered") return R("celebrate", `${trim(d.project || "The quote", 48)} is out the door. The deadline clock stops here.`, `status:${d.project}:out`);
        if (s === "Completed Estimating") return R("clipboard", `Estimating complete on ${trim(d.project || "the quote", 48)} — the rates are pinned from here.`, `status:${d.project}:complete`);
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

  /* ------------------------------------------------------------------ chatter
   * Friendly lines he says on his own every N minutes (Grady, 6 Nov 2026: "make him make comments like
   * 'last worked on was', 'what a good day to…' — friendly and funny, 50–100 interchangeable sayings,
   * the projects he opened, not imposing, can be shut off"). Every line is a TEMPLATE: a {placeholder}
   * is filled from the facts the shell holds (the welcome facts, the projects opened this session, the
   * weather chip) and a line is only eligible when every placeholder it needs has a value — so he never
   * names a project, a figure or a day he was not given. `pose` is the pose he strikes for it.
   */
  const MATE_SAYINGS = [
    // last worked on
    { t: "Last worked on was {last}, {lastWhen}. Shall we pick it back up?", needs: ["last", "lastWhen"], pose: "point" },
    { t: "{last} was the last one touched, {lastWhen}. It misses you.", needs: ["last", "lastWhen"], pose: "hips" },
    { t: "Memory check: the last project you were on was {last}.", needs: ["last"], pose: "clipboard" },
    { t: "{last} — {lastWhen}. The concrete does not pour itself, {name}.", needs: ["last", "lastWhen", "name"], pose: "point" },
    { t: "I had a look at {last} while you were away. Did not touch a thing. Promise.", needs: ["last"], pose: "hips" },
    // what a good day to…
    { t: "What a good {day} to tick off {next}.", needs: ["day", "next"], pose: "point" },
    { t: "Good {tod}, {name}. What a day to get {project} over the line.", needs: ["tod", "name", "project"], pose: "wave" },
    { t: "What a good day to send an RFQ before the pilers knock off.", needs: [], pose: "clipboard" },
    { t: "What a good day to measure twice and pour once.", needs: [], pose: "measure" },
    { t: "What a good {day} to be an estimator. Said nobody with a deadline. Said me.", needs: ["day"], pose: "hips" },
    { t: "{day}. Perfect day for a slab. Any slab. I am not fussy.", needs: ["day"], pose: "measure" },
    { t: "What a good day to tidy the crew sheet on {project}.", needs: ["project"], pose: "clipboard" },
    // the projects he opened this session
    { t: "Projects opened today: {opened}. Busy office.", needs: ["opened"], pose: "clipboard" },
    { t: "{nOpened} projects opened so far. {name}, you are on a roll.", needs: ["nOpened", "name"], pose: "thumbs" },
    { t: "First stop today was {firstOpened}. Still think about it sometimes.", needs: ["firstOpened"], pose: "hips" },
    { t: "We have been through {opened} today. My boots are tired.", needs: ["opened"], pose: "hips" },
    { t: "Currently on {project}. {done} of {total} elements ticked.", needs: ["project", "done", "total"], pose: "clipboard" },
    { t: "{project}: {done} done, {total} in all. Next up is {next}. I checked.", needs: ["project", "done", "total", "next"], pose: "point" },
    // deadlines
    { t: "{nDueToday} due TODAY: {dueToday}. No pressure. Some pressure.", needs: ["nDueToday", "dueToday"], pose: "wrist" },
    { t: "{dueWeekFirst} is due this week. Just saying it out loud.", needs: ["dueWeekFirst"], pose: "wrist" },
    { t: "{nDueWeek} quotes due this week. The calendar is not a suggestion.", needs: ["nDueWeek"], pose: "wrist" },
    { t: "Nothing due this week. Enjoy it. It will not last.", needs: ["noneDue"], pose: "hips" },
    { t: "{nQueued} in the queue, {nEstimating} being priced. The machine is humming.", needs: ["nQueued", "nEstimating"], pose: "clipboard" },
    { t: "{nTakingOff} on the tape right now. Measure once, swear twice.", needs: ["nTakingOff"], pose: "measure" },
    { t: "{nQueued} projects queued. Somebody is popular.", needs: ["nQueued"], pose: "hips" },
    // weather
    { t: "{temp}° and {sky} in {place}. Pour weather, if you ask me.", needs: ["temp", "sky", "place"], pose: "hips" },
    { t: "{sky} out there in {place}. Good day to be inside pricing concrete.", needs: ["sky", "place"], pose: "clipboard" },
    { t: "{temp}° in {place}. The slab will cure fine. So will you.", needs: ["temp", "place"], pose: "thumbs" },
    // friendly, no facts needed
    { t: "Blinding first, then the glory. That is the order of things.", needs: [], pose: "measure" },
    { t: "A quote row with no amount prices at zero. Zero is not a price, it is a cry for help.", needs: [], pose: "scratch" },
    { t: "Remember: the margin divides, it does not multiply. I read the manual.", needs: [], pose: "clipboard" },
    { t: "Tie the reo, pour the mud, tick the box. Repeat.", needs: [], pose: "thumbs" },
    { t: "If in doubt, add a bit of edgeform. Nobody ever complained about too much edgeform.", needs: [], pose: "measure" },
    { t: "Four cubic metres is a load. Three point nine is a conversation with Holcim.", needs: [], pose: "scratch" },
    { t: "I have never seen a pump that did not have a four hour minimum. Not once.", needs: [], pose: "hips" },
    { t: "Formwork under 400 goes by the metre. Over 400 goes by the square. The rest goes by feel.", needs: [], pose: "measure" },
    { t: "A clean crew sheet is a happy crew sheet.", needs: [], pose: "clipboard" },
    { t: "Every version is kept for good. Delete with confidence. Then restore with relief.", needs: [], pose: "thumbs" },
    { t: "The Rates Library governs. I just work here.", needs: [], pose: "hips" },
    { t: "Did you know you can drag me anywhere? Go on. I do not get dizzy.", needs: [], pose: "wave" },
    { t: "Stretch your legs. The quote will be here when you get back. So will I.", needs: [], pose: "hips" },
    { t: "Steel is dear, concrete is heavy, and coffee is the only true preliminary.", needs: [], pose: "thumbs" },
    { t: "I counted the trench mesh. Then I counted it again. Same number both times.", needs: [], pose: "measure" },
    { t: "An element ticked done is a bookmark, not a lock. Untick it and nobody gets hurt.", needs: [], pose: "clipboard" },
    { t: "Provisional sums: when you want to be right without being sure.", needs: [], pose: "scratch" },
    { t: "Submitted stops the clock. Won stops the worrying. Neither stops the invoicing.", needs: [], pose: "wrist" },
    { t: "Screw piles or bored piers? Ask the Register before you ask the piler.", needs: [], pose: "point" },
    { t: "There is no such thing as too many drawings attached. There is such a thing as an 18 MB limit.", needs: [], pose: "scratch" },
    { t: "I would offer to hold the tape, but I am made of pixels.", needs: [], pose: "measure" },
    { t: "Hydration is a preliminary. Drink some water.", needs: [], pose: "thumbs" },
    { t: "If the Holcim fee row says auto, it is doing maths so you do not have to.", needs: [], pose: "clipboard" },
    { t: "Packages add up to the project. Always. I checked with verify.", needs: [], pose: "hips" },
    { t: "Confidence is 25% margin. Experience is checking the sub quotes first.", needs: [], pose: "clipboard" },
    { t: "Nothing in this bubble is made up. Everything in your inbox might be.", needs: [], pose: "hips" },
    { t: "Keep going. The pour is booked and the pump has a minimum.", needs: [], pose: "point" },
    { t: "I stand in the corner so you do not have to.", needs: [], pose: "hips" },
    { t: "The tender inbox scans at seven each morning. I scan for snacks.", needs: [], pose: "scratch" },
    // with the name
    { t: "You are doing great, {name}. The spreadsheet never says that, so I will.", needs: ["name"], pose: "thumbs" },
    { t: "{name}, the Done ticks are where you left off. Follow the green.", needs: ["name"], pose: "point" },
    { t: "Oi {name}. Blinding ticked? Just checking. I do not want to be that guy.", needs: ["name"], pose: "scratch" },
    { t: "{name}. Mate. The RFQ button is on every card now. Legible and everything.", needs: ["name"], pose: "point" },
    { t: "Good {tod}, {name}. Nice {day} for it.", needs: ["tod", "name", "day"], pose: "wave" },
    { t: "Happy {day}, {name}. One quote at a time.", needs: ["day", "name"], pose: "wave" },
    { t: "{name}, the last thing touched was {last}. Not pointing fingers. Just pointing.", needs: ["name", "last"], pose: "point" },
    // the recent project's size
    { t: "{last} has {elements} elements on it. Chunky.", needs: ["last", "elements", "elementsMany"], pose: "clipboard" },
    { t: "{last} is a one-element job. Easy money, if the piler plays ball.", needs: ["last", "elementsOne"], pose: "thumbs" },
    // next up
    { t: "Next up on the sheet: {next}. The rest can wait its turn.", needs: ["next"], pose: "point" },
    { t: "{next} is next. I would start with the concrete. I always start with the concrete.", needs: ["next"], pose: "measure" },
    { t: "Between you and me, {next} is not going to tick itself.", needs: ["next"], pose: "point" },
    { t: "Everything on {project} is ticked. Go on, submit it. Or add a sauna.", needs: ["project", "allDone"], pose: "celebrate" },
  ];

  const SAYING_PLACEHOLDERS = ["name", "day", "tod", "last", "lastWhen", "next", "project", "done", "total", "dueToday", "nDueToday", "dueWeekFirst", "nDueWeek", "nQueued", "nEstimating", "nTakingOff", "opened", "nOpened", "firstOpened", "temp", "sky", "place", "elements"];
  const SAYING_FLAGS = ["noneDue", "elementsMany", "elementsOne", "allDone"];

  /** The facts a saying can use, from what the shell holds. Blank / zero facts are left OUT so a line that
   *  needs them is not eligible. {name, day, tod, last, lastWhen, next, project, done, total, dueToday, …}. */
  function sayingFacts(raw) {
    const r = raw || {}; const w = r.welcome || {}; const f = {};
    const put = (k, v) => { if (v === null || v === undefined) return; const s = typeof v === "number" ? String(v) : String(v).trim(); if (s) f[k] = s; };
    put("name", r.name); put("day", w.day || r.day); put("tod", r.tod);
    if (w.recent && w.recent.name) { put("last", trim(w.recent.name, 48)); put("lastWhen", w.recent.when); if (n(w.recent.elements) > 1) { put("elements", n(w.recent.elements)); f.elementsMany = "1"; } if (n(w.recent.elements) === 1) f.elementsOne = "1"; }
    put("next", r.next ? trim(r.next, 48) : ""); put("project", r.project ? trim(r.project, 48) : "");
    if (r.project && Number.isFinite(Number(r.total)) && n(r.total) > 0) { put("done", n(r.done)); put("total", n(r.total)); if (n(r.done) >= n(r.total)) f.allDone = "1"; }
    const dt = Array.isArray(w.dueToday) ? w.dueToday : [], dw = Array.isArray(w.dueWeek) ? w.dueWeek : [];
    if (dt.length) { put("nDueToday", dt.length); put("dueToday", trim(dt.join(", "), 80)); }
    if (dw.length) { put("nDueWeek", dw.length); put("dueWeekFirst", trim(dw[0], 48)); }
    if (w.day && !dt.length && !dw.length) f.noneDue = "1";
    if (n(w.nQueued) > 0) put("nQueued", n(w.nQueued)); if (n(w.nEstimating) > 0) put("nEstimating", n(w.nEstimating)); if (n(w.nTakingOff) > 0) put("nTakingOff", n(w.nTakingOff));
    const op = Array.isArray(r.opened) ? r.opened.filter(Boolean) : [];
    if (op.length >= 2) { put("opened", trim(op.map((x) => trim(x, 40)).join(", "), 120)); put("nOpened", op.length); put("firstOpened", trim(op[0], 48)); }
    if (r.weather && typeof r.weather === "object") { if (Number.isFinite(Number(r.weather.temp))) put("temp", Math.round(Number(r.weather.temp))); put("sky", r.weather.sky ? String(r.weather.sky).toLowerCase() : ""); put("place", r.weather.place); }
    return f;
  }
  function fillSaying(t, f) { return String(t).replace(/\{(\w+)\}/g, (m, k) => (f[k] !== undefined ? f[k] : m)); }
  /** The sayings whose every need the facts satisfy. */
  function eligibleSayings(f) { return MATE_SAYINGS.filter((s) => (s.needs || []).every((k) => f[k] !== undefined)); }
  /** One saying for the moment: {text, pose, sig} or null. `seed` picks (a minute slot does); the previous text is never repeated back to back. */
  function mateSaying(raw, seed, lastText) {
    const f = sayingFacts(raw); let list = eligibleSayings(f);
    if (!list.length) return null;
    if (lastText && list.length > 1) list = list.filter((s) => fillSaying(s.t, f) !== lastText);
    const i = Math.abs(Math.floor(n(seed))) % list.length; const s = list[i];
    const filled = fillSaying(s.t, f); const text = filled.charAt(0).toUpperCase() + filled.slice(1); // a lower-cased fact can open the line
    return { text, pose: MATE_POSES.indexOf(s.pose) >= 0 ? s.pose : "hips", sig: `say:${text}` };
  }

  /* ------------------------------------------------------------- placement, size, opacity, chatter */
  function mateSize(prefs) { const v = n(prefs && prefs.mateSize); return MATE_SIZES.indexOf(v) >= 0 ? v : MATE_SIZE_DEFAULT; }
  function mateOpacity(prefs) { const v = prefs && Number.isFinite(Number(prefs.mateOpacity)) ? Number(prefs.mateOpacity) : MATE_OPACITY_DEFAULT; return Math.min(100, Math.max(20, v)) / 100; }
  function mateChatterMs(prefs) { const v = prefs && Number.isFinite(Number(prefs.mateChatterMin)) ? Number(prefs.mateChatterMin) : MATE_CHATTER_MIN_DEFAULT; return MATE_CHATTER_OPTIONS.indexOf(v) >= 0 ? v * 60000 : MATE_CHATTER_MIN_DEFAULT * 60000; }
  /** Keep a dragged figure on screen: {x, y} are the figure's left / top in px; null = the default corner. */
  function clampMatePos(pos, size, viewport) {
    if (!pos || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) return null;
    const w = n(size && size.w) || 120, h = n(size && size.h) || 240, vw = n(viewport && viewport.w) || 1280, vh = n(viewport && viewport.h) || 800;
    return { x: Math.round(Math.min(Math.max(0, Number(pos.x)), Math.max(0, vw - w))), y: Math.round(Math.min(Math.max(0, Number(pos.y)), Math.max(0, vh - h))) };
  }

  /** Subcontract quote rows with a quantity but no amount typed on the element — the handover's own test. */
  function countUnpricedQuoteRows(items) {
    return (items || []).reduce((acc, it) => acc + Object.entries((it && it.qtys) || {}).filter(([k, v]) => /::quote$/.test(k) && Number(v) > 0 && !(it.rateOverrides && it.rateOverrides[k] && Number(it.rateOverrides[k].unitCost) > 0)).length, 0);
  }

  return { MATE_EVENT_KEY, MATE_POSES, MATE_REPEAT_MS, MATE_IDLE_MS, MATE_BUBBLE_MS, MATE_CHATTER_MIN_DEFAULT, MATE_CHATTER_OPTIONS, MATE_SIZES, MATE_SIZE_DEFAULT, MATE_OPACITY_DEFAULT,
    MATE_SAYINGS, SAYING_PLACEHOLDERS, SAYING_FLAGS, sayingFacts, fillSaying, eligibleSayings, mateSaying, mateSize, mateOpacity, mateChatterMs, clampMatePos,
    parseMateEvent, mateReaction, shouldSpeak, idlePose, mateEnabled, countUnpricedQuoteRows };
});
