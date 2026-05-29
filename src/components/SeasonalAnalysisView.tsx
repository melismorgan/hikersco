'use client';

import { useMemo, useState } from 'react';
// Types come from the server module — `import type` keeps it tree-shakable
// and never drags googleapis into the client bundle.
import type {
  SeasonalAnalysisData,
  EventYearRow,
  EventYoY,
  CurrentSkuVelocity,
} from '@/lib/seasonal-analysis';
// Runtime values (SEASONAL_EVENTS) live in the client-safe module that has
// no Node-only deps. Importing them from /lib/seasonal-analysis would pull
// in googleapis transitively → 'net' module-not-found in browser.
import { SEASONAL_EVENTS } from '@/lib/seasonal-events';

interface Props {
  data: SeasonalAnalysisData;
}

type ViewTab = 'overview' | 'seasons' | 'forecast' | 'method';
type SortDir = 'asc' | 'desc';
type SkuSortKey = 'sku' | 'style' | 'color' | 'size' | 'velocity' | 'recentRevenue' | 'recommendedQty';
type MultiplierMode = 'latest' | 'weighted' | 'avg';

export function SeasonalAnalysisView({ data }: Props) {
  const [tab, setTab] = useState<ViewTab>('overview');

  return (
    <div>
      {/* Tabs */}
      <div className="border-b border-warm-gray/40 mb-6 flex items-center gap-1 flex-wrap">
        <TabButton current={tab} value="overview" onSelect={setTab}>Overview</TabButton>
        <TabButton current={tab} value="seasons" onSelect={setTab}>Seasonal Analysis</TabButton>
        <TabButton current={tab} value="forecast" onSelect={setTab}>Per-SKU Forecast</TabButton>
        <TabButton current={tab} value="method" onSelect={setTab}>Methodology</TabButton>
        <div className="ml-auto text-xs text-charcoal/50 px-2 tabular-nums">
          as of {data.asOf} · {data.rowsScanned.toLocaleString()} rows · {data.yearsAvailable.length} years
        </div>
      </div>

      {tab === 'overview' && <OverviewView data={data} />}
      {tab === 'seasons' && <SeasonsView data={data} />}
      {tab === 'forecast' && <ForecastView data={data} />}
      {tab === 'method' && <MethodView />}
    </div>
  );
}

/* ====================================================================
   TAB: OVERVIEW
   ==================================================================== */

function OverviewView({ data }: { data: SeasonalAnalysisData }) {
  const { totals, channels, monthlyTrend, upcomingEvents } = data;
  return (
    <div className="space-y-6">
      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi
          label="Last 12 mo revenue"
          value={fmtMoney(totals.last12moRevenue)}
          subtext={`${totals.last12moUnits.toLocaleString()} units`}
        />
        <Kpi
          label="YoY revenue change"
          value={totals.yoyChange !== null ? fmtPct(totals.yoyChange) : '—'}
          subtext={
            totals.yoyChange !== null
              ? `vs. prior 12 mo (${fmtMoney(totals.priorYearRevenue)})`
              : 'no prior year in history'
          }
          tone={
            totals.yoyChange === null ? 'neutral'
              : totals.yoyChange > 0 ? 'positive'
                : 'negative'
          }
        />
        <Kpi
          label="Top channel"
          value={totals.topChannel}
          subtext={`${(totals.topChannelShare * 100).toFixed(0)}% of T12M revenue`}
        />
        <Kpi
          label="Channels tracked"
          value={String(channels.length)}
          subtext={channels.map((c) => c.channel).join(' · ')}
        />
      </div>

      {/* 24-month trend */}
      <Card title="Revenue trend — last 24 months" subtitle="Stacked by channel, monthly buckets">
        {monthlyTrend.every((p) => p.total === 0) ? (
          <Empty subtitle="Sales History tab is empty. Run setupSalesHistoryBackfill() in Apps Script." />
        ) : (
          <MonthlyStackedBars points={monthlyTrend} />
        )}
      </Card>

      {/* Channel mix */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {channels.map((c) => (
          <ChannelTile key={c.channel} channel={c.channel} revenue={c.revenue} units={c.units} share={c.share} />
        ))}
        {channels.length === 0 && (
          <div className="md:col-span-3"><Empty /></div>
        )}
      </div>

      {/* Upcoming events */}
      <Card title="Upcoming events" subtitle="From the Events tab in the workbook">
        {upcomingEvents.length === 0 ? (
          <Empty subtitle="No events scheduled. Add rows on the Events tab to see them here." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-charcoal/60 border-b border-warm-gray/40">
                <th className="py-2 font-normal">Date</th>
                <th className="py-2 font-normal">Type</th>
                <th className="py-2 font-normal">Name</th>
                <th className="py-2 font-normal">Channels</th>
                <th className="py-2 font-normal">Linked SKUs</th>
                <th className="py-2 font-normal text-right">Expected Units</th>
              </tr>
            </thead>
            <tbody>
              {upcomingEvents.map((e, i) => (
                <tr key={`${e.date}-${i}`} className="border-b border-warm-gray/20 last:border-b-0">
                  <td className="py-2 tabular-nums">{e.date}</td>
                  <td className="py-2">{e.type}</td>
                  <td className="py-2 font-medium">{e.name}</td>
                  <td className="py-2 text-charcoal/70">{e.channels}</td>
                  <td className="py-2 text-charcoal/70 text-xs">{e.linkedParents}</td>
                  <td className="py-2 text-right tabular-nums">{e.expectedUnits || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

/* ====================================================================
   TAB: SEASONAL ANALYSIS
   ==================================================================== */

function SeasonsView({ data }: { data: SeasonalAnalysisData }) {
  const [eventKey, setEventKey] = useState<string>(SEASONAL_EVENTS[0].key);
  const event = data.events.find((e) => e.key === eventKey);
  const campaigns = data.campaignsByEvent[eventKey] ?? [];

  return (
    <div className="space-y-6">
      <Card title="Year-over-year event comparison">
        <div className="mb-4 flex items-center gap-3 flex-wrap">
          <label className="text-sm text-charcoal/70">Event:</label>
          <select
            value={eventKey}
            onChange={(e) => setEventKey(e.target.value)}
            className="border border-warm-gray/50 rounded-md px-2 py-1 text-sm bg-warm-white"
          >
            {SEASONAL_EVENTS.map((e) => (
              <option key={e.key} value={e.key}>{e.name}</option>
            ))}
          </select>
        </div>

        {!event || event.years.length === 0 ? (
          <Empty subtitle="No completed event windows in the data yet." />
        ) : (
          <>
            <YoYBars years={event.years} />
            <div className="mt-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-charcoal/60 border-b border-warm-gray/40">
                    <th className="py-2 font-normal">Year</th>
                    <th className="py-2 font-normal">Window</th>
                    <th className="py-2 font-normal">Source</th>
                    <th className="py-2 font-normal">Sale active</th>
                    <th className="py-2 font-normal text-right">Units</th>
                    <th className="py-2 font-normal text-right">Revenue</th>
                    <th className="py-2 font-normal text-right">Organic baseline</th>
                    <th className="py-2 font-normal text-right w-20">Multiplier</th>
                    <th className="py-2 font-normal text-right w-24">Lift vs baseline</th>
                  </tr>
                </thead>
                <tbody>
                  {event.years.map((y) => (
                    <YearRow key={y.year} y={y} />
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-charcoal/55 leading-relaxed">
                <span className="inline-block w-2 h-2 rounded-sm bg-indigo align-middle mr-1.5" /> Campaign-anchored window — matched promotional sends defined the window.
                <span className="inline-block w-2 h-2 rounded-sm bg-warm-gray align-middle ml-3 mr-1.5" /> Calendar fallback — no matched campaigns ran.
                <br />
                <strong className="text-charcoal/70">Sale active</strong> combines two signals tuned to how HIKERS actually runs sales: ≥10% per-SKU avg-price drop on ≥30% of Shopify window units (catches Launchpad price changes), and any Events-tab row of Type=Promo overlapping the window (manual ground truth for theme-only swaps). Click the badge for signal detail.
                <br />
                <strong className="text-indigo">Multiplier</strong> = (event total ÷ window length) ÷ daily baseline. This is the metric that travels across years even when window length and total revenue look incomparable — and it&apos;s what powers the forecast tab. Use it instead of raw revenue when comparing events year over year.
                <br />
                <em>Baseline</em> excludes any day with a campaign send anywhere on the calendar, so it reflects an organic, no-promo run-rate.
              </p>
            </div>
          </>
        )}
      </Card>

      <Card title="Email + SMS campaigns inside this event's most recent window"
        subtitle="Klaviyo + Postscript sends overlaid on the picked event window">
        {campaigns.length === 0 ? (
          <Empty subtitle="No campaigns landed in this window — or the Campaigns tab is still being backfilled." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-charcoal/60 border-b border-warm-gray/40">
                <th className="py-2 font-normal">Send date</th>
                <th className="py-2 font-normal">Platform</th>
                <th className="py-2 font-normal">Type</th>
                <th className="py-2 font-normal">Name</th>
                <th className="py-2 font-normal text-right">Recipients</th>
                <th className="py-2 font-normal text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c, i) => (
                <tr key={`${c.sendDate}-${c.name}-${i}`} className="border-b border-warm-gray/20 last:border-b-0">
                  <td className="py-2 tabular-nums">{c.sendDate}</td>
                  <td className="py-2">{c.platform}</td>
                  <td className="py-2 text-charcoal/70">{c.type}</td>
                  <td className="py-2 font-medium">{c.name}</td>
                  <td className="py-2 text-right tabular-nums">{c.recipients.toLocaleString()}</td>
                  <td className="py-2 text-right tabular-nums">{fmtMoney(c.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

/* ====================================================================
   TAB: PER-SKU FORECAST
   ==================================================================== */

/**
 * Per-SKU forecast using the multiplier × current-velocity × window math.
 *
 * forecast_units = current_daily_velocity × event_multiplier × planned_window_days × buffer
 *
 * Why this formula over raw YoY units:
 *  - current_daily_velocity captures TODAY's brand reality (more SKUs, bigger
 *    list, improved site) without any explicit growth knob.
 *  - event_multiplier (event daily rev ÷ baseline daily rev, averaged across
 *    years) is an intensive metric that travels across years even when window
 *    length and total revenue vary year-over-year.
 *  - planned_window_days is what YOU decide for this year's run — keeps the
 *    "how long are we running this" decision explicit.
 *  - buffer is unchanged: stockout protection on top of the central estimate.
 */
function ForecastView({ data }: { data: SeasonalAnalysisData }) {
  const [eventKey, setEventKey] = useState<string>(SEASONAL_EVENTS[0].key);
  const [multiplierMode, setMultiplierMode] = useState<MultiplierMode>('weighted');
  const [buffer, setBuffer] = useState<number>(1.2);
  const [sortKey, setSortKey] = useState<SkuSortKey>('recommendedQty');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const event: EventYoY | undefined = data.events.find((e) => e.key === eventKey);
  const [plannedWindowDays, setPlannedWindowDays] = useState<number>(event?.calendarWindowDays ?? 14);

  // When event changes, reset planned window to that event's calendar length.
  // useMemo dependency makes this update without flicker.
  const defaultedWindow = useMemo(() => event?.calendarWindowDays ?? 14, [event]);
  // (We don't auto-sync plannedWindowDays from defaultedWindow on every render
  // because Melissa might want to override it. She re-picks event → window
  // resets to the calendar default. Good UX trade-off.)

  const chosenMultiplier = useMemo(() => {
    if (!event) return null;
    if (multiplierMode === 'latest') return event.multipliers.latestYear;
    if (multiplierMode === 'weighted') return event.multipliers.recencyWeighted;
    return event.multipliers.allYearsAvg;
  }, [event, multiplierMode]);

  const forecastRows = useMemo(() => {
    const rows = data.currentSkuVelocity.map((s) => {
      const central = chosenMultiplier !== null
        ? s.dailyVelocity * chosenMultiplier * plannedWindowDays
        : null;
      const recommended = central !== null
        ? Math.ceil((central * buffer) / 25) * 25
        : null;
      return { ...s, central, recommended };
    });
    const sorted = [...rows].sort((a, b) => compareRowsV2(a, b, sortKey));
    if (sortDir === 'asc') sorted.reverse();
    return sorted;
  }, [data.currentSkuVelocity, chosenMultiplier, plannedWindowDays, buffer, sortKey, sortDir]);

  return (
    <div className="space-y-6">
      <Card
        title="Per-SKU forecast (current velocity × event multiplier × window)"
        subtitle="Multiplier-based math handles brand growth, calendar drift, and new SKUs without an explicit growth knob — today's velocity is the input."
      >
        <div className="mb-4 flex items-center gap-4 flex-wrap text-sm">
          <label className="flex items-center gap-2">
            <span className="text-charcoal/70">Event:</span>
            <select
              value={eventKey}
              onChange={(e) => {
                setEventKey(e.target.value);
                const nextEvt = data.events.find((ev) => ev.key === e.target.value);
                if (nextEvt) setPlannedWindowDays(nextEvt.calendarWindowDays);
              }}
              className="border border-warm-gray/50 rounded-md px-2 py-1 bg-warm-white"
            >
              {SEASONAL_EVENTS.map((e) => (
                <option key={e.key} value={e.key}>{e.name}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-charcoal/70">Multiplier source:</span>
            <select
              value={multiplierMode}
              onChange={(e) => setMultiplierMode(e.target.value as MultiplierMode)}
              className="border border-warm-gray/50 rounded-md px-2 py-1 bg-warm-white"
            >
              <option value="latest">Latest year only</option>
              <option value="weighted">Recency-weighted (default)</option>
              <option value="avg">All-years simple average</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-charcoal/70">Planned window:</span>
            <select
              value={plannedWindowDays}
              onChange={(e) => setPlannedWindowDays(Number(e.target.value))}
              className="border border-warm-gray/50 rounded-md px-2 py-1 bg-warm-white"
            >
              {[5, 7, 10, 14, 18, 21, 28].map((d) => (
                <option key={d} value={d}>{d} days{d === defaultedWindow ? ' (calendar default)' : ''}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-charcoal/70">Buffer:</span>
            <select
              value={buffer}
              onChange={(e) => setBuffer(Number(e.target.value))}
              className="border border-warm-gray/50 rounded-md px-2 py-1 bg-warm-white"
            >
              <option value={1.0}>none (1.0×)</option>
              <option value={1.1}>10% (1.1×)</option>
              <option value={1.15}>15% (1.15×)</option>
              <option value={1.2}>20% (1.2×)</option>
              <option value={1.25}>25% (1.25×)</option>
              <option value={1.3}>30% (1.3×)</option>
            </select>
          </label>
        </div>

        {/* Multiplier summary panel */}
        {event && (
          <div className="mb-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <MultiplierTile
              label="Latest year"
              value={event.multipliers.latestYear}
              active={multiplierMode === 'latest'}
              detail={event.multipliers.perYear.length
                ? `${event.multipliers.perYear[event.multipliers.perYear.length - 1].year}`
                : '—'}
            />
            <MultiplierTile
              label="Recency-weighted"
              value={event.multipliers.recencyWeighted}
              active={multiplierMode === 'weighted'}
              detail="latest ×3, prior ×2, older ×1"
            />
            <MultiplierTile
              label="All-years average"
              value={event.multipliers.allYearsAvg}
              active={multiplierMode === 'avg'}
              detail={event.multipliers.perYear.length
                ? `${event.multipliers.perYear.length} year${event.multipliers.perYear.length === 1 ? '' : 's'} of data`
                : 'no data'}
            />
            <div className="rounded-md border border-indigo/40 bg-indigo/5 px-3 py-2.5 flex flex-col justify-center">
              <div className="text-[10px] uppercase tracking-wide text-indigo/80 font-semibold">Active forecast multiplier</div>
              <div className="text-lg font-semibold text-indigo tabular-nums">
                {chosenMultiplier !== null ? chosenMultiplier.toFixed(2) + '×' : '—'}
              </div>
              <div className="text-[11px] text-charcoal/60">applied to every SKU</div>
            </div>
          </div>
        )}

        {!event || chosenMultiplier === null || data.currentSkuVelocity.length === 0 ? (
          <Empty subtitle={
            !event
              ? 'No event selected.'
              : chosenMultiplier === null
                ? 'No multiplier data available for this event yet — need at least one completed prior year with an organic baseline.'
                : 'No recent velocity data — Sales History may be empty or all recent days had campaign sends (no organic days to measure).'
          } />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-charcoal/60 border-b border-warm-gray/40">
                  <SortHeader k="style" cur={sortKey} dir={sortDir} setKey={setSortKey} setDir={setSortDir}>Style</SortHeader>
                  <SortHeader k="color" cur={sortKey} dir={sortDir} setKey={setSortKey} setDir={setSortDir}>Color</SortHeader>
                  <SortHeader k="size" cur={sortKey} dir={sortDir} setKey={setSortKey} setDir={setSortDir}>Size</SortHeader>
                  <SortHeader k="sku" cur={sortKey} dir={sortDir} setKey={setSortKey} setDir={setSortDir}>SKU</SortHeader>
                  <SortHeader k="velocity" cur={sortKey} dir={sortDir} setKey={setSortKey} setDir={setSortDir} align="right">Current daily velocity</SortHeader>
                  <SortHeader k="recentRevenue" cur={sortKey} dir={sortDir} setKey={setSortKey} setDir={setSortDir} align="right">30d organic revenue</SortHeader>
                  <SortHeader k="recommendedQty" cur={sortKey} dir={sortDir} setKey={setSortKey} setDir={setSortDir} align="right">Recommended order</SortHeader>
                </tr>
              </thead>
              <tbody>
                {forecastRows.slice(0, 250).map((r) => (
                  <tr key={r.sku} className="border-b border-warm-gray/20 last:border-b-0">
                    <td className="py-1.5">{r.style}</td>
                    <td className="py-1.5">{r.color}</td>
                    <td className="py-1.5">{r.size}</td>
                    <td className="py-1.5 font-mono text-xs text-charcoal/80">{r.sku}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {r.dailyVelocity.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      <span className="text-[10px] text-charcoal/50 ml-1">/day</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{fmtMoney(r.recentRevenue)}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold text-indigo">
                      {r.recommended !== null ? r.recommended.toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {forecastRows.length > 250 && (
              <div className="text-xs text-charcoal/50 mt-2 text-center">
                Showing top 250 of {forecastRows.length} SKUs by sort. Recommend ordering by recommended-order desc to plan from the largest buys down.
              </div>
            )}
            <p className="mt-3 text-xs text-charcoal/55 leading-relaxed">
              <strong>Formula:</strong> recommended_qty = current_daily_velocity × {chosenMultiplier?.toFixed(2)}× event multiplier × {plannedWindowDays} days × {buffer.toFixed(2)} buffer, rounded up to nearest 25.
              Current daily velocity is the trailing 30-day organic-day average per SKU. SKUs that didn&apos;t sell organically in the last 30 days are excluded (no velocity signal to multiply against — treat as manual additions).
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

function compareRowsV2(
  a: { dailyVelocity: number; recentRevenue: number; recommended: number | null; sku: string; style: string; color: string; size: string },
  b: typeof a,
  key: SkuSortKey,
): number {
  switch (key) {
    case 'velocity': return b.dailyVelocity - a.dailyVelocity;
    case 'recentRevenue': return b.recentRevenue - a.recentRevenue;
    case 'recommendedQty': return (b.recommended ?? -1) - (a.recommended ?? -1);
    case 'sku': return a.sku.localeCompare(b.sku);
    case 'style': return a.style.localeCompare(b.style);
    case 'color': return a.color.localeCompare(b.color);
    case 'size': return a.size.localeCompare(b.size);
    // Legacy keys 'units'/'revenue' aren't used here; treat as no-op.
    default: return 0;
  }
}

function MultiplierTile({
  label, value, active, detail,
}: { label: string; value: number | null; active: boolean; detail: string }) {
  return (
    <div className={'rounded-md border px-3 py-2.5 flex flex-col justify-center ' +
      (active ? 'border-indigo/60 bg-indigo/10' : 'border-warm-gray/40 bg-warm-white')}>
      <div className={'text-[10px] uppercase tracking-wide font-semibold ' + (active ? 'text-indigo/80' : 'text-charcoal/60')}>{label}</div>
      <div className={'text-lg font-semibold tabular-nums ' + (active ? 'text-indigo' : 'text-charcoal')}>
        {value !== null ? value.toFixed(2) + '×' : '—'}
      </div>
      <div className="text-[11px] text-charcoal/55">{detail}</div>
    </div>
  );
}

/**
 * One row of the YoY table. Renders the source badge (campaign vs calendar)
 * and a collapsed-by-default disclosure of the matched campaign sends so
 * Melissa can sanity-check what the loader inferred for that year.
 */
function YearRow({ y }: { y: EventYearRow }) {
  const [open, setOpen] = useState<'none' | 'campaigns' | 'sale'>('none');
  const isCampaign = y.windowSource === 'campaign';
  const sourceClass = isCampaign
    ? 'bg-indigo/10 text-indigo'
    : 'bg-warm-gray/40 text-charcoal/70';
  const sourceLabel = isCampaign
    ? `${y.matchedCampaigns.length} matched send${y.matchedCampaigns.length === 1 ? '' : 's'}`
    : 'calendar fallback';

  const saleActive = y.sale.active;
  const saleSignalLabels = y.sale.signals.map((s) =>
    s.kind === 'discount' ? 'discount' : s.kind === 'pricedrop' ? 'price drop' : 'events tab'
  );
  const saleClass = saleActive
    ? 'bg-sage/15 text-sage'
    : 'bg-warm-gray/30 text-charcoal/55';

  const toggle = (which: 'campaigns' | 'sale') =>
    setOpen((cur) => (cur === which ? 'none' : which));

  return (
    <>
      <tr className="border-b border-warm-gray/20 last:border-b-0">
        <td className="py-2 font-medium">{y.year}</td>
        <td className="py-2 text-charcoal/70 tabular-nums">{y.windowStart} → {y.windowEnd}</td>
        <td className="py-2">
          <button
            type="button"
            onClick={() => isCampaign && toggle('campaigns')}
            className={'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium ' + sourceClass + (isCampaign ? ' hover:opacity-80 cursor-pointer' : ' cursor-default')}
            disabled={!isCampaign}
            title={isCampaign ? 'Click to see matched campaigns' : 'No matched campaigns; fixed calendar range used'}
          >
            {sourceLabel}
            {isCampaign && <span className={'text-[10px] ' + (open === 'campaigns' ? 'rotate-180' : '') + ' transition-transform'}>▾</span>}
          </button>
        </td>
        <td className="py-2">
          <button
            type="button"
            onClick={() => saleActive && toggle('sale')}
            className={'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium ' + saleClass + (saleActive ? ' hover:opacity-80 cursor-pointer' : ' cursor-default')}
            disabled={!saleActive}
            title={saleActive ? 'Click to see how we know the sale was live' : 'No sale signals detected — promo may have been theme-only with no price change and no Events-tab entry'}
          >
            {saleActive ? '✓ ' + saleSignalLabels.join(' + ') : '— none'}
            {saleActive && <span className={'text-[10px] ' + (open === 'sale' ? 'rotate-180' : '') + ' transition-transform'}>▾</span>}
          </button>
        </td>
        <td className="py-2 text-right tabular-nums">{y.units.toLocaleString()}</td>
        <td className="py-2 text-right tabular-nums">{fmtMoney(y.revenue)}</td>
        <td className="py-2 text-right tabular-nums text-charcoal/70">{fmtMoney(y.baseline)}/day</td>
        <td className="py-2 text-right tabular-nums font-medium text-indigo">
          {y.dailyMultiplier !== null ? y.dailyMultiplier.toFixed(2) + '×' : '—'}
        </td>
        <td className={'py-2 text-right tabular-nums font-medium ' + liftToneClass(y.lift)}>
          {fmtPct(y.lift)}
        </td>
      </tr>
      {open === 'campaigns' && isCampaign && (
        <tr className="bg-warm-tint/30">
          <td colSpan={9} className="px-3 py-3">
            <div className="text-xs text-charcoal/60 mb-2 font-medium uppercase tracking-wide">
              Matched campaigns ({y.matchedCampaigns.length})
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-charcoal/55">
                  <th className="py-1 font-normal">Send date</th>
                  <th className="py-1 font-normal">Platform</th>
                  <th className="py-1 font-normal">Type</th>
                  <th className="py-1 font-normal">Name</th>
                  <th className="py-1 font-normal text-right">Recipients</th>
                  <th className="py-1 font-normal text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {y.matchedCampaigns.map((c, i) => (
                  <tr key={`${c.sendDate}-${c.name}-${i}`}>
                    <td className="py-1 tabular-nums">{c.sendDate}</td>
                    <td className="py-1">{c.platform}</td>
                    <td className="py-1 text-charcoal/70">{c.type}</td>
                    <td className="py-1">{c.name}</td>
                    <td className="py-1 text-right tabular-nums">{c.recipients.toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums">{fmtMoney(c.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
      {open === 'sale' && saleActive && (
        <tr className="bg-sage/5">
          <td colSpan={9} className="px-3 py-3">
            <div className="text-xs text-charcoal/60 mb-2 font-medium uppercase tracking-wide">
              Sale-active signals ({y.sale.signals.length})
            </div>
            <ul className="text-xs space-y-1.5">
              {y.sale.signals.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="font-mono uppercase text-[10px] bg-sage/20 text-sage px-1.5 py-0.5 rounded shrink-0 self-start mt-0.5">
                    {s.kind === 'discount' ? 'discount' : s.kind === 'pricedrop' ? 'launchpad price' : 'events tab'}
                  </span>
                  <span className="text-charcoal/80">{s.detail}</span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

// (compareRows lived here for the legacy ForecastView that used prior-year
// units. Replaced by compareRowsV2 next to the new multiplier-based
// ForecastView.)

function SortHeader({
  k, cur, dir, setKey, setDir, align = 'left', children,
}: {
  k: SkuSortKey;
  cur: SkuSortKey;
  dir: SortDir;
  setKey: (k: SkuSortKey) => void;
  setDir: (d: SortDir) => void;
  align?: 'left' | 'right';
  children: React.ReactNode;
}) {
  const active = k === cur;
  return (
    <th className={'py-2 font-normal ' + (align === 'right' ? 'text-right' : 'text-left')}>
      <button
        type="button"
        className={'cursor-pointer hover:text-indigo ' + (active ? 'text-indigo font-semibold' : '')}
        onClick={() => {
          if (active) setDir(dir === 'desc' ? 'asc' : 'desc');
          else { setKey(k); setDir('desc'); }
        }}
      >
        {children}
        {active && <span className="ml-1 text-[10px]">{dir === 'desc' ? '▼' : '▲'}</span>}
      </button>
    </th>
  );
}

/* ====================================================================
   TAB: METHODOLOGY
   ==================================================================== */

function MethodView() {
  return (
    <div className="space-y-6 max-w-3xl">
      <Card title="How the numbers are computed">
        <div className="prose prose-sm max-w-none space-y-3 text-charcoal">
          <h3 className="font-semibold text-base">Event windows — grounded in actual sends</h3>
          <p>
            The eleven events come from the actual HIKERS Klaviyo + Postscript send history 2024-2026 (sender:
            <code className="bg-warm-beige px-1 rounded text-xs ml-1">support@hikersco.com</code>),
            not from a generic US retail calendar. No Mother&apos;s Day, no Father&apos;s Day, no Back-to-School, no Christmas-week
            campaign — HIKERS skips those. The Mid-June Summer Restock falls on Father&apos;s Day weekend but the messaging is
            restock, not gifting.
          </p>
          <p>
            Each event is anchored either to a moving holiday (Memorial Day = last Mon of May, BFCM = day after Thanksgiving,
            Labor Day = first Mon of Sep, President&apos;s Day = third Mon of Feb) or to a fixed calendar date (4th of July,
            Anniversary = Mar 31, Hauliday = Oct 12, January Clearance = Jan 26, Summer Restock = Jun 15, After-Holiday = Dec 26,
            Free Shipping Deadline = Dec 10). The artifact-side formula matches the actual send dates within ±2 days year over year.
          </p>

          <h3 className="font-semibold text-base">Campaign-anchored windows</h3>
          <p>
            For each event-year pair, the loader first looks for campaigns whose name or subject matches that event&apos;s
            keywords and that sent within ±60 days of the calendar anchor. If any match, the year&apos;s window becomes
            <em> earliest matched send −1 day → fixed calendar window length</em>. That gives the closest possible
            apples-to-apples comparison across years even when HIKERS&apos; marketing calendar drifted (e.g. BFCM pre-ramp
            ran 9 days in 2024, 16 days in 2025). When no matched campaigns exist for a year, the loader falls back to
            the fixed calendar window — visible in the YoY table as the &quot;calendar fallback&quot; badge.
          </p>
          <p>
            <strong>Manual overrides:</strong> the keyword matcher misses some campaigns (older years used different naming
            conventions) and occasionally mis-attributes follow-up sends. The
            <code className="bg-warm-beige px-1 rounded text-xs">Campaign Event Map</code> tab in the workbook lets you set
            an explicit event per campaign. Override values win over the keyword matcher; type
            <code className="bg-warm-beige px-1 rounded text-xs">skip</code> to exclude a campaign from all events. Re-run
            <code className="bg-warm-beige px-1 rounded text-xs">setupCampaignEventMap()</code> in Apps Script after new
            campaigns land to add fresh rows; existing overrides are preserved.
          </p>

          <h3 className="font-semibold text-base">Organic baseline</h3>
          <p>
            Baseline = average daily revenue over the trailing 28 days leading <em>up to</em> the event window —
            <strong> excluding any day where ANY campaign was sent</strong>. That excludes product-launch noise, restock
            announcements, and ad-hoc promos from the &quot;normal day&quot; reference. The resulting lift % is closer to
            &quot;the promotional effect of this event,&quot; not &quot;the event plus everything else that happened to land in the
            same month.&quot;
          </p>

          <h3 className="font-semibold text-base">Event lift</h3>
          <p>
            Lift % = (event-window total ÷ (organic baseline × window-length)) − 1. A lift of +200% means the event
            window did 3× what a comparable stretch of organic days would have done. A near-zero lift on a
            calendar-fallback year means the event probably didn&apos;t happen — not that it failed.
          </p>

          <h3 className="font-semibold text-base">Sale-active detection (two signals)</h3>
          <p>
            The &quot;Sale active&quot; column in the YoY table verifies that a sale was actually live on Shopify during each window,
            using two independent signals tuned to how HIKERS actually runs sales. <strong>Either one</strong> flips it to active:
          </p>
          <ol className="list-decimal ml-6 space-y-1.5 my-2">
            <li><strong>Launchpad price drop</strong> — per-SKU avg unit price during the window vs. trailing 28-day baseline.
              A SKU is flagged if its window avg is ≥10% below its baseline avg (and it sold ≥3 units in both periods).
              The signal fires when flagged SKUs account for ≥30% of total window units. Catches the Launchpad theme/price
              swap that&apos;s HIKERS&apos; standard sale mechanism. Shopify channel only — Amazon prices aren&apos;t controlled by Launchpad.</li>
            <li><strong>Events tab Promo</strong> — any Events tab row of Type=Promo with start/end overlapping the window. Manual
              ground truth for the rare cases where a sale was run with no measurable price change (theme-only swap
              with messaging changes only). Log it on the Events tab, the dashboard reads it.</li>
          </ol>
          <p>
            <strong>Why not a discount-code signal?</strong> HIKERS doesn&apos;t use Shopify discount codes for sale events — sales are run via Launchpad
            price changes instead. The Discount Schedule tab is still synced (interesting data for separate analyses around
            perpetual retention codes and abandoned-cart recovery performance) but isn&apos;t consulted here. If the sale
            mechanism ever changes to code-based, the third signal is easy to wire back in.
          </p>
          <p>
            Neither signal firing means we couldn&apos;t verify a sale was actually live. The campaigns may still have run
            (their email subjects might announce a sale that the detector missed for some reason), but the dashboard can&apos;t
            corroborate it from the data. In those cases the lift number reflects whatever organic seasonal pull the window happened to have,
            not a verified promotional effect.
          </p>

          <h3 className="font-semibold text-base">Per-SKU forecast (multiplier × current velocity × window)</h3>
          <div className="rounded-md bg-sage/10 border-l-4 border-sage px-4 py-3 font-mono text-xs">
            recommended_qty = current_daily_velocity × event_multiplier × planned_window_days × buffer, rounded up to nearest 25
          </div>
          <p>
            <code className="bg-warm-beige px-1 rounded text-xs">current_daily_velocity</code> is each SKU&apos;s trailing 30-day
            organic-day average — today&apos;s reality, captures brand growth and new products automatically. No explicit YoY
            growth knob needed.
          </p>
          <p>
            <code className="bg-warm-beige px-1 rounded text-xs">event_multiplier</code> is the daily-rate multiplier the event
            historically produced vs. its trailing baseline (3-year average by default, recency-weighted). This is the only
            piece that pulls from history, and it&apos;s an intensive metric that travels across years even when window length,
            calendar dates, and total revenue all drift. Switch between latest-year, recency-weighted, and all-years-average
            in the multiplier-source dropdown depending on how much the brand has changed.
          </p>
          <p>
            <code className="bg-warm-beige px-1 rounded text-xs">planned_window_days</code> is what YOU decide — a 14-day BFCM
            ramp produces meaningfully different inventory needs than a 21-day one, and the formula makes that decision explicit.
            <code className="bg-warm-beige px-1 rounded text-xs">buffer</code> protects against stockouts — 20% covers typical
            week-over-week variability inside a high-velocity window.
          </p>
          <p>
            <strong>Why this beats raw YoY:</strong> the brand of 2026 is very different from 2023 (more SKUs, bigger list, better site).
            Naively multiplying 2023 units by a YoY growth rate is fragile. By using current velocity as the input and only
            pulling the multiplier from history, the math automatically accounts for everything that has changed about the
            business while still anchoring expectations to the historical event-vs-baseline pattern.
          </p>

          <h3 className="font-semibold text-base">New SKUs (no prior-year data)</h3>
          <p>
            Not in the table — fall back to a Style+Color analogue (e.g. for a new color of H503-4 Heavy Duty, use last year&apos;s
            same-size H503-4-NGBK or H503-4-BK as a proxy). New-color uplift averages 1.2-1.5× the established-color baseline
            for the first event window.
          </p>

          <h3 className="font-semibold text-base">Data sources</h3>
          <p>
            Sales History tab (per-channel × per-day × per-SKU, 3 years of Shopify + 2 years of Amazon) for revenue/units.
            Campaigns tab for the email overlay. Events tab for upcoming events. All three live in the inventory workbook.
            The page reloads fresh on each request — no caching.
          </p>
        </div>
      </Card>
    </div>
  );
}

/* ====================================================================
   Charts
   ==================================================================== */

function MonthlyStackedBars({ points }: { points: { month: string; shopify: number; amazonFba: number; amazonFbm: number; total: number }[] }) {
  const W = 820;
  const H = 180;
  const padTop = 14;
  const padBottom = 26;
  const padLeft = 64;
  const padRight = 16;
  const chartW = W - padLeft - padRight;
  const chartH = H - padTop - padBottom;

  const rawMax = Math.max(...points.map((p) => p.total), 1);
  const yMax = niceCeiling(rawMax);
  const barGap = 2;
  const barW = Math.max(4, chartW / points.length - barGap);

  const yTicks = [0, 0.5, 1].map((t) => ({
    pct: t,
    y: padTop + chartH - t * chartH,
    label: fmtMoneyCompact(t * yMax),
  }));

  const COLORS = { shopify: '#7A84AC', amazonFba: '#7F8B6C', amazonFbm: '#C98A55' };

  return (
    <div>
      <div className="flex items-center gap-4 text-xs text-charcoal/70 mb-2">
        <LegendDot color={COLORS.shopify} label="Shopify" />
        <LegendDot color={COLORS.amazonFba} label="Amazon-FBA" />
        <LegendDot color={COLORS.amazonFbm} label="Amazon-FBM" />
        <span className="ml-auto text-charcoal/50 tabular-nums">max: {fmtMoneyCompact(yMax)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block">
        {yTicks.map((t) => (
          <g key={`tick-${t.pct}`}>
            <line x1={padLeft} x2={W - padRight} y1={t.y} y2={t.y}
              stroke="#D3CEC4"
              strokeDasharray={t.pct === 0 ? undefined : '2 4'}
              strokeWidth={t.pct === 0 ? 1 : 0.6} />
            <text x={padLeft - 6} y={t.y + 4} textAnchor="end" fontSize="10" fill="#1F2337" opacity={0.6}>
              {t.label}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const xPos = padLeft + (i * chartW) / points.length;
          const yBottom = padTop + chartH;
          const hShop = (p.shopify / yMax) * chartH;
          const hFba = (p.amazonFba / yMax) * chartH;
          const hFbm = (p.amazonFbm / yMax) * chartH;
          return (
            <g key={p.month}>
              <rect x={xPos} y={yBottom - hShop} width={barW} height={Math.max(0, hShop)} fill={COLORS.shopify}>
                <title>{`${p.month} Shopify: ${fmtMoney(p.shopify)}`}</title>
              </rect>
              <rect x={xPos} y={yBottom - hShop - hFba} width={barW} height={Math.max(0, hFba)} fill={COLORS.amazonFba}>
                <title>{`${p.month} Amazon-FBA: ${fmtMoney(p.amazonFba)}`}</title>
              </rect>
              <rect x={xPos} y={yBottom - hShop - hFba - hFbm} width={barW} height={Math.max(0, hFbm)} fill={COLORS.amazonFbm}>
                <title>{`${p.month} Amazon-FBM: ${fmtMoney(p.amazonFbm)}`}</title>
              </rect>
            </g>
          );
        })}
        {/* X labels every 3 months */}
        {points.map((p, i) => (i % 3 === 0 || i === points.length - 1) ? (
          <text key={`xl-${p.month}`}
            x={padLeft + (i * chartW) / points.length + barW / 2}
            y={H - 8}
            textAnchor="middle" fontSize="10" fill="#1F2337" opacity={0.6}>
            {p.month.slice(2)}
          </text>
        ) : null)}
      </svg>
    </div>
  );
}

function YoYBars({ years }: { years: EventYearRow[] }) {
  const W = 820;
  const H = 200;
  const padTop = 14;
  const padBottom = 30;
  const padLeft = 64;
  const padRight = 16;
  const chartW = W - padLeft - padRight;
  const chartH = H - padTop - padBottom;

  const rawMax = Math.max(...years.map((y) => y.revenue), 1);
  const yMax = niceCeiling(rawMax);
  const barGap = 18;
  const barW = Math.max(20, chartW / years.length - barGap);

  const yTicks = [0, 0.5, 1].map((t) => ({
    pct: t,
    y: padTop + chartH - t * chartH,
    label: fmtMoneyCompact(t * yMax),
  }));

  const palette = ['#7A84AC', '#7F8B6C', '#C98A55', '#4A5490', '#B63B38'];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block">
      {yTicks.map((t) => (
        <g key={`tick-${t.pct}`}>
          <line x1={padLeft} x2={W - padRight} y1={t.y} y2={t.y}
            stroke="#D3CEC4"
            strokeDasharray={t.pct === 0 ? undefined : '2 4'}
            strokeWidth={t.pct === 0 ? 1 : 0.6} />
          <text x={padLeft - 6} y={t.y + 4} textAnchor="end" fontSize="10" fill="#1F2337" opacity={0.6}>
            {t.label}
          </text>
        </g>
      ))}
      {years.map((y, i) => {
        const barHeight = (y.revenue / yMax) * chartH;
        const xPos = padLeft + (i * chartW) / years.length + barGap / 2;
        const yPos = padTop + chartH - barHeight;
        const fill = palette[i % palette.length];
        return (
          <g key={y.year}>
            <rect x={xPos} y={yPos} width={barW} height={Math.max(0, barHeight)} fill={fill}>
              <title>{`${y.year}: ${fmtMoney(y.revenue)} · ${y.units.toLocaleString()} units`}</title>
            </rect>
            <text x={xPos + barW / 2} y={H - 14} textAnchor="middle" fontSize="11" fill="#1F2337">
              {y.year}
            </text>
            <text x={xPos + barW / 2} y={yPos - 4} textAnchor="middle" fontSize="9" fill="#1F2337" opacity={0.7}>
              {fmtMoneyCompact(y.revenue)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ====================================================================
   Reusable bits
   ==================================================================== */

function TabButton({
  current, value, onSelect, children,
}: { current: ViewTab; value: ViewTab; onSelect: (v: ViewTab) => void; children: React.ReactNode }) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={
        'px-4 py-2 text-sm border-b-2 -mb-px transition-colors ' +
        (active
          ? 'border-indigo text-indigo font-semibold'
          : 'border-transparent text-charcoal/70 hover:text-indigo')
      }
    >
      {children}
    </button>
  );
}

function Kpi({
  label, value, subtext, tone = 'neutral',
}: { label: string; value: string; subtext?: string; tone?: 'neutral' | 'positive' | 'negative' }) {
  const toneClass = tone === 'positive' ? 'text-sage' : tone === 'negative' ? 'text-ironclad' : 'text-charcoal';
  return (
    <div className="rounded-md border border-warm-gray/40 bg-warm-white p-4">
      <div className="text-xs uppercase tracking-wide text-charcoal/60 font-medium">{label}</div>
      <div className={'text-2xl mt-1 ' + toneClass}>{value}</div>
      {subtext && <div className="text-xs text-charcoal/60 mt-1">{subtext}</div>}
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

function Empty({ subtitle = 'No data.' }: { subtitle?: string }) {
  return <div className="text-sm text-charcoal/50 py-6 text-center">{subtitle}</div>;
}

function ChannelTile({ channel, revenue, units, share }: { channel: string; revenue: number; units: number; share: number }) {
  const isShop = channel === 'Shopify';
  const isFba = channel === 'Amazon-FBA';
  const accent = isShop ? 'border-peri bg-peri/10'
    : isFba ? 'border-sage bg-sage/10'
      : 'border-clay bg-clay/10';
  return (
    <div className={'rounded-md border-l-4 p-4 ' + accent}>
      <div className="text-xs uppercase tracking-wide text-charcoal/60 font-medium">{channel}</div>
      <div className="text-2xl mt-1 font-semibold">{fmtMoney(revenue)}</div>
      <div className="text-xs text-charcoal/60 mt-1">
        {units.toLocaleString()} units · {(share * 100).toFixed(0)}% of T12M
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
      <span>{label}</span>
    </span>
  );
}

/* ====================================================================
   Formatters
   ==================================================================== */

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtMoneyCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

function fmtPct(x: number | null): string {
  if (x == null || !isFinite(x)) return '—';
  return (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
}

function liftToneClass(x: number | null): string {
  if (x == null || !isFinite(x)) return 'text-charcoal/50';
  if (x > 0.05) return 'text-sage';
  if (x < -0.05) return 'text-ironclad';
  return 'text-charcoal/70';
}

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
