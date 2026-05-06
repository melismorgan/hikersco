'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ReorderReport, ReorderSuggestion } from '@/lib/reorder';

interface Props {
  report: ReorderReport;
  initialTargetDays: number;
}

/**
 * Reorder table with:
 *   - Target days-cover slider (30 to 180; updates the URL → server re-runs the math)
 *   - Search filter (SKU / Style / Color)
 *   - "Suggest" toggle: only show SKUs that need reordering
 *   - CSV download — generated client-side from the already-fetched data
 *
 * The math runs on the server (so it sees fresh sheet data on every page load).
 * Slider changes update ?target=N which forces a server re-render.
 */
export function ReorderTable({ report, initialTargetDays }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [target, setTarget] = useState(initialTargetDays);
  const [query, setQuery] = useState('');
  const [onlyNeeded, setOnlyNeeded] = useState(true);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = onlyNeeded ? report.reorderList : report.suggestions;
    return base.filter((s) => {
      if (!q) return true;
      return (
        s.sku.toLowerCase().includes(q) ||
        s.style.toLowerCase().includes(q) ||
        s.color.toLowerCase().includes(q)
      );
    });
  }, [report, query, onlyNeeded]);

  const visibleTotals = useMemo(() => {
    return visible.reduce(
      (acc, s) => {
        acc.distinctSkus += s.totalPlan > 0 ? 1 : 0;
        acc.amzUnits += s.amzPlan;
        acc.sbUnits  += s.sbPlan;
        acc.totalUnits += s.totalPlan;
        acc.estimatedCost += s.estimatedCost;
        return acc;
      },
      { distinctSkus: 0, amzUnits: 0, sbUnits: 0, totalUnits: 0, estimatedCost: 0 },
    );
  }, [visible]);

  const applyTarget = (newTarget: number) => {
    setTarget(newTarget);
    startTransition(() => {
      router.push(`/reorder?target=${newTarget}`);
    });
  };

  const downloadCsv = () => {
    // Build CSV client-side from currently visible rows.
    const header = [
      'SKU', 'Category', 'Style', 'Color', 'Size',
      'Total OH', 'Amz Total', 'In-Transit', 'Draft PO',
      'Avg/Day 30d', 'Effective Avg/Day', 'Velocity Adjusted',
      'Spike Units', 'Days Cover',
      'Amz Eligible', 'Eligibility Reason',
      'Amz Plan', 'SB Plan', 'Total Plan', 'Est. Cost',
    ];
    const escape = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = visible.filter((s) => s.totalPlan > 0).map((s) => [
      s.sku, s.category, s.style, s.color, s.size,
      s.totalOnHand, s.amazonTotal, s.inTransit, s.draftPo,
      s.avgPerDay30d.toFixed(2),
      s.effectiveAvgPerDay.toFixed(2),
      s.velocityAdjusted ? 'Y' : '',
      s.spikeUnits || '',
      s.effectiveDaysCover === Infinity ? '∞' : s.effectiveDaysCover.toFixed(1),
      s.amazonEligible ? 'Y' : 'N',
      s.amazonEligibilityReason,
      s.amzPlan, s.sbPlan, s.totalPlan, s.estimatedCost.toFixed(2),
    ]);
    const csv = [header, ...rows].map((r) => r.map(escape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `hikers-reorder-${dateStr}-target${target}d.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Top KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Stat label="Distinct SKUs" value={report.totals.distinctSkus.toLocaleString()} />
        <Stat label="Amazon (AWD)" value={report.totals.amzUnits.toLocaleString()} subtle />
        <Stat label="ShipBob WI" value={report.totals.sbUnits.toLocaleString()} subtle />
        <Stat label="Total units" value={report.totals.totalUnits.toLocaleString()} accent />
        <Stat label="Est. cost" value={fmtCurrency(report.totals.estimatedCost)} accent />
      </div>

      {/* Events banner — only renders when at least one Event influenced the
          numbers above. Shows what was adjusted and why so the math is
          legible. */}
      {report.appliedEvents.length > 0 && (
        <div className="rounded-lg border border-periwinkle/60 bg-periwinkle/10 p-4">
          <div className="text-xs uppercase tracking-wider text-charcoal/60 mb-2">
            Events applied to this reorder
          </div>
          <ul className="space-y-1.5 text-sm">
            {report.appliedEvents.map((ev) => (
              <li key={ev.eventId} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-xs text-charcoal/60">{ev.eventId}</span>
                <span className="font-medium text-charcoal">{ev.name}</span>
                <span className="text-xs text-charcoal/50">
                  {ev.type} · {ev.status}
                  {ev.startDate && ` · ${ev.startDate}`}
                  {ev.endDate && ` → ${ev.endDate}`}
                </span>
                <span className="ml-auto text-xs text-charcoal/70 font-mono">
                  {ev.velocityAdjustedSkuCount > 0 && (
                    <span className="mr-3">
                      {ev.velocityAdjustedSkuCount} SKU{ev.velocityAdjustedSkuCount === 1 ? '' : 's'} → 90d Avg
                    </span>
                  )}
                  {ev.spikedSkuCount > 0 && (
                    <span>
                      +{ev.totalSpikeUnits.toLocaleString()} units across {ev.spikedSkuCount} SKU{ev.spikedSkuCount === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <div className="text-xs text-charcoal/50 mt-2">
            Edit on the <span className="font-mono">Events</span> tab of the workbook.
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="rounded-lg border border-warm-gray/40 bg-warm-white p-4 space-y-3">
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-3 text-sm">
            <span className="text-charcoal/70 whitespace-nowrap">Target days cover</span>
            <input
              type="range" min={30} max={180} step={5}
              value={target}
              onChange={(e) => setTarget(parseInt(e.target.value, 10))}
              onMouseUp={(e) => applyTarget(parseInt((e.target as HTMLInputElement).value, 10))}
              onTouchEnd={(e) => applyTarget(parseInt((e.target as HTMLInputElement).value, 10))}
              className="w-48 accent-indigo"
            />
            <span className="font-mono font-semibold w-12 text-indigo">{target}d</span>
            {isPending && <span className="text-xs text-charcoal/50">recalculating…</span>}
          </label>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <input
            type="text"
            placeholder="Search SKU, Style, Color…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 min-w-[200px] max-w-md px-3 py-2 rounded-md border border-warm-gray/60 bg-warm-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo/40"
          />
          <label className="flex items-center gap-2 text-sm text-charcoal/70 select-none cursor-pointer">
            <input type="checkbox" checked={onlyNeeded} onChange={(e) => setOnlyNeeded(e.target.checked)} className="accent-indigo" />
            Only SKUs needing reorder
          </label>
          <button
            onClick={downloadCsv}
            className="ml-auto px-4 py-2 rounded-md bg-indigo text-warm-white text-sm font-medium hover:bg-indigo/90"
          >
            Download CSV
          </button>
        </div>
        <div className="text-xs text-charcoal/60">
          Showing {visible.length.toLocaleString()} rows · {visibleTotals.distinctSkus.toLocaleString()} need reorder · {visibleTotals.totalUnits.toLocaleString()} units · {fmtCurrency(visibleTotals.estimatedCost)} est. cost
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-warm-gray/40 bg-warm-white">
        <div className="dash-scroll">
          <table className="dash-table w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr className="bg-periwinkle/15 text-charcoal/80 text-xs uppercase tracking-wider">
                <Th className="text-left">SKU</Th>
                <Th className="text-left">Style</Th>
                <Th className="text-left">Color</Th>
                <Th className="text-left">Size</Th>
                <Th className="text-right" title="Avg units sold per day, 30d window">Avg/Day</Th>
                <Th className="text-right" title="Days of cover at current avg/day">Cover</Th>
                <Th className="text-right">Total OH</Th>
                <Th className="text-right" title="Amazon FBA + AWD + reserved + inbound">Amz</Th>
                <Th className="text-right" title="Air + Sea inbound">In-Tr</Th>
                <Th className="text-right">Amz Plan</Th>
                <Th className="text-right">SB Plan</Th>
                <Th className="text-right">Total</Th>
                <Th className="text-right">Est. Cost</Th>
                <Th className="text-left">Reason</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => <ReorderRow key={s.sku} s={s} />)}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={14} className="text-center text-charcoal/60 py-8">
                    {onlyNeeded
                      ? `Nothing needs reordering at ${target}-day target — drop the slider lower or untoggle "Only SKUs needing reorder."`
                      : 'No matches.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ReorderRow({ s }: { s: ReorderSuggestion }) {
  const needsReorder = s.totalPlan > 0;
  // The displayed Avg/Day reflects whichever number actually drove the math:
  // 90d when an Events exclusion is in effect, 30d otherwise. The 30d cell
  // is dimmed to show it was overridden, with a tooltip explaining why.
  const displayedAvg = s.velocityAdjusted ? s.effectiveAvgPerDay : s.avgPerDay30d;
  return (
    <tr className={`border-b border-warm-gray/20 hover:bg-indigo/5 ${needsReorder ? '' : 'opacity-50'}`}>
      <Td className="font-mono text-xs">
        <a href={`/sku/${encodeURIComponent(s.sku)}`} className="hover:text-indigo hover:underline">{s.sku}</a>
      </Td>
      <Td>{s.style}</Td>
      <Td>{s.color}</Td>
      <Td>{s.size}</Td>
      <Td className="text-right font-mono">
        {displayedAvg > 0 ? displayedAvg.toFixed(1) : '—'}
        {s.velocityAdjusted && (
          <span
            className="ml-1 px-1 rounded bg-periwinkle/30 text-charcoal/70 text-[10px] font-sans align-middle cursor-help"
            title={s.velocityAdjustReason || '90d Avg/Day substituted for 30d due to active Event exclusion'}
          >
            90d
          </span>
        )}
      </Td>
      <Td className="text-right"><DaysCoverBadge days={s.effectiveDaysCover} /></Td>
      <Td className="text-right font-mono">{s.totalOnHand.toLocaleString()}</Td>
      <Td className="text-right font-mono text-charcoal/70">{s.amazonTotal.toLocaleString()}</Td>
      <Td className="text-right font-mono text-charcoal/60">{s.inTransit.toLocaleString()}</Td>
      <Td className="text-right font-mono font-semibold text-indigo">{s.amzPlan ? s.amzPlan.toLocaleString() : '—'}</Td>
      <Td className="text-right font-mono font-semibold text-indigo">{s.sbPlan ? s.sbPlan.toLocaleString() : '—'}</Td>
      <Td className="text-right font-mono font-semibold">
        {s.totalPlan ? s.totalPlan.toLocaleString() : '—'}
        {s.spikeUnits > 0 && (
          <span
            className="ml-1 px-1 rounded bg-clay/15 text-clay text-[10px] font-sans align-middle cursor-help"
            title={s.spikeReason || `+${s.spikeUnits} units from upcoming Event(s)`}
          >
            +{s.spikeUnits}
          </span>
        )}
      </Td>
      <Td className="text-right font-mono text-charcoal/70">
        {s.estimatedCost > 0 ? fmtCurrency(s.estimatedCost) : ''}
      </Td>
      <Td className="text-xs text-charcoal/60">{s.amazonEligibilityReason}</Td>
    </tr>
  );
}

function DaysCoverBadge({ days }: { days: number }) {
  if (!Number.isFinite(days)) return <span className="text-charcoal/30 font-mono">—</span>;
  let cls = 'text-sage bg-sage-wash';
  if (days < 14) cls = 'text-ironclad bg-ironclad/10';
  else if (days < 30) cls = 'text-clay bg-clay/10';
  return (
    <span className={`inline-block min-w-[2.5rem] px-2 py-0.5 rounded ${cls} font-mono font-semibold`}>
      {days < 100 ? days.toFixed(0) : '99+'}
    </span>
  );
}

function Stat({ label, value, accent, subtle }: { label: string; value: string; accent?: boolean; subtle?: boolean }) {
  return (
    <div className="rounded-lg border border-warm-gray/40 bg-warm-white px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-charcoal/50">{label}</div>
      <div className={`font-display text-2xl ${accent ? 'text-indigo' : ''} ${subtle ? 'text-charcoal/70' : ''}`}>
        {value}
      </div>
    </div>
  );
}

function Th({ children, className = '', title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <th className={`px-3 py-2 font-medium ${className}`} title={title} scope="col">{children}</th>;
}
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-1.5 ${className}`}>{children}</td>;
}
function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n);
}
