/**
 * Pure, client-safe pieces of the seasonal-analysis module.
 *
 * Anything imported into a `'use client'` React component must live here,
 * NOT in seasonal-analysis.ts — that file pulls in googleapis (via lib/sheets
 * → lib/events), which uses Node's `net` module and explodes when webpack
 * tries to bundle it for the browser.
 *
 * Contents:
 *   • SEASONAL_EVENTS array (anchor functions + windows)
 *   • SeasonalEvent / SkuPriorYearRow / ForecastRow types
 *   • computeForecast pure function
 *   • Pure date math helpers (eventWindowFor, nthDowOfMonth, etc.)
 *
 * seasonal-analysis.ts re-exports the runtime values so server-side callers
 * have a single import target.
 */

export interface SeasonalEvent {
  key: string;
  name: string;
  /** Returns ISO YYYY-MM-DD anchor for a given year. */
  anchor: (year: number) => string;
  /** Window length in days (calendar fallback only). */
  window: number;
  /** Days before (negative) / after the anchor the window starts (calendar fallback only). */
  offsetStart: number;
  /**
   * Lowercase substrings to match against a campaign's name OR subject when
   * inferring which campaigns belong to this event. Any match counts.
   * Empty array = no keyword-based matching, always use calendar window.
   *
   * Tuned against actual HIKERS Klaviyo + Postscript send history 2024-2026.
   * If you see a campaign getting incorrectly grouped (or missed), add or
   * tighten a keyword here.
   */
  campaignKeywords: string[];
}

export interface SkuPriorYearRow {
  sku: string;
  style: string;
  color: string;
  size: string;
  units: number;
  revenue: number;
}

export interface ForecastRow extends SkuPriorYearRow {
  recommendedQty: number;
}

/* ===== Event definitions — grounded in actual HIKERS Klaviyo sends
   2024-2026 (sender support@hikersco.com). See
   feedback_check_real_campaign_history.md in the memory store. ===== */

/* Keyword design notes:
 * - HIKERS' Klaviyo campaign Names follow internal patterns like
 *   "Memorial SALE 26 Campaign (5/18)" rather than the full customer-facing
 *   subject lines ("Don't Miss Our Memorial Day SALE!"). Klaviyo's
 *   /api/campaigns/ doesn't return subject_line by default, so we can't
 *   rely on subject — we match against the internal Name field.
 * - Postscript's Name field DOES carry the campaign theme ("Memorial Day
 *   2026", "Labor Day Extension 2025") so those match either pattern.
 * - The ±60d search window around the calendar anchor (enforced in
 *   resolveEventWindowForYear) keeps loose keywords like 'memorial' from
 *   false-positing on out-of-season sends.
 * - Keep the bar low: it's better to occasionally catch a related
 *   announcement and have the user mentally filter than to miss the
 *   actual event sends entirely.
 */
export const SEASONAL_EVENTS: SeasonalEvent[] = [
  {
    key: 'memorial-day',
    name: "Memorial Day SALE ('Biggest of the Year')",
    anchor: (y) => isoDate(nthDowOfMonth(y, 4, 1, -1)),
    window: 14,
    offsetStart: -10,
    // 'memorial' alone catches both "Memorial Day SALE!" (customer subject)
    // and "Memorial SALE 26 Campaign" (Klaviyo internal name). Safe inside
    // the ±60d window since nothing else HIKERS sends in May has "memorial".
    campaignKeywords: ['memorial', 'biggest sale'],
  },
  {
    key: 'bfcm',
    name: 'Black Friday / Cyber Monday',
    anchor: (y) => isoDate(addDays(thanksgivingFor(y), 1)),
    window: 18,
    offsetStart: -12,
    // 'bf ' catches HIKERS' "BF 25" internal naming style; the trailing
    // space prevents matching unrelated words. 'thanksgiving' catches the
    // "Happy Thanksgiving" Klaviyo subject that precedes BFCM.
    campaignKeywords: ['black friday', 'cyber monday', 'bfcm', 'thanksgiving', 'bf '],
  },
  {
    key: 'fourth-of-july',
    name: '4th of July SALE',
    anchor: (y) => `${y}-07-04`,
    window: 10,
    offsetStart: -5,
    // 'july' alone is dangerous (matches dates / months in other campaign
    // names). Stick to combinations + 'the 4th'.
    campaignKeywords: ['4th of july', 'fourth of july', 'independence day', 'july 4', 'the 4th', '4th sale'],
  },
  {
    key: 'labor-day',
    name: 'Labor Day SALE',
    anchor: (y) => isoDate(nthDowOfMonth(y, 8, 1, 1)),
    window: 10,
    offsetStart: -8,
    campaignKeywords: ['labor day', 'labor sale'],
  },
  {
    key: 'anniversary',
    name: 'Anniversary SALE',
    anchor: (y) => `${y}-03-31`,
    window: 8,
    offsetStart: -2,
    // 'anniversary' covers most variants. 'turning' catches "We're Turning 5"
    // brand-anniversary subject lines. 'birthday' is a defensive add in case
    // future campaigns frame it that way.
    campaignKeywords: ['anniversary', 'turning', 'years of hikers', 'birthday'],
  },
  {
    key: 'hauliday',
    name: "October 'Hauliday' SALE",
    anchor: (y) => `${y}-10-12`,
    window: 14,
    offsetStart: 0,
    campaignKeywords: ['hauliday'],
  },
  {
    key: 'january-clearance',
    name: 'January Clearance SALE',
    anchor: (y) => `${y}-01-26`,
    window: 8,
    offsetStart: 0,
    campaignKeywords: ['clearance', 'clearnace'],
  },
  {
    key: 'presidents-day',
    name: "President's Day Weekend SALE",
    anchor: (y) => isoDate(nthDowOfMonth(y, 1, 1, 3)),
    window: 5,
    offsetStart: -3,
    // 'president' alone is safer than I worried — nothing else HIKERS-related
    // mentions presidents, and ±60d window keeps it inside Feb anyway.
    campaignKeywords: ["president's day", 'presidents day', 'presidentʼs day', 'president'],
  },
  {
    key: 'summer-restock',
    name: 'Mid-June Summer Restock SALE',
    anchor: (y) => `${y}-06-15`,
    window: 7,
    offsetStart: 0,
    campaignKeywords: ['back in stock', 'summer restock', 'summer sale'],
  },
  {
    key: 'after-holiday',
    name: 'After-Holiday / New Year SALE',
    anchor: (y) => `${y}-12-26`,
    window: 9,
    offsetStart: 0,
    campaignKeywords: ['after holiday', 'after christmas', 'new year'],
  },
  {
    key: 'free-shipping-deadline',
    name: 'Free Shipping Deadline (CTA, not sale)',
    anchor: (y) => `${y}-12-10`,
    window: 5,
    offsetStart: -1,
    campaignKeywords: ['free shipping deadline', 'shipping deadline'],
  },
];

/* ===== Campaign-theme inference =====
   Given a campaign's name + subject + platform, returns the SeasonalEvent
   it belongs to (or null for product-launches / operational sends). Used by
   the loader to switch from calendar-anchored to campaign-anchored event
   windows; will also feed the future Promotions view. */

/** Lowercase a string defensively. */
function _lc(s: string | undefined | null): string {
  return String(s || '').toLowerCase();
}

/**
 * Find which SeasonalEvent (if any) a campaign matches based on its name +
 * subject. Returns the event with the most keyword hits, or null if none
 * match. Ties broken by SEASONAL_EVENTS order.
 */
export function matchCampaignToEvent(name: string, subject: string): SeasonalEvent | null {
  const hay = _lc(name) + ' ' + _lc(subject);
  let best: SeasonalEvent | null = null;
  let bestHits = 0;
  for (const evt of SEASONAL_EVENTS) {
    let hits = 0;
    for (const kw of evt.campaignKeywords) {
      if (kw && hay.indexOf(kw.toLowerCase()) !== -1) hits++;
    }
    if (hits > bestHits) {
      best = evt;
      bestHits = hits;
    }
  }
  return best;
}

/* ===== Pure forecast math ===== */

export function computeForecast(
  priorYear: SkuPriorYearRow[],
  yoyGrowth: number,
  buffer: number,
  roundTo = 25,
): ForecastRow[] {
  return priorYear.map((r) => ({
    ...r,
    recommendedQty: Math.ceil((r.units * yoyGrowth * buffer) / roundTo) * roundTo,
  }));
}

/* ===== Pure date math (no Node-only deps) ===== */

export function eventWindowFor(evt: SeasonalEvent, year: number) {
  const anchorIso = evt.anchor(year);
  const startD = addDays(new Date(anchorIso + 'T00:00:00Z'), evt.offsetStart);
  const endD = addDays(startD, evt.window);
  return { start: isoDate(startD), end: isoDate(endD), len: evt.window, anchor: anchorIso };
}

export function nthDowOfMonth(year: number, monthIdx: number, dow: number, n: number): Date {
  if (n > 0) {
    const d = new Date(Date.UTC(year, monthIdx, 1));
    const offset = ((dow - d.getUTCDay()) + 7) % 7;
    return new Date(Date.UTC(year, monthIdx, 1 + offset + 7 * (n - 1)));
  }
  const lastDay = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(year, monthIdx, lastDay));
  const offset = ((d.getUTCDay() - dow) + 7) % 7;
  return new Date(Date.UTC(year, monthIdx, lastDay - offset - 7 * (-n - 1)));
}

export function thanksgivingFor(year: number): Date {
  return nthDowOfMonth(year, 10, 4, 4);
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
