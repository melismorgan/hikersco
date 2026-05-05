'use client';

import { useMemo, useState } from 'react';
import type { ApparelDashboardRow, DraftPoSummary } from '@/lib/inventory';
import { lineOrderIndex } from '@/lib/line-order';
import { splitDraft } from '@/lib/policy';
import { useDrafts } from '@/lib/use-drafts';
import type { DraftPushLine } from '@/app/pos/actions';
import { DraftSummaryBar } from './DraftSummaryBar';

interface Props {
  rows: ApparelDashboardRow[];
  /** Plain object map of Style → Line (e.g. H503 → "Upfitter"). Drives line banners. */
  styleLineMap: Record<string, string>;
  /** Style → Supplier (e.g. Billfold → "Pacific Wallet Co"). Drives multi-vendor PO splits. */
  styleSupplierMap: Record<string, string>;
  /** Existing Draft POs the user can append to from the push picker. */
  existingDrafts: DraftPoSummary[];
}

/**
 * Apparel dashboard grid.
 *
 * Identity columns (Style, Color, SKU, Size) are sticky-left so they stay
 * visible when scrolling horizontally on mobile. Each Line group (HIKERS,
 * Upfitter, Deluxe, etc.) gets a banner row separating it from the next.
 *
 * Rollup is ON by default: one row per Style+Color with summed numbers,
 * click the chevron to expand and see individual sizes inline.
 */
export function ApparelGrid({ rows: allRows, styleLineMap, styleSupplierMap, existingDrafts }: Props) {
  const [query, setQuery] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [rollup, setRollup] = useState(true); // default ON
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { drafts, setDraft, clearDrafts } = useDrafts();

  // Pre-compute line for each row, then re-sort so lines appear in canonical
  // HIKERS Co. order (Upfitter before Deluxe before Heavy-Duty etc.) rather
  // than alphabetical. Within a line, preserve the server-side Style →
  // Active → Color → Size_Order ordering by using a stable sort.
  const rowsWithLine = useMemo(() => {
    const rows = allRows.map((r) => ({ ...r, line: styleLineMap[r.style] || r.style }));
    // Stable sort: items that compare equal on line keep their server order.
    return rows
      .map((row, idx) => ({ row, idx }))
      .sort((a, b) => {
        const aLi = lineOrderIndex(a.row.line);
        const bLi = lineOrderIndex(b.row.line);
        if (aLi !== bLi) return aLi - bLi;
        if (a.row.line !== b.row.line) return a.row.line.localeCompare(b.row.line);
        return a.idx - b.idx;
      })
      .map(({ row }) => row);
  }, [allRows, styleLineMap]);

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rowsWithLine.filter((r) => {
      if (activeOnly && !r.active) return false;
      if (!q) return true;
      return (
        r.sku.toLowerCase().includes(q) ||
        r.style.toLowerCase().includes(q) ||
        r.color.toLowerCase().includes(q) ||
        r.size.toLowerCase().includes(q) ||
        r.line.toLowerCase().includes(q)
      );
    });
  }, [rowsWithLine, query, activeOnly]);

  const groups = useMemo(() => groupByStyleColor(visibleRows), [visibleRows]);

  if (allRows.length === 0) {
    return (
      <div className="rounded-lg border border-warm-gray/60 bg-warm-beige/40 p-8 text-center">
        <p className="text-charcoal/70">
          No apparel SKUs found. Check that <code className="px-1 bg-warm-white rounded">Category</code>{' '}
          equals <code className="px-1 bg-warm-white rounded">Apparel</code> in SKU Master.
        </p>
      </div>
    );
  }

  const toggleGroup = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const expandAll   = () => setExpanded(new Set(groups.map((g) => g.key)));
  const collapseAll = () => setExpanded(new Set());

  // Walk groups inserting a banner whenever the line changes. Used by both
  // rollup and flat modes (flat just expands every group inline).
  // Compute draft aggregates (per-row policy split, then summed) for the
  // top summary bar. Only count drafts whose SKU exists in the current
  // active-filtered row set — drafts on now-inactive SKUs stay in
  // localStorage but don't surface here.
  const draftAggregates = useMemo(() => {
    const indexed = new Map(rowsWithLine.map((r) => [r.sku, r] as const));
    let distinctSkus = 0;
    let gross = 0;
    let amzTotal = 0;
    let sbTotal = 0;
    let estCost = 0;
    const lines: DraftPushLine[] = [];
    for (const [sku, qty] of Object.entries(drafts)) {
      if (!(qty > 0)) continue;
      const r = indexed.get(sku);
      if (!r) continue;  // stale draft — SKU disappeared from sheet
      const split = splitDraft({
        qty,
        hasFbaSku: r.hasFbaSku,
        avgPerDay30d: r.avgPerDay30d,
        amazonTotal: r.amazonTotal,
      });
      distinctSkus += 1;
      gross += qty;
      amzTotal += split.amz;
      sbTotal += split.sb;
      estCost += split.total * r.unitCost;
      lines.push({
        sku, qty,
        unitCost: r.unitCost,
        hasFbaSku: r.hasFbaSku,
        avgPerDay30d: r.avgPerDay30d,
        amazonTotal: r.amazonTotal,
        supplier: styleSupplierMap[r.style],
      });
    }
    return { distinctSkus, gross, amzTotal, sbTotal, estCost, lines };
  }, [drafts, rowsWithLine, styleSupplierMap]);

  const items: Array<{ kind: 'banner'; line: string } | { kind: 'group'; group: GroupT; tint: number }> = [];
  let lastLine: string | null = null;
  let groupTintIdx = 0;
  for (const g of groups) {
    const line = g.rows[0]?.line ?? g.style;
    if (line !== lastLine) {
      items.push({ kind: 'banner', line });
      lastLine = line;
      groupTintIdx = 0;
    }
    items.push({ kind: 'group', group: g, tint: groupTintIdx % 2 });
    groupTintIdx++;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <input
          type="text"
          placeholder="Search SKU, Style, Color, Size, Line…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 min-w-[200px] max-w-md px-3 py-2 rounded-md border border-warm-gray/60 bg-warm-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo/40 focus:border-indigo/60"
        />
        <label className="flex items-center gap-2 text-sm text-charcoal/70 select-none cursor-pointer">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-indigo" />
          Active only
        </label>
        <label className="flex items-center gap-2 text-sm text-charcoal/70 select-none cursor-pointer">
          <input type="checkbox" checked={rollup} onChange={(e) => setRollup(e.target.checked)} className="accent-indigo" />
          Group by Style+Color
        </label>
        {rollup && (
          <div className="flex items-center gap-3 text-xs text-charcoal/60">
            <button onClick={expandAll}   className="hover:text-indigo">Expand all</button>
            <span className="text-warm-gray">·</span>
            <button onClick={collapseAll} className="hover:text-indigo">Collapse all</button>
          </div>
        )}
        <span className="text-xs text-charcoal/50">
          {groups.length} {groups.length === 1 ? 'family' : 'families'} · {visibleRows.length} SKUs
        </span>
      </div>

      {draftAggregates.distinctSkus > 0 && (
        <DraftSummaryBar agg={draftAggregates} onClear={clearDrafts} existingDrafts={existingDrafts} />
      )}

      <div className="rounded-lg border border-warm-gray/40 bg-warm-white">
        <div className="dash-scroll">
          <table className="dash-table text-sm border-separate border-spacing-0" style={{ minWidth: '100%' }}>
            <thead>
              {/* Single-row header. Column groups are conveyed via alternating
                  background shades on the header cells (warm-tint vs the base
                  periwinkle gray) plus vertical dividers on the body. */}
              <tr className="text-charcoal/80 text-xs uppercase tracking-wider">
                <Th tone="header" className="sticky-sku font-mono whitespace-nowrap">SKU</Th>
                <Th className="text-right bg-warm-tint border-l border-warm-gray/50" title="ShipBob WI">ShipBob</Th>
                <Th className="text-right text-charcoal/50 bg-warm-tint">Indiv</Th>
                <Th className="text-right text-charcoal/50 bg-warm-tint">Case</Th>
                <Th className="text-right bg-[#E6E6E8] border-l border-warm-gray/50" title="Amazon">Amazon</Th>
                <Th className="text-right bg-[#E6E6E8]">FBA</Th>
                <Th className="text-right bg-[#E6E6E8]">AWD</Th>
                <Th className="text-right bg-warm-tint border-l border-warm-gray/50" title="Incoming POs (Air freight)">Air</Th>
                <Th className="text-right bg-warm-tint">Sea</Th>
                <Th className="text-left bg-warm-tint" title="Soonest Incoming PO arrival → projected total on hand at that date. Hover a cell for the full schedule.">Next ETA</Th>
                <Th className="text-right bg-warm-tint" title="Draft POs already in the POs tab awaiting finalize">Pend</Th>
                <Th className="text-right bg-[#E6E6E8] border-l border-warm-gray/50" title="New draft qty — editable, persists locally until you push to POs">Draft</Th>
                <Th className="text-right bg-[#E6E6E8]" title="Plan total = Hand + Incoming + Pend + Draft input. Hover any cell for the breakdown.">Total</Th>
                <Th className="text-right bg-[#E6E6E8]">Avg/Day</Th>
                <Th className="text-right bg-[#E6E6E8]">Cover</Th>
                <Th className="text-right bg-[#E6E6E8]">$ On Hand</Th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={16} className="text-center text-charcoal/60 py-8">No matches.</td></tr>
              )}
              {items.map((item, i) => {
                if (item.kind === 'banner') {
                  return <BannerRow key={`b-${i}-${item.line}`} line={item.line} />;
                }
                const { group, tint } = item;
                return (
                  <GroupRows
                    key={group.key}
                    group={group}
                    tint={tint}
                    open={!rollup || expanded.has(group.key)}
                    showSummary={rollup}
                    onToggle={() => toggleGroup(group.key)}
                    drafts={drafts}
                    setDraft={setDraft}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---- Banner row -------------------------------------------------------------

function BannerRow({ line }: { line: string }) {
  return (
    <tr>
      <td
        colSpan={16}
        className="bg-indigo text-warm-white px-3 py-2 font-display text-sm tracking-wide uppercase sticky"
        style={{ left: 0, zIndex: 5 }}
      >
        {line}
      </td>
    </tr>
  );
}

// ---- Group rendering --------------------------------------------------------

type RowWithLine = ApparelDashboardRow & { line: string };

interface GroupT {
  key: string;
  style: string;
  color: string;
  rows: RowWithLine[];
  agg: GroupAggregates;
}

interface GroupAggregates {
  shipbobWiTotal: number;
  indivOnHand: number;
  casePackEqv: number;
  fbaAvailable: number;
  awdStorage: number;
  amazonTotal: number;
  inTransitAir: number;
  inTransitSea: number;
  draftPo: number;
  totalOnHand: number;
  avgPerDay30d: number;
  daysCover: number | null;
  valueOnHand: number;
  inactiveCount: number;
  totalCount: number;
}

function groupByStyleColor(rows: RowWithLine[]): GroupT[] {
  const map = new Map<string, GroupT>();
  for (const r of rows) {
    const key = `${r.style}::${r.color}`;
    if (!map.has(key)) {
      map.set(key, { key, style: r.style, color: r.color, rows: [], agg: emptyAgg() });
    }
    const g = map.get(key)!;
    g.rows.push(r);
    const a = g.agg;
    a.shipbobWiTotal += r.shipbobWiTotal;
    a.indivOnHand    += r.indivOnHand;
    a.casePackEqv    += r.casePackEqv;
    a.fbaAvailable   += r.fbaAvailable;
    a.awdStorage     += r.awdStorage;
    a.amazonTotal    += r.amazonTotal;
    a.inTransitAir   += r.inTransitAir;
    a.inTransitSea   += r.inTransitSea;
    a.draftPo        += r.draftPo;
    a.totalOnHand    += r.totalOnHand;
    a.avgPerDay30d   += r.avgPerDay30d;
    a.valueOnHand    += r.valueOnHand;
    a.totalCount     += 1;
    if (!r.active) a.inactiveCount += 1;
  }
  for (const g of map.values()) {
    const supply = g.agg.totalOnHand + g.agg.inTransitAir + g.agg.inTransitSea + g.agg.draftPo;
    g.agg.daysCover = g.agg.avgPerDay30d > 0 ? supply / g.agg.avgPerDay30d : null;
    g.rows.sort((a, b) => (a.sizeOrder || 99) - (b.sizeOrder || 99));
  }
  return Array.from(map.values());
}

function emptyAgg(): GroupAggregates {
  return {
    shipbobWiTotal: 0, indivOnHand: 0, casePackEqv: 0,
    fbaAvailable: 0, awdStorage: 0, amazonTotal: 0,
    inTransitAir: 0, inTransitSea: 0, draftPo: 0,
    totalOnHand: 0, avgPerDay30d: 0, daysCover: null,
    valueOnHand: 0, inactiveCount: 0, totalCount: 0,
  };
}

function GroupRows({ group, tint, open, showSummary, onToggle, drafts, setDraft }: {
  group: GroupT; tint: number; open: boolean; showSummary: boolean; onToggle: () => void;
  drafts: Record<string, number>;
  setDraft: (sku: string, qty: number) => void;
}) {
  const tintClass = tint === 0 ? 'bg-warm-white' : 'bg-warm-tint';
  const a = group.agg;

  // Family-level "plan total" — sum of each row's plan total (current Hand
  // + Air + Sea + Pend + the policy-applied draft qty). Reactive to drafts.
  const familyDraftSplitTotal = group.rows.reduce((sum, row) => {
    const dq = drafts[row.sku] ?? 0;
    if (dq <= 0) return sum;
    const s = splitDraft({
      qty: dq,
      hasFbaSku: row.hasFbaSku,
      avgPerDay30d: row.avgPerDay30d,
      amazonTotal: row.amazonTotal,
    });
    return sum + s.total;
  }, 0);
  const familyPlanTotal = a.totalOnHand + a.inTransitAir + a.inTransitSea + a.draftPo + familyDraftSplitTotal;
  const familyTotalBreakdown = `Hand ${a.totalOnHand.toLocaleString()}`
    + ` · Air ${a.inTransitAir.toLocaleString()}`
    + ` · Sea ${a.inTransitSea.toLocaleString()}`
    + ` · Pend ${a.draftPo.toLocaleString()}`
    + (familyDraftSplitTotal > 0 ? ` · Draft +${familyDraftSplitTotal.toLocaleString()}` : '')
    + ` = ${familyPlanTotal.toLocaleString()}`;

  return (
    <>
      {showSummary && (
        <tr
          className={`${tintClass} border-b border-warm-gray/30 cursor-pointer hover:bg-indigo/10`}
          onClick={onToggle}
        >
          <Td tintClass={tintClass} className={`sticky-sku ${tintClass} whitespace-nowrap`}>
            <span className="inline-flex items-center gap-1 font-semibold text-indigo">
              <Chevron open={open} />
              {group.color}
            </span>
            <span className="hidden md:inline text-xs text-charcoal/60 ml-2">
              · {a.totalCount} {a.totalCount === 1 ? 'size' : 'sizes'}{a.inactiveCount > 0 ? ` · ${a.inactiveCount} inactive` : ''}
            </span>
          </Td>
          <Td className="text-right font-mono font-bold text-charcoal border-l border-warm-gray/40">{fmt(a.shipbobWiTotal)}</Td>
          <Td className="text-right font-mono text-charcoal/50">{fmt(a.indivOnHand)}</Td>
          <Td className="text-right font-mono text-charcoal/50">{fmt(a.casePackEqv)}</Td>
          <Td className="text-right font-mono font-bold text-charcoal border-l border-warm-gray/40">{fmt(a.amazonTotal)}</Td>
          <Td className="text-right font-mono">{fmt(a.fbaAvailable)}</Td>
          <Td className="text-right font-mono">{fmt(a.awdStorage)}</Td>
          <Td className="text-right font-mono text-charcoal/60 border-l border-warm-gray/40">{fmt(a.inTransitAir)}</Td>
          <Td className="text-right font-mono text-charcoal/60">{fmt(a.inTransitSea)}</Td>
          <Td className="text-charcoal/40 text-xs">{''}</Td>
          <Td className="text-right font-mono text-charcoal/60">{fmt(a.draftPo)}</Td>
          <Td className="text-right text-charcoal/30 text-xs border-l border-warm-gray/40">—</Td>
          <Td className="text-right font-mono font-semibold" title={familyTotalBreakdown}>
            {fmt(familyPlanTotal)}
            {familyDraftSplitTotal > 0 && (
              <span className="ml-1 text-[10px] text-sage font-medium">+{familyDraftSplitTotal.toLocaleString()}</span>
            )}
          </Td>
          <Td className="text-right font-mono">{a.avgPerDay30d > 0 ? a.avgPerDay30d.toFixed(1) : '—'}</Td>
          <Td className="text-right"><DaysCover days={a.daysCover} /></Td>
          <Td className="text-right font-mono text-charcoal/70">
            {a.valueOnHand > 0 ? fmtCurrency(a.valueOnHand) : ''}
          </Td>
        </tr>
      )}
      {open && group.rows.map((row, idx) => {
        const childTint = showSummary ? 'bg-warm-white' : tintClass;
        const inactive = !row.active;
        const firstOfStyle = !showSummary && idx === 0;
        const firstOfColor = firstOfStyle;

        const draftQty = drafts[row.sku] ?? 0;
        // Apply the policy ceiling so the planned cover reflects the *actual*
        // qty we'd order, not the raw input. This mirrors what Push to POs
        // will commit, so what you see is what you get.
        const split = splitDraft({
          qty: draftQty,
          hasFbaSku: row.hasFbaSku,
          avgPerDay30d: row.avgPerDay30d,
          amazonTotal: row.amazonTotal,
        });
        const plannedSupply = row.totalOnHand + row.inTransitAir + row.inTransitSea + row.draftPo + split.total;
        const plannedCover = row.avgPerDay30d > 0 ? plannedSupply / row.avgPerDay30d : null;
        const coverDelta = (plannedCover ?? 0) - (row.daysCover ?? 0);
        const totalBreakdown = `Hand ${row.totalOnHand.toLocaleString()}`
          + ` · Air ${row.inTransitAir.toLocaleString()}`
          + ` · Sea ${row.inTransitSea.toLocaleString()}`
          + ` · Pend ${row.draftPo.toLocaleString()}`
          + (split.total > 0 ? ` · Draft +${split.total.toLocaleString()}` : '')
          + ` = ${plannedSupply.toLocaleString()}`;

        return (
          <tr key={row.sku} className={`${childTint} border-b border-warm-gray/15 ${inactive ? 'opacity-50' : ''} hover:bg-indigo/5`}>
            <Td tintClass={childTint} className={`sticky-sku ${childTint} font-mono text-xs whitespace-nowrap`}>
              <a href={`/sku/${encodeURIComponent(row.sku)}`} className="hover:text-indigo hover:underline">{row.sku}</a>
            </Td>
            <Td className="text-right font-mono font-bold text-charcoal border-l border-warm-gray/40">{fmt(row.shipbobWiTotal)}</Td>
            <Td className="text-right font-mono text-charcoal/50">{fmt(row.indivOnHand)}</Td>
            <Td className="text-right font-mono text-charcoal/50">{fmt(row.casePackEqv)}</Td>
            <Td className="text-right font-mono font-bold text-charcoal border-l border-warm-gray/40">{fmt(row.amazonTotal)}</Td>
            <Td className="text-right font-mono">{fmt(row.fbaAvailable)}</Td>
            <Td className="text-right font-mono">{fmt(row.awdStorage)}</Td>
            <Td className="text-right font-mono text-charcoal/60 border-l border-warm-gray/40">{fmt(row.inTransitAir)}</Td>
            <Td className="text-right font-mono text-charcoal/60">{fmt(row.inTransitSea)}</Td>
            <Td className="whitespace-nowrap"><NextEtaCell row={row} /></Td>
            <Td className="text-right font-mono text-charcoal/60">{fmt(row.draftPo)}</Td>
            <Td className="text-right border-l border-warm-gray/40">
              <DraftInput
                value={draftQty}
                onChange={(v) => setDraft(row.sku, v)}
                title={split.reason + (split.total > 0 ? ` · routes ${split.amz}→AWD, ${split.sb}→ShipBob` : '')}
              />
            </Td>
            <Td className="text-right font-mono font-semibold" title={totalBreakdown}>
              {fmt(plannedSupply)}
              {split.total > 0 && (
                <span className="ml-1 text-[10px] text-sage font-medium">+{split.total.toLocaleString()}</span>
              )}
            </Td>
            <Td className="text-right font-mono">{row.avgPerDay30d > 0 ? row.avgPerDay30d.toFixed(1) : '—'}</Td>
            <Td className="text-right">
              <DaysCover days={draftQty > 0 ? plannedCover : row.daysCover} />
              {draftQty > 0 && coverDelta > 0 && (
                <span className="ml-1 text-[10px] text-sage font-medium" title={`Was ${row.daysCover?.toFixed(0) ?? '—'}d`}>
                  +{coverDelta.toFixed(0)}d
                </span>
              )}
            </Td>
            <Td className="text-right font-mono text-charcoal/70">
              {row.valueOnHand > 0 ? fmtCurrency(row.valueOnHand) : ''}
            </Td>
          </tr>
        );
      })}
    </>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
      <path d="M2 1 L7 5 L2 9" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Compact "next arrival" indicator for the dashboard row. Three cases:
 *
 *   May 30 → 600       — soonest Incoming PO lands May 30; total at that
 *                         moment will be 600.
 *   no ETA → 600       — Incoming PO exists but ETA cell on the sheet is
 *                         blank/unreadable. Still show the qty so the user
 *                         knows reinforcement is coming, just not when.
 *   —                  — no Incoming POs for this SKU at all.
 *
 * Hover the cell for the full schedule (every incoming PO with mode, ETA, qty).
 */
function NextEtaCell({ row }: { row: ApparelDashboardRow }) {
  const incoming = row.incoming;
  if (incoming.length === 0) {
    return <span className="text-charcoal/30">—</span>;
  }

  const tooltip = incoming
    .map((p) => {
      const date = p.eta && Number.isFinite(Date.parse(p.eta)) ? formatEta(p.eta) : '(no ETA)';
      const mode = p.mode || 'PO';
      const po   = p.poNumber ? ` (${p.poNumber})` : '';
      return `${mode} ${date} +${p.qty.toLocaleString()}${po}`;
    })
    .join('\n');

  // Find the first PO with a parseable ETA; if none, render the no-ETA flavor.
  const next = incoming.find((p) => p.etaTimestamp < Number.MAX_SAFE_INTEGER);
  if (!next) {
    const totalIncoming = incoming.reduce((s, p) => s + p.qty, 0);
    const projected = row.totalOnHand + totalIncoming;
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-clay" title={`${tooltip}\n\nETA cells on the POs tab are blank — fill them in for arrival timing.`}>
        <span className="italic">no ETA</span>
        <span className="text-charcoal/40">→</span>
        <span className="font-mono font-semibold">{projected.toLocaleString()}</span>
        {incoming.length > 1 && <span className="text-charcoal/50 text-[10px]">+{incoming.length - 1}</span>}
      </span>
    );
  }

  const stale = next.etaTimestamp < Date.now();
  // Sum qty of all POs that share this earliest ETA (multi-mode same-day).
  const atNextEta = row.totalOnHand
    + incoming.filter((p) => p.etaTimestamp === next.etaTimestamp).reduce((s, p) => s + p.qty, 0);

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${stale ? 'text-ironclad' : 'text-charcoal/80'}`} title={tooltip}>
      <span className="font-medium">{formatEta(next.eta)}</span>
      <span className="text-charcoal/40">→</span>
      <span className="font-mono font-semibold">{atNextEta.toLocaleString()}</span>
      {incoming.length > 1 && <span className="text-charcoal/50 text-[10px]">+{incoming.length - 1}</span>}
    </span>
  );
}

/** Format an ETA string as "MMM d" (current year) or "MMM d, 'YY" (other years). */
function formatEta(raw: string): string {
  if (!raw) return '—';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return raw;  // unparsable — show raw
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = d.toLocaleString('en-US', { month: 'short' });
  return sameYear
    ? `${month} ${d.getDate()}`
    : `${month} ${d.getDate()}, '${String(d.getFullYear()).slice(2)}`;
}

function DaysCover({ days }: { days: number | null }) {
  if (days === null) return <span className="text-charcoal/30">—</span>;
  let cls = 'text-sage bg-sage-wash';
  if (days < 14) cls = 'text-ironclad bg-ironclad/10';
  else if (days < 30) cls = 'text-clay bg-clay/10';
  return (
    <span className={`inline-block min-w-[2.5rem] px-2 py-0.5 rounded ${cls} font-mono font-semibold`}>
      {days < 100 ? days.toFixed(0) : '99+'}
    </span>
  );
}

// ---- Th / Td helpers with sticky support ------------------------------------

function Th({ children, className = '', title, sticky, left, width, tone }: {
  children: React.ReactNode;
  className?: string;
  title?: string;
  sticky?: boolean;
  left?: string;
  width?: string;
  tone?: 'header';
}) {
  const styles: React.CSSProperties = {};
  if (sticky) {
    styles.position = 'sticky';
    styles.left = left ?? 0;
    styles.zIndex = 30;
  }
  if (width) {
    styles.width = width;
    styles.minWidth = width;
    styles.maxWidth = width;
  }
  const toneClass = tone === 'header' ? 'bg-[#E6E6E8]' : '';
  return (
    <th className={`px-3 py-2 font-medium ${toneClass} ${className}`} title={title} scope="col" style={styles}>
      {children}
    </th>
  );
}

function Td({ children, className = '', sticky, left, width, tintClass, title }: {
  children: React.ReactNode;
  className?: string;
  sticky?: boolean;
  left?: string;
  width?: string;
  /** Tailwind bg class to apply when sticky so content underneath doesn't bleed through. */
  tintClass?: string;
  /** Native HTML title attribute for hover tooltips. */
  title?: string;
}) {
  const styles: React.CSSProperties = {};
  if (sticky) {
    styles.position = 'sticky';
    styles.left = left ?? 0;
    styles.zIndex = 1;
  }
  if (width) {
    styles.width = width;
    styles.minWidth = width;
    styles.maxWidth = width;
  }
  return (
    <td className={`px-3 py-1.5 ${sticky && tintClass ? tintClass : ''} ${className}`} style={styles} title={title}>
      {children}
    </td>
  );
}

function fmt(n: number): string { return n ? n.toLocaleString() : '—'; }
function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

/**
 * Compact numeric draft input. Empty string when 0 so the column reads
 * cleanly when nothing is drafted. Click stays inside the input — bubbling
 * up to the group row would toggle expand/collapse on every keystroke.
 */
function DraftInput({ value, onChange, title }: {
  value: number;
  onChange: (v: number) => void;
  title?: string;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      value={value > 0 ? value : ''}
      placeholder="—"
      title={title}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') return onChange(0);
        const n = parseInt(raw, 10);
        if (Number.isFinite(n)) onChange(Math.max(0, n));
      }}
      className="w-16 px-1.5 py-0.5 text-right font-mono text-xs rounded border border-warm-gray/40 bg-warm-white focus:outline-none focus:ring-1 focus:ring-indigo focus:border-indigo placeholder:text-charcoal/30"
    />
  );
}
