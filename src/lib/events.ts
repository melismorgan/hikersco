/**
 * Events tab — campaigns, launches, restocks, promos, and announcement emails.
 *
 * V1 schema lives entirely on a Sheet tab named "Events". Melissa edits rows
 * directly. Two existing dashboards consume it:
 *
 *   1. Reorder math (lib/reorder.ts) — when an Event has Exclude From Velocity
 *      Avg = Y, the rolling 30d Avg/Day for the linked SKUs is replaced by the
 *      90d Avg/Day for the duration the Event window overlaps "now or recent
 *      past." This prevents launch bursts from polluting the demand signal and
 *      causing over-orders.
 *
 *   2. Reorder demand-spike awareness — when a Planned/Active Event has
 *      Expected Units and a Linked Parent covering a SKU, the Expected Units
 *      get added to the SKU's projected demand for the window. Lets the
 *      reorder math pre-stock for known upcoming campaigns rather than
 *      reacting after the fact.
 *
 * The Events tab is created lazily on first read. If it doesn't exist when
 * we reach for it, ensureEventsTab() creates the tab, writes the header row,
 * and seeds it with the upcoming Heavy Duty campaign so Melissa has a
 * working example to edit on day one.
 *
 * Schema (cols A..W, 23 cols):
 *
 *   A Event ID                 (auto, EVT-NNNNN)
 *   B Type                     (Launch | Restock | Promo | Email Blast | External)
 *   C Name                     (free text)
 *   D Start Date               (YYYY-MM-DD or any parseable date)
 *   E Window Length (days)     (e.g. 14, 30)
 *   F End Date                 (auto-derivable: Start + Window. If both set,
 *                               End wins so multi-segment events can override.)
 *   G Status                   (Planned | Active | Ended — auto-flips by date
 *                               if blank or if it disagrees with today)
 *   H Channels                 (multi-select via comma list:
 *                               Email, Ads, Organic, Banner, Influencer)
 *   I Linked Parents           (comma list of Style+Color or wildcards:
 *                               "H503-4-NGBK, H503-4-GYBK" or "H503-4-*")
 *   J New SKUs (subset)        (comma list — those of the Linked Parents that
 *                               are brand-new with no baseline. Drives Lift %
 *                               vs First-Window Units split.)
 *   K Discount %               (0..1 fraction; 0 if no promo)
 *   L Expected Units           (forward-looking forecast, drives Reorder
 *                               demand-spike. Total across linked SKUs over
 *                               the window — we divide by the SKU count when
 *                               applying.)
 *   M Notes                    (free text)
 *   N Exclude From Velocity Avg (Y/N — Y means the window's units are
 *                                anomalous and shouldn't drive the rolling
 *                                avg.)
 *   O Email Recipients
 *   P Email Open %
 *   Q Email Click %
 *   R Units Sold (Window)      (filled after — sum of units sold for Linked
 *                               Parents during the window)
 *   S Baseline Avg/Day         (filled after — avg/day for the non-new
 *                               linked SKUs across the prior 30d)
 *   T Lift %                   (filled after — established SKUs only)
 *   U New SKU First-Window Units (launch-only number — sum of units across
 *                                 the New SKUs during the window)
 *   V Gross Revenue
 *   W Result Notes             (post-mortem text)
 */

import { appendRows, batchUpdateCells, ensureTabExists, readTab } from './sheets';

// ---- Types ----------------------------------------------------------------

export type EventType =
  | 'Launch'
  | 'Restock'
  | 'Promo'
  | 'Email Blast'
  | 'External'
  | '';

export type EventStatus = 'Planned' | 'Active' | 'Ended' | '';

/** A row on the Events tab, parsed and ready to use. Linked Parents and
 *  New SKUs are kept as the raw user strings here; expansion to actual SKUs
 *  happens in {@link expandLinkedParents}, which needs the live SKU list. */
export interface EventRow {
  /** 1-based sheet row number; header is row 1, first data row is 2.
   *  Used as the address for in-place edits (none in v1, but consistent
   *  with PoRow/PoPaymentRow patterns). */
  rowIndex: number;
  eventId: string;
  type: EventType;
  name: string;
  startDate: string;
  /** 0 if blank/invalid. */
  windowLengthDays: number;
  /** Empty string if blank — caller can derive from startDate + windowLength. */
  endDate: string;
  /** Auto-resolved status: if cell is blank or disagrees with today's date,
   *  we substitute the date-derived value. Stored cell is preserved on the
   *  sheet so edits aren't fought. */
  status: EventStatus;
  /** Cell content as written, even if it disagrees with derived status. */
  statusRaw: string;
  channels: string[];
  /** Raw text — comma list of patterns. Use expandLinkedParents to resolve. */
  linkedParents: string;
  /** Raw text — comma list. Subset of linkedParents that are brand-new. */
  newSkus: string;
  discountPct: number;
  expectedUnits: number;
  /** Multiplier applied to linked SKUs during the event window when no
   *  calendar-event multiplier is available (e.g., launches, novel events).
   *  0 / blank = "no manual override; planner falls back to organic baseline."
   *  Typical values: 2.0–4.0 for an announcement, 3.0–6.0 for a promo. */
  manualMultiplier: number;
  /** Smaller across-the-board lift applied to NON-linked SKUs during the
   *  event window — captures the halo/site-traffic bump every campaign drives.
   *  0 / blank = no halo applied. Typical: 1.1–1.3. */
  sitewideHaloMultiplier: number;
  notes: string;
  excludeFromVelocityAvg: boolean;
  // Result fields (filled in post-event, optional):
  emailRecipients: number;
  emailOpenPct: number;
  emailClickPct: number;
  unitsSoldWindow: number;
  baselineAvgPerDay: number;
  liftPct: number;
  newSkuFirstWindowUnits: number;
  grossRevenue: number;
  resultNotes: string;
}

// ---- Constants ------------------------------------------------------------

export const EVENTS_TAB = 'Events';

const HEADER_ROW: string[] = [
  'Event ID',
  'Type',
  'Name',
  'Start Date',
  'Window Length (days)',
  'End Date',
  'Status',
  'Channels',
  'Linked Parents',
  'New SKUs (subset)',
  'Discount %',
  'Expected Units',
  'Notes',
  'Exclude From Velocity Avg',
  'Email Recipients',
  'Email Open %',
  'Email Click %',
  'Units Sold (Window)',
  'Baseline Avg/Day',
  'Lift %',
  'New SKU First-Window Units',
  'Gross Revenue',
  'Result Notes',
  // Appended for backward compat — new cols sit at the end so existing data
  // rows don't have to shift. ensureEventsTab() writes the missing header
  // cells on first read if the sheet already exists.
  'Manual Multiplier',
  'Sitewide Halo Multiplier',
];

/** Heavy Duty restock + new colors campaign — seeded so the schema has a
 *  working example to edit on day one. Per project_po_policies, the H503-4
 *  colorways NGBK/GYBK/WHLG launched on RX-24037 (S–5X), and Melissa's
 *  expected announcement is ~early June 2026. Start date is a placeholder
 *  she should adjust once the email is scheduled. */
const SEED_HEAVY_DUTY_ROW: (string | number)[] = [
  'EVT-00001',
  'Email Blast',
  'H503-4 Heavy Duty — June Email + New Colors + Restock',
  '2026-06-05',                                // Start Date (placeholder)
  14,                                          // Window Length
  '',                                          // End Date — auto-derived
  'Planned',                                   // Status
  'Email, Banner',                             // Channels
  'H503-4-*',                                  // Linked Parents (wildcard: all H503-4 colors)
  'H503-4-NGBK, H503-4-GYBK, H503-4-WHLG',    // New SKUs
  0,                                           // Discount %
  '',                                          // Expected Units — Melissa fills
  'Auto-seeded. Update Start Date once email is scheduled. Expected Units feeds Reorder spike math.',
  'Y',                                         // Exclude From Velocity Avg
  '', '', '', '', '', '', '', '', '',          // Result columns blank until window closes
  '',                                          // Manual Multiplier — leave blank, Melissa fills
  1.2,                                         // Sitewide Halo Multiplier — typical announcement halo
];

// ---- Tab init -------------------------------------------------------------

let _initPromise: Promise<void> | null = null;

/**
 * Ensure the Events tab exists, has headers, and (if newly-created) is
 * seeded with the Heavy Duty campaign row. Idempotent — safe to call from
 * every reader. Cached for the lifetime of the process so we don't re-check
 * on every request.
 */
export async function ensureEventsTab(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const { created } = await ensureTabExists(EVENTS_TAB);
    if (created) {
      // New tab — write header row + seed.
      await appendRows(EVENTS_TAB, [HEADER_ROW]);
      await appendRows(EVENTS_TAB, [SEED_HEAVY_DUTY_ROW]);
      return;
    }
    // Existing tab — make sure the header row is present. If row 1 is empty
    // (someone deleted it) we add headers but DON'T re-seed (their data is
    // there, just the header is missing).
    let grid: string[][];
    try {
      grid = await readTab(EVENTS_TAB);
    } catch {
      return;
    }
    const firstRow = grid[0] ?? [];
    const looksLikeHeader = firstRow.length > 0 && String(firstRow[0] ?? '').trim() === 'Event ID';
    if (!looksLikeHeader && grid.length === 0) {
      await appendRows(EVENTS_TAB, [HEADER_ROW]);
      return;
    }
    // Backfill missing header cells when HEADER_ROW grows past the existing
    // header. Keeps Melissa's data rows where they are while still showing
    // the new column labels at the right edge. Idempotent — re-running this
    // after a partial backfill just writes whatever's still missing.
    if (looksLikeHeader && firstRow.length < HEADER_ROW.length) {
      const updates: Array<{ range: string; value: string | number }> = [];
      for (let col = firstRow.length; col < HEADER_ROW.length; col++) {
        updates.push({
          range: `${EVENTS_TAB}!${colLetter(col)}1`,
          value: HEADER_ROW[col],
        });
      }
      if (updates.length > 0) {
        await batchUpdateCells(updates);
      }
    }
  })();
  return _initPromise;
}

/** A=0, B=1, ..., Z=25, AA=26, AB=27, ... Handles two-letter columns even
 *  though we don't currently need them, so future appends are safe. */
function colLetter(zeroBasedIndex: number): string {
  let n = zeroBasedIndex;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// ---- Reader ---------------------------------------------------------------

/** Pure helpers — no I/O, no shared mutable state. */
function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).replace(/,/g, '').replace(/%/g, '').trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function parseYn(v: unknown): boolean {
  const s = str(v).toUpperCase();
  return s === 'Y' || s === 'YES' || s === 'TRUE' || s === '1';
}

function parseList(v: unknown): string[] {
  return str(v)
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Days between two dates (b - a), positive if b is after a. NaN-safe. */
export function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  if (!Number.isFinite(ms)) return NaN;
  return ms / (1000 * 60 * 60 * 24);
}

/** Parse a Sheets-formatted date string. Accepts ISO and US (m/d/yyyy).
 *  Returns null on parse failure. */
export function parseSheetDate(s: string): Date | null {
  const t = s.trim();
  if (!t) return null;
  const d = new Date(t);
  if (!Number.isNaN(d.getTime())) return d;
  // Sheets sometimes hands us "5/20/2026" — Date constructor handles this on
  // most JS runtimes, but be explicit just in case.
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (m) {
    const [, mo, da, yr] = m;
    const yyyy = yr.length === 2 ? 2000 + Number(yr) : Number(yr);
    const built = new Date(yyyy, Number(mo) - 1, Number(da));
    if (!Number.isNaN(built.getTime())) return built;
  }
  return null;
}

/** Auto-derive Status from start/end vs today. Used when the cell is blank
 *  or to override a stale "Planned" that's actually started already. */
export function deriveStatus(
  startDate: string,
  endDate: string,
  windowLengthDays: number,
  asOf: Date = new Date(),
): EventStatus {
  const start = parseSheetDate(startDate);
  if (!start) return '';
  let end = parseSheetDate(endDate);
  if (!end && windowLengthDays > 0) {
    end = new Date(start);
    end.setDate(end.getDate() + windowLengthDays);
  }
  if (!end) {
    // No window — once we pass start we treat as Active until manually ended.
    return asOf < start ? 'Planned' : 'Active';
  }
  if (asOf < start) return 'Planned';
  if (asOf <= end)  return 'Active';
  return 'Ended';
}

/** Read all rows from the Events tab. Triggers tab creation + seeding on
 *  first call if the tab is missing. */
export async function readEvents(): Promise<EventRow[]> {
  await ensureEventsTab();
  let grid: string[][];
  try {
    grid = await readTab(EVENTS_TAB);
  } catch {
    return [];
  }
  if (grid.length < 2) return [];
  const out: EventRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const eventId = str(r[0]);
    if (!eventId) continue;

    const startDate        = str(r[3]);
    const windowLengthDays = num(r[4]);
    const endDate          = str(r[5]);
    const statusRaw        = str(r[6]);

    // Derive end date if the cell is blank.
    let resolvedEnd = endDate;
    if (!resolvedEnd && startDate && windowLengthDays > 0) {
      const s = parseSheetDate(startDate);
      if (s) {
        const e = new Date(s);
        e.setDate(e.getDate() + windowLengthDays);
        // Output as YYYY-MM-DD for predictability.
        resolvedEnd = e.toISOString().slice(0, 10);
      }
    }

    // Derive status if the cell disagrees with today.
    const derivedStatus = deriveStatus(startDate, resolvedEnd, windowLengthDays);
    const statusToUse: EventStatus =
      statusRaw === 'Planned' || statusRaw === 'Active' || statusRaw === 'Ended'
        ? // Trust the cell if it agrees with derived OR is blank-derived.
          // If derived disagrees (e.g. cell says Planned but we're past start),
          // the derived value wins so reorder math is correct.
          (derivedStatus && derivedStatus !== statusRaw ? derivedStatus : (statusRaw as EventStatus))
        : derivedStatus;

    const typeRaw = str(r[1]);
    const type: EventType =
      typeRaw === 'Launch' || typeRaw === 'Restock' || typeRaw === 'Promo' ||
      typeRaw === 'Email Blast' || typeRaw === 'External'
        ? typeRaw : '';

    out.push({
      rowIndex: i + 1,
      eventId,
      type,
      name:                   str(r[2]),
      startDate,
      windowLengthDays,
      endDate: resolvedEnd,
      status: statusToUse,
      statusRaw,
      channels:               parseList(r[7]),
      linkedParents:          str(r[8]),
      newSkus:                str(r[9]),
      // Discount stored as either 0..1 or 0..100. Coerce both.
      discountPct: (() => {
        const n = num(r[10]);
        return n > 1 ? n / 100 : n;
      })(),
      expectedUnits:          num(r[11]),
      notes:                  str(r[12]),
      excludeFromVelocityAvg: parseYn(r[13]),
      emailRecipients:        num(r[14]),
      emailOpenPct:           (() => { const n = num(r[15]); return n > 1 ? n / 100 : n; })(),
      emailClickPct:          (() => { const n = num(r[16]); return n > 1 ? n / 100 : n; })(),
      unitsSoldWindow:        num(r[17]),
      baselineAvgPerDay:      num(r[18]),
      liftPct:                (() => { const n = num(r[19]); return n > 1 ? n / 100 : n; })(),
      newSkuFirstWindowUnits: num(r[20]),
      grossRevenue:           num(r[21]),
      resultNotes:            str(r[22]),
      // Appended cols — safe on legacy rows because num(undefined) === 0,
      // which the planner reads as "no override; use organic baseline."
      manualMultiplier:       num(r[23]),
      sitewideHaloMultiplier: num(r[24]),
    });
  }
  return out;
}

// ---- SKU expansion --------------------------------------------------------

/**
 * Expand a comma list of patterns (which may contain wildcards like
 * "H503-4-*") against a known list of full SKUs. The patterns target the
 * "Parent" level — Style+Color — but the expansion returns concrete SKUs
 * (all sizes for a parent).
 *
 * Wildcards: only `*` is supported. Translates to `.*` in regex. Other
 * regex metachars in the pattern are escaped first so colors with hyphens
 * like "GYBK" or "WHDG" work correctly.
 *
 * Examples (against the SKU master with H503-4 sizes XS..5X):
 *   "H503-4-NGBK"              → 8 SKUs (H503-4-NGBK-XS..5X)
 *   "H503-4-NGBK, H503-4-GYBK" → 16 SKUs
 *   "H503-4-*"                 → all H503-4 SKUs across all colors+sizes
 */
export function expandLinkedParents(
  patternList: string,
  allSkus: string[],
): Set<string> {
  const out = new Set<string>();
  const patterns = parseList(patternList);
  if (patterns.length === 0) return out;

  for (const raw of patterns) {
    if (raw.includes('*')) {
      // Wildcard pattern: escape regex metachars (except *), then turn * → .*
      // Anchor to whole-SKU match so "H503-4-*" doesn't accidentally hit
      // some hypothetical "EXTRAH503-4-…" SKU.
      const escaped = raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const re = new RegExp('^' + escaped, 'i'); // prefix match: parent → all sizes
      for (const sku of allSkus) if (re.test(sku)) out.add(sku);
    } else {
      // Literal pattern — treat as a parent prefix (Style+Color), match all
      // sizes by prefix. A pattern that already includes a size will match
      // exactly one SKU.
      const prefix = raw.toUpperCase();
      for (const sku of allSkus) {
        const u = sku.toUpperCase();
        if (u === prefix || u.startsWith(prefix + '-')) out.add(sku);
      }
    }
  }
  return out;
}

// ---- Reorder integration helpers -----------------------------------------

/**
 * For a given SKU, return the most-recent or current Event whose window the
 * SKU is currently in AND that has Exclude From Velocity Avg = Y. Returns
 * null if no such event applies. Used by the Reorder math to substitute
 * 90d Avg/Day for 30d when the rolling-30d average is being polluted by an
 * ongoing or recently-ended launch burst.
 *
 * The "recent past" window also excludes — by default we extend the
 * exclusion 14d past End Date so a launch that ended last week still gets
 * the 90d substitution while the 30d avg is still polluted.
 */
export function findActiveExclusionEvent(
  sku: string,
  events: EventRow[],
  expandedBySku: Map<string, EventRow[]>,
  asOf: Date = new Date(),
  postEventBufferDays: number = 14,
): EventRow | null {
  void events; // events param kept for future cross-event-resolution
  const candidates = expandedBySku.get(sku) ?? [];
  for (const ev of candidates) {
    if (!ev.excludeFromVelocityAvg) continue;
    const start = parseSheetDate(ev.startDate);
    if (!start) continue;
    let end = parseSheetDate(ev.endDate);
    if (!end && ev.windowLengthDays > 0) {
      end = new Date(start);
      end.setDate(end.getDate() + ev.windowLengthDays);
    }
    if (!end) continue;
    const bufferEnd = new Date(end);
    bufferEnd.setDate(bufferEnd.getDate() + postEventBufferDays);
    // Active if today is within [start - 0, end + buffer].
    if (asOf >= start && asOf <= bufferEnd) return ev;
  }
  return null;
}

/**
 * Compute the additional units to add to a SKU's projected demand for the
 * upcoming reorder window, sourced from Planned/Active Events with Expected
 * Units set.
 *
 * Apportionment: an Event's Expected Units cover the WHOLE event (sum
 * across all linked SKUs over the window). To convert to per-SKU spike,
 * we divide by the number of linked SKUs the event covers. This gives the
 * marginal demand that should be added to one SKU's projected baseline.
 *
 * The lookahead clamps the spike to events whose window starts within
 * `lookaheadDays` from today — events further out shouldn't influence
 * today's PO decisions (they'll be picked up when we re-run reorder
 * closer to the event).
 */
export function spikeUnitsForSku(
  sku: string,
  events: EventRow[],
  expandedBySku: Map<string, EventRow[]>,
  asOf: Date = new Date(),
  lookaheadDays: number = 90,
): { spike: number; events: EventRow[] } {
  void events;
  const matched = expandedBySku.get(sku) ?? [];
  let spike = 0;
  const contributing: EventRow[] = [];
  for (const ev of matched) {
    if (ev.expectedUnits <= 0) continue;
    if (ev.status !== 'Planned' && ev.status !== 'Active') continue;
    const start = parseSheetDate(ev.startDate);
    if (!start) continue;
    const days = daysBetween(asOf, start);
    if (days > lookaheadDays) continue;
    // Per-SKU share = expected total / # linked SKUs.
    const linkedCount = countLinkedSkus(ev, expandedBySku);
    if (linkedCount <= 0) continue;
    spike += ev.expectedUnits / linkedCount;
    contributing.push(ev);
  }
  return { spike, events: contributing };
}

/** Count how many distinct SKUs an event's Linked Parents cover. */
function countLinkedSkus(
  ev: EventRow,
  expandedBySku: Map<string, EventRow[]>,
): number {
  let n = 0;
  for (const evList of expandedBySku.values()) {
    if (evList.includes(ev)) n++;
  }
  return n;
}

/**
 * Build a Map<SKU, EventRow[]> by expanding every event's Linked Parents
 * against the master SKU list. Caller-provided allSkus must be the list of
 * active SKUs the dashboard is operating on (so Reorder doesn't apply
 * spikes to inactive SKUs).
 */
export function buildEventsBySku(
  events: EventRow[],
  allSkus: string[],
): Map<string, EventRow[]> {
  const out = new Map<string, EventRow[]>();
  for (const ev of events) {
    const skus = expandLinkedParents(ev.linkedParents, allSkus);
    for (const sku of skus) {
      if (!out.has(sku)) out.set(sku, []);
      out.get(sku)!.push(ev);
    }
  }
  return out;
}
