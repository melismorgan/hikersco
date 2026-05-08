'use client';

import type { SalesMarketingData } from '@/lib/sales-marketing';

interface Props {
  data: SalesMarketingData;
}

export function MarketingDashboard({ data }: Props) {
  const {
    totals,
    channelMix,
    platformBreakdown,
    dailyTrend,
    topCampaigns,
    topFlows,
    windowStart,
    windowEnd,
    windowDays,
  } = data;

  return (
    <div className="space-y-8">
      {/* Date range banner */}
      <div className="rounded-md bg-warm-tint border border-warm-gray/30 px-4 py-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-sm font-semibold text-charcoal">
          {windowDays === 1
            ? `Yesterday · ${fmtDateLong(windowEnd)}`
            : `${fmtDateLong(windowStart)} – ${fmtDateLong(windowEnd)}`}
        </span>
        <span className="text-xs text-charcoal/60">
          {windowDays === 1
            ? 'Single-day view · today excluded (partial-day data)'
            : `${windowDays} complete days · ending yesterday · today excluded (partial-day data)`}
        </span>
      </div>

      {/* Integration-status notice — keep until everything is wired up. */}
      <div className="rounded-md border border-clay/40 bg-clay/5 px-4 py-3 text-xs text-charcoal/80">
        <span className="font-semibold text-clay">Heads-up:</span> some integrations are still pending and the numbers below reflect available data only.
        <ul className="mt-1.5 ml-4 list-disc space-y-0.5">
          <li>
            <span className="font-medium">Google Ads</span> and <span className="font-medium">Amazon Ads</span> — awaiting API approval. Spend and attributed revenue from these channels are not yet included.
          </li>
          <li>
            <span className="font-medium">Klaviyo flows</span> (welcome series, abandoned cart, browse abandonment, etc.) — only Klaviyo <em>campaigns</em> are wired up so far. Flows often drive more email revenue than campaigns; expect Email + SMS Revenue to grow once flows land.
          </li>
          <li>
            <span className="font-medium">Amazon orders</span> — Shopify revenue is fully populated; Amazon FBA/FBM is intermittent due to SP-API report queue delays. Catches up overnight.
          </li>
        </ul>
      </div>

      {/* KPI strip — 5 tiles */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Kpi
          label="Net Revenue"
          value={fmtMoney(totals.netRevenue)}
          subtext={`${totals.orders.toLocaleString()} orders`}
        />
        <Kpi
          label="Advertising Revenue"
          value={fmtMoney(totals.advertisingRevenue)}
          subtext="Meta + Google + Amazon"
        />
        <Kpi
          label="Email + SMS Revenue"
          value={fmtMoney(totals.emailSmsRevenue)}
          subtext="Klaviyo + Postscript"
        />
        <Kpi
          label="Marketing Spend"
          value={fmtMoney(totals.marketingSpend)}
          subtext="Paid ad platforms"
        />
        <Kpi
          label="Blended ROAS"
          value={totals.blendedRoas !== null ? `${totals.blendedRoas.toFixed(2)}x` : '—'}
          subtext={
            totals.blendedRoas !== null
              ? `${fmtMoney(totals.marketingConversionValue)} attributed`
              : 'no spend in window'
          }
        />
      </div>

      {/* Two-column: channel mix + platform breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card title="Sales by Channel" subtitle={`Last ${windowDays} days`}>
          {channelMix.length === 0 ? (
            <Empty />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-charcoal/60 border-b border-warm-gray/40">
                  <th className="py-2 font-normal">Channel</th>
                  <th className="py-2 font-normal text-right">Orders</th>
                  <th className="py-2 font-normal text-right">Gross</th>
                  <th className="py-2 font-normal text-right">Net</th>
                  <th className="py-2 font-normal text-right w-24">Share (Net)</th>
                </tr>
              </thead>
              <tbody>
                {channelMix.map((c) => (
                  <tr key={c.channel} className="border-b border-warm-gray/20 last:border-b-0">
                    <td className="py-2.5 font-medium">{c.channel}</td>
                    <td className="py-2.5 text-right tabular-nums">
                      {c.orders.toLocaleString()}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{fmtMoney(c.grossRevenue)}</td>
                    <td className="py-2.5 text-right tabular-nums">{fmtMoney(c.netRevenue)}</td>
                    <td className="py-2.5 text-right">
                      <ShareBar value={c.share} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Marketing by Platform" subtitle={`Last ${windowDays} days · sorted by attributed revenue`}>
          {platformBreakdown.length === 0 ? (
            <Empty />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-charcoal/60 border-b border-warm-gray/40">
                  <th className="py-2 font-normal">Platform</th>
                  <th className="py-2 font-normal text-right">Spend</th>
                  <th className="py-2 font-normal text-right">Attributed Rev</th>
                  <th className="py-2 font-normal text-right">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {platformBreakdown.map((p) => (
                  <tr key={p.platform} className="border-b border-warm-gray/20 last:border-b-0">
                    <td className="py-2.5 font-medium">{p.platform}</td>
                    <td className="py-2.5 text-right tabular-nums">
                      {p.spend > 0 ? (
                        fmtMoney(p.spend)
                      ) : (
                        <span className="text-charcoal/40">—</span>
                      )}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{fmtMoney(p.conversionValue)}</td>
                    <td className="py-2.5 text-right tabular-nums">
                      {p.roas !== null ? `${p.roas.toFixed(2)}x` : <span className="text-charcoal/40">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {/* Daily trend — three stacked single-metric bar charts.
          Hidden on the 1-day view since a chart of one bar isn't useful.
          Each chart has its own Y scale; the shared X axis is what lets
          the eye compare day-to-day. Avoids dual-axis-confusion where
          differently-scaled lines on one chart look comparable when they
          aren't. */}
      {windowDays > 1 && (
        <Card
          title="Daily Trend"
          subtitle="Three views, same dates: revenue, spend, and ROAS"
        >
          <DailyTrendStack points={dailyTrend} />
        </Card>
      )}

      {/* Top campaigns + flows */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card title="Top Campaigns" subtitle="Email blasts and SMS sends, by attributed revenue">
          {topCampaigns.length === 0 ? (
            <Empty subtitle="No campaign sends in this window." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-charcoal/60 border-b border-warm-gray/40">
                  <th className="py-2 font-normal">Campaign</th>
                  <th className="py-2 font-normal">Platform</th>
                  <th className="py-2 font-normal text-right">Conversions</th>
                  <th className="py-2 font-normal text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {topCampaigns.map((c, i) => (
                  <tr key={`${c.sendDate}-${c.name}-${i}`} className="border-b border-warm-gray/20 last:border-b-0">
                    <td className="py-2 truncate max-w-xs" title={c.name}>{c.name || '(unnamed)'}</td>
                    <td className="py-2">{c.platform}</td>
                    <td className="py-2 text-right tabular-nums">{c.conversions.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{fmtMoney(c.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Top Flows" subtitle="Automated sequences (welcome, abandoned cart, browse, etc.)">
          {topFlows.length === 0 ? (
            <Empty subtitle="No flow conversions in this window." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-charcoal/60 border-b border-warm-gray/40">
                  <th className="py-2 font-normal">Flow</th>
                  <th className="py-2 font-normal">Platform</th>
                  <th className="py-2 font-normal text-right">Conversions</th>
                  <th className="py-2 font-normal text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {topFlows.map((c, i) => (
                  <tr key={`${c.sendDate}-${c.name}-${i}`} className="border-b border-warm-gray/20 last:border-b-0">
                    <td className="py-2 truncate max-w-xs" title={c.name}>{c.name || '(unnamed)'}</td>
                    <td className="py-2">{c.platform}</td>
                    <td className="py-2 text-right tabular-nums">{c.conversions.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{fmtMoney(c.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="text-xs text-charcoal/40 pt-2">
        Sales Daily: {data.rawSalesRowCount.toLocaleString()} rows · Marketing Daily:{' '}
        {data.rawMarketingRowCount.toLocaleString()} rows · Campaigns:{' '}
        {data.rawCampaignRowCount.toLocaleString()} rows
      </div>
    </div>
  );
}

/* ===== Sub-components ===== */

function Kpi({ label, value, subtext }: { label: string; value: string; subtext: string }) {
  return (
    <div className="rounded-lg border border-warm-gray/40 bg-warm-white p-4">
      <div className="text-xs uppercase tracking-wide text-charcoal/50 mb-1">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-charcoal/60 mt-1">{subtext}</div>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-warm-gray/40 bg-warm-white">
      <div className="px-4 pt-4 pb-2 border-b border-warm-gray/30">
        <div className="text-base font-semibold">{title}</div>
        {subtitle && <div className="text-xs text-charcoal/60 mt-0.5">{subtitle}</div>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Empty({ subtitle = 'No data in this window.' }: { subtitle?: string }) {
  return <div className="text-sm text-charcoal/50 py-6 text-center">{subtitle}</div>;
}

function ShareBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="flex items-center gap-2 justify-end">
      <div className="w-16 h-2 bg-warm-gray/40 rounded-full overflow-hidden">
        <div className="h-full bg-indigo" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-charcoal/70 w-10 text-right">{pct.toFixed(0)}%</span>
    </div>
  );
}

/* =====================================================================
   Daily trend stack — three single-metric bar charts sharing an X axis
   =====================================================================
   Why three separate small charts and not one combined view: revenue
   and spend are on totally different magnitudes (~$10K vs ~$200/day),
   so any combined chart either makes spend invisible (single y-axis)
   or makes the lines visually misleading (dual y-axis). Three stacked
   single-metric charts let each metric have its own scale, while the
   shared X axis still lets the eye compare any given day across all
   three.

   Layout:
     Daily Net Revenue   (indigo bars)
     Daily Marketing Spend (ironclad bars)
     Daily ROAS          (sage bars, 1.0x reference line)
   ===================================================================== */

function DailyTrendStack({
  points,
}: {
  points: { date: string; revenue: number; spend: number; conversionValue: number }[];
}) {
  if (points.length === 0) return <Empty />;

  // X-axis label cadence — at most ~8 labels regardless of window size.
  const maxXLabels = 8;
  const stride = Math.max(1, Math.ceil(points.length / maxXLabels));
  const xLabelMask = points.map((_, idx) => idx % stride === 0 || idx === points.length - 1);

  const revData = points.map((p) => p.revenue);
  const spendData = points.map((p) => p.spend);
  // Daily ROAS uses the same numerator/denominator as the Blended ROAS KPI:
  // total marketing-attributed conversion value ÷ marketing spend. Days with
  // zero spend show as 0 (no bar) — they're not "bad ROAS," they're "no ad
  // activity." The reference line at 1.0x is the break-even threshold.
  const roasData = points.map((p) => (p.spend > 0 ? p.conversionValue / p.spend : 0));

  return (
    <div className="space-y-5">
      <SingleMetricBars
        title="Net Revenue"
        values={revData}
        dates={points.map((p) => p.date)}
        showXLabels={true}
        xLabelMask={xLabelMask}
        barFill="#4A5490"
        formatY={fmtMoneyCompact}
      />
      <SingleMetricBars
        title="Marketing Spend"
        values={spendData}
        dates={points.map((p) => p.date)}
        showXLabels={true}
        xLabelMask={xLabelMask}
        barFill="#B63B38"
        formatY={fmtMoneyCompact}
      />
      <SingleMetricBars
        title="Daily ROAS"
        subtitle="Conversion value ÷ spend (paid + email/SMS attribution). Bar above 1.0x = profitable on attributed revenue."
        values={roasData}
        dates={points.map((p) => p.date)}
        showXLabels={true}
        xLabelMask={xLabelMask}
        barFill="#7F8B6C"
        formatY={(v) => `${v.toFixed(1)}x`}
        referenceY={1}
        referenceLabel="break-even (1.0x)"
      />
    </div>
  );
}

/**
 * One bar per data point, fixed Y axis from 0 to a "nice" ceiling. Renders
 * as SVG so it scales cleanly across viewports without a chart library.
 */
function SingleMetricBars({
  title,
  subtitle,
  values,
  dates,
  showXLabels,
  xLabelMask,
  barFill,
  formatY,
  referenceY,
  referenceLabel,
}: {
  title: string;
  subtitle?: string;
  values: number[];
  dates: string[];
  showXLabels: boolean;
  xLabelMask: boolean[];
  barFill: string;
  formatY: (v: number) => string;
  referenceY?: number;
  referenceLabel?: string;
}) {
  const W = 820;
  const H = showXLabels ? 150 : 120;
  const padTop = 14;
  const padBottom = showXLabels ? 26 : 8;
  const padLeft = 64;
  const padRight = 16;
  const chartW = W - padLeft - padRight;
  const chartH = H - padTop - padBottom;

  const rawMax = Math.max(...values, referenceY ?? 0);
  const yMax = niceCeiling(rawMax || 1);
  const barGap = 1;
  const barW = Math.max(1.5, chartW / values.length - barGap);

  const yTicks = [0, 0.5, 1].map((t) => ({
    pct: t,
    y: padTop + chartH - t * chartH,
    label: formatY(t * yMax),
  }));

  const refY = referenceY !== undefined ? padTop + chartH - (referenceY / yMax) * chartH : null;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <div>
          <span className="text-sm font-semibold text-charcoal">{title}</span>
          {subtitle && <span className="text-xs text-charcoal/60 ml-2">{subtitle}</span>}
        </div>
        <span className="text-xs text-charcoal/50 tabular-nums">max: {formatY(yMax)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block">
        {/* Y gridlines (0 / 50% / 100%) */}
        {yTicks.map((t) => (
          <g key={`tick-${t.pct}`}>
            <line
              x1={padLeft}
              x2={W - padRight}
              y1={t.y}
              y2={t.y}
              stroke="#D3CEC4"
              strokeDasharray={t.pct === 0 ? undefined : '2 4'}
              strokeWidth={t.pct === 0 ? 1 : 0.6}
            />
            <text x={padLeft - 6} y={t.y + 4} textAnchor="end" fontSize="10" fill="#1F2337" opacity={0.6}>
              {t.label}
            </text>
          </g>
        ))}

        {/* Optional reference line (e.g. 1.0x ROAS break-even) */}
        {refY !== null && (
          <g>
            <line x1={padLeft} x2={W - padRight} y1={refY} y2={refY} stroke="#1F2337" strokeWidth={0.8} strokeDasharray="3 3" opacity={0.5} />
            {referenceLabel && (
              <text x={W - padRight} y={refY - 4} textAnchor="end" fontSize="9" fill="#1F2337" opacity={0.6}>
                {referenceLabel}
              </text>
            )}
          </g>
        )}

        {/* Bars */}
        {values.map((v, i) => {
          const barHeight = (v / yMax) * chartH;
          const xPos = padLeft + (i * chartW) / values.length;
          const yPos = padTop + chartH - barHeight;
          return (
            <rect
              key={`bar-${i}`}
              x={xPos}
              y={yPos}
              width={barW}
              height={Math.max(0, barHeight)}
              fill={barFill}
              opacity={0.85}
            >
              <title>{`${dates[i]}: ${formatY(v)}`}</title>
            </rect>
          );
        })}

        {/* X axis labels — only on the bottom chart */}
        {showXLabels &&
          dates.map((d, i) =>
            xLabelMask[i] ? (
              <text
                key={`xlab-${d}`}
                x={padLeft + (i * chartW) / dates.length + barW / 2}
                y={H - 8}
                textAnchor="middle"
                fontSize="10"
                fill="#1F2337"
                opacity={0.6}
              >
                {fmtDateShort(d)}
              </text>
            ) : null,
          )}
      </svg>
    </div>
  );
}

/* ===== formatters ===== */

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

function fmtMoneyCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

function fmtDateShort(iso: string): string {
  // YYYY-MM-DD → "May 7"
  const d = parseLocalIsoDate(iso);
  if (!d) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtDateLong(iso: string): string {
  const d = parseLocalIsoDate(iso);
  if (!d) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function parseLocalIsoDate(iso: string): Date | null {
  if (!iso) return null;
  const parts = iso.slice(0, 10).split('-');
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  // Local date — avoids the timezone-shift bug that comes from `new Date('2026-05-07')`,
  // which would otherwise be parsed as UTC midnight and may render as the previous day
  // for users west of UTC.
  return new Date(y, m - 1, d);
}

/** Round n UP to a "nice" axis ceiling (1, 2, 2.5, 5, 10, ...) at the right magnitude. */
function niceCeiling(n: number): number {
  if (n <= 0) return 1;
  const exp = Math.floor(Math.log10(n));
  const f = n / Math.pow(10, exp);
  let nf: number;
  if (f <= 1) nf = 1;
  else if (f <= 2) nf = 2;
  else if (f <= 2.5) nf = 2.5;
  else if (f <= 5) nf = 5;
  else nf = 10;
  return nf * Math.pow(10, exp);
}
