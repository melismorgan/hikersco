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

/** Per-SKU aggregations off the POs tab. */
export interface PoAggregates {
  inTransitAir: number;
  inTransitSea: number;
  draftPo: number;
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

    const agg = out.get(sku) ?? { inTransitAir: 0, inTransitSea: 0, draftPo: 0 };
    if (status === 'incoming' && mode === 'air') agg.inTransitAir += qty;
    else if (status === 'incoming' && mode === 'sea') agg.inTransitSea += qty;
    else if (status === 'draft') agg.draftPo += qty;
    out.set(sku, agg);
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
  shipbobWi: number;
  fbaAvailable: number;
  awdStorage: number;
  amazonTotal: number;
  inTransit: number;        // Air + Sea combined
  draftPo: number;
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

      const totalOnHand = shipbobWiTotal + amazonTotal;
      const avgPerDay30d = velocity.get(r.sku)?.avgPerDay30d ?? 0;

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
        inTransitAir, inTransitSea, draftPo,
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
      const inTransit = (po?.inTransitAir ?? 0) + (po?.inTransitSea ?? 0);
      const draftPo   = po?.draftPo ?? 0;

      const totalOnHand = shipbobWi + amazonTotal;
      const avgPerDay30d = velocity.get(r.sku)?.avgPerDay30d ?? 0;

      return {
        style: r.style,
        color: r.color,
        sku: r.sku,
        active: r.active,
        shipbobWi,
        fbaAvailable, awdStorage, amazonTotal,
        inTransit, draftPo,
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
