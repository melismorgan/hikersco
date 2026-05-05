'use client';

import { useMemo, useState } from 'react';
import type { AccessoriesDashboardRow } from '@/lib/inventory';

interface Props {
  rows: AccessoriesDashboardRow[];
}

/**
 * Accessories dashboard — non-sized SKUs (Billfolds, TRICK*, hook packs).
 * Same editorial-minimal aesthetic as Apparel; just simpler since there's
 * no Size dimension and no case-pack split.
 */
export function AccessoriesGrid({ rows: allRows }: Props) {
  const [query, setQuery] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRows.filter((r) => {
      if (activeOnly && !r.active) return false;
      if (!q) return true;
      return (
        r.sku.toLowerCase().includes(q) ||
        r.style.toLowerCase().includes(q) ||
        r.color.toLowerCase().includes(q)
      );
    });
  }, [allRows, query, activeOnly]);

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

  // Style banding decoration (only Style alternates here — no within-style color groups).
  const decorated: { row: AccessoriesDashboardRow; firstOfStyle: boolean; tint: number }[] = [];
  let lastStyle: string | null = null;
  let styleIdx = -1;
  for (const row of rows) {
    const firstOfStyle = row.style !== lastStyle;
    if (firstOfStyle) styleIdx++;
    decorated.push({ row, firstOfStyle, tint: styleIdx % 2 });
    lastStyle = row.style;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <input
          type="text"
          placeholder="Search SKU, Style, Color…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 min-w-[200px] max-w-md px-3 py-2 rounded-md border border-warm-gray/60 bg-warm-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo/40 focus:border-indigo/60"
        />
        <label className="flex items-center gap-2 text-sm text-charcoal/70 select-none cursor-pointer">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-indigo" />
          Active only
        </label>
        <span className="text-xs text-charcoal/50">
          Showing {rows.length.toLocaleString()} of {allRows.length.toLocaleString()}
        </span>
      </div>

      <div className="rounded-lg border border-warm-gray/40 overflow-hidden bg-warm-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-periwinkle/15 text-charcoal/80 text-xs uppercase tracking-wider">
                <Th className="text-left">Style</Th>
                <Th className="text-left">Color</Th>
                <Th className="text-left font-mono">SKU</Th>
                <Th className="text-right">ShipBob</Th>
                <Th className="text-right">FBA</Th>
                <Th className="text-right">AWD</Th>
                <Th className="text-right">Amz</Th>
                <Th className="text-right" title="Air + Sea inbound">In-Transit</Th>
                <Th className="text-right" title="Draft PO quantity">Draft</Th>
                <Th className="text-right">Total</Th>
                <Th className="text-right">Avg/Day</Th>
                <Th className="text-right">Cover</Th>
                <Th className="text-right">$ On Hand</Th>
              </tr>
            </thead>
            <tbody>
              {decorated.map(({ row, firstOfStyle, tint }) => {
                const tintClass = tint === 0 ? 'bg-warm-white' : 'bg-warm-beige/30';
                const inactive = !row.active;
                return (
                  <tr
                    key={row.sku}
                    className={`${tintClass} border-b border-warm-gray/20 ${inactive ? 'opacity-50' : ''} hover:bg-indigo/5`}
                  >
                    <Td>
                      {firstOfStyle ? (
                        <span className="font-semibold text-indigo">{row.style}</span>
                      ) : (
                        <span className="text-warm-gray">{row.style}</span>
                      )}
                    </Td>
                    <Td>{row.color || <span className="text-warm-gray">—</span>}</Td>
                    <Td className="font-mono text-xs">
                      <a href={`/sku/${encodeURIComponent(row.sku)}`} className="hover:text-indigo hover:underline">
                        {row.sku}
                      </a>
                    </Td>
                    <Td className="text-right font-mono font-semibold">{fmt(row.shipbobWi)}</Td>
                    <Td className="text-right font-mono">{fmt(row.fbaAvailable)}</Td>
                    <Td className="text-right font-mono">{fmt(row.awdStorage)}</Td>
                    <Td className="text-right font-mono font-semibold">{fmt(row.amazonTotal)}</Td>
                    <Td className="text-right font-mono text-charcoal/60">{fmt(row.inTransit)}</Td>
                    <Td className="text-right font-mono text-charcoal/60">{fmt(row.draftPo)}</Td>
                    <Td className="text-right font-mono font-semibold">{fmt(row.totalOnHand)}</Td>
                    <Td className="text-right font-mono">{row.avgPerDay30d > 0 ? row.avgPerDay30d.toFixed(1) : '—'}</Td>
                    <Td className="text-right"><DaysCover days={row.daysCover} /></Td>
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
  let color = 'text-sage';
  let bg = 'bg-sage-wash';
  if (days < 14) { color = 'text-ironclad'; bg = 'bg-ironclad/10'; }
  else if (days < 30) { color = 'text-clay'; bg = 'bg-clay/10'; }
  return (
    <span className={`inline-block min-w-[2.5rem] px-2 py-0.5 rounded ${bg} ${color} font-mono font-semibold`}>
      {days < 100 ? days.toFixed(0) : '99+'}
    </span>
  );
}

function Th({ children, className = '', title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <th className={`px-3 py-2 font-medium ${className}`} title={title} scope="col">{children}</th>;
}
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-1.5 ${className}`}>{children}</td>;
}
function fmt(n: number): string { return n ? n.toLocaleString() : '—'; }
function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n);
}
