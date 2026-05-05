/**
 * Reorder forecasting — applies the HIKERS PO policy to live inventory data
 * to produce suggested reorder quantities, split 75/25 between Amazon (AWD)
 * and ShipBob legs per the policy memo.
 *
 * Policy summary (from project_po_policies memo):
 *   1. Target days-cover defaults to 90 (~1 quarter, tunable per call).
 *   2. Reorder math: gapDays = target − (totalOnHand + inTransit + draftPo) / avgPerDay
 *      → rawSuggestedQty = gapDays × avgPerDay
 *   3. Split:
 *      • Amazon eligible when SKU has an FBA SKU AND amazonTotal/avgPerDay < 45
 *        (i.e. Amazon is currently below 45 days cover — the slow-mover gate).
 *      • Eligible: Amz = ceil(raw × 0.75, 100), SB = max(ceil(raw × 0.25, 100), 100)
 *      • Ineligible: Amz = 0, SB = ceil(raw, 100)
 *   4. 100-unit floor per leg (CEILING-to-100). Smaller legs round up.
 *   5. SKUs with avgPerDay ≤ 0 produce no suggestion (can't extrapolate).
 *   6. Inactive SKUs are filtered out before this layer.
 *
 * The math is purposely separated from the data layer so it can be unit-tested
 * without hitting the Sheets API.
 */

import {
  loadApparelDashboard,
  loadAccessoriesDashboard,
  type ApparelDashboardRow,
  type AccessoriesDashboardRow,
} from './inventory';
import {
  AMAZON_SHARE, AMAZON_SLOW_MOVER_GATE_DAYS, PO_LEG_FLOOR, ceilTo,
} from './policy';

export { AMAZON_SHARE, AMAZON_SLOW_MOVER_GATE_DAYS, PO_LEG_FLOOR };
export const DEFAULT_TARGET_DAYS = 90;

export interface ReorderInput {
  sku: string;
  category: 'apparel' | 'accessories';
  style: string;
  color: string;
  size: string;       // empty for accessories
  active: boolean;
  hasFbaSku: boolean;
  totalOnHand: number;
  amazonTotal: number;
  inTransit: number;
  draftPo: number;
  avgPerDay30d: number;
  unitCost: number;
}

export interface ReorderSuggestion {
  sku: string;
  category: 'apparel' | 'accessories';
  style: string;
  color: string;
  size: string;
  hasFbaSku: boolean;
  // Diagnostics
  totalOnHand: number;
  amazonTotal: number;
  inTransit: number;
  draftPo: number;
  avgPerDay30d: number;
  effectiveDaysCover: number;
  amazonDaysCover: number;
  // Decision
  amazonEligible: boolean;
  amazonEligibilityReason: string;
  rawSuggestedQty: number;       // Pre-policy, just the gap × avgPerDay
  amzPlan: number;               // After 75/25 split + ceil-100
  sbPlan: number;                // After 25% + 100-floor or full leg if Amz=0
  totalPlan: number;             // Amz + SB
  estimatedCost: number;         // totalPlan × unitCost
}

export function computeReorderPlan(
  input: ReorderInput,
  targetDays: number = DEFAULT_TARGET_DAYS,
): ReorderSuggestion {
  const supply = input.totalOnHand + input.inTransit + input.draftPo;
  const effectiveDaysCover = input.avgPerDay30d > 0 ? supply / input.avgPerDay30d : Infinity;
  const amazonDaysCover    = input.avgPerDay30d > 0 ? input.amazonTotal / input.avgPerDay30d : Infinity;

  // Amazon eligibility per policy
  let amazonEligible = false;
  let amazonEligibilityReason = '';
  if (!input.hasFbaSku) {
    amazonEligibilityReason = 'No FBA SKU — ShipBob only';
  } else if (input.avgPerDay30d <= 0) {
    amazonEligibilityReason = 'No velocity data';
  } else if (amazonDaysCover >= AMAZON_SLOW_MOVER_GATE_DAYS) {
    amazonEligibilityReason = `Amazon already has ${amazonDaysCover.toFixed(0)} days cover (≥${AMAZON_SLOW_MOVER_GATE_DAYS}); routing to ShipBob`;
  } else {
    amazonEligible = true;
    amazonEligibilityReason = 'Eligible';
  }

  // No reorder needed if velocity unknown or already past target
  if (input.avgPerDay30d <= 0 || effectiveDaysCover >= targetDays) {
    return {
      sku: input.sku,
      category: input.category,
      style: input.style, color: input.color, size: input.size,
      hasFbaSku: input.hasFbaSku,
      totalOnHand: input.totalOnHand,
      amazonTotal: input.amazonTotal,
      inTransit: input.inTransit, draftPo: input.draftPo,
      avgPerDay30d: input.avgPerDay30d,
      effectiveDaysCover, amazonDaysCover,
      amazonEligible, amazonEligibilityReason,
      rawSuggestedQty: 0,
      amzPlan: 0, sbPlan: 0, totalPlan: 0,
      estimatedCost: 0,
    };
  }

  const gapDays = targetDays - effectiveDaysCover;
  const rawSuggestedQty = Math.max(0, gapDays * input.avgPerDay30d);

  // Apply split + floor
  let amzPlan = 0;
  let sbPlan  = 0;
  if (amazonEligible) {
    amzPlan = ceilTo(rawSuggestedQty * AMAZON_SHARE, PO_LEG_FLOOR);
    sbPlan  = Math.max(ceilTo(rawSuggestedQty * (1 - AMAZON_SHARE), PO_LEG_FLOOR), PO_LEG_FLOOR);
  } else {
    sbPlan = ceilTo(rawSuggestedQty, PO_LEG_FLOOR);
  }
  const totalPlan = amzPlan + sbPlan;

  return {
    sku: input.sku,
    category: input.category,
    style: input.style, color: input.color, size: input.size,
    hasFbaSku: input.hasFbaSku,
    totalOnHand: input.totalOnHand,
    amazonTotal: input.amazonTotal,
    inTransit: input.inTransit, draftPo: input.draftPo,
    avgPerDay30d: input.avgPerDay30d,
    effectiveDaysCover, amazonDaysCover,
    amazonEligible, amazonEligibilityReason,
    rawSuggestedQty: Math.round(rawSuggestedQty),
    amzPlan, sbPlan, totalPlan,
    estimatedCost: totalPlan * input.unitCost,
  };
}

// ---- Loader -----------------------------------------------------------------

export interface LoadReorderOpts {
  /** Target days cover; defaults to 90 (≈1 quarter). */
  targetDays?: number;
  /** Include inactive SKUs in suggestions. Default false. */
  includeInactive?: boolean;
}

export interface ReorderReport {
  targetDays: number;
  generatedAt: string;
  suggestions: ReorderSuggestion[];
  /** SKUs that need reordering (totalPlan > 0). Sorted by urgency. */
  reorderList: ReorderSuggestion[];
  /** Aggregate totals for the reorder list. */
  totals: {
    distinctSkus: number;
    amzUnits: number;
    sbUnits: number;
    totalUnits: number;
    estimatedCost: number;
  };
}

export async function loadReorderReport(opts: LoadReorderOpts = {}): Promise<ReorderReport> {
  const targetDays = opts.targetDays ?? DEFAULT_TARGET_DAYS;
  const includeInactive = opts.includeInactive ?? false;

  const [apparel, accessories] = await Promise.all([
    loadApparelDashboard(),
    loadAccessoriesDashboard(),
  ]);

  const inputs: ReorderInput[] = [
    ...apparel
      .filter((r) => includeInactive || r.active)
      .map(apparelToInput),
    ...accessories
      .filter((r) => includeInactive || r.active)
      .map(accessoriesToInput),
  ];

  const suggestions = inputs.map((i) => computeReorderPlan(i, targetDays));
  const reorderList = suggestions
    .filter((s) => s.totalPlan > 0)
    .sort((a, b) => a.effectiveDaysCover - b.effectiveDaysCover);  // most urgent first

  const totals = reorderList.reduce(
    (acc, s) => {
      acc.distinctSkus += 1;
      acc.amzUnits += s.amzPlan;
      acc.sbUnits  += s.sbPlan;
      acc.totalUnits += s.totalPlan;
      acc.estimatedCost += s.estimatedCost;
      return acc;
    },
    { distinctSkus: 0, amzUnits: 0, sbUnits: 0, totalUnits: 0, estimatedCost: 0 },
  );

  return {
    targetDays,
    generatedAt: new Date().toISOString(),
    suggestions,
    reorderList,
    totals,
  };
}

function apparelToInput(r: ApparelDashboardRow): ReorderInput {
  return {
    sku: r.sku,
    category: 'apparel',
    style: r.style, color: r.color, size: r.size,
    active: r.active,
    hasFbaSku: r.fbaAvailable + r.fbaReserved + r.fbaInbound + r.awdStorage + r.awdTransit > 0
      // The above is a proxy: any Amazon presence implies an FBA SKU exists.
      // For SKUs with zero on hand at Amazon we'd also want an explicit hasFbaSku
      // flag — we'll add one in a follow-up so brand-new SKUs aren't accidentally
      // classified ineligible.
      || r.amazonTotal > 0,
    totalOnHand: r.totalOnHand,
    amazonTotal: r.amazonTotal,
    inTransit: r.inTransitAir + r.inTransitSea,
    draftPo: r.draftPo,
    avgPerDay30d: r.avgPerDay30d,
    unitCost: r.unitCost,
  };
}

function accessoriesToInput(r: AccessoriesDashboardRow): ReorderInput {
  return {
    sku: r.sku,
    category: 'accessories',
    style: r.style, color: r.color, size: '',
    active: r.active,
    hasFbaSku: r.fbaAvailable + r.amazonTotal > 0,
    totalOnHand: r.totalOnHand,
    amazonTotal: r.amazonTotal,
    inTransit: r.inTransit,
    draftPo: r.draftPo,
    avgPerDay30d: r.avgPerDay30d,
    unitCost: r.unitCost,
  };
}

// ---- CSV export -------------------------------------------------------------

export function reorderListToCsv(report: ReorderReport): string {
  const header = [
    'SKU', 'Category', 'Style', 'Color', 'Size',
    'Total On Hand', 'Amazon Total', 'In-Transit', 'Draft PO',
    'Avg/Day 30d', 'Days Cover', 'Amazon Days Cover',
    'Amazon Eligible', 'Eligibility Reason',
    'Raw Suggested', 'Amz Plan', 'SB Plan', 'Total Plan', 'Est. Cost',
  ];
  const escape = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = report.reorderList.map((s) => [
    s.sku, s.category, s.style, s.color, s.size,
    s.totalOnHand, s.amazonTotal, s.inTransit, s.draftPo,
    s.avgPerDay30d.toFixed(2),
    s.effectiveDaysCover === Infinity ? '∞' : s.effectiveDaysCover.toFixed(1),
    s.amazonDaysCover === Infinity ? '∞' : s.amazonDaysCover.toFixed(1),
    s.amazonEligible ? 'Y' : 'N',
    s.amazonEligibilityReason,
    s.rawSuggestedQty, s.amzPlan, s.sbPlan, s.totalPlan, s.estimatedCost.toFixed(2),
  ]);
  return [header, ...rows].map((row) => row.map(escape).join(',')).join('\n');
}
