import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { CostsView } from '@/components/CostsView';
import { loadCostsDashboard } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function CostsPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  let data: Awaited<ReturnType<typeof loadCostsDashboard>> | null = null;
  let loadError: string | null = null;
  try {
    data = await loadCostsDashboard();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl mb-1">Costs Dashboard</h1>
          <p className="text-sm text-charcoal/60">
            What we pay to store and ship — by warehouse, category, and month. Built from ShipBob Bills + Amazon Bills.
            Trailing 12 months. Sales Fees split out from logistics so the cost-per-revenue story stays apples-to-apples.
          </p>
        </div>
        {loadError ? (
          <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
            <p className="font-semibold text-ironclad mb-2">Couldn’t load costs.</p>
            <pre className="text-xs whitespace-pre-wrap">{loadError}</pre>
          </div>
        ) : data ? (
          <CostsView data={data} />
        ) : null}
      </main>
    </>
  );
}
