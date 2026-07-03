'use server';

import { revalidatePath } from 'next/cache';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { appendRows, batchUpdateCells, deleteRows, ensureTabExists } from '@/lib/sheets';
import { splitDraft } from '@/lib/policy';
import {
  readPos,
  readPoPayments,
  readPoPaymentTransactions,
  readShipments,
  readShipmentLines,
  readSkuMaster,
  readShipbobFeed,
  readSuppliers,
  DEFAULT_DEPOSIT_PCT,
  type ShipmentStatus,
} from '@/lib/inventory';

/**
 * Map of editable PO fields → POs-tab column letters. Anchored to the
 * schema in 01_bootstrap.gs; non-editable cols (Source/Dest On Hand,
 * All-Day Total — sheet-side formulas) are intentionally absent.
 */
const PO_COL: Record<string, string> = {
  poNumber:     'A',
  status:       'B',
  supplier:     'C',
  mode:         'D',
  orderDate:    'E',
  eta:          'F',
  sku:          'G',
  qty:          'H',
  unitCost:     'I',
  receivedDate: 'J',
  notes:        'K',
  // Type/Source/Dest left out — those are set at create time and rarely change.
};

/**
 * Append a new PO line to the POs tab. Column order matches the schema in
 * 01_bootstrap.gs:
 *   A PO #     · B Status · C Supplier · D Mode (Air|Sea)
 *   E Order Date · F ETA · G SKU · H Qty · I Unit Cost
 *   J Received Date · K Notes · L Type
 *   M Source · N Dest · O Source On Hand · P Dest On Hand · Q All-Day Total
 *
 * Source/Dest/On-Hand columns are left blank for supplier POs (only matter
 * for internal transfers, which we don't write through this form).
 */
export async function createPo(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  // Re-check auth on the server side. NextAuth middleware already gates the
  // page, but Server Actions are publicly callable so we always verify.
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return { ok: false, error: 'Not authenticated.' };
  }

  // Light validation
  const poNumber = String(formData.get('poNumber') ?? '').trim();
  const status   = String(formData.get('status') ?? '').trim() || 'Draft';
  const supplier = String(formData.get('supplier') ?? '').trim();
  const mode     = String(formData.get('mode') ?? '').trim();
  const orderDate = String(formData.get('orderDate') ?? '').trim();
  const eta      = String(formData.get('eta') ?? '').trim();
  const sku      = String(formData.get('sku') ?? '').trim();
  const qtyRaw   = String(formData.get('qty') ?? '').trim();
  const unitCostRaw = String(formData.get('unitCost') ?? '').trim();
  const notes    = String(formData.get('notes') ?? '').trim();

  if (!sku) return { ok: false, error: 'SKU is required.' };
  const qty = Number(qtyRaw);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, error: 'Qty must be a positive number.' };
  }
  const unitCost = unitCostRaw ? Number(unitCostRaw) : 0;
  if (unitCostRaw && !Number.isFinite(unitCost)) {
    return { ok: false, error: 'Unit cost must be a number.' };
  }

  // Status whitelist — anything else risks breaking the dashboard SUMIFS.
  const allowedStatus = ['Draft', 'Incoming', 'Received', 'Cancelled'];
  if (!allowedStatus.includes(status)) {
    return { ok: false, error: `Status must be one of: ${allowedStatus.join(', ')}` };
  }
  // Mode is only relevant for Incoming/Air|Sea routing in the dashboard.
  // Allow blank for Draft/Received/Cancelled.
  if (mode && !['Air', 'Sea'].includes(mode)) {
    return { ok: false, error: 'Mode must be Air, Sea, or blank.' };
  }

  // Build the row in column order. Cols I, M..Q stay blank/zero for now.
  const row: (string | number)[] = [
    poNumber,                    // A PO #
    status,                      // B Status
    supplier,                    // C Supplier
    mode,                        // D Mode
    orderDate,                   // E Order Date
    eta,                         // F ETA
    sku,                         // G SKU
    qty,                         // H Qty
    unitCost,                    // I Unit Cost
    '',                          // J Received Date
    notes,                       // K Notes
    'Supplier PO',               // L Type
    '',                          // M Source
    '',                          // N Dest
    '',                          // O Source On Hand (formula owned by sheet)
    '',                          // P Dest On Hand
    '',                          // Q All-Day Total
  ];

  try {
    await appendRows('POs', [row]);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Force the dashboards and POs page to re-fetch on next render so the new
  // row is visible immediately.
  revalidatePath('/pos');
  revalidatePath('/dashboard');
  revalidatePath('/accessories');
  revalidatePath('/reorder');

  return { ok: true };
}

/**
 * Bulk-create Draft PO rows from per-SKU draft quantities. Each draft becomes
 * up to two POs lines (Amazon AWD + ShipBob WI) per the splitDraft policy.
 * Returns the count of rows actually written so the UI can give feedback.
 */
export interface DraftPushLine {
  sku: string;
  qty: number;
  unitCost: number;
  hasFbaSku: boolean;
  avgPerDay30d: number;
  amazonTotal: number;
  /** Supplier for this SKU's parent style (from Style_Templates). When two
   *  drafts have different suppliers, the push action splits them into
   *  separate POs so vendor handoff is clean. Defaults to RX Suspenders. */
  supplier?: string;
}

export async function createDraftPosFromDrafts(
  lines: DraftPushLine[],
  options: { poNumber?: string } = {},
): Promise<{ ok: boolean; created: number; poNumbers: string[]; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, created: 0, poNumbers: [], error: 'Not authenticated.' };

  if (!Array.isArray(lines) || lines.length === 0) {
    return { ok: false, created: 0, poNumbers: [], error: 'No drafts to push.' };
  }

  const today = new Date().toISOString().slice(0, 10);

  // Group draft lines by supplier so each vendor gets its own PO. Caller
  // override (options.poNumber) wins for everything that maps to its single
  // existing PO — but only if all drafts share the same supplier; if they
  // don't, we ignore the override for the mismatched suppliers and still
  // create vendor-specific POs to avoid cross-vendor lines on one PO.
  const DEFAULT_SUPPLIER = 'RX Suspenders';
  const bySupplier = new Map<string, DraftPushLine[]>();
  for (const line of lines) {
    if (!line.sku || !(line.qty > 0)) continue;
    const supplier = (line.supplier && line.supplier.trim()) || DEFAULT_SUPPLIER;
    if (!bySupplier.has(supplier)) bySupplier.set(supplier, []);
    bySupplier.get(supplier)!.push(line);
  }

  if (bySupplier.size === 0) {
    return { ok: false, created: 0, poNumbers: [], error: 'No drafts to push.' };
  }

  // If an existing PO# was provided AND all drafts share one supplier, route
  // them all to that PO. Otherwise mint per-supplier sequential PO#s so
  // cross-vendor pushes never collide on a single PO.
  const useOverride = options.poNumber && options.poNumber.trim() && bySupplier.size === 1;

  // For sequential numbering we need the current max PO# per supplier prefix
  // already on the sheet. Read once and reuse for every supplier in this push.
  const existingPos = useOverride ? [] : await readPos();
  const assignedThisRun = new Set<string>();

  const allRows: (string | number)[][] = [];
  const poNumbers: string[] = [];

  for (const [supplier, supplierLines] of bySupplier) {
    const poNumber = useOverride
      ? options.poNumber!.trim()
      : nextSequentialPoNumber(supplier, existingPos, assignedThisRun);
    assignedThisRun.add(poNumber);
    poNumbers.push(poNumber);

    for (const line of supplierLines) {
      const split = splitDraft({
        qty: line.qty,
        hasFbaSku: line.hasFbaSku,
        avgPerDay30d: line.avgPerDay30d,
        amazonTotal: line.amazonTotal,
      });
      const note = `Drafted from dashboard ${today}`;
      if (split.amz > 0) {
        allRows.push(buildSupplierPoRow({ poNumber, supplier, sku: line.sku, qty: split.amz, dest: 'AWD Storage', unitCost: line.unitCost, today, note }));
      }
      if (split.sb > 0) {
        allRows.push(buildSupplierPoRow({ poNumber, supplier, sku: line.sku, qty: split.sb, dest: 'ShipBob WI', unitCost: line.unitCost, today, note }));
      }
    }
  }

  if (allRows.length === 0) {
    return { ok: false, created: 0, poNumbers, error: 'All drafts split to zero — nothing to push.' };
  }

  try {
    await appendRows('POs', allRows);
  } catch (err) {
    return { ok: false, created: 0, poNumbers, error: err instanceof Error ? err.message : String(err) };
  }

  revalidatePath('/pos');
  revalidatePath('/dashboard');
  revalidatePath('/accessories');
  revalidatePath('/reorder');

  return { ok: true, created: allRows.length, poNumbers };
}

/**
 * Soft-cancel selected POs by flipping Status to "Cancelled". Rows stay on
 * the sheet as an audit trail; dashboard Pend / Cover math drops them
 * automatically because SUMIFS in the Apps Script (and the equivalent web
 * filter) only counts Status="Draft"|"Incoming".
 */
export async function bulkCancelPos(rowIndices: number[]): Promise<{ ok: boolean; updated: number; error?: string }> {
  return bulkUpdatePos(rowIndices.map((rowIndex) => ({ rowIndex, fields: { status: 'Cancelled' } })));
}

/**
 * Hard-delete selected POs — rows are permanently removed from the POs tab.
 * No audit trail, no undo. Use when the draft was a genuine mistake (typo,
 * wrong SKU, etc.) rather than a real cancellation. Caller is expected to
 * confirm with the user before calling.
 */
export async function deletePos(rowIndices: number[]): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, deleted: 0, error: 'Not authenticated.' };
  if (!Array.isArray(rowIndices) || rowIndices.length === 0) {
    return { ok: false, deleted: 0, error: 'No rows to delete.' };
  }
  for (const i of rowIndices) {
    if (!Number.isInteger(i) || i < 2) return { ok: false, deleted: 0, error: `Invalid row index: ${i}` };
  }
  try {
    await deleteRows('POs', rowIndices);
  } catch (err) {
    return { ok: false, deleted: 0, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath('/pos');
  revalidatePath('/dashboard');
  revalidatePath('/accessories');
  revalidatePath('/reorder');
  return { ok: true, deleted: rowIndices.length };
}

/**
 * One-time: create a `Suppliers` tab and seed it with the RX Suspenders
 * vendor block (sourced from PO #24036). Idempotent — if the tab exists
 * with rows, leaves them alone; if it exists but is empty, seeds it; if
 * it doesn't exist, creates and seeds it.
 *
 * Once this runs, edits in the sheet are the source of truth — running it
 * again will not overwrite Melissa's changes.
 */
export async function setupSuppliersTab(): Promise<{
  ok: boolean;
  created: boolean;
  seeded: boolean;
  error?: string;
}> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return { ok: false, created: false, seeded: false, error: 'Not authenticated.' };
  }

  try {
    const { created } = await ensureTabExists('Suppliers');

    // If the tab has any data already, don't overwrite.
    const existing = await readSuppliers();
    if (existing.size > 0) {
      return { ok: true, created, seeded: false };
    }

    // Seed with header + RX Suspenders row (sourced from PO #24036).
    await appendRows('Suppliers', [
      [
        'Supplier',
        'Company Name',
        'Attn',
        'Address (English)',
        'Chinese Address',
        'Contact Name',
        'Contact Phone',
      ],
      [
        'RX Suspenders',
        'Guangzhou City Rui Xin Leather Co., Ltd',
        'Juliet',
        'No. 14, Nanhe 2nd Street, Shiling Town, Huadu District, Guangzhou, China',
        '广州市花都区狮岭镇南方工业园南合二街14号 瑞信皮具',
        'Juliet',
        '+86-13822246647',
      ],
    ]);

    revalidatePath('/pos');
    return { ok: true, created, seeded: true };
  } catch (err) {
    return { ok: false, created: false, seeded: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Generate the next sequential PO# for a supplier. Reads the highest
 * existing `<PREFIX>-NNNNN` PO# from the sheet (and any already assigned
 * earlier in the same push) and increments by 1 with 5-digit zero padding.
 *
 * Default supplier "RX Suspenders" uses prefix "RX". Other suppliers get
 * the first 2 alphanumeric characters of their first word, uppercased
 * (e.g. "Pacific Wallet Co" → "PA"). If you want a specific abbreviation,
 * adjust supplierPrefix() rather than relying on the heuristic.
 */
function nextSequentialPoNumber(
  supplier: string,
  existing: { poNumber: string }[],
  alreadyAssigned: Set<string>,
): string {
  const prefix = supplierPrefix(supplier);
  const re = new RegExp(`^${prefix}-(\\d+)$`, 'i');
  let max = 0;
  for (const r of existing) {
    const m = r.poNumber.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0);
  }
  for (const a of alreadyAssigned) {
    const m = a.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0);
  }
  const next = String(max + 1).padStart(5, '0');
  return `${prefix}-${next}`;
}

function supplierPrefix(supplier: string): string {
  const trimmed = (supplier || '').trim();
  if (!trimmed || /^rx /i.test(trimmed) || /^rx$/i.test(trimmed)) return 'RX';
  // First 2 alphanumeric chars of the first word, uppercased.
  const word = trimmed.split(/\s+/)[0] || trimmed;
  const abbr = word.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  return abbr || 'RX';
}

/**
 * Update an existing PO row. Sparse — only the fields you pass get written.
 * Empty strings are written as blanks (so you can clear an ETA, etc.).
 *
 * `rowIndex` must come from the same readPos() snapshot the user is editing
 * against — if the sheet changes between read and edit, the wrong row could
 * be hit. We don't currently lock or version-check, so a stale tab in a
 * second window is the most realistic failure mode.
 */
export interface PoUpdateFields {
  poNumber?: string;
  status?: string;
  supplier?: string;
  mode?: string;
  orderDate?: string;
  eta?: string;
  sku?: string;
  qty?: number;
  unitCost?: number;
  receivedDate?: string;
  notes?: string;
}

export async function updatePo(
  rowIndex: number,
  fields: PoUpdateFields,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, error: 'Not authenticated.' };

  if (!Number.isInteger(rowIndex) || rowIndex < 2) {
    return { ok: false, error: `Invalid row index: ${rowIndex}` };
  }

  // Validation
  if (fields.status !== undefined) {
    const allowed = ['Draft', 'Incoming', 'Received', 'Cancelled'];
    if (!allowed.includes(fields.status)) {
      return { ok: false, error: `Status must be one of: ${allowed.join(', ')}` };
    }
  }
  if (fields.mode !== undefined && fields.mode !== '' && !['Air', 'Sea'].includes(fields.mode)) {
    return { ok: false, error: 'Mode must be Air, Sea, or blank.' };
  }
  if (fields.qty !== undefined && (!Number.isFinite(fields.qty) || fields.qty < 0)) {
    return { ok: false, error: 'Qty must be a non-negative number.' };
  }
  if (fields.unitCost !== undefined && (!Number.isFinite(fields.unitCost) || fields.unitCost < 0)) {
    return { ok: false, error: 'Unit cost must be a non-negative number.' };
  }

  const updates: Array<{ range: string; value: string | number }> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const col = PO_COL[key];
    if (!col) continue;
    updates.push({
      range: `'POs'!${col}${rowIndex}`,
      value: value as string | number,
    });
  }

  if (updates.length === 0) {
    return { ok: false, error: 'No fields to update.' };
  }

  try {
    await batchUpdateCells(updates);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  revalidatePath('/pos');
  revalidatePath('/dashboard');
  revalidatePath('/accessories');
  revalidatePath('/reorder');

  return { ok: true };
}

/**
 * Bulk-update many PO rows in a single Sheets API batch call. Each entry in
 * `updates` targets a specific row by its rowIndex with a sparse field set.
 * Empty/undefined fields are ignored, so you can pass `{eta: '2026-06-12'}`
 * and only that cell gets touched per row.
 */
export async function bulkUpdatePos(
  updates: Array<{ rowIndex: number; fields: PoUpdateFields }>,
): Promise<{ ok: boolean; updated: number; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, updated: 0, error: 'Not authenticated.' };

  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: false, updated: 0, error: 'No rows to update.' };
  }

  const cells: Array<{ range: string; value: string | number }> = [];
  for (const u of updates) {
    if (!Number.isInteger(u.rowIndex) || u.rowIndex < 2) {
      return { ok: false, updated: 0, error: `Invalid row index: ${u.rowIndex}` };
    }
    for (const [key, value] of Object.entries(u.fields)) {
      if (value === undefined) continue;
      const col = PO_COL[key];
      if (!col) continue;
      cells.push({ range: `'POs'!${col}${u.rowIndex}`, value: value as string | number });
    }
  }

  if (cells.length === 0) {
    return { ok: false, updated: 0, error: 'No fields to update.' };
  }

  try {
    await batchUpdateCells(cells);
  } catch (err) {
    return { ok: false, updated: 0, error: err instanceof Error ? err.message : String(err) };
  }

  revalidatePath('/pos');
  revalidatePath('/dashboard');
  revalidatePath('/accessories');
  revalidatePath('/reorder');

  return { ok: true, updated: updates.length };
}

// =====================================================================
// PO Payments — the PLAN per PO #. Actuals live on a sibling tab
// (`PO Payment Transactions`) where each money transfer is one row.
// Schema in lib/inventory.ts. Two suppliers in one PO is forbidden by the
// PO-creation flow, so PO # is a stable key.
// =====================================================================

const PO_PAYMENTS_HEADER: string[] = [
  'PO #',
  'Deposit %',
  'Deposit Due Date',
  'Balance Due Date',
  'Notes',
];

const PO_PAYMENTS_COL: Record<string, string> = {
  poNumber:       'A',
  depositPct:     'B',
  depositDueDate: 'C',
  balanceDueDate: 'D',
  notes:          'E',
};

export interface PoPaymentUpdateFields {
  depositPct?: number;        // 0..1 (0.20 = 20%)
  depositDueDate?: string;
  balanceDueDate?: string;
  notes?: string;
}

// =====================================================================
// PO Payment Transactions — one row per actual money transfer.
// =====================================================================

const PO_PAYMENT_TXNS_HEADER: string[] = [
  'PO #',
  'Type',          // Deposit | Balance | Shipping
  'Date',
  'Amount',        // principal sent to recipient
  'Fee',           // Alibaba/platform fee on this transaction (0 if none)
  'Notes',
  'Shipment ID',   // links Shipping txs to a row on Shipments tab; blank otherwise
];

const PO_PAYMENT_TXNS_COL: Record<string, string> = {
  poNumber:   'A',
  type:       'B',
  date:       'C',
  amount:     'D',
  fee:        'E',
  notes:      'F',
  shipmentId: 'G',
};

export interface PoPaymentTxnFields {
  type?: 'Deposit' | 'Balance' | 'Shipping';
  date?: string;
  amount?: number;
  fee?: number;
  notes?: string;
  shipmentId?: string;
}

/**
 * Idempotent: ensure both `PO Payments` and `PO Payment Transactions` tabs
 * exist with their headers. Safe to call repeatedly. Used by the upsert
 * actions before they write so a fresh workbook just-works.
 */
export async function setupPoPaymentsTab(): Promise<{
  ok: boolean;
  created: boolean;
  seeded: boolean;
  error?: string;
}> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return { ok: false, created: false, seeded: false, error: 'Not authenticated.' };
  }
  try {
    let createdAny = false;
    let seededAny  = false;

    // Plan tab
    const planRes = await ensureTabExists('PO Payments');
    createdAny = createdAny || planRes.created;
    const existingPlan = await readPoPayments();
    if (existingPlan.size === 0) {
      await batchUpdateCells(
        PO_PAYMENTS_HEADER.map((h, i) => ({
          range: `'PO Payments'!${String.fromCharCode(65 + i)}1`,
          value: h,
        })),
      );
      seededAny = true;
    }

    // Transactions tab
    const txnRes = await ensureTabExists('PO Payment Transactions');
    createdAny = createdAny || txnRes.created;
    const existingTxns = await readPoPaymentTransactions();
    if (existingTxns.size === 0) {
      await batchUpdateCells(
        PO_PAYMENT_TXNS_HEADER.map((h, i) => ({
          range: `'PO Payment Transactions'!${String.fromCharCode(65 + i)}1`,
          value: h,
        })),
      );
      seededAny = true;
    }

    revalidatePath('/pos');
    revalidatePath('/cashflow');
    return { ok: true, created: createdAny, seeded: seededAny };
  } catch (err) {
    return { ok: false, created: false, seeded: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Upsert the PLAN row for a PO (deposit %, due dates, notes). If a row
 * already exists, named fields are batch-updated in place (sparse). If
 * none exists, a fresh row is appended with the given fields and the rest
 * blank (depositPct defaults to 20%).
 *
 * Empty string clears a field. Use the transaction CRUD actions below to
 * record actual money transfers — those don't go through this function.
 */
export async function updatePoPayment(
  poNumber: string,
  fields: PoPaymentUpdateFields,
): Promise<{ ok: boolean; created: boolean; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, created: false, error: 'Not authenticated.' };

  const po = (poNumber || '').trim();
  if (!po) return { ok: false, created: false, error: 'PO # is required.' };

  if (fields.depositPct !== undefined) {
    const p = Number(fields.depositPct);
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      return { ok: false, created: false, error: 'depositPct must be a fraction between 0 and 1 (e.g. 0.20).' };
    }
  }

  await ensureTabExists('PO Payments');
  const existing = await readPoPayments();
  const row = existing.get(po);

  if (row) {
    const cells: Array<{ range: string; value: string | number }> = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const col = PO_PAYMENTS_COL[key];
      if (!col) continue;
      cells.push({ range: `'PO Payments'!${col}${row.rowIndex}`, value: value as string | number });
    }
    if (cells.length === 0) {
      return { ok: false, created: false, error: 'No fields to update.' };
    }
    try {
      await batchUpdateCells(cells);
    } catch (err) {
      return { ok: false, created: false, error: err instanceof Error ? err.message : String(err) };
    }
    revalidatePath('/pos');
    revalidatePath('/cashflow');
    return { ok: true, created: false };
  }

  // No plan row yet — append a fresh one with header guaranteed.
  if (existing.size === 0) {
    await batchUpdateCells(
      PO_PAYMENTS_HEADER.map((h, i) => ({
        range: `'PO Payments'!${String.fromCharCode(65 + i)}1`,
        value: h,
      })),
    );
  }
  const depositPct = fields.depositPct ?? DEFAULT_DEPOSIT_PCT;
  const newRow: (string | number)[] = [
    po,                              // A PO #
    depositPct,                      // B Deposit %
    fields.depositDueDate ?? '',     // C
    fields.balanceDueDate ?? '',     // D
    fields.notes          ?? '',     // E
  ];
  try {
    await appendRows('PO Payments', [newRow]);
  } catch (err) {
    return { ok: false, created: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath('/pos');
  revalidatePath('/cashflow');
  return { ok: true, created: true };
}

// ---------------------------------------------------------------------
// Transaction CRUD — append-only style for actuals.
// ---------------------------------------------------------------------

async function ensurePoPaymentTxnsTab(): Promise<void> {
  await ensureTabExists('PO Payment Transactions');
  const existing = await readPoPaymentTransactions();
  if (existing.size === 0) {
    // Header may or may not be present. We can't trivially read row 1 from
    // here without another helper; just write the header — batchUpdateCells
    // is idempotent at the cell level (overwrites with the same value).
    await batchUpdateCells(
      PO_PAYMENT_TXNS_HEADER.map((h, i) => ({
        range: `'PO Payment Transactions'!${String.fromCharCode(65 + i)}1`,
        value: h,
      })),
    );
  }
}

function validateTxnFields(fields: PoPaymentTxnFields, requireAll: boolean): string | null {
  if (requireAll || fields.type !== undefined) {
    if (fields.type !== 'Deposit' && fields.type !== 'Balance' && fields.type !== 'Shipping') {
      return 'Type must be Deposit, Balance, or Shipping.';
    }
  }
  if (requireAll || fields.amount !== undefined) {
    const a = Number(fields.amount);
    if (!Number.isFinite(a) || a <= 0) {
      return 'Amount must be a positive number.';
    }
  }
  if (fields.fee !== undefined) {
    const f = Number(fields.fee);
    if (!Number.isFinite(f) || f < 0) {
      return 'Fee must be a non-negative number (0 if none).';
    }
  }
  if (requireAll || fields.date !== undefined) {
    const d = String(fields.date ?? '').trim();
    if (!d) return 'Date is required.';
    const ts = Date.parse(d);
    if (!Number.isFinite(ts)) return 'Date must be a valid date (e.g. 2026-05-05).';
  }
  return null;
}

/**
 * Append a single payment transaction. PO # must already exist on the POs
 * tab — we don't validate that here (the UI shouldn't let you reach this
 * with a bogus PO #), but the join in loadPoSummaries will simply ignore
 * orphan transactions.
 */
export async function addPoPaymentTransaction(
  poNumber: string,
  fields: {
    type: 'Deposit' | 'Balance' | 'Shipping';
    date: string;
    amount: number;
    fee?: number;
    notes?: string;
    shipmentId?: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, error: 'Not authenticated.' };

  const po = (poNumber || '').trim();
  if (!po) return { ok: false, error: 'PO # is required.' };
  const err = validateTxnFields(fields, true);
  if (err) return { ok: false, error: err };

  await ensurePoPaymentTxnsTab();

  const newRow: (string | number)[] = [
    po,
    fields.type,
    fields.date,
    Number(fields.amount),
    Number(fields.fee ?? 0),
    fields.notes ?? '',
    fields.shipmentId ?? '',
  ];
  try {
    await appendRows('PO Payment Transactions', [newRow]);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath('/pos');
  revalidatePath('/cashflow');
  return { ok: true };
}

/** Edit an existing transaction in place by its row index. Sparse fields. */
export async function updatePoPaymentTransaction(
  rowIndex: number,
  fields: PoPaymentTxnFields,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, error: 'Not authenticated.' };

  if (!Number.isInteger(rowIndex) || rowIndex < 2) {
    return { ok: false, error: `Invalid row index: ${rowIndex}` };
  }
  const err = validateTxnFields(fields, false);
  if (err) return { ok: false, error: err };

  const cells: Array<{ range: string; value: string | number }> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const col = PO_PAYMENT_TXNS_COL[key];
    if (!col) continue;
    cells.push({ range: `'PO Payment Transactions'!${col}${rowIndex}`, value: value as string | number });
  }
  if (cells.length === 0) {
    return { ok: false, error: 'No fields to update.' };
  }
  try {
    await batchUpdateCells(cells);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath('/pos');
  revalidatePath('/cashflow');
  return { ok: true };
}

/** Hard-delete one or more transactions by row index. */
export async function deletePoPaymentTransactions(
  rowIndices: number[],
): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, deleted: 0, error: 'Not authenticated.' };

  if (!Array.isArray(rowIndices) || rowIndices.length === 0) {
    return { ok: false, deleted: 0, error: 'No rows to delete.' };
  }
  for (const i of rowIndices) {
    if (!Number.isInteger(i) || i < 2) return { ok: false, deleted: 0, error: `Invalid row index: ${i}` };
  }
  try {
    await deleteRows('PO Payment Transactions', rowIndices);
  } catch (e) {
    return { ok: false, deleted: 0, error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath('/pos');
  revalidatePath('/cashflow');
  return { ok: true, deleted: rowIndices.length };
}

// =====================================================================
// Shipments + Shipment Lines — physical shipment tracking. A PO can
// produce N shipments; each shipment goes to ONE destination warehouse.
// Shipping payment transactions optionally link via shipmentId.
// =====================================================================

const SHIPMENTS_HEADER: string[] = [
  'Shipment ID',
  'PO #',
  'Label',
  'Mode',                 // Air | Sea | Truck
  'Destination',          // AWD Storage | ShipBob WI
  'Departure Date',
  'ETA',
  'Status',               // Planning | In Transit | Received | Cancelled
  'Carrier',
  'Tracking #',
  'Receiving Order ID',   // AWD inbound ID or ShipBob WRO ID
  'Estimated Cost',
  'Notes',
];

const SHIPMENTS_COL: Record<string, string> = {
  shipmentId:        'A',
  poNumber:          'B',
  label:             'C',
  mode:              'D',
  destination:       'E',
  departureDate:     'F',
  eta:               'G',
  status:            'H',
  carrier:           'I',
  trackingNumber:    'J',
  receivingOrderId:  'K',
  estimatedCost:     'L',
  notes:             'M',
};

const SHIPMENT_LINES_HEADER: string[] = ['Shipment ID', 'SKU', 'Qty'];

const SHIPMENT_STATUSES: ShipmentStatus[] = ['Planning', 'In Transit', 'Received', 'Cancelled'];
const SHIPMENT_MODES = ['Air', 'Sea', 'Truck'];

export interface ShipmentFields {
  label?: string;
  mode?: string;
  destination?: string;
  departureDate?: string;
  eta?: string;
  status?: ShipmentStatus;
  carrier?: string;
  trackingNumber?: string;
  receivingOrderId?: string;
  estimatedCost?: number;
  notes?: string;
}

export interface ShipmentLineInput {
  sku: string;
  qty: number;
}

async function ensureShipmentTabs(): Promise<void> {
  await ensureTabExists('Shipments');
  const ships = await readShipments();
  if (ships.size === 0) {
    await batchUpdateCells(
      SHIPMENTS_HEADER.map((h, i) => ({
        range: `'Shipments'!${String.fromCharCode(65 + i)}1`,
        value: h,
      })),
    );
  }
  await ensureTabExists('Shipment Lines');
  const lines = await readShipmentLines();
  if (lines.size === 0) {
    await batchUpdateCells(
      SHIPMENT_LINES_HEADER.map((h, i) => ({
        range: `'Shipment Lines'!${String.fromCharCode(65 + i)}1`,
        value: h,
      })),
    );
  }
}

function nextShipmentId(existingIds: Iterable<string>, alreadyAssigned: Set<string>): string {
  const re = /^SHP-(\d+)$/i;
  let max = 0;
  for (const id of existingIds) {
    const m = id.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0);
  }
  for (const id of alreadyAssigned) {
    const m = id.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0);
  }
  return `SHP-${String(max + 1).padStart(5, '0')}`;
}

function validateShipmentFields(fields: ShipmentFields, requireAll: boolean): string | null {
  if (requireAll || fields.mode !== undefined) {
    if (!fields.mode || !SHIPMENT_MODES.includes(fields.mode)) {
      return `Mode must be one of: ${SHIPMENT_MODES.join(', ')}`;
    }
  }
  if (requireAll || fields.destination !== undefined) {
    if (!fields.destination || !fields.destination.trim()) {
      return 'Destination is required.';
    }
  }
  if (fields.status !== undefined && !SHIPMENT_STATUSES.includes(fields.status)) {
    return `Status must be one of: ${SHIPMENT_STATUSES.join(', ')}`;
  }
  if (fields.estimatedCost !== undefined) {
    const v = Number(fields.estimatedCost);
    if (!Number.isFinite(v) || v < 0) return 'Estimated cost must be a non-negative number.';
  }
  return null;
}

/**
 * After a shipment changes (status flip, line edits, or new shipment) for
 * one PO #, walk that PO's Incoming rows and flip to Received any whose qty
 * is fully covered by Received-shipment line qtys for the same SKU.
 *
 * Per-SKU pro-rata: Received qty is consumed across the PO's Incoming rows
 * in sheet-row order. A row is only flipped when fully consumed; partial
 * receipts leave the row Incoming and the Apparel Stock dashboard handles
 * the subtraction itself (see readPoAggregates in src/lib/inventory.ts).
 *
 * Does NOT un-flip already-Received rows when a Received shipment is later
 * un-received — that's a manual cleanup on the POs page if you change your
 * mind. Cheap to add later if it comes up.
 */
async function reconcilePoLinesAfterReceive(poNumber: string): Promise<void> {
  const pn = (poNumber || '').trim();
  if (!pn) return;

  const [pos, shipments, shipLines] = await Promise.all([
    readPos(),
    readShipments(),
    readShipmentLines(),
  ]);

  // Sum Received-shipment line qtys for THIS PO, per SKU.
  const receivedBySku = new Map<string, number>();
  for (const sh of shipments.values()) {
    if (sh.poNumber !== pn) continue;
    if (sh.status !== 'Received') continue;
    const lines = shipLines.get(sh.shipmentId) ?? [];
    for (const l of lines) {
      if (!l.sku || l.qty <= 0) continue;
      receivedBySku.set(l.sku, (receivedBySku.get(l.sku) ?? 0) + l.qty);
    }
  }
  if (receivedBySku.size === 0) return;

  const today = new Date().toISOString().slice(0, 10);
  const consumed = new Map<string, number>();
  const cells: Array<{ range: string; value: string | number }> = [];

  // Walk in sheet-row order so per-SKU consumption matches readPoAggregates
  // exactly. Mismatched ordering would let the dashboard and the POs tab
  // disagree about which row got "the" received qty.
  const rows = pos
    .filter((r) => r.poNumber === pn)
    .sort((a, b) => a.rowIndex - b.rowIndex);

  for (const r of rows) {
    if (r.status !== 'Incoming') continue;
    if ((r.type || '').toLowerCase() === 'internal transfer') continue;
    if (!r.sku || r.qty <= 0) continue;
    const available = receivedBySku.get(r.sku) ?? 0;
    const already   = consumed.get(r.sku) ?? 0;
    const consume   = Math.min(r.qty, Math.max(available - already, 0));
    consumed.set(r.sku, already + consume);
    if (consume < r.qty) continue;       // partial only — don't flip
    cells.push({ range: `'POs'!B${r.rowIndex}`, value: 'Received' });
    if (!r.receivedDate) {
      cells.push({ range: `'POs'!J${r.rowIndex}`, value: today });
    }
  }
  if (cells.length === 0) return;
  await batchUpdateCells(cells);
}

/**
 * Create a new Shipment for a PO with optional initial line allocations.
 * Generates the next sequential SHP-NNNNN ID. Status defaults to 'Planning'.
 */
export async function createShipment(
  poNumber: string,
  fields: ShipmentFields,
  lines: ShipmentLineInput[] = [],
): Promise<{ ok: boolean; shipmentId?: string; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, error: 'Not authenticated.' };

  const po = (poNumber || '').trim();
  if (!po) return { ok: false, error: 'PO # is required.' };
  const vErr = validateShipmentFields(fields, true);
  if (vErr) return { ok: false, error: vErr };

  await ensureShipmentTabs();
  const existing = await readShipments();
  const shipmentId = nextShipmentId(existing.keys(), new Set());

  const status: ShipmentStatus = fields.status ?? 'Planning';
  const newRow: (string | number)[] = [
    shipmentId,
    po,
    fields.label ?? '',
    fields.mode!,
    fields.destination!,
    fields.departureDate ?? '',
    fields.eta ?? '',
    status,
    fields.carrier ?? '',
    fields.trackingNumber ?? '',
    fields.receivingOrderId ?? '',
    Number(fields.estimatedCost ?? 0),
    fields.notes ?? '',
  ];
  try {
    await appendRows('Shipments', [newRow]);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (lines.length > 0) {
    const lineRows = lines
      .filter((l) => l.sku && l.qty > 0)
      .map((l) => [shipmentId, l.sku, Number(l.qty)] as (string | number)[]);
    if (lineRows.length > 0) {
      try {
        await appendRows('Shipment Lines', lineRows);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  // Rare on create (status usually starts Planning), but if the user saves
  // a brand-new shipment already at Received, auto-close any fully-covered
  // PO lines so Apparel Stock matches.
  if (status === 'Received') {
    try {
      await reconcilePoLinesAfterReceive(po);
    } catch {
      // Silent — shipment write already succeeded; user can re-save to retry.
    }
  }
  revalidatePath('/pos');
  revalidatePath('/cashflow');
  revalidatePath('/dashboard');
  revalidatePath('/accessories');
  revalidatePath('/reorder');
  return { ok: true, shipmentId };
}

/** Update fields on an existing shipment (sparse). */
export async function updateShipment(
  shipmentId: string,
  fields: ShipmentFields,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, error: 'Not authenticated.' };

  const id = (shipmentId || '').trim();
  if (!id) return { ok: false, error: 'Shipment ID is required.' };
  const vErr = validateShipmentFields(fields, false);
  if (vErr) return { ok: false, error: vErr };

  const existing = await readShipments();
  const sh = existing.get(id);
  if (!sh) return { ok: false, error: `Shipment ${id} not found.` };

  const cells: Array<{ range: string; value: string | number }> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const col = SHIPMENTS_COL[key];
    if (!col) continue;
    cells.push({ range: `'Shipments'!${col}${sh.rowIndex}`, value: value as string | number });
  }
  if (cells.length === 0) return { ok: false, error: 'No fields to update.' };

  try {
    await batchUpdateCells(cells);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // After any shipment field change, reconcile against the parent PO — the
  // status may have just flipped to Received, or the user may have edited
  // a Received shipment's metadata in a way that affects nothing here but
  // is cheap to re-check.
  try {
    await reconcilePoLinesAfterReceive(sh.poNumber);
  } catch {
    // Silent — shipment write already succeeded.
  }
  revalidatePath('/pos');
  revalidatePath('/cashflow');
  revalidatePath('/dashboard');
  revalidatePath('/accessories');
  revalidatePath('/reorder');
  return { ok: true };
}

/**
 * Replace all line allocations for a shipment with the given list. Existing
 * rows are deleted; provided list is appended fresh. Empty list = delete all
 * lines for this shipment.
 */
export async function replaceShipmentLines(
  shipmentId: string,
  lines: ShipmentLineInput[],
): Promise<{ ok: boolean; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, error: 'Not authenticated.' };

  const id = (shipmentId || '').trim();
  if (!id) return { ok: false, error: 'Shipment ID is required.' };

  await ensureShipmentTabs();
  const existing = await readShipmentLines();
  const oldLines = existing.get(id) ?? [];
  if (oldLines.length > 0) {
    try {
      await deleteRows('Shipment Lines', oldLines.map((l) => l.rowIndex));
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const filtered = lines.filter((l) => l.sku && l.qty > 0);
  if (filtered.length > 0) {
    const rows = filtered.map((l) => [id, l.sku, Number(l.qty)] as (string | number)[]);
    try {
      await appendRows('Shipment Lines', rows);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  // Editing lines on a Received shipment changes consumption — recompute.
  // Cheap to run unconditionally; reconcilePoLinesAfterReceive no-ops when
  // the PO has no Received shipments yet.
  try {
    const ships = await readShipments();
    const parent = ships.get(id);
    if (parent?.poNumber) await reconcilePoLinesAfterReceive(parent.poNumber);
  } catch {
    // Silent — line write already succeeded.
  }
  revalidatePath('/pos');
  revalidatePath('/dashboard');
  revalidatePath('/accessories');
  revalidatePath('/reorder');
  return { ok: true };
}

/**
 * Hard-delete a shipment AND its line allocations. Any shipping transactions
 * still pointing to this shipmentId become "unassigned" (their col G no
 * longer matches a real shipment). They keep counting toward PO totals.
 */
export async function deleteShipment(
  shipmentId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, error: 'Not authenticated.' };

  const id = (shipmentId || '').trim();
  if (!id) return { ok: false, error: 'Shipment ID is required.' };

  const ships = await readShipments();
  const sh = ships.get(id);
  if (!sh) return { ok: false, error: `Shipment ${id} not found.` };

  const lineMap = await readShipmentLines();
  const lineRows = (lineMap.get(id) ?? []).map((l) => l.rowIndex);

  try {
    if (lineRows.length > 0) {
      await deleteRows('Shipment Lines', lineRows);
    }
    await deleteRows('Shipments', [sh.rowIndex]);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath('/pos');
  revalidatePath('/cashflow');
  return { ok: true };
}

/**
 * Close a PO line as short — reduces the line's qty by `shortQty`, appends a
 * dated note to the Notes column, flips status to Received, and stamps the
 * Received Date if blank. One atomic batched write so the row never lands
 * in a partial state. Used when a vendor underships and you've accepted the
 * shortage rather than chasing the missing units.
 *
 * Validations:
 *   - shortQty must be a positive integer
 *   - shortQty must be < current line qty (closing 100% short = use Cancelled)
 *   - line cannot already be Received or Cancelled (would be a no-op or
 *     surprising rewrite — the user can edit those manually if needed)
 *
 * Note format: appended to existing Notes with a separator, so prior context
 * is preserved. Example existing notes "Sea shipped 2026-04-19" becomes
 * "Sea shipped 2026-04-19 | Vendor short 1 unit, closed 2026-05-26".
 */
export async function closePoLineAsShort(
  rowIndex: number,
  shortQty: number,
): Promise<{ ok: boolean; error?: string; newQty?: number }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, error: 'Not authenticated.' };

  if (!Number.isInteger(rowIndex) || rowIndex < 2) {
    return { ok: false, error: 'Invalid row index.' };
  }
  if (!Number.isFinite(shortQty) || shortQty <= 0 || !Number.isInteger(shortQty)) {
    return { ok: false, error: 'Short qty must be a positive integer.' };
  }

  const pos = await readPos();
  const row = pos.find((r) => r.rowIndex === rowIndex);
  if (!row) return { ok: false, error: `PO row ${rowIndex} not found.` };
  if (row.status === 'Received' || row.status === 'Cancelled') {
    return { ok: false, error: `Line is already ${row.status}; nothing to close.` };
  }
  if (shortQty >= row.qty) {
    return {
      ok: false,
      error: `Short qty (${shortQty}) must be less than line qty (${row.qty}). For a full shortage, set status to Cancelled instead.`,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const newQty = row.qty - shortQty;
  const shortNote = `Vendor short ${shortQty} unit${shortQty === 1 ? '' : 's'}, closed ${today}`;
  const combinedNotes = row.notes ? `${row.notes} | ${shortNote}` : shortNote;

  const cells: Array<{ range: string; value: string | number }> = [
    { range: `'POs'!B${rowIndex}`, value: 'Received' },
    { range: `'POs'!H${rowIndex}`, value: newQty },
    { range: `'POs'!K${rowIndex}`, value: combinedNotes },
  ];
  if (!row.receivedDate) {
    cells.push({ range: `'POs'!J${rowIndex}`, value: today });
  }

  try {
    await batchUpdateCells(cells);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath('/pos');
  revalidatePath('/dashboard');
  revalidatePath('/accessories');
  revalidatePath('/reorder');
  return { ok: true, newQty };
}

/**
 * Public-facing reconciler. Wraps reconcilePoLinesAfterReceive so the UI can
 * trigger writeback on demand for POs whose shipments were marked Received
 * before the auto-reconcile shipped, or whose previous auto-reconcile failed
 * silently (the catch around the reconcile call in createShipment /
 * updateShipment / replaceShipmentLines swallows transient Sheets errors so
 * the user's edit isn't blocked, but that means stuck Incoming rows can pile
 * up if Sheets blips during a Receive).
 *
 * Idempotent — running twice has the same effect as once.
 *
 * - poNumber given → reconcile only that PO.
 * - poNumber omitted/blank → walk every PO with at least one Received
 *   shipment and reconcile each. Useful as a global "heal everything" button.
 *
 * Returns counts so the UI can confirm what happened. `linesFlipped` is the
 * number of POs-tab status writebacks that fired across all reconciled POs.
 */
export async function reconcileReceivedPoLines(
  poNumber?: string,
): Promise<{ ok: boolean; reconciledPos: number; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, reconciledPos: 0, error: 'Not authenticated.' };

  const target = (poNumber || '').trim();
  try {
    if (target) {
      await reconcilePoLinesAfterReceive(target);
      revalidatePath('/pos');
      revalidatePath('/dashboard');
      revalidatePath('/accessories');
      revalidatePath('/reorder');
      return { ok: true, reconciledPos: 1 };
    }
    // No PO# — heal every PO that has at least one Received shipment.
    const shipments = await readShipments();
    const posWithReceived = new Set<string>();
    for (const sh of shipments.values()) {
      if (sh.status === 'Received' && sh.poNumber) posWithReceived.add(sh.poNumber);
    }
    let count = 0;
    for (const pn of posWithReceived) {
      await reconcilePoLinesAfterReceive(pn);
      count++;
    }
    revalidatePath('/pos');
    revalidatePath('/dashboard');
    revalidatePath('/accessories');
    revalidatePath('/reorder');
    return { ok: true, reconciledPos: count };
  } catch (e) {
    return { ok: false, reconciledPos: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

function buildSupplierPoRow({ poNumber, supplier, sku, qty, dest, unitCost, today, note }: {
  poNumber: string; supplier?: string; sku: string; qty: number; dest: string; unitCost: number; today: string; note: string;
}): (string | number)[] {
  return [
    poNumber,                       // A PO #          (auto-generated if not provided)
    'Draft',                        // B Status
    supplier || 'RX Suspenders',    // C Supplier      (per-style from Style_Templates, default RX)
    '',                  // D Mode          (Air/Sea — assigned at finalize)
    today,               // E Order Date
    '',                  // F ETA
    sku,                 // G SKU
    qty,                 // H Qty
    unitCost || 0,       // I Unit Cost
    '',                  // J Received Date
    note,                // K Notes
    'Supplier PO',       // L Type
    '',                  // M Source
    dest,                // N Dest          ('AWD Storage' or 'ShipBob WI')
    '',                  // O Source On Hand
    '',                  // P Dest On Hand
    '',                  // Q All-Day Total
  ];
}

// ---------------------------------------------------------------------------
// ShipBob WRO (Warehouse Receiving Order) CSV export
// ---------------------------------------------------------------------------

/**
 * ShipBob's WRO product-upload template — fixed 7-column format, confirmed
 * 2026-04-22 from WRO_ProductUpload_Template_04-21-2026.csv. Box/carton
 * config happens in the ShipBob UI after upload, so the CSV is purely
 * SKU + qty. This is the Shipments-feature equivalent of the older
 * POs-tab Apps Script generator in 17_shipbob_receiving.gs — one shipment
 * (one destination, one mode) maps to exactly one WRO.
 */
const WRO_CSV_HEADER = [
  'InventoryId',
  'SKU',
  'ItemName',
  'IsLot (Yes/No value)',
  'QuantityToSend',
  'LotNumber',
  'ExpirationDate',
];

/** ShipBob's CSV importer rejects any file with more than this many data
 *  rows ("Only 100 records allowed to import"). Shipments with more SKUs
 *  than this are split into multiple files, each imported in turn into the
 *  same WRO. */
const WRO_MAX_RECORDS = 100;

/** RFC-4180-ish cell escaping: quote when the value has a comma, quote, CR or LF. */
function wroCsvCell(v: string | number): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One generated CSV file. A shipment yields more than one of these only
 *  when its SKU count exceeds ShipBob's WRO_MAX_RECORDS import limit. */
export interface WroExportFile {
  /** Suggested download filename, e.g. shipbob_WRO_SHP-00012_20260520_1of2.csv */
  filename: string;
  /** Full CSV text (CRLF line endings) ready to be saved as a .csv file. */
  csv: string;
  /** Number of SKU data rows in this file (<= WRO_MAX_RECORDS). */
  recordCount: number;
}

export interface WroExportResult {
  ok: boolean;
  /** Generated CSV file(s). Length is >1 when the shipment was split to
   *  stay under ShipBob's 100-record-per-file import cap. */
  files?: WroExportFile[];
  /** Human-readable error when ok is false. */
  error?: string;
  /** SKUs with no ShipBob Inventory ID — populated when the export is blocked. */
  missingSkus?: string[];
}

/**
 * Build the ShipBob WRO CSV for a single shipment, from its saved line
 * allocations on the Shipment Lines tab.
 *
 * The export is BLOCKED (ok:false, missingSkus populated) when any allocated
 * SKU has no ShipBob Inventory ID in SKU Master col O — uploading those rows
 * would create stray, unmatched items at ShipBob, so every line must be
 * linked first. ShipBob-WI shipments only; AWD shipments use Amazon's
 * inbound flow, not a WRO.
 */
export async function exportShipmentWro(
  shipmentId: string,
): Promise<WroExportResult> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, error: 'Not authenticated.' };

  const id = (shipmentId || '').trim();
  if (!id) return { ok: false, error: 'Shipment ID is required.' };

  const [ships, lineMap] = await Promise.all([readShipments(), readShipmentLines()]);
  const sh = ships.get(id);
  if (!sh) return { ok: false, error: `Shipment ${id} not found.` };
  if (sh.destination !== 'ShipBob WI') {
    return {
      ok: false,
      error: `${id} ships to ${sh.destination || 'an unset destination'}. WRO CSVs are for ShipBob WI shipments only.`,
    };
  }

  // Aggregate qty per SKU (defensive — a shipment normally has one row/SKU).
  const qtyBySku = new Map<string, number>();
  for (const l of lineMap.get(id) ?? []) {
    if (!l.sku || l.qty <= 0) continue;
    qtyBySku.set(l.sku, (qtyBySku.get(l.sku) ?? 0) + l.qty);
  }
  if (qtyBySku.size === 0) {
    return { ok: false, error: `${id} has no line allocations to export.` };
  }

  // Resolve ShipBob Inventory ID (SKU Master col O) + ItemName (Shipbob Feed).
  const [skuMaster, shipbobFeed] = await Promise.all([readSkuMaster(), readShipbobFeed()]);
  const invIdBySku = new Map<string, string>();
  for (const m of skuMaster) {
    if (m.sku) invIdBySku.set(m.sku, (m.shipbobInventoryId || '').trim());
  }

  // Block: every SKU must carry a ShipBob Inventory ID before an upload.
  const missingSkus = [...qtyBySku.keys()]
    .filter((sku) => !invIdBySku.get(sku))
    .sort();
  if (missingSkus.length > 0) {
    const one = missingSkus.length === 1;
    return {
      ok: false,
      missingSkus,
      error:
        `${missingSkus.length} SKU${one ? '' : 's'} on ${id} ${one ? 'has' : 'have'} no ` +
        `ShipBob Inventory ID in SKU Master (column O). Link ${one ? 'it' : 'them'} — ` +
        `run HIKERS Tools → Refresh ShipBob, or paste the ID from the Shipbob Feed tab — ` +
        `then export again.`,
    };
  }

  // Build one data row per SKU, sorted for a stable, scannable file.
  const dataRows: string[] = [];
  for (const sku of [...qtyBySku.keys()].sort()) {
    const invId = invIdBySku.get(sku) ?? '';
    const itemName = shipbobFeed.get(invId)?.inventoryName ?? '';
    dataRows.push([invId, sku, itemName, 'No', qtyBySku.get(sku) ?? 0, '', ''].map(wroCsvCell).join(','));
  }

  // ShipBob's importer caps a file at WRO_MAX_RECORDS data rows. Split into
  // chunks of that size; each chunk is a self-contained CSV with its own
  // header. One chunk -> a single unsuffixed filename; multiple chunks ->
  // "_NofM" suffixes, imported in order into the same WRO.
  const header = WRO_CSV_HEADER.join(',');
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const chunks: string[][] = [];
  for (let i = 0; i < dataRows.length; i += WRO_MAX_RECORDS) {
    chunks.push(dataRows.slice(i, i + WRO_MAX_RECORDS));
  }
  const files: WroExportFile[] = chunks.map((chunk, idx) => ({
    filename: `shipbob_WRO_${id}_${stamp}${chunks.length > 1 ? `_${idx + 1}of${chunks.length}` : ''}.csv`,
    csv: [header, ...chunk].join('\r\n') + '\r\n',
    recordCount: chunk.length,
  }));
  return { ok: true, files };
}
