/**
 * Typed readers for the live HIKERS workbook tabs, plus the join logic
 * that powers the Apparel dashboard.
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
 *   I Barcode Label Title
 *   J GTIN (UPC)
 *   K FBA ASIN
 *
 * Shipbob Feed (cols A..F + dynamic FC cols + Last Synced)
 *   A Inventory ID  C Total On Hand   E Units Per Case
 *   B Inv Name      D Twin Lakes (WI) F Merchant SKU
 *
 * Amazon Feed (SP-API standard; cols A..T+ used)
 *   A sku           K(11) afn-fulfillable     P(16) afn-inbound-working
 *   L FBA SKU       M(13) afn-reserved        Q(17) afn-inbound-shipped
 *                                             R(18) afn-inbound-receiving
 *                   S(19) AWD Storage         T(20) AWD → FBA Transit
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
  })).filter((r) => r.sku); // drop any blank trailing rows
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
  // Amazon Feed key is sku (col A); the SKU value matches SKU Master col L (FBA SKU).
  for (const r of grid.slice(1)) {
    const fbaSku = str(r[0]);
    if (!fbaSku) continue;
    out.set(fbaSku, {
      fbaSku,
      afnFulfillable:       num(r[10]),  // K
      afnReserved:          num(r[12]),  // M
      afnInboundWorking:    num(r[15]),  // P
      afnInboundShipped:    num(r[16]),  // Q
      afnInboundReceiving:  num(r[17]),  // R
      awdStorage:           num(r[18]),  // S
      awdToFbaTransit:      num(r[19]),  // T
    });
  }
  return out;
}

// ---- Joined dashboard row ---------------------------------------------------

export interface ApparelDashboardRow {
  style: string;
  color: string;
  sku: string;
  size: string;
  sizeOrder: number;
  active: boolean;
  // ShipBob WI
  indivOnHand: number;
  casePackEqv: number;
  shipbobWiTotal: number;
  // Amazon
  fbaAvailable: number;
  fbaReserved: number;
  fbaInbound: number;       // working + shipped + receiving
  awdStorage: number;
  awdTransit: number;
  amazonTotal: number;
  // Rollup
  totalOnHand: number;
  unitCost: number;
  valueOnHand: number;
}

/**
 * Pull all three tabs in parallel, filter to apparel SKUs, join them, and
 * return rows in the order Matt expects (Style → Active → Color → Size_Order).
 */
export async function loadApparelDashboard(): Promise<ApparelDashboardRow[]> {
  const [skuMaster, shipbob, amazon] = await Promise.all([
    readSkuMaster(),
    readShipbobFeed(),
    readAmazonFeed(),
  ]);

  const rows: ApparelDashboardRow[] = skuMaster
    .filter((r) => r.category.toLowerCase() === 'apparel')
    .map((r) => {
      // ShipBob individual on-hand: lookup by Shipbob Inventory ID
      const indiv = r.shipbobInventoryId ? shipbob.get(r.shipbobInventoryId) : undefined;
      const indivOnHand = indiv ? indiv.twinLakesWi : 0;

      // ShipBob case-pack: lookup by Shipbob Case Pack ID, then multiply
      // case count × units per case (case packs store on-hand in CASES not units).
      const casePack = r.shipbobCasePackId ? shipbob.get(r.shipbobCasePackId) : undefined;
      const casePackEqv = casePack ? casePack.twinLakesWi * casePack.unitsPerCase : 0;

      const shipbobWiTotal = indivOnHand + casePackEqv;

      // Amazon: lookup by FBA SKU
      const amz = r.fbaSku ? amazon.get(r.fbaSku) : undefined;
      const fbaAvailable = amz?.afnFulfillable ?? 0;
      const fbaReserved  = amz?.afnReserved ?? 0;
      const fbaInbound   = (amz?.afnInboundWorking ?? 0)
                         + (amz?.afnInboundShipped ?? 0)
                         + (amz?.afnInboundReceiving ?? 0);
      const awdStorage   = amz?.awdStorage ?? 0;
      const awdTransit   = amz?.awdToFbaTransit ?? 0;
      const amazonTotal  = fbaAvailable + fbaReserved + fbaInbound + awdStorage + awdTransit;

      const totalOnHand = shipbobWiTotal + amazonTotal;

      return {
        style: r.style,
        color: r.color,
        sku: r.sku,
        size: r.size,
        sizeOrder: r.sizeOrder,
        active: r.active,
        indivOnHand, casePackEqv, shipbobWiTotal,
        fbaAvailable, fbaReserved, fbaInbound,
        awdStorage, awdTransit, amazonTotal,
        totalOnHand,
        unitCost: r.unitCost,
        valueOnHand: totalOnHand * r.unitCost,
      };
    });

  // Sort: Style → Active (active first) → Color → Size_Order. Mirrors
  // the Apps Script ordering exactly so the web grid matches the sheet.
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
