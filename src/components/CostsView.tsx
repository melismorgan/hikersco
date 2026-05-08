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

import type { CostsDashboardData, CostMatrixRow } from '@/lib/inventory';

interface Props {
  data: CostsDashboardData;
}

const WAREHOUSE_TINT: Record<string, string> = {
  'ShipBob WI': 'bg-sage-wash',
  'Amazon FBA': 'bg-indigo-wash',
  'AWD':        'bg-periwinkle-wash',
};

export function CostsView({ data }: Props) {
  const { kpis, months, matrixRows, monthTotals, grandTotal } = data;

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
    </div>
  );
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
