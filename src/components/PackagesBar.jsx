/**
 * Packages within a project (lib/packages.js — Grady, 4 Nov 2026): the bar
 * that splits a project into packages and adds more, and the band that heads
 * each package's elements in the editor column — its name (typed in place),
 * its element count, direct cost and sell, its own margin (blank = the
 * project's), ▲ ▼ and remove (two clicks; the elements move to the first
 * remaining package, never lost). Nothing here prices anything itself.
 */
import { useState } from "react";
import { Plus, ArrowUp, ArrowDown, X, Boxes, ChevronDown, ChevronRight } from "lucide-react";
import { money, pinnedMargin, projectMargin } from "../lib/costing.js";
import { packageName, packageColour, inkFor } from "../lib/packages.js";
import { PctInput } from "./atoms.jsx";

const pctLabel = (f) => `${Math.round((Number(f) || 0) * 1000) / 10}%`;

export function PackagesBar({ packages, totals, onAdd, quote }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const submit = () => { onAdd(name); setName(""); setAdding(false); };
  return (
    <div className="flex flex-wrap items-center gap-2 bg-white border border-neutral-200 rounded-xl px-3 py-2 shadow-sm text-[12px]" data-testid="packages-bar">
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-neutral-500 font-semibold"><Boxes size={12} /> Packages</span>
      {packages.length === 0 && <span className="text-neutral-500">none — the project is priced as one job.</span>}
      {packages.map((p) => { const t = (totals || []).find((x) => x.id === p.id); return (
        <a key={p.id} href={`#package-${p.id}`} className="inline-flex items-center gap-1.5 rounded-full border-2 bg-neutral-50 hover:bg-neutral-100 px-2.5 py-0.5 text-neutral-800" style={{ borderColor: packageColour(quote, p) }} data-testid="package-chip" data-package={p.id} title="Jump to this package's elements">
          <span className="inline-block w-2.5 h-2.5 rounded-full flex-none" style={{ background: packageColour(quote, p) }} />
          <span className="font-medium">{packageName(p)}</span>
          {t && <span className="font-mono tabular-nums text-neutral-500">{t.count} · {money(t.cost)}</span>}
        </a>
      ); })}
      {adding ? (
        <span className="inline-flex items-center gap-1">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") { setAdding(false); setName(""); } }} placeholder={packages.length ? "Package name, e.g. Pool & surrounds" : "Name the first package, e.g. Main residence"} className="border border-neutral-300 rounded px-2 py-1 text-[12px] w-64" data-testid="package-name-input" />
          <button type="button" onClick={submit} className="px-2 py-1 rounded bg-orange-600 hover:bg-orange-700 text-white text-[12px] font-semibold" data-testid="package-add-confirm">Add</button>
          <button type="button" onClick={() => { setAdding(false); setName(""); }} className="px-2 py-1 rounded border border-neutral-300 text-[12px]">Cancel</button>
        </span>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-neutral-300 hover:bg-neutral-50 text-[12px] font-medium" data-testid="package-add" title={packages.length ? "Add another package to this project" : "Split this project into packages — every element goes into the first one, then move elements between packages from their cards"}>
          <Plus size={12} /> {packages.length ? "Add package" : "Split into packages"}
        </button>
      )}
      {packages.length > 0 && <span className="ml-auto text-[11px] text-neutral-400">The package sums add up to the project. The Tender Quote prints them combined or one by one.</span>}
    </div>
  );
}

export function PackageBand({ pkg, quote, totals, index, count, onRename, onRemove, onMove, onMargin, onColour, collapsed = false, onToggle }) {
  const [confirm, setConfirm] = useState(false);
  const pm = projectMargin(quote || {});
  const pinned = pkg ? pinnedMargin(pkg.marginPct) : null;
  // the package's own colour (lib/packages.js) and a text ink that reads on it; the band is taller than an element's band
  const colour = packageColour(quote, pkg); const ink = inkFor(colour); const faint = ink === "#ffffff" ? "rgba(255,255,255,0.75)" : "rgba(0,0,0,0.6)";
  return (
    <div id={pkg ? `package-${pkg.id}` : undefined} data-band="category" className="rounded-xl px-5 py-4 min-h-[6rem] flex flex-wrap items-center gap-x-4 gap-y-1.5 shadow-md scroll-mt-24" style={{ background: colour, color: ink }} data-testid="package-band" data-package={pkg ? pkg.id : ""} data-collapsed={collapsed ? "1" : "0"} data-colour={colour}>
      {onToggle && <button type="button" onClick={onToggle} className="flex-none p-0.5 rounded hover:bg-black/10" title={collapsed ? "Unfold this package" : "Fold this package"} aria-label={collapsed ? "Unfold package" : "Fold package"} aria-expanded={!collapsed} data-testid="package-fold">{collapsed ? <ChevronRight size={20} /> : <ChevronDown size={20} />}</button>}
      <span className="text-[10px] uppercase tracking-widest font-semibold flex-none" style={{ color: faint }}>{pkg ? "Package" : "Unassigned"}</span>
      {pkg
        ? <input value={pkg.name || ""} onChange={(e) => onRename(e.target.value)} placeholder="Package name" className="flex-1 min-w-[10rem] bg-transparent border-b border-current/40 focus:border-current focus:outline-none font-bold text-[22px] placeholder:opacity-60" style={{ color: ink }} aria-label="Package name" data-testid="package-name" />
        : <span className="flex-1 min-w-[10rem] text-[13px]" style={{ color: faint }}>elements not in any package — pick one on each card</span>}
      {totals && (
        <span className="flex-none text-[12.5px] font-mono tabular-nums" style={{ color: faint }} title="Elements · direct cost · sell ex GST at the package's margins" data-testid="package-totals">
          {totals.count} element{totals.count === 1 ? "" : "s"} · {money(totals.cost)} · sells <b style={{ color: ink }}>{money(totals.sell)}</b>{collapsed ? " · folded" : ""}
        </span>
      )}
      {pkg && onMargin && (
        <label className="flex-none flex items-center gap-1 text-[10px] uppercase tracking-widest" style={{ color: faint }} title="This package's margin — its elements inherit it unless pinned at their own rate; blank = the project margin">
          <span>Margin</span>
          <PctInput value={pinned ?? undefined} placeholder={pctLabel(pm)} onChange={(v) => onMargin(v)} className="!w-14 !py-0 !text-[11px] !bg-white/90 !border-transparent !text-neutral-900" data-testid="package-margin-input" />
        </label>
      )}
      {pkg && onColour && (
        <label className="flex-none flex items-center gap-1 text-[10px] uppercase tracking-widest cursor-pointer" style={{ color: faint }} title="This package's colour — on its band, its chip, its element cards, the rail, the tender and the prints">
          <span>Colour</span>
          <input type="color" value={colour} onChange={(e) => onColour(e.target.value)} className="w-6 h-6 rounded border border-white/50 bg-transparent cursor-pointer" aria-label="Package colour" data-testid="package-colour" />
        </label>
      )}
      {pkg && (
        <span className="flex-none flex items-center gap-0.5">
          <button type="button" onClick={() => onMove(-1)} disabled={index <= 0} className="p-1 rounded hover:bg-black/15 disabled:opacity-30" title="Move this package up" aria-label="Move package up"><ArrowUp size={13} /></button>
          <button type="button" onClick={() => onMove(1)} disabled={index >= count - 1} className="p-1 rounded hover:bg-black/15 disabled:opacity-30" title="Move this package down" aria-label="Move package down"><ArrowDown size={13} /></button>
          {confirm
            ? <span className="inline-flex items-center gap-1 text-[11px] ml-1"><span className="font-semibold">Remove? Its elements move to {count > 1 ? "the first remaining package" : "the project (no packages left)"}.</span><button type="button" onClick={() => { setConfirm(false); onRemove(); }} className="px-1.5 py-0.5 rounded bg-red-600 hover:bg-red-700 text-white font-semibold" data-testid="package-remove-confirm">Remove</button><button type="button" onClick={() => setConfirm(false)} className="px-1.5 py-0.5 rounded border border-current/50">Keep</button></span>
            : <button type="button" onClick={() => setConfirm(true)} className="p-1 rounded hover:bg-black/15 opacity-80 hover:opacity-100" title="Remove this package (its elements are kept)" aria-label="Remove package" data-testid="package-remove"><X size={13} /></button>}
        </span>
      )}
    </div>
  );
}
