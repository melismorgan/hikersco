'use server';

import { revalidatePath } from 'next/cache';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { appendRows, batchUpdateCells, deleteRows, ensureTabExists } from '@/lib/sheets';
import { splitDraft } from '@/lib/policy';
import { readPos, readSuppliers } from '@/lib/inventory';

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
