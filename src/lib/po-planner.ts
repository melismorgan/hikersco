/**
 * PO Coverage Planner — strategic forward-looking inventory planning.
 *
 * Powers the "Planning mode" of /reorder. Tactical mode (the existing
 * loadReorderReport flow) answers "what should I restock NOW based on
 * current velocity + a 90-day target days-cover?" Planning mode answers
 * a different question:
 *
 *   Given that THIS PO lands on a specific date and the NEXT PO lands
 *   later, how much of each SKU should I order so that the inventory
 *   landing in THIS PO comfortably covers all the demand (organic + every
 *   event) between THIS PO's landing date and NEXT PO's landing date,
 *   after accounting for current on-hand + everything else that's
 *   already incoming?
 *
 * Reuses the existing tactical infrastructure for supply-side data
 * (inventory, in-transit, draft POs) and policy enforcement (75/25 split,
 * Amazon slow-mover gate, 100-unit floor). The new work here is on the
 * DEMAND side: composing organic velocity + per-event multiplier-driven
 * spikes over the planning window into a per-SKU expected-demand number.
 *
 * Multiplier math is borrowed from `lib/seasonal-analysis.ts` by calling
 * loadSeasonalAnalysis() — that gets us per-event aggregate multipliers
 * AND per-SKU current daily velocity in one shot. Some output gets
 * thrown away (channel mix, monthly trend, etc.) but the duplication
 * avoidance is worth more than the wasted compute.
 *
 * Single source of truth for event Linked Parents expansion: lib/events.ts
 * (expandLinkedParents). When the user accepts the auto-populated
 * Expected Units, those write back to the Events tab and the EXISTING
 * tactical reorder logic picks them up automatically — no separate
 * integration needed.
 */

import {
  loadApparelDashboard,
  loadAccessoriesDashboard,
  readStyleLines,
  type ApparelDashboardRow,
  type AccessoriesDashboardRow,
} from './inventory';
import { readEvents, expandLinkedParents, type EventRow } from './events';
import {
  loadSeasonalAnalysis,
  type EventYoY,
  type CurrentSkuVelocity,
  type SeasonalAnalysisData,
} from './seasonal-analysis';
import { SEASONAL_EVENTS, eventWindowFor } from './seasonal-events';
import {
  AMAZON_SHARE, AMAZON_SLOW_MOVER_GATE_DAYS, PO_LEG_FLOOR, ceilTo,
} from './policy';

/* ===== Public types ===== */

export type MultiplierMode = 'latest' | 'weighted' | 'avg';

export interface LoadPoCoverageOpts {
  /** ISO 'YYYY-MM-DD' — date this PO is expected to land in HIKERS' warehouses
   *  (ShipBob + AWD). Demand from "now" through this date is supply-side
   *  burn-down; demand from this date onward is what the PO needs to cover. */
  thisPoLandsAt: string;
  /** ISO 'YYYY-MM-DD' — date the NEXT PO after this one will land. Defines
   *  the planning window's far end. */
  nextPoLandsAt: string;
  /** Which aggregate multiplier flavor to use for the event-demand math.
   *  Defaults to 'weighted' (the same default as the /sales forecast view). */
  multiplierMode?: MultiplierMode;
  /** Safety stock multiplier on top of the central demand estimate. Defaults
   *  to 1.2 (20% buffer), same as the existing forecast view. */
  buffer?: number;
  /** Include inactive SKUs (SKU Master column R = 'N'). Default false. */
  includeInactive?: boolean;
  /** Per-event window-length overrides, keyed by event key. When absent we
   *  fall back to the event's calendar default. Lets the user say "this
   *  year's BFCM ramp is 21 days, not the default 18." */
  windowOverrides?: Record<string, number>;
}

export interface PlannedEvent {
  eventKey: string;
  eventName: string;
  /** ISO date this event's window starts (within the planning coverage). */
  start: string;
  /** ISO date the event's window ends (exclusive). */
  end: string;
  durationDays: number;
  /** Chosen aggregate multiplier per the multiplierMode option. */
  multiplier: number;
  /** Whether the multiplier was available from historical data; if false
   *  the event's demand will be organic-only and we surface that to the user. */
  hasMultiplier: boolean;
  /** SKUs explicitly linked to this event via the Events tab Linked Parents
   *  column. Empty array means "all active SKUs" (default per existing
   *  events.ts behavior when LinkedParents is blank). */
  linkedSkus: string[];
  /** Whether this event was sourced from the Events tab (manual) or
   *  generated from the SEASONAL_EVENTS calendar (auto-inferred). */
  source: 'events-tab' | 'calendar';
  /** Existing Expected Units value from the Events tab, if any. */
  existingExpectedUnits: number;
  /** What the multiplier math suggests Expected Units should be. Sums the
   *  per-SKU expected event-driven demand across all linked SKUs. */
  suggestedExpectedUnits: number;
  /** Manual multiplier from the Events-tab column. Used when no historical
   *  multiplier is available (new launches, novel events). 0 = no override. */
  manualMultiplier: number;
  /** Halo multiplier applied to NON-linked SKUs during the event window —
   *  captures the sitewide traffic bump from any campaign send. 0 = no halo. */
  sitewideHalo: number;
  /** Per-SKU Expected Units share for brand-new (zero-velocity) linked SKUs.
   *  Computed once per event from existingExpectedUnits / zero-velocity-linked
   *  count. Lets the planner size initial launch demand without a velocity
   *  baseline. 0 = no fallback applied. */
  zeroVelocityShare: number;
}

export interface PoCoverageRow {
  sku: string;
  category: 'apparel' | 'accessories';
  style: string;
  color: string;
  size: string;
  /** Order index within a style's size run (XS=1, S=2, …). 0 if unknown. */
  sizeOrder: number;
  /** Product line — Upfitter, Deluxe, Heavy-Duty, etc. Populated from
   *  Style_Templates Col C via the readStyleLines map. Falls back to the
   *  style code itself when the mapping is missing. */
  line: string;
  active: boolean;
  hasFbaSku: boolean;

  /** Current daily velocity (organic days, last 30d) — basis for demand math. */
  currentDailyVelocity: number;

  /** Current totals across all locations. */
  totalOnHandNow: number;
  amazonOnHandNow: number;
  /** In-transit + draft POs whose ETA is before thisPoLandsAt — i.e., supply
   *  that will land before the planned PO does. */
  arrivalsBeforeLanding: number;
  /** Per-PO breakdown of the above, for UI tooltips so Melissa can audit
   *  what's being counted (and spot a missing/mis-statused PO). The status
   *  field lets the UI tag user-created drafts that haven't been moved to
   *  Incoming yet. */
  arrivalsBeforeLandingDetail: Array<{ poNumber: string; eta: string; qty: number; status: 'Incoming' | 'Draft' }>;
  /** In-transit + draft POs whose ETA is after thisPoLandsAt but before
   *  nextPoLandsAt — supply that will offset some of the demand window. */
  arrivalsInWindow: number;
  /** Per-PO breakdown of the in-window arrivals. */
  arrivalsInWindowDetail: Array<{ poNumber: string; eta: string; qty: number; status: 'Incoming' | 'Draft' }>;
  /** Per-PO breakdown of incoming entries that landed OUTSIDE both buckets
   *  (eta after nextPoLandsAt, or eta unparseable). Surfaced so a row that
   *  Melissa expected to count but doesn't is debuggable from the UI. */
  arrivalsExcluded: Array<{ poNumber: string; eta: string; qty: number; reason: string; status: 'Incoming' | 'Draft' }>;

  /** Days from today to thisPoLandsAt. */
  daysToLanding: number;
  /** Estimated organic burn between today and landing (currentDailyVelocity
   *  × daysToLanding). Doesn't yet apply event multipliers for events
   *  between today and landing — events ahead of landing are surfaced
   *  separately if any. */
  organicBurnToLanding: number;
  /** Sum of event-driven demand for events that fall BEFORE thisPoLandsAt
   *  (e.g., Labor Day if the PO lands in late September). */
  preLandingEventDemand: number;
  /** Inventory we expect to have on hand the day the new PO lands. */
  availableAtLanding: number;

  /** Days inside the coverage window that aren't inside any event window. */
  organicDaysInWindow: number;
  /** Demand from those organic days. */
  organicDemandInWindow: number;
  /** Per-event demand contributions inside the coverage window. */
  perEventDemand: { eventKey: string; eventName: string; demand: number }[];
  /** Sum of organic + per-event demand inside the coverage window. */
  totalDemandInWindow: number;

  /** Net gap between buffered demand and supply. The raw recommendation
   *  before policy floors and Amazon eligibility get applied. */
  rawSuggestedQty: number;
  /** 75/25 split: Amazon portion. 0 if Amazon ineligible. */
  amzPlan: number;
  /** 75/25 split: ShipBob portion. */
  sbPlan: number;
  /** amz + sb. */
  totalPlan: number;
  /** Whether Amazon was eligible (has FBA SKU + Amazon under 45-day cover). */
  amazonEligible: boolean;
  amazonEligibilityReason: string;
  /** unitCost × totalPlan. */
  estimatedCost: number;
  unitCost: number;
}

export interface PoCoveragePlan {
  /** Options resolved (filled-in defaults made explicit). */
  thisPoLandsAt: string;
  nextPoLandsAt: string;
  multiplierMode: MultiplierMode;
  buffer: number;
  /** Date the loader ran. */
  generatedAt: string;

  /** Days from today (in PT) to thisPoLandsAt. */
  daysToLanding: number;
  /** Days from thisPoLandsAt to nextPoLandsAt (the planning window). */
  coverageWindowDays: number;

  /** Events that fall inside the coverage window. Sorted by start date. */
  eventsInWindow: PlannedEvent[];

  /** Per-SKU recommendations. Sorted by totalPlan desc. */
  perSku: PoCoverageRow[];

  /** Aggregate totals for SKUs needing reorder. */
  totals: {
    distinctSkus: number;
    amzUnits: number;
    sbUnits: number;
    totalUnits: number;
    estimatedCost: number;
  };

  /** The SeasonalAnalysisData asOf, exposed so callers know how fresh the
   *  velocity/multiplier inputs are. */
  asOf: string;

  /** Style → Line mapping (from Style_Templates), serialized as an object for
   *  JSON transport. Used by the view for style-grouped sort + line banners. */
  styleLineMap: Record<string, string>;
}

/* ===== Loader ===== */

export async function loadPoCoveragePlan(opts: LoadPoCoverageOpts): Promise<PoCoveragePlan> {
  const multiplierMode: MultiplierMode = opts.multiplierMode ?? 'weighted';
  const buffer = opts.buffer ?? 1.2;
  const includeInactive = opts.includeInactive ?? false;
  const today = ptToday();

  if (opts.thisPoLandsAt <= today) {
    throw new Error('thisPoLandsAt must be in the future (got ' + opts.thisPoLandsAt + ', today is ' + today + ')');
  }
  if (opts.nextPoLandsAt <= opts.thisPoLandsAt) {
    throw new Error('nextPoLandsAt must be after thisPoLandsAt');
  }

  const [apparel, accessories, eventRows, seasonal, styleLineMap] = await Promise.all([
    loadApparelDashboard(),
    loadAccessoriesDashboard(),
    readEvents().catch(() => [] as EventRow[]),
    loadSeasonalAnalysis(),
    readStyleLines().catch(() => new Map<string, string>()),
  ]);

  const daysToLanding = daysBetweenIso(today, opts.thisPoLandsAt);
  const coverageWindowDays = daysBetweenIso(opts.thisPoLandsAt, opts.nextPoLandsAt);

  // Precompute timestamp boundaries used by the incoming-PO partitioning.
  // Declared up here (not inside the per-SKU computation) so they're
  // initialized BEFORE the hoisted computePerSkuRow function is called by
  // the for-loops below — otherwise we hit a temporal-dead-zone error.
  // sumIncomingByEta compares via Date.parse-derived etaTimestamp so any
  // ETA string format on the POs tab resolves correctly.
  const thisPoLandsTs = new Date(opts.thisPoLandsAt + 'T23:59:59Z').getTime();
  const nextPoLandsTs = new Date(opts.nextPoLandsAt + 'T23:59:59Z').getTime();

  // SKU universe (active by default) + supporting indexes.
  const apparelRows = apparel.filter((r) => includeInactive || r.active);
  const accessoryRows = accessories.filter((r) => includeInactive || r.active);
  const allSkus = [...apparelRows.map((r) => r.sku), ...accessoryRows.map((r) => r.sku)];

  // Velocity index — pull from seasonal.currentSkuVelocity (last 30 organic
  // days, the same metric as the /sales forecast view uses). Falls back to
  // 0 for SKUs not in the seasonal data (= no sales in last 30 days).
  const velocityBySku = new Map<string, number>();
  seasonal.currentSkuVelocity.forEach((v) => velocityBySku.set(v.sku, v.dailyVelocity));

  // Build the list of planned events — both calendar-anchored (SEASONAL_EVENTS)
  // and manually-entered Events-tab rows that fall in the coverage window.
  // De-dupe in favor of the Events-tab entry when both match the same event.
  const eventsInWindow: PlannedEvent[] = [];
  const calendarEventsCovered = new Set<string>();

  // First pass: any Events-tab Promo / Launch / Restock rows in the window.
  // These are user-managed and take precedence over auto-inferred calendar events.
  for (const er of eventRows) {
    if (!er.startDate) continue;
    const evStart = er.startDate;
    const evEnd = er.endDate || addDaysIso(evStart, er.windowLengthDays || 7);
    // Overlap test with the coverage window [thisPoLandsAt, nextPoLandsAt)
    if (evStart >= opts.nextPoLandsAt || evEnd <= opts.thisPoLandsAt) continue;
    // expandLinkedParents returns a Set; convert to array for the typed shape.
    const linked = Array.from(expandLinkedParents(er.linkedParents, allSkus));
    eventsInWindow.push({
      eventKey: er.eventId,
      eventName: er.name,
      start: evStart,
      end: evEnd,
      durationDays: daysBetweenIso(evStart, evEnd) || (er.windowLengthDays || 7),
      // Events-tab entries don't carry a multiplier by themselves; if the
      // name matches a calendar event, borrow its multiplier; else fall back
      // to the user's Manual Multiplier (column X). Sitewide Halo (col Y)
      // applies to non-linked SKUs regardless.
      multiplier: 1,                          // refined below
      hasMultiplier: false,                    // refined below
      linkedSkus: linked,
      source: 'events-tab',
      existingExpectedUnits: er.expectedUnits || 0,
      suggestedExpectedUnits: 0,               // computed in per-SKU pass
      manualMultiplier: er.manualMultiplier || 0,
      sitewideHalo: er.sitewideHaloMultiplier || 0,
      zeroVelocityShare: 0,                    // computed below once SKU universe is fixed
    });
  }

  // Second pass: SEASONAL_EVENTS calendar entries falling in the window.
  // Year inference: the current year and next year, so events like January
  // Clearance show up if the coverage window crosses Dec 31.
  const today_d = new Date(today + 'T00:00:00Z');
  const lastDay = new Date(opts.nextPoLandsAt + 'T00:00:00Z');
  const yearsToCheck = new Set<number>();
  for (let d = new Date(today_d); d <= lastDay; d.setUTCMonth(d.getUTCMonth() + 6)) {
    yearsToCheck.add(d.getUTCFullYear());
  }
  yearsToCheck.add(lastDay.getUTCFullYear());

  for (const evt of SEASONAL_EVENTS) {
    for (const yr of yearsToCheck) {
      const cw = eventWindowFor(evt, yr);
      const overrideDays = opts.windowOverrides?.[evt.key];
      const usedLen = overrideDays ?? evt.window;
      const start = cw.start;
      const end = addDaysIso(start, usedLen);
      // Overlap test
      if (start >= opts.nextPoLandsAt || end <= opts.thisPoLandsAt) continue;
      // Skip if an Events-tab row already covers this date (de-dupe). Use
      // absDaysBetweenIso here — daysBetweenIso has a Math.max(0, ...) clamp
      // that would silently treat reverse-order dates as 0 apart, causing
      // every later calendar event to false-flag as a duplicate of any
      // earlier Events-tab row.
      const dup = eventsInWindow.some((e) =>
        e.source === 'events-tab' &&
        absDaysBetweenIso(e.start, start) <= 7,
      );
      if (dup) {
        // Note multiplier on the dup if its name matches the calendar event
        const eyo = seasonal.events.find((e) => e.key === evt.key);
        const m = chooseMultiplier(eyo, multiplierMode);
        const dupRow = eventsInWindow.find((e) =>
          e.source === 'events-tab' &&
          absDaysBetweenIso(e.start, start) <= 7,
        );
        if (dupRow && m !== null) {
          dupRow.multiplier = m;
          dupRow.hasMultiplier = true;
        }
        calendarEventsCovered.add(evt.key + '-' + yr);
        continue;
      }
      // Fresh calendar-driven event row
      const eyo = seasonal.events.find((e) => e.key === evt.key);
      const m = chooseMultiplier(eyo, multiplierMode);
      eventsInWindow.push({
        eventKey: evt.key + '-' + yr,
        eventName: evt.name,
        start,
        end,
        durationDays: usedLen,
        multiplier: m ?? 1,
        hasMultiplier: m !== null,
        // No Linked Parents on calendar events — they apply to all active SKUs
        // (which matches existing events.ts behavior for blank Linked Parents).
        linkedSkus: [],
        source: 'calendar',
        existingExpectedUnits: 0,
        suggestedExpectedUnits: 0,
        manualMultiplier: 0,                   // calendar events use their historical multiplier
        sitewideHalo: 0,                       // halo is for Events-tab announcements, not seasonal calendar
        zeroVelocityShare: 0,
      });
      calendarEventsCovered.add(evt.key + '-' + yr);
    }
  }

  eventsInWindow.sort((a, b) => a.start.localeCompare(b.start));

  // Compute per-event zeroVelocityShare for launches with brand-new linked
  // SKUs. Done once here so the per-SKU loop is O(events) instead of O(events
  // × SKUs). For each event whose linked SKUs include zero-velocity entries
  // AND has Expected Units > 0, split those units evenly across the new SKUs.
  // Caveat: "evenly" is a starter heuristic — if a launch is skewed toward a
  // hero color, Melissa can split into per-color events.
  for (const ev of eventsInWindow) {
    if (ev.existingExpectedUnits <= 0 || ev.linkedSkus.length === 0) continue;
    let zeroVelCount = 0;
    for (const s of ev.linkedSkus) {
      if ((velocityBySku.get(s) ?? 0) === 0) zeroVelCount++;
    }
    if (zeroVelCount > 0) {
      ev.zeroVelocityShare = ev.existingExpectedUnits / zeroVelCount;
    }
  }

  // Pre-landing events (between today and thisPoLandsAt) — surfaced per-SKU
  // as "pre-landing event demand" since they burn down inventory before the
  // new PO arrives. Includes both Events-tab rows (so a launch announced
  // before landing isn't invisible to the burn-down) and SEASONAL_EVENTS.
  const preLandingEvents: PlannedEvent[] = [];

  // First: Events-tab rows that overlap [today, thisPoLandsAt). Same shape
  // as the in-window pass above so the per-SKU loop treats them identically.
  for (const er of eventRows) {
    if (!er.startDate) continue;
    const evStart = er.startDate;
    const evEnd = er.endDate || addDaysIso(evStart, er.windowLengthDays || 7);
    if (evStart >= opts.thisPoLandsAt || evEnd <= today) continue;
    const linked = Array.from(expandLinkedParents(er.linkedParents, allSkus));
    preLandingEvents.push({
      eventKey: er.eventId + '-pre',
      eventName: er.name,
      start: evStart,
      end: evEnd,
      durationDays: daysBetweenIso(evStart, evEnd) || (er.windowLengthDays || 7),
      multiplier: 1,
      hasMultiplier: false,
      linkedSkus: linked,
      source: 'events-tab',
      existingExpectedUnits: er.expectedUnits || 0,
      suggestedExpectedUnits: 0,
      manualMultiplier: er.manualMultiplier || 0,
      sitewideHalo: er.sitewideHaloMultiplier || 0,
      zeroVelocityShare: 0,                    // resolved after the SEASONAL_EVENTS pass
    });
  }

  for (const evt of SEASONAL_EVENTS) {
    for (const yr of yearsToCheck) {
      const cw = eventWindowFor(evt, yr);
      const overrideDays = opts.windowOverrides?.[evt.key];
      const usedLen = overrideDays ?? evt.window;
      const start = cw.start;
      const end = addDaysIso(start, usedLen);
      if (end <= today || start >= opts.thisPoLandsAt) continue;
      const eyo = seasonal.events.find((e) => e.key === evt.key);
      const m = chooseMultiplier(eyo, multiplierMode);
      // De-dupe against any Events-tab pre-landing row already covering this
      // calendar event (same 7-day fuzzy check we use for the in-window pass).
      const dup = preLandingEvents.some((e) =>
        e.source === 'events-tab' && absDaysBetweenIso(e.start, start) <= 7,
      );
      if (dup) {
        const dupRow = preLandingEvents.find((e) =>
          e.source === 'events-tab' && absDaysBetweenIso(e.start, start) <= 7,
        );
        if (dupRow && m !== null) {
          dupRow.multiplier = m;
          dupRow.hasMultiplier = true;
        }
        continue;
      }
      preLandingEvents.push({
        eventKey: evt.key + '-pre-' + yr,
        eventName: evt.name,
        start,
        end,
        durationDays: usedLen,
        multiplier: m ?? 1,
        hasMultiplier: m !== null,
        linkedSkus: [],
        source: 'calendar',
        existingExpectedUnits: 0,
        suggestedExpectedUnits: 0,
        manualMultiplier: 0,
        sitewideHalo: 0,
        zeroVelocityShare: 0,
      });
    }
  }

  // Resolve zeroVelocityShare on pre-landing Events-tab rows now that all
  // events are gathered. Same logic as the in-window pass.
  for (const ev of preLandingEvents) {
    if (ev.existingExpectedUnits <= 0 || ev.linkedSkus.length === 0) continue;
    let zeroVelCount = 0;
    for (const s of ev.linkedSkus) {
      if ((velocityBySku.get(s) ?? 0) === 0) zeroVelCount++;
    }
    if (zeroVelCount > 0) {
      ev.zeroVelocityShare = ev.existingExpectedUnits / zeroVelCount;
    }
  }

  // Total organic days within the window (window length minus any days that
  // fall inside ANY event window, summed). When events overlap each other
  // (rare but possible) the overlap counts once toward event-days, not twice.
  const eventDaysInWindow = countDistinctDaysInRanges(
    eventsInWindow.map((e) => [
      maxIso(e.start, opts.thisPoLandsAt),
      minIso(e.end, opts.nextPoLandsAt),
    ]),
  );
  const organicDaysInWindow = Math.max(0, coverageWindowDays - eventDaysInWindow);

  // Pre-landing event days for the burn-down calc.
  const preLandingEventDaysCount = countDistinctDaysInRanges(
    preLandingEvents.map((e) => [
      maxIso(e.start, today),
      minIso(e.end, opts.thisPoLandsAt),
    ]),
  );
  const organicDaysBeforeLanding = Math.max(0, daysToLanding - preLandingEventDaysCount);

  // Per-SKU compute pass.
  const perSku: PoCoverageRow[] = [];
  // Suggested Expected Units per event — accumulated as we walk SKUs.
  const suggestedEUByEvent = new Map<string, number>();

  for (const r of apparelRows) {
    const row = computePerSkuRow(r, 'apparel');
    if (row) perSku.push(row);
  }
  for (const r of accessoryRows) {
    const row = computePerSkuRow(r, 'accessories');
    if (row) perSku.push(row);
  }

  // Stamp the suggestedExpectedUnits per event from the accumulator.
  for (const ev of eventsInWindow) {
    ev.suggestedExpectedUnits = Math.round(suggestedEUByEvent.get(ev.eventKey) ?? 0);
  }

  perSku.sort((a, b) => b.totalPlan - a.totalPlan);
  const totals = perSku
    .filter((r) => r.totalPlan > 0)
    .reduce(
      (acc, r) => {
        acc.distinctSkus++;
        acc.amzUnits += r.amzPlan;
        acc.sbUnits += r.sbPlan;
        acc.totalUnits += r.totalPlan;
        acc.estimatedCost += r.estimatedCost;
        return acc;
      },
      { distinctSkus: 0, amzUnits: 0, sbUnits: 0, totalUnits: 0, estimatedCost: 0 },
    );

  return {
    thisPoLandsAt: opts.thisPoLandsAt,
    nextPoLandsAt: opts.nextPoLandsAt,
    multiplierMode,
    buffer,
    generatedAt: new Date().toISOString(),
    daysToLanding,
    coverageWindowDays,
    eventsInWindow,
    perSku,
    totals,
    asOf: seasonal.asOf,
    styleLineMap: Object.fromEntries(styleLineMap),
  };

  /* ===== Inner helper: per-SKU row computation =====
     Has access to all the outer state (eventsInWindow, velocityBySku, etc.) */
  function computePerSkuRow(
    r: ApparelDashboardRow | AccessoriesDashboardRow,
    category: 'apparel' | 'accessories',
  ): PoCoverageRow | null {
    const sku = r.sku;
    const velocity = velocityBySku.get(sku) ?? 0;

    // Supply side: partition incoming POs into before/after landing AND
    // build per-PO detail lists for UI tooltips. The detail lists let
    // Melissa audit what's being counted vs. silently excluded.
    const arrivalsBeforeLandingDetail: Array<{ poNumber: string; eta: string; qty: number; status: 'Incoming' | 'Draft' }> = [];
    const arrivalsInWindowDetail: Array<{ poNumber: string; eta: string; qty: number; status: 'Incoming' | 'Draft' }> = [];
    const arrivalsExcluded: Array<{ poNumber: string; eta: string; qty: number; reason: string; status: 'Incoming' | 'Draft' }> = [];
    let arrivalsBeforeLanding = 0;
    let arrivalsInWindow = 0;
    for (const p of r.incoming) {
      const qty = Number(p.qty ?? 0) || 0;
      if (qty <= 0) continue;
      const entry = { poNumber: p.poNumber, eta: p.eta, qty, status: p.status };
      if (!Number.isFinite(p.etaTimestamp) || p.etaTimestamp === Number.MAX_SAFE_INTEGER) {
        arrivalsExcluded.push({ ...entry, reason: 'ETA missing or unparseable' });
      } else if (p.etaTimestamp <= thisPoLandsTs) {
        arrivalsBeforeLandingDetail.push(entry);
        arrivalsBeforeLanding += qty;
      } else if (p.etaTimestamp <= nextPoLandsTs) {
        arrivalsInWindowDetail.push(entry);
        arrivalsInWindow += qty;
      } else {
        arrivalsExcluded.push({ ...entry, reason: 'ETA after next PO landing' });
      }
    }

    // Pre-landing demand: organic burn + event spikes between today and landing.
    const organicBurnToLanding = velocity * organicDaysBeforeLanding;
    const preLandingEventDemand = preLandingEvents.reduce((s, ev) => {
      const effDays = Math.max(0, daysBetweenIso(
        maxIso(ev.start, today),
        minIso(ev.end, opts.thisPoLandsAt),
      ));
      return s + computeEventDemandForSku(ev, sku, velocity, effDays);
    }, 0);

    const availableAtLanding = Math.max(
      0,
      r.totalOnHand
        + arrivalsBeforeLanding
        - organicBurnToLanding
        - preLandingEventDemand,
    );

    // In-window demand: organic + per-event. Per-event lift accounts for
    // calendar multipliers (historical), Manual Multiplier (Events-tab user
    // override), Sitewide Halo (non-linked SKUs), and Expected-Units
    // distribution for brand-new zero-velocity linked SKUs — all via the
    // computeEventDemandForSku helper so pre-landing and in-window stay in
    // sync.
    const organicDemandInWindow = velocity * organicDaysInWindow;
    const perEventDemand: { eventKey: string; eventName: string; demand: number }[] = [];
    let inWindowEventDemand = 0;
    for (const ev of eventsInWindow) {
      const effDays = Math.max(0, daysBetweenIso(
        maxIso(ev.start, opts.thisPoLandsAt),
        minIso(ev.end, opts.nextPoLandsAt),
      ));
      const skuDemand = computeEventDemandForSku(ev, sku, velocity, effDays);
      if (skuDemand > 0) {
        perEventDemand.push({ eventKey: ev.eventKey, eventName: ev.eventName, demand: round2(skuDemand) });
        inWindowEventDemand += skuDemand;
        // Accumulate toward this event's suggested Expected Units (sum across SKUs).
        suggestedEUByEvent.set(
          ev.eventKey,
          (suggestedEUByEvent.get(ev.eventKey) ?? 0) + skuDemand,
        );
      }
    }
    const totalDemandInWindow = organicDemandInWindow + inWindowEventDemand;

    // Recommendation: buffered demand minus everything that'll land before
    // we need it minus what's arriving during the window.
    const rawSuggestedQty = Math.max(
      0,
      totalDemandInWindow * buffer
        - availableAtLanding
        - arrivalsInWindow,
    );

    // Apply the existing 75/25 + 100-floor + Amazon-gate policy.
    const amazonEligible = r.hasFbaSku;
    let amazonDaysCover = 0;
    if (velocity > 0 && r.amazonTotal !== undefined) {
      amazonDaysCover = r.amazonTotal / velocity;
    }
    const amazonGated = amazonEligible && amazonDaysCover < AMAZON_SLOW_MOVER_GATE_DAYS;
    const amazonEligibilityReason = !r.hasFbaSku
      ? 'No FBA SKU'
      : !amazonGated
        ? `Amazon ${Math.round(amazonDaysCover)}d cover ≥ ${AMAZON_SLOW_MOVER_GATE_DAYS}d slow-mover gate`
        : 'Eligible';

    let amzPlan = 0;
    let sbPlan = 0;
    if (rawSuggestedQty > 0) {
      if (amazonGated) {
        amzPlan = ceilTo(rawSuggestedQty * AMAZON_SHARE, PO_LEG_FLOOR);
        sbPlan = Math.max(ceilTo(rawSuggestedQty * (1 - AMAZON_SHARE), PO_LEG_FLOOR), PO_LEG_FLOOR);
      } else {
        amzPlan = 0;
        sbPlan = ceilTo(rawSuggestedQty, PO_LEG_FLOOR);
      }
    }
    const totalPlan = amzPlan + sbPlan;

    return {
      sku,
      category,
      style: r.style,
      color: r.color,
      size: (r as ApparelDashboardRow).size ?? '',
      sizeOrder: (r as ApparelDashboardRow).sizeOrder ?? 0,
      line: styleLineMap.get(r.style) || r.style,
      active: r.active,
      hasFbaSku: r.hasFbaSku,
      currentDailyVelocity: round2(velocity),
      totalOnHandNow: r.totalOnHand,
      amazonOnHandNow: r.amazonTotal,
      arrivalsBeforeLanding: round2(arrivalsBeforeLanding),
      arrivalsBeforeLandingDetail,
      arrivalsInWindow: round2(arrivalsInWindow),
      arrivalsInWindowDetail,
      arrivalsExcluded,
      daysToLanding,
      organicBurnToLanding: round2(organicBurnToLanding),
      preLandingEventDemand: round2(preLandingEventDemand),
      availableAtLanding: round2(availableAtLanding),
      organicDaysInWindow,
      organicDemandInWindow: round2(organicDemandInWindow),
      perEventDemand,
      totalDemandInWindow: round2(totalDemandInWindow),
      rawSuggestedQty: round2(rawSuggestedQty),
      amzPlan,
      sbPlan,
      totalPlan,
      amazonEligible,
      amazonEligibilityReason,
      estimatedCost: round2(totalPlan * r.unitCost),
      unitCost: r.unitCost,
    };
  }
}

/* ===== Helpers ===== */

/**
 * Resolve a single (event, sku) pair into a units-of-demand number for the
 * effective day count. Honors, in priority order:
 *
 *   1. Linked + zero-velocity → use ev.zeroVelocityShare prorated over effDays
 *      vs. ev.durationDays. This is the "brand-new launch SKU" path: we don't
 *      have a velocity baseline so the planner consumes the Expected Units
 *      share Melissa entered on the Events tab.
 *   2. Linked + has velocity → velocity × bestMultiplier × effDays, where
 *      bestMultiplier = calendar (if hasMultiplier) else Manual Multiplier
 *      else 1. This is the "lift on an existing SKU during the announcement"
 *      path.
 *   3. NOT linked + sitewideHalo > 1 → velocity × sitewideHalo × effDays.
 *      The across-the-board halo every announcement drives.
 *   4. NOT linked + no halo OR event with empty linkedSkus → treat as
 *      "applies to all SKUs" with the event's primary multiplier (preserves
 *      the original calendar-event behavior for events without explicit Linked
 *      Parents).
 *
 * Returns 0 (not negative, not NaN) when no path applies so callers can sum
 * safely.
 */
function computeEventDemandForSku(
  ev: PlannedEvent,
  sku: string,
  velocity: number,
  effDays: number,
): number {
  if (effDays <= 0) return 0;
  const hasLinkedScope = ev.linkedSkus.length > 0;
  const skuIsLinked = hasLinkedScope && ev.linkedSkus.includes(sku);

  if (hasLinkedScope && !skuIsLinked) {
    // Non-linked SKU during a scoped event — only the halo applies, if set.
    if (ev.sitewideHalo > 1 && velocity > 0) {
      return velocity * ev.sitewideHalo * effDays;
    }
    return 0;
  }

  // Linked-scope OR all-SKUs event. Decide the multiplier.
  const bestMultiplier = ev.hasMultiplier
    ? ev.multiplier
    : ev.manualMultiplier > 0
      ? ev.manualMultiplier
      : 1;

  // Zero-velocity path: brand-new SKU in the linked set with Expected Units
  // distribution available. Prorate the SKU's share over the slice of the
  // event window we're looking at (effDays / durationDays).
  if (
    skuIsLinked &&
    velocity === 0 &&
    ev.zeroVelocityShare > 0 &&
    ev.durationDays > 0
  ) {
    return ev.zeroVelocityShare * (effDays / ev.durationDays);
  }

  if (velocity === 0) return 0;
  return velocity * bestMultiplier * effDays;
}

function chooseMultiplier(eyo: EventYoY | undefined, mode: MultiplierMode): number | null {
  if (!eyo) return null;
  if (mode === 'latest') return eyo.multipliers.latestYear;
  if (mode === 'weighted') return eyo.multipliers.recencyWeighted;
  return eyo.multipliers.allYearsAvg;
}

/**
 * Sum incoming-PO units whose ETA matches the predicate. Compares via the
 * pre-computed etaTimestamp (Date.parse output) so date format on the POs
 * tab doesn't matter — '9/15/26', '2026-09-15', and '15 Sep 2026' all
 * resolve to the same timestamp. Earlier versions used naive string
 * comparison on a sliced `eta` field, which silently mis-categorized rows
 * whose ETAs weren't typed in ISO format and made it look like incoming
 * inventory wasn't being counted.
 */
function sumIncomingByEta(
  incoming: { eta: string; etaTimestamp: number; qty?: number; units?: number }[],
  predicate: (etaTs: number) => boolean,
): number {
  let total = 0;
  for (const p of incoming) {
    if (!Number.isFinite(p.etaTimestamp) || p.etaTimestamp === Number.MAX_SAFE_INTEGER) continue;
    if (!predicate(p.etaTimestamp)) continue;
    // ApparelDashboardRow uses `qty`, AccessoriesDashboardRow uses `units` —
    // we accept either to keep the signature general.
    const q = Number(p.qty ?? p.units ?? 0) || 0;
    total += q;
  }
  return total;
}

function countDistinctDaysInRanges(ranges: [string, string][]): number {
  const days = new Set<string>();
  for (const [start, end] of ranges) {
    if (!start || !end || start >= end) continue;
    let cursor = start;
    while (cursor < end) {
      days.add(cursor);
      cursor = addDaysIso(cursor, 1);
    }
  }
  return days.size;
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

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetweenIso(startIso: string, endIso: string): number {
  if (!startIso || !endIso) return 0;
  const a = new Date(startIso + 'T00:00:00Z').getTime();
  const b = new Date(endIso + 'T00:00:00Z').getTime();
  return Math.max(0, Math.round((b - a) / 86400000));
}

/** Absolute days between two ISO dates, regardless of order. Use this when
 *  you want a magnitude (e.g., dup detection), not a signed difference. */
function absDaysBetweenIso(a: string, b: string): number {
  if (!a || !b) return 0;
  const aT = new Date(a + 'T00:00:00Z').getTime();
  const bT = new Date(b + 'T00:00:00Z').getTime();
  return Math.abs(Math.round((bT - aT) / 86400000));
}

function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

function minIso(a: string, b: string): string {
  return a < b ? a : b;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
