import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight, Clock, Loader2, MessageSquarePlus, Radar } from "lucide-react";
import { PLANNER_PRIORITIES, PLANNER_PRIORITY_STYLES } from "../data/catalog.js";
import { readQuotes, writeQuote } from "../lib/projects.js";
import { uid } from "../lib/costing.js";
import { isUrgent, daysLabel, priorityRank } from "../lib/planner.js";

const CHANNELS = ["Call", "Email", "Site meeting", "Text/WhatsApp", "Other"];

// Portal Settings preference for the priority a project shows before anyone
// has set one — validated against the real list so a stale/typo'd stored
// value can never render an unstyled priority.
const defaultPriority = () => {
  try {
    const p = JSON.parse(localStorage.getItem("gradcon-preferences")) || {};
    return PLANNER_PRIORITIES.includes(p.plannerDefaultPriority) ? p.plannerDefaultPriority : "Medium";
  } catch {
    return "Medium";
  }
};

export default function PlannerView({ projects, onOpen }) {
  const [quotesByKey, setQuotesByKey] = useState({});
  const [loading, setLoading] = useState(true);
  const [openComms, setOpenComms] = useState({}); // projectId -> bool

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    readQuotes(projects.map((p) => p.storageKey)).then((map) => {
      if (cancelled) return;
      setQuotesByKey(map);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projects]);

  const rows = useMemo(
    () => projects.map((p) => {
      const quote = quotesByKey[p.storageKey] || {};
      return {
        project: p,
        name: quote.projectName || "Untitled project",
        planner: quote.planner || { deadline: "", priority: defaultPriority(), requirements: "" },
        communications: quote.communications || [],
      };
    }),
    [projects, quotesByKey]
  );

  const patchQuote = (project, patch) => {
    const quote = quotesByKey[project.storageKey] || {};
    const updated = { ...quote, ...patch };
    setQuotesByKey((m) => ({ ...m, [project.storageKey]: updated }));
    writeQuote(project.storageKey, updated);
  };
  const patchPlanner = (project, field, value) => {
    const quote = quotesByKey[project.storageKey] || {};
    patchQuote(project, { planner: { ...(quote.planner || {}), [field]: value } });
  };
  const addCommunication = (project, entry) => {
    const quote = quotesByKey[project.storageKey] || {};
    const list = quote.communications || [];
    patchQuote(project, { communications: [{ id: uid(), ...entry }, ...list] });
  };

  const attend = rows
    .filter((r) => isUrgent(r.planner))
    .sort((a, b) => priorityRank(a.planner.priority) - priorityRank(b.planner.priority)
      || (a.planner.deadline || "9999").localeCompare(b.planner.deadline || "9999"));
  const defer = rows
    .filter((r) => !isUrgent(r.planner))
    .sort((a, b) => (a.planner.deadline || "9999").localeCompare(b.planner.deadline || "9999"));

  if (loading && rows.length === 0) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-16 text-center text-neutral-400">
        <Loader2 size={16} className="inline animate-spin mr-1.5" /> Loading projects…
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
          <Radar size={20} className="text-orange-500" /> Planner
        </h1>
        <p className="text-sm text-neutral-500">
          Deadlines, priority and requirements across every project — what to attend to now, and what can wait.
        </p>
      </div>

      {rows.length === 0 && (
        <div className="text-center py-16 text-neutral-400 border-2 border-dashed border-neutral-200 rounded-xl">
          No projects yet — add one from the Dashboard first.
        </div>
      )}

      {attend.length > 0 && (
        <Section title="Attend to now" count={attend.length} tone="urgent">
          {attend.map((r) => (
            <ProjectPlannerCard
              key={r.project.id}
              row={r}
              onOpen={onOpen}
              onPatchPlanner={(field, v) => patchPlanner(r.project, field, v)}
              onAddCommunication={(entry) => addCommunication(r.project, entry)}
              commsOpen={!!openComms[r.project.id]}
              setCommsOpen={(v) => setOpenComms((m) => ({ ...m, [r.project.id]: v }))}
            />
          ))}
        </Section>
      )}

      {defer.length > 0 && (
        <Section title="Can defer" count={defer.length} tone="quiet">
          {defer.map((r) => (
            <ProjectPlannerCard
              key={r.project.id}
              row={r}
              onOpen={onOpen}
              onPatchPlanner={(field, v) => patchPlanner(r.project, field, v)}
              onAddCommunication={(entry) => addCommunication(r.project, entry)}
              commsOpen={!!openComms[r.project.id]}
              setCommsOpen={(v) => setOpenComms((m) => ({ ...m, [r.project.id]: v }))}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, count, tone, children }) {
  return (
    <div>
      <div className={`flex items-center gap-2 mb-2 text-sm font-semibold ${tone === "urgent" ? "text-red-600" : "text-neutral-500"}`}>
        {tone === "urgent" && <Clock size={15} />}
        {title} <span className="text-xs font-normal text-neutral-400">({count})</span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function ProjectPlannerCard({ row, onOpen, onPatchPlanner, onAddCommunication, commsOpen, setCommsOpen }) {
  const { project, name, planner, communications } = row;
  const style = PLANNER_PRIORITY_STYLES[planner.priority] || PLANNER_PRIORITY_STYLES[defaultPriority()] || PLANNER_PRIORITY_STYLES.Medium;
  const due = daysLabel(planner.deadline);
  const [open, setOpen] = useState(false);
  const [logging, setLogging] = useState(false);
  const [draft, setDraft] = useState({ date: new Date().toISOString().slice(0, 10), contact: "", channel: CHANNELS[0], summary: "" });

  const submitLog = () => {
    if (!draft.summary.trim()) return;
    onAddCommunication(draft);
    setDraft({ date: new Date().toISOString().slice(0, 10), contact: "", channel: CHANNELS[0], summary: "" });
    setLogging(false);
    setCommsOpen(true);
  };

  return (
    <div className="rounded-xl border border-neutral-200 bg-white shadow-sm">
      <button onClick={() => setOpen(!open)} className="w-full flex items-start justify-between gap-3 flex-wrap p-4 text-left">
        <div className="min-w-0 flex items-start gap-2">
          {open ? <ChevronDown size={16} className="text-neutral-400 mt-0.5 flex-none" /> : <ChevronRight size={16} className="text-neutral-400 mt-0.5 flex-none" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`inline-block w-2.5 h-2.5 rounded-full flex-none ${style.dot}`} />
              <span className="font-semibold text-[15px] text-neutral-900">{name}</span>
            </div>
            {due && <div className={`text-xs mt-0.5 ${due.cls}`}>{due.text}</div>}
          </div>
        </div>
        <span
          onClick={(e) => { e.stopPropagation(); onOpen(project.id); }}
          className="flex items-center gap-1 text-xs font-medium text-blue-900 hover:text-blue-700 flex-none"
        >
          Open project <ArrowRight size={13} />
        </span>
      </button>

      {open && (
      <div className="px-4 pb-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <label className="block text-xs">
          <span className="block text-neutral-400 mb-1">Deadline</span>
          <input
            type="date"
            value={planner.deadline || ""}
            onChange={(e) => onPatchPlanner("deadline", e.target.value)}
            className="w-full border border-neutral-200 rounded px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-xs">
          <span className="block text-neutral-400 mb-1">Priority</span>
          <select
            value={planner.priority || defaultPriority()}
            onChange={(e) => onPatchPlanner("priority", e.target.value)}
            className={`w-full border border-neutral-200 rounded px-2 py-1 text-sm font-medium ${style.text}`}
          >
            {PLANNER_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>

      <label className="block text-xs mt-3">
        <span className="block text-neutral-400 mb-1">Requirements / what's needed to move this forward</span>
        <textarea
          defaultValue={planner.requirements || ""}
          onBlur={(e) => onPatchPlanner("requirements", e.target.value)}
          rows={2}
          placeholder="e.g. waiting on structural drawings from architect, client to confirm scope"
          className="w-full border border-neutral-200 rounded px-2 py-1.5 text-sm"
        />
      </label>

      <div className="mt-3 border-t border-neutral-100 pt-2">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setCommsOpen(!commsOpen)}
            className="text-xs font-medium text-neutral-500 hover:text-neutral-700"
          >
            Communications ({communications.length}) {commsOpen ? "▲" : "▼"}
          </button>
          <button
            onClick={() => setLogging(!logging)}
            className="flex items-center gap-1 text-xs font-medium text-orange-600 hover:text-orange-700"
          >
            <MessageSquarePlus size={13} /> Log communication
          </button>
        </div>

        {logging && (
          <div className="mt-2 p-2 bg-neutral-50 rounded-lg border border-neutral-200 space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <input type="date" value={draft.date} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} className="border border-neutral-200 rounded px-2 py-1 text-xs" />
              <input placeholder="Contact" value={draft.contact} onChange={(e) => setDraft((d) => ({ ...d, contact: e.target.value }))} className="border border-neutral-200 rounded px-2 py-1 text-xs" />
              <select value={draft.channel} onChange={(e) => setDraft((d) => ({ ...d, channel: e.target.value }))} className="border border-neutral-200 rounded px-2 py-1 text-xs">
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <textarea
              placeholder="Summary"
              value={draft.summary}
              onChange={(e) => setDraft((d) => ({ ...d, summary: e.target.value }))}
              rows={2}
              className="w-full border border-neutral-200 rounded px-2 py-1 text-xs"
            />
            <button onClick={submitLog} className="px-2 py-1 rounded bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold">
              Add
            </button>
          </div>
        )}

        {commsOpen && (
          <div className="mt-2 space-y-1.5">
            {communications.length === 0 && <div className="text-xs text-neutral-400 italic">No communications logged yet.</div>}
            {communications.map((c) => (
              <div key={c.id} className="text-xs text-neutral-600 flex gap-2">
                <span className="text-neutral-400 flex-none">{c.date}</span>
                <span className="font-medium flex-none">{c.channel}{c.contact ? ` · ${c.contact}` : ""}</span>
                <span className="text-neutral-500">{c.summary}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      </div>
      )}
    </div>
  );
}
