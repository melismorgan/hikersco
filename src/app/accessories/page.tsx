import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { AccessoriesGrid } from '@/components/AccessoriesGrid';
import { loadAccessoriesDashboard, readStyleLines, readStyleSuppliers, getDraftPoSummaries } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function AccessoriesPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  let rows: Awaited<ReturnType<typeof loadAccessoriesDashboard>> = [];
  let styleLineMap: Record<string, string> = {};
  let styleSupplierMap: Record<string, string> = {};
  let existingDrafts: Awaited<ReturnType<typeof getDraftPoSummaries>> = [];
  let loadError: string | null = null;
  try {
    const [r, sl, ss, ed] = await Promise.all([
      loadAccessoriesDashboard(),
      readStyleLines(),
      readStyleSuppliers(),
      getDraftPoSummaries(),
    ]);
    rows = r;
    styleLineMap = Object.fromEntries(sl);
    styleSupplierMap = Object.fromEntries(ss);
    existingDrafts = ed;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

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
            <h1 className="text-3xl mb-1">Accessories</h1>
            <p className="text-sm text-charcoal/60">
              Non-sized SKUs — Hook Packs, Rear Hooks, Wallets. Sorted by line, then Style → Color.
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
          <ErrorBox error={loadError} />
        ) : (
          <AccessoriesGrid rows={rows} styleLineMap={styleLineMap} styleSupplierMap={styleSupplierMap} existingDrafts={existingDrafts} />
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

function ErrorBox({ error }: { error: string }) {
  return (
    <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
      <p className="font-semibold text-ironclad mb-2">Couldn’t load the sheet.</p>
      <pre className="text-xs text-charcoal/80 whitespace-pre-wrap">{error}</pre>
    </div>
  );
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n);
}
