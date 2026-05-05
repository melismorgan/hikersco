import { readFile } from 'fs/promises';
import { join } from 'path';
import { readPos, readSkuMaster, readSuppliers, readStyleSuppliers, type SupplierRecord } from './inventory';
import type { PoPdfData, PoPdfLine, SizeCol } from './po-pdf';
import { SIZE_COLS } from './po-pdf';

/**
 * HIKERS Co. constants embedded in every PO PDF. Address updated 2026-05-05
 * (was Kawaihae, now Aoloa St., Kamuela). Update here when company info changes.
 */
const HIKERS_HEADER = {
  addressLines: [
    'HIKERS CO LLC',
    '64-721 Aoloa St., Kamuela HI 96743',
  ],
};

/**
 * Read the logo PNG from /public/hikers-logo.png and return it as a base64
 * data URL. React-PDF's Image component can render base64 strings inline,
 * which avoids the renderer trying to fetch a relative URL it can't reach.
 *
 * Returns undefined if the file isn't present — the PDF then falls back to
 * the text wordmark ("HIKERS CO.") so the doc still renders cleanly.
 */
async function loadLogoDataUrl(): Promise<string | undefined> {
  const candidates = ['hikers-logo.png', 'hikers-logo.jpg', 'hikers-logo.jpeg'];
  for (const name of candidates) {
    try {
      const path = join(process.cwd(), 'public', name);
      const buf = await readFile(path);
      const mime = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

const STANDARD_COMMENTS = [
  'Cost includes all materials except plastic hooks. Includes packaging and bar code.',
  '20% deposit, shipping cost before shipment, and full balance 60 days after shipment',
];

/**
 * Fallback vendor block used when the Suppliers tab is missing or has no
 * entry for the requested supplier. The Suppliers tab reader is preferred
 * — see readSuppliers() — but this keeps the PDF rendering instead of
 * erroring out if the sheet isn't set up yet.
 */
const FALLBACK_VENDORS: Record<string, PoPdfData['vendor']> = {
  'RX Suspenders': {
    name: 'Guangzhou City Rui Xin Leather Co., Ltd',
    attn: 'Juliet',
    addressEn: ['No. 14, Nanhe 2nd Street, Shiling Town, Huadu District, Guangzhou, China'],
    addressZh: '广州市花都区狮岭镇南方工业园南合二街14号 瑞信皮具',
    contactName: 'Juliet',
    contactPhone: '+86-13822246647',
  },
};

const DEFAULT_VENDOR: PoPdfData['vendor'] = {
  name: 'Vendor',
  addressEn: ['(Add a Suppliers tab to the sheet to populate vendor info)'],
};

/**
 * Strip size and color from a SKU Master Product Title so it reads as the
 * family name only — matching how RX's worksheet shows products like
 * "HIKERS BUTTON FLY SUSPENDERS" without the size or color.
 *
 * Title patterns we need to handle (observed in HIKERS data):
 *   "HIKERS® Button Fly Suspenders - Black - M"           → "HIKERS® Button Fly Suspenders"
 *   "Upfitter® Belt Loop Suspenders - Deluxe - Brown - L" → "Upfitter® Belt Loop Suspenders - Deluxe"
 *   "Upfitter® Belt Loop Suspenders - White/Light Gray - S" → "Upfitter® Belt Loop Suspenders"
 *   "L Upfitter® Belt Loop Suspenders"                    → "Upfitter® Belt Loop Suspenders"
 *
 * Strategy: strip trailing " - SIZE" and trailing " - COLOR" alternately,
 * up to a few iterations, since size and color can appear in either order
 * at the end. Also strip a leading size token defensively.
 */
const SIZE_TOKEN = '(XS|S|M|L|XL|2X|3X|4X|5X|OSFA)';

function cleanProductTitle(rawTitle: string, color: string): string {
  if (!rawTitle) return '';
  let cleaned = rawTitle.trim();
  const escapedColor = color
    ? color.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')
    : '';

  // Run a few passes — size and color can appear in either order at the tail.
  for (let i = 0; i < 4; i++) {
    const before = cleaned;
    // Strip trailing " - SIZE" (the most common terminal pattern)
    cleaned = cleaned.replace(new RegExp(`\\s*-\\s*${SIZE_TOKEN}\\s*$`, 'i'), '');
    // Strip trailing bare " SIZE" (fallback for non-dashed titles)
    cleaned = cleaned.replace(new RegExp(`\\s+${SIZE_TOKEN}\\s*$`, 'i'), '');
    // Strip trailing " - COLOR"
    if (escapedColor) {
      cleaned = cleaned.replace(new RegExp(`\\s*-\\s*${escapedColor}\\s*$`, 'i'), '');
    }
    if (cleaned === before) break;  // nothing more to strip
  }

  // Defensive: strip a leading size token if the title started with one.
  cleaned = cleaned.replace(new RegExp(`^${SIZE_TOKEN}\\s+`, 'i'), '');

  return cleaned.trim();
}

/** Pull a HIKERS size code out of the tail of a SKU. Same logic used elsewhere. */
function sizeFromSku(sku: string): SizeCol {
  const tail = (sku.split('-').pop() || '').toUpperCase();
  return (SIZE_COLS as readonly string[]).includes(tail) ? (tail as SizeCol) : 'OSFA';
}

/** Format a date string from the sheet as MM/DD/YY. Falls back to today if unparseable. */
function fmtDate(raw: string): string {
  const ts = Date.parse(raw);
  const d = Number.isFinite(ts) ? new Date(ts) : new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const y = String(d.getFullYear()).slice(2);
  return `${m}/${day}/${y}`;
}

/**
 * Build the PoPdfData payload for a single PO #. Pulls all lines for that
 * PO from the POs tab, joins to SKU Master for product/colorway/size,
 * pivots sizes into per-row maps, and rolls up totals.
 *
 * Returns null if no rows match the PO #.
 */
export async function buildPoPdfData(poNumber: string): Promise<PoPdfData | null> {
  const [allPos, skuMaster, suppliers, styleSuppliers, logoDataUrl] = await Promise.all([
    readPos(),
    readSkuMaster(),
    readSuppliers(),
    readStyleSuppliers(),
    loadLogoDataUrl(),
  ]);
  const poLines = allPos.filter((p) => p.poNumber.trim().toUpperCase() === poNumber.trim().toUpperCase());
  if (poLines.length === 0) return null;

  // SKU lookup for product names + colorway resolution
  const skuMap = new Map(skuMaster.map((s) => [s.sku, s] as const));

  // Group by Style+Color so each row on the PDF represents a unique colorway,
  // with per-size qtys filled in from individual SKUs of that family. The
  // PO row in the sheet already represents one SKU (one size), so we build
  // a Map keyed by `{style}::{color}` and accumulate qty into the size slot.
  const familyMap = new Map<string, PoPdfLine>();

  for (const po of poLines) {
    const sku = skuMap.get(po.sku);
    if (!sku) {
      // Unknown SKU — emit a single OSFA row so it isn't lost from the PDF.
      const key = `unknown::${po.sku}`;
      const existing = familyMap.get(key);
      if (existing) {
        existing.qtyBySize.OSFA = (existing.qtyBySize.OSFA ?? 0) + po.qty;
        existing.totalQty += po.qty;
        existing.lineTotal += po.qty * po.unitCost;
      } else {
        familyMap.set(key, {
          product: '(SKU not in master)',
          styleCode: po.sku,
          colorway: '',
          qtyBySize: { OSFA: po.qty },
          totalQty: po.qty,
          unitPrice: po.unitCost,
          lineTotal: po.qty * po.unitCost,
        });
      }
      continue;
    }
    const key = `${sku.style}::${sku.color}`;
    const sizeCol = sizeFromSku(po.sku);
    if (familyMap.has(key)) {
      const f = familyMap.get(key)!;
      f.qtyBySize[sizeCol] = (f.qtyBySize[sizeCol] ?? 0) + po.qty;
      f.totalQty += po.qty;
      f.lineTotal += po.qty * po.unitCost;
      // Unit price across sizes within a colorway is constant in HIKERS' world,
      // but if it ever differs (e.g., bigger sizes priced higher), keep the
      // first-seen as the row's display value — note in v2 we'd flag mismatches.
    } else {
      familyMap.set(key, {
        product: cleanProductTitle(sku.productTitle, sku.color) || sku.style,
        styleCode: po.sku,  // Show the size's full SKU so RX has the exact code
        colorway: sku.color,
        qtyBySize: { [sizeCol]: po.qty },
        totalQty: po.qty,
        unitPrice: po.unitCost,
        lineTotal: po.qty * po.unitCost,
      });
    }
  }

  const lines = Array.from(familyMap.values());

  // For the displayed style code on multi-size families, show just the parent
  // (Style-Color) without the size suffix — RX's PO worksheet does this.
  for (const line of lines) {
    const parts = line.styleCode.split('-');
    const lastIsSize = (SIZE_COLS as readonly string[]).includes((parts[parts.length - 1] || '').toUpperCase());
    if (lastIsSize) line.styleCode = parts.slice(0, -1).join('-');
  }

  // Aggregate totals
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const taxRate = 0;
  const tax = 0;
  const other = 0;
  const total = subtotal + tax + other;
  const depositPct = 0.20;
  const deposit = total * depositPct;

  // Vendor resolution — POs share a supplier, but the value on the PO row
  // could be (a) our nickname like "RX Suspenders", (b) the full legal
  // name "Guangzhou City Rui Xin Leather Co., Ltd" (legacy data), or
  // (c) blank. We try every candidate we can derive against both the
  // Suppliers tab AND the bundled fallback dictionary, accepting the
  // first match.
  const candidates: string[] = [];
  const poSupplier = poLines[0]?.supplier?.trim();
  if (poSupplier) candidates.push(poSupplier);

  // Style_Templates is the canonical home for "this style is sourced from
  // X supplier" — derive from the first SKU's style as a robust fallback
  // when the PO row's column is empty or out-of-band.
  const firstSkuRow = skuMaster.find((s) => s.sku === poLines[0]?.sku);
  if (firstSkuRow) {
    const styleSupplier = styleSuppliers.get(firstSkuRow.style);
    if (styleSupplier && !candidates.includes(styleSupplier)) candidates.push(styleSupplier);
  }
  if (!candidates.includes('RX Suspenders')) candidates.push('RX Suspenders');

  const vendor: PoPdfData['vendor'] = resolveVendor(candidates, suppliers) ?? DEFAULT_VENDOR;

  // Date — use the earliest Order Date among the lines, fallback today.
  const earliestOrderDate = poLines
    .map((p) => p.orderDate)
    .filter(Boolean)
    .sort()[0] || '';

  // Notes/comments aggregate. POs with non-trivial notes (especially the
  // "<CONFIRM HOOKS DELIVERY with NINGBO" alert) surface as alertText.
  const allNotes = poLines.map((p) => p.notes).filter(Boolean);
  const distinctNotes = Array.from(new Set(allNotes));

  return {
    poNumber,
    dateIssued: fmtDate(earliestOrderDate),
    vendor,
    vendorInstructions: 'BEFORE CNY PLEASE',
    newColorwayNote: undefined,  // Future: detect from a flag
    shipToText: 'Melissa will send shipping instructions',
    lines,
    totals: {
      subtotal, taxRate, tax,
      shipping: 'TBD',
      other,
      total,
      depositPct,
      deposit,
    },
    comments: [...STANDARD_COMMENTS, ...distinctNotes],
    alertText: undefined,
    signature: {
      authorizedBy: 'Matt Morgan',
      title: 'CEO HIKERS CO LLC',
      dateSigned: fmtDate(earliestOrderDate),
    },
    hikers: { ...HIKERS_HEADER, logoUrl: logoDataUrl },
  };
}

/**
 * Walk a list of candidate supplier names (in priority order) and return
 * the first one that matches in either the Suppliers tab or the bundled
 * fallback dictionary. Lookup is case-insensitive, trim-aware, and also
 * matches against the row's Company Name (col B) — so a PO row whose
 * Supplier column contains the full legal name still resolves to the row
 * keyed by the nickname.
 */
function resolveVendor(
  candidates: string[],
  suppliers: Map<string, SupplierRecord>,
): PoPdfData['vendor'] | undefined {
  for (const candidate of candidates) {
    const fromSheet = lookupSupplierLoose(suppliers, candidate);
    if (fromSheet) return mapToVendorBlock(fromSheet);

    const fromFallback = lookupFallbackLoose(candidate);
    if (fromFallback) return fromFallback;
  }
  return undefined;
}

function mapToVendorBlock(rec: SupplierRecord): PoPdfData['vendor'] {
  return {
    name: rec.companyName || rec.supplier,
    attn: rec.attn || undefined,
    addressEn: rec.addressEn
      ? rec.addressEn.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : ['(no address)'],
    addressZh: rec.addressZh || undefined,
    contactName: rec.contactName || undefined,
    contactPhone: rec.contactPhone || undefined,
  };
}

/** Loose lookup that also matches against the row's Company Name (col B). */
function lookupSupplierLoose(
  map: Map<string, SupplierRecord>,
  key: string,
): SupplierRecord | undefined {
  const direct = map.get(key);
  if (direct) return direct;
  const target = key.trim().toLowerCase();
  for (const [k, v] of map) {
    if (k.trim().toLowerCase() === target) return v;
    if (v.companyName?.trim().toLowerCase() === target) return v;
  }
  return undefined;
}

/** Loose match against the bundled fallback dictionary, by both the key
 *  AND the company name embedded in the vendor record. */
function lookupFallbackLoose(key: string): PoPdfData['vendor'] | undefined {
  const target = key.trim().toLowerCase();
  for (const [k, v] of Object.entries(FALLBACK_VENDORS)) {
    if (k.trim().toLowerCase() === target) return v;
    if (v.name.trim().toLowerCase() === target) return v;
  }
  return undefined;
}
