import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight, Clock, GitBranch, HardHat, Loader2, MessageSquarePlus, Package, Plus, Radar, Trash2 } from "lucide-react";
import { PLANNER_PRIORITIES, PLANNER_PRIORITY_STYLES } from "../data/catalog.js";
import { readQuotes, writeQuote } from "../lib/projects.js";
import { uid, money2 } from "../lib/costing.js";
import { useStoredState } from "../lib/storage.js";
import { isUrgent, daysLabel, priorityRank } from "../lib/planner.js";

const CHANNELS = ["Call", "Email", "Site meeting", "Text/WhatsApp", "Other"];
const VARIATION_STATUSES = ["Draft", "Submitted", "Approved", "Rejected"];

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

/**
 * Project Management — the old Planner tab, grown into a sub-tabbed section:
 * Planner (deadlines/priorities/comms, unchanged), Variations (per-project
 * variation register, stored on each quote), and global Contractor/Supplier
 * registers (via useStoredState, so they sync through Supabase like every
 * other persisted blob). The App.jsx view key stays "planner" — the portal
 * shell's welcome tile and any remembered view both point at it.
 */
export default function PlannerView({ projects, onOpen }) {
  const [tab, setTab] = useState("planner");
  const [quotesByKey, setQuotesByKey] = useState({});
  const [loading, setLoading] = useState(true);

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

  const patchQuote = (project, patch) => {
    const quote = quotesByKey[project.storageKey] || {};
    const updated = { ...quote, ...patch };
    setQuotesByKey((m) => ({ ...m, [project.storageKey]: updated }));
    writeQuote(project.storageKey, updated);
  };

  const TABS = [
    { key: "planner", label: "Planner", Icon: Radar },
    { key: "variations", label: "Variations", Icon: GitBranch },
    { key: "contractors", label: "Contractors", Icon: HardHat },
    { key: "suppliers", label: "Suppliers", Icon: Package },
  ];

  if (loading && projects.length > 0 && Object.keys(quotesByKey).length === 0) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-16 text-center text-neutral-400">
        <Loader2 size={16} className="inline animate-spin mr-1.5" /> Loading projects…
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
          <Radar size={20} className="text-orange-500" /> Project Management
        </h1>
        <p className="text-sm text-neutral-500">
          Planning, variations and your contractor &amp; supplier registers, in one place.
        </p>
      </div>

      <div className="flex gap-1 border-b border-neutral-200">
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === key ? "border-orange-500 text-neutral-900" : "border-transparent text-neutral-400 hover:text-neutral-600"
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === "planner" && (
        <PlannerTab projects={projects} quotesByKey={quotesByKey} onOpen={onOpen} patchQuote={patchQuote} />
      )}
      {tab === "variations" && (
        <VariationsTab projects={projects} quotesByKey={quotesByKey} onOpen={onOpen} patchQuote={patchQuote} />
      )}
      {tab === "contractors" && (
        <RegisterTab
          storageKey="gradcon-contractors"
          title="Contractor register"
          nounSingular="contractor"
          roleLabel="Trade / scope"
          rolePlaceholder="e.g. Formwork, Steel fixing, Pumping"
        />
      )}
      {tab === "suppliers" && (
        <RegisterTab
          storageKey="gradcon-suppliers"
          title="Supplier register"
          nounSingular="supplier"
          roleLabel="Supplies"
          rolePlaceholder="e.g. Premix concrete, Reo bar &amp; mesh, Formply"
        />
      )}
    </div>
  );
}

function PlannerTab({ projects, quotesByKey, onOpen, patchQuote }) {
  const [openComms, setOpenComms] = useState({}); // projectId -> bool

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

  return (
    <div className="space-y-6">
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

/* ---------- Variations (stored per project on quote.variations) ---------- */

const VARIATION_STATUS_STYLES = {
  Draft: "bg-neutral-100 text-neutral-600",
  Submitted: "bg-blue-100 text-blue-800",
  Approved: "bg-green-100 text-green-800",
  Rejected: "bg-red-100 text-red-700",
};

function VariationsTab({ projects, quotesByKey, onOpen, patchQuote }) {
  const rowsByProject = projects.map((p) => {
    const quote = quotesByKey[p.storageKey] || {};
    return { project: p, name: quote.projectName || "Untitled project", variations: quote.variations || [] };
  });

  const patchVariations = (project, variations) => patchQuote(project, { variations });
  const addVariation = (project, existing) => {
    const nextNo = existing.reduce((mx, v) => Math.max(mx, Number(v.no) || 0), 0) + 1;
    patchVariations(project, [
      ...existing,
      { id: uid(), no: nextNo, date: new Date().toISOString().slice(0, 10), description: "", status: "Draft", cost: "", days: "" },
    ]);
  };
  const changeVariation = (project, existing, id, field, value) =>
    patchVariations(project, existing.map((v) => (v.id === id ? { ...v, [field]: value } : v)));
  const removeVariation = (project, existing, id) =>
    patchVariations(project, existing.filter((v) => v.id !== id));

  if (rowsByProject.length === 0) {
    return (
      <div className="text-center py-16 text-neutral-400 border-2 border-dashed border-neutral-200 rounded-xl">
        No projects yet — add one from the Dashboard first.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {rowsByProject.map(({ project, name, variations }) => {
        const approved = variations.filter((v) => v.status === "Approved")
          .reduce((s, v) => s + (Number(v.cost) || 0), 0);
        return (
          <div key={project.id} className="rounded-xl border border-neutral-200 bg-white shadow-sm overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-neutral-50 border-b border-neutral-200">
              <button
                onClick={() => onOpen(project.id)}
                className="font-semibold text-[14px] text-neutral-900 hover:text-blue-900 flex items-center gap-1"
              >
                {name} <ArrowRight size={13} className="text-neutral-400" />
              </button>
              <div className="text-xs text-neutral-500">
                {variations.length} variation{variations.length === 1 ? "" : "s"}
                {approved !== 0 && <> · approved value <b className="font-mono tabular-nums text-green-700">{money2(approved)}</b></>}
              </div>
            </div>
            <div className="p-3 space-y-2">
              {variations.length === 0 && (
                <div className="text-xs text-neutral-400 italic">No variations logged for this project.</div>
              )}
              {variations.map((v) => (
                <div key={v.id} className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap">
                  <span className="w-12 flex-none text-xs font-mono text-neutral-500 text-center">VO-{String(v.no).padStart(2, "0")}</span>
                  <input
                    type="date"
                    value={v.date || ""}
                    onChange={(e) => changeVariation(project, variations, v.id, "date", e.target.value)}
                    className="w-32 flex-none border border-neutral-200 rounded px-2 py-1 text-xs"
                  />
                  <input
                    value={v.description}
                    onChange={(e) => changeVariation(project, variations, v.id, "description", e.target.value)}
                    placeholder="Variation description (scope change, extra pour, latent condition…)"
                    className="flex-1 min-w-40 border border-neutral-200 rounded px-2 py-1 text-[13px]"
                  />
                  <select
                    value={v.status}
                    onChange={(e) => changeVariation(project, variations, v.id, "status", e.target.value)}
                    className={`w-28 flex-none border border-neutral-200 rounded px-1.5 py-1 text-xs font-medium ${VARIATION_STATUS_STYLES[v.status] || ""}`}
                  >
                    {VARIATION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <input
                    type="number"
                    value={v.cost}
                    onChange={(e) => changeVariation(project, variations, v.id, "cost", e.target.value)}
                    placeholder="$ cost"
                    className="w-24 flex-none border border-neutral-200 rounded px-2 py-1 text-xs font-mono tabular-nums text-right"
                  />
                  <input
                    type="number"
                    value={v.days}
                    onChange={(e) => changeVariation(project, variations, v.id, "days", e.target.value)}
                    placeholder="days"
                    title="Time impact (days)"
                    className="w-16 flex-none border border-neutral-200 rounded px-2 py-1 text-xs font-mono tabular-nums text-right"
                  />
                  <button
                    onClick={() => removeVariation(project, variations, v.id)}
                    className="text-neutral-300 hover:text-red-500 transition-colors flex-none"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button
                onClick={() => addVariation(project, variations)}
                className="flex items-center gap-1 text-xs font-medium text-orange-600 hover:text-orange-700"
              >
                <Plus size={13} /> Add variation
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---- Contractor & Supplier registers (global, shared across projects) ---- */

function RegisterTab({ storageKey, title, nounSingular, roleLabel, rolePlaceholder }) {
  const [entries, setEntries, status] = useStoredState(storageKey, []);

  const add = () =>
    setEntries((list) => [...list, { id: uid(), name: "", role: "", contact: "", phone: "", email: "", notes: "" }]);
  const change = (id, field, v) =>
    setEntries((list) => list.map((e) => (e.id === id ? { ...e, [field]: v } : e)));
  const remove = (id) => setEntries((list) => list.filter((e) => e.id !== id));

  if (status === "loading") {
    return (
      <div className="py-16 text-center text-neutral-400">
        <Loader2 size={16} className="inline animate-spin mr-1.5" /> Loading {title.toLowerCase()}…
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 bg-neutral-50 border-b border-neutral-200 flex items-center justify-between">
        <span className="font-semibold text-[14px] text-neutral-900">{title}</span>
        <span className="text-xs text-neutral-500">{entries.length} {nounSingular}{entries.length === 1 ? "" : "s"}</span>
      </div>
      <div className="p-3 overflow-x-auto">
        {entries.length === 0 && (
          <div className="text-xs text-neutral-400 italic mb-2">No {nounSingular}s registered yet.</div>
        )}
        {entries.length > 0 && (
          <table className="w-full text-[13px] min-w-[720px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-neutral-400">
                <th className="pb-1.5 pr-2">Company / name</th>
                <th className="pb-1.5 pr-2">{roleLabel}</th>
                <th className="pb-1.5 pr-2">Contact person</th>
                <th className="pb-1.5 pr-2">Phone</th>
                <th className="pb-1.5 pr-2">Email</th>
                <th className="pb-1.5 pr-2">Notes</th>
                <th className="pb-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-neutral-100">
                  <td className="py-1 pr-2"><RegInput value={e.name} onChange={(v) => change(e.id, "name", v)} placeholder="Name" /></td>
                  <td className="py-1 pr-2"><RegInput value={e.role} onChange={(v) => change(e.id, "role", v)} placeholder={rolePlaceholder} /></td>
                  <td className="py-1 pr-2"><RegInput value={e.contact} onChange={(v) => change(e.id, "contact", v)} placeholder="Contact" /></td>
                  <td className="py-1 pr-2"><RegInput value={e.phone} onChange={(v) => change(e.id, "phone", v)} placeholder="Phone" /></td>
                  <td className="py-1 pr-2"><RegInput value={e.email} onChange={(v) => change(e.id, "email", v)} placeholder="Email" /></td>
                  <td className="py-1 pr-2"><RegInput value={e.notes} onChange={(v) => change(e.id, "notes", v)} placeholder="Notes (rates, reliability, insurances…)" /></td>
                  <td className="py-1">
                    <button onClick={() => remove(e.id)} className="text-neutral-300 hover:text-red-500 transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button onClick={add} className="mt-2 flex items-center gap-1 text-xs font-medium text-orange-600 hover:text-orange-700">
          <Plus size={13} /> Add {nounSingular}
        </button>
      </div>
    </div>
  );
}

function RegInput({ value, onChange, placeholder }) {
  return (
    <input
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full border border-neutral-200 rounded px-2 py-1 text-[13px] focus:outline-none focus:ring-2 focus:ring-orange-400"
    />
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
