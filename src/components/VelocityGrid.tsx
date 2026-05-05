'use client';

import { useMemo, useState } from 'react';
import type { VelocityFull } from '@/lib/inventory';
import { lineOrderIndex } from '@/lib/line-order';
import { BRAND } from '@/lib/brand';

interface Props {
  rows: VelocityFull[];
  styleLineMap: Record<string, string>;
}

type SortKey = 'units30d' | 'avgPerDay30d' | 'avgPerDay7d' | 'stockoutPct30d' | 'sku' | 'line';

type RowWithLine = VelocityFull & { line: string };

/**
 * Velocity browser. Shares the editorial design language with Apparel:
 * line banners between line groups, alternating Style tints, sticky SKU
 * column, optional Style+Color rollup. Trend column renders as inline
 * 3-point sparkline (90d → 30d → 7d) since the sheet's SPARKLINE formula
 * doesn't transmit through the API.
 *
 * Rollup is only meaningful when sorted by line — in metric-sort modes
 * (Stockout %, Units 30d, etc.) families don't naturally cluster, so we
 * disable the rollup toggle in those modes and show a flat per-SKU view.
 */
export function VelocityGrid({ rows: allRows, styleLineMap }: Props) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('line');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('asc');
  const [rollup, setRollup] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Attach line + canonical sort.
  const rowsWithLine: RowWithLine[] = useMemo(
    () => allRows.map((r) => ({ ...r, line: styleLineMap[r.style] || r.style })),
    [allRows, styleLineMap],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rowsWithLine.filter((r) => {
      if (!q) return true;
      return (
        r.sku.toLowerCase().includes(q) ||
        r.style.toLowerCase().includes(q) ||
        r.color.toLowerCase().includes(q) ||
        r.line.toLowerCase().includes(q)
      );
    });
  }, [rowsWithLine, query]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortKey === 'line') {
      return [...filtered].sort((a, b) => {
        const aLi = lineOrderIndex(a.line);
        const bLi = lineOrderIndex(b.line);
        if (aLi !== bLi) return (aLi - bLi) * dir;
        if (a.line !== b.line) return a.line.localeCompare(b.line) * dir;
        if (a.style !== b.style) return a.style.localeCompare(b.style);
        if (a.color !== b.color) return a.color.localeCompare(b.color);
        const aSz = sizeOrderFromSku(a.sku);
        const bSz = sizeOrderFromSku(b.sku);
        if (aSz !== bSz) return aSz - bSz;
        return a.sku.localeCompare(b.sku);
      });
    }
    return [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [filtered, sortKey, sortDir]);

  // Group by Style+Color for rollup mode. Banners + tinted blocks are based
  // on these groups when rollup+line-sort are both on.
  const groups = useMemo(() => groupByStyleColor(sorted), [sorted]);

  const isLineSort = sortKey === 'line';
  const isRollup = rollup && isLineSort;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir(key === 'sku' || key === 'line' ? 'asc' : 'desc'); }
  };

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

  if (allRows.length === 0) {
    return (
      <div className="rounded-lg border border-warm-gray/60 bg-warm-beige/40 p-8 text-center">
        <p className="text-charcoal/70">
          Velocity tab is empty. Run <code className="px-1 bg-warm-white rounded">HIKERS Tools → Recompute velocity</code> from the workbook.
        </p>
      </div>
    );
  }

  // Build render items.
  // - Rollup mode (line sort): banner per line, then group summary rows + optional expanded children.
  // - Line sort, no rollup: banner per line, then per-row with Style banding.
  // - Metric sort: no banners, just per-row.
  type Item =
    | { kind: 'banner'; line: string }
    | { kind: 'group'; group: GroupT; tint: number }
    | { kind: 'row'; row: RowWithLine; tint: number; firstOfStyle: boolean };
  const items: Item[] = [];

  if (isRollup) {
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
  } else {
    let lastLine: string | null = null;
    let lastStyle: string | null = null;
    let styleIdx = -1;
    for (const row of sorted) {
      if (isLineSort && row.line !== lastLine) {
        items.push({ kind: 'banner', line: row.line });
        lastLine = row.line;
        lastStyle = null;
        styleIdx = -1;
      }
      const firstOfStyle = row.style !== lastStyle;
      if (firstOfStyle) styleIdx++;
      items.push({ kind: 'row', row, tint: styleIdx % 2, firstOfStyle });
      lastStyle = row.style;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <input
          type="text"
          placeholder="Search SKU, Style, Color, Line…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 min-w-[200px] max-w-md px-3 py-2 rounded-md border border-warm-gray/60 bg-warm-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo/40"
        />
        <button onClick={() => toggleSort('line')} className={`text-sm hover:text-indigo ${isLineSort ? 'text-indigo font-medium' : 'text-charcoal/70'}`}>
          Group by line
        </button>
        <label className={`flex items-center gap-2 text-sm select-none ${isLineSort ? 'text-charcoal/70 cursor-pointer' : 'text-warm-gray cursor-not-allowed'}`} title={isLineSort ? '' : 'Available when sorted by line'}>
          <input
            type="checkbox"
            checked={rollup && isLineSort}
            disabled={!isLineSort}
            onChange={(e) => setRollup(e.target.checked)}
            className="accent-indigo"
          />
          Group by Style+Color
        </label>
        {isRollup && (
          <div className="flex items-center gap-3 text-xs text-charcoal/60">
            <button onClick={expandAll}   className="hover:text-indigo">Expand all</button>
            <span className="text-warm-gray">·</span>
            <button onClick={collapseAll} className="hover:text-indigo">Collapse all</button>
          </div>
        )}
        <span className="text-xs text-charcoal/50">
          {isRollup
            ? `${groups.length} families · ${sorted.length} SKUs`
            : `${sorted.length.toLocaleString()} of ${allRows.length.toLocaleString()}`}
        </span>
      </div>

      <div className="rounded-lg border border-warm-gray/40 bg-warm-white">
        <div className="dash-scroll">
          <table className="dash-table text-sm border-separate border-spacing-0" style={{ minWidth: '100%' }}>
            <thead>
              <tr className="text-charcoal/80 text-xs uppercase tracking-wider">
                <Th tone="header" className="sticky-sku font-mono whitespace-nowrap text-left">SKU</Th>
                <Th tone="header" className="text-right">Units 7d</Th>
                <SortHeader label="Units 30d" k="units30d" current={sortKey} dir={sortDir} onClick={toggleSort} className="text-right" />
                <Th tone="header" className="text-right">Units 90d</Th>
                <SortHeader label="Avg/Day 7d" k="avgPerDay7d" current={sortKey} dir={sortDir} onClick={toggleSort} className="text-right" />
                <SortHeader label="Avg/Day 30d" k="avgPerDay30d" current={sortKey} dir={sortDir} onClick={toggleSort} className="text-right" />
                <Th tone="header" className="text-right">Avg/Day 90d</Th>
                <Th tone="header" className="text-right" title="Avg/Day 30d adjusted to exclude stockout days — truer demand signal">Avg/Day Obs</Th>
                <Th tone="header" className="text-right" title="In-stock days during the 30d window">In-Stock</Th>
                <SortHeader label="Stockout %" k="stockoutPct30d" current={sortKey} dir={sortDir} onClick={toggleSort} className="text-right" title="% of last 30 days the SKU was out of stock" />
                <Th tone="header" className="text-center" title="Sparkline: 90d → 30d → 7d">Trend</Th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={11} className="text-center text-charcoal/60 py-8">No matches.</td></tr>
              )}
              {items.map((item, i) => {
                if (item.kind === 'banner') {
                  return (
                    <tr key={`b-${i}-${item.line}`}>
                      <td colSpan={11} className="bg-indigo text-warm-white px-3 py-2 font-display text-sm tracking-wide uppercase sticky" style={{ left: 0, zIndex: 5 }}>
                        {item.line}
                      </td>
                    </tr>
                  );
                }
                if (item.kind === 'group') {
                  return (
                    <GroupRowsForVelocity
                      key={item.group.key}
                      group={item.group}
                      tint={item.tint}
                      open={expanded.has(item.group.key)}
                      onToggle={() => toggleGroup(item.group.key)}
                    />
                  );
                }
                const { row, tint, firstOfStyle } = item;
                const tintClass = tint === 0 ? 'bg-warm-white' : 'bg-warm-tint';
                return (
                  <tr key={row.sku} className={`${tintClass} border-b border-warm-gray/15 hover:bg-indigo/5`}>
                    <Td className={`sticky-sku ${tintClass} font-mono text-xs whitespace-nowrap`}>
                      <a href={`/sku/${encodeURIComponent(row.sku)}`} className="hover:text-indigo hover:underline">{row.sku}</a>
                    </Td>
                    <Td className="text-right font-mono">{fmt(row.units7d)}</Td>
                    <Td className="text-right font-mono font-semibold">{fmt(row.units30d)}</Td>
                    <Td className="text-right font-mono">{fmt(row.units90d)}</Td>
                    <Td className="text-right font-mono">{row.avgPerDay7d > 0 ? row.avgPerDay7d.toFixed(2) : '—'}</Td>
                    <Td className="text-right font-mono font-semibold">{row.avgPerDay30d > 0 ? row.avgPerDay30d.toFixed(2) : '—'}</Td>
                    <Td className="text-right font-mono">{row.avgPerDay90d > 0 ? row.avgPerDay90d.toFixed(2) : '—'}</Td>
                    <Td className="text-right font-mono text-charcoal/80">{row.avgPerDay30dObserved > 0 ? row.avgPerDay30dObserved.toFixed(2) : '—'}</Td>
                    <Td className="text-right font-mono text-charcoal/70">{row.inStockDays30d > 0 ? `${row.inStockDays30d}/30` : '—'}</Td>
                    <Td className="text-right">
                      <StockoutPct pct={row.stockoutPct30d} />
                    </Td>
                    <Td className="text-center">
                      <Sparkline p90={row.avgPerDay90d} p30={row.avgPerDay30d} p7={row.avgPerDay7d} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---- Rollup grouping --------------------------------------------------------

interface GroupT {
  key: string;
  style: string;
  color: string;
  rows: RowWithLine[];
  agg: GroupAgg;
}

interface GroupAgg {
  units7d: number;
  units30d: number;
  units90d: number;
  avgPerDay7d: number;
  avgPerDay30d: number;
  avgPerDay90d: number;
  stockoutPct30dWeighted: number; // units30d-weighted
}

function groupByStyleColor(rows: RowWithLine[]): GroupT[] {
  const map = new Map<string, GroupT>();
  for (const r of rows) {
    const key = `${r.style}::${r.color}`;
    if (!map.has(key)) {
      map.set(key, {
        key, style: r.style, color: r.color, rows: [],
        agg: { units7d: 0, units30d: 0, units90d: 0, avgPerDay7d: 0, avgPerDay30d: 0, avgPerDay90d: 0, stockoutPct30dWeighted: 0 },
      });
    }
    const g = map.get(key)!;
    g.rows.push(r);
    g.agg.units7d  += r.units7d;
    g.agg.units30d += r.units30d;
    g.agg.units90d += r.units90d;
    g.agg.avgPerDay7d  += r.avgPerDay7d;
    g.agg.avgPerDay30d += r.avgPerDay30d;
    g.agg.avgPerDay90d += r.avgPerDay90d;
  }
  // Compute weighted stockout AFTER unit sums are known.
  for (const g of map.values()) {
    let weightSum = 0;
    let weighted = 0;
    for (const r of g.rows) {
      const w = r.units30d || 1; // fallback so a 0-unit SKU still contributes
      weightSum += w;
      weighted += w * r.stockoutPct30d;
    }
    g.agg.stockoutPct30dWeighted = weightSum > 0 ? weighted / weightSum : 0;
    g.rows.sort((a, b) => sizeOrderFromSku(a.sku) - sizeOrderFromSku(b.sku) || a.sku.localeCompare(b.sku));
  }
  return Array.from(map.values());
}

function GroupRowsForVelocity({ group, tint, open, onToggle }: { group: GroupT; tint: number; open: boolean; onToggle: () => void }) {
  const tintClass = tint === 0 ? 'bg-warm-white' : 'bg-warm-tint';
  const a = group.agg;
  return (
    <>
      <tr
        className={`${tintClass} border-b border-warm-gray/30 cursor-pointer hover:bg-indigo/10`}
        onClick={onToggle}
      >
        <Td className={`sticky-sku ${tintClass} whitespace-nowrap`}>
          <span className="inline-flex items-center gap-1 font-semibold text-indigo">
            <Chevron open={open} />
            {group.style} {group.color}
          </span>
          <span className="hidden md:inline text-xs text-charcoal/60 ml-2">
            · {group.rows.length} {group.rows.length === 1 ? 'size' : 'sizes'}
          </span>
        </Td>
        <Td className="text-right font-mono">{fmt(a.units7d)}</Td>
        <Td className="text-right font-mono font-semibold">{fmt(a.units30d)}</Td>
        <Td className="text-right font-mono">{fmt(a.units90d)}</Td>
        <Td className="text-right font-mono">{a.avgPerDay7d > 0 ? a.avgPerDay7d.toFixed(2) : '—'}</Td>
        <Td className="text-right font-mono font-semibold">{a.avgPerDay30d > 0 ? a.avgPerDay30d.toFixed(2) : '—'}</Td>
        <Td className="text-right font-mono">{a.avgPerDay90d > 0 ? a.avgPerDay90d.toFixed(2) : '—'}</Td>
        <Td className="text-right text-charcoal/40">—</Td>
        <Td className="text-right text-charcoal/40">—</Td>
        <Td className="text-right">
          <StockoutPct pct={a.stockoutPct30dWeighted} />
        </Td>
        <Td className="text-center">
          <Sparkline p90={a.avgPerDay90d} p30={a.avgPerDay30d} p7={a.avgPerDay7d} />
        </Td>
      </tr>
      {open && group.rows.map((row) => (
        <tr key={row.sku} className="bg-warm-white border-b border-warm-gray/15 hover:bg-indigo/5">
          <Td className="sticky-sku bg-warm-white font-mono text-xs whitespace-nowrap">
            <a href={`/sku/${encodeURIComponent(row.sku)}`} className="hover:text-indigo hover:underline">{row.sku}</a>
          </Td>
          <Td className="text-right font-mono">{fmt(row.units7d)}</Td>
          <Td className="text-right font-mono">{fmt(row.units30d)}</Td>
          <Td className="text-right font-mono">{fmt(row.units90d)}</Td>
          <Td className="text-right font-mono">{row.avgPerDay7d > 0 ? row.avgPerDay7d.toFixed(2) : '—'}</Td>
          <Td className="text-right font-mono">{row.avgPerDay30d > 0 ? row.avgPerDay30d.toFixed(2) : '—'}</Td>
          <Td className="text-right font-mono">{row.avgPerDay90d > 0 ? row.avgPerDay90d.toFixed(2) : '—'}</Td>
          <Td className="text-right font-mono text-charcoal/80">{row.avgPerDay30dObserved > 0 ? row.avgPerDay30dObserved.toFixed(2) : '—'}</Td>
          <Td className="text-right font-mono text-charcoal/70">{row.inStockDays30d > 0 ? `${row.inStockDays30d}/30` : '—'}</Td>
          <Td className="text-right"><StockoutPct pct={row.stockoutPct30d} /></Td>
          <Td className="text-center"><Sparkline p90={row.avgPerDay90d} p30={row.avgPerDay30d} p7={row.avgPerDay7d} /></Td>
        </tr>
      ))}
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

// ---- Reusable bits ----------------------------------------------------------

function Sparkline({ p90, p30, p7 }: { p90: number; p30: number; p7: number }) {
  if (p90 === 0 && p30 === 0 && p7 === 0) {
    return <span className="text-charcoal/30">—</span>;
  }
  const w = 56, h = 18, pad = 2;
  const max = Math.max(p90, p30, p7);
  const min = Math.min(p90, p30, p7);
  const range = max - min || 1;
  const norm = (v: number) => h - pad - ((v - min) / range) * (h - 2 * pad);
  const x90 = pad, x30 = w / 2, x7 = w - pad;
  const y90 = norm(p90), y30 = norm(p30), y7 = norm(p7);
  let dotColor: string = BRAND.indigo;
  if (p7 > p30 * 1.1) dotColor = BRAND.sage;
  else if (p7 < p30 * 0.9) dotColor = BRAND.ironclad;
  return (
    <svg width={w} height={h} className="inline-block align-middle" aria-label={`Trend: 90d ${p90.toFixed(1)} → 30d ${p30.toFixed(1)} → 7d ${p7.toFixed(1)}`}>
      <polyline points={`${x90},${y90} ${x30},${y30} ${x7},${y7}`} stroke={BRAND.indigo} fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x7} cy={y7} r="2.2" fill={dotColor} />
    </svg>
  );
}

function StockoutPct({ pct }: { pct: number }) {
  if (pct <= 0) return <span className="text-charcoal/30 font-mono">0%</span>;
  let cls = 'text-charcoal/70';
  if (pct > 0.25) cls = 'text-ironclad font-semibold';
  else if (pct > 0.10) cls = 'text-clay font-semibold';
  return <span className={`font-mono ${cls}`}>{(pct * 100).toFixed(0)}%</span>;
}

function SortHeader({ label, k, current, dir, onClick, className = '', title }: {
  label: string; k: SortKey; current: SortKey; dir: 'asc' | 'desc'; onClick: (k: SortKey) => void; className?: string; title?: string;
}) {
  const active = current === k;
  return (
    <th className={`px-3 py-2 font-medium bg-[#E6E6E8] ${className}`} title={title} scope="col">
      <button onClick={() => onClick(k)} className={`hover:text-indigo inline-flex items-center gap-1 ${active ? 'text-indigo' : ''}`}>
        {label}
        {active && <span className="text-xs">{dir === 'desc' ? '↓' : '↑'}</span>}
      </button>
    </th>
  );
}

function Th({ children, className = '', title, tone }: { children: React.ReactNode; className?: string; title?: string; tone?: 'header' }) {
  const toneClass = tone === 'header' ? 'bg-[#E6E6E8]' : '';
  return <th className={`px-3 py-2 font-medium ${toneClass} ${className}`} title={title} scope="col">{children}</th>;
}
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-1.5 ${className}`}>{children}</td>;
}
function fmt(n: number): string { return n ? n.toLocaleString() : '—'; }

const SIZE_ORDER: Record<string, number> = {
  XS: 1, S: 2, M: 3, L: 4, XL: 5,
  '2X': 6, '3X': 7, '4X': 8, '5X': 9,
};
function sizeOrderFromSku(sku: string): number {
  const parts = sku.split('-');
  const code = (parts[parts.length - 1] || '').toUpperCase();
  return SIZE_ORDER[code] ?? 99;
}
