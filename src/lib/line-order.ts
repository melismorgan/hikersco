/**
 * Canonical line order for HIKERS Co. dashboards — apparel families in
 * product hierarchy first, then accessories. Banner sort and any "show
 * lines in this order" UI keys off this list.
 *
 * Matching is case-insensitive and treats hyphens, underscores, and spaces
 * as equivalent ("Heavy-Duty" === "Heavy Duty" === "heavy_duty"). Anything
 * not listed sorts alphabetically *after* the canonical lines.
 *
 * IMPORTANT: this file deliberately has zero non-trivial dependencies so
 * client components can import it without dragging in `googleapis`/Node-only
 * modules. Don't add a Sheets API import here.
 */
export const LINE_ORDER = [
  'HIKERS',
  'Upfitter',
  'Deluxe',
  'Heavy-Duty',
  'Youth',
  'Hook Packs',
  'Rear Hooks',
  'Wallets',
] as const;

function normalizeLine(s: string): string {
  return s.replace(/[-_]/g, ' ').toLowerCase().trim();
}

export function lineOrderIndex(line: string): number {
  const norm = normalizeLine(line);
  const idx = LINE_ORDER.findIndex((l) => normalizeLine(l) === norm);
  return idx === -1 ? 999 : idx;
}
