'use client';

import { useMemo, useState } from 'react';
import type { AccessoriesDashboardRow, DraftPoSummary } from '@/lib/inventory';
import { lineOrderIndex } from '@/lib/line-order';
import { splitDraft } from '@/lib/policy';
import { useDrafts } from '@/lib/use-drafts';
import type { DraftPushLine } from '@/app/pos/actions';
import { DraftSummaryBar } from './DraftSummaryBar';

interface Props {
  rows: AccessoriesDashboardRow[];
  styleLineMap: Record<string, string>;
  /** Style → Supplier from Style_Templates (col E). Drives per-vendor PO splits. */
  styleSupplierMap: Record<string, string>;
  existingDrafts: DraftPoSummary[];
}

/**
 * Accessories dashboard — non-sized SKUs (Hook Packs, Rear Hooks, Wallets).
 * Same editorial design language as Apparel: line banners between Hook Packs /
 * Rear Hooks / Wallets groups, alternating tints by Style block, sticky-SKU
 * column on horizontal scroll.
 */
export function AccessoriesGrid({ rows: allRows, styleLineMap, styleSupplierMap, existingDrafts }: Props) {
  const [query, setQuery] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const { drafts, setDraft, clearDrafts } = useDrafts();

  // Attach Line and re-sort: LINE_ORDER → MT-bubble → Style → Color.
  // The MT-bubble step drops metal-hardware variants (styles ending in
  // "MT" — e.g. wide-loop metal hooks) to the bottom of their Line block,
  // matching how Melissa thinks about hardware: web/standard first,
  // metal/specialty last.
  const rowsWithLine = useMemo(() => {
    const rows = allRows.map((r) => ({ ...r, line: styleLineMap[r.style] || r.style }));
    return rows
      .map((row, idx) => ({ row, idx }))
      .sort((a, b) => {
        const aLi = lineOrderIndex(a.row.line);
        const bLi = lineOrderIndex(b.row.line);
        if (aLi !== bLi) return aLi - bLi;
        if (a.row.line !== b.row.line) return a.row.line.localeCompare(b.row.line);
        const aMt = isMetalHardware(a.row.style);
        const bMt = isMetalHardware(b.row.style);
        if (aMt !== bMt) return aMt ? 1 : -1;
        if (a.row.style !== b.row.style) return a.row.style.localeCompare(b.row.style);
        if (a.row.color !== b.row.color) return a.row.color.localeCompare(b.row.color);
        return a.idx - b.idx;
      })
      .map(({ row }) => row);
  }, [allRows, styleLineMap]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rowsWithLine.filter((r) => {
      if (activeOnly && !r.active) return false;
      if (!q) return true;
      return (
        r.sku.toLowerCase().includes(q) ||
        r.style.toLowerCase().includes(q) ||
        r.color.toLowerCase().includes(q) ||
        r.line.toLowerCase().includes(q)
      );
    });
  }, [rowsWithLine, query, activeOnly]);

  if (allRows.length === 0) {
    return (
      <div className="rounded-lg border border-warm-gray/60 bg-warm-beige/40 p-8 text-center">
        <p className="text-charcoal/70">
          No accessories SKUs found. Check that <code className="px-1 bg-warm-white rounded">Category</code>{' '}
          equals <code className="px-1 bg-warm-white rounded">Accessories</code> in SKU Master.
        </p>
      </div>
    );
  }

  // Walk visible rows building items: insert banner whenever line changes,
  // alternate Style tint within each line.
  const items: Array<
    | { kind: 'banner'; line: string }
    | { kind: 'row'; row: AccessoriesDashboardRow & { line: string }; tint: number; firstOfStyle: boolean }
  > = [];
  let lastLine: string | null = null;
  let lastStyle: string | null = null;
  let styleIdx = -1;
  for (const row of visible) {
    if (row.line !== lastLine) {
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

  // Aggregate per-SKU drafts into the summary-bar totals (using policy split).
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
      if (!r) continue;
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <input
          type="text"
          placeholder="Search SKU, Style, Color, Line…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 min-w-[200px] max-w-md px-3 py-2 rounded-md border border-warm-gray/60 bg-warm-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo/40 focus:border-indigo/60"
        />
        <label className="flex items-center gap-2 text-sm text-charcoal/70 select-none cursor-pointer">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-indigo" />
          Active only
        </label>
        <span className="text-xs text-charcoal/50">
          Showing {visible.length.toLocaleString()} of {allRows.length.toLocaleString()}
        </span>
      </div>

      {draftAggregates.distinctSkus > 0 && (
        <DraftSummaryBar agg={draftAggregates} onClear={clearDrafts} existingDrafts={existingDrafts} />
      )}

      <div className="rounded-lg border border-warm-gray/40 bg-warm-white">
        <div className="dash-scroll">
          <table className="dash-table text-sm border-separate border-spacing-0" style={{ minWidth: '100%' }}>
            <thead>
              <tr className="text-charcoal/80 text-xs uppercase tracking-wider">
                <Th tone="header" className="sticky-sku font-mono whitespace-nowrap text-left">SKU</Th>
                <Th className="text-right bg-warm-tint border-l border-warm-gray/50" title="ShipBob WI">ShipBob</Th>
                <Th className="text-right bg-[#E6E6E8] border-l border-warm-gray/50" title="Amazon">Amazon</Th>
                <Th className="text-right bg-[#E6E6E8]">FBA</Th>
                <Th className="text-right bg-[#E6E6E8]">AWD</Th>
                <Th className="text-right bg-warm-tint border-l border-warm-gray/50">Air</Th>
                <Th className="text-right bg-warm-tint">Sea</Th>
                <Th className="text-left bg-warm-tint" title="Soonest Incoming PO arrival → projected total at that date">Next ETA</Th>
                <Th className="text-right bg-warm-tint" title="Draft POs already in the POs tab awaiting finalize">Pend</Th>
                <Th className="text-right bg-[#E6E6E8] border-l border-warm-gray/50" title="New draft qty — editable, persists locally until you push to POs">Draft</Th>
                <Th className="text-right bg-[#E6E6E8]" title="Plan total = Hand + Incoming + Pend + Draft input.">Total</Th>
                <Th className="text-right bg-[#E6E6E8]">Avg/Day</Th>
                <Th className="text-right bg-[#E6E6E8]">Cover</Th>
                <Th className="text-right bg-[#E6E6E8]">$ On Hand</Th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={14} className="text-center text-charcoal/60 py-8">No matches.</td></tr>
              )}
              {items.map((item, i) => {
                if (item.kind === 'banner') {
                  return (
                    <tr key={`b-${i}-${item.line}`}>
                      <td colSpan={14} className="bg-indigo text-warm-white px-3 py-2 font-display text-sm tracking-wide uppercase sticky" style={{ left: 0, zIndex: 5 }}>
                        {item.line}
                      </td>
                    </tr>
                  );
                }
                const { row, tint, firstOfStyle } = item;
                const tintClass = tint === 0 ? 'bg-warm-white' : 'bg-warm-tint';
                const inactive = !row.active;
                const draftQty = drafts[row.sku] ?? 0;
                const split = splitDraft({
                  qty: draftQty,
                  hasFbaSku: row.hasFbaSku,
                  avgPerDay30d: row.avgPerDay30d,
                  amazonTotal: row.amazonTotal,
                });
                const plannedSupply = row.totalOnHand + row.inTransit + row.draftPo + split.total;
                const plannedCover = row.avgPerDay30d > 0 ? plannedSupply / row.avgPerDay30d : null;
                const coverDelta = (plannedCover ?? 0) - (row.daysCover ?? 0);
                const totalBreakdown = `Hand ${row.totalOnHand.toLocaleString()}`
                  + ` · Air ${row.inTransitAir.toLocaleString()}`
                  + ` · Sea ${row.inTransitSea.toLocaleString()}`
                  + ` · Pend ${row.draftPo.toLocaleString()}`
                  + (split.total > 0 ? ` · Draft +${split.total.toLocaleString()}` : '')
                  + ` = ${plannedSupply.toLocaleString()}`;
                return (
                  <tr key={row.sku} className={`${tintClass} border-b border-warm-gray/20 ${inactive ? 'opacity-50' : ''} hover:bg-indigo/5`}>
                    <Td className={`sticky-sku ${tintClass} font-mono text-xs whitespace-nowrap`}>
                      <a href={`/sku/${encodeURIComponent(row.sku)}`} className="hover:text-indigo hover:underline">{row.sku}</a>
                    </Td>
                    <Td className="text-right font-mono font-bold text-charcoal border-l border-warm-gray/40">{fmt(row.shipbobWi)}</Td>
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
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
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

function Th({ children, className = '', title, tone }: { children: React.ReactNode; className?: string; title?: string; tone?: 'header' }) {
  const toneClass = tone === 'header' ? 'bg-[#E6E6E8]' : '';
  return <th className={`px-3 py-2 font-medium ${toneClass} ${className}`} title={title} scope="col">{children}</th>;
}
function Td({ children, className = '', title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <td className={`px-3 py-1.5 ${className}`} title={title}>{children}</td>;
}
function fmt(n: number): string { return n ? n.toLocaleString() : '—'; }

/** Metal-hardware variants — styles ending in `MT` (wide-loop metal hooks
 *  and hookpacks). These sort to the bottom of their Line block. */
function isMetalHardware(style: string): boolean {
  return /MT$/i.test(style.trim());
}
function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n);
}

function NextEtaCell({ row }: { row: AccessoriesDashboardRow }) {
  const incoming = row.incoming;
  if (incoming.length === 0) {
    return <span className="text-charcoal/30">—</span>;
  }
  const tooltip = incoming.map((p) => {
    const date = p.eta && Number.isFinite(Date.parse(p.eta)) ? formatEta(p.eta) : '(no ETA)';
    const mode = p.mode || 'PO';
    const po   = p.poNumber ? ` (${p.poNumber})` : '';
    return `${mode} ${date} +${p.qty.toLocaleString()}${po}`;
  }).join('\n');
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

function formatEta(raw: string): string {
  if (!raw) return '—';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return raw;
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = d.toLocaleString('en-US', { month: 'short' });
  return sameYear
    ? `${month} ${d.getDate()}`
    : `${month} ${d.getDate()}, '${String(d.getFullYear()).slice(2)}`;
}

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
