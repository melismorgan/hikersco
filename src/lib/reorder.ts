/**
 * Reorder forecasting — applies the HIKERS PO policy to live inventory data
 * to produce suggested reorder quantities, split 75/25 between Amazon (AWD)
 * and ShipBob legs per the policy memo.
 *
 * Policy summary (from project_po_policies memo):
 *   1. Target days-cover defaults to 90 (~1 quarter, tunable per call).
 *   2. Reorder math: gapDays = target − (totalOnHand + inTransit + draftPo) / avgPerDay
 *      → rawSuggestedQty = gapDays × avgPerDay + spikeFromUpcomingEvents
 *   3. Split:
 *      • Amazon eligible when SKU has an FBA SKU AND amazonTotal/avgPerDay < 45
 *        (i.e. Amazon is currently below 45 days cover — the slow-mover gate).
 *      • Eligible: Amz = ceil(raw × 0.75, 100), SB = max(ceil(raw × 0.25, 100), 100)
 *      • Ineligible: Amz = 0, SB = ceil(raw, 100)
 *   4. 100-unit floor per leg (CEILING-to-100). Smaller legs round up.
 *   5. SKUs with avgPerDay ≤ 0 produce no suggestion (can't extrapolate).
 *   6. Inactive SKUs are filtered out before this layer.
 *
 * Events tab integration (lib/events.ts):
 *   - When a SKU is currently in (or just past) an Event window with
 *     Exclude From Velocity Avg = Y, the 30d Avg/Day is anomalous and we
 *     substitute the 90d Avg/Day for stability. The substitution is recorded
 *     on the suggestion (`velocityAdjusted=true`) so the UI can show the
 *     reason.
 *   - When a Planned/Active Event has Expected Units covering this SKU, the
 *     per-SKU share gets added to rawSuggestedQty as a demand spike. The
 *     suggestion records the spike units + contributing event names.
 *
 * The math is purposely separated from the data layer so it can be unit-tested
 * without hitting the Sheets API.
 */

import {
  loadApparelDashboard,
  loadAccessoriesDashboard,
  readVelocityFull,
  type ApparelDashboardRow,
  type AccessoriesDashboardRow,
} from './inventory';
import {
  AMAZON_SHARE, AMAZON_SLOW_MOVER_GATE_DAYS, PO_LEG_FLOOR, ceilTo,
} from './policy';
import {
  buildEventsBySku,
  findActiveExclusionEvent,
  readEvents,
  spikeUnitsForSku,
  type EventRow,
} from './events';

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
  /** 90d Avg/Day — used as the substitute when an Events-flagged window
   *  pollutes the 30d rolling average. 0 if not provided (no substitution). */
  avgPerDay90d?: number;
  unitCost: number;
  /** Events-driven adjustments (computed in loadReorderReport, not by callers
   *  who hand-build a ReorderInput for tests). */
  velocityAdjustedTo90d?: boolean;
  velocityAdjustReason?: string;
  spikeUnits?: number;
  spikeReason?: string;
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
  /** Whichever Avg/Day actually drove the math — equals avgPerDay30d in the
   *  default case, or 90d Avg/Day when a Velocity exclusion was in effect. */
  effectiveAvgPerDay: number;
  effectiveDaysCover: number;
  amazonDaysCover: number;
  // Decision
  amazonEligible: boolean;
  amazonEligibilityReason: string;
  rawSuggestedQty: number;       // Pre-policy, gap × avgPerDay + spike
  amzPlan: number;               // After 75/25 split + ceil-100
  sbPlan: number;                // After 25% + 100-floor or full leg if Amz=0
  totalPlan: number;             // Amz + SB
  estimatedCost: number;         // totalPlan × unitCost
  // Events integration
  velocityAdjusted: boolean;
  velocityAdjustReason: string;
  spikeUnits: number;
  spikeReason: string;
}

export function computeReorderPlan(
  input: ReorderInput,
  targetDays: number = DEFAULT_TARGET_DAYS,
): ReorderSuggestion {
  // ---- Effective Avg/Day --------------------------------------------------
  // If an Events-driven exclusion is in effect AND we have a 90d alternate,
  // the 90d figure is the more reliable forward-demand estimate (less
  // pollution from the launch burst). Fall back to 30d when 90d is missing.
  const velocityAdjusted = !!input.velocityAdjustedTo90d &&
    typeof input.avgPerDay90d === 'number' && input.avgPerDay90d > 0;
  const velocityAdjustReason = velocityAdjusted
    ? input.velocityAdjustReason ?? ''
    : '';
  const effectiveAvgPerDay = velocityAdjusted
    ? (input.avgPerDay90d as number)
    : input.avgPerDay30d;

  const supply = input.totalOnHand + input.inTransit + input.draftPo;
  const effectiveDaysCover = effectiveAvgPerDay > 0 ? supply / effectiveAvgPerDay : Infinity;
  // Amazon eligibility uses the same Avg/Day we're projecting demand on, so
  // the slow-mover gate stays consistent with the rest of the math.
  const amazonDaysCover    = effectiveAvgPerDay > 0 ? input.amazonTotal / effectiveAvgPerDay : Infinity;

  const spikeUnits  = Math.max(0, input.spikeUnits ?? 0);
  const spikeReason = spikeUnits > 0 ? (input.spikeReason ?? '') : '';

  // Amazon eligibility per policy
  let amazonEligible = false;
  let amazonEligibilityReason = '';
  if (!input.hasFbaSku) {
    amazonEligibilityReason = 'No FBA SKU — ShipBob only';
  } else if (effectiveAvgPerDay <= 0) {
    amazonEligibilityReason = 'No velocity data';
  } else if (amazonDaysCover >= AMAZON_SLOW_MOVER_GATE_DAYS) {
    amazonEligibilityReason = `Amazon already has ${amazonDaysCover.toFixed(0)} days cover (≥${AMAZON_SLOW_MOVER_GATE_DAYS}); routing to ShipBob`;
  } else {
    amazonEligible = true;
    amazonEligibilityReason = 'Eligible';
  }

  // No reorder needed if velocity unknown or already past target — UNLESS
  // there's an upcoming spike that pushes us into "pre-stock now" territory.
  // We still proceed if spikeUnits > 0 so the spike alone can drive a PO.
  if ((effectiveAvgPerDay <= 0 || effectiveDaysCover >= targetDays) && spikeUnits <= 0) {
    return {
      sku: input.sku,
      category: input.category,
      style: input.style, color: input.color, size: input.size,
      hasFbaSku: input.hasFbaSku,
      totalOnHand: input.totalOnHand,
      amazonTotal: input.amazonTotal,
      inTransit: input.inTransit, draftPo: input.draftPo,
      avgPerDay30d: input.avgPerDay30d,
      effectiveAvgPerDay,
      effectiveDaysCover, amazonDaysCover,
      amazonEligible, amazonEligibilityReason,
      rawSuggestedQty: 0,
      amzPlan: 0, sbPlan: 0, totalPlan: 0,
      estimatedCost: 0,
      velocityAdjusted, velocityAdjustReason,
      spikeUnits, spikeReason,
    };
  }

  // Gap-fill from velocity (clamped at 0 if already over target), plus the
  // upcoming-event spike. Spike is additive — it represents extra demand the
  // rolling avg can't see yet.
  const gapDays = Math.max(0, targetDays - effectiveDaysCover);
  const gapFillUnits = effectiveAvgPerDay > 0 ? gapDays * effectiveAvgPerDay : 0;
  const rawSuggestedQty = Math.max(0, gapFillUnits + spikeUnits);

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
    effectiveAvgPerDay,
    effectiveDaysCover, amazonDaysCover,
    amazonEligible, amazonEligibilityReason,
    rawSuggestedQty: Math.round(rawSuggestedQty),
    amzPlan, sbPlan, totalPlan,
    estimatedCost: totalPlan * input.unitCost,
    velocityAdjusted, velocityAdjustReason,
    spikeUnits, spikeReason,
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
  /** Events that influenced this report — surfaced so the UI can show "we
   *  applied these adjustments." Empty when no events match. */
  appliedEvents: AppliedEventSummary[];
}

export interface AppliedEventSummary {
  eventId: string;
  name: string;
  type: string;
  status: string;
  startDate: string;
  endDate: string;
  /** # SKUs whose Avg/Day was substituted with 90d due to this event. */
  velocityAdjustedSkuCount: number;
  /** # SKUs that received a demand spike from this event. */
  spikedSkuCount: number;
  /** Total spike units distributed across SKUs from this event. */
  totalSpikeUnits: number;
}

export async function loadReorderReport(opts: LoadReorderOpts = {}): Promise<ReorderReport> {
  const targetDays = opts.targetDays ?? DEFAULT_TARGET_DAYS;
  const includeInactive = opts.includeInactive ?? false;

  const [apparel, accessories, events, velocityFull] = await Promise.all([
    loadApparelDashboard(),
    loadAccessoriesDashboard(),
    readEvents().catch(() => [] as EventRow[]), // tolerate sheet-side failures
    readVelocityFull().catch(() => []),
  ]);

  // Index 90d Avg/Day by SKU for the exclusion-substitution path.
  const avgPerDay90dBySku = new Map<string, number>();
  for (const v of velocityFull) {
    if (v.sku) avgPerDay90dBySku.set(v.sku, v.avgPerDay90d);
  }

  // Build the list of inputs first so we know the SKU universe events apply
  // to. We then expand each event's Linked Parents against this universe.
  const inputsRaw: ReorderInput[] = [
    ...apparel
      .filter((r) => includeInactive || r.active)
      .map(apparelToInput),
    ...accessories
      .filter((r) => includeInactive || r.active)
      .map(accessoriesToInput),
  ];
  const allSkus = inputsRaw.map((i) => i.sku);
  const eventsBySku = buildEventsBySku(events, allSkus);

  // Apply events to each input — substitute 90d Avg/Day on exclusions, add
  // per-SKU spike from upcoming campaigns. Track applied events per-event so
  // we can surface a summary.
  const asOf = new Date();
  const eventStats = new Map<string, { vel: number; spike: number; spikeUnits: number }>();
  const inputs = inputsRaw.map((i): ReorderInput => {
    const exclusion = findActiveExclusionEvent(i.sku, events, eventsBySku, asOf);
    const { spike, events: contributing } = spikeUnitsForSku(i.sku, events, eventsBySku, asOf);

    let velocityAdjustedTo90d = false;
    let velocityAdjustReason = '';
    if (exclusion) {
      const stats = eventStats.get(exclusion.eventId) ??
        { vel: 0, spike: 0, spikeUnits: 0 };
      stats.vel += 1;
      eventStats.set(exclusion.eventId, stats);
      const has90d = (avgPerDay90dBySku.get(i.sku) ?? 0) > 0;
      if (has90d) {
        velocityAdjustedTo90d = true;
        velocityAdjustReason =
          `${exclusion.name} (${exclusion.eventId}) — using 90d Avg/Day instead of 30d`;
      }
    }
    let spikeReason = '';
    if (spike > 0 && contributing.length > 0) {
      for (const ev of contributing) {
        const stats = eventStats.get(ev.eventId) ??
          { vel: 0, spike: 0, spikeUnits: 0 };
        stats.spike += 1;
        // Total units the event contributed to this SKU (already
        // apportioned). Sum across SKUs to get the per-event total.
        // contributing has the events for THIS sku only, so we approximate
        // by dividing the event's expectedUnits by linkedCount once and
        // adding it. Since spikeUnitsForSku already did the division, we
        // just add the per-SKU share here:
        stats.spikeUnits += ev.expectedUnits / Math.max(1, countLinked(ev, eventsBySku));
        eventStats.set(ev.eventId, stats);
      }
      spikeReason = contributing.map((ev) =>
        `${ev.name} (+${Math.round(spike / contributing.length)} units)`,
      ).join('; ');
    }

    return {
      ...i,
      avgPerDay90d: avgPerDay90dBySku.get(i.sku) ?? 0,
      velocityAdjustedTo90d,
      velocityAdjustReason,
      spikeUnits: Math.round(spike),
      spikeReason,
    };
  });

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

  // Build applied-events summary — only events that actually moved something.
  const appliedEvents: AppliedEventSummary[] = [];
  for (const ev of events) {
    const stats = eventStats.get(ev.eventId);
    if (!stats || (stats.vel === 0 && stats.spike === 0)) continue;
    appliedEvents.push({
      eventId: ev.eventId,
      name: ev.name,
      type: ev.type,
      status: ev.status,
      startDate: ev.startDate,
      endDate: ev.endDate,
      velocityAdjustedSkuCount: stats.vel,
      spikedSkuCount: stats.spike,
      totalSpikeUnits: Math.round(stats.spikeUnits),
    });
  }

  return {
    targetDays,
    generatedAt: new Date().toISOString(),
    suggestions,
    reorderList,
    totals,
    appliedEvents,
  };
}

/** Local helper — duplicates events.countLinkedSkus since that one isn't
 *  exported. Cheap enough at our scale (<200 SKUs × handful of events). */
function countLinked(ev: EventRow, eventsBySku: Map<string, EventRow[]>): number {
  let n = 0;
  for (const list of eventsBySku.values()) if (list.includes(ev)) n++;
  return n;
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
    'Avg/Day 30d', 'Effective Avg/Day', 'Velocity Adjusted', 'Spike Units',
    'Days Cover', 'Amazon Days Cover',
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
    s.effectiveAvgPerDay.toFixed(2),
    s.velocityAdjusted ? 'Y' : '',
    s.spikeUnits || '',
    s.effectiveDaysCover === Infinity ? '∞' : s.effectiveDaysCover.toFixed(1),
    s.amazonDaysCover === Infinity ? '∞' : s.amazonDaysCover.toFixed(1),
    s.amazonEligible ? 'Y' : 'N',
    s.amazonEligibilityReason,
    s.rawSuggestedQty, s.amzPlan, s.sbPlan, s.totalPlan, s.estimatedCost.toFixed(2),
  ]);
  return [header, ...rows].map((row) => row.map(escape).join(',')).join('\n');
}
