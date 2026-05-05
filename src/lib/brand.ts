/**
 * HIKERS Co. brand tokens — TypeScript mirror of the BRAND constant in
 * 13_brand.gs and tailwind.config.ts. Single source of truth for any code
 * that needs hex values directly (chart libs, server-rendered SVG, etc.).
 *
 * Ratified by Matt 2026-04-20. Don't add colors here without flagging them
 * as "proposed additions" first.
 */
export const BRAND = {
  indigo:        '#4A5490',
  periwinkle:    '#7A84AC',
  ironclad:      '#B63B38',
  clay:          '#C98A55',
  sage:          '#7F8B6C',
  warmWhite:     '#FAF8F3',
  warmBeige:     '#EFE9DD',
  warmGray:      '#D3CEC4',
  charcoal:      '#1F2337',
  // PO-status washes
  washIndigo:    '#E6E8F1',
  washPeriwinkle:'#DDE1EE',
  washSage:      '#EAEDE2',
  washCancelled: '#E5E2DA',
} as const;

export type BrandColor = keyof typeof BRAND;

/** Days-Cover semantic color: <14 ironclad, 14–30 clay, ≥30 sage. */
export function daysCoverColor(days: number): string {
  if (days < 14) return BRAND.ironclad;
  if (days < 30) return BRAND.clay;
  return BRAND.sage;
}
