/**
 * Typed readers for the live HIKERS workbook tabs, plus the join logic
 * that powers the Apparel and Accessories dashboards.
 *
 * Mirrors the schema documented in 02_dashboard.gs (Apps Script). When the
 * sheet schema changes, update both. Web dashboard logic stays here so it
 * can be unit-tested independently of the Sheets API layer.
 *
 * Schema reference (snapshot 2026-05-04):
 *
 * SKU Master (cols A..S)
 *   A SKU                    L FBA SKU
 *   B Parent (Style+Color)   M FBM ASIN
 *   C Style                  N FBM SKU
 *   D Color                  O Shipbob Inventory ID
 *   E Size                   P Shopify Listed
 *   F Size_Order             Q Unit Cost
 *   G Category               R Active
 *   H Product Title          S Shipbob Case Pack ID
 *
 * Shipbob Feed (cols A..F + dynamic FC cols + Last Synced)
 *   A Inventory ID  C Total On Hand   E Units Per Case
 *   B Inv Name      D Twin Lakes (WI) F Merchant SKU
 *
 * Amazon Feed (SP-API standard; cols A..T+ used)
 *   A sku           K(11) afn-fulfillable     P(16) afn-inbound-working
 *                   M(13) afn-reserved        Q(17) afn-inbound-shipped
 *                                             R(18) afn-inbound-receiving
 *                   S(19) AWD Storage         T(20) AWD → FBA Transit
 *
 * Velocity (cols A..N)
 *   A Style    D Units 7d    G Avg/Day 7d
 *   B Color    E Units 30d   H Avg/Day 30d   ← this is what dashboard uses
 *   C SKU      F Units 90d   I Avg/Day 90d
 *
 * POs (cols A..Q)
 *   A PO #       G SKU         L Type        (Supplier PO | Internal Transfer)
 *   B Status     H Qty         M Source
 *   C Supplier                 N Dest
 *   D Mode (Air|Sea)           O Source On Hand
 *   E Order Date               P Dest On Hand
 *   F ETA                      Q All-Day Total
 *
 * PO Payments (cols A..E) — one row per PO #, holds the PLAN only.
 *   A PO #
 *   B Deposit %        (fraction 0..1; default 0.20)
 *   C Deposit Due Date (when deposit is owed)
 *   D Balance Due Date (when balance is owed; on staged deliveries this is
 *                       the first due date — actuals come from transactions)
 *   E Notes            (free text — Alibaba Trade Assurance # often goes here)
 *
 * PO Payment Transactions (cols A..G) — one row per actual money transfer.
 * A single PO can have N transactions per leg: deposits sometimes split into
 * 2-3 transfers, balance payments often split across staged deliveries
 * (pay 50% balance on first container, 50% on second), and shipping payments
 * land separately when the freight forwarder is paid before shipment.
 *   A PO #
 *   B Type        (Deposit | Balance | Shipping)
 *   C Date        (when the transfer happened)
 *   D Amount      (principal — what the recipient receives)
 *   E Fee         (Alibaba/platform fee on this transaction; 0 if none)
 *   F Notes       (Alibaba TA event ref, batch number, "1 of 3", etc.)
 *   G Shipment ID (links Shipping txs to a row on the Shipments tab; blank
 *                  for Deposit/Balance txs and for legacy Shipping txs)
 *
 * Type semantics:
 *   Deposit + Balance — paid to the supplier (RX). Together they cover the
 *     PO Total (= sum of line items × unit cost). Deposit % applies to PO
 *     Total, balance is the remainder.
 *   Shipping — paid to the freight forwarder, separate stream. Has no plan
 *     amount in v1; tracked as actuals only so we can answer "have we paid
 *     enough to release the shipment?"
 *
 * Fees are intrinsic to each transaction (Alibaba charges a platform fee on
 * top of the principal). Stored separately so we can roll up TRUE landed
 * cost = PO Total + Σ Shipping + Σ Fees.
 *
 * Computed from transactions in loadPoSummaries:
 *   depositPaidAmount  = Σ(Type=Deposit  Amount)
 *   balancePaidAmount  = Σ(Type=Balance  Amount)
 *   shippingPaidAmount = Σ(Type=Shipping Amount)
 *   totalFees          = Σ(any-type Fee)
 *   landedCost         = totalCost + shippingPaidAmount + totalFees
 *
 * Note: shipping is NOT entered as a line item on the POs tab — it's only
 * tracked here. If you want freight in COGS, use landedCost.
 *
 * Shipments (cols A..M) — one row per physical shipment leaving RX.
 *   A Shipment ID         (auto SHP-NNNNN sequential)
 *   B PO #                (parent PO)
 *   C Label               (free text — "Air restock to AWD", optional)
 *   D Mode                (Air | Sea | Truck)
 *   E Destination         (AWD Storage | ShipBob WI)
 *   F Departure Date
 *   G ETA
 *   H Status              (Planning | In Transit | Received | Cancelled)
 *   I Carrier             (forwarder name)
 *   J Tracking #
 *   K Receiving Order ID  (AWD inbound shipment ID or ShipBob WRO ID)
 *   L Estimated Cost      (freight quote, optional)
 *   M Notes
 *
 * Shipment Lines (cols A..C) — line-item allocation per shipment. A PO
 * line item can be split across multiple shipments (e.g. 500 air + 4500 sea).
 *   A Shipment ID
 *   B SKU
 *   C Qty
 *
 * A shipment goes to exactly ONE destination. PO splitting AWD + ShipBob
 * = two shipments. Existing pre-shipments POs (history) don't need backfill;
 * shipments only apply to new POs going forward.
 */

import { readTab } from './sheets';
import { lineOrderIndex } from './line-order';

// ---- Row types --------------------------------------------------------------

export interface SkuMasterRow {
  sku: string;
  parent: string;
  style: string;
  color: string;
  size: string;
  sizeOrder: number;
  category: string;
  productTitle: string;
  fbaSku: string;
  shipbobInventoryId: string;
  unitCost: number;
  active: boolean;
  shipbobCasePackId: string;
}

export interface ShipbobFeedRow {
  inventoryId: string;
  inventoryName: string;
  totalOnHand: number;
  twinLakesWi: number;
  unitsPerCase: number;
  merchantSku: string;
}

export interface AmazonFeedRow {
  fbaSku: string;
  afnFulfillable: number;
  afnReserved: number;
  afnInboundWorking: number;
  afnInboundShipped: number;
  afnInboundReceiving: number;
  awdStorage: number;
  awdToFbaTransit: number;
}

export interface VelocityRow {
  sku: string;
  avgPerDay30d: number;
}

/** Full Velocity-tab record for the /velocity browser. */
export interface VelocityFull {
  style: string;
  color: string;
  sku: string;
  units7d: number;
  units30d: number;
  units90d: number;
  avgPerDay7d: number;
  avgPerDay30d: number;
  avgPerDay90d: number;
  lastSync: string;
  trend: string;
  inStockDays30d: number;
  stockoutPct30d: number;
  avgPerDay30dObserved: number;
}

/** Per-SKU aggregations off the POs tab. */
export interface PoAggregates {
  inTransitAir: number;
  inTransitSea: number;
  draftPo: number;
  /** Incoming PO lines for this SKU, sorted by ETA ascending (earliest first). */
  incoming: IncomingPoLine[];
}

/** A single Incoming PO line attached to a SKU, used for ETA display. */
export interface IncomingPoLine {
  poNumber: string;
  mode: string;       // 'Air' | 'Sea' | other
  eta: string;        // raw string from sheet
  etaTimestamp: number; // Date.parse(eta), or Number.MAX_SAFE_INTEGER if unparsable
  qty: number;
}

/**
 * A row on the PO Payments tab — the PLAN per PO #. Actual money transfers
 * live on the PO Payment Transactions tab (potentially many per PO).
 */
export interface PoPaymentRow {
  /** 1-based sheet row number; header is row 1, first data row is 2.
   *  Used as the address for in-place edits. */
  rowIndex: number;
  poNumber: string;
  /** Deposit fraction (0..1). 0.20 = 20% deposit / 80% balance. Default 0.20. */
  depositPct: number;
  depositDueDate: string;
  balanceDueDate: string;
  notes: string;
}

/** A single payment transaction — one money transfer for a PO. */
export interface PoPaymentTxn {
  /** 1-based sheet row number on PO Payment Transactions tab. */
  rowIndex: number;
  poNumber: string;
  type: 'Deposit' | 'Balance' | 'Shipping';
  date: string;
  /** Principal — what the recipient (RX or freight forwarder) receives. */
  amount: number;
  /** Platform fee on this transaction (Alibaba processing fee, etc.). 0 if none. */
  fee: number;
  notes: string;
  /** Optional link to a Shipment row — only populated for Shipping txs. '' if unassigned. */
  shipmentId: string;
}

/** Status enum for a Shipment. */
export type ShipmentStatus = 'Planning' | 'In Transit' | 'Received' | 'Cancelled';

/** A row on the Shipments tab — one physical shipment leaving RX. */
export interface Shipment {
  rowIndex: number;
  shipmentId: string;
  poNumber: string;
  label: string;
  mode: string;
  destination: string;
  departureDate: string;
  eta: string;
  status: ShipmentStatus | '';
  carrier: string;
  trackingNumber: string;
  receivingOrderId: string;
  estimatedCost: number;
  notes: string;
  /** Lines allocated to this shipment (joined from Shipment Lines tab). */
  lines: ShipmentLine[];
  /** Σ Shipping-type transactions linked to this shipment. */
  shippingPaidAmount: number;
  /** # of Shipping transactions linked to this shipment. */
  shippingTxnCount: number;
  /** Σ Fee on Shipping transactions linked to this shipment. */
  shippingFees: number;
}

/** One allocated line on a shipment. */
export interface ShipmentLine {
  rowIndex: number;
  shipmentId: string;
  sku: string;
  qty: number;
}

/** Derived payment status — never stored, always computed from paid dates +
 *  the rolled-up Status of the PO's line items. */
export type PaymentStatus =
  | 'Pending Deposit'
  | 'Awaiting Balance'
  | 'Paid In Full'
  | 'Cancelled';

/**
 * Per-PO summary — one entity per PO #, joining the line-item rollup with
 * the PO Payments tab. Drives /pos summary view and /cashflow.
 */
export interface PoSummary {
  poNumber: string;
  /** Rolled-up PO status. If all lines Cancelled → Cancelled; else "most
   *  advanced" non-Cancelled status across lines (Received > Incoming >
   *  Draft). Mixed states stay readable in the line table below. */
  status: string;
  supplier: string;
  /** Most-common Mode across lines, or '' if mixed/blank. */
  mode: string;
  orderDate: string;
  /** Earliest non-blank ETA across lines (ETAs may differ on multi-leg POs). */
  eta: string;
  lineCount: number;
  totalUnits: number;
  /** sum(line.qty × line.unitCost) across all lines. */
  totalCost: number;
  // Payment fields — present whether or not a PO Payments row exists yet.
  depositPct: number;
  depositAmount: number;
  balanceAmount: number;
  depositDueDate: string;
  /** Latest Deposit transaction date, or '' if none. */
  depositPaidDate: string;
  /** Σ Deposit-type transaction Amount for this PO. */
  depositPaidAmount: number;
  balanceDueDate: string;
  /** Latest Balance transaction date, or '' if none. */
  balancePaidDate: string;
  /** Σ Balance-type transaction Amount. */
  balancePaidAmount: number;
  /** Remaining unpaid (max(expected − paid, 0)) — drives Cashflow. */
  depositRemaining: number;
  balanceRemaining: number;
  // Shipping (no plan amount in v1 — actuals only)
  /** Σ Shipping-type transaction Amount. */
  shippingPaidAmount: number;
  /** Latest Shipping transaction date, or '' if none. */
  shippingPaidDate: string;
  // Fees (Alibaba platform fees, etc.) — rolled up for landed-cost accuracy
  depositFees: number;
  balanceFees: number;
  shippingFees: number;
  /** Σ Fee across all transactions of any type. */
  totalFees: number;
  /** True landed cost = PO Total (product) + shipping paid + total fees. */
  landedCost: number;
  paymentStatus: PaymentStatus;
  paymentNotes: string;
  /** True when there's no row in the PO Payments tab yet — UI uses this to
   *  surface a "set defaults" affordance on first edit. */
  paymentRowExists: boolean;
  /** All transactions for this PO, sorted by date (earliest first). */
  transactions: PoPaymentTxn[];
  /** All shipments for this PO, sorted by Shipment ID (creation order). */
  shipments: Shipment[];
  /** The PO's line items (SKU + qty + supplier/dest/mode/etc) — used by the
   *  shipment allocation editor so it knows what's available to ship. */
  lineRows: PoRow[];
  /** SKU → ordering metadata for the shipment allocation editor.
   *  When destination = ShipBob WI, the editor sorts SKUs by style → color →
   *  sizeOrder (matches the Apparel dashboard ordering). When = AWD Storage,
   *  alphabetical by SKU. Plain object (not Map) so it serializes cleanly
   *  across the server→client boundary. */
  skuMeta: Record<string, {
    style: string;
    color: string;
    line: string;
    lineOrder: number;
    size: string;
    sizeOrder: number;
  }>;
}

/** A single PO line as stored on the POs tab. */
export interface PoRow {
  /** 1-based sheet row number; header is row 1, first data row is 2.
   *  Used as the address for in-place edits. */
  rowIndex: number;
  poNumber: string;
  status: string;        // Draft | Incoming | Received | Cancelled
  supplier: string;
  mode: string;          // Air | Sea | (blank for transfers)
  orderDate: string;
  eta: string;
  sku: string;
  qty: number;
  unitCost: number;
  receivedDate: string;
  notes: string;
  type: string;          // Supplier PO | Internal Transfer | (blank → Supplier PO)
  source: string;
  dest: string;
}

// ---- Helpers ----------------------------------------------------------------

function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

// ---- Tab readers ------------------------------------------------------------

export async function readSkuMaster(): Promise<SkuMasterRow[]> {
  const grid = await readTab('SKU Master');
  if (grid.length < 2) return [];
  return grid.slice(1).map((r): SkuMasterRow => ({
    sku:                str(r[0]),
    parent:             str(r[1]),
    style:              str(r[2]),
    color:              str(r[3]),
    size:               str(r[4]),
    sizeOrder:          num(r[5]),
    category:           str(r[6]),
    productTitle:       str(r[7]),
    fbaSku:             str(r[11]),
    shipbobInventoryId: str(r[14]),
    unitCost:           num(r[16]),
    active:             str(r[17]).toUpperCase() !== 'N',
    shipbobCasePackId:  str(r[18]),
  })).filter((r) => r.sku);
}

export async function readShipbobFeed(): Promise<Map<string, ShipbobFeedRow>> {
  const grid = await readTab('Shipbob Feed');
  const out = new Map<string, ShipbobFeedRow>();
  if (grid.length < 2) return out;
  for (const r of grid.slice(1)) {
    const id = str(r[0]);
    if (!id) continue;
    out.set(id, {
      inventoryId:   id,
      inventoryName: str(r[1]),
      totalOnHand:   num(r[2]),
      twinLakesWi:   num(r[3]),
      unitsPerCase:  num(r[4]),
      merchantSku:   str(r[5]),
    });
  }
  return out;
}

export async function readAmazonFeed(): Promise<Map<string, AmazonFeedRow>> {
  const grid = await readTab('Amazon Feed');
  const out = new Map<string, AmazonFeedRow>();
  if (grid.length < 2) return out;
  for (const r of grid.slice(1)) {
    const fbaSku = str(r[0]);
    if (!fbaSku) continue;
    out.set(fbaSku, {
      fbaSku,
      afnFulfillable:       num(r[10]),
      afnReserved:          num(r[12]),
      afnInboundWorking:    num(r[15]),
      afnInboundShipped:    num(r[16]),
      afnInboundReceiving:  num(r[17]),
      awdStorage:           num(r[18]),
      awdToFbaTransit:      num(r[19]),
    });
  }
  return out;
}

// Re-export the line-order helpers so server code can still pull them from
// here. Client components must import from './line-order' directly to avoid
// dragging googleapis into the browser bundle.
export { LINE_ORDER, lineOrderIndex } from './line-order';

/**
 * Style → Line mapping from the Style_Templates tab. Used by Apparel to
 * insert banner rows between lines (HIKERS / Upfitter / Deluxe / etc.) —
 * mirrors the banner behavior in 02_dashboard.gs.
 *
 * Schema: A=Style, B=Barcode Title Template, C=Line, D=Notes, E=Supplier
 * (Supplier is a HIKERS Inventory web-app addition; if you haven't added
 * column E to Style_Templates yet, all styles default to RX Suspenders.)
 */
export async function readStyleLines(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let grid: string[][];
  try {
    grid = await readTab('Style_Templates');
  } catch {
    return out;
  }
  if (grid.length < 2) return out;
  for (const r of grid.slice(1)) {
    const style = str(r[0]);
    const line  = str(r[2]);
    if (style && line) out.set(style, line);
  }
  return out;
}

/**
 * Vendor block for a supplier — used to populate the Vendor section on the
 * PO PDF. Stored in a `Suppliers` tab on the sheet so Melissa can edit
 * vendor details without code changes.
 *
 * Schema (cols A..G):
 *   A Supplier (must match the Supplier value in Style_Templates col E)
 *   B Company Name (full legal name as it should appear on the PO)
 *   C Attn (contact person to address — e.g. "Juliet")
 *   D Address (English; multiple lines OK with `\n` or comma separators)
 *   E Chinese Address (optional)
 *   F Contact Name (e.g. "Juliet")
 *   G Contact Phone (e.g. "+86-13822246647")
 */
export interface SupplierRecord {
  supplier: string;
  companyName: string;
  attn: string;
  addressEn: string;
  addressZh: string;
  contactName: string;
  contactPhone: string;
}

export async function readSuppliers(): Promise<Map<string, SupplierRecord>> {
  const out = new Map<string, SupplierRecord>();
  let grid: string[][];
  try {
    grid = await readTab('Suppliers');
  } catch {
    return out; // Tab may not exist yet; PDF falls back to hardcoded defaults.
  }
  if (grid.length < 2) return out;
  for (const r of grid.slice(1)) {
    const supplier = str(r[0]);
    if (!supplier) continue;
    out.set(supplier, {
      supplier,
      companyName:  str(r[1]),
      attn:         str(r[2]),
      addressEn:    str(r[3]),
      addressZh:    str(r[4]),
      contactName:  str(r[5]),
      contactPhone: str(r[6]),
    });
  }
  return out;
}

/**
 * Style → Supplier mapping from Style_Templates (col E). When a style has
 * no supplier set, the push-to-POs flow uses the default 'RX Suspenders'.
 *
 * Reading separately (rather than returning a combined struct) keeps the
 * Line-only callers from caring about supplier, and makes the Supplier
 * column optional — adding/removing column E doesn't break Line lookups.
 */
export async function readStyleSuppliers(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let grid: string[][];
  try {
    grid = await readTab('Style_Templates');
  } catch {
    return out;
  }
  if (grid.length < 2) return out;
  for (const r of grid.slice(1)) {
    const style    = str(r[0]);
    const supplier = str(r[4]); // col E
    if (style && supplier) out.set(style, supplier);
  }
  return out;
}

export async function readVelocity(): Promise<Map<string, VelocityRow>> {
  const grid = await readTab('Velocity');
  const out = new Map<string, VelocityRow>();
  if (grid.length < 2) return out;
  for (const r of grid.slice(1)) {
    const sku = str(r[2]);                 // col C
    if (!sku) continue;
    out.set(sku, { sku, avgPerDay30d: num(r[7]) }); // col H
  }
  return out;
}

/**
 * Full Velocity tab — every column we display in the /velocity browser.
 * Schema:
 *   A Style    D Units 7d    G Avg/Day 7d   J Last Sync   M Stockout % 30d
 *   B Color    E Units 30d   H Avg/Day 30d  K Trend       N Avg/Day 30d (observed)
 *   C SKU      F Units 90d   I Avg/Day 90d  L In-Stock Days 30d
 */
export async function readVelocityFull(): Promise<VelocityFull[]> {
  const grid = await readTab('Velocity');
  if (grid.length < 2) return [];
  return grid.slice(1).map((r): VelocityFull => ({
    style:                str(r[0]),
    color:                str(r[1]),
    sku:                  str(r[2]),
    units7d:              num(r[3]),
    units30d:             num(r[4]),
    units90d:             num(r[5]),
    avgPerDay7d:          num(r[6]),
    avgPerDay30d:         num(r[7]),
    avgPerDay90d:         num(r[8]),
    lastSync:             str(r[9]),
    trend:                str(r[10]),
    inStockDays30d:       num(r[11]),
    stockoutPct30d:       num(r[12]),
    avgPerDay30dObserved: num(r[13]),
  })).filter((r) => r.sku);
}

/**
 * Per-source last-synced timestamps for the freshness indicator on the
 * dashboards. Each value is the raw cell content from row 2 of the
 * corresponding feed (Apps Script writes a Date there, which Sheets
 * serializes as an ISO-ish string we can pass straight to the client).
 */
export interface SyncFreshness {
  shipbob: string | null;
  amazon: string | null;
  velocity: string | null;
}

/**
 * Read the "Last Synced" timestamp from each feed. Each feed is fully
 * rewritten in one shot by its sync job, so all rows carry the same
 * timestamp — we just read row 2 (the first data row) of each tab.
 *
 * Robust to schema drift: locates the timestamp column by header name
 * rather than fixed index, since Shipbob Feed has a dynamic column
 * count that depends on how many fulfillment centers report data.
 */
export async function readSyncFreshness(): Promise<SyncFreshness> {
  const findTimestamp = async (tabName: string, headerNeedles: string[]): Promise<string | null> => {
    try {
      const grid = await readTab(tabName);
      if (grid.length < 2) return null;
      const header = (grid[0] || []).map((h) => String(h ?? '').trim().toLowerCase());
      let idx = -1;
      for (const needle of headerNeedles) {
        idx = header.findIndex((h) => h === needle.toLowerCase());
        if (idx !== -1) break;
      }
      if (idx === -1) return null;
      // Walk down looking for the first row that actually has a timestamp —
      // some tabs (Velocity) have line-banner rows interspersed with data.
      for (let i = 1; i < grid.length; i++) {
        const v = grid[i]?.[idx];
        if (v != null && String(v).trim() !== '') return String(v);
      }
      return null;
    } catch {
      // Tab missing or API error — treat as "no data", don't fail the page.
      return null;
    }
  };
  const [shipbob, amazon, velocity] = await Promise.all([
    findTimestamp('Shipbob Feed', ['Last Synced']),
    findTimestamp('Amazon Feed', ['Last Synced']),
    findTimestamp('Velocity', ['Last Sync', 'Last Synced']),
  ]);
  return { shipbob, amazon, velocity };
}

/** Lightweight summary of an existing Draft PO group, used by the
 *  "add to existing draft" picker in the dashboard's Push flow. */
export interface DraftPoSummary {
  poNumber: string;
  lineCount: number;
  totalQty: number;
  totalCost: number;
  supplier: string;       // Most-common supplier across the group
  oldestDate: string;     // earliest order date in the group, if any
}

/**
 * Group existing Draft POs by their PO# (skipping internal transfers and
 * blank PO#s). Used to populate the destination dropdown when the user is
 * pushing more drafts and wants them to land on an existing PO.
 */
export async function getDraftPoSummaries(): Promise<DraftPoSummary[]> {
  const rows = await readPos();
  const groups = new Map<string, { lines: PoRow[] }>();
  for (const r of rows) {
    if (r.status.toLowerCase() !== 'draft') continue;
    if (r.type.toLowerCase() === 'internal transfer') continue;
    if (!r.poNumber) continue; // blank PO# can't be a target
    if (!groups.has(r.poNumber)) groups.set(r.poNumber, { lines: [] });
    groups.get(r.poNumber)!.lines.push(r);
  }
  const out: DraftPoSummary[] = [];
  for (const [poNumber, { lines }] of groups) {
    const totalQty = lines.reduce((s, l) => s + l.qty, 0);
    const totalCost = lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
    // Mode the supplier across lines to pick the most common
    const supplierCounts = new Map<string, number>();
    for (const l of lines) {
      supplierCounts.set(l.supplier, (supplierCounts.get(l.supplier) ?? 0) + 1);
    }
    const supplier = [...supplierCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const orderDates = lines.map((l) => l.orderDate).filter(Boolean);
    const oldestDate = orderDates.sort()[0] ?? '';
    out.push({ poNumber, lineCount: lines.length, totalQty, totalCost, supplier, oldestDate });
  }
  // Most recent first — newest PO# usually means most recent timestamp suffix.
  out.sort((a, b) => b.poNumber.localeCompare(a.poNumber));
  return out;
}

/** Read all PO rows from the POs tab as typed records. */
export async function readPos(): Promise<PoRow[]> {
  const grid = await readTab('POs');
  if (grid.length < 2) return [];
  return grid.slice(1).map((r, idx): PoRow => ({
    rowIndex:     idx + 2,    // header is row 1; first data row is row 2
    poNumber:     str(r[0]),
    status:       str(r[1]),
    supplier:     str(r[2]),
    mode:         str(r[3]),
    orderDate:    str(r[4]),
    eta:          str(r[5]),
    sku:          str(r[6]),
    qty:          num(r[7]),
    unitCost:     num(r[8]),
    receivedDate: str(r[9]),
    notes:        str(r[10]),
    type:         str(r[11]),
    source:       str(r[12]),
    dest:         str(r[13]),
  })).filter((r) => r.sku || r.poNumber); // skip fully blank rows
}

/** Default deposit fraction when a PO has no payment record yet. */
export const DEFAULT_DEPOSIT_PCT = 0.20;

/**
 * Read the PO Payments tab (the PLAN). Tab is optional — if missing/empty,
 * returns an empty map and the summary builder falls back to defaults
 * (20% deposit, no due dates) for every PO.
 */
export async function readPoPayments(): Promise<Map<string, PoPaymentRow>> {
  const out = new Map<string, PoPaymentRow>();
  let grid: string[][];
  try {
    grid = await readTab('PO Payments');
  } catch {
    return out; // Tab not created yet
  }
  if (grid.length < 2) return out;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const poNumber = str(r[0]);
    if (!poNumber) continue;
    // Stored as 0..1 (0.20 = 20%) OR 0..100 (20 = 20%). Coerce both safely.
    let depositPct = num(r[1]);
    if (depositPct > 1) depositPct = depositPct / 100;
    // Allow exactly 1.0 (100% deposit) for paid-at-order POs like hook-only
    // accessories. Reject only values outside (0, 1] or non-finite.
    if (!(depositPct > 0 && depositPct <= 1)) depositPct = DEFAULT_DEPOSIT_PCT;
    out.set(poNumber, {
      rowIndex: i + 1,
      poNumber,
      depositPct,
      depositDueDate: str(r[2]),
      balanceDueDate: str(r[3]),
      notes:          str(r[4]),
    });
  }
  return out;
}

/**
 * Read the PO Payment Transactions tab. Returns transactions grouped by
 * PO #, sorted within each group by date (earliest first). Missing/empty
 * tab returns an empty map.
 */
export async function readPoPaymentTransactions(): Promise<Map<string, PoPaymentTxn[]>> {
  const out = new Map<string, PoPaymentTxn[]>();
  let grid: string[][];
  try {
    grid = await readTab('PO Payment Transactions');
  } catch {
    return out;
  }
  if (grid.length < 2) return out;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const poNumber = str(r[0]);
    const typeRaw  = str(r[1]);
    if (!poNumber || !typeRaw) continue;
    // Normalize type — accept any case ('deposit'/'DEPOSIT'/'Deposit').
    const tl = typeRaw.toLowerCase();
    const type: PoPaymentTxn['type'] | null =
      tl.startsWith('dep')  ? 'Deposit' :
      tl.startsWith('bal')  ? 'Balance' :
      tl.startsWith('ship') ? 'Shipping' :
      null;
    if (!type) continue;
    const tx: PoPaymentTxn = {
      rowIndex:   i + 1,
      poNumber,
      type,
      date:       str(r[2]),
      amount:     num(r[3]),
      fee:        num(r[4]),
      notes:      str(r[5]),
      shipmentId: str(r[6]),
    };
    if (!out.has(poNumber)) out.set(poNumber, []);
    out.get(poNumber)!.push(tx);
  }
  // Stable sort: earliest date first, then row index for ties.
  for (const list of out.values()) {
    list.sort((a, b) => {
      const at = Date.parse(a.date);
      const bt = Date.parse(b.date);
      const av = Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
      const bv = Number.isFinite(bt) ? bt : Number.MAX_SAFE_INTEGER;
      if (av !== bv) return av - bv;
      return a.rowIndex - b.rowIndex;
    });
  }
  return out;
}

/**
 * Read the Shipments tab. Optional — returns empty map if missing.
 * Each row maps to one Shipment record (lines populated separately).
 */
export async function readShipments(): Promise<Map<string, Shipment>> {
  const out = new Map<string, Shipment>();
  let grid: string[][];
  try {
    grid = await readTab('Shipments');
  } catch {
    return out;
  }
  if (grid.length < 2) return out;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const shipmentId = str(r[0]);
    if (!shipmentId) continue;
    const statusRaw = str(r[7]);
    const status: ShipmentStatus | '' =
      statusRaw === 'Planning'   ? 'Planning' :
      statusRaw === 'In Transit' ? 'In Transit' :
      statusRaw === 'Received'   ? 'Received' :
      statusRaw === 'Cancelled'  ? 'Cancelled' : '';
    out.set(shipmentId, {
      rowIndex: i + 1,
      shipmentId,
      poNumber:         str(r[1]),
      label:            str(r[2]),
      mode:             str(r[3]),
      destination:      str(r[4]),
      departureDate:    str(r[5]),
      eta:              str(r[6]),
      status,
      carrier:          str(r[8]),
      trackingNumber:   str(r[9]),
      receivingOrderId: str(r[10]),
      estimatedCost:    num(r[11]),
      notes:            str(r[12]),
      lines: [],
      shippingPaidAmount: 0,
      shippingTxnCount: 0,
      shippingFees: 0,
    });
  }
  return out;
}

/**
 * Read the Shipment Lines tab and return lines grouped by Shipment ID.
 * Optional — returns empty map if missing.
 */
export async function readShipmentLines(): Promise<Map<string, ShipmentLine[]>> {
  const out = new Map<string, ShipmentLine[]>();
  let grid: string[][];
  try {
    grid = await readTab('Shipment Lines');
  } catch {
    return out;
  }
  if (grid.length < 2) return out;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const shipmentId = str(r[0]);
    const sku        = str(r[1]);
    if (!shipmentId || !sku) continue;
    const line: ShipmentLine = {
      rowIndex: i + 1,
      shipmentId,
      sku,
      qty: num(r[2]),
    };
    if (!out.has(shipmentId)) out.set(shipmentId, []);
    out.get(shipmentId)!.push(line);
  }
  return out;
}

/**
 * Group PO line items by PO# and return one PoSummary per PO. Joins the
 * line-item rollup (totals, supplier, dates) with the PO Payments tab.
 *
 * Skips internal transfers — those don't represent vendor payments.
 *
 * @param scope 'all' (default) returns every PO. 'open' filters to POs with
 *   non-Cancelled lines (drives the cashflow forecast).
 */
export async function loadPoSummaries(
  scope: 'all' | 'open' = 'all',
): Promise<PoSummary[]> {
  const [lines, payments, txns, shipmentsById, shipmentLinesById, skuMaster, styleLines] = await Promise.all([
    readPos(),
    readPoPayments(),
    readPoPaymentTransactions(),
    readShipments(),
    readShipmentLines(),
    readSkuMaster(),
    readStyleLines(),
  ]);

  // Build a SKU → ordering meta map once. Used by every PoSummary so the
  // shipment allocation editor can sort by Style → Color → Size when shipping
  // to ShipBob WI (matches the Apparel dashboard ordering).
  const skuMetaAll: Record<string, {
    style: string; color: string; line: string; lineOrder: number; size: string; sizeOrder: number;
  }> = {};
  for (const m of skuMaster) {
    const line = styleLines.get(m.style) ?? '';
    skuMetaAll[m.sku] = {
      style: m.style,
      color: m.color,
      line,
      lineOrder: lineOrderIndex(line),
      size: m.size,
      sizeOrder: m.sizeOrder,
    };
  }

  // Pre-attach lines to each shipment, and pre-bucket shipments by PO #
  // so we can spread them into PoSummary cheaply.
  const shipmentsByPo = new Map<string, Shipment[]>();
  for (const s of shipmentsById.values()) {
    s.lines = shipmentLinesById.get(s.shipmentId) ?? [];
    if (!shipmentsByPo.has(s.poNumber)) shipmentsByPo.set(s.poNumber, []);
    shipmentsByPo.get(s.poNumber)!.push(s);
  }
  for (const list of shipmentsByPo.values()) {
    list.sort((a, b) => a.shipmentId.localeCompare(b.shipmentId));
  }

  interface Group {
    lines: PoRow[];
    statuses: Set<string>;
    suppliers: Map<string, number>;
    modes: Map<string, number>;
    orderDates: string[];
    etas: string[];
  }
  const groups = new Map<string, Group>();
  for (const l of lines) {
    if (!l.poNumber) continue;
    if ((l.type || '').toLowerCase() === 'internal transfer') continue;
    let g = groups.get(l.poNumber);
    if (!g) {
      g = {
        lines: [], statuses: new Set(), suppliers: new Map(), modes: new Map(),
        orderDates: [], etas: [],
      };
      groups.set(l.poNumber, g);
    }
    g.lines.push(l);
    if (l.status) g.statuses.add(l.status);
    if (l.supplier) g.suppliers.set(l.supplier, (g.suppliers.get(l.supplier) ?? 0) + 1);
    if (l.mode)     g.modes.set(l.mode,         (g.modes.get(l.mode)     ?? 0) + 1);
    if (l.orderDate) g.orderDates.push(l.orderDate);
    if (l.eta)       g.etas.push(l.eta);
  }

  // "Most advanced" status — Received > Incoming > Draft > Cancelled.
  const STATUS_RANK: Record<string, number> = { Received: 4, Incoming: 3, Draft: 2, Cancelled: 1 };
  function rollupStatus(statuses: Set<string>): string {
    if (statuses.size === 0) return '';
    // If every line is Cancelled, the PO is Cancelled.
    if (statuses.size === 1 && statuses.has('Cancelled')) return 'Cancelled';
    // Otherwise pick the most-advanced non-Cancelled state.
    let best = '';
    let bestRank = 0;
    for (const s of statuses) {
      if (s === 'Cancelled') continue;
      const r = STATUS_RANK[s] ?? 0;
      if (r > bestRank) { bestRank = r; best = s; }
    }
    return best || [...statuses][0]!;
  }

  const summaries: PoSummary[] = [];
  for (const [poNumber, g] of groups) {
    const status = rollupStatus(g.statuses);
    if (scope === 'open' && status === 'Cancelled') continue;

    // Cancelled lines should not count toward the PO's monetary total or
    // unit count — they were ordered then cancelled. Including them inflates
    // both the PO Total and the derived deposit/balance amounts (see
    // RX-24036's $80 of cancelled hooks → $16 phantom deposit overdue).
    const activeLines = g.lines.filter((l) => l.status !== 'Cancelled');
    const totalUnits = activeLines.reduce((s, l) => s + l.qty, 0);
    const totalCost  = activeLines.reduce((s, l) => s + l.qty * l.unitCost, 0);
    const supplier   = [...g.suppliers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const modeWinner = [...g.modes.entries()].sort((a, b) => b[1] - a[1])[0];
    // If multiple modes appear (split air/sea PO), leave blank rather than picking one.
    const mode = modeWinner && g.modes.size === 1 ? modeWinner[0] : '';
    const orderDate = g.orderDates.sort()[0] ?? '';
    const eta       = g.etas.sort()[0] ?? '';

    const pay = payments.get(poNumber);
    const depositPct  = pay?.depositPct ?? DEFAULT_DEPOSIT_PCT;
    const depositAmount = totalCost * depositPct;
    const balanceAmount = Math.max(totalCost - depositAmount, 0);

    // Aggregate transactions by leg. Sum amounts and fees; latest date is
    // the most recent transaction date per leg (poTxns is sorted by date
    // ascending so the LAST matching item is "latest").
    const poTxns = txns.get(poNumber) ?? [];
    let depositPaidAmount = 0,  balancePaidAmount = 0,  shippingPaidAmount = 0;
    let depositFees       = 0,  balanceFees       = 0,  shippingFees       = 0;
    let depositPaidDate   = '', balancePaidDate   = '', shippingPaidDate   = '';
    for (const t of poTxns) {
      if (t.type === 'Deposit') {
        depositPaidAmount += t.amount;
        depositFees       += t.fee;
        if (t.date) depositPaidDate = t.date;
      } else if (t.type === 'Balance') {
        balancePaidAmount += t.amount;
        balanceFees       += t.fee;
        if (t.date) balancePaidDate = t.date;
      } else if (t.type === 'Shipping') {
        shippingPaidAmount += t.amount;
        shippingFees       += t.fee;
        if (t.date) shippingPaidDate = t.date;
        // Roll the tx into its linked shipment, if any. Unassigned shipping
        // txs (legacy, or freight forwarder paid before shipment was logged)
        // still count toward PO totals but won't show on a shipment.
        if (t.shipmentId) {
          const sh = shipmentsById.get(t.shipmentId);
          if (sh) {
            sh.shippingPaidAmount += t.amount;
            sh.shippingFees       += t.fee;
            sh.shippingTxnCount   += 1;
          }
        }
      }
    }
    const totalFees = depositFees + balanceFees + shippingFees;
    const landedCost = totalCost + shippingPaidAmount + totalFees;

    const EPS = 0.005; // half-cent slop to absorb rounding noise
    const depositFullyPaid = depositPaidAmount >= depositAmount - EPS;
    const balanceFullyPaid = balancePaidAmount >= balanceAmount - EPS;
    const depositRemaining = Math.max(depositAmount - depositPaidAmount, 0);
    const balanceRemaining = Math.max(balanceAmount - balancePaidAmount, 0);

    let paymentStatus: PaymentStatus;
    if (status === 'Cancelled')             paymentStatus = 'Cancelled';
    else if (balanceFullyPaid && depositFullyPaid) paymentStatus = 'Paid In Full';
    else if (depositFullyPaid)              paymentStatus = 'Awaiting Balance';
    else                                     paymentStatus = 'Pending Deposit';

    summaries.push({
      poNumber, status, supplier, mode, orderDate, eta,
      lineCount: g.lines.length,
      totalUnits, totalCost,
      depositPct, depositAmount, balanceAmount,
      depositDueDate: pay?.depositDueDate ?? '',
      depositPaidDate, depositPaidAmount,
      balanceDueDate: pay?.balanceDueDate ?? '',
      balancePaidDate, balancePaidAmount,
      depositRemaining, balanceRemaining,
      shippingPaidAmount, shippingPaidDate,
      depositFees, balanceFees, shippingFees, totalFees,
      landedCost,
      paymentStatus,
      paymentNotes: pay?.notes ?? '',
      paymentRowExists: !!pay,
      transactions: poTxns,
      shipments: shipmentsByPo.get(poNumber) ?? [],
      lineRows: g.lines,
      // Slim the global meta map down to just the SKUs on this PO so the
      // serialized payload doesn't carry every SKU's ordering fields.
      skuMeta: (() => {
        const out: Record<string, {
          style: string; color: string; line: string; lineOrder: number; size: string; sizeOrder: number;
        }> = {};
        for (const r of g.lines) {
          if (r.sku && skuMetaAll[r.sku]) out[r.sku] = skuMetaAll[r.sku];
        }
        return out;
      })(),
    });
  }

  // Most recent first by PO# — RX-NNNNN sorts naturally.
  summaries.sort((a, b) => b.poNumber.localeCompare(a.poNumber));
  return summaries;
}

/**
 * Read the POs tab and aggregate per-SKU in-transit (Air/Sea) and draft
 * quantities. Mirrors the SUMIFS formulas in 02_dashboard.gs:
 *   In-Transit Air:  Status=Incoming AND Mode=Air AND Type<>Internal Transfer
 *   In-Transit Sea:  Status=Incoming AND Mode=Sea AND Type<>Internal Transfer
 *   Draft POs:       Status=Draft                  AND Type<>Internal Transfer
 *
 * Internal transfers are excluded so we don't double-count: those move stock
 * from one of our locations to another, they don't bring new inventory.
 */
export async function readPoAggregates(): Promise<Map<string, PoAggregates>> {
  const grid = await readTab('POs');
  const out = new Map<string, PoAggregates>();
  if (grid.length < 2) return out;

  for (const r of grid.slice(1)) {
    const status = str(r[1]).toLowerCase();
    const mode   = str(r[3]).toLowerCase();
    const sku    = str(r[6]);
    const qty    = num(r[7]);
    const type   = str(r[11]).toLowerCase();
    if (!sku || qty <= 0) continue;
    if (type === 'internal transfer') continue;

    const agg = out.get(sku) ?? { inTransitAir: 0, inTransitSea: 0, draftPo: 0, incoming: [] };
    if (status === 'incoming') {
      const eta = str(r[5]);
      // Date.parse handles ISO + most US-formatted dates; bad/blank ETAs
      // sort to the end so they don't masquerade as "next."
      const ts = eta ? Date.parse(eta) : NaN;
      agg.incoming.push({
        poNumber: str(r[0]),
        mode: str(r[3]),
        eta,
        etaTimestamp: Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER,
        qty,
      });
      if (mode === 'air') agg.inTransitAir += qty;
      else if (mode === 'sea') agg.inTransitSea += qty;
    } else if (status === 'draft') {
      agg.draftPo += qty;
    }
    out.set(sku, agg);
  }
  // Sort each SKU's incoming POs earliest first — that's the order the
  // dashboard reads them ("next ETA" = first item).
  for (const agg of out.values()) {
    agg.incoming.sort((a, b) => a.etaTimestamp - b.etaTimestamp);
  }
  return out;
}

// ---- Joined dashboard rows --------------------------------------------------

export interface ApparelDashboardRow {
  style: string;
  color: string;
  sku: string;
  size: string;
  sizeOrder: number;
  active: boolean;
  hasFbaSku: boolean;       // For policy decisions client-side
  // ShipBob WI
  indivOnHand: number;
  casePackEqv: number;
  shipbobWiTotal: number;
  // Amazon
  fbaAvailable: number;
  fbaReserved: number;
  fbaInbound: number;
  awdStorage: number;
  awdTransit: number;
  amazonTotal: number;
  // Inbound supply
  inTransitAir: number;
  inTransitSea: number;
  draftPo: number;
  /** Incoming PO list (sorted by ETA) — empty when none scheduled. */
  incoming: IncomingPoLine[];
  /** Soonest incoming ETA as raw string, or '' if no incoming. */
  nextEta: string;
  /** Total on-hand projected at the soonest ETA = totalOnHand + qty arriving by then. */
  atNextEtaTotal: number;
  // Rollup + forecasting
  totalOnHand: number;
  avgPerDay30d: number;
  daysCover: number | null;  // null when avgPerDay30d <= 0 (can't compute)
  unitCost: number;
  valueOnHand: number;
}

export interface AccessoriesDashboardRow {
  style: string;
  color: string;
  sku: string;
  active: boolean;
  hasFbaSku: boolean;
  shipbobWi: number;
  fbaAvailable: number;
  awdStorage: number;
  amazonTotal: number;
  inTransitAir: number;
  inTransitSea: number;
  /** @deprecated Kept for backward-compat with anything still reading it; equals Air+Sea. */
  inTransit: number;
  draftPo: number;
  /** Incoming PO list (sorted by ETA) — empty when none scheduled. */
  incoming: IncomingPoLine[];
  /** Soonest incoming ETA as raw string, or '' if no incoming. */
  nextEta: string;
  /** Total at next ETA (sum of POs sharing that ETA). */
  atNextEtaTotal: number;
  totalOnHand: number;
  avgPerDay30d: number;
  daysCover: number | null;
  unitCost: number;
  valueOnHand: number;
}

// ---- Joined loaders ---------------------------------------------------------

interface LoadedFeeds {
  skuMaster: SkuMasterRow[];
  shipbob: Map<string, ShipbobFeedRow>;
  amazon: Map<string, AmazonFeedRow>;
  velocity: Map<string, VelocityRow>;
  pos: Map<string, PoAggregates>;
}

/** Pull every tab in parallel — one network round-trip per tab. */
async function loadAllFeeds(): Promise<LoadedFeeds> {
  const [skuMaster, shipbob, amazon, velocity, pos] = await Promise.all([
    readSkuMaster(),
    readShipbobFeed(),
    readAmazonFeed(),
    readVelocity(),
    readPoAggregates(),
  ]);
  return { skuMaster, shipbob, amazon, velocity, pos };
}

function daysCover(totalOnHand: number, draftPo: number, avgPerDay: number): number | null {
  if (avgPerDay <= 0) return null;
  return (totalOnHand + draftPo) / avgPerDay;
}

export async function loadApparelDashboard(): Promise<ApparelDashboardRow[]> {
  const { skuMaster, shipbob, amazon, velocity, pos } = await loadAllFeeds();

  const rows: ApparelDashboardRow[] = skuMaster
    .filter((r) => r.category.toLowerCase() === 'apparel')
    .map((r) => {
      const indiv = r.shipbobInventoryId ? shipbob.get(r.shipbobInventoryId) : undefined;
      const indivOnHand = indiv ? indiv.twinLakesWi : 0;

      const casePack = r.shipbobCasePackId ? shipbob.get(r.shipbobCasePackId) : undefined;
      const casePackEqv = casePack ? casePack.twinLakesWi * casePack.unitsPerCase : 0;
      const shipbobWiTotal = indivOnHand + casePackEqv;

      const amz = r.fbaSku ? amazon.get(r.fbaSku) : undefined;
      const fbaAvailable = amz?.afnFulfillable ?? 0;
      const fbaReserved  = amz?.afnReserved ?? 0;
      const fbaInbound   = (amz?.afnInboundWorking ?? 0)
                         + (amz?.afnInboundShipped ?? 0)
                         + (amz?.afnInboundReceiving ?? 0);
      const awdStorage   = amz?.awdStorage ?? 0;
      const awdTransit   = amz?.awdToFbaTransit ?? 0;
      const amazonTotal  = fbaAvailable + fbaReserved + fbaInbound + awdStorage + awdTransit;

      const po = pos.get(r.sku);
      const inTransitAir = po?.inTransitAir ?? 0;
      const inTransitSea = po?.inTransitSea ?? 0;
      const draftPo      = po?.draftPo ?? 0;
      const incoming     = po?.incoming ?? [];

      const totalOnHand = shipbobWiTotal + amazonTotal;
      const avgPerDay30d = velocity.get(r.sku)?.avgPerDay30d ?? 0;

      // Project the on-hand at the soonest incoming ETA. Because incoming is
      // sorted by ETA, the first entry is "next" — total at that moment is
      // current totalOnHand + that single PO's qty (NOT all incoming, since
      // the rest arrive later). If POs share an ETA, sum across the same date.
      const nextEta = incoming[0]?.eta ?? '';
      const atNextEtaTotal = nextEta
        ? totalOnHand + incoming.filter((p) => p.eta === nextEta).reduce((s, p) => s + p.qty, 0)
        : totalOnHand;

      return {
        style: r.style,
        color: r.color,
        sku: r.sku,
        size: r.size,
        sizeOrder: r.sizeOrder,
        active: r.active,
        hasFbaSku: !!r.fbaSku,
        indivOnHand, casePackEqv, shipbobWiTotal,
        fbaAvailable, fbaReserved, fbaInbound,
        awdStorage, awdTransit, amazonTotal,
        inTransitAir, inTransitSea, draftPo,
        incoming, nextEta, atNextEtaTotal,
        totalOnHand,
        avgPerDay30d,
        daysCover: daysCover(totalOnHand + inTransitAir + inTransitSea, draftPo, avgPerDay30d),
        unitCost: r.unitCost,
        valueOnHand: totalOnHand * r.unitCost,
      };
    });

  rows.sort((a, b) => {
    if (a.style !== b.style) return a.style.localeCompare(b.style);
    const aInactive = a.active ? 0 : 1;
    const bInactive = b.active ? 0 : 1;
    if (aInactive !== bInactive) return aInactive - bInactive;
    if (a.color !== b.color) return a.color.localeCompare(b.color);
    return (a.sizeOrder || 99) - (b.sizeOrder || 99);
  });

  return rows;
}

export async function loadAccessoriesDashboard(): Promise<AccessoriesDashboardRow[]> {
  const { skuMaster, shipbob, amazon, velocity, pos } = await loadAllFeeds();

  const rows: AccessoriesDashboardRow[] = skuMaster
    .filter((r) => r.category.toLowerCase() === 'accessories')
    .map((r) => {
      // Accessories have no case-pack split — just the individual on-hand.
      const indiv = r.shipbobInventoryId ? shipbob.get(r.shipbobInventoryId) : undefined;
      const shipbobWi = indiv ? indiv.twinLakesWi : 0;

      const amz = r.fbaSku ? amazon.get(r.fbaSku) : undefined;
      const fbaAvailable = amz?.afnFulfillable ?? 0;
      const fbaReserved  = amz?.afnReserved ?? 0;
      const fbaInbound   = (amz?.afnInboundWorking ?? 0)
                         + (amz?.afnInboundShipped ?? 0)
                         + (amz?.afnInboundReceiving ?? 0);
      const awdStorage   = amz?.awdStorage ?? 0;
      const awdTransit   = amz?.awdToFbaTransit ?? 0;
      const amazonTotal  = fbaAvailable + fbaReserved + fbaInbound + awdStorage + awdTransit;

      const po = pos.get(r.sku);
      const inTransitAir = po?.inTransitAir ?? 0;
      const inTransitSea = po?.inTransitSea ?? 0;
      const inTransit    = inTransitAir + inTransitSea;
      const draftPo   = po?.draftPo ?? 0;
      const incoming  = po?.incoming ?? [];

      const totalOnHand = shipbobWi + amazonTotal;
      const avgPerDay30d = velocity.get(r.sku)?.avgPerDay30d ?? 0;

      const nextEta = incoming[0]?.eta ?? '';
      const atNextEtaTotal = nextEta
        ? totalOnHand + incoming.filter((p) => p.eta === nextEta).reduce((s, p) => s + p.qty, 0)
        : totalOnHand;

      return {
        style: r.style,
        color: r.color,
        sku: r.sku,
        active: r.active,
        hasFbaSku: !!r.fbaSku,
        shipbobWi,
        fbaAvailable, awdStorage, amazonTotal,
        inTransitAir, inTransitSea, inTransit, draftPo,
        incoming, nextEta, atNextEtaTotal,
        totalOnHand,
        avgPerDay30d,
        daysCover: daysCover(totalOnHand + inTransit, draftPo, avgPerDay30d),
        unitCost: r.unitCost,
        valueOnHand: totalOnHand * r.unitCost,
      };
    });

  // Same Style/Active/Color sort as Apparel; no Size dimension here.
  rows.sort((a, b) => {
    if (a.style !== b.style) return a.style.localeCompare(b.style);
    const aInactive = a.active ? 0 : 1;
    const bInactive = b.active ? 0 : 1;
    if (aInactive !== bInactive) return aInactive - bInactive;
    return a.color.localeCompare(b.color);
  });

  return rows;
}

// ---- Per-SKU detail (mobile lookup) -----------------------------------------

export interface SkuDetail {
  sku: string;
  style: string;
  color: string;
  size: string;
  category: string;
  active: boolean;
  productTitle: string;
  fbaSku: string;
  shipbobInventoryId: string;
  shipbobCasePackId: string;
  // Quantities by location
  shipbobIndiv: number;
  shipbobCasePackEqv: number;
  shipbobWiTotal: number;
  fbaAvailable: number;
  fbaReserved: number;
  fbaInbound: number;
  awdStorage: number;
  awdTransit: number;
  amazonTotal: number;
  inTransitAir: number;
  inTransitSea: number;
  draftPo: number;
  totalOnHand: number;
  avgPerDay30d: number;
  daysCover: number | null;
  unitCost: number;
}

export async function loadSkuDetail(sku: string): Promise<SkuDetail | null> {
  const target = sku.trim().toUpperCase();
  if (!target) return null;
  const { skuMaster, shipbob, amazon, velocity, pos } = await loadAllFeeds();
  const r = skuMaster.find((row) => row.sku.toUpperCase() === target);
  if (!r) return null;

  const indiv = r.shipbobInventoryId ? shipbob.get(r.shipbobInventoryId) : undefined;
  const indivOnHand = indiv ? indiv.twinLakesWi : 0;

  const casePack = r.shipbobCasePackId ? shipbob.get(r.shipbobCasePackId) : undefined;
  const casePackEqv = casePack ? casePack.twinLakesWi * casePack.unitsPerCase : 0;
  const shipbobWiTotal = indivOnHand + casePackEqv;

  const amz = r.fbaSku ? amazon.get(r.fbaSku) : undefined;
  const fbaAvailable = amz?.afnFulfillable ?? 0;
  const fbaReserved  = amz?.afnReserved ?? 0;
  const fbaInbound   = (amz?.afnInboundWorking ?? 0)
                     + (amz?.afnInboundShipped ?? 0)
                     + (amz?.afnInboundReceiving ?? 0);
  const awdStorage   = amz?.awdStorage ?? 0;
  const awdTransit   = amz?.awdToFbaTransit ?? 0;
  const amazonTotal  = fbaAvailable + fbaReserved + fbaInbound + awdStorage + awdTransit;

  const po = pos.get(r.sku);
  const inTransitAir = po?.inTransitAir ?? 0;
  const inTransitSea = po?.inTransitSea ?? 0;
  const draftPo      = po?.draftPo ?? 0;

  const totalOnHand = shipbobWiTotal + amazonTotal;
  const avgPerDay30d = velocity.get(r.sku)?.avgPerDay30d ?? 0;

  return {
    sku: r.sku,
    style: r.style, color: r.color, size: r.size,
    category: r.category, active: r.active,
    productTitle: r.productTitle,
    fbaSku: r.fbaSku,
    shipbobInventoryId: r.shipbobInventoryId,
    shipbobCasePackId: r.shipbobCasePackId,
    shipbobIndiv: indivOnHand, shipbobCasePackEqv: casePackEqv, shipbobWiTotal,
    fbaAvailable, fbaReserved, fbaInbound,
    awdStorage, awdTransit, amazonTotal,
    inTransitAir, inTransitSea, draftPo,
    totalOnHand,
    avgPerDay30d,
    daysCover: daysCover(totalOnHand + inTransitAir + inTransitSea, draftPo, avgPerDay30d),
    unitCost: r.unitCost,
  };
}

// ============================================================================
// LANDED COST
// ============================================================================
//
// Per-SKU blended landed cost computed from Received POs + their shipping
// and fee transactions. Allocation = pro-rata by line value (qty × unit_cost).
// Aggregation = weighted average across all Received POs containing this SKU.
//
// Currently includes EXW + Freight + Alibaba Fees. Duty per unit and 3PL
// inbound per unit are placeholders (always 0) until those data sources
// are ingested in a separate workstream.

/** A single Received-PO contribution to a SKU's blended landed cost. */
export interface LandedCostContribution {
  poNumber: string;
  receivedDate: string;
  qty: number;
  unitCost: number;
  lineValue: number;        // qty * unitCost
  poGoodsValue: number;     // total goods value of all non-Cancelled lines in this PO
  valueShare: number;       // lineValue / poGoodsValue, 0..1
  poShipping: number;       // sum of Type=Shipping principal for this PO
  poFees: number;           // sum of Fee across all transaction types for this PO
  freightAlloc: number;     // valueShare * poShipping
  feesAlloc: number;        // valueShare * poFees
  /** Destination of this line ('ShipBob WI', 'AWD Storage', etc.) — drives 3PL inbound allocation. */
  dest: string;
  /** 3PL inbound fee allocated to this line: qty × dest-specific rate ($0 for AWD, blended rate for ShipBob). */
  threePLAlloc: number;
}

/** Per-SKU landed cost row. */
export interface LandedCostRow {
  sku: string;
  // SKU Master metadata (joined for line/Style+Color rollup in the dashboard).
  // Empty strings if the SKU isn't in SKU Master (shouldn't happen but defensive).
  style: string;
  color: string;
  size: string;
  category: string;
  productTitle: string;
  active: boolean;
  unitsReceived: number;
  exwValue: number;          // total EXW spend across all contributing POs
  exwUnitCost: number;       // weighted avg = exwValue / unitsReceived
  freightTotal: number;
  freightPerUnit: number;
  feesTotal: number;
  feesPerUnit: number;
  dutyPerUnit: number;       // 0 — DDP wraps duty into freight
  threePLTotal: number;      // sum of 3PL inbound across contributions ($0 for AWD-destined units)
  threePLPerUnit: number;    // threePLTotal / unitsReceived
  totalLandedCost: number;   // exwUnitCost + freightPerUnit + feesPerUnit + threePLPerUnit
  poCount: number;
  lastReceived: string;
  contributions: LandedCostContribution[];
}

/** ShipBob Bills row — read from the ShipBob Bills tab in the inventory tracker. */
export interface ShipBobBillRow {
  invoiceId: string | number;
  date: string;
  category: string;          // 'Inbound' | 'Storage' | 'Outbound' | 'Additional' | 'Return' | 'Credit' | 'Payment' | 'Other'
  detail: string;
  amount: number;
  notes: string;
}

/** Read the ShipBob Bills tab. Returns [] if the tab doesn't exist (graceful). */
export async function readShipBobBills(): Promise<ShipBobBillRow[]> {
  let grid: string[][];
  try {
    grid = await readTab('ShipBob Bills');
  } catch {
    return [];
  }
  if (!grid || grid.length < 2) return [];
  const out: ShipBobBillRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || !r[0]) continue;
    out.push({
      invoiceId: r[0],
      date: str(r[1]),
      category: str(r[2]),
      detail: str(r[3]),
      amount: num(r[4]),
      notes: str(r[5]),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Amazon Bills tab — populated by 28_amazon_finances_sync.gs (SP-API
// /financialEvents). Schema written in the Apps Script. Costs Dashboard
// reads this alongside ShipBob Bills.
// ─────────────────────────────────────────────────────────────────────────

export interface AmazonBillRow {
  postedDate: string;          // 'YYYY-MM-DD'
  periodMonth: string;         // 'YYYY-MM'
  eventType: string;           // ShipmentEvent | RefundEvent | ServiceFeeEvent | AdjustmentEvent
  category: string;            // Outbound | Storage | Inbound | Additional | Sales Fees | Reserve | Other | Marketing
  feeType: string;             // raw FeeType, e.g. 'FBAPerUnitFulfillmentFee', 'Commission', etc.
  amount: number;              // signed; positive = cost we paid, negative = refund of cost
  sku: string;                 // canonical SKU (channel-suffix stripped)
  skuChannel: string;          // raw Amazon SellerSKU with -FBA suffix
  orderId: string;
  qty: number;
  notes: string;
}

/** Read the Amazon Bills tab. Returns [] if the tab doesn't exist (graceful). */
export async function readAmazonBills(): Promise<AmazonBillRow[]> {
  let grid: string[][];
  try {
    grid = await readTab('Amazon Bills');
  } catch {
    return [];
  }
  if (!grid || grid.length < 2) return [];
  const out: AmazonBillRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || !r[0]) continue;
    out.push({
      postedDate:  str(r[0]),
      periodMonth: str(r[1]),
      eventType:   str(r[2]),
      category:    str(r[3]),
      feeType:     str(r[4]),
      amount:      num(r[5]),
      sku:         str(r[6]),
      skuChannel:  str(r[7]),
      orderId:     str(r[8]),
      qty:         num(r[9]),
      notes:       str(r[10]),
    });
  }
  return out;
}


// ─────────────────────────────────────────────────────────────────────────
// Costs Dashboard — joins ShipBob Bills + Amazon Bills into a single
// warehouse × category × month matrix plus headline KPIs.
// Mirrors the Apps Script `computeCostsDashboard()` in 31_costs_dashboard.gs
// so the Sheet and the web view always agree.
// ─────────────────────────────────────────────────────────────────────────

export interface CostMatrixRow {
  warehouse: string;            // 'ShipBob WI' | 'Amazon FBA' | 'AWD'
  category: string;             // Inbound | Storage | Outbound | Additional | Sales Fees | Return | Credit
  monthValues: number[];        // one entry per month in `months`
  total: number;
}

export interface CostsDashboardData {
  kpis: {
    shipBobStorage: number;
    shipBobOutbound: number;
    shipBobInbound: number;
    amazonOutbound: number;
    amazonSalesFees: number;
  };
  months: string[];             // trailing 12, 'YYYY-MM' oldest→newest
  matrixRows: CostMatrixRow[];
  monthTotals: number[];        // grand total per month
  grandTotal: number;
  topCarryingSkus: SkuCarryingCostRow[];   // Phase 2 — top 30 by Total $/mo
}

export interface SkuCarryingCostRow {
  sku: string;
  style: string;
  color: string;
  size: string;
  shipbobUnits: number;
  fbaUnits: number;
  awdUnits: number;
  totalUnits: number;
  shipbobMonthly: number;
  fbaMonthly: number;
  awdMonthly: number;
  totalMonthly: number;
  avgPerDay: number;          // 0 if no velocity data
  monthsOfCover: number | null;  // null when avgPerDay is 0
}

export interface SaleCandidate {
  style: string;
  color: string;
  totalUnits: number;
  totalMonthly: number;             // group total carrying cost
  weightedMonthsOfCover: number | null;  // group total units / (group total daily demand × 30); null when total demand is 0
  stuckSkuCount: number;            // sizes within this parent that meet the per-SKU stuck threshold
  totalSkuCount: number;            // total sizes with on-hand
}

/**
 * Compute the Costs Dashboard from raw ShipBob Bills + Amazon Bills.
 *
 * Aggregation rules match the Apps Script implementation:
 * - ShipBob: skip Category='Payment' (settlement, not cost). Everything else
 *   uses the signed Amount as-is.
 * - Amazon: skip Category in {Reserve, Marketing, Other} (not logistics cost
 *   or future Marketing module). Sign convention: Amount is already positive=cost.
 * - Warehouse derivation:
 *     ShipBob → 'ShipBob WI'
 *     Amazon FeeType starting with 'AWD' or 'AmazonUpstream' → 'AWD'
 *     Amazon everything else → 'Amazon FBA'
 * - Window: trailing 12 calendar months ending current month.
 * - Empty (warehouse, category) combos with $0 across the full window are
 *   suppressed from the output.
 */
export async function loadCostsDashboard(): Promise<CostsDashboardData> {
  const [shipBobBills, amazonBills, carryingSkus] = await Promise.all([
    readShipBobBills(),
    readAmazonBills(),
    readCostsBySku(),
  ]);

  const months = trailing12Months();
  const monthIdx = new Map(months.map((m, i) => [m, i] as const));

  // matrix[warehouse][category][monthIdx] = amount
  const matrix = new Map<string, Map<string, number[]>>();
  function bump(wh: string, cat: string, mi: number, amt: number) {
    if (!matrix.has(wh)) matrix.set(wh, new Map());
    const cm = matrix.get(wh)!;
    if (!cm.has(cat)) cm.set(cat, new Array(months.length).fill(0));
    cm.get(cat)![mi] += amt;
  }

  // ShipBob
  for (const r of shipBobBills) {
    if (r.category === 'Payment') continue;
    if (!Number.isFinite(r.amount) || r.amount === 0) continue;
    const m = (r.date || '').slice(0, 7);
    const mi = monthIdx.get(m);
    if (mi == null) continue;
    bump('ShipBob WI', r.category, mi, r.amount);
  }

  // Amazon
  for (const r of amazonBills) {
    if (r.category === 'Reserve' || r.category === 'Marketing' || r.category === 'Other') continue;
    if (!Number.isFinite(r.amount) || r.amount === 0) continue;
    const m = r.periodMonth || (r.postedDate || '').slice(0, 7);
    const mi = monthIdx.get(m);
    if (mi == null) continue;
    const wh = /^AWD/.test(r.feeType) || /^AmazonUpstream/.test(r.feeType) ? 'AWD' : 'Amazon FBA';
    bump(wh, r.category, mi, r.amount);
  }

  // Flatten with stable ordering
  const WAREHOUSE_ORDER = ['ShipBob WI', 'Amazon FBA', 'AWD'];
  const CATEGORY_ORDER  = ['Inbound', 'Storage', 'Outbound', 'Additional', 'Sales Fees', 'Return', 'Credit'];

  const matrixRows: CostMatrixRow[] = [];
  for (const wh of WAREHOUSE_ORDER) {
    if (!matrix.has(wh)) continue;
    const cm = matrix.get(wh)!;
    const cats = Array.from(cm.keys()).sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a);
      const bi = CATEGORY_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    for (const cat of cats) {
      const vals = cm.get(cat)!;
      const total = vals.reduce((s, v) => s + v, 0);
      if (Math.abs(total) < 0.005) continue;
      matrixRows.push({ warehouse: wh, category: cat, monthValues: vals, total });
    }
  }
  // Append any unexpected warehouses (defensive)
  for (const wh of matrix.keys()) {
    if (WAREHOUSE_ORDER.includes(wh)) continue;
    const cm = matrix.get(wh)!;
    for (const [cat, vals] of cm) {
      const total = vals.reduce((s, v) => s + v, 0);
      if (Math.abs(total) < 0.005) continue;
      matrixRows.push({ warehouse: wh, category: cat, monthValues: vals, total });
    }
  }

  const monthTotals = months.map((_, i) => matrixRows.reduce((s, r) => s + r.monthValues[i], 0));
  const grandTotal = monthTotals.reduce((s, v) => s + v, 0);

  function sumCat(wh: string, cat: string): number {
    const row = matrixRows.find((r) => r.warehouse === wh && r.category === cat);
    return row ? row.total : 0;
  }

  const kpis = {
    shipBobStorage:   sumCat('ShipBob WI', 'Storage'),
    shipBobOutbound:  sumCat('ShipBob WI', 'Outbound'),
    shipBobInbound:   sumCat('ShipBob WI', 'Inbound'),
    amazonOutbound:   sumCat('Amazon FBA', 'Outbound'),
    amazonSalesFees:  sumCat('Amazon FBA', 'Sales Fees') + sumCat('AWD', 'Sales Fees'),
  };

  // Top 30 by Total $/mo — defensive re-sort in case the tab gets edited
  const topCarryingSkus = carryingSkus
    .slice()
    .sort((a, b) => b.totalMonthly - a.totalMonthly)
    .slice(0, 30);

  return { kpis, months, matrixRows, monthTotals, grandTotal, topCarryingSkus };
}

/**
 * Reads the precomputed `Costs by SKU` tab written by
 * 31_costs_dashboard.gs.computeSkuCarryingCost(). Returns rows in tab order
 * (already sorted by Total $/mo desc, but loadCostsDashboard re-sorts
 * defensively before slicing).
 *
 * Schema (15 cols): A SKU · B Style · C Color · D Size · E ShipBob WI Units ·
 * F Amazon FBA Units · G AWD Units · H Total Units · I ShipBob $/mo ·
 * J Amazon FBA $/mo · K AWD $/mo · L Total $/mo · M Avg/Day 30d ·
 * N Months of Cover · O Last Computed.
 */
export async function readCostsBySku(): Promise<SkuCarryingCostRow[]> {
  let grid: string[][];
  try {
    grid = await readTab('Costs by SKU');
  } catch {
    return [];
  }
  if (!grid || grid.length < 2) return [];
  const out: SkuCarryingCostRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || !r[0]) continue;
    const monthsOfCoverRaw = r[13];
    const monthsOfCover =
      monthsOfCoverRaw === '' || monthsOfCoverRaw == null ? null : num(monthsOfCoverRaw);
    out.push({
      sku: str(r[0]),
      style: str(r[1]),
      color: str(r[2]),
      size: str(r[3]),
      shipbobUnits: num(r[4]),
      fbaUnits: num(r[5]),
      awdUnits: num(r[6]),
      totalUnits: num(r[7]),
      shipbobMonthly: num(r[8]),
      fbaMonthly: num(r[9]),
      awdMonthly: num(r[10]),
      totalMonthly: num(r[11]),
      avgPerDay: num(r[12]),
      monthsOfCover: Number.isFinite(monthsOfCover as number) ? (monthsOfCover as number) : null,
    });
  }
  return out;
}

/**
 * Sale Candidates — Style+Color groups stuck in inventory long enough to
 * be worth running a sale on. Built by rolling up the per-SKU carrying-
 * cost data to the parent (Style+Color) level. We never recommend putting
 * a single size on sale — sales happen at the visible product level.
 *
 * Group rules:
 *   - totalUnits + totalMonthly: simple sums across the parent's sizes
 *   - weightedMonthsOfCover: groupTotalUnits / (sum of per-size daily demand × 30)
 *     i.e., "how many months will the whole color last at current sales pace"
 *   - stuckSkuCount: sizes within this parent that individually meet the
 *     per-SKU stuck threshold (≥6 mo cover, ≥$5/mo). A high count is a
 *     stronger signal than a single straggler size.
 *
 * Filter: parent-level months of cover ≥ minMoC AND group total cost ≥ minCost.
 * The group threshold defaults to $20/mo because a color is typically 4-7 sizes
 * — a $5/SKU floor would catch nearly every parent; $20/group filters to ones
 * actually worth a promo.
 */
export async function loadSaleCandidates(opts?: {
  minMonthsOfCover?: number;
  minMonthlyCost?: number;
  limit?: number;
}): Promise<SaleCandidate[]> {
  const minMoC  = opts?.minMonthsOfCover ?? 6;
  const minCost = opts?.minMonthlyCost   ?? 20;
  const limit   = opts?.limit            ?? 10;

  const rows = await readCostsBySku();
  if (!rows.length) return [];

  type Acc = {
    style: string; color: string;
    totalUnits: number; totalMonthly: number; totalDailyDemand: number;
    stuckSkuCount: number; totalSkuCount: number;
  };
  const groups = new Map<string, Acc>();

  for (const r of rows) {
    if (!r.style && !r.color) continue;
    const key = `${r.style}|${r.color}`;
    let g = groups.get(key);
    if (!g) {
      g = { style: r.style, color: r.color, totalUnits: 0, totalMonthly: 0, totalDailyDemand: 0, stuckSkuCount: 0, totalSkuCount: 0 };
      groups.set(key, g);
    }
    g.totalUnits       += r.totalUnits;
    g.totalMonthly     += r.totalMonthly;
    g.totalDailyDemand += r.avgPerDay;   // per-size daily demand sums to group demand
    g.totalSkuCount    += 1;
    if (r.monthsOfCover !== null && r.monthsOfCover >= 6 && r.totalMonthly >= 5) {
      g.stuckSkuCount += 1;
    }
  }

  const candidates: SaleCandidate[] = Array.from(groups.values())
    .map((g) => ({
      style: g.style,
      color: g.color,
      totalUnits: g.totalUnits,
      totalMonthly: Math.round(g.totalMonthly * 100) / 100,
      weightedMonthsOfCover: g.totalDailyDemand > 0
        ? g.totalUnits / (g.totalDailyDemand * 30)
        : null,
      stuckSkuCount: g.stuckSkuCount,
      totalSkuCount: g.totalSkuCount,
    }))
    .filter((c) =>
      c.weightedMonthsOfCover !== null &&
      c.weightedMonthsOfCover >= minMoC &&
      c.totalMonthly >= minCost
    )
    .sort((a, b) => b.totalMonthly - a.totalMonthly)
    .slice(0, limit);

  return candidates;
}

function trailing12Months(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
  }
  return out;
}


/**
 * Compute the blended ShipBob inbound rate per unit:
 *   total Inbound fees (across all imported bills) ÷ total units received at
 *   ShipBob WI (across all Received POs).
 *
 * If either side is empty, returns 0 (3PL inbound stays at $0 in landed cost).
 */
function computeShipBobInboundRate(bills: ShipBobBillRow[], poRows: PoRow[]): number {
  let inbound = 0;
  for (const b of bills) if (b.category === 'Inbound') inbound += b.amount;

  let units = 0;
  for (const r of poRows) {
    if (r.status !== 'Received') continue;
    if (r.dest !== 'ShipBob WI') continue;
    if ((r.type || '').toLowerCase() === 'internal transfer') continue;
    units += r.qty;
  }
  return units > 0 ? inbound / units : 0;
}

export async function loadLandedCost(): Promise<LandedCostRow[]> {
  const [poRows, txnsByPo, skuMaster, shipBobBills] = await Promise.all([
    readPos(),
    readPoPaymentTransactions(),
    readSkuMaster(),
    readShipBobBills(),
  ]);
  const skuMetaBySku = new Map(skuMaster.map((m) => [m.sku, m]));
  const shipBobInboundRate = computeShipBobInboundRate(shipBobBills, poRows);

  // Two groupings:
  //   • allLinesByPo  = ALL non-Cancelled lines (used as the allocation denominator,
  //     so partially-received POs allocate freight against the FULL PO goods value
  //     not just the received portion — otherwise per-unit freight gets wildly
  //     inflated for SKUs in POs where only an air-shipment subset has arrived).
  //   • receivedLinesByPo = only Received lines (these become the SKUs we surface
  //     in the output — we only show landed cost for inventory we actually have).
  const allLinesByPo = new Map<string, PoRow[]>();
  const receivedLinesByPo = new Map<string, PoRow[]>();
  for (const r of poRows) {
    if (!r.poNumber || !r.sku) continue;
    if (r.qty <= 0 || r.unitCost <= 0) continue;
    if ((r.type || '').toLowerCase() === 'internal transfer') continue;
    if (r.status === 'Cancelled') continue;
    if (!allLinesByPo.has(r.poNumber)) allLinesByPo.set(r.poNumber, []);
    allLinesByPo.get(r.poNumber)!.push(r);
    if (r.status === 'Received') {
      if (!receivedLinesByPo.has(r.poNumber)) receivedLinesByPo.set(r.poNumber, []);
      receivedLinesByPo.get(r.poNumber)!.push(r);
    }
  }

  // Per PO totals: shipping principal + total fees across all txn types
  function poTotals(poNumber: string): { shipping: number; fees: number } {
    const txns = txnsByPo.get(poNumber) ?? [];
    let shipping = 0, fees = 0;
    for (const t of txns) {
      if (t.type === 'Shipping') shipping += t.amount;
      fees += t.fee;
    }
    return { shipping, fees };
  }

  // Aggregate per SKU
  interface Agg {
    units: number;
    exwValue: number;
    freightAlloc: number;
    feesAlloc: number;
    threePLAlloc: number;
    poSet: Set<string>;
    lastReceived: string;
    contributions: LandedCostContribution[];
  }
  const skuAgg = new Map<string, Agg>();

  for (const [poNumber, receivedLines] of receivedLinesByPo) {
    const allLines = allLinesByPo.get(poNumber) ?? receivedLines;
    // Denominator = FULL PO goods value (Received + Incoming, ex-Cancelled).
    // Numerators = received line values. This way each received SKU picks up
    // its proportional slice of freight + fees, regardless of whether the
    // rest of the PO has arrived yet.
    const poGoodsValue = allLines.reduce((s, l) => s + l.qty * l.unitCost, 0);
    if (poGoodsValue <= 0) continue;
    const { shipping: poShipping, fees: poFees } = poTotals(poNumber);

    for (const l of receivedLines) {
      const lineValue = l.qty * l.unitCost;
      const valueShare = lineValue / poGoodsValue;
      const freightAlloc = valueShare * poShipping;
      const feesAlloc = valueShare * poFees;
      // 3PL inbound allocation: ShipBob WI uses the blended ShipBob inbound
      // rate; AWD-destined units are $0 (per Fall 2025 AWD migration); other
      // destinations also $0 by default until those data sources are wired up.
      const threePLAlloc = l.dest === 'ShipBob WI' ? l.qty * shipBobInboundRate : 0;

      let agg = skuAgg.get(l.sku);
      if (!agg) {
        agg = {
          units: 0, exwValue: 0, freightAlloc: 0, feesAlloc: 0, threePLAlloc: 0,
          poSet: new Set(), lastReceived: '', contributions: [],
        };
        skuAgg.set(l.sku, agg);
      }
      agg.units += l.qty;
      agg.exwValue += lineValue;
      agg.freightAlloc += freightAlloc;
      agg.feesAlloc += feesAlloc;
      agg.threePLAlloc += threePLAlloc;
      agg.poSet.add(poNumber);
      if (l.receivedDate && l.receivedDate > agg.lastReceived) {
        agg.lastReceived = l.receivedDate;
      }
      agg.contributions.push({
        poNumber,
        receivedDate: l.receivedDate || '',
        qty: l.qty,
        unitCost: l.unitCost,
        lineValue,
        poGoodsValue,
        valueShare,
        poShipping,
        poFees,
        freightAlloc,
        feesAlloc,
        dest: l.dest || '',
        threePLAlloc,
      });
    }
  }

  // Build output, sorted by SKU
  const out: LandedCostRow[] = [];
  for (const [sku, agg] of skuAgg) {
    const exwUnitCost = agg.exwValue / agg.units;
    const freightPerUnit = agg.freightAlloc / agg.units;
    const feesPerUnit = agg.feesAlloc / agg.units;
    const dutyPerUnit = 0;  // DDP — duty is wrapped into freight already
    const threePLPerUnit = agg.threePLAlloc / agg.units;
    const totalLandedCost = exwUnitCost + freightPerUnit + feesPerUnit + dutyPerUnit + threePLPerUnit;
    // Sort contributions by date desc so the latest PO shows first when expanded
    agg.contributions.sort((a, b) => (b.receivedDate || '').localeCompare(a.receivedDate || ''));
    const meta = skuMetaBySku.get(sku);
    out.push({
      sku,
      style: meta?.style ?? '',
      color: meta?.color ?? '',
      size: meta?.size ?? '',
      category: meta?.category ?? '',
      productTitle: meta?.productTitle ?? '',
      active: meta?.active ?? false,
      unitsReceived: agg.units,
      exwValue: agg.exwValue,
      exwUnitCost,
      freightTotal: agg.freightAlloc,
      freightPerUnit,
      feesTotal: agg.feesAlloc,
      feesPerUnit,
      dutyPerUnit,
      threePLTotal: agg.threePLAlloc,
      threePLPerUnit,
      totalLandedCost,
      poCount: agg.poSet.size,
      lastReceived: agg.lastReceived,
      contributions: agg.contributions,
    });
  }
  out.sort((a, b) => a.sku.localeCompare(b.sku));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// CS Dashboard — combines Gorgias tickets + CS Satisfaction + Judge.me
// reviews + Amazon Returns into one customer-experience view.
//
// Source tabs:
//   • CS Tickets       (40_gorgias_sync.gs)
//   • CS Satisfaction  (40_gorgias_sync.gs)
//   • Reviews          (41_judgeme_sync.gs) — published + moderated
//   • Amazon Returns   (42_amazon_returns.gs)
//
// Important context (project_review_moderation_policy.md):
// Melissa moderates sizing- and delivery-driven negative reviews into CS
// exchanges. The published Judge.me feed under-represents true sizing
// complaints. The dashboard surfaces published AND moderated rows so the
// real signal is visible.
// ─────────────────────────────────────────────────────────────────────────

const CS_DASHBOARD_TICKETS_WINDOW_DAYS = 30;
const CS_DASHBOARD_REVIEWS_WINDOW_DAYS = 90;
const CS_DASHBOARD_TOP_FRICTION_LIMIT = 25;
const CS_DASHBOARD_RECENT_REVIEWS_LIMIT = 12;
const SIZING_CURVE_MIN_UNITS_SHIPPED = 50;     // suppress noise for tiny-volume Style+Color groups

export interface CsTicketRow {
  ticketId: string;
  status: string;
  channel: string;
  via: string;
  subject: string;
  excerpt: string;
  createdAt: string;
  closedAt: string;
  customerEmail: string;
  customerName: string;
  messagesCount: number;
  tags: string[];          // split from comma-joined column
  satisfactionScore: number | null;
}

export interface CsSatisfactionRow {
  ticketId: string;
  customerEmail: string;
  scoredAt: string;
  score: number;            // 1-5
  comment: string;
}

export interface ReviewRow {
  reviewId: string;
  createdAt: string;
  rating: number;
  title: string;
  body: string;
  reviewerName: string;
  verified: string;
  source: string;
  published: boolean;
  productHandle: string;
  productTitle: string;
  hasReply: boolean;
  hidden: boolean;
}

export interface AmazonReturnRow {
  sku: string;
  skuChannel: string;
  style: string;
  color: string;
  size: string;
  category: string;
  productTitle: string;
  unitsShipped: number;
  returnUnits: number;
  returnRate: number;       // 0..1
  returnEvents: number;
  handlingFee: number;
  returnPostage: number;
  reversal: number;
  netReturnCost: number;
  costPerUnitShipped: number;
}

export interface SizingHeatmapRow {
  styleColor: string;       // "Style · Color"
  style: string;
  color: string;
  cells: { size: string; rate: number; units: number }[];   // one per size with data
  totalUnits: number;
  totalReturns: number;
  totalReturnRate: number;
}

export interface CsDashboardData {
  generatedAt: string;
  kpis: {
    ticketVolume30d: number;
    openTickets: number;
    avgCsat90d: number | null;
    csatResponseCount90d: number;
    amazonReturnRate90d: number;
    netReturnCost90d: number;
    avgReviewRating90d: number | null;
    pctReviews4PlusStar90d: number | null;
    moderatedReviewCount90d: number;
  };
  topFrictionSkus: AmazonReturnRow[];                     // top N by return units
  sizingHeatmap: SizingHeatmapRow[];                      // Style+Color rows × size cells
  sizes: string[];                                        // ordered union of sizes appearing in heatmap
  recentLowOrModeratedReviews: ReviewRow[];               // newest first
  ticketTagMix: { tag: string; count: number }[];         // top 10 tags in window
  ticketChannelMix: { channel: string; count: number }[]; // breakdown
}

/** Read the CS Tickets tab. Returns [] if the tab doesn't exist (graceful). */
export async function readCsTickets(): Promise<CsTicketRow[]> {
  let grid: string[][];
  try {
    grid = await readTab('CS Tickets');
  } catch {
    return [];
  }
  if (!grid || grid.length < 2) return [];
  const out: CsTicketRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || !r[0]) continue;
    const tagsCell = str(r[17]);
    const tags = tagsCell ? tagsCell.split(',').map((t) => t.trim()).filter(Boolean) : [];
    const sat = r[18];
    out.push({
      ticketId: str(r[0]),
      status: str(r[2]),
      channel: str(r[3]),
      via: str(r[4]),
      subject: str(r[5]),
      excerpt: str(r[6]),
      createdAt: str(r[7]),
      closedAt: str(r[10]),
      customerEmail: str(r[13]),
      customerName: str(r[14]),
      messagesCount: num(r[16]),
      tags,
      satisfactionScore: sat === '' || sat == null ? null : num(sat),
    });
  }
  return out;
}

/** Read the CS Satisfaction tab. */
export async function readCsSatisfaction(): Promise<CsSatisfactionRow[]> {
  let grid: string[][];
  try {
    grid = await readTab('CS Satisfaction');
  } catch {
    return [];
  }
  if (!grid || grid.length < 2) return [];
  const out: CsSatisfactionRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || !r[0]) continue;
    out.push({
      ticketId: str(r[1]),
      customerEmail: str(r[2]),
      scoredAt: str(r[4]),
      score: num(r[5]),
      comment: str(r[6]),
    });
  }
  return out.filter((s) => s.score > 0);
}

/** Read the Reviews tab (Judge.me, includes published + moderated). */
export async function readReviews(): Promise<ReviewRow[]> {
  let grid: string[][];
  try {
    grid = await readTab('Reviews');
  } catch {
    return [];
  }
  if (!grid || grid.length < 2) return [];
  const out: ReviewRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || !r[0]) continue;
    out.push({
      reviewId: str(r[0]),
      createdAt: str(r[1]),
      rating: num(r[3]),
      title: str(r[4]),
      body: str(r[5]),
      reviewerName: str(r[6]),
      verified: str(r[8]),
      source: str(r[9]),
      published: parseBool(r[10], true),       // default true if blank — back-compat with rows from before Published column existed
      productHandle: str(r[12]),
      productTitle: str(r[13]),
      hasReply: parseBool(r[16], false),
      hidden: parseBool(r[20], false),
    });
  }
  return out;
}

/** Read the Amazon Returns tab. */
export async function readAmazonReturns(): Promise<AmazonReturnRow[]> {
  let grid: string[][];
  try {
    grid = await readTab('Amazon Returns');
  } catch {
    return [];
  }
  if (!grid || grid.length < 2) return [];
  const out: AmazonReturnRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || !r[0]) continue;
    out.push({
      sku: str(r[0]),
      skuChannel: str(r[1]),
      style: str(r[2]),
      color: str(r[3]),
      size: str(r[4]),
      category: str(r[5]),
      productTitle: str(r[6]),
      unitsShipped: num(r[8]),
      returnUnits: num(r[9]),
      returnRate: num(r[10]),
      returnEvents: num(r[11]),
      handlingFee: num(r[12]),
      returnPostage: num(r[13]),
      reversal: num(r[14]),
      netReturnCost: num(r[15]),
      costPerUnitShipped: num(r[16]),
    });
  }
  return out;
}

function parseBool(v: unknown, fallback: boolean): boolean {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
}

/**
 * Compute the CS Dashboard. Pulls all four source tabs in parallel and
 * derives KPIs + the four visualization datasets. Pure read — no writes
 * back to the workbook.
 */
export async function loadCsDashboard(): Promise<CsDashboardData> {
  const [tickets, satisfaction, reviews, amazonReturns] = await Promise.all([
    readCsTickets(),
    readCsSatisfaction(),
    readReviews(),
    readAmazonReturns(),
  ]);

  const now = Date.now();
  const dayMs = 86_400_000;
  const ticketWindowStart = now - CS_DASHBOARD_TICKETS_WINDOW_DAYS * dayMs;
  const reviewWindowStart = now - CS_DASHBOARD_REVIEWS_WINDOW_DAYS * dayMs;

  // ─── Ticket KPIs ───
  const ticketsInWindow = tickets.filter((t) => {
    const ms = Date.parse(t.createdAt);
    return !isNaN(ms) && ms >= ticketWindowStart;
  });
  const openTickets = tickets.filter((t) => t.status === 'open').length;

  // ─── CSAT KPI (90d) ───
  const csatInWindow = satisfaction.filter((s) => {
    const ms = Date.parse(s.scoredAt);
    return !isNaN(ms) && ms >= reviewWindowStart;
  });
  const avgCsat90d = csatInWindow.length > 0
    ? csatInWindow.reduce((sum, s) => sum + s.score, 0) / csatInWindow.length
    : null;

  // ─── Amazon return KPI (90d, blended across all SKUs) ───
  const totalUnitsShipped = amazonReturns.reduce((s, r) => s + r.unitsShipped, 0);
  const totalReturnUnits = amazonReturns.reduce((s, r) => s + r.returnUnits, 0);
  const amazonReturnRate90d = totalUnitsShipped > 0 ? totalReturnUnits / totalUnitsShipped : 0;
  const netReturnCost90d = amazonReturns.reduce((s, r) => s + r.netReturnCost, 0);

  // ─── Review KPIs (90d) ───
  const reviewsInWindow = reviews.filter((rv) => {
    const ms = Date.parse(rv.createdAt);
    return !isNaN(ms) && ms >= reviewWindowStart;
  });
  const publishedInWindow = reviewsInWindow.filter((rv) => rv.published);
  const moderatedInWindow = reviewsInWindow.filter((rv) => !rv.published);
  const avgReviewRating90d = publishedInWindow.length > 0
    ? publishedInWindow.reduce((s, r) => s + r.rating, 0) / publishedInWindow.length
    : null;
  const fourPlusStar = publishedInWindow.filter((r) => r.rating >= 4).length;
  const pctReviews4PlusStar90d = publishedInWindow.length > 0
    ? fourPlusStar / publishedInWindow.length
    : null;

  // ─── Top friction SKUs ───
  const topFrictionSkus = [...amazonReturns]
    .sort((a, b) => b.returnUnits - a.returnUnits)
    .slice(0, CS_DASHBOARD_TOP_FRICTION_LIMIT);

  // ─── Sizing curve heatmap ───
  // Group by Style+Color, pivot Size as cells. Suppress groups with too
  // little volume (would be noise — a single return looks like 100% rate
  // on a SKU that shipped one unit).
  const sizingGroups = new Map<string, AmazonReturnRow[]>();
  for (const r of amazonReturns) {
    if (!r.style || !r.color || !r.size) continue;
    const key = `${r.style}|${r.color}`;
    if (!sizingGroups.has(key)) sizingGroups.set(key, []);
    sizingGroups.get(key)!.push(r);
  }
  const sizesUniverse = new Set<string>();
  const sizingHeatmap: SizingHeatmapRow[] = [];
  for (const [key, rows] of sizingGroups) {
    const totalUnits = rows.reduce((s, r) => s + r.unitsShipped, 0);
    if (totalUnits < SIZING_CURVE_MIN_UNITS_SHIPPED) continue;
    const totalReturns = rows.reduce((s, r) => s + r.returnUnits, 0);
    const cells = rows
      .filter((r) => r.unitsShipped > 0)
      .map((r) => {
        sizesUniverse.add(r.size);
        return { size: r.size, rate: r.returnRate, units: r.unitsShipped };
      });
    const [style, color] = key.split('|');
    sizingHeatmap.push({
      styleColor: `${style} · ${color}`,
      style,
      color,
      cells,
      totalUnits,
      totalReturns,
      totalReturnRate: totalUnits > 0 ? totalReturns / totalUnits : 0,
    });
  }
  // Sort heatmap rows: highest blended return rate first (most-troubled at top)
  sizingHeatmap.sort((a, b) => b.totalReturnRate - a.totalReturnRate);

  // Order sizes naturally: XS, S, M, L, XL, 2X-5X (and OSFA at end as fallback)
  const sizeOrder: Record<string, number> = {
    'XS': 1, 'S': 2, 'M': 3, 'L': 4, 'XL': 5, '2X': 6, '3X': 7, '4X': 8, '5X': 9, 'OSFA': 99,
  };
  const sizes = [...sizesUniverse].sort((a, b) => {
    const oa = sizeOrder[a] ?? 50;
    const ob = sizeOrder[b] ?? 50;
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b);
  });

  // ─── Recent low-rating + moderated reviews ───
  // Show newest first; include both published 1-2★ and ALL moderated rows
  // (regardless of rating — moderation reason matters more than star count).
  const recentLowOrModeratedReviews = [...reviewsInWindow]
    .filter((r) => !r.published || r.rating <= 2)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, CS_DASHBOARD_RECENT_REVIEWS_LIMIT);

  // ─── Ticket tag mix (top 10) ───
  const tagCounts = new Map<string, number>();
  for (const t of ticketsInWindow) {
    for (const tag of t.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const ticketTagMix = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // ─── Ticket channel mix ───
  const channelCounts = new Map<string, number>();
  for (const t of ticketsInWindow) {
    const ch = t.channel || '(unknown)';
    channelCounts.set(ch, (channelCounts.get(ch) ?? 0) + 1);
  }
  const ticketChannelMix = [...channelCounts.entries()]
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count);

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      ticketVolume30d: ticketsInWindow.length,
      openTickets,
      avgCsat90d,
      csatResponseCount90d: csatInWindow.length,
      amazonReturnRate90d,
      netReturnCost90d,
      avgReviewRating90d,
      pctReviews4PlusStar90d,
      moderatedReviewCount90d: moderatedInWindow.length,
    },
    topFrictionSkus,
    sizingHeatmap,
    sizes,
    recentLowOrModeratedReviews,
    ticketTagMix,
    ticketChannelMix,
  };
}
