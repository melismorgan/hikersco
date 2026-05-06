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
    if (!(depositPct > 0 && depositPct < 1)) depositPct = DEFAULT_DEPOSIT_PCT;
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
  const [lines, payments, txns, shipmentsById, shipmentLinesById] = await Promise.all([
    readPos(),
    readPoPayments(),
    readPoPaymentTransactions(),
    readShipments(),
    readShipmentLines(),
  ]);

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

    const totalUnits = g.lines.reduce((s, l) => s + l.qty, 0);
    const totalCost  = g.lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
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
