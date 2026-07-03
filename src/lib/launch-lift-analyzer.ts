/**
 * Launch Lift Analyzer — data-derived multipliers for product announcements.
 *
 * Reads the Campaign Event Map (49_campaign_event_map.gs) and pulls every
 * row tagged `Campaign Type = 'Product Announcement'`. For each announcement,
 * we expand the user-typed `Announced SKUs` patterns against the SKU master
 * (same pattern as Events tab Linked Parents) and join to the Sales History
 * tab to compute, per SKU:
 *
 *   • Pre-window units — the 30 calendar days BEFORE the announcement send.
 *   • Post-window units — the 14 days STARTING with the send date.
 *   • Classification — "existing" SKUs had real sales pre-launch and yield a
 *     lift multiplier (post daily / pre daily). "new" SKUs were dormant or
 *     non-existent in the pre-window and yield first-window absolute demand.
 *
 * The per-launch output is then aggregated across launches into:
 *
 *   • medianExistingLift          — the typical multiplier the planner should
 *                                   use for "lift on existing SKUs during an
 *                                   announcement window."
 *   • medianNewSkuFirstWindowUnits — the typical 14-day initial demand for a
 *                                   brand-new SKU introduced in an announcement.
 *
 * These two numbers are what fills the Manual Multiplier and Expected Units
 * cells on the Events tab for a future announcement. Until enough launches
 * are tagged (we surface launchCount in the aggregate), the planner falls
 * back to whatever Melissa guesses; once n ≥ 3 the data-driven number should
 * be the default she reaches for.
 *
 * Window choice rationale (PRE 30d / POST 14d):
 *   • 30d pre matches the velocity window used everywhere else in the app
 *     (currentSkuVelocity in seasonal-analysis.ts), so pre vs. post is an
 *     apples-to-apples comparison against the planner's baseline.
 *   • 14d post is the typical "burst" window for an announcement campaign at
 *     HIKERS — long enough to capture the email + follow-ups, short enough
 *     that drift toward organic-baseline doesn't dilute the lift signal.
 *
 * Cross-launch confounders — we DO NOT yet exclude launches whose post window
 * overlaps a major sale event (e.g., an announcement timed for BFCM week
 * would have post units inflated by the sale itself). This is a known limit;
 * the UI surfaces overlapping events per launch so Melissa can eyeball which
 * results to trust. Future work: subtract baseline-window seasonal multiplier
 * before computing lift.
 */

import { readTab } from './sheets';
import { readSkuMaster } from './inventory';
import { expandLinkedParents } from './events';

const SALES_HISTORY_TAB = 'Sales History';
const CAMPAIGN_EVENT_MAP_TAB = 'Campaign Event Map';

const PRE_WINDOW_DAYS = 30;
const POST_WINDOW_DAYS = 14;

/**
 * Minimum units in the 30-day pre window to classify a SKU as "existing."
 * Below this threshold the SKU is treated as new — the lift math (post/pre)
 * blows up on tiny denominators and the post units are best interpreted as
 * absolute launch demand rather than a multiplier on noise.
 *
 * 3 units = "moved at least once every 10 days," which matches the cutoff
 * the planner uses elsewhere to filter SKUs out of the active-velocity set.
 */
const EXISTING_SKU_MIN_PRE_UNITS = 3;

/** Per-SKU result inside one launch. */
export interface LaunchSkuResult {
  sku: string;
  classification: 'existing' | 'new';
  preUnits30d: number;
  postUnits14d: number;
  preDailyAvg: number;
  postDailyAvg: number;
  /** Only meaningful for 'existing' SKUs. Null for 'new' (no pre baseline). */
  liftMultiplier: number | null;
}

/** One Product Announcement row, fully analyzed. */
export interface LaunchAnalysisRow {
  sendDate: string;        // YYYY-MM-DD
  platform: string;
  campaignName: string;
  announcedSkusRaw: string;
  expandedSkuCount: number;
  /** Warning if the launch's post window extends past the last Sales History
   *  date — partial data only. UI greys these out. */
  postWindowComplete: boolean;
  perSku: LaunchSkuResult[];
  existingCount: number;
  newCount: number;
  /** Median lift across this launch's existing SKUs. Null if none. */
  medianExistingLift: number | null;
  /** Avg lift across this launch's existing SKUs — useful sanity check vs median. */
  avgExistingLift: number | null;
  /** Sum of new-SKU 14-day units across the launch. */
  totalNewSkuFirstWindowUnits: number;
  /** Avg per-new-SKU first-14d units — what to budget for an unknown new SKU. */
  avgPerNewSkuFirstWindowUnits: number | null;
}

/** Aggregate across all analyzed launches. */
export interface LaunchLiftAggregate {
  /** How many launches contributed (postWindowComplete only). */
  launchCount: number;
  /** Median of every launch's medianExistingLift — the cross-launch typical. */
  medianExistingLift: number | null;
  /** Median of every launch's avgPerNewSkuFirstWindowUnits — typical per-new-SKU demand. */
  medianNewSkuFirstWindowUnits: number | null;
  /** P25 / P75 of existing lift across launches, for "how confident is this?" framing. */
  p25ExistingLift: number | null;
  p75ExistingLift: number | null;
}

export interface LaunchLiftAnalysis {
  launches: LaunchAnalysisRow[];
  aggregate: LaunchLiftAggregate;
  generatedAt: string;
  /** Last Sales History date — used to decide postWindowComplete. */
  salesHistoryAsOf: string;
  /** Non-fatal issues for the UI to surface (no Announced SKUs, no match, etc.). */
  warnings: string[];
}

// ---- Loader ---------------------------------------------------------------

export async function loadLaunchLiftAnalysis(): Promise<LaunchLiftAnalysis> {
  const [mapGrid, salesGrid, skuMaster] = await Promise.all([
    readTab(CAMPAIGN_EVENT_MAP_TAB).catch(() => [] as string[][]),
    readTab(SALES_HISTORY_TAB).catch(() => [] as string[][]),
    readSkuMaster(),
  ]);

  const warnings: string[] = [];

  // Parse all Product Announcement tags from the Campaign Event Map.
  // Schema cols: A SendDate B Platform C Name D Subject E Suggested
  //              F Override G LastUpdated H CampaignType I AnnouncedSkus
  const announcements: Array<{
    sendDate: string;
    platform: string;
    name: string;
    announcedSkusRaw: string;
  }> = [];
  for (let i = 1; i < mapGrid.length; i++) {
    const r = mapGrid[i];
    const campaignType = String(r[7] ?? '').trim();
    if (campaignType !== 'Product Announcement') continue;
    const sendDate = dateOnly(r[0]);
    if (!sendDate) continue;
    announcements.push({
      sendDate,
      platform: String(r[1] ?? ''),
      name: String(r[2] ?? ''),
      announcedSkusRaw: String(r[8] ?? '').trim(),
    });
  }

  if (announcements.length === 0) {
    return {
      launches: [],
      aggregate: emptyAggregate(),
      generatedAt: new Date().toISOString(),
      salesHistoryAsOf: '',
      warnings: [
        'No campaigns tagged as "Product Announcement" in the Campaign Event Map. Tag at least one historical announcement (Campaign Type = "Product Announcement" + Announced SKUs filled in) to see lift results.',
      ],
    };
  }

  // Build the per-SKU per-day units index from Sales History.
  // Sum across channels — the planner's velocity is total units/day.
  // Index shape: Map<sku, Map<date, units>>.
  const dailyBySkuMap = new Map<string, Map<string, number>>();
  let salesHistoryAsOf = '';
  for (let i = 1; i < salesGrid.length; i++) {
    const r = salesGrid[i];
    const date = dateOnly(r[0]);
    if (!date) continue;
    if (date > salesHistoryAsOf) salesHistoryAsOf = date;
    const sku = String(r[2] ?? '').trim();
    if (!sku) continue;
    const units = numFrom(r[7]);
    if (units === 0) continue;
    let byDate = dailyBySkuMap.get(sku);
    if (!byDate) {
      byDate = new Map<string, number>();
      dailyBySkuMap.set(sku, byDate);
    }
    byDate.set(date, (byDate.get(date) ?? 0) + units);
  }

  // SKU universe for pattern expansion.
  const allSkus = skuMaster.map((m) => m.sku);

  const launches: LaunchAnalysisRow[] = [];
  for (const a of announcements) {
    // Expand the comma-list of patterns ("H503-4-NGBK, H503-4-GYBK") into
    // concrete SKUs ("H503-4-NGBK-XS", "H503-4-NGBK-S", ...). Same expansion
    // logic as Events tab Linked Parents — both wildcards (*) and parent
    // codes are supported.
    const expanded = a.announcedSkusRaw
      ? Array.from(expandLinkedParents(a.announcedSkusRaw, allSkus))
      : [];

    if (!a.announcedSkusRaw) {
      warnings.push(
        `Skipped "${a.name}" (${a.sendDate}) — tagged as Product Announcement but Announced SKUs is blank. Fill it in to include this launch.`,
      );
      continue;
    }
    if (expanded.length === 0) {
      warnings.push(
        `Skipped "${a.name}" (${a.sendDate}) — Announced SKUs "${a.announcedSkusRaw}" expanded to zero SKUs. Check the patterns against the SKU master.`,
      );
      continue;
    }

    const preStart = addDays(a.sendDate, -PRE_WINDOW_DAYS);
    const preEnd = addDays(a.sendDate, -1);              // inclusive day before send
    const postStart = a.sendDate;
    const postEnd = addDays(a.sendDate, POST_WINDOW_DAYS - 1);
    const postWindowComplete = !!salesHistoryAsOf && postEnd <= salesHistoryAsOf;

    const perSku: LaunchSkuResult[] = [];
    for (const sku of expanded) {
      const byDate = dailyBySkuMap.get(sku);
      const preUnits = sumInRange(byDate, preStart, preEnd);
      const postUnits = sumInRange(byDate, postStart, postEnd);
      const preDailyAvg = preUnits / PRE_WINDOW_DAYS;
      const postDailyAvg = postUnits / POST_WINDOW_DAYS;
      const classification: 'existing' | 'new' =
        preUnits >= EXISTING_SKU_MIN_PRE_UNITS ? 'existing' : 'new';
      const liftMultiplier =
        classification === 'existing' && preDailyAvg > 0
          ? postDailyAvg / preDailyAvg
          : null;
      perSku.push({
        sku,
        classification,
        preUnits30d: preUnits,
        postUnits14d: postUnits,
        preDailyAvg: round3(preDailyAvg),
        postDailyAvg: round3(postDailyAvg),
        liftMultiplier: liftMultiplier === null ? null : round3(liftMultiplier),
      });
    }

    const existingLifts = perSku
      .filter((s) => s.classification === 'existing' && s.liftMultiplier !== null)
      .map((s) => s.liftMultiplier as number);
    const newSkuPostUnits = perSku
      .filter((s) => s.classification === 'new')
      .map((s) => s.postUnits14d);

    launches.push({
      sendDate: a.sendDate,
      platform: a.platform,
      campaignName: a.name,
      announcedSkusRaw: a.announcedSkusRaw,
      expandedSkuCount: expanded.length,
      postWindowComplete,
      perSku,
      existingCount: existingLifts.length,
      newCount: newSkuPostUnits.length,
      medianExistingLift: existingLifts.length > 0 ? round3(median(existingLifts)) : null,
      avgExistingLift: existingLifts.length > 0 ? round3(avg(existingLifts)) : null,
      totalNewSkuFirstWindowUnits: newSkuPostUnits.reduce((s, n) => s + n, 0),
      avgPerNewSkuFirstWindowUnits: newSkuPostUnits.length > 0
        ? Math.round(avg(newSkuPostUnits))
        : null,
    });
  }

  // Sort newest launches first — most recent first matches user mental model.
  launches.sort((a, b) => b.sendDate.localeCompare(a.sendDate));

  // Aggregate — only consider launches with a complete post window so we
  // don't average in launches still inside their first 14 days. Per-launch
  // contribution = the launch's own median (not all per-SKU lifts dumped
  // together) so a launch with 30 size SKUs doesn't dominate one with 4.
  const complete = launches.filter((l) => l.postWindowComplete);
  const perLaunchExistingLifts = complete
    .map((l) => l.medianExistingLift)
    .filter((v): v is number => v !== null);
  const perLaunchNewSkuMeds = complete
    .map((l) => l.avgPerNewSkuFirstWindowUnits)
    .filter((v): v is number => v !== null);

  const aggregate: LaunchLiftAggregate = {
    launchCount: complete.length,
    medianExistingLift: perLaunchExistingLifts.length > 0
      ? round3(median(perLaunchExistingLifts))
      : null,
    medianNewSkuFirstWindowUnits: perLaunchNewSkuMeds.length > 0
      ? Math.round(median(perLaunchNewSkuMeds))
      : null,
    p25ExistingLift: perLaunchExistingLifts.length >= 3
      ? round3(quantile(perLaunchExistingLifts, 0.25))
      : null,
    p75ExistingLift: perLaunchExistingLifts.length >= 3
      ? round3(quantile(perLaunchExistingLifts, 0.75))
      : null,
  };

  // Quality warnings for the UI.
  if (complete.length === 0 && launches.length > 0) {
    warnings.push(
      'All tagged launches have an incomplete post window (post window extends past last Sales History date). Aggregate metrics are unavailable until the 14-day windows close.',
    );
  }
  if (complete.length > 0 && complete.length < 3) {
    warnings.push(
      `Only ${complete.length} launch${complete.length === 1 ? '' : 'es'} with complete post windows so far — the aggregate is directional, not statistically firm. Tag a few more historical announcements (and let recent ones close their windows) to tighten the multiplier.`,
    );
  }

  return {
    launches,
    aggregate,
    generatedAt: new Date().toISOString(),
    salesHistoryAsOf,
    warnings,
  };
}

// ---- Helpers --------------------------------------------------------------

/** Allow either "YYYY-MM-DD" strings or JS Date objects (Sheets' date cells
 *  come through either way depending on cell formatting). Returns '' on
 *  unrecognized input so callers can skip the row. */
function dateOnly(v: unknown): string {
  if (!v) return '';
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  // Accept ISO YYYY-MM-DD directly; tolerate the timestamp form too.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Fallback: try Date parse for US-formatted dates etc.
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  return '';
}

function numFrom(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sumInRange(
  byDate: Map<string, number> | undefined,
  startIso: string,
  endIso: string,
): number {
  if (!byDate) return 0;
  let total = 0;
  for (const [d, u] of byDate) {
    if (d >= startIso && d <= endIso) total += u;
  }
  return total;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, n) => s + n, 0) / arr.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function quantile(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function emptyAggregate(): LaunchLiftAggregate {
  return {
    launchCount: 0,
    medianExistingLift: null,
    medianNewSkuFirstWindowUnits: null,
    p25ExistingLift: null,
    p75ExistingLift: null,
  };
}
