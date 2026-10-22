import { useEffect, useMemo, useState } from "react";
import { MapPin, Loader2, X, Check } from "lucide-react";
import { requestProjectNames, autoApplies, applyNamePatch, keepNamePatch, isConventionName } from "../lib/projectNaming.js";
import { preferredProvider } from "../lib/tenderWording.js";

/**
 * The choice a project name gets when the address convention cannot be
 * applied on its own (lib/projectNaming.js): the options the AI provider
 * proposed, each a radio, plus "keep as typed". Rendered under the editor's
 * name field by App.jsx. `result` = {options, confidence, note}.
 */
export function AddressOptions({ typed, result, onChoose, onKeep, onClose, source, onRevert }) {
  const [pick, setPick] = useState(0);
  if (!result) return null;
  return (
    <div className="mt-1 border border-amber-300 bg-amber-50 rounded-lg px-3 py-2 text-[12px] text-neutral-900 shadow" role="dialog" aria-label="Project name — address options" data-testid="address-options">
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-amber-900 flex items-center gap-1"><MapPin size={13} /> Name this project by its address</div>
        <button type="button" onClick={onClose} className="p-0.5 rounded hover:bg-amber-100" aria-label="Close"><X size={14} /></button>
      </div>
      <div className="text-[11px] text-neutral-700 mt-0.5">"{typed}" — {result.note || (result.confidence === "high" ? "confirm the address" : "the details are thin; pick the right address or keep the name as typed")}.</div>
      <div className="mt-1.5 space-y-0.5">
        {result.options.map((o, i) => (
          <label key={o.name} className="flex items-center gap-2 cursor-pointer" data-testid="address-option">
            <input type="radio" name="address-option" checked={pick === i} onChange={() => setPick(i)} />
            <span className="font-medium">{o.name}</span>
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={() => onChoose(result.options[pick])} className="px-2.5 py-1 rounded-md bg-orange-600 hover:bg-orange-700 text-white text-[11px] font-semibold" data-testid="address-use"><Check size={11} className="inline mr-0.5" />Use this name</button>
        <button type="button" onClick={onKeep} className="px-2.5 py-1 rounded-md bg-white border border-neutral-300 hover:bg-neutral-50 text-[11px] font-medium" data-testid="address-keep">Keep "{typed}"</button>
        {source && source !== typed && onRevert && <button type="button" onClick={onRevert} className="px-2.5 py-1 rounded-md bg-white border border-neutral-300 hover:bg-neutral-50 text-[11px] font-medium" data-testid="address-revert">Back to "{source}" as typed</button>}
      </div>
    </div>
  );
}

/**
 * Existing projects renamed in one pass (the Dashboard's "Standardise
 * names"): every project whose name is not yet in the convention is sent in
 * one request; each comes back with a proposal (a select when there are
 * several) and a tick — ticked by default when the model was confident,
 * unticked when it was not — and ONE button renames the ticked ones through
 * `onRename(project, option)`. Nothing is renamed until that button.
 */
export function RenameProjectsModal({ rows, onRename, onClose }) {
  const todo = useMemo(() => rows.filter((r) => r.name && !isConventionName(r.name)), [rows]);
  const [state, setState] = useState({ loading: true, error: null, results: {} });
  const [picks, setPicks] = useState({});      // id → option index
  const [ticked, setTicked] = useState({});    // id → bool
  const [done, setDone] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!todo.length) { setState({ loading: false, error: null, results: {} }); return undefined; }
    requestProjectNames(todo, { provider: preferredProvider() })
      .then((r) => {
        if (cancelled) return;
        const t = {}; Object.keys(r.results).forEach((id) => { t[id] = autoApplies(r.results[id]); });
        setTicked(t); setState({ loading: false, error: null, results: r.results, provider: r.provider });
      })
      .catch((e) => { if (!cancelled) setState({ loading: false, error: e.message, results: {} }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const apply = () => {
    let n = 0;
    todo.forEach((r) => {
      const res = state.results[String(r.id)];
      if (!res || !ticked[String(r.id)]) return;
      const opt = res.options[picks[String(r.id)] || 0];
      if (opt) { onRename(r, opt); n += 1; }
    });
    setDone(n);
  };
  const tickedCount = Object.values(ticked).filter(Boolean).length;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-label="Standardise project names" data-testid="rename-projects">
      <div className="w-full max-w-3xl bg-white rounded-xl shadow-2xl flex flex-col max-h-[85vh]">
        <div className="px-4 py-3 border-b border-neutral-200 flex items-center justify-between bg-blue-950 text-white rounded-t-xl">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-blue-300 font-semibold">Projects Dashboard</div>
            <div className="font-semibold">Standardise project names — the address convention</div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-blue-900" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="px-4 py-2 text-[12px] text-neutral-700 border-b border-neutral-100">
          Every name becomes <b>&lt;number&gt; &lt;Street&gt;, &lt;Suburb&gt; VIC &lt;postcode&gt; — &lt;descriptor&gt;</b>. The AI provider proposes; tick what to rename, choose where it offers more than one address, and nothing changes until the button. The name as typed is kept on the project.
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-2">
          {state.loading ? <div className="flex items-center gap-2 text-[12px] text-neutral-500 py-4"><Loader2 size={14} className="animate-spin" /> Asking the AI provider about {todo.length} project name{todo.length === 1 ? "" : "s"}…</div>
            : state.error ? <div className="text-[12px] text-red-700 py-3" data-testid="rename-error">{state.error}</div>
            : !todo.length ? <div className="text-[12px] text-neutral-600 py-3">Every project name already follows the convention.</div>
            : (
              <table className="w-full text-[12px]">
                <thead><tr className="text-[10.5px] uppercase tracking-wide text-neutral-500"><th className="py-1 text-left w-8"></th><th className="py-1 text-left">As typed</th><th className="py-1 text-left">Proposed name</th><th className="py-1 text-left">Confidence</th></tr></thead>
                <tbody>
                  {todo.map((r) => {
                    const id = String(r.id); const res = state.results[id];
                    return (
                      <tr key={id} className="border-t border-neutral-100 align-top" data-testid="rename-row" data-confidence={res ? res.confidence : "none"}>
                        <td className="py-1.5"><input type="checkbox" disabled={!res} checked={!!ticked[id]} onChange={(e) => setTicked((t) => ({ ...t, [id]: e.target.checked }))} aria-label={`Rename ${r.name}`} /></td>
                        <td className="py-1.5 pr-3 text-neutral-700">{r.name}{r.client ? <div className="text-[10.5px] text-neutral-400">{r.client}</div> : null}</td>
                        <td className="py-1.5 pr-3">
                          {!res ? <span className="text-neutral-400">no proposal</span>
                            : res.options.length === 1 ? <span className="font-medium">{res.options[0].name}</span>
                            : <select value={picks[id] || 0} onChange={(e) => setPicks((p) => ({ ...p, [id]: Number(e.target.value) }))} className="border border-neutral-300 rounded px-1 py-0.5 text-[12px] max-w-full" data-testid="rename-pick">{res.options.map((o, i) => <option key={o.name} value={i}>{o.name}</option>)}</select>}
                          {res && res.note ? <div className="text-[10.5px] text-neutral-500">{res.note}</div> : null}
                        </td>
                        <td className="py-1.5">{res ? <span className={`px-1.5 py-0.5 rounded text-[10.5px] font-semibold ${res.confidence === "high" ? "bg-emerald-100 text-emerald-800" : res.confidence === "medium" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"}`}>{res.confidence}</span> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
        </div>
        <div className="px-4 py-3 border-t border-neutral-200 flex items-center justify-between gap-3">
          <div className="text-[11px] text-neutral-500">{done != null ? `${done} project${done === 1 ? "" : "s"} renamed.` : state.provider ? `Proposals from ${state.provider}.` : ""}</div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg border border-neutral-300 bg-white hover:bg-neutral-50 text-[12px] font-medium">{done != null ? "Close" : "Cancel"}</button>
            {done == null && <button type="button" disabled={state.loading || !tickedCount} onClick={apply} className="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-700 disabled:bg-neutral-300 text-white text-[12px] font-semibold" data-testid="rename-apply">Rename {tickedCount} ticked</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
