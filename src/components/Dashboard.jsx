import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, ArrowRight, LayoutDashboard, Loader2, FolderOpen, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { QUOTE_STATUSES, QUOTE_STATUS_STYLES } from "../data/catalog.js";
import { computeGrandTotal, computeMarginLadder, money, getDefaultMargin, getMarginSteps } from "../lib/costing.js";
import { readQuoteSummariesDetailed, readQuotesCached, patchQuoteFields } from "../lib/projects.js";
import { SummaryLoadNotice } from "./atoms.jsx";
import { dashboardDueLabel, formatDay, OPEN_STATUSES } from "../lib/planner.js";
import { effectiveRates, statusChangePatch, completedDay } from "../lib/rateFreeze.js";
import { PROJECT_SORTS, sortProjects, defaultSortDir, preferredSortKey } from "../lib/projectSort.js";
import RateValidityBanner from "./RateValidityBanner.jsx";

const OPEN_FILTER = "__open";   // the tile value for OPEN_STATUSES (lib/planner.js)

/** A column heading that sorts the table: click to sort by `sortKey` (its
 * own default direction), click again to flip. The active column carries
 * the direction arrow; every other one shows the faint sort glyph. */
function SortTh({ sortKey, label, align = "left", sort, onSort, className = "" }) {
  const active = sort.key === sortKey;
  const Icon = active ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : "text-left"} ${className}`} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-neutral-900 ${active ? "text-neutral-900" : ""}`}
        title={active ? `Sorted ${sort.dir === "asc" ? "ascending" : "descending"} — click to flip` : `Sort by ${label.toLowerCase()}`}
      >
        {label}
        <Icon size={11} className={active ? "text-orange-600" : "text-neutral-300"} />
      </button>
    </th>
  );
}

/** Turns one pre-fetched quote object into the numbers a dashboard row (or
 * the portfolio totals) needs. Mirrors the same costing calls
 * QuoteSummary.jsx uses so the figures always agree with what you'd see
 * inside the project itself. */
function summarizeQuote(quote, liveRates) {
  quote = quote || {};
  const items = quote.items || [];
  // A finished project costs off its own pinned rates, exactly as its editor does (lib/rateFreeze.js).
  const rates = effectiveRates(quote, liveRates);
  const directCost = computeGrandTotal(items, rates);
  const { subtotal, rows } = computeMarginLadder(
    directCost,
    quote.overheadPct ?? 0.08,
    quote.contingencyPct ?? 0.05,
    quote.gfa,
    getMarginSteps()
  );
  const defaultRow = rows.find((r) => Math.abs(r.margin - getDefaultMargin()) < 1e-9) || rows[0];
  return {
    name: quote.projectName || "Untitled project",
    client: quote.clientName || "",
    date: quote.projectDate,
    // Only a status the style table knows: the rows below index
    // QUOTE_STATUS_STYLES by this value, and one stale/renamed status in any
    // single quote would otherwise take the whole dashboard down.
    status: QUOTE_STATUSES.includes(quote.status) ? quote.status : QUOTE_STATUSES[0],
    deadline: quote.planner?.deadline || null,
    submittedAt: quote.submittedAt || null,
    completedAt: completedDay(quote),
    gfa: Number(quote.gfa) || 0,
    elementCount: items.length,
    directCost,
    subtotal,
    sellExGst: defaultRow?.sellExGst || 0,
    perM2: defaultRow?.perM2 || 0,
  };
}

function StatTile({ label, value, highlight }) {
  return (
    <div className={`rounded-xl border p-3 ${highlight ? "border-orange-200 bg-orange-50" : "border-neutral-200 bg-white"}`}>
      <div className="text-[10px] uppercase tracking-widest text-neutral-400 font-semibold">{label}</div>
      <div className={`font-mono tabular-nums text-lg font-bold ${highlight ? "text-orange-600" : "text-neutral-800"}`}>{value}</div>
    </div>
  );
}

export default function Dashboard({ projects, rates, onOpen, onCreate, onDelete, onImportFile, onPrune }) {
  // First paint comes from the last-known summary mirror (instant), then the
  // effect below replaces it with what the database actually holds. An
  // install without a mirror yet starts empty exactly as before.
  const [quotesByKey, setQuotesByKey] = useState(() => readQuotesCached(projects.map((p) => p.storageKey)));
  const [loading, setLoading] = useState(true);
  // Two-click "arm, then confirm" delete instead of window.confirm() — a
  // native confirm() dialog can be silently blocked (throws or is a no-op)
  // when this app is embedded in a sandboxed iframe, e.g. hosted inside
  // the portal shell inside an Artifact viewer, which made Delete appear
  // to do nothing. This has no dependency on any browser dialog API.
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const armDelete = (id) => {
    // Portal Settings "ask before deleting" toggle — explicitly off skips
    // the arm step and deletes on the first click.
    try {
      const p = JSON.parse(localStorage.getItem("gradcon-preferences")) || {};
      if (p.confirmDeletes === false) { onDelete(id); return; }
    } catch { /* fall through to the confirm flow */ }
    setConfirmDeleteId(id);
    setTimeout(() => setConfirmDeleteId((cur) => (cur === id ? null : cur)), 3000);
  };

  // Rows that could not be read this time (never treated as missing) and
  // the tick that re-runs the load when Retry is pressed.
  const [failedCount, setFailedCount] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    readQuoteSummariesDetailed(projects.map((p) => p.storageKey)).then(({ map, missing, failed }) => {
      if (cancelled) return;
      setQuotesByKey(map);
      setLoading(false);
      setFailedCount(failed.length);
      // An index entry whose data row does not exist is an "Untitled
      // project" that can never be opened or edited — a project whose first
      // save never landed, or a delete that only half-completed. Drop it.
      // ONLY entries the database confirmed have no row (`missing`: absent
      // from a successful stamp query). A row that merely could not be read
      // (a timeout, a network failure, an error) is in `failed` instead and
      // is never pruned. A brand-new entry is left alone for an hour so a
      // slow first save cannot be mistaken for an orphan.
      if (onPrune && missing.length > 0) {
        const cutoff = Date.now() - 60 * 60 * 1000;
        const orphans = projects
          .filter((p) => missing.includes(p.storageKey) && Date.parse(p.createdAt || 0) < cutoff)
          .map((p) => p.id);
        if (orphans.length) onPrune(orphans);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projects, reloadTick]);

  const summaries = useMemo(
    () => projects.map((p) => ({ project: p, ...summarizeQuote(quotesByKey[p.storageKey], rates) })),
    [projects, quotesByKey, rates]
  );

  // Sort: the ONE rule in lib/projectSort.js (shared with Project Management
  // and the Vault). Initial key from the portal Settings preference, opening
  // on that key's own direction; session-local after that. The "Sort by"
  // select, the direction button and every column heading all drive it.
  const [sort, setSort] = useState(() => {
    let key = "added";
    try { key = preferredSortKey(JSON.parse(localStorage.getItem("gradcon-preferences")) || {}); } catch { /* default */ }
    return { key, dir: defaultSortDir(key) };
  });
  const sortBy = sort.key;
  const chooseSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultSortDir(key) }));
  const sortedSummaries = useMemo(() => sortProjects(summaries, sort.key, sort.dir), [summaries, sort]);

  // Filter row: status tiles + free-text name search, applied on top of the
  // chosen sort. Session-local. A fresh load shows ONLY the open work —
  // Queued and Estimating — so a quote that has gone out leaves the main
  // screen and lives under its own status tile (or "All projects"); Grady,
  // 1 Oct 2026: "submitted quotes should leave the main screen and remain
  // under the submitted button so only queued and estimating projects are
  // visible upon opening … one should be able to filter all to see those".
  const [statusFilter, setStatusFilter] = useState(OPEN_FILTER);
  const [search, setSearch] = useState("");
  const matchesStatus = (s) => (statusFilter === OPEN_FILTER ? OPEN_STATUSES.includes(s.status) : !statusFilter || s.status === statusFilter);
  const visibleSummaries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sortedSummaries.filter(
      (s) => matchesStatus(s) && (!q || s.name.toLowerCase().includes(q) || s.client.toLowerCase().includes(q))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedSummaries, statusFilter, search]);
  const filtering = !!statusFilter || !!search.trim();
  // One count per status, off the SEARCHED set rather than the fully filtered
  // one — so the buttons show how many projects each status would give you
  // right now, and a status with none reads as 0 instead of vanishing.
  const statusCounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const searched = sortedSummaries.filter(
      (s) => !q || s.name.toLowerCase().includes(q) || s.client.toLowerCase().includes(q)
    );
    const counts = { "": searched.length, [OPEN_FILTER]: searched.filter((s) => OPEN_STATUSES.includes(s.status)).length };
    QUOTE_STATUSES.forEach((st) => { counts[st] = 0; });
    searched.forEach((s) => { counts[s.status] = (counts[s.status] || 0) + 1; });
    return counts;
  }, [sortedSummaries, search]);

  const changeStatus = (project, status) => {
    const quote = quotesByKey[project.storageKey] || {};
    // The same status rule as the editor's select: moving into a finished
    // status pins today's rates on the project, moving back out unpins it.
    const patch = statusChangePatch(quote, status, rates);
    const updated = { ...quote, ...patch };
    setQuotesByKey((m) => ({ ...m, [project.storageKey]: updated }));
    patchQuoteFields(project.storageKey, patch); // field merge: the summary copy here has no drawing data and must never be written whole
  };

  // The project's client/owner is edited HERE, beside the project name —
  // the dashboard is where projects get scanned by who they belong to, so
  // it isn't duplicated in the project editor's own header. Same
  // optimistic-local-then-write path as the status dropdown above.
  const changeClient = (project, clientName) => {
    const quote = quotesByKey[project.storageKey] || {};
    const updated = { ...quote, clientName };
    setQuotesByKey((m) => ({ ...m, [project.storageKey]: updated }));
    patchQuoteFields(project.storageKey, { clientName });
  };

  const totals = useMemo(
    () =>
      summaries.reduce(
        (acc, s) => ({
          directCost: acc.directCost + s.directCost,
          sellExGst: acc.sellExGst + s.sellExGst,
          gfa: acc.gfa + s.gfa,
          elementCount: acc.elementCount + s.elementCount,
        }),
        { directCost: 0, sellExGst: 0, gfa: 0, elementCount: 0 }
      ),
    [summaries]
  );

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
            <LayoutDashboard size={20} className="text-orange-500" /> Projects Dashboard
          </h1>
          <p className="text-sm text-neutral-500">Every Gradcon quote, summed across the whole portfolio.</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects / clients…"
            className="border border-neutral-200 rounded px-2.5 py-1.5 text-xs w-44 focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
          <div className="flex items-center gap-1.5 text-xs text-neutral-500">
            <span>Sort by:</span>
            <select
              value={sortBy}
              onChange={(e) => setSort({ key: e.target.value, dir: defaultSortDir(e.target.value) })}
              className="border border-neutral-200 rounded px-2 py-1 text-xs"
            >
              {PROJECT_SORTS.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setSort((s) => ({ ...s, dir: s.dir === "asc" ? "desc" : "asc" }))}
              className="inline-flex items-center gap-1 border border-neutral-200 rounded px-2 py-1 text-xs hover:bg-neutral-50"
              title={sort.dir === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
              aria-label="Sort direction"
            >
              {sort.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
              {sort.dir === "asc" ? "Asc" : "Desc"}
            </button>
          </div>
          {onImportFile && (
            <label
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-neutral-300 bg-white hover:bg-neutral-50 text-neutral-700 text-sm font-medium transition-colors cursor-pointer"
              title="Open a quote saved with “Save to computer” or downloaded from a project's Versions"
            >
              <FolderOpen size={16} /> Open .json
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files && e.target.files[0];
                  e.target.value = "";
                  if (!file) return;
                  file.text().then((text) => onImportFile(text, file.name));
                }}
              />
            </label>
          )}
          <button
            onClick={onCreate}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-950 hover:bg-blue-900 text-white text-sm font-medium transition-colors"
          >
            <Plus size={16} /> New project
          </button>
        </div>
      </div>
      <SummaryLoadNotice failedCount={failedCount} onRetry={() => setReloadTick((t) => t + 1)} />
      <RateValidityBanner rates={rates} />

      {/* Status filter tiles — one per status plus All projects. Each tile is
          FILLED with its status's own solid colour (the same `bar` shade the
          row dots use), not a white chip with coloured text, so the row reads
          as the pipeline at a glance. The count is the tile's headline.
          Clicking one filters the table below to just those projects;
          clicking the active one again clears back to all. The active tile is
          marked by a dark ring and shadow rather than by a colour change —
          colour is spoken for by the status itself. */}
      <div className="flex flex-wrap gap-2">
        {[[OPEN_FILTER, "Open — Queued & Estimating"], ["", "All projects"], ...QUOTE_STATUSES.map((s2) => [s2, s2])].map(([value, label]) => {
          const active = statusFilter === value;
          // "All projects" and the Open tile have no catalog status colour —
          // the app's own navy (All) and the Estimating orange's darker
          // sibling (Open) so the row reads as one set rather than odd tiles.
          const style = QUOTE_STATUS_STYLES[value] || (value === OPEN_FILTER
            ? { bar: "bg-orange-700", dot: "bg-orange-700", text: "text-orange-900", bg: "bg-orange-50" }
            : { bar: "bg-blue-950", dot: "bg-blue-950", text: "text-blue-900", bg: "bg-blue-50" });
          // Every status bar is dark enough to carry white text except On
          // Hold's deliberately washed-out neutral — that one needs dark ink.
          const light = style.bar === "bg-neutral-300";
          const ink = light ? "text-neutral-800" : "text-white";
          const count = statusCounts[value] || 0;
          return (
            <button
              key={value || "__all"}
              onClick={() => setStatusFilter(active ? (value === "" ? OPEN_FILTER : "") : value)}
              aria-pressed={active}
              title={`${label} — ${count} project${count === 1 ? "" : "s"}`}
              className={`relative overflow-hidden flex-1 min-w-[112px] max-w-[168px] min-h-[92px] rounded-xl border border-transparent flex flex-col items-center justify-center gap-1.5 px-3 py-3 transition-all ${style.bar} ${ink} ${
                active
                  ? "shadow-lg ring-2 ring-offset-2 ring-blue-950 scale-[1.03]"
                  : `shadow-sm hover:brightness-110 hover:shadow-md ${count === 0 ? "opacity-50" : ""}`
              }`}
            >
              {/* a soft wash behind the count, so the headline number reads as
                  a badge rather than floating on the flat fill */}
              <span
                className={`inline-flex items-center justify-center min-w-[2.25rem] px-2 py-0.5 rounded-lg font-mono tabular-nums text-2xl font-bold leading-none ${
                  light ? "bg-white/70" : "bg-black/20"
                }`}
              >
                {count}
              </span>
              <span className="text-[11px] font-semibold leading-tight text-center">{label}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Projects" value={summaries.length} />
        <StatTile label="Total direct cost" value={money(totals.directCost)} />
        <StatTile
          label={`Total sell (${Math.round(getDefaultMargin() * 100)}% margin, ex GST)`}
          value={money(totals.sellExGst)}
          highlight
        />
        <StatTile label="Total GFA" value={`${totals.gfa.toLocaleString("en-AU")} m²`} />
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-neutral-50 text-neutral-500 text-[11px] uppercase tracking-wide">
              <th className="px-3 py-2" />
              <SortTh sortKey="name" label="Project" sort={sort} onSort={chooseSort} className="!px-4" />
              <SortTh sortKey="client" label="Client" sort={sort} onSort={chooseSort} />
              <SortTh sortKey="date" label="Date" sort={sort} onSort={chooseSort} />
              <SortTh sortKey="deadline" label="Deadline" sort={sort} onSort={chooseSort} />
              <SortTh sortKey="completed" label="Completed" sort={sort} onSort={chooseSort} />
              <SortTh sortKey="status" label="Status" sort={sort} onSort={chooseSort} />
              <SortTh sortKey="elements" label="Elements" align="right" sort={sort} onSort={chooseSort} />
              <SortTh sortKey="cost" label="Direct cost" align="right" sort={sort} onSort={chooseSort} />
              <SortTh sortKey="value" label={`Sell (${Math.round(getDefaultMargin() * 100)}%, ex GST)`} align="right" sort={sort} onSort={chooseSort} />
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {visibleSummaries.map(({ project, ...s }) => (
              <tr
                key={project.id}
                className="border-t border-neutral-100 hover:bg-neutral-50 cursor-pointer"
                onClick={() => onOpen(project.id)}
              >
                <td className="pl-4 pr-1 py-3">
                  <span
                    className={`inline-block w-3.5 h-3.5 rounded-full flex-none ${QUOTE_STATUS_STYLES[s.status].dot}`}
                    title={s.status}
                  />
                </td>
                <td className="px-4 py-3 font-semibold text-[15px] text-neutral-900">{s.name}</td>
                <td className="px-3 py-2.5">
                  <input
                    value={s.client}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => changeClient(project, e.target.value)}
                    placeholder="+ client"
                    title="Client / owner — click to edit"
                    className="w-full bg-transparent border-0 text-sm text-neutral-600 focus:outline-none focus:underline decoration-orange-400 placeholder:text-neutral-300"
                  />
                </td>
                <td className="px-3 py-2.5 text-neutral-400 text-xs">{s.date || "—"}</td>
                <td className="px-3 py-2.5 text-xs">
                  {(() => {
                    const due = dashboardDueLabel(s.deadline, s.status, s.submittedAt);
                    return due ? <span className={due.cls} title={due.title || undefined}>{due.text}</span> : <span className="text-neutral-300">—</span>;
                  })()}
                </td>
                <td className="px-3 py-2.5 text-xs text-neutral-500 whitespace-nowrap" title={s.completedAt ? "The day estimating finished" : undefined}>
                  {s.completedAt ? formatDay(s.completedAt) : <span className="text-neutral-300">—</span>}
                </td>
                <td className="px-3 py-2.5">
                  <select
                    value={s.status}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => changeStatus(project, e.target.value)}
                    className={`bg-transparent border-0 rounded px-1 py-1 text-xs font-medium ${QUOTE_STATUS_STYLES[s.status].text}`}
                  >
                    {QUOTE_STATUSES.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-neutral-400 text-xs">{s.elementCount}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-neutral-500">{money(s.directCost)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-orange-600 font-semibold">
                  {money(s.sellExGst)}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(project.id);
                      }}
                      className="p-1.5 rounded hover:bg-neutral-200 text-neutral-500"
                      title="Open"
                    >
                      <ArrowRight size={14} />
                    </button>
                    {confirmDeleteId === project.id ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(null);
                          onDelete(project.id);
                        }}
                        className="px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white text-[11px] font-semibold whitespace-nowrap"
                        title="Click again to permanently delete"
                      >
                        Confirm delete?
                      </button>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          armDelete(project.id);
                        }}
                        className="p-1.5 rounded hover:bg-red-100 text-neutral-400 hover:text-red-600"
                        title="Delete project"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {summaries.length === 0 && loading && (
              <tr>
                <td colSpan={11} className="text-center py-12 text-neutral-400">
                  <Loader2 size={16} className="inline animate-spin mr-1.5" /> Loading projects…
                </td>
              </tr>
            )}
            {summaries.length === 0 && !loading && (
              <tr>
                <td colSpan={11} className="text-center py-12 text-neutral-400">
                  No projects yet — click &quot;New project&quot; to start your first quote.
                </td>
              </tr>
            )}
            {summaries.length > 0 && visibleSummaries.length === 0 && (
              <tr>
                <td colSpan={11} className="text-center py-12 text-neutral-400">
                  No projects match the current search/filter.
                </td>
              </tr>
            )}
          </tbody>
          {summaries.length > 0 && (() => {
            // Footer follows the filter: sums what's actually listed, and says so.
            const ft = filtering
              ? visibleSummaries.reduce(
                  (acc, s) => ({
                    directCost: acc.directCost + s.directCost,
                    sellExGst: acc.sellExGst + s.sellExGst,
                    gfa: acc.gfa + s.gfa,
                    elementCount: acc.elementCount + s.elementCount,
                  }),
                  { directCost: 0, sellExGst: 0, gfa: 0, elementCount: 0 }
                )
              : totals;
            return (
            <tfoot>
              <tr className="border-t-2 border-neutral-200 bg-neutral-50 font-semibold">
                <td className="px-4 py-2.5" colSpan={7}>
                  {statusFilter === OPEN_FILTER && !search.trim()
                    ? `Open projects — Queued & Estimating (${visibleSummaries.length} of ${summaries.length}; the rest are under their status tiles or All projects)`
                    : filtering ? `Filtered projects (${visibleSummaries.length} of ${summaries.length})` : "All projects"}
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">{ft.elementCount}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">{money(ft.directCost)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-orange-600">{money(ft.sellExGst)}</td>
                <td />
              </tr>
            </tfoot>
            );
          })()}
        </table>
      </div>
    </div>
  );
}
