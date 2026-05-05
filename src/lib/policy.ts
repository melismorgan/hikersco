/**
 * HIKERS PO policy math — pure functions, no I/O. Client-safe (no
 * googleapis imports), so it can be imported from React components AND
 * from server actions.
 *
 * Mirrors the X/Y formula behavior in 02_dashboard.gs:
 *   - Amazon eligible: hasFbaSku AND avgPerDay > 0 AND amazonDaysCover < 45
 *   - Eligible: amzPlan = ceil(qty × 0.75 / 100) × 100
 *               sbPlan  = max(ceil(qty × 0.25 / 100) × 100, 100)
 *   - Ineligible: amzPlan = 0; sbPlan = ceil(qty / 100) × 100
 */

export const PO_LEG_FLOOR = 100;
export const AMAZON_SHARE = 0.75;
export const AMAZON_SLOW_MOVER_GATE_DAYS = 45;

export function ceilTo(n: number, step: number): number {
  if (n <= 0) return 0;
  return Math.ceil(n / step) * step;
}

export interface SplitInput {
  qty: number;
  hasFbaSku: boolean;
  avgPerDay30d: number;
  amazonTotal: number;
}

export interface SplitResult {
  amz: number;
  sb: number;
  total: number;
  amazonEligible: boolean;
  reason: string;
}

export function splitDraft(input: SplitInput): SplitResult {
  if (input.qty <= 0) {
    return { amz: 0, sb: 0, total: 0, amazonEligible: false, reason: 'No draft' };
  }
  const amazonDaysCover = input.avgPerDay30d > 0 ? input.amazonTotal / input.avgPerDay30d : Infinity;
  let eligible = false;
  let reason = '';
  if (!input.hasFbaSku) reason = 'No FBA SKU — ShipBob only';
  else if (input.avgPerDay30d <= 0) reason = 'No velocity data';
  else if (amazonDaysCover >= AMAZON_SLOW_MOVER_GATE_DAYS) {
    reason = `Amazon already has ${amazonDaysCover.toFixed(0)} days cover (≥${AMAZON_SLOW_MOVER_GATE_DAYS})`;
  } else {
    eligible = true;
    reason = 'Eligible';
  }

  if (eligible) {
    const amz = ceilTo(input.qty * AMAZON_SHARE, PO_LEG_FLOOR);
    const sb  = Math.max(ceilTo(input.qty * (1 - AMAZON_SHARE), PO_LEG_FLOOR), PO_LEG_FLOOR);
    return { amz, sb, total: amz + sb, amazonEligible: true, reason };
  }
  const sb = ceilTo(input.qty, PO_LEG_FLOOR);
  return { amz: 0, sb, total: sb, amazonEligible: false, reason };
}
