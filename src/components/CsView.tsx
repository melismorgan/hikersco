'use client';

/**
 * Customer (CS) Dashboard view.
 *
 * v1 sections:
 *   1. KPI tile strip (8 tiles, 2 rows on desktop)
 *   2. Top Friction SKUs — Amazon Returns sorted by return units
 *   3. Sizing-Curve Heatmap — Style+Color × Size pivot, color-coded return rate
 *   4. Recent Low-Rating + Moderated Reviews — full body text + moderation flag
 *   5. Ticket Tag Mix (rolling 30d) + Channel Mix
 *
 * IMPORTANT design context (project_review_moderation_policy.md):
 * Melissa moderates sizing- and delivery-driven negative reviews into CS
 * exchanges. The published Judge.me feed under-counts true sizing
 * complaints. Recent-reviews panel intentionally surfaces moderated rows
 * alongside published low-rating ones so the real signal is visible.
 *
 * Deferred to v2:
 *   • First-response time KPI (requires per-ticket /messages fetch)
 *   • Per-product joining of Reviews+Tickets+Returns (review aggregation
 *     by product handle, ticket join via subject keyword match)
 *   • Moderation reason classification (sizing vs delivery vs other)
 */

import { useMemo, useState } from 'react';
import type { CsDashboardData, AmazonReturnRow, SizingHeatmapRow, ReviewRow } from '@/lib/inventory';

interface Props {
  data: CsDashboardData;
}

type FrictionSortKey = 'sku' | 'unitsShipped' | 'returnUnits' | 'returnRate' | 'netReturnCost';
type FrictionSortDir = 'asc' | 'desc';

export function CsView({ data }: Props) {
  const { kpis, topFrictionSkus, sizingHeatmap, sizes, recentLowOrModeratedReviews, ticketTagMix, ticketChannelMix } = data;

  return (
    <div className="space-y-8">
      {/* ─────── KPI tile strip ─────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Tile label="Tickets · 30d" value={fmtCount(kpis.ticketVolume30d)} sub="Created in window" />
        <Tile label="Open Tickets"  value={fmtCount(kpis.openTickets)}     sub="Unresolved right now" />
        <Tile label="Avg CSAT · 90d"
              value={kpis.avgCsat90d != null ? kpis.avgCsat90d.toFixed(2) + ' / 5' : '—'}
              sub={`${kpis.csatResponseCount90d} responses`} />
        <Tile label="Moderated Reviews · 90d"
              value={fmtCount(kpis.moderatedReviewCount90d)}
              sub="Intercepted to CS, not published" />
        <Tile label="Amazon Return Rate · 90d"
              value={fmtPct(kpis.amazonReturnRate90d)}
              sub="Units returned ÷ shipped" />
        <Tile label="Net Return Cost · 90d"
              value={fmtCurrency(kpis.netReturnCost90d)}
              sub="Handling + postage + reversal" />
        <Tile label="Avg Review Rating · 90d"
              value={kpis.avgReviewRating90d != null ? kpis.avgReviewRating90d.toFixed(2) + ' ★' : '—'}
              sub="Published reviews only" />
        <Tile label="% 4★+ · 90d"
              value={kpis.pctReviews4PlusStar90d != null ? fmtPct(kpis.pctReviews4PlusStar90d) : '—'}
              sub="Published reviews only" />
      </div>

      {/* ─────── Top Friction SKUs ─────── */}
      <section>
        <SectionHeader title="Top Friction SKUs" subtitle={`Amazon · top ${topFrictionSkus.length} by return units · last 90 days`} />
        <FrictionTable rows={topFrictionSkus} />
      </section>

      {/* ─────── Sizing Heatmap ─────── */}
      <section>
        <SectionHeader
          title="Sizing-Curve Heatmap"
          subtitle={`Return rate by Style+Color × Size · groups with ≥50 units shipped · sorted by overall return rate desc`}
        />
        <SizingHeatmap rows={sizingHeatmap} sizes={sizes} />
        <p className="text-xs text-charcoal/50 mt-2">
          Cell colors: green = below 5%, amber = 5–10%, red = above 10%. Empty cells mean no Amazon
          shipments for that size in the 90-day window. Look for vertical patterns — if XL consistently
          runs hotter than L across multiple Style+Color rows, that&rsquo;s a sizing-spec problem, not a
          customer-quality issue.
        </p>
      </section>

      {/* ─────── Recent Low-Rating + Moderated Reviews ─────── */}
      <section>
        <SectionHeader
          title="Recent Friction Reviews"
          subtitle="Low-rating (1-2★) AND moderated reviews · newest first · the unfiltered customer voice"
        />
        <ReviewsList rows={recentLowOrModeratedReviews} />
      </section>

      {/* ─────── Ticket Mixes (side by side) ─────── */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <SectionHeader title="Ticket Tags · 30d" subtitle="Top 10 tags by ticket count" />
          <SimpleCountTable header="Tag" rows={ticketTagMix.map((t) => ({ label: t.tag, count: t.count }))} />
        </div>
        <div>
          <SectionHeader title="Ticket Channel · 30d" subtitle="Where customers reach us" />
          <SimpleCountTable header="Channel" rows={ticketChannelMix.map((c) => ({ label: c.channel, count: c.count }))} />
        </div>
      </section>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/* Subcomponents                                                          */
/* ────────────────────────────────────────────────────────────────────── */

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex items-baseline justify-between mb-3">
      <h2 className="font-display text-xl">{title}</h2>
      {subtitle && <p className="text-xs text-charcoal/50">{subtitle}</p>}
    </div>
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

function FrictionTable({ rows }: { rows: AmazonReturnRow[] }) {
  const [sortKey, setSortKey] = useState<FrictionSortKey>('returnUnits');
  const [sortDir, setSortDir] = useState<FrictionSortDir>('desc');
  const sorted = useMemo(() => sortFriction(rows, sortKey, sortDir), [rows, sortKey, sortDir]);

  function handleSort(k: FrictionSortKey) {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setSortDir(k === 'sku' ? 'asc' : 'desc');
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-warm-gray/60 bg-warm-white p-6 text-center text-charcoal/60 text-sm">
        No Amazon return data in window. Run <code className="font-mono text-xs">syncAmazonReturns()</code> in Apps Script.
      </div>
    );
  }

  return (
    <div className="dash-scroll rounded-lg border border-warm-gray/60 bg-warm-white">
      <table className="dash-table text-sm border-separate border-spacing-0" style={{ minWidth: '100%' }}>
        <thead className="text-xs uppercase tracking-wide text-charcoal/70">
          <tr>
            <FSortHeader label="SKU" col="sku"  align="left"  minWidth={220} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <FSortHeader label="Units Shipped" col="unitsShipped" align="right" minWidth={100} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <FSortHeader label="Returns" col="returnUnits" align="right" minWidth={80} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <FSortHeader label="Return Rate" col="returnRate" align="right" minWidth={100} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            <FSortHeader label="Net Cost" col="netReturnCost" align="right" minWidth={90} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.sku} className="border-b border-warm-gray/30 bg-warm-white">
              <td className="px-3 py-2">
                <div className="font-mono text-xs">{r.sku}</div>
                {(r.style || r.color || r.size) && (
                  <div className="text-[11px] text-charcoal/60 mt-0.5">
                    {[r.style, r.color, r.size].filter(Boolean).join(' · ')}
                    {r.productTitle ? ` · ${r.productTitle}` : ''}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{r.unitsShipped.toLocaleString('en-US')}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.returnUnits.toLocaleString('en-US')}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtPct(r.returnRate)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtCurrency(r.netReturnCost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FSortHeader({
  label, col, align, minWidth, sortKey, sortDir, onSort,
}: {
  label: string;
  col: FrictionSortKey;
  align: 'left' | 'right';
  minWidth: number;
  sortKey: FrictionSortKey;
  sortDir: FrictionSortDir;
  onSort: (k: FrictionSortKey) => void;
}) {
  const active = sortKey === col;
  const arrow = active ? (sortDir === 'desc' ? '▼' : '▲') : '';
  return (
    <th
      className={`px-3 py-2 text-${align} cursor-pointer select-none hover:bg-warm-tint/60 ${active ? 'text-charcoal' : ''}`}
      style={{ minWidth }}
      onClick={() => onSort(col)}
    >
      <span>{label}</span>
      <span className="ml-1 text-[10px] text-charcoal/50">{arrow || ' '}</span>
    </th>
  );
}

function sortFriction(rows: AmazonReturnRow[], key: FrictionSortKey, dir: FrictionSortDir): AmazonReturnRow[] {
  const out = [...rows];
  out.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (key === 'sku') {
      return dir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    }
    return dir === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av);
  });
  return out;
}

function SizingHeatmap({ rows, sizes }: { rows: SizingHeatmapRow[]; sizes: string[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-warm-gray/60 bg-warm-white p-6 text-center text-charcoal/60 text-sm">
        Not enough Amazon volume in any Style+Color group to plot a sizing curve.
      </div>
    );
  }
  return (
    <div className="dash-scroll rounded-lg border border-warm-gray/60 bg-warm-white">
      <table className="dash-table text-sm border-separate border-spacing-0" style={{ minWidth: '100%' }}>
        <thead className="text-xs uppercase tracking-wide text-charcoal/70">
          <tr>
            <th className="sticky-sku px-3 py-2 text-left border-r-2 border-warm-gray/60" style={{ minWidth: 220 }}>
              Style · Color
            </th>
            {sizes.map((s) => (
              <th key={s} className="px-3 py-2 text-center" style={{ minWidth: 64 }}>
                {s}
              </th>
            ))}
            <th className="px-3 py-2 text-right border-l-2 border-warm-gray/40 tabular-nums" style={{ minWidth: 80 }}>
              Overall
            </th>
            <th className="px-3 py-2 text-right tabular-nums" style={{ minWidth: 80 }}>
              Units
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cellBySize: Record<string, { rate: number; units: number }> = {};
            for (const c of row.cells) cellBySize[c.size] = { rate: c.rate, units: c.units };
            return (
              <tr key={row.styleColor} className="border-b border-warm-gray/30">
                <td className="sticky-sku px-3 py-2 bg-warm-white border-r-2 border-warm-gray/60 text-sm">
                  <div className="font-medium">{row.style}</div>
                  <div className="text-[11px] text-charcoal/60">{row.color}</div>
                </td>
                {sizes.map((s) => {
                  const cell = cellBySize[s];
                  if (!cell) {
                    return <td key={s} className="px-1 py-1 text-center text-charcoal/30 text-xs">—</td>;
                  }
                  return (
                    <td key={s} className={`px-1 py-1 text-center ${heatmapBg(cell.rate)}`} title={`${cell.units} shipped`}>
                      <span className="text-xs tabular-nums">{fmtPct(cell.rate)}</span>
                    </td>
                  );
                })}
                <td className={`px-3 py-2 text-right tabular-nums border-l-2 border-warm-gray/40 ${heatmapBg(row.totalReturnRate)}`}>
                  {fmtPct(row.totalReturnRate)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-charcoal/70 text-xs">
                  {row.totalUnits.toLocaleString('en-US')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function heatmapBg(rate: number): string {
  if (rate >= 0.10) return 'bg-ironclad/30';  // red — too hot to ignore
  if (rate >= 0.05) return 'bg-clay/30';      // amber — watch
  if (rate > 0)     return 'bg-sage/20';      // green — healthy
  return '';                                   // 0 — leave blank
}

function ReviewsList({ rows }: { rows: ReviewRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-warm-gray/60 bg-warm-white p-6 text-center text-charcoal/60 text-sm">
        No low-rating or moderated reviews in window. Either reviews are universally positive (great!),
        or the Reviews tab needs a backfill — run <code className="font-mono text-xs">syncJudgeMeBackfill(90)</code>.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.reviewId}
             className={`rounded-lg border p-4 ${r.published ? 'border-warm-gray/60 bg-warm-white' : 'border-indigo/40 bg-indigo/5'}`}>
          <div className="flex items-baseline justify-between gap-4 mb-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium tabular-nums">{'★'.repeat(r.rating)}{'☆'.repeat(Math.max(0, 5 - r.rating))}</span>
              {r.title && <span className="text-sm font-medium text-charcoal">{r.title}</span>}
              {!r.published && (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo/20 text-indigo">
                  Moderated · not public
                </span>
              )}
              {r.hidden && (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-charcoal/20 text-charcoal/80">
                  Spam-flagged
                </span>
              )}
            </div>
            <span className="text-[11px] text-charcoal/50 whitespace-nowrap">{fmtDate(r.createdAt)}</span>
          </div>
          {r.body && <p className="text-sm text-charcoal/80 mb-2 whitespace-pre-wrap">{r.body}</p>}
          <div className="text-[11px] text-charcoal/50">
            {r.productTitle || r.productHandle || '(no product)'}
            {r.reviewerName && <> · {r.reviewerName}</>}
            {r.verified && <> · {r.verified}</>}
          </div>
        </div>
      ))}
    </div>
  );
}

function SimpleCountTable({ header, rows }: { header: string; rows: { label: string; count: number }[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-warm-gray/60 bg-warm-white p-4 text-center text-charcoal/60 text-sm">
        No data in window.
      </div>
    );
  }
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <div className="rounded-lg border border-warm-gray/60 bg-warm-white">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-charcoal/70 border-b border-warm-gray/40">
          <tr>
            <th className="px-3 py-2 text-left">{header}</th>
            <th className="px-3 py-2 text-right">Count</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-warm-gray/20 last:border-b-0">
              <td className="px-3 py-2 align-middle">
                <div className="flex items-center gap-2">
                  <div className="h-2 rounded bg-indigo/30 flex-shrink-0" style={{ width: `${(r.count / max) * 80}px` }} />
                  <span>{r.label}</span>
                </div>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{r.count.toLocaleString('en-US')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/* Formatters                                                             */
/* ────────────────────────────────────────────────────────────────────── */

function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}
function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return (n * 100).toFixed(2) + '%';
}
function fmtCurrency(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function fmtDate(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
