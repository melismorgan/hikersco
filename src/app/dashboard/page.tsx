import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { ApparelGrid } from '@/components/ApparelGrid';
import { loadApparelDashboard } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  let rows: Awaited<ReturnType<typeof loadApparelDashboard>> = [];
  let loadError: string | null = null;
  try {
    rows = await loadApparelDashboard();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  // Quick rollup for the header KPIs.
  const totalSkus = rows.length;
  const totalUnits = rows.reduce((s, r) => s + r.totalOnHand, 0);
  const totalValue = rows.reduce((s, r) => s + r.valueOnHand, 0);
  const lowStockCount = rows.filter((r) => r.totalOnHand < 50 && r.active).length;

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6 flex items-end justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-3xl mb-1">Apparel</h1>
            <p className="text-sm text-charcoal/60">
              Live read of SKU Master, Shipbob Feed, and Amazon Feed. Sorted Style → Active → Color → Size.
            </p>
          </div>
          <div className="flex gap-6 text-sm">
            <Kpi label="SKUs" value={totalSkus.toLocaleString()} />
            <Kpi label="Units on hand" value={totalUnits.toLocaleString()} />
            <Kpi label="Value on hand" value={formatCurrency(totalValue)} />
            <Kpi label="Low stock (<50)" value={String(lowStockCount)} accent={lowStockCount > 0} />
          </div>
        </div>

        {loadError ? (
          <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
            <p className="font-semibold text-ironclad mb-2">Couldn’t load the sheet.</p>
            <pre className="text-xs text-charcoal/80 whitespace-pre-wrap">{loadError}</pre>
            <p className="text-xs text-charcoal/60 mt-3">
              Common causes: the service account isn’t shared on the sheet (share the
              <code className="mx-1 px-1 bg-warm-beige rounded">GOOGLE_SERVICE_ACCOUNT_EMAIL</code>
              as Editor), or <code className="mx-1 px-1 bg-warm-beige rounded">SHEET_ID</code>
              doesn’t match the live workbook.
            </p>
          </div>
        ) : (
          <ApparelGrid rows={rows} />
        )}
      </main>
    </>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="text-right">
      <div className="text-xs uppercase tracking-wider text-charcoal/50">{label}</div>
      <div className={`font-display text-2xl ${accent ? 'text-ironclad' : ''}`}>{value}</div>
    </div>
  );
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}
