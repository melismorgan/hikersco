import { Document, Page, Text, View, StyleSheet, Image, Font } from '@react-pdf/renderer';
import { BRAND } from './brand';

/**
 * Register Noto Sans SC for Chinese characters in vendor addresses.
 * Loaded from a stable GitHub raw URL; React-PDF fetches and caches the
 * font at first render, so the cost is one-time per server process.
 *
 * If GitHub raw is ever unavailable (it's been reliable but isn't an SLA'd
 * service), drop a TTF/OTF copy into `public/fonts/NotoSansSC-Regular.otf`
 * and switch the `src` below to a `fs.readFile` Buffer load.
 *
 * Wrapped in try/catch so a registration failure doesn't crash the import —
 * the PDF still renders, just with placeholder glyphs for the Chinese line.
 */
try {
  Font.register({
    family: 'NotoSansSC',
    src: 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf',
  });
} catch (err) {
  console.warn('[po-pdf] Failed to register NotoSansSC — Chinese chars may render incorrectly.', err);
}

/**
 * HIKERS Co. PO PDF — sized to match the existing PO worksheet RX expects.
 *
 * Layout (top to bottom):
 *   1. Letterhead: HIKERS wordmark + "HIKERS CO LLC" + address
 *   2. Header: Date Issued + PO# (right-aligned banner)
 *   3. Two-column band: vendor block (left) + special instructions + ship-to (right)
 *   4. Line items table — sizes-as-columns (OSFA, XS..4X), 1 row per SKU
 *   5. Totals stack: subtotal, tax, S&H, other, total, 20% deposit
 *   6. Comments / signature line
 *
 * Sizes, qty, prices come pre-joined from the server (PoPdfData below);
 * this component just lays them out. Keeping render dumb makes future
 * format tweaks cheap.
 */

// Register a serif/sans pair that approximates the worksheet's feel without
// pulling in custom font files. React-PDF ships Helvetica/Times by default;
// we use the system Helvetica so footprint stays small.

// Full HIKERS size run including 5X (H503-4 Heavy-Duty is the only style
// that carries 5X today — other styles' column will simply be blank).
export const SIZE_COLS = ['OSFA', 'XS', 'S', 'M', 'L', 'XL', '2X', '3X', '4X', '5X'] as const;
export type SizeCol = typeof SIZE_COLS[number];

/** Per-row data for one SKU line on the PO. */
export interface PoPdfLine {
  product: string;          // e.g. "HIKERS BUTTON FLY SUSPENDERS"
  styleCode: string;        // e.g. "H501-2-BK"
  colorway: string;         // e.g. "Black/Black"
  /** Map of size code → qty. Missing/0 sizes render blank. OSFA is used for non-sized SKUs. */
  qtyBySize: Partial<Record<SizeCol, number>>;
  totalQty: number;
  unitPrice: number;
  lineTotal: number;
  /** Mark this row as a "new colorway" — gets the purple-callout styling. */
  isNew?: boolean;
}

export interface PoPdfData {
  poNumber: string;
  dateIssued: string;       // formatted "MM/DD/YY"
  vendor: {
    name: string;
    attn?: string;
    addressEn: string[];    // each string = one line
    addressZh?: string;
    contactName?: string;
    contactPhone?: string;
  };
  /** Yellow callout next to the vendor block. Free text. */
  vendorInstructions?: string;
  /** Purple callout if the PO contains new colorways. */
  newColorwayNote?: string;
  shipToText?: string;
  lines: PoPdfLine[];
  totals: {
    subtotal: number;
    taxRate: number;        // 0..1
    tax: number;
    shipping?: string | number;  // could be "TBD"
    other: number;
    total: number;
    depositPct: number;     // e.g. 0.20
    deposit: number;
  };
  /** Free-text comments at the bottom (e.g., "20% deposit, full balance 60 days after shipment"). */
  comments: string[];
  /** Highlighted callout under comments (red bar in the worksheet). */
  alertText?: string;
  signature: {
    authorizedBy: string;   // "Matt Morgan"
    title: string;          // "CEO HIKERS CO LLC"
    dateSigned: string;
  };
  hikers: {
    addressLines: string[]; // e.g. ["HIKERS CO LLC", "64-721 Aoloa St., Kamuela HI 96743"]
    /** Public path to the logo PNG (e.g. "/hikers-logo.png"). Optional — falls back to text wordmark. */
    logoUrl?: string;
  };
}

const styles = StyleSheet.create({
  page: {
    padding: 24,
    fontSize: 8,
    fontFamily: 'Helvetica',
    color: BRAND.charcoal,
    backgroundColor: BRAND.warmWhite,
  },
  // ---- Letterhead ----
  letterhead: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingBottom: 8,
    borderBottom: `1pt solid ${BRAND.warmGray}`,
    marginBottom: 10,
  },
  logoBox: {
    width: 200,
    height: 64,
    justifyContent: 'center',
  },
  logoImage: { width: 200, height: 64, objectFit: 'contain' },
  logoFallback: {
    fontSize: 24,
    fontFamily: 'Helvetica-Bold',
    color: BRAND.indigo,
    letterSpacing: 2,
  },
  hikersAddress: {
    flex: 1,
    paddingLeft: 16,
    paddingBottom: 4,
    fontSize: 7,
    color: BRAND.charcoal,
  },
  hikersAddressLine: { lineHeight: 1.4 },
  poBanner: {
    width: 160,
    backgroundColor: BRAND.indigo,
    color: BRAND.warmWhite,
    padding: 6,
    fontSize: 9,
  },
  poBannerLabel: { fontSize: 7, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 },
  poBannerValue: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginTop: 2 },
  // ---- Vendor / instructions / ship-to ----
  metaRow: { flexDirection: 'row', marginBottom: 10, gap: 8 },
  metaCol: { flex: 1, padding: 8, borderRadius: 2 },
  vendorBlock: {
    backgroundColor: BRAND.warmBeige,
    border: `0.5pt solid ${BRAND.warmGray}`,
  },
  metaHeading: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: BRAND.indigo,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  vendorName: { fontFamily: 'Helvetica-Bold', fontSize: 9, marginBottom: 2 },
  vendorLine: { fontSize: 7, lineHeight: 1.5 },
  calloutYellow: {
    backgroundColor: '#FFF6CC',
    border: `0.5pt solid #E8C547`,
  },
  calloutPurple: {
    backgroundColor: '#E6D7F0',
    border: `0.5pt solid #9B6CC4`,
  },
  shipToBlock: {
    backgroundColor: BRAND.warmWhite,
    border: `0.5pt solid ${BRAND.warmGray}`,
  },
  // ---- Line items table ----
  table: { borderTop: `1pt solid ${BRAND.charcoal}`, borderLeft: `0.5pt solid ${BRAND.warmGray}` },
  tr: { flexDirection: 'row', borderBottom: `0.5pt solid ${BRAND.warmGray}` },
  th: {
    paddingVertical: 4,
    paddingHorizontal: 3,
    backgroundColor: BRAND.indigo,
    color: BRAND.warmWhite,
    fontSize: 6.5,
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    textAlign: 'center',
    borderRight: `0.5pt solid ${BRAND.warmWhite}`,
  },
  td: {
    paddingVertical: 3,
    paddingHorizontal: 3,
    fontSize: 7,
    borderRight: `0.5pt solid ${BRAND.warmGray}`,
  },
  tdProduct: { width: '22%', textAlign: 'left' },
  tdStyle: { width: '11%', textAlign: 'left', fontFamily: 'Helvetica-Bold' },
  tdColor: { width: '10%', textAlign: 'left' },
  tdSize: { flex: 1, textAlign: 'center', fontVariant: ['tabular-nums' as const] },
  tdTotalQty: { width: '6%', textAlign: 'right', fontFamily: 'Helvetica-Bold' },
  tdUnitPrice: { width: '7%', textAlign: 'right' },
  tdLineTotal: { width: '9%', textAlign: 'right', fontFamily: 'Helvetica-Bold' },
  rowNew: { backgroundColor: '#F5EDFA' },  // subtle purple wash for new colorways
  // ---- Totals stack ----
  totals: { flexDirection: 'row', marginTop: 10 },
  totalsLeft: { flex: 1, paddingRight: 16 },
  totalsRight: { width: 200 },
  totalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderBottom: `0.5pt solid ${BRAND.warmGray}`,
  },
  totalsLabel: { fontSize: 7.5, color: BRAND.charcoal },
  totalsValue: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', textAlign: 'right' },
  totalsRowGrand: {
    backgroundColor: BRAND.warmBeige,
    paddingVertical: 5,
    paddingHorizontal: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderBottom: `0.5pt solid ${BRAND.charcoal}`,
  },
  totalsRowDeposit: {
    backgroundColor: BRAND.indigo,
    paddingVertical: 5,
    paddingHorizontal: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  // ---- Comments / signature ----
  commentsBlock: {
    marginTop: 10,
    fontSize: 7,
    lineHeight: 1.5,
  },
  alertBar: {
    backgroundColor: BRAND.ironclad,
    color: BRAND.warmWhite,
    padding: 5,
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    marginVertical: 6,
  },
  signature: {
    marginTop: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTop: `0.5pt solid ${BRAND.warmGray}`,
    paddingTop: 6,
    fontSize: 7,
  },
});

/**
 * Format a Chinese address as multiple lines. If the cell contains explicit
 * newlines (Alt+Enter in the sheet), respects those. Otherwise splits on
 * whitespace — works for addresses formatted as "<street> <company>" like
 * RX's "广州市花都区...南合二街14号 瑞信皮具".
 *
 * If a future supplier needs finer-grained breaks, the user just edits the
 * Suppliers tab cell to insert newlines wherever they want the line breaks.
 */
function splitChineseAddress(raw: string): string[] {
  const trimmed = raw.trim();
  const byNewline = trimmed.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (byNewline.length > 1) return byNewline;
  return trimmed.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

function fmtCurrency(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$ -';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(3)}%`;
}

export function PoPdf({ data }: { data: PoPdfData }) {
  return (
    <Document title={`${data.poNumber} HIKERS CO`}>
      <Page size="LETTER" orientation="landscape" style={styles.page}>
        {/* Letterhead */}
        <View style={styles.letterhead}>
          <View style={styles.logoBox}>
            {data.hikers.logoUrl ? (
              /* eslint-disable-next-line jsx-a11y/alt-text */
              <Image src={data.hikers.logoUrl} style={styles.logoImage} />
            ) : (
              <Text style={styles.logoFallback}>HIKERS CO.</Text>
            )}
          </View>
          <View style={styles.hikersAddress}>
            {data.hikers.addressLines.map((line, i) => (
              <Text key={i} style={[styles.hikersAddressLine, i === 0 ? { fontFamily: 'Helvetica-Bold' } : {}]}>
                {line}
              </Text>
            ))}
          </View>
          <View style={styles.poBanner}>
            <Text style={styles.poBannerLabel}>Date Issued</Text>
            <Text style={styles.poBannerValue}>{data.dateIssued}</Text>
            <Text style={[styles.poBannerLabel, { marginTop: 6 }]}>Purchase Order #</Text>
            <Text style={styles.poBannerValue}>{data.poNumber}</Text>
          </View>
        </View>

        {/* Vendor / instructions / ship-to band */}
        <View style={styles.metaRow}>
          <View style={[styles.metaCol, styles.vendorBlock]}>
            <Text style={styles.metaHeading}>Vendor</Text>
            {data.vendor.attn && <Text style={styles.vendorLine}>Attn: {data.vendor.attn}</Text>}
            <Text style={styles.vendorName}>{data.vendor.name}</Text>
            {data.vendor.addressEn.map((line, i) => (
              <Text key={i} style={styles.vendorLine}>{line}</Text>
            ))}
            {data.vendor.addressZh && (
              <View style={{ marginTop: 4 }}>
                {splitChineseAddress(data.vendor.addressZh).map((line, i) => (
                  <Text key={i} style={[styles.vendorLine, { fontFamily: 'NotoSansSC' }]}>
                    {line}
                  </Text>
                ))}
              </View>
            )}
            {data.vendor.contactName && (
              <Text style={[styles.vendorLine, { marginTop: 2 }]}>Contact: {data.vendor.contactName}</Text>
            )}
            {data.vendor.contactPhone && (
              <Text style={styles.vendorLine}>Phone: {data.vendor.contactPhone}</Text>
            )}
          </View>

          <View style={[styles.metaCol, styles.calloutYellow]}>
            <Text style={styles.metaHeading}>Special Instructions</Text>
            <Text style={styles.vendorLine}>{data.vendorInstructions || ' '}</Text>
            {data.newColorwayNote && (
              <View style={[styles.calloutPurple, { padding: 5, marginTop: 6 }]}>
                <Text style={styles.metaHeading}>New Colorways</Text>
                <Text style={styles.vendorLine}>{data.newColorwayNote}</Text>
              </View>
            )}
          </View>

          <View style={[styles.metaCol, styles.shipToBlock]}>
            <Text style={styles.metaHeading}>Ship To</Text>
            <Text style={styles.vendorLine}>{data.shipToText || 'Melissa will send shipping instructions'}</Text>
          </View>
        </View>

        {/* Line items table */}
        <View style={styles.table}>
          <View style={styles.tr}>
            <Text style={[styles.th, styles.tdProduct, { textAlign: 'left' }]}>Product</Text>
            <Text style={[styles.th, styles.tdStyle, { textAlign: 'left' }]}>Style #</Text>
            <Text style={[styles.th, styles.tdColor, { textAlign: 'left' }]}>Colorway</Text>
            {SIZE_COLS.map((s) => (
              <Text key={s} style={[styles.th, styles.tdSize]}>{s}</Text>
            ))}
            <Text style={[styles.th, styles.tdTotalQty, { textAlign: 'right' }]}>Total Qty</Text>
            <Text style={[styles.th, styles.tdUnitPrice, { textAlign: 'right' }]}>Unit $</Text>
            <Text style={[styles.th, styles.tdLineTotal, { textAlign: 'right' }]}>Total</Text>
          </View>
          {data.lines.map((line, i) => (
            <View key={`${line.styleCode}-${i}`} style={[styles.tr, line.isNew ? styles.rowNew : {}]}>
              <Text style={[styles.td, styles.tdProduct]}>{line.product}{line.isNew ? ' — new' : ''}</Text>
              <Text style={[styles.td, styles.tdStyle]}>{line.styleCode}</Text>
              <Text style={[styles.td, styles.tdColor]}>{line.colorway}</Text>
              {SIZE_COLS.map((s) => (
                <Text key={s} style={[styles.td, styles.tdSize]}>
                  {line.qtyBySize[s] && line.qtyBySize[s]! > 0 ? line.qtyBySize[s]!.toLocaleString() : ''}
                </Text>
              ))}
              <Text style={[styles.td, styles.tdTotalQty]}>{line.totalQty.toLocaleString()}</Text>
              <Text style={[styles.td, styles.tdUnitPrice]}>{fmtCurrency(line.unitPrice)}</Text>
              <Text style={[styles.td, styles.tdLineTotal]}>{fmtCurrency(line.lineTotal)}</Text>
            </View>
          ))}
        </View>

        {/* Totals stack */}
        <View style={styles.totals}>
          <View style={styles.totalsLeft}>
            <View style={styles.commentsBlock}>
              {data.comments.map((c, i) => (
                <Text key={i} style={{ marginBottom: 2 }}>{c}</Text>
              ))}
            </View>
            {data.alertText && (
              <View style={styles.alertBar}>
                <Text>{data.alertText}</Text>
              </View>
            )}
          </View>
          <View style={styles.totalsRight}>
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>Subtotal</Text>
              <Text style={styles.totalsValue}>{fmtCurrency(data.totals.subtotal)}</Text>
            </View>
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>Tax {fmtPct(data.totals.taxRate)}</Text>
              <Text style={styles.totalsValue}>{fmtCurrency(data.totals.tax)}</Text>
            </View>
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>S & H</Text>
              <Text style={styles.totalsValue}>{typeof data.totals.shipping === 'number' ? fmtCurrency(data.totals.shipping) : (data.totals.shipping || 'TBD')}</Text>
            </View>
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>Other</Text>
              <Text style={styles.totalsValue}>{fmtCurrency(data.totals.other)}</Text>
            </View>
            <View style={styles.totalsRowGrand}>
              <Text style={[styles.totalsLabel, { fontFamily: 'Helvetica-Bold' }]}>TOTAL</Text>
              <Text style={[styles.totalsValue, { fontSize: 9 }]}>{fmtCurrency(data.totals.total)}</Text>
            </View>
            <View style={styles.totalsRowDeposit}>
              <Text style={[styles.totalsLabel, { color: BRAND.warmWhite, fontFamily: 'Helvetica-Bold' }]}>
                {Math.round(data.totals.depositPct * 100)}% Deposit
              </Text>
              <Text style={[styles.totalsValue, { color: BRAND.warmWhite, fontSize: 9 }]}>
                {fmtCurrency(data.totals.deposit)}
              </Text>
            </View>
          </View>
        </View>

        {/* Signature */}
        <View style={styles.signature}>
          <Text>Authorized by</Text>
          <Text style={{ fontFamily: 'Helvetica-Bold' }}>
            {data.signature.authorizedBy}, {data.signature.title}
          </Text>
          <Text>{data.signature.dateSigned}</Text>
        </View>
      </Page>
    </Document>
  );
}
