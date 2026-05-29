import { readTab } from './sheets';
import { readEvents } from './events';
import {
  SEASONAL_EVENTS,
  eventWindowFor,
  matchCampaignToEvent,
  type SeasonalEvent,
  type SkuPriorYearRow,
} from './seasonal-events';

/**
 * Seasonal Analysis dashboard data loader.
 *
 * Reads the multi-year Sales History tab (per-channel × per-day × per-SKU)
 * plus Campaigns + Events for the same window. Computes:
 *   • 24-month revenue trend (per channel)
 *   • Channel mix (T12M)
 *   • Per-event year-over-year comparison (units, revenue, lift vs baseline)
 *   • Per-event most-recent prior-year per-SKU breakdown (the input the
 *     forecast table needs to compute "recommended order qty")
 *   • Campaign overlay (Klaviyo/Postscript sends inside each event's most
 *     recent prior-year window)
 *   • Upcoming events from the Events tab
 *
 * Everything beyond reading from Sheets happens server-side so the client
 * just renders. The dataset shipped to the browser is ~100-300 KB even for
 * a full 3-year per-SKU history.
 *
 * Why a separate loader from sales-marketing.ts: that one is window-scoped
 * (rolling 90-day cross-channel summary). This one is event-scoped
 * (multi-year per-event comparison with per-SKU detail per event). Different
 * shapes, different consumers — kept independent so neither breaks the
 * other.
 *
 * NB: Runtime values used by the client (SEASONAL_EVENTS, computeForecast,
 * pure date math) live in `./seasonal-events` so they don't drag googleapis
 * into the client bundle. Server-side callers can import either module
 * interchangeably — see the re-exports at the bottom of this file.
 */

const SALES_HISTORY_TAB = 'Sales History';
const CAMPAIGNS_TAB = 'Campaigns';
const CAMPAIGN_EVENT_MAP_TAB = 'Campaign Event Map';

// Sale-active detector thresholds (per Melissa's 2026-05-27 decisions):
// - 10% avg unit price drop flags a SKU as "discounted via Launchpad"
// - 30% of window units must come from discounted SKUs to flag the window
//   as price-dropped. Keeps a narrow-scope SKU sale from false-flagging
//   the whole event.
//
// NB: Signal #1 (Shopify Discount Schedule overlap) was prototyped earlier
// in this file's history but removed because HIKERS doesn't use discount
// codes for SALE events — they use Launchpad to lower listed prices. The
// Discount Schedule tab is still synced by 48_shopify_discount_schedule.gs
// (data is useful for separate discount-code analytics — perpetual
// retention codes like COMEBACK10, abandoned-cart recovery performance,
// etc.) but it's NOT consulted for sale-active detection. Don't re-wire
// it here without confirming HIKERS' sale mechanism has changed.
const SALE_PRICE_DROP_THRESHOLD = 0.10;
const SALE_PRICE_DROP_MIN_UNITS_PER_SKU = 3;
const SALE_PRICE_DROP_MIN_WINDOW_UNIT_SHARE = 0.30;

// Re-export the shared types/values so server-side callers (page route,
// other server modules) have a single import target — `@/lib/seasonal-analysis`.
// Client components must import from `./seasonal-events` directly.
export { SEASONAL_EVENTS, computeForecast, eventWindowFor } from './seasonal-events';
export type { SeasonalEvent, SkuPriorYearRow, ForecastRow } from './seasonal-events';

/* ===== Output shapes ===== */

export interface MonthlyTrendPoint {
  month: string;          // YYYY-MM
  shopify: number;
  amazonFba: number;
  amazonFbm: number;
  total: number;
}

export interface ChannelTotal {
  channel: string;
  revenue: number;
  units: number;
  share: number;          // 0..1 of T12M revenue
}

export interface SaleSignal {
  /** 'pricedrop' — Launchpad-style avg-unit-price drop on Shopify.
   *  'events'    — manual Events-tab Promo row overlapping the window.
   *  ('discount' was kept here for future re-introduction if HIKERS ever
   *  switches to code-based sales; not emitted today.) */
  kind: 'pricedrop' | 'events' | 'discount';
  /** Free-text describing the signal — "X% avg price drop on N SKUs" or
   *  the Events-tab row name. Shown in the UI disclosure. */
  detail: string;
}

export interface SaleStatus {
  /** True if AT LEAST ONE of the three signals fired for this window. */
  active: boolean;
  /** Which signals fired. Multiple can coexist (e.g. discount + pricedrop). */
  signals: SaleSignal[];
}

export interface EventMultipliers {
  /** Multiplier from the most recent year with data — best for "what's the
   *  current pattern" if the brand has changed significantly. */
  latestYear: number | null;
  /** Recency-weighted average: most recent year × 3, next × 2, older × 1.
   *  Default for forecasting — balances current-pattern accuracy against
   *  noise from any single year. */
  recencyWeighted: number | null;
  /** Simple average across all years with data — most conservative,
   *  smooths out any single-year anomalies. */
  allYearsAvg: number | null;
  /** Per-year multipliers for the YoY table display. */
  perYear: { year: number; multiplier: number }[];
}

export interface EventYearRow {
  year: number;
  windowStart: string;
  windowEnd: string;
  /**
   * How the window was determined for this year:
   *   'campaign' — anchored to the actual matched campaign sends (preferred,
   *                gives apples-to-apples comparison even when HIKERS' marketing
   *                calendar drifted year-over-year).
   *   'calendar' — fallback to the calendar-anchored window because no matching
   *                campaigns ran that year (e.g. event didn't happen yet).
   */
  windowSource: 'campaign' | 'calendar';
  /** Campaigns whose name/subject matched this event's keywords inside the
   *  ±60d search radius. Empty when windowSource = 'calendar'. */
  matchedCampaigns: EventCampaignRow[];
  /** Was the sale actually live on Shopify during this window? Combines three
   *  independent signals: discount overlap, per-SKU price-drop detection,
   *  and Events-tab Promo entries. See SaleSignal for the per-signal detail. */
  sale: SaleStatus;
  units: number;
  revenue: number;
  baseline: number;       // daily avg $ over the trailing 28d (organic days only)
  lift: number | null;    // (revenue - baseline*windowLen) / (baseline*windowLen)
  /** Event daily-rate multiplier: (event total ÷ window len) ÷ baseline.
   *  Stable across years even when window length and total revenue vary,
   *  which makes it the right unit for cross-year comparison. Null when
   *  baseline is zero (very early years with no organic-day data). */
  dailyMultiplier: number | null;
}

export interface EventYoY {
  key: string;
  name: string;
  years: EventYearRow[];  // sorted ascending by year
  /** Aggregate event multipliers across years — the input to the forecast
   *  formula. Computed only from years where dailyMultiplier is non-null. */
  multipliers: EventMultipliers;
  /** The event's calendar window length, exposed here so the forecast UI
   *  can default the "planned window" slider to a sensible starting value. */
  calendarWindowDays: number;
}

// SkuPriorYearRow is now defined in ./seasonal-events and re-exported above.

export interface PerSkuByEvent {
  /** Key into SEASONAL_EVENTS. Empty object if no prior-year data. */
  [eventKey: string]: {
    priorYear: number;
    windowStart: string;
    windowEnd: string;
    skus: SkuPriorYearRow[];
  };
}

export interface EventCampaignRow {
  sendDate: string;
  platform: string;
  type: string;            // 'Campaign' | 'Flow'
  name: string;
  recipients: number;
  revenue: number;
}

export interface CurrentSkuVelocity {
  sku: string;
  style: string;
  color: string;
  size: string;
  /** Avg units/day over the last 30 organic days (campaign days excluded).
   *  This is the "what is this SKU doing on a normal day right now" signal —
   *  the basis for forward forecasting that accounts for brand growth, new
   *  SKUs launching, and operational improvements without any explicit
   *  adjustment. */
  dailyVelocity: number;
  /** Total units in the last 30 organic days. */
  recentUnits: number;
  /** Total revenue in the last 30 organic days. */
  recentRevenue: number;
  /** Number of organic days the velocity was computed across (≤ 30). */
  daysCounted: number;
}

export interface UpcomingEventRow {
  date: string;
  type: string;
  name: string;
  channels: string;
  linkedParents: string;
  expectedUnits: string;
}

export interface SeasonalAnalysisData {
  /** End of analysis window — last day with data in Sales History. */
  asOf: string;
  /** Date the loader ran. */
  loadedAt: string;
  /** Number of raw Sales History rows scanned. */
  rowsScanned: number;
  /** Years present in the history. */
  yearsAvailable: number[];

  totals: {
    last12moRevenue: number;
    last12moUnits: number;
    priorYearRevenue: number;     // months 13-24 ago
    yoyChange: number | null;     // (last12 - prior) / prior, decimal
    topChannel: string;           // e.g. 'Amazon-FBA'
    topChannelShare: number;      // 0..1
  };

  channels: ChannelTotal[];
  monthlyTrend: MonthlyTrendPoint[];  // last 24 months
  events: EventYoY[];                 // one entry per SEASONAL_EVENTS member
  perSkuByEvent: PerSkuByEvent;
  /** Per-SKU current daily velocity, sorted descending. Replaces prior-year
   *  units as the basis for the new multiplier-based forecast formula. */
  currentSkuVelocity: CurrentSkuVelocity[];
  campaignsByEvent: Record<string, EventCampaignRow[]>;
  upcomingEvents: UpcomingEventRow[];
}

/* ===== Loader ===== */

export async function loadSeasonalAnalysis(): Promise<SeasonalAnalysisData> {
  const [historyGrid, campaignsGrid, mapGrid, events] = await Promise.all([
    readTab(SALES_HISTORY_TAB).catch(() => [] as string[][]),
    readTab(CAMPAIGNS_TAB).catch(() => [] as string[][]),
    readTab(CAMPAIGN_EVENT_MAP_TAB).catch(() => [] as string[][]),
    readEvents().catch(() => []),
  ]);

  const history = parseSalesHistory(historyGrid);
  const campaigns = parseCampaigns(campaignsGrid);
  // Manual campaign→event mapping (populated by 49_campaign_event_map.gs).
  // Wins over the keyword matcher when present.
  const campaignOverrides = parseCampaignEventMap(mapGrid);
  // Events tab rows of Type='Promo' are the manual ground truth for sales
  // (especially Launchpad theme swaps that leave no other data signal).
  const promoEvents = events
    .filter((e) => (e.type || '').toLowerCase() === 'promo')
    .map((e) => ({
      name: e.name || '',
      start: e.startDate || '',
      end: e.endDate || e.startDate || '',
    }))
    .filter((p) => !!p.start);

  // ---- asOf = max date in history ----
  let asOf = '';
  for (const r of history) if (r.date > asOf) asOf = r.date;
  if (!asOf) asOf = ptToday();   // empty history fallback

  const yearsSet = new Set<number>();
  history.forEach((r) => {
    const y = Number(r.date.slice(0, 4));
    if (!isNaN(y)) yearsSet.add(y);
  });
  const yearsAvailable = Array.from(yearsSet).sort((a, b) => a - b);

  // ---- Monthly trend (last 24 months ending at asOf) ----
  const monthlyTrend = buildMonthlyTrend(history, asOf, 24);

  // ---- Channel totals + KPI numbers ----
  const t12Start = isoDaysAgo(asOf, 365);
  const t24Start = isoDaysAgo(asOf, 730);

  const channelMap = new Map<string, { revenue: number; units: number }>();
  let last12moRevenue = 0;
  let last12moUnits = 0;
  let priorYearRevenue = 0;
  history.forEach((r) => {
    if (r.date >= t12Start && r.date <= asOf) {
      last12moRevenue += r.gross;
      last12moUnits += r.units;
      const acc = channelMap.get(r.channel) ?? { revenue: 0, units: 0 };
      acc.revenue += r.gross;
      acc.units += r.units;
      channelMap.set(r.channel, acc);
    } else if (r.date >= t24Start && r.date < t12Start) {
      priorYearRevenue += r.gross;
    }
  });

  const channels: ChannelTotal[] = Array.from(channelMap.entries())
    .map(([channel, v]) => ({
      channel,
      revenue: round2(v.revenue),
      units: v.units,
      share: last12moRevenue > 0 ? v.revenue / last12moRevenue : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const top = channels[0] ?? { channel: '—', revenue: 0, share: 0, units: 0 };
  const yoyChange = priorYearRevenue > 0
    ? (last12moRevenue - priorYearRevenue) / priorYearRevenue
    : null;

  // ---- Per-event YoY across all years in history ----
  //
  // For each (event, year), find the campaigns that match this event's
  // keyword set AND landed within ±60d of the calendar anchor. If any
  // matched, the year's window is anchored to those sends (earliest send
  // -1d to latest send +3d) — the closest possible apples-to-apples
  // comparison even when HIKERS' marketing calendar drifted year-over-year.
  // If none matched, fall back to the fixed calendar window.
  //
  // Baseline excludes any day where ANY campaign was sent. That makes the
  // baseline reflect organic-day run-rate (not noise from product-launch
  // sends or ad-hoc promotions inside the trailing 28d).
  const campaignSendDays = buildCampaignSendDaySet(campaigns);
  const events_: EventYoY[] = SEASONAL_EVENTS.map((evt) => {
    const years: EventYearRow[] = [];
    yearsAvailable.forEach((y) => {
      const win = resolveEventWindowForYear(evt, y, campaigns, campaignOverrides);
      // Skip windows that haven't ended yet (we don't want partial-window
      // totals competing with completed windows in the YoY chart).
      if (win.end > asOf) return;
      let units = 0;
      let revenue = 0;
      history.forEach((r) => {
        if (r.date >= win.start && r.date < win.end) {
          units += r.units;
          revenue += r.gross;
        }
      });
      // Skip zero-rev years — gives cleaner YoY charts when the brand
      // wasn't fully ramped in early years.
      if (units === 0 && revenue === 0) return;
      const baseline = computeBaselineDailyRev(history, win.start, 28, campaignSendDays);
      const liftDenom = baseline * (win.lengthDays);
      const lift = liftDenom > 0 ? (revenue - liftDenom) / liftDenom : null;
      // Event daily-rate multiplier: how many times higher per day was the
      // event vs. the organic baseline. This is the metric that travels
      // across years even when window length and total revenue vary.
      const eventDailyRev = win.lengthDays > 0 ? revenue / win.lengthDays : 0;
      const dailyMultiplier = baseline > 0 ? eventDailyRev / baseline : null;
      const sale = detectSaleActive(history, promoEvents, win.start, win.end);
      years.push({
        year: y,
        windowStart: win.start,
        windowEnd: win.end,
        windowSource: win.source,
        matchedCampaigns: win.matched,
        sale: sale,
        units,
        revenue: round2(revenue),
        baseline: round2(baseline),
        lift,
        dailyMultiplier: dailyMultiplier !== null ? round2(dailyMultiplier) : null,
      });
    });
    return {
      key: evt.key,
      name: evt.name,
      years,
      multipliers: aggregateMultipliers(years),
      calendarWindowDays: evt.window,
    };
  });

  // ---- Per-event per-SKU breakdown for the most-recent prior-year window ----
  // "Most recent prior year" = the latest completed year for which we have
  // an event window. For January-style events with anchor early in the year,
  // this lands as last year. For events that haven't happened yet in this
  // year, prior year is the most useful comparator.
  const perSkuByEvent: PerSkuByEvent = {};
  SEASONAL_EVENTS.forEach((evt) => {
    const candidateYears = [...yearsAvailable].reverse();
    let chosenYear: number | null = null;
    let chosenWindow: { start: string; end: string } | null = null;
    // Walk most-recent year first; pick the latest year whose window has
    // fully ended AND has either matched campaigns or a calendar fallback
    // that produced data.
    for (const y of candidateYears) {
      const w = resolveEventWindowForYear(evt, y, campaigns, campaignOverrides);
      if (w.end > asOf) continue;  // window hasn't completed yet
      chosenYear = y;
      chosenWindow = w;
      break;
    }
    if (chosenYear === null || chosenWindow === null) return;

    const skuMap = new Map<string, SkuPriorYearRow>();
    history.forEach((r) => {
      if (r.date < chosenWindow!.start || r.date >= chosenWindow!.end) return;
      const existing = skuMap.get(r.sku);
      if (existing) {
        existing.units += r.units;
        existing.revenue += r.gross;
      } else {
        skuMap.set(r.sku, {
          sku: r.sku,
          style: r.style,
          color: r.color,
          size: r.size,
          units: r.units,
          revenue: r.gross,
        });
      }
    });

    const skus = Array.from(skuMap.values())
      .filter((s) => s.units > 0)
      .map((s) => ({ ...s, revenue: round2(s.revenue) }))
      .sort((a, b) => b.units - a.units);

    perSkuByEvent[evt.key] = {
      priorYear: chosenYear,
      windowStart: chosenWindow.start,
      windowEnd: chosenWindow.end,
      skus,
    };
  });

  // ---- Campaigns inside each event's prior-year window ----
  const campaignsByEvent: Record<string, EventCampaignRow[]> = {};
  Object.keys(perSkuByEvent).forEach((evtKey) => {
    const window = perSkuByEvent[evtKey];
    campaignsByEvent[evtKey] = campaigns
      .filter((c) => c.sendDate >= window.windowStart && c.sendDate < window.windowEnd)
      .map((c) => ({
        sendDate: c.sendDate,
        platform: c.platform,
        type: c.type,
        name: c.name,
        recipients: c.recipients,
        revenue: round2(c.revenue),
      }))
      .sort((a, b) => a.sendDate.localeCompare(b.sendDate));
  });

  // ---- Upcoming events (Events tab) ----
  // EventRow.startDate is already ISO 'YYYY-MM-DD' (see lib/events.ts).
  // EventRow.channels is string[] (not string) — join for display.
  // EventRow.expectedUnits is number — render blank when 0.
  const today = ptToday();
  const upcomingEvents: UpcomingEventRow[] = events
    .filter((e) => e.startDate && e.startDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .slice(0, 12)
    .map((e) => ({
      date: e.startDate,
      type: e.type ?? '',
      name: e.name ?? '',
      channels: (e.channels ?? []).join(', '),
      linkedParents: e.linkedParents ?? '',
      expectedUnits: e.expectedUnits ? String(e.expectedUnits) : '',
    }));

  return {
    asOf,
    loadedAt: new Date().toISOString(),
    rowsScanned: history.length,
    yearsAvailable,
    totals: {
      last12moRevenue: round2(last12moRevenue),
      last12moUnits,
      priorYearRevenue: round2(priorYearRevenue),
      yoyChange,
      topChannel: top.channel,
      topChannelShare: top.share,
    },
    channels,
    monthlyTrend,
    events: events_,
    perSkuByEvent,
    currentSkuVelocity: computeCurrentSkuVelocity(history, asOf, campaignSendDays),
    campaignsByEvent,
    upcomingEvents,
  };
}

/* ===== Parsing ===== */

interface SalesHistoryRow {
  date: string;
  channel: string;
  sku: string;
  skuChannel: string;
  style: string;
  color: string;
  size: string;
  units: number;
  gross: number;
  discount: number;
}

/** Sales History cols: A Date · B Channel · C SKU Canonical · D SKU (Channel)
 *  E Style · F Color · G Size · H Units · I Gross Rev · J Discount $ · K Last Updated */
function parseSalesHistory(grid: string[][]): SalesHistoryRow[] {
  if (grid.length < 2) return [];
  return grid.slice(1)
    .map((r) => ({
      date: dateOnly(r[0]),
      channel: String(r[1] ?? ''),
      sku: String(r[2] ?? ''),
      skuChannel: String(r[3] ?? ''),
      style: String(r[4] ?? ''),
      color: String(r[5] ?? ''),
      size: String(r[6] ?? ''),
      units: num(r[7]),
      gross: num(r[8]),
      discount: num(r[9]),
    }))
    .filter((r) => !!r.date && !!r.channel);
}

// (parseDiscountSchedule + DiscountScheduleRow lived here briefly while we
// prototyped Signal #1 of sale-active detection. Removed once we confirmed
// HIKERS runs sales via Launchpad price changes, not discount codes. The
// `Discount Schedule` tab is still populated by 48_shopify_discount_
// schedule.gs and is available for future discount-code analytics — see
// the comment near SALE_PRICE_DROP_THRESHOLD at the top of this file.)

/** Manual campaign→event override map (populated by 49_campaign_event_map.gs).
 *  Key: 'YYYY-MM-DD|Platform|Name'. Value: event key (memorial-day, bfcm, ...)
 *  OR 'skip' to exclude the campaign from all events. Empty Override column =
 *  not in this map = fall through to keyword matcher. */
type CampaignOverrideMap = Map<string, string>;

function parseCampaignEventMap(grid: string[][]): CampaignOverrideMap {
  const map = new Map<string, string>();
  if (grid.length < 2) return map;
  // Cols A..G: Send Date · Platform · Name · Subject · Suggested · Override · Last Updated.
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const date = dateOnly(r[0]);
    const platform = String(r[1] ?? '');
    const name = String(r[2] ?? '');
    const override = String(r[5] ?? '').trim().toLowerCase();
    if (!date || !platform || !name || !override) continue;
    map.set(date + '|' + platform + '|' + name, override);
  }
  return map;
}

interface CampaignParsed {
  sendDate: string;
  platform: string;
  type: string;
  name: string;
  /** Subject line (Klaviyo only; empty for Postscript). Carries the
   *  customer-facing copy, which is where keyword matches live for
   *  Klaviyo campaigns — their Name field is an internal label. */
  subject: string;
  recipients: number;
  revenue: number;
}
/** Campaigns cols: A SendDate · B Platform · C Type · D Name · E Subject
 *  F Recipients · G Opens · H Clicks · I Unsubs · J Conversions · K Revenue · L Last Updated */
function parseCampaigns(grid: string[][]): CampaignParsed[] {
  if (grid.length < 2) return [];
  return grid.slice(1)
    .map((r) => ({
      sendDate: dateOnly(r[0]),
      platform: String(r[1] ?? ''),
      type: String(r[2] ?? ''),
      name: String(r[3] ?? ''),
      subject: String(r[4] ?? ''),
      recipients: num(r[5]),
      revenue: num(r[10]),
    }))
    .filter((r) => !!r.sendDate && !!r.platform);
}

/* ===== Trend builder ===== */

function buildMonthlyTrend(rows: SalesHistoryRow[], asOf: string, months: number): MonthlyTrendPoint[] {
  // Seed the last N months ending at asOf with zeros so the chart never has gaps.
  const trend = new Map<string, MonthlyTrendPoint>();
  const asOfD = new Date(asOf + 'T00:00:00Z');
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(asOfD.getUTCFullYear(), asOfD.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    trend.set(key, { month: key, shopify: 0, amazonFba: 0, amazonFbm: 0, total: 0 });
  }
  rows.forEach((r) => {
    const m = r.date.slice(0, 7);
    const pt = trend.get(m);
    if (!pt) return;
    if (r.channel === 'Shopify') pt.shopify += r.gross;
    else if (r.channel === 'Amazon-FBA') pt.amazonFba += r.gross;
    else if (r.channel === 'Amazon-FBM') pt.amazonFbm += r.gross;
    pt.total += r.gross;
  });
  return Array.from(trend.values()).map((p) => ({
    month: p.month,
    shopify: round2(p.shopify),
    amazonFba: round2(p.amazonFba),
    amazonFbm: round2(p.amazonFbm),
    total: round2(p.total),
  }));
}

/**
 * Daily average revenue over the trailing `lookback` days ending the day
 * before `windowStart`. When `excludeCampaignDays` is provided, any date
 * that had a campaign send is dropped from both the numerator and the
 * denominator — that way the baseline reflects organic-day run-rate, not
 * "average including any product-launch noise that happened to land in
 * the trailing 28d." The denominator never drops below 1 to avoid divide
 * by zero on heavily-promoted runs.
 */
function computeBaselineDailyRev(
  rows: SalesHistoryRow[],
  windowStart: string,
  lookback: number,
  excludeCampaignDays?: Set<string>,
): number {
  if (lookback <= 0) return 0;
  const baselineStart = isoDaysAgo(windowStart, lookback);

  // Sum revenue by date so multi-channel rows don't double-count.
  const byDay = new Map<string, number>();
  rows.forEach((r) => {
    if (r.date >= baselineStart && r.date < windowStart) {
      byDay.set(r.date, (byDay.get(r.date) || 0) + r.gross);
    }
  });

  // Walk every day in the baseline window. If excludeCampaignDays says
  // this day had a send, skip it (drop from both numerator and denominator).
  let sum = 0;
  let countedDays = 0;
  let cursor = baselineStart;
  while (cursor < windowStart) {
    const isPromo = excludeCampaignDays && excludeCampaignDays.has(cursor);
    if (!isPromo) {
      sum += byDay.get(cursor) || 0;
      countedDays++;
    }
    cursor = _addDaysHelper(cursor, 1);
  }
  return countedDays > 0 ? sum / countedDays : 0;
}

function _addDaysHelper(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return _isoDate(d);
}

/**
 * Reduce per-year event multipliers to the three aggregate flavors the UI
 * exposes. Years without a non-null multiplier (e.g., the brand wasn't
 * ramped enough for a baseline) are excluded from all three averages.
 *
 *   latestYear      — most recent year's multiplier as-is
 *   recencyWeighted — most-recent year × 3, +1 year × 2, older × 1, normalized
 *   allYearsAvg     — simple arithmetic mean
 */
function aggregateMultipliers(years: EventYearRow[]): EventMultipliers {
  const valid = years.filter((y) => y.dailyMultiplier !== null);
  const perYear = valid.map((y) => ({ year: y.year, multiplier: y.dailyMultiplier as number }));
  if (perYear.length === 0) {
    return { latestYear: null, recencyWeighted: null, allYearsAvg: null, perYear: [] };
  }

  // Sort ascending by year so [last] = most recent
  perYear.sort((a, b) => a.year - b.year);
  const latest = perYear[perYear.length - 1].multiplier;

  // All-years simple average
  const avg = perYear.reduce((s, p) => s + p.multiplier, 0) / perYear.length;

  // Recency-weighted: latest×3, latest-1×2, others×1. With 1 year this
  // collapses to latest. With 2 years it's (latest×3 + prior×2)/5. With 3+
  // it's (latest×3 + prior×2 + others×1×N)/(3 + 2 + N).
  let weightedNum = 0;
  let weightedDen = 0;
  perYear.forEach((p, i) => {
    const fromLatest = perYear.length - 1 - i;
    let w: number;
    if (fromLatest === 0) w = 3;
    else if (fromLatest === 1) w = 2;
    else w = 1;
    weightedNum += p.multiplier * w;
    weightedDen += w;
  });
  const weighted = weightedDen > 0 ? weightedNum / weightedDen : null;

  return {
    latestYear: round2(latest),
    recencyWeighted: weighted !== null ? round2(weighted) : null,
    allYearsAvg: round2(avg),
    perYear: perYear.map((p) => ({ year: p.year, multiplier: round2(p.multiplier) })),
  };
}

/**
 * Compute per-SKU current daily velocity from the trailing 30 days, excluding
 * campaign-send days so the velocity reflects organic baseline behavior.
 *
 * This is the "what is this SKU doing on a normal day right now" signal — the
 * input to the multiplier-based forecast formula. By using current data it
 * automatically accounts for brand growth, new SKUs launching, and ops
 * improvements between historical event years and now. No explicit YoY
 * growth adjustment needed; today's velocity already reflects today.
 *
 * Returns sorted descending by velocity. SKUs with zero recent units are
 * filtered out (no signal to forecast from).
 */
function computeCurrentSkuVelocity(
  history: SalesHistoryRow[],
  asOf: string,
  campaignSendDays: Set<string>,
): CurrentSkuVelocity[] {
  const lookback = 30;
  const windowStart = isoDaysAgo(asOf, lookback);

  type Agg = {
    sku: string;
    style: string;
    color: string;
    size: string;
    units: number;
    revenue: number;
    days: Set<string>;
  };
  const map = new Map<string, Agg>();
  history.forEach((r) => {
    if (r.date < windowStart || r.date > asOf) return;
    if (campaignSendDays.has(r.date)) return;   // organic days only
    const existing = map.get(r.sku);
    if (existing) {
      existing.units += r.units;
      existing.revenue += r.gross;
      existing.days.add(r.date);
    } else {
      const days = new Set<string>();
      days.add(r.date);
      map.set(r.sku, {
        sku: r.sku,
        style: r.style,
        color: r.color,
        size: r.size,
        units: r.units,
        revenue: r.gross,
        days,
      });
    }
  });

  // Count total organic days in the window (denominator). Walking the
  // calendar so SKUs that didn't sell every day still get a fair daily
  // average across the window.
  let organicDaysInWindow = 0;
  let cursor = windowStart;
  while (cursor <= asOf) {
    if (!campaignSendDays.has(cursor)) organicDaysInWindow++;
    cursor = _addDaysHelper(cursor, 1);
  }
  const denominator = Math.max(1, organicDaysInWindow);

  const rows: CurrentSkuVelocity[] = [];
  map.forEach((a) => {
    if (a.units <= 0) return;
    rows.push({
      sku: a.sku,
      style: a.style,
      color: a.color,
      size: a.size,
      dailyVelocity: round2(a.units / denominator),
      recentUnits: a.units,
      recentRevenue: round2(a.revenue),
      daysCounted: organicDaysInWindow,
    });
  });
  rows.sort((a, b) => b.dailyVelocity - a.dailyVelocity);
  return rows;
}

/**
 * Build a Set of ISO YYYY-MM-DD strings for every distinct date that had at
 * least one CAMPAIGN-type send. Used to exclude those days from the
 * trailing-baseline calculation so the baseline reflects an organic,
 * no-promo day.
 *
 * CRITICAL: this MUST exclude Klaviyo Flow rows. Flows (Welcome Series,
 * Abandoned Cart, Browse Abandonment, Back In Stock, etc.) fire every day
 * for every customer in them — they're represented as one row per day per
 * flow across the entire history. If we treated those as "campaign days,"
 * every day would get excluded from the baseline → baseline = 0 → every
 * event's multiplier comes back null → the forecast view shows empty.
 *
 * Flows ARE the organic baseline behavior (background email automation
 * that's always running). Only actual marketing campaigns — promotional
 * blasts, hero sends, product announcements — count as days to exclude.
 * For Klaviyo the campaign rows have type='Campaign' and flow rows have
 * type='Flow'. For Postscript both Campaign and Campaign Flow rows are
 * real marketing campaigns (Campaign Flow is just a multi-message drip
 * send, not an automation), so both are kept.
 */
function buildCampaignSendDaySet(campaigns: CampaignParsed[]): Set<string> {
  const set = new Set<string>();
  campaigns.forEach((c) => {
    if (!c.sendDate) return;
    // Exclude Klaviyo flow rows (always-on automations).
    if (c.type === 'Flow') return;
    set.add(c.sendDate);
  });
  return set;
}

interface PromoEventRange {
  name: string;
  start: string;        // YYYY-MM-DD
  end: string;          // YYYY-MM-DD (inclusive)
}

/**
 * Determine whether a sale was actually live on the site during the given
 * window by combining two independent signals. Returns a SaleStatus with
 * each fired signal carrying a human-readable detail string (shown in the
 * UI disclosure).
 *
 * Signal 1 — Per-SKU price drop on Shopify (catches Launchpad price changes,
 * which is how HIKERS actually runs sales):
 *   For each SHOPIFY SKU with at least SALE_PRICE_DROP_MIN_UNITS_PER_SKU
 *   units in both the window and a trailing 28-day baseline, compute
 *   avgUnitPrice in each. Mark the SKU as "dropped" if window avg is
 *   SALE_PRICE_DROP_THRESHOLD (10%) or more below baseline avg. Flag the
 *   signal if dropped SKUs collectively account for
 *   SALE_PRICE_DROP_MIN_WINDOW_UNIT_SHARE (30%) or more of total window
 *   units. Amazon channels are excluded because Launchpad only controls
 *   Shopify pricing.
 *
 * Signal 2 — Events tab promo overlap:
 *   Any Events tab row of Type='Promo' whose [start, end] overlaps the
 *   window. This is the manual ground truth for theme-only swaps that
 *   change neither prices nor whatever-other-mechanism (rare for HIKERS
 *   but the option is there).
 *
 * (Signal #3 — discount overlap — was prototyped and removed; HIKERS doesn't
 * use discount codes for sale events. See the SALE_PRICE_DROP_* constant
 * block at the top of this file for the longer note.)
 */
function detectSaleActive(
  history: SalesHistoryRow[],
  promos: PromoEventRange[],
  windowStart: string,
  windowEnd: string,
): SaleStatus {
  const signals: SaleSignal[] = [];

  // -- Signal 1: per-SKU price drop on Shopify (primary signal for HIKERS) --
  // Compute avg unit price per SKU inside window vs trailing 28d baseline.
  const baselineStart = _addDaysHelper(windowStart, -28);
  // skuAgg[sku] = { winUnits, winRev, baseUnits, baseRev }
  const skuAgg = new Map<string, { winUnits: number; winRev: number; baseUnits: number; baseRev: number }>();
  history.forEach((r) => {
    if (r.channel !== 'Shopify') return;   // Launchpad is Shopify-only
    const inWindow = r.date >= windowStart && r.date < windowEnd;
    const inBaseline = r.date >= baselineStart && r.date < windowStart;
    if (!inWindow && !inBaseline) return;
    const sku = r.sku || '(no sku)';
    const a = skuAgg.get(sku) || { winUnits: 0, winRev: 0, baseUnits: 0, baseRev: 0 };
    if (inWindow) { a.winUnits += r.units; a.winRev += r.gross; }
    else { a.baseUnits += r.units; a.baseRev += r.gross; }
    skuAgg.set(sku, a);
  });
  let totalWinUnits = 0;
  let droppedWinUnits = 0;
  let droppedSkuCount = 0;
  let maxDropPct = 0;
  skuAgg.forEach((a) => {
    totalWinUnits += a.winUnits;
    if (a.winUnits < SALE_PRICE_DROP_MIN_UNITS_PER_SKU) return;
    if (a.baseUnits < SALE_PRICE_DROP_MIN_UNITS_PER_SKU) return;
    const winPrice = a.winRev / a.winUnits;
    const basePrice = a.baseRev / a.baseUnits;
    if (basePrice <= 0) return;
    const drop = (basePrice - winPrice) / basePrice;
    if (drop >= SALE_PRICE_DROP_THRESHOLD) {
      droppedWinUnits += a.winUnits;
      droppedSkuCount++;
      if (drop > maxDropPct) maxDropPct = drop;
    }
  });
  const droppedShare = totalWinUnits > 0 ? droppedWinUnits / totalWinUnits : 0;
  if (droppedShare >= SALE_PRICE_DROP_MIN_WINDOW_UNIT_SHARE) {
    signals.push({
      kind: 'pricedrop',
      detail: `${droppedSkuCount} SKUs ≥${Math.round(SALE_PRICE_DROP_THRESHOLD * 100)}% below baseline ` +
        `(${Math.round(droppedShare * 100)}% of window units, deepest cut ${Math.round(maxDropPct * 100)}%)`,
    });
  }

  // -- Signal 2: Events tab promo overlap --
  const overlappingPromos = promos.filter((p) => {
    return p.start < windowEnd && p.end >= windowStart;
  });
  if (overlappingPromos.length > 0) {
    signals.push({
      kind: 'events',
      detail: overlappingPromos.map((p) => p.name + ' (' + p.start + ' → ' + p.end + ')').join(' · '),
    });
  }

  return { active: signals.length > 0, signals };
}

/**
 * Resolve the event's window for a given year. Tries campaign-anchored
 * first (find sends matching the event's keywords inside ±60d of the
 * calendar anchor; if any found, anchor to those sends). Falls back to
 * the fixed calendar window if no matching campaigns ran.
 *
 * Returns {start, end, lengthDays, source, matched}. start is inclusive,
 * end is exclusive — matches the half-open intervals the rest of the
 * loader uses.
 */
function resolveEventWindowForYear(
  evt: SeasonalEvent,
  year: number,
  campaigns: CampaignParsed[],
  overrides?: CampaignOverrideMap,
): {
  start: string;
  end: string;
  lengthDays: number;
  source: 'campaign' | 'calendar';
  matched: EventCampaignRow[];
} {
  const calWin = eventWindowFor(evt, year);
  // ±60d search radius around the calendar anchor — wide enough to catch
  // campaigns that drifted but tight enough that next-event keywords (e.g.,
  // a "Memorial Day" subject for a Memorial Day announced 3 months early)
  // don't get pulled into another event's bucket.
  const searchStart = _addDaysHelper(calWin.anchor, -60);
  const searchEnd = _addDaysHelper(calWin.anchor, 60);

  const matched: EventCampaignRow[] = [];
  campaigns.forEach((c) => {
    if (!c.sendDate || c.sendDate < searchStart || c.sendDate > searchEnd) return;

    // Manual override wins over keyword matcher. Override values:
    //   'skip'       → exclude from ALL events (campaign drops out entirely)
    //   <event-key>  → force this campaign into the named event, regardless
    //                  of what the keyword matcher would say
    //   blank        → no override, fall through to keyword matcher
    const overrideKey = c.sendDate + '|' + c.platform + '|' + c.name;
    const override = overrides?.get(overrideKey);
    let assignedEventKey: string | null;
    if (override === 'skip') {
      return;
    } else if (override) {
      assignedEventKey = override;
    } else {
      // Match against BOTH name and subject — Klaviyo's Name field is
      // usually an internal label, while the customer-facing copy in
      // Subject is where the keyword hit actually lives.
      const m = matchCampaignToEvent(c.name, c.subject);
      assignedEventKey = m ? m.key : null;
    }

    if (assignedEventKey === evt.key) {
      matched.push({
        sendDate: c.sendDate,
        platform: c.platform,
        type: c.type,
        name: c.name,
        recipients: c.recipients,
        revenue: round2(c.revenue),
      });
    }
  });

  if (matched.length === 0) {
    return {
      start: calWin.start,
      end: calWin.end,
      lengthDays: calWin.len,
      source: 'calendar',
      matched: [],
    };
  }

  // Sort matched by send date so first/last picks are deterministic.
  matched.sort((a, b) => a.sendDate.localeCompare(b.sendDate));
  const firstSend = matched[0].sendDate;
  // CRITICAL: every year's window must be the SAME length, otherwise YoY
  // revenue totals become "17 days of 2024 vs 5 days of 2025" — useless.
  // We anchor to the first matched send (the campaign's actual start),
  // back off 1 day for pre-warmup traffic, then use the event's calendar
  // window LENGTH so each year captures the same number of days. The
  // lastSend value is preserved in the matched list (visible in the UI's
  // expandable disclosure) so you can still see how long the promotional
  // run actually went, even if some of those sends fall outside the
  // counted revenue window.
  const start = _addDaysHelper(firstSend, -1);
  const end = _addDaysHelper(start, calWin.len);
  return { start, end, lengthDays: calWin.len, source: 'campaign', matched };
}

/* ===== Date math — server-only helpers (pure ones live in ./seasonal-events) ===== */

// eventWindowFor, nthDowOfMonth, thanksgivingFor, addDays, isoDate are
// re-exported from ./seasonal-events at the top of this file. The local
// helpers below are only used by the server loader.

import { addDays as _addDays, isoDate as _isoDate } from './seasonal-events';

function isoDateOnly(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoDaysAgo(fromIso: string, n: number): string {
  const d = new Date(fromIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return _isoDate(d);
}

/* ===== Helpers ===== */

function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function dateOnly(v: unknown): string {
  if (!v) return '';
  return String(v).slice(0, 10);
}

function ptToday(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

// ForecastRow + computeForecast now live in ./seasonal-events (client-safe).
// They're re-exported at the top of this file.
