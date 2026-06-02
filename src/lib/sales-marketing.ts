import { readTab } from './sheets';

/**
 * Sales + Marketing dashboard data loader.
 *
 * Reads the three tabs that the daily syncs populate:
 *   • Sales Daily       — one row per (date × channel)
 *   • Marketing Daily   — one row per (date × platform)
 *   • Campaigns         — one row per (date × email/SMS campaign or flow)
 *
 * Returns shaped data plus summary metrics computed over a configurable
 * window (default 30 days). All money fields are dollars (the workbook
 * already stores dollars, not cents).
 */

export interface SalesDailyRow {
  date: string;          // YYYY-MM-DD
  channel: string;       // 'Shopify' | 'Amazon-FBA' | 'Amazon-FBM'
  orders: number;
  units: number;
  grossRevenue: number;
  netRevenue: number;
  topSku: string;
  topSkuRevenue: number;
}

export interface MarketingDailyRow {
  date: string;
  platform: string;      // 'Meta-FB' | 'Meta-IG' | 'Meta-AN' | 'Klaviyo' | 'Postscript-Campaign' | etc.
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  sends: number;
}

export interface CampaignRow {
  sendDate: string;
  platform: string;      // 'Klaviyo' | 'Postscript'
  type: string;          // 'Campaign' | 'Flow'
  name: string;
  recipients: number;
  opens: number;
  clicks: number;
  conversions: number;
  revenue: number;
}

export interface DiscountRow {
  date: string;
  channel: string;       // 'Shopify' | 'Amazon'
  code: string;          // discount code (Shopify) or PromotionId (Amazon)
  codeType: string;      // 'Code' | 'Auto' | 'Manual' | 'Script' (Shopify); 'Principal' | 'Shipping' | 'Promotion' (Amazon)
  sku: string;
  orderId: string;
  discountAmount: number;
  lineSubtotal: number;  // Shopify only; blank/0 for Amazon in v1
}

export interface DiscountCodeTotals {
  code: string;
  channel: string;
  codeType: string;
  orders: number;            // distinct order count
  lines: number;             // total discount-line count
  grossRevenue: number;      // sum of line subtotals (Shopify only — Amazon contributes 0)
  discountAmount: number;
  discountPct: number | null;  // discountAmount / grossRevenue; null when grossRevenue is 0 (e.g. Amazon-only codes)
}

export interface ChannelTotals {
  channel: string;
  orders: number;
  grossRevenue: number;
  netRevenue: number;
  share: number;         // 0..1, share of total NET revenue
}

export interface PlatformTotals {
  platform: string;
  spend: number;
  conversions: number;
  conversionValue: number;
  roas: number | null;   // null when spend is 0 (e.g. email/SMS)
}

export interface DailyTrendPoint {
  date: string;
  revenue: number;          // Net revenue from Sales Daily (Shopify + Amazon)
  spend: number;            // Marketing spend from Marketing Daily (paid platforms)
  conversionValue: number;  // Marketing-attributed revenue (paid + email/SMS)
}

export interface SalesMarketingData {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  /** What ptDaysAgo(1) returned — i.e. "yesterday in PT" by the clock. */
  expectedWindowEnd: string;
  /** True when windowEnd had to be pushed back because the morning sync
   *  hasn't yet written rows for expectedWindowEnd. UI uses this to swap
   *  the "Yesterday" label for "Last complete day" and warn the user. */
  windowEndIsStale: boolean;
  totals: {
    netRevenue: number;
    grossRevenue: number;
    orders: number;
    units: number;
    marketingSpend: number;
    marketingConversionValue: number;     // total platform-attributed (paid + email/SMS)
    advertisingRevenue: number;           // paid-ad attribution only (Meta + Google + Amazon Ads)
    emailSmsRevenue: number;              // Klaviyo + Postscript-* attribution
    blendedRoas: number | null;
    discountAmount: number;               // total $ discounted in window (Shopify + Amazon)
    discountPctOfGross: number | null;    // discountAmount / grossRevenue; null if no gross
  };
  channelMix: ChannelTotals[];
  platformBreakdown: PlatformTotals[];
  dailyTrend: DailyTrendPoint[];
  topCampaigns: CampaignRow[];
  topFlows: CampaignRow[];
  topDiscountCodes: DiscountCodeTotals[];
  rawSalesRowCount: number;
  rawMarketingRowCount: number;
  rawCampaignRowCount: number;
  rawDiscountRowCount: number;
}

const SALES_DAILY_TAB = 'Sales Daily';
const MARKETING_DAILY_TAB = 'Marketing Daily';
const CAMPAIGNS_TAB = 'Campaigns';
const DISCOUNTS_TAB = 'Discounts';

/**
 * Load and shape the Sales + Marketing dashboard data.
 * @param windowDays inclusive lookback window in days. Default 30.
 */
export async function loadSalesMarketing(windowDays = 30): Promise<SalesMarketingData> {
  const [salesGrid, marketingGrid, campaignsGrid, discountsGrid] = await Promise.all([
    readTab(SALES_DAILY_TAB).catch(() => [] as string[][]),
    readTab(MARKETING_DAILY_TAB).catch(() => [] as string[][]),
    readTab(CAMPAIGNS_TAB).catch(() => [] as string[][]),
    readTab(DISCOUNTS_TAB).catch(() => [] as string[][]),
  ]);

  const sales = parseSalesDaily(salesGrid);
  const marketing = parseMarketingDaily(marketingGrid);
  const campaigns = parseCampaigns(campaignsGrid);
  const discounts = parseDiscounts(discountsGrid);

  // Window ENDS yesterday by default — today's data is intentionally
  // excluded because the daily sync runs at 05:00 PT and only captures
  // orders before then, so "today" looks like an artificial revenue
  // cliff if included. windowDays counts back from yesterday inclusively.
  //
  // CRITICAL: "yesterday" means yesterday in PACIFIC TIME, regardless of
  // where the server runs. Sales Daily rows are written by Apps Script
  // (PT-scheduled triggers) using PT-anchored dates. If we use the server's
  // local clock and the server is UTC (Fly), late-evening PT requests see
  // a "tomorrow" windowEnd that has no data yet — Amazon rows vanish even
  // though they exist on disk. Using PT here keeps the dashboard correct
  // regardless of where it's deployed.
  //
  // ALSO: there's a ~7-hour dead zone every night between PT-midnight and
  // the 04:00–07:00 PT sync window where "yesterday in PT" exists by the
  // clock but hasn't been written to the workbook yet. (Hit this 2026-06-01
  // at 21:49 HST = 00:49 PT — banner said "Yesterday · Jun 1" but the
  // morning sync hadn't run.)
  //
  // Detecting staleness via "any Sales Daily row exists for date X" doesn't
  // work: 30_sales_daily_sync.gs's Shopify pull writes intraday rows tagged
  // with the current PT date as orders come in, so ptYesterday always has
  // partial rows by the time we hit the dead zone. And Amazon-only presence
  // doesn't work either: 30_sales_daily_sync.gs only writes Amazon rows for
  // dates with orders, so a zero-sales Amazon day would falsely flag as
  // stale. So we use the clock instead: the morning sync window runs 04:00–
  // 07:00 PT. After 08:00 PT we trust ptYesterday as complete. Before then,
  // we clamp back one more day.
  const expectedWindowEnd = ptDaysAgo(1);
  const windowEndIsStale = ptHour() < SYNC_COMPLETE_HOUR_PT;
  const windowEnd = windowEndIsStale ? isoDaysBefore(expectedWindowEnd, 1) : expectedWindowEnd;
  const windowStart = isoDaysBefore(windowEnd, windowDays - 1);

  const salesInWindow = sales.filter((r) => r.date >= windowStart && r.date <= windowEnd);
  const marketingInWindow = marketing.filter((r) => r.date >= windowStart && r.date <= windowEnd);
  const campaignsInWindow = campaigns.filter(
    (r) => r.sendDate >= windowStart && r.sendDate <= windowEnd,
  );
  const discountsInWindow = discounts.filter((r) => r.date >= windowStart && r.date <= windowEnd);

  // ---- Totals ----
  const netRevenue = sum(salesInWindow, (r) => r.netRevenue);
  const grossRevenue = sum(salesInWindow, (r) => r.grossRevenue);
  const orders = sum(salesInWindow, (r) => r.orders);
  const units = sum(salesInWindow, (r) => r.units);
  const marketingSpend = sum(marketingInWindow, (r) => r.spend);
  const marketingConversionValue = sum(marketingInWindow, (r) => r.conversionValue);
  const blendedRoas = marketingSpend > 0 ? marketingConversionValue / marketingSpend : null;

  // Email/SMS revenue = Klaviyo + any Postscript-* platform.
  const emailSmsRevenue = sum(
    marketingInWindow.filter((r) => isEmailSmsPlatform(r.platform)),
    (r) => r.conversionValue,
  );
  // Advertising revenue = Meta-* + Google Ads + Amazon Ads (paid channels).
  const advertisingRevenue = sum(
    marketingInWindow.filter((r) => isPaidAdPlatform(r.platform)),
    (r) => r.conversionValue,
  );

  // ---- Channel mix ----
  const channelMap = new Map<string, ChannelTotals>();
  salesInWindow.forEach((r) => {
    const existing = channelMap.get(r.channel) ?? {
      channel: r.channel,
      orders: 0,
      grossRevenue: 0,
      netRevenue: 0,
      share: 0,
    };
    existing.orders += r.orders;
    existing.grossRevenue += r.grossRevenue;
    existing.netRevenue += r.netRevenue;
    channelMap.set(r.channel, existing);
  });
  const channelMix = Array.from(channelMap.values())
    .map((c) => ({
      ...c,
      share: netRevenue > 0 ? c.netRevenue / netRevenue : 0,
    }))
    .sort((a, b) => b.netRevenue - a.netRevenue);

  // ---- Platform breakdown ----
  const platformMap = new Map<string, PlatformTotals>();
  marketingInWindow.forEach((r) => {
    const existing = platformMap.get(r.platform) ?? {
      platform: r.platform,
      spend: 0,
      conversions: 0,
      conversionValue: 0,
      roas: null,
    };
    existing.spend += r.spend;
    existing.conversions += r.conversions;
    existing.conversionValue += r.conversionValue;
    platformMap.set(r.platform, existing);
  });
  const platformBreakdown = Array.from(platformMap.values())
    .map((p) => ({
      ...p,
      roas: p.spend > 0 ? p.conversionValue / p.spend : null,
    }))
    .sort((a, b) => b.conversionValue - a.conversionValue);

  // ---- Daily trend ----
  const trendMap = new Map<string, DailyTrendPoint>();
  // Pre-seed every day in [windowStart, windowEnd] so the chart never has gaps.
  // Note: windowEnd is the clamped end (yesterday-in-PT, or earlier if the
  // morning sync hasn't run yet — see comment above).
  for (let i = 0; i < windowDays; i++) {
    const d = isoDaysBefore(windowEnd, windowDays - 1 - i);
    trendMap.set(d, { date: d, revenue: 0, spend: 0, conversionValue: 0 });
  }
  salesInWindow.forEach((r) => {
    const point = trendMap.get(r.date);
    if (point) point.revenue += r.netRevenue;
  });
  marketingInWindow.forEach((r) => {
    const point = trendMap.get(r.date);
    if (point) {
      point.spend += r.spend;
      point.conversionValue += r.conversionValue;
    }
  });
  const dailyTrend = Array.from(trendMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // ---- Top campaigns / flows ----
  // Campaigns each have a real send date so one row per campaign — no need
  // to aggregate. Flows are stored as one row per (flow × day) (see the
  // distribute step in 33_klaviyo_sync.gs), so we sum daily rows back up
  // to per-flow before picking the top 10. Without the rollup, Top Flows
  // would show 10 individual days of the same flow.
  const topCampaigns = campaignsInWindow
    .filter((c) => c.type === 'Campaign')
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  const flowAggMap = new Map<string, CampaignRow>();
  campaignsInWindow
    .filter((c) => c.type === 'Flow')
    .forEach((c) => {
      const key = `${c.platform}|${c.name}`;
      const existing = flowAggMap.get(key);
      if (existing) {
        existing.recipients += c.recipients;
        existing.opens += c.opens;
        existing.clicks += c.clicks;
        existing.conversions += c.conversions;
        existing.revenue += c.revenue;
      } else {
        // Clone so we don't mutate the source row
        flowAggMap.set(key, { ...c });
      }
    });
  const topFlows = Array.from(flowAggMap.values())
    .map((f) => ({ ...f, revenue: round2(f.revenue) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  // ---- Discounts: total + top codes ----
  // Aggregate by (channel, code). Distinct order count via a per-key Set.
  // Note Amazon line subtotals are blank in v1, so Amazon-only codes have
  // grossRevenue=0 and discountPct=null — the dashboard renders that as "—".
  const discountAmount = sum(discountsInWindow, (r) => r.discountAmount);
  const discountPctOfGross = grossRevenue > 0 ? discountAmount / grossRevenue : null;

  type DiscountAgg = DiscountCodeTotals & { _orderIds: Set<string> };
  const discountMap = new Map<string, DiscountAgg>();
  discountsInWindow.forEach((d) => {
    const key = `${d.channel}|${d.code}`;
    let agg = discountMap.get(key);
    if (!agg) {
      agg = {
        code: d.code,
        channel: d.channel,
        codeType: d.codeType,
        orders: 0,
        lines: 0,
        grossRevenue: 0,
        discountAmount: 0,
        discountPct: null,
        _orderIds: new Set<string>(),
      };
      discountMap.set(key, agg);
    }
    agg.lines += 1;
    agg.grossRevenue += d.lineSubtotal;
    agg.discountAmount += d.discountAmount;
    if (d.orderId) agg._orderIds.add(d.orderId);
  });
  const topDiscountCodes: DiscountCodeTotals[] = Array.from(discountMap.values())
    .map((agg) => {
      const orders = agg._orderIds.size;
      const gross = round2(agg.grossRevenue);
      const disc = round2(agg.discountAmount);
      return {
        code: agg.code,
        channel: agg.channel,
        codeType: agg.codeType,
        orders,
        lines: agg.lines,
        grossRevenue: gross,
        discountAmount: disc,
        discountPct: gross > 0 ? disc / gross : null,
      };
    })
    .sort((a, b) => b.discountAmount - a.discountAmount)
    .slice(0, 10);

  return {
    windowDays,
    windowStart,
    windowEnd,
    expectedWindowEnd,
    windowEndIsStale,
    totals: {
      netRevenue: round2(netRevenue),
      grossRevenue: round2(grossRevenue),
      orders,
      units,
      marketingSpend: round2(marketingSpend),
      marketingConversionValue: round2(marketingConversionValue),
      advertisingRevenue: round2(advertisingRevenue),
      emailSmsRevenue: round2(emailSmsRevenue),
      blendedRoas: blendedRoas !== null ? round2(blendedRoas) : null,
      discountAmount: round2(discountAmount),
      discountPctOfGross: discountPctOfGross !== null ? round2(discountPctOfGross) : null,
    },
    channelMix,
    platformBreakdown,
    dailyTrend,
    topCampaigns,
    topFlows,
    topDiscountCodes,
    rawSalesRowCount: sales.length,
    rawMarketingRowCount: marketing.length,
    rawCampaignRowCount: campaigns.length,
    rawDiscountRowCount: discounts.length,
  };
}

/* ===== parsers ===== */

function parseSalesDaily(grid: string[][]): SalesDailyRow[] {
  if (grid.length < 2) return [];
  return grid.slice(1).map((r) => ({
    date: dateOnly(r[0]),
    channel: String(r[1] ?? ''),
    orders: num(r[2]),
    units: num(r[3]),
    grossRevenue: num(r[4]),
    netRevenue: num(r[7]),
    topSku: String(r[12] ?? ''),
    topSkuRevenue: num(r[13]),
  })).filter((r) => !!r.date && !!r.channel);
}

function parseMarketingDaily(grid: string[][]): MarketingDailyRow[] {
  if (grid.length < 2) return [];
  return grid.slice(1).map((r) => ({
    date: dateOnly(r[0]),
    platform: String(r[1] ?? ''),
    spend: num(r[2]),
    impressions: num(r[3]),
    clicks: num(r[4]),
    conversions: num(r[5]),
    conversionValue: num(r[6]),
    sends: num(r[8]),
  })).filter((r) => !!r.date && !!r.platform);
}

function parseCampaigns(grid: string[][]): CampaignRow[] {
  if (grid.length < 2) return [];
  return grid.slice(1).map((r) => ({
    sendDate: dateOnly(r[0]),
    platform: String(r[1] ?? ''),
    type: String(r[2] ?? ''),
    name: String(r[3] ?? ''),
    recipients: num(r[5]),
    opens: num(r[6]),
    clicks: num(r[7]),
    conversions: num(r[9]),
    revenue: num(r[10]),
  })).filter((r) => !!r.sendDate && !!r.platform);
}

function parseDiscounts(grid: string[][]): DiscountRow[] {
  if (grid.length < 2) return [];
  // Discounts tab cols: A Date · B Channel · C Code · D Code Type · E SKU
  // F Order ID · G Discount Amount · H Line Subtotal · I Last Updated
  return grid.slice(1).map((r) => ({
    date: dateOnly(r[0]),
    channel: String(r[1] ?? ''),
    code: String(r[2] ?? ''),
    codeType: String(r[3] ?? ''),
    sku: String(r[4] ?? ''),
    orderId: String(r[5] ?? ''),
    discountAmount: num(r[6]),
    lineSubtotal: num(r[7]),
  })).filter((r) => !!r.date && !!r.channel && !!r.code);
}

/* ===== helpers ===== */

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
  // Workbook returns ISO strings or yyyy-mm-dd or full timestamps —
  // first 10 chars covers all of them.
  return String(v).slice(0, 10);
}

function isoDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoDaysAgo(d: Date, n: number): string {
  const x = new Date(d);
  x.setDate(x.getDate() - n);
  return isoDateOnly(x);
}

/** Returns YYYY-MM-DD that is `n` days before the given YYYY-MM-DD string,
 *  computed in pure UTC arithmetic so it's timezone-agnostic. */
function isoDaysBefore(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Returns YYYY-MM-DD that is `n` days before today *in Pacific Time*,
 * regardless of where the server runs. Use this anywhere the dashboard's
 * date window needs to align with the PT-anchored Sales Daily / Marketing
 * Daily / Campaigns / Discounts tabs.
 *
 * Why hard-coded to America/Los_Angeles: HIKERS Co.'s Apps Script syncs
 * are scheduled in PT (04:00–07:00 PT), and Shopify writes order dates
 * using the shop's PT-set timezone. Computing "yesterday" in any other
 * timezone causes the dashboard to look up dates that haven't been
 * populated yet — the bug we hit on Fly (UTC) where the late-evening PT
 * dashboard was looking for a date the next morning's sync hadn't yet
 * written. If HIKERS ever changes business timezone, change this constant.
 */
const BUSINESS_TIMEZONE = 'America/Los_Angeles';

/** Hour (0–23) in PT after which we trust the daily morning sync to have
 *  written rows for ptYesterday. The Apps Script triggers run 04:00–07:00
 *  PT; 08:00 gives a 1-hour buffer. Lower this if the sync window changes. */
const SYNC_COMPLETE_HOUR_PT = 8;

/** Current hour in PT, 0–23. */
function ptHour(): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    hour: '2-digit',
    hour12: false,
  });
  // 'en-US' with hour12:false renders midnight as "24" in some Node versions;
  // mod 24 normalizes that to 0.
  return Number(fmt.format(new Date())) % 24;
}

function ptDaysAgo(n: number): string {
  // Step 1: read today's date in BUSINESS_TIMEZONE as YYYY-MM-DD parts.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [year, month, day] = fmt.format(new Date()).split('-').map(Number);
  // Step 2: do the day arithmetic in UTC (no timezone shift now that we
  // have the date parts as integers). UTC is just a clean calculator.
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() - n);
  const y  = d.getUTCFullYear();
  const m  = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function sum<T>(arr: T[], fn: (x: T) => number): number {
  return arr.reduce((s, x) => s + fn(x), 0);
}

function isEmailSmsPlatform(platform: string): boolean {
  // 'Klaviyo' = campaigns; 'Klaviyo-Flow' = automated flows (welcome, abandoned cart, etc.)
  return platform.startsWith('Klaviyo') || platform.startsWith('Postscript');
}

function isPaidAdPlatform(platform: string): boolean {
  return (
    platform.startsWith('Meta-') ||
    platform === 'Google Ads' ||
    platform === 'Amazon Ads'
  );
}
