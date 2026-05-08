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
  };
  channelMix: ChannelTotals[];
  platformBreakdown: PlatformTotals[];
  dailyTrend: DailyTrendPoint[];
  topCampaigns: CampaignRow[];
  topFlows: CampaignRow[];
  rawSalesRowCount: number;
  rawMarketingRowCount: number;
  rawCampaignRowCount: number;
}

const SALES_DAILY_TAB = 'Sales Daily';
const MARKETING_DAILY_TAB = 'Marketing Daily';
const CAMPAIGNS_TAB = 'Campaigns';

/**
 * Load and shape the Sales + Marketing dashboard data.
 * @param windowDays inclusive lookback window in days. Default 30.
 */
export async function loadSalesMarketing(windowDays = 30): Promise<SalesMarketingData> {
  const [salesGrid, marketingGrid, campaignsGrid] = await Promise.all([
    readTab(SALES_DAILY_TAB).catch(() => [] as string[][]),
    readTab(MARKETING_DAILY_TAB).catch(() => [] as string[][]),
    readTab(CAMPAIGNS_TAB).catch(() => [] as string[][]),
  ]);

  const sales = parseSalesDaily(salesGrid);
  const marketing = parseMarketingDaily(marketingGrid);
  const campaigns = parseCampaigns(campaignsGrid);

  // Window ENDS yesterday by default — today's data is intentionally
  // excluded because the daily sync runs at 05:00 PT and only captures
  // orders before then, so "today" looks like an artificial revenue
  // cliff if included. windowDays counts back from yesterday inclusively.
  const today = new Date();
  const windowEnd = isoDaysAgo(today, 1);             // yesterday
  const windowStart = isoDaysAgo(today, windowDays);  // windowDays days ago

  const salesInWindow = sales.filter((r) => r.date >= windowStart && r.date <= windowEnd);
  const marketingInWindow = marketing.filter((r) => r.date >= windowStart && r.date <= windowEnd);
  const campaignsInWindow = campaigns.filter(
    (r) => r.sendDate >= windowStart && r.sendDate <= windowEnd,
  );

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
  // Note: windowEnd is yesterday (today is excluded — see comment above).
  for (let i = 0; i < windowDays; i++) {
    const d = isoDaysAgo(today, windowDays - i);
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
  const topCampaigns = campaignsInWindow
    .filter((c) => c.type === 'Campaign')
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);
  const topFlows = campaignsInWindow
    .filter((c) => c.type === 'Flow')
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  return {
    windowDays,
    windowStart,
    windowEnd,
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
    },
    channelMix,
    platformBreakdown,
    dailyTrend,
    topCampaigns,
    topFlows,
    rawSalesRowCount: sales.length,
    rawMarketingRowCount: marketing.length,
    rawCampaignRowCount: campaigns.length,
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

function sum<T>(arr: T[], fn: (x: T) => number): number {
  return arr.reduce((s, x) => s + fn(x), 0);
}

function isEmailSmsPlatform(platform: string): boolean {
  return platform === 'Klaviyo' || platform.startsWith('Postscript');
}

function isPaidAdPlatform(platform: string): boolean {
  return (
    platform.startsWith('Meta-') ||
    platform === 'Google Ads' ||
    platform === 'Amazon Ads'
  );
}
