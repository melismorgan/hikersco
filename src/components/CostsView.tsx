'use client';

/**
 * Costs Dashboard view.
 *
 * Phase 1 cut:
 *   - Headline KPI tiles (5)
 *   - Cost matrix table — Warehouse × Category × Month, trailing 12
 *
 * Deferred to subsequent phases:
 *   - Time-grain switcher (Today/Week/Month/T12M)
 *   - Stacked monthly bar chart
 *   - Per-SKU carrying cost table
 *   - Outbound shipping drill (channel × zone × weight)
 *
 * Mirrors the editorial design language used in LandedCostView.
 */

import { useMemo, useState } from 'react';
import type { CostsDashboardData, CostMatrixRow, SkuCarryingCostRow } from '@/lib/inventory';

interface Props {
  data: CostsDashboardData;
}

// "Stuck" thresholds — highlight rows that are simultaneously slow-moving
// AND non-trivially expensive to hold. These are the rows worth a kill /
// discount / reorder-pause decision. Tunable per business reality.
const STUCK_MONTHS_OF_COVER = 6;
const STUCK_MIN_MONTHLY_COST = 5;

type SortKey =
  | 'sku'
  | 'shipbobUnits' | 'fbaUnits' | 'awdUnits' | 'totalUnits'
  | 'shipbobMonthly' | 'fbaMonthly' | 'awdMonthly' | 'totalMonthly'
  | 'avgPerDay' | 'monthsOfCover';
type SortDir = 'asc' | 'desc';

const WAREHOUSE_TINT: Record<string, string> = {
  'ShipBob WI': 'bg-sage-wash',
  'Amazon FBA': 'bg-indigo-wash',
  'AWD':        'bg-periwinkle-wash',
};

export function CostsView({ data }: Props) {
  const { kpis, months, matrixRows, monthTotals, grandTotal, topCarryingSkus } = data;

  // Sort state for the Top SKUs table. Default mirrors the loadCostsDashboard
  // ranking (Total $/mo desc) so the initial render matches what users expect.
  const [sortKey, setSortKey] = useState<SortKey>('totalMonthly');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const sortedSkus = useMemo(() => sortCarryingSkus(topCarryingSkus, sortKey, sortDir), [topCarryingSkus, sortKey, sortDir]);
  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Default direction: SKU ascends alpha, every numeric column descends
      setSortDir(key === 'sku' ? 'asc' : 'desc');
    }
  }

  return (
    <div className="space-y-6">
      {/* Headline KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Tile label="ShipBob Storage"   value={fmtCurrency(kpis.shipBobStorage)}   sub="Trailing 12 months" />
        <Tile label="ShipBob Outbound"  value={fmtCurrency(kpis.shipBobOutbound)}  sub="Trailing 12 months" />
        <Tile label="ShipBob Inbound"   value={fmtCurrency(kpis.shipBobInbound)}   sub="Trailing 12 months" />
        <Tile label="Amazon Outbound"   value={fmtCurrency(kpis.amazonOutbound)}   sub="FBA fulfillment fees" />
        <Tile label="Amazon Sales Fees" value={fmtCurrency(kpis.amazonSalesFees)}  sub="Marketplace commission etc." />
      </div>

      {/* Section header */}
      <div className="flex items-baseline justify-between mt-4">
        <h2 className="font-display text-xl">Cost Matrix · Trailing 12 Months</h2>
        <p className="text-xs text-charcoal/50">
          {monthsRangeLabel(months)} · grand total {fmtCurrency(grandTotal)}
        </p>
      </div>

      {/* Matrix table */}
      <div className="dash-scroll rounded-lg border border-warm-gray/60 bg-warm-white">
        <table className="dash-table text-sm border-separate border-spacing-0" style={{ minWidth: '100%' }}>
          <thead className="text-xs uppercase tracking-wide text-charcoal/70">
            <tr>
              <th
                className="sticky-sku px-3 py-2 text-left border-r border-warm-gray/40"
                style={{ width: 120, minWidth: 120 }}
              >
                Warehouse
              </th>
              <th
                className="px-3 py-2 text-left border-r-2 border-warm-gray/60"
                style={{ position: 'sticky', left: 120, zIndex: 30, width: 110, minWidth: 110 }}
              >
                Category
              </th>
              {months.map((m, idx) => (
                <th
                  key={m}
                  className={`px-3 py-2 text-right tabular-nums ${idx < months.length - 1 ? 'border-r border-warm-gray/30' : ''}`}
                  style={{ minWidth: 80 }}
                >
                  {fmtMonthLabel(m)}
                </th>
              ))}
              <th
                className="px-3 py-2 text-right tabular-nums text-charcoal border-l-2 border-warm-gray/40"
                style={{ minWidth: 90 }}
              >
                T12M
              </th>
            </tr>
          </thead>
          <tbody>
            {matrixRows.length === 0 ? (
              <tr>
                <td colSpan={months.length + 3} className="text-center text-charcoal/60 py-8">
                  No cost data in the trailing 12-month window. Make sure ShipBob Bills and Amazon Bills tabs are populated.
                </td>
              </tr>
            ) : (
              matrixRows.map((r) => <MatrixRow key={`${r.warehouse}-${r.category}`} row={r} monthCount={months.length} />)
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-charcoal/80 font-semibold">
              <td
                className="sticky-sku px-3 py-2 bg-warm-white border-r border-warm-gray/40"
                style={{ width: 120, minWidth: 120 }}
              >
                Grand Total
              </td>
              <td
                className="px-3 py-2 bg-warm-white border-r-2 border-warm-gray/60"
                style={{ position: 'sticky', left: 120, zIndex: 4, width: 110, minWidth: 110 }}
              ></td>
              {monthTotals.map((t, i) => (
                <td
                  key={i}
                  className={`px-3 py-2 text-right tabular-nums ${i < monthTotals.length - 1 ? 'border-r border-warm-gray/30' : ''}`}
                >
                  {fmtCellMoney(t)}
                </td>
              ))}
              <td className="px-3 py-2 text-right tabular-nums border-l-2 border-warm-gray/40">{fmtCurrency(grandTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Footnote */}
      <p className="text-xs text-charcoal/50">
        ShipBob payments (settlement transfers) are excluded. Amazon Reserve / Marketing / Other categories are excluded
        from the cost view. Sales Fees are kept in their own category — they're marketplace cost, not logistics.
      </p>

      {/* Phase 2 — Top SKUs by carrying cost */}
      <div className="flex items-baseline justify-between mt-8">
        <h2 className="font-display text-xl">Top SKUs by Carrying Cost</h2>
        <p className="text-xs text-charcoal/50">
          Storage $ allocated by current on-hand × trailing 3-month warehouse rate · top {topCarryingSkus.length} · click any column to sort
        </p>
      </div>

      {/* Legend explaining the row shading */}
      <div className="flex items-center gap-4 text-xs text-charcoal/60 -mt-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-clay/10 border border-clay/30" />
          Stuck — ≥{STUCK_MONTHS_OF_COVER} months of cover AND ≥${STUCK_MIN_MONTHLY_COST}/mo · candidates for kill / discount / reorder pause
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-warm-white border border-warm-gray/60" />
          Healthy — moving fast enough or cheap enough to hold
        </span>
      </div>

      <div className="dash-scroll rounded-lg border border-warm-gray/60 bg-warm-white">
        <table className="dash-table text-sm border-separate border-spacing-0" style={{ minWidth: '100%' }}>
          <thead className="text-xs uppercase tracking-wide text-charcoal/70">
            <tr>
              <SortHeader label="SKU"        col="sku"            align="left"  minWidth={200} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="WI"         col="shipbobUnits"   align="right" minWidth={70}  sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="FBA"        col="fbaUnits"       align="right" minWidth={70}  sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="AWD"        col="awdUnits"       align="right" minWidth={70}  sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Total"      col="totalUnits"     align="right" minWidth={70}  sortKey={sortKey} sortDir={sortDir} onSort={handleSort} borderClass="border-l border-warm-gray/30" />
              <SortHeader label="WI $/mo"    col="shipbobMonthly" align="right" minWidth={90}  sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="FBA $/mo"   col="fbaMonthly"     align="right" minWidth={90}  sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="AWD $/mo"   col="awdMonthly"     align="right" minWidth={90}  sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Total $/mo" col="totalMonthly"   align="right" minWidth={100} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} borderClass="border-l-2 border-warm-gray/40" />
              <SortHeader label="Avg/Day"    col="avgPerDay"      align="right" minWidth={90}  sortKey={sortKey} sortDir={sortDir} onSort={handleSort} borderClass="border-l border-warm-gray/30" />
              <SortHeader label="Mo of Cover" col="monthsOfCover" align="right" minWidth={100} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {sortedSkus.length === 0 ? (
              <tr>
                <td colSpan={11} className="text-center text-charcoal/60 py-8">
                  No per-SKU carrying cost data yet. Run <code className="font-mono text-xs">computeSkuCarryingCost()</code> in the Apps Script editor.
                </td>
              </tr>
            ) : (
              sortedSkus.map((s) => <CarryingRow key={s.sku} row={s} />)
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-charcoal/50">
        Allocation assumes flat $/unit/month — accurate for ranking, not absolute accounting (ignores SKU cube/weight differences).
        Months of Cover uses Velocity tab&rsquo;s Avg/Day 30d (stock-adjusted).
      </p>
    </div>
  );
}

function SortHeader({
  label, col, align, minWidth, borderClass = '', sortKey, sortDir, onSort,
}: {
  label: string;
  col: SortKey;
  align: 'left' | 'right';
  minWidth: number;
  borderClass?: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === col;
  const arrow = active ? (sortDir === 'desc' ? '▼' : '▲') : '';
  return (
    <th
      className={`px-3 py-2 text-${align} cursor-pointer select-none hover:bg-warm-tint/60 ${borderClass} ${active ? 'text-charcoal' : ''}`}
      style={{ minWidth }}
      onClick={() => onSort(col)}
    >
      <span>{label}</span>
      <span className="ml-1 text-[10px] text-charcoal/50">{arrow || ' '}</span>
    </th>
  );
}

function sortCarryingSkus(rows: SkuCarryingCostRow[], key: SortKey, dir: SortDir): SkuCarryingCostRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (key === 'sku') {
      return dir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    }
    // Numeric. monthsOfCover can be null — push nulls to the end regardless of direction.
    const aNum = av === null || av === undefined ? Number.POSITIVE_INFINITY : Number(av);
    const bNum = bv === null || bv === undefined ? Number.POSITIVE_INFINITY : Number(bv);
    if (aNum === Number.POSITIVE_INFINITY && bNum === Number.POSITIVE_INFINITY) return 0;
    if (aNum === Number.POSITIVE_INFINITY) return 1;
    if (bNum === Number.POSITIVE_INFINITY) return -1;
    return dir === 'asc' ? aNum - bNum : bNum - aNum;
  });
  return sorted;
}

function CarryingRow({ row }: { row: SkuCarryingCostRow }) {
  const isStuck =
    row.monthsOfCover !== null &&
    row.monthsOfCover >= STUCK_MONTHS_OF_COVER &&
    row.totalMonthly >= STUCK_MIN_MONTHLY_COST;
  return (
    <tr className={`border-b border-warm-gray/30 ${isStuck ? 'bg-clay/10' : 'bg-warm-white'}`}>
      <td className="px-3 py-2">
        <div className="font-mono text-xs">{row.sku}</div>
        {(row.style || row.color || row.size) && (
          <div className="text-[11px] text-charcoal/60 mt-0.5">
            {[row.style, row.color, row.size].filter(Boolean).join(' · ')}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtUnits(row.shipbobUnits)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtUnits(row.fbaUnits)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtUnits(row.awdUnits)}</td>
      <td className="px-3 py-2 text-right tabular-nums font-semibold border-l border-warm-gray/30">{fmtUnits(row.totalUnits)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtMoneyOrDash(row.shipbobMonthly)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtMoneyOrDash(row.fbaMonthly)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtMoneyOrDash(row.awdMonthly)}</td>
      <td className="px-3 py-2 text-right tabular-nums font-semibold border-l-2 border-warm-gray/40">
        {fmtMoneyOrDash(row.totalMonthly)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums border-l border-warm-gray/30">
        {row.avgPerDay > 0 ? row.avgPerDay.toFixed(2) : '—'}
      </td>
      <td className={`px-3 py-2 text-right tabular-nums ${isStuck ? 'text-clay font-semibold' : ''}`}>
        {row.monthsOfCover === null ? '—' : row.monthsOfCover.toFixed(1)}
      </td>
    </tr>
  );
}

function fmtUnits(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '—';
  return n.toLocaleString('en-US');
}

function fmtMoneyOrDash(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function MatrixRow({ row, monthCount }: { row: CostMatrixRow; monthCount: number }) {
  const tint = WAREHOUSE_TINT[row.warehouse] ?? 'bg-warm-white';
  return (
    <tr className={`${tint} border-b border-warm-gray/30`}>
      <td
        className={`sticky-sku ${tint} px-3 py-2 font-semibold border-r border-warm-gray/40`}
        style={{ width: 120, minWidth: 120 }}
      >
        {row.warehouse}
      </td>
      <td
        className={`${tint} px-3 py-2 border-r-2 border-warm-gray/60`}
        style={{ position: 'sticky', left: 120, zIndex: 4, width: 110, minWidth: 110 }}
      >
        {row.category}
      </td>
      {row.monthValues.map((v, i) => (
        <td
          key={i}
          className={`px-3 py-2 text-right tabular-nums ${v < 0 ? 'text-ironclad' : ''} ${i < monthCount - 1 ? 'border-r border-warm-gray/20' : ''}`}
        >
          {fmtCellMoney(v)}
        </td>
      ))}
      <td className="px-3 py-2 text-right tabular-nums font-semibold border-l-2 border-warm-gray/40">
        {fmtCurrency(row.total)}
      </td>
    </tr>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-warm-gray/60 bg-warm-white px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-charcoal/50">{label}</div>
      <div className="text-2xl font-display tabular-nums mt-1">{value}</div>
      {sub && <div className="text-[11px] text-charcoal/50 mt-1">{sub}</div>}
    </div>
  );
}

// ─── formatting helpers ───────────────────────────────────────────────

function fmtCurrency(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtCellMoney(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '—';
  // Compact format: $1.2k for thousands, $XX for under
  if (Math.abs(n) >= 1000) {
    return '$' + (n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'k';
  }
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtMonthLabel(m: string): string {
  // 'YYYY-MM' → 'Jan 25'
  const match = m.match(/^(\d{4})-(\d{2})$/);
  if (!match) return m;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = months[parseInt(match[2], 10) - 1] || m;
  const yr = match[1].slice(2);
  return `${monthName} ${yr}`;
}

function monthsRangeLabel(months: string[]): string {
  if (months.length === 0) return '';
  return `${fmtMonthLabel(months[0])} → ${fmtMonthLabel(months[months.length - 1])}`;
}
