import { useState, useMemo, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, Copy, Trash2, Paperclip, X } from "lucide-react";
import { FULL_CATALOG } from "../data/catalog.js";
import { uid, money2, computeElementCost, suggestedLabourPrefill } from "../lib/costing.js";
import CategoryBlock from "./CategoryBlock.jsx";
import LabourMatrix from "./LabourMatrix.jsx";
import AdditionalItems from "./AdditionalItems.jsx";

export default function ElementCard({ item, rates, onChange, onRemove, onDuplicate }) {
  // Every material category starts collapsed — only Labour/Equipment starts
  // expanded (it's still collapsible too, just defaults open).
  const [openCats, setOpenCats] = useState({});
  // Everything starts ROLLED UP: the labour matrix and the whole card, same
  // as every material category. The Settings toggle can restore open-by-
  // default cards by being explicitly set to false.
  const [labourOpen, setLabourOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(() => {
    try {
      const p = JSON.parse(localStorage.getItem("gradcon-preferences")) || {};
      return p.quotesCardsCollapsed === false;
    } catch {
      return false;
    }
  });

  const cost = useMemo(() => computeElementCost(item, rates), [item, rates]);

  const patch = (fn) => onChange(fn(item));

  // Suggests (never overwrites) "Pour concrete..."/"Tie steel..." labour
  // hours from quantities already entered, using Quotes' own PRODUCTION_RATES
  // (see catalog.js). Keyed on item.qtys rather than item.tasks so applying a
  // suggestion (which only touches tasks) can't retrigger itself.
  useEffect(() => {
    const suggestions = suggestedLabourPrefill(item, rates);
    if (Object.keys(suggestions).length === 0) return;
    patch((it) => ({
      ...it,
      tasks: it.tasks.map((t) => (suggestions[t.id] ? { ...t, qtys: { ...suggestions[t.id], ...t.qtys } } : t)),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.qtys, rates]);

  const setQty = (qKey, v) => patch((it) => ({ ...it, qtys: { ...it.qtys, [qKey]: v } }));
  const setLabel = (v) => patch((it) => ({ ...it, label: v }));
  const addTask = () => patch((it) => ({ ...it, tasks: [...it.tasks, { id: uid(), name: "New task", qtys: {} }] }));
  const removeTask = (taskId) => patch((it) => ({ ...it, tasks: it.tasks.filter((t) => t.id !== taskId) }));
  const renameTask = (taskId, name) => patch((it) => ({ ...it, tasks: it.tasks.map((t) => (t.id === taskId ? { ...t, name } : t)) }));
  const setTaskQty = (taskId, resKey, v) =>
    patch((it) => ({ ...it, tasks: it.tasks.map((t) => (t.id === taskId ? { ...t, qtys: { ...t.qtys, [resKey]: v } } : t)) }));

  const addAdditional = () =>
    patch((it) => ({ ...it, additional: [...it.additional, { id: uid(), name: "", unit: "", qty: undefined, rate: undefined }] }));
  const removeAdditional = (id) => patch((it) => ({ ...it, additional: it.additional.filter((a) => a.id !== id) }));
  const changeAdditional = (id, field, v) =>
    patch((it) => ({ ...it, additional: it.additional.map((a) => (a.id === id ? { ...a, [field]: v } : a)) }));
  // Multi-field fill in one patch — used by the catalog picker, which sets
  // name+unit+rate together (three changeAdditional calls would each start
  // from the same stale `item` and drop each other's fields).
  const fillAdditional = (id, fields) =>
    patch((it) => ({ ...it, additional: it.additional.map((a) => (a.id === id ? { ...a, ...fields } : a)) }));

  const setDescription = (v) => patch((it) => ({ ...it, description: v }));

  // Markup drawings (pdf/png/jpg) stored as data URLs on the item itself so
  // they travel with the quote through localStorage/Supabase like everything
  // else. Capped per file — the whole quote has to fit in one storage blob.
  const MAX_MARKUP_BYTES = 3 * 1024 * 1024;
  const fileInputRef = useRef(null);
  const addMarkupFiles = (fileList) => {
    const files = Array.from(fileList || []);
    files.forEach((file) => {
      const ok = /\.(pdf|png|jpe?g)$/i.test(file.name) || /^(application\/pdf|image\/(png|jpeg))$/.test(file.type);
      if (!ok) {
        alert(`"${file.name}" isn't a PDF, PNG or JPG — not added.`);
        return;
      }
      if (file.size > MAX_MARKUP_BYTES) {
        alert(`"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB — markups are capped at 3 MB each so the quote still saves. Export a smaller/flattened copy and try again.`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
        patch((it) => ({
          ...it,
          markups: [...(it.markups || []), { id: uid(), name: file.name, type: isPdf ? "pdf" : "image", dataURL: reader.result }],
        }));
      };
      reader.readAsDataURL(file);
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };
  const removeMarkup = (id) => patch((it) => ({ ...it, markups: (it.markups || []).filter((m) => m.id !== id) }));
  const markups = item.markups || [];

  return (
    <div className="rounded-xl border border-neutral-200 bg-white shadow-sm overflow-hidden">
      <div className="bg-blue-950 text-white px-4 py-3 flex items-center gap-3">
        <button onClick={() => setCardOpen(!cardOpen)} className="text-blue-300 hover:text-white transition-colors flex-none">
          {cardOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-blue-300 font-semibold flex items-center gap-1.5">
            <span>{item.category} {item.category && item.section ? "›" : ""} {item.section}</span>
            {markups.length > 0 && (
              <span className="inline-flex items-center gap-0.5 text-orange-400 normal-case tracking-normal" title={`${markups.length} markup drawing(s) attached`}>
                <Paperclip size={10} /> {markups.length}
              </span>
            )}
          </div>
          <input
            value={item.label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full bg-transparent border-0 text-white font-semibold text-[15px] focus:outline-none focus:underline decoration-orange-400"
          />
        </div>
        <div className="text-right flex-none">
          <div className="text-[10px] uppercase tracking-widest text-blue-300">Total</div>
          <div className="font-mono tabular-nums text-lg font-bold text-orange-400">{money2(cost.total)}</div>
        </div>
        <button onClick={onDuplicate} title="Duplicate" className="text-blue-300 hover:text-white transition-colors flex-none">
          <Copy size={16} />
        </button>
        <button onClick={onRemove} title="Remove" className="text-blue-300 hover:text-red-400 transition-colors flex-none">
          <Trash2 size={16} />
        </button>
      </div>

      {cardOpen && (
        <div className="p-3 space-y-2 bg-neutral-50">
          <div className="text-xs text-neutral-500 flex flex-wrap gap-x-4 gap-y-1 px-1">
            <span>Concrete qty: <b className="font-mono text-neutral-700">{cost.concreteQty.toFixed(2)} m³</b></span>
            <span>Materials: <b className="font-mono text-neutral-700">{money2(cost.materialsTotal)}</b></span>
            <span>Labour/Equipment: <b className="font-mono text-neutral-700">{money2(cost.labourTotal)}</b></span>
            <span>Custom items: <b className="font-mono text-neutral-700">{money2(cost.additionalTotal)}</b></span>
          </div>

          <div className="rounded-lg border border-neutral-200 bg-white p-3">
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-semibold mb-1">
              Element description / specification
            </div>
            <textarea
              value={item.description || ""}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Fully editable — spell out the spec: e.g. type of insulation (R2.5 XPS under slab), finish, concrete class notes, inclusions/exclusions…"
              className="w-full text-[13px] border border-neutral-200 rounded-md px-2 py-1.5 focus:outline-none focus:border-orange-400 resize-y"
            />
          </div>

          <div className="rounded-lg border border-neutral-200 bg-white p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-semibold flex items-center gap-1.5">
                <Paperclip size={12} /> Markup drawings {markups.length > 0 && <span className="text-orange-600">({markups.length})</span>}
              </div>
              <label className="cursor-pointer px-2.5 py-1 rounded-md bg-blue-950 hover:bg-blue-900 text-white text-[11px] font-semibold">
                Upload PDF / PNG / JPG
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                  multiple
                  className="hidden"
                  onChange={(e) => addMarkupFiles(e.target.files)}
                />
              </label>
            </div>
            {markups.length === 0 ? (
              <div className="text-[12px] text-neutral-400 italic">
                No markups attached — upload the marked-up drawing(s) this line item was measured from.
              </div>
            ) : (
              <div className="space-y-2">
                {markups.map((m) => (
                  <div key={m.id} className="border border-neutral-200 rounded-md overflow-hidden">
                    <div className="flex items-center justify-between px-2 py-1 bg-neutral-100 text-[11px]">
                      <span className="truncate font-medium text-neutral-700">{m.name}</span>
                      <button
                        onClick={() => removeMarkup(m.id)}
                        title="Remove markup"
                        className="flex-none text-neutral-400 hover:text-red-500 transition-colors ml-2"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    {m.type === "pdf" ? (
                      <embed src={m.dataURL} type="application/pdf" className="w-full h-96 bg-neutral-50" />
                    ) : (
                      <img src={m.dataURL} alt={m.name} className="block max-w-full max-h-96 object-contain bg-neutral-50 mx-auto" />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {FULL_CATALOG.map((cat) => (
            <CategoryBlock
              key={cat.key}
              cat={cat}
              item={item}
              rates={rates}
              onQtyChange={setQty}
              catOpen={openCats[cat.key]}
              toggleCat={() => setOpenCats((o) => ({ ...o, [cat.key]: !o[cat.key] }))}
              catTotal={cost.categoryTotals[cat.key]}
            />
          ))}

          <LabourMatrix
            item={item}
            rates={rates}
            onTaskQtyChange={setTaskQty}
            onAddTask={addTask}
            onRemoveTask={removeTask}
            onRenameTask={renameTask}
            resourceTotals={cost.resourceTotals}
            resourceCosts={cost.resourceCosts}
            labourTotal={cost.labourTotal}
            labourOpen={labourOpen}
            toggleLabour={() => setLabourOpen((o) => !o)}
          />

          <AdditionalItems
            item={item}
            rates={rates}
            onAdd={addAdditional}
            onRemove={removeAdditional}
            onChange={changeAdditional}
            onFill={fillAdditional}
            total={cost.additionalTotal}
          />
        </div>
      )}
    </div>
  );
}
