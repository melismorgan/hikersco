'use client';

/**
 * Landed Cost dashboard. Shares the editorial design language with
 * Apparel + Velocity: line banners between line groups, Style+Color rollup
 * with per-size expand, sticky SKU column, alternating Style tints.
 *
 * Default sort = line (canonical HIKERS Co. order). When sorting by a
 * metric column the rollup banners are suspended in favor of a flat ranked
 * list — same pattern as VelocityGrid.
 *
 * Rollup math: at the Style+Color level, EXW / Freight / Fees / Total
 * Landed are weighted averages by units received across the included sizes.
 * That keeps the units-economics interpretation consistent at every tier.
 */

import { Fragment, useMemo, useState } from 'react';
import type { LandedCostRow, LandedCostContribution } from '@/lib/inventory';
import { lineOrderIndex } from '@/lib/line-order';

type DateRange = 'all' | 'ytd' | '12mo' | '6mo' | '90d';

const DATE_RANGE_LABELS: Record<DateRange, string> = {
  all:  'All time',
  ytd:  'Year to date',
  '12mo': 'Last 12 months',
  '6mo':  'Last 6 months',
  '90d':  'Last 90 days',
};

interface Props {
  rows: LandedCostRow[];
  /** Style → Line map (e.g. H503 → "Upfitter") for line banners. */
  styleLineMap: Record<string, string>;
}

type SortKey =
  | 'line'           // default: canonical line + Style + size order
  | 'sku'
  | 'unitsReceived'
  | 'exwUnitCost'
  | 'freightPerUnit'
  | 'feesPerUnit'
  | 'totalLandedCost'
  | 'freightShare'
  | 'poCount'
  | 'lastReceived';

type RowWithLine = LandedCostRow & { line: string };

interface GroupT {
  key: string;
  style: string;
  color: string;
  line: string;
  rows: RowWithLine[];
  agg: {
    unitsReceived: number;
    exwValue: number;
    freightTotal: number;
    feesTotal: number;
    exwUnitCost: number;
    freightPerUnit: number;
    feesPerUnit: number;
    totalLandedCost: number;
    poSet: Set<string>;
    lastReceived: string;
  };
}

export function LandedCostView({ rows: allRows, styleLineMap }: Props) {
  const [query, setQuery] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [rollup, setRollup] = useState(true); // default ON — matches Apparel
  const [sortKey, setSortKey] = useState<SortKey>('line');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dateRange, setDateRange] = useState<DateRange>('all');

  // Attach line per row (look up by Style).
  const rowsWithLine: RowWithLine[] = useMemo(
    () => allRows.map((r) => ({ ...r, line: styleLineMap[r.style] || r.style || '—' })),
    [allRows, styleLineMap],
  );

  // Date filter — recomputes per-row aggregates from the subset of contributions
  // that fall within the selected window. Rows whose contributions all fall
  // outside the window drop out of the table entirely.
  const dateFiltered: RowWithLine[] = useMemo(() => {
    const cutoff = computeCutoff(dateRange);
    if (!cutoff) return rowsWithLine;
    const out: RowWithLine[] = [];
    for (const r of rowsWithLine) {
      const inRange = r.contributions.filter((c) => c.receivedDate && c.receivedDate >= cutoff);
      if (inRange.length === 0) continue;
      out.push(recomputeFromContributions(r, inRange));
    }
    return out;
  }, [rowsWithLine, dateRange]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return dateFiltered.filter((r) => {
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
  }, [dateFiltered, query, activeOnly]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortKey === 'line') {
      return [...filtered].sort((a, b) => {
        const aLi = lineOrderIndex(a.line);
        const bLi = lineOrderIndex(b.line);
        if (aLi !== bLi) return aLi - bLi;
        if (a.line !== b.line) return a.line.localeCompare(b.line);
        if (a.style !== b.style) return a.style.localeCompare(b.style);
        if (a.color !== b.color) return a.color.localeCompare(b.color);
        return sizeOrderFromSku(a.sku) - sizeOrderFromSku(b.sku) || a.sku.localeCompare(b.sku);
      });
    }
    return [...filtered].sort((a, b) => {
      if (sortKey === 'freightShare') {
        const sa = a.totalLandedCost > 0 ? a.freightPerUnit / a.totalLandedCost : 0;
        const sb = b.totalLandedCost > 0 ? b.freightPerUnit / b.totalLandedCost : 0;
        return (sa - sb) * dir;
      }
      if (sortKey === 'lastReceived') {
        return ((a.lastReceived || '').localeCompare(b.lastReceived || '')) * dir;
      }
      if (sortKey === 'sku') return a.sku.localeCompare(b.sku) * dir;
      const av = (a as unknown as Record<string, number>)[sortKey] ?? 0;
      const bv = (b as unknown as Record<string, number>)[sortKey] ?? 0;
      return (av - bv) * dir;
    });
  }, [filtered, sortKey, sortDir]);

  // Build Style+Color groups (only meaningful in line-sort mode for rollup).
  const groups = useMemo(() => groupByStyleColor(sorted), [sorted]);

  const isLineSort = sortKey === 'line';
  const isRollup = rollup && isLineSort;

  // Headline tiles + page-level metadata, computed from the date-filtered set
  // (so when you switch to "Last 6 months", every tile reflects that window).
  const totals = useMemo(() => {
    let totalUnits = 0, totalExw = 0, totalFreight = 0, totalFees = 0;
    const poSet = new Set<string>();
    let earliest = '', latest = '';
    for (const r of dateFiltered) {
      totalUnits += r.unitsReceived;
      totalExw += r.exwValue;
      totalFreight += r.freightTotal;
      totalFees += r.feesTotal;
      for (const c of r.contributions) {
        poSet.add(c.poNumber);
        if (c.receivedDate) {
          if (!earliest || c.receivedDate < earliest) earliest = c.receivedDate;
          if (!latest   || c.receivedDate > latest)   latest   = c.receivedDate;
        }
      }
    }
    const totalLanded = totalExw + totalFreight + totalFees;
    const activeCovered = dateFiltered.filter((r) => r.active).length;
    return {
      coveredSkus: dateFiltered.length,
      activeCoveredSkus: activeCovered,
      totalUnits,
      totalLanded,
      avgLandedPerUnit: totalUnits > 0 ? totalLanded / totalUnits : 0,
      freightShare: totalLanded > 0 ? totalFreight / totalLanded : 0,
      feesShare:    totalLanded > 0 ? totalFees / totalLanded : 0,
      poCount: poSet.size,
      dateRange: earliest && latest
        ? formatRange(earliest, latest)
        : '',
    };
  }, [dateFiltered]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'sku' || key === 'line' ? 'asc' : 'desc');
    }
  }

  function toggleGroup(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  const expandAll = () => setExpanded(new Set(groups.map((g) => g.key)));
  const collapseAll = () => setExpanded(new Set());

  if (allRows.length === 0) {
    return (
      <div className="rounded-lg border border-warm-gray/60 bg-warm-beige/40 p-8 text-center">
        <p className="text-charcoal/70">
          No Received POs found yet. Once a PO is marked Received and has shipping/fee transactions logged, its
          SKUs will show up here with blended landed-cost values.
        </p>
      </div>
    );
  }

  // Build render items so we can interleave banners + rollup rows + expanded children.
  type Item =
    | { kind: 'banner'; line: string }
    | { kind: 'group'; group: GroupT; tint: number }
    | { kind: 'row'; row: RowWithLine; tint: number; firstOfStyle: boolean };
  const items: Item[] = [];

  if (isRollup) {
    // Rollup mode: per-line banner, then per-group summary; expand → child SKU rows.
    let lastLine = '';
    let tint = 0;
    let lastStyle = '';
    for (const g of groups) {
      if (g.line !== lastLine) {
        items.push({ kind: 'banner', line: g.line });
        lastLine = g.line;
        lastStyle = '';
      }
      if (g.style !== lastStyle) {
        tint = 1 - tint;
        lastStyle = g.style;
      }
      items.push({ kind: 'group', group: g, tint });
    }
  } else if (isLineSort) {
    // Line sort, no rollup: banner per line + flat per-row, with Style banding.
    let lastLine = '';
    let lastStyle = '';
    let tint = 0;
    for (const row of sorted) {
      if (row.line !== lastLine) {
        items.push({ kind: 'banner', line: row.line });
        lastLine = row.line;
        lastStyle = '';
      }
      const firstOfStyle = row.style !== lastStyle;
      if (firstOfStyle) {
        tint = 1 - tint;
        lastStyle = row.style;
      }
      items.push({ kind: 'row', row, tint, firstOfStyle });
    }
  } else {
    // Metric sort: flat ranked list, no banners, no Style tinting.
    for (const row of sorted) {
      items.push({ kind: 'row', row, tint: 0, firstOfStyle: false });
    }
  }

  return (
    <div className="space-y-6">
      {/* Data context line — what timeframe + how many POs */}
      <p className="text-xs text-charcoal/50 -mt-2">
        {totals.poCount > 0 ? `Blended across ${totals.poCount} Received PO${totals.poCount === 1 ? '' : 's'}` : 'No Received POs yet'}
        {totals.dateRange && ` · ${totals.dateRange}`}
      </p>

      {/* Headline tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Tile
          label="SKUs covered"
          value={totals.activeCoveredSkus.toLocaleString()}
          sub={`of ${totals.coveredSkus.toLocaleString()} total SKUs in Received POs`}
        />
        <Tile
          label="Avg landed $/unit"
          value={fmtCurrency2(totals.avgLandedPerUnit)}
          sub="Units-weighted across covered SKUs"
        />
        <Tile
          label="Freight share"
          value={fmtPct(totals.freightShare)}
          sub="Of total landed cost"
        />
        <Tile
          label="Alibaba fees share"
          value={fmtPct(totals.feesShare)}
          sub="Of total landed cost"
        />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="search"
          placeholder="Filter by SKU, Style, Color, Line…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="px-3 py-2 border border-warm-gray rounded-md text-sm bg-warm-white focus:outline-none focus:ring-2 focus:ring-indigo/30 w-72"
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-charcoal/60">Range:</span>
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as DateRange)}
            className="px-2 py-1 border border-warm-gray rounded-md text-sm bg-warm-white focus:outline-none focus:ring-2 focus:ring-indigo/30"
          >
            {(Object.keys(DATE_RANGE_LABELS) as DateRange[]).map((k) => (
              <option key={k} value={k}>{DATE_RANGE_LABELS[k]}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
          />
          Active only
        </label>
        <label className={`flex items-center gap-2 text-sm ${!isLineSort ? 'opacity-40 cursor-not-allowed' : ''}`}>
          <input
            type="checkbox"
            checked={rollup}
            onChange={(e) => setRollup(e.target.checked)}
            disabled={!isLineSort}
          />
          Style+Color rollup
        </label>
        {isRollup && (
          <div className="flex items-center gap-2 ml-auto text-xs">
            <button onClick={expandAll} className="px-2 py-1 border border-warm-gray rounded hover:bg-warm-gray/30">Expand all</button>
            <button onClick={collapseAll} className="px-2 py-1 border border-warm-gray rounded hover:bg-warm-gray/30">Collapse all</button>
          </div>
        )}
        <span className="text-xs text-charcoal/60 ml-auto">
          {sorted.length} of {rowsWithLine.length} SKUs
        </span>
      </div>

      {/* Table */}
      <div className="dash-scroll rounded-lg border border-warm-gray/60">
        <table className="dash-table text-sm border-separate border-spacing-0" style={{ minWidth: '100%' }}>
          <thead className="text-xs uppercase tracking-wide text-charcoal/70">
            <tr>
              <Th onClick={() => toggleSort('line')}           active={sortKey === 'line'}            dir={sortDir} align="left"  className="sticky-sku min-w-[260px]">SKU / Style+Color</Th>
              <Th onClick={() => toggleSort('unitsReceived')}  active={sortKey === 'unitsReceived'}   dir={sortDir} align="right">Units</Th>
              <Th onClick={() => toggleSort('exwUnitCost')}    active={sortKey === 'exwUnitCost'}     dir={sortDir} align="right">EXW $/u</Th>
              <Th onClick={() => toggleSort('freightPerUnit')} active={sortKey === 'freightPerUnit'}  dir={sortDir} align="right">Freight $/u</Th>
              <Th onClick={() => toggleSort('feesPerUnit')}    active={sortKey === 'feesPerUnit'}     dir={sortDir} align="right">Fees $/u</Th>
              <Th onClick={() => toggleSort('totalLandedCost')} active={sortKey === 'totalLandedCost'} dir={sortDir} align="right">Landed $/u</Th>
              <Th onClick={() => toggleSort('freightShare')}   active={sortKey === 'freightShare'}    dir={sortDir} align="right">Freight %</Th>
              <Th onClick={() => toggleSort('poCount')}        active={sortKey === 'poCount'}         dir={sortDir} align="right"># POs</Th>
              <Th onClick={() => toggleSort('lastReceived')}   active={sortKey === 'lastReceived'}    dir={sortDir} align="left">Last Received</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              if (it.kind === 'banner') {
                return (
                  <tr key={`banner-${it.line}-${i}`}>
                    <td colSpan={9} className="bg-indigo text-warm-white px-3 py-2 font-display text-sm tracking-wide uppercase sticky" style={{ left: 0, zIndex: 5 }}>
                      {it.line}
                    </td>
                  </tr>
                );
              }
              if (it.kind === 'group') {
                const g = it.group;
                const open = expanded.has(g.key);
                const tintClass = it.tint === 0 ? 'bg-warm-white' : 'bg-warm-beige/40';
                const fShare = g.agg.totalLandedCost > 0 ? g.agg.freightPerUnit / g.agg.totalLandedCost : 0;
                return (
                  <Fragment key={g.key}>
                    <tr
                      className={`${tintClass} border-b border-warm-gray/30 cursor-pointer hover:bg-indigo/5`}
                      onClick={() => toggleGroup(g.key)}
                    >
                      <td className={`sticky-sku ${tintClass} px-3 py-2 whitespace-nowrap`}>
                        <span className="inline-flex items-center gap-1 font-semibold text-indigo">
                          <Chevron open={open} />
                          {g.style} {g.color}
                        </span>
                        <span className="hidden md:inline text-xs text-charcoal/60 ml-2">
                          · {g.rows.length} {g.rows.length === 1 ? 'size' : 'sizes'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">{g.agg.unitsReceived.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney4(g.agg.exwUnitCost)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney4(g.agg.freightPerUnit)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney4(g.agg.feesPerUnit)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtMoney4(g.agg.totalLandedCost)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${fShare > 0.15 ? 'text-clay font-semibold' : 'text-charcoal/70'}`}>
                        {fmtPct(fShare)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{g.agg.poSet.size}</td>
                      <td className="px-3 py-2 text-charcoal/70">{g.agg.lastReceived || '—'}</td>
                    </tr>
                    {open && g.rows.map((row) => (
                      <tr key={row.sku} className="bg-warm-white border-b border-warm-gray/15 hover:bg-indigo/5">
                        <td className="sticky-sku bg-warm-white px-3 pl-9 py-1.5 font-mono text-xs whitespace-nowrap">
                          <a href={`/sku/${encodeURIComponent(row.sku)}`} className="hover:text-indigo hover:underline">{row.sku}</a>
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{row.unitsReceived.toLocaleString()}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney4(row.exwUnitCost)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney4(row.freightPerUnit)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney4(row.feesPerUnit)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney4(row.totalLandedCost)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-charcoal/70">
                          {fmtPct(row.totalLandedCost > 0 ? row.freightPerUnit / row.totalLandedCost : 0)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{row.poCount}</td>
                        <td className="px-3 py-1.5 text-charcoal/70">{row.lastReceived || '—'}</td>
                      </tr>
                    ))}
                  </Fragment>
                );
              }
              // kind === 'row' (flat metric-sort or line-sort no-rollup)
              const r = it.row;
              const tintClass = it.tint === 0 ? 'bg-warm-white' : 'bg-warm-beige/40';
              const fShare = r.totalLandedCost > 0 ? r.freightPerUnit / r.totalLandedCost : 0;
              return (
                <tr key={r.sku} className={`${tintClass} border-b border-warm-gray/15 hover:bg-indigo/5`}>
                  <td className={`sticky-sku ${tintClass} px-3 py-1.5 font-mono text-xs whitespace-nowrap`}>
                    <span className="text-charcoal/50 mr-2">{r.style} {r.color}</span>
                    <a href={`/sku/${encodeURIComponent(r.sku)}`} className="hover:text-indigo hover:underline">{r.sku}</a>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.unitsReceived.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney4(r.exwUnitCost)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney4(r.freightPerUnit)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney4(r.feesPerUnit)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{fmtMoney4(r.totalLandedCost)}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${fShare > 0.15 ? 'text-clay font-semibold' : 'text-charcoal/70'}`}>
                    {fmtPct(fShare)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.poCount}</td>
                  <td className="px-3 py-1.5 text-charcoal/70">{r.lastReceived || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================================
// Sub-components + helpers
// ============================================================================

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-warm-gray/60 bg-warm-white px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-charcoal/50">{label}</div>
      <div className="text-2xl font-display tabular-nums mt-1">{value}</div>
      {sub && <div className="text-[11px] text-charcoal/50 mt-1">{sub}</div>}
    </div>
  );
}

function Th({
  onClick, active, dir, align, className, children,
}: {
  onClick: () => void;
  active: boolean;
  dir: 'asc' | 'desc';
  align: 'left' | 'right';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <th
      className={`px-3 py-2 cursor-pointer select-none hover:bg-warm-gray/50 ${align === 'right' ? 'text-right' : 'text-left'} ${className || ''}`}
      onClick={onClick}
    >
      <span className={active ? 'text-indigo' : ''}>
        {children}
        {active && <span className="ml-1">{dir === 'asc' ? '↑' : '↓'}</span>}
      </span>
    </th>
  );
}

function Chevron({ open }: { open: boolean }) {
  return <span className="inline-block w-3 text-charcoal/50">{open ? '▾' : '▸'}</span>;
}

function groupByStyleColor(rows: RowWithLine[]): GroupT[] {
  const map = new Map<string, GroupT>();
  for (const r of rows) {
    const key = `${r.style}::${r.color}`;
    if (!map.has(key)) {
      map.set(key, {
        key, style: r.style, color: r.color, line: r.line, rows: [],
        agg: {
          unitsReceived: 0, exwValue: 0, freightTotal: 0, feesTotal: 0,
          exwUnitCost: 0, freightPerUnit: 0, feesPerUnit: 0, totalLandedCost: 0,
          poSet: new Set(), lastReceived: '',
        },
      });
    }
    const g = map.get(key)!;
    g.rows.push(r);
    g.agg.unitsReceived += r.unitsReceived;
    g.agg.exwValue      += r.exwValue;
    g.agg.freightTotal  += r.freightTotal;
    g.agg.feesTotal     += r.feesTotal;
    for (const c of r.contributions) g.agg.poSet.add(c.poNumber);
    if (r.lastReceived && r.lastReceived > g.agg.lastReceived) g.agg.lastReceived = r.lastReceived;
  }
  // After unit sums known, compute weighted-avg per-unit values.
  for (const g of map.values()) {
    const u = g.agg.unitsReceived;
    g.agg.exwUnitCost     = u > 0 ? g.agg.exwValue / u : 0;
    g.agg.freightPerUnit  = u > 0 ? g.agg.freightTotal / u : 0;
    g.agg.feesPerUnit     = u > 0 ? g.agg.feesTotal / u : 0;
    g.agg.totalLandedCost = g.agg.exwUnitCost + g.agg.freightPerUnit + g.agg.feesPerUnit;
    g.rows.sort((a, b) => sizeOrderFromSku(a.sku) - sizeOrderFromSku(b.sku) || a.sku.localeCompare(b.sku));
  }
  return Array.from(map.values());
}

const SIZE_ORDER: Record<string, number> = {
  XS: 1, S: 2, M: 3, L: 4, XL: 5,
  '2X': 6, '3X': 7, '4X': 8, '5X': 9,
};
function sizeOrderFromSku(sku: string): number {
  const parts = sku.split('-');
  const code = (parts[parts.length - 1] || '').toUpperCase();
  return SIZE_ORDER[code] ?? 99;
}

// Compute ISO-date cutoff string for the selected range (returns null for 'all').
function computeCutoff(range: DateRange): string | null {
  if (range === 'all') return null;
  const d = new Date();
  switch (range) {
    case 'ytd':  d.setMonth(0, 1); break;
    case '12mo': d.setFullYear(d.getFullYear() - 1); break;
    case '6mo':  d.setMonth(d.getMonth() - 6); break;
    case '90d':  d.setDate(d.getDate() - 90); break;
  }
  // Use local-time YYYY-MM-DD; receivedDate strings are typed as 'YYYY-MM-DD'.
  return d.toISOString().slice(0, 10);
}

// Re-aggregate a row from a filtered subset of its contributions.
// Mirrors the loader's per-SKU aggregation so the math stays consistent across
// "all time" and date-filtered views.
function recomputeFromContributions(
  base: RowWithLine,
  contribs: LandedCostContribution[],
): RowWithLine {
  let units = 0, exwValue = 0, freightTotal = 0, feesTotal = 0, threePLTotal = 0;
  const poSet = new Set<string>();
  let lastReceived = '';
  for (const c of contribs) {
    units += c.qty;
    exwValue += c.lineValue;
    freightTotal += c.freightAlloc;
    feesTotal += c.feesAlloc;
    threePLTotal += c.threePLAlloc;
    poSet.add(c.poNumber);
    if (c.receivedDate && c.receivedDate > lastReceived) lastReceived = c.receivedDate;
  }
  const exwUnitCost = units > 0 ? exwValue / units : 0;
  const freightPerUnit = units > 0 ? freightTotal / units : 0;
  const feesPerUnit = units > 0 ? feesTotal / units : 0;
  const threePLPerUnit = units > 0 ? threePLTotal / units : 0;
  return {
    ...base,
    contributions: contribs,
    unitsReceived: units,
    exwValue,
    exwUnitCost,
    freightTotal,
    freightPerUnit,
    feesTotal,
    feesPerUnit,
    threePLTotal,
    threePLPerUnit,
    totalLandedCost: exwUnitCost + freightPerUnit + feesPerUnit + base.dutyPerUnit + threePLPerUnit,
    poCount: poSet.size,
    lastReceived,
  };
}

function fmtCurrency(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtCurrency2(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatRange(earliest: string, latest: string): string {
  // Inputs are 'YYYY-MM-DD' strings (or possibly 'MM/DD/YYYY'). Format short month-year.
  function short(s: string): string {
    const m = s.match(/^(\d{4})-(\d{2})/);
    if (m) {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${months[parseInt(m[2], 10) - 1]} ${m[1]}`;
    }
    return s;
  }
  if (earliest === latest) return short(earliest);
  return `${short(earliest)} → ${short(latest)}`;
}

function fmtMoney4(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return (n * 100).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}
