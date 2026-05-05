import type { ApparelDashboardRow } from '@/lib/inventory';

interface Props {
  rows: ApparelDashboardRow[];
}

/**
 * Apparel dashboard grid.
 *
 * Editorial-minimal styling (matches the v2 spec from the workbook):
 * - Rows are pre-sorted Style → Active → Color → Size_Order.
 * - Style alternation: each Style block gets a subtle warm-beige tint vs.
 *   warm-white. Reads like a magazine, not a spreadsheet.
 * - First row of a new Style: Style name in bold indigo (anchor).
 * - First row of a new Color within a Style: Color name in indigo.
 * - Repeated Style/Color values on subsequent rows: rendered in warm-gray
 *   (the "ghost-repeat" trick — present for screen readers, visually quiet).
 * - Numeric columns use mono + tabular-nums so columns align to the digit.
 * - Days-cover/low-stock semantic colors hold for the future Days Cover col.
 */
export function ApparelGrid({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-warm-gray/60 bg-warm-beige/40 p-8 text-center">
        <p className="text-charcoal/70">
          No apparel SKUs found. Check that <code className="px-1 bg-warm-white rounded">Category</code>{' '}
          equals <code className="px-1 bg-warm-white rounded">Apparel</code> in SKU Master.
        </p>
      </div>
    );
  }

  // Walk rows once to compute style-block index (for alternating tint) and
  // the boolean flags we need for ghost-repeat / first-of emphasis. Doing
  // this in render time is fine at our scale (≤200 rows).
  const decorated = rows.map((row, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    const firstOfStyle = !prev || prev.style !== row.style;
    const firstOfColor = firstOfStyle || prev!.color !== row.color;
    return { row, firstOfStyle, firstOfColor };
  });

  // Build a styleIndex (0,1,0,1,...) so we can alternate tint per Style block.
  let styleIndex = -1;
  let lastStyle: string | null = null;
  const styleIndexes = decorated.map(({ row }) => {
    if (row.style !== lastStyle) {
      styleIndex++;
      lastStyle = row.style;
    }
    return styleIndex % 2;
  });

  return (
    <div className="rounded-lg border border-warm-gray/40 overflow-hidden bg-warm-white">
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-periwinkle/15 text-charcoal/80 text-xs uppercase tracking-wider">
              <Th className="text-left">Style</Th>
              <Th className="text-left">Color</Th>
              <Th className="text-left font-mono">SKU</Th>
              <Th className="text-left">Size</Th>
              <Th className="text-right">ShipBob WI</Th>
              <Th className="text-right text-charcoal/50" title="Individual on-hand at Twin Lakes">Indiv</Th>
              <Th className="text-right text-charcoal/50" title="Case-pack equivalent units">Case</Th>
              <Th className="text-right">FBA Avail</Th>
              <Th className="text-right">AWD</Th>
              <Th className="text-right">Amz Total</Th>
              <Th className="text-right">Total</Th>
              <Th className="text-right">$ On Hand</Th>
            </tr>
          </thead>
          <tbody>
            {decorated.map(({ row, firstOfStyle, firstOfColor }, i) => {
              const tint = styleIndexes[i] === 0 ? 'bg-warm-white' : 'bg-warm-beige/30';
              const inactive = !row.active;
              return (
                <tr
                  key={row.sku}
                  className={`${tint} border-b border-warm-gray/20 ${inactive ? 'opacity-50' : ''} hover:bg-indigo/5`}
                >
                  <Td>
                    {firstOfStyle ? (
                      <span className="font-semibold text-indigo">{row.style}</span>
                    ) : (
                      <span className="text-warm-gray">{row.style}</span>
                    )}
                  </Td>
                  <Td>
                    {firstOfColor ? (
                      <span className="font-medium text-indigo">{row.color}</span>
                    ) : (
                      <span className="text-warm-gray">{row.color}</span>
                    )}
                  </Td>
                  <Td className="font-mono text-xs">{row.sku}</Td>
                  <Td>{row.size}</Td>
                  <Td className="text-right font-mono font-semibold">
                    {fmt(row.shipbobWiTotal)}
                  </Td>
                  <Td className="text-right font-mono text-charcoal/50">{fmt(row.indivOnHand)}</Td>
                  <Td className="text-right font-mono text-charcoal/50">{fmt(row.casePackEqv)}</Td>
                  <Td className="text-right font-mono">{fmt(row.fbaAvailable)}</Td>
                  <Td className="text-right font-mono">{fmt(row.awdStorage)}</Td>
                  <Td className="text-right font-mono font-semibold">{fmt(row.amazonTotal)}</Td>
                  <Td className="text-right font-mono font-semibold">{fmt(row.totalOnHand)}</Td>
                  <Td className="text-right font-mono text-charcoal/70">
                    {row.valueOnHand > 0 ? fmtCurrency(row.valueOnHand) : ''}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className = '', title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <th
      className={`px-3 py-2 font-medium ${className}`}
      title={title}
      scope="col"
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-1.5 ${className}`}>{children}</td>;
}

function fmt(n: number): string {
  if (!n) return '—';
  return n.toLocaleString();
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}
