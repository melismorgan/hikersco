import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { LandedCostView } from '@/components/LandedCostView';
import { loadLandedCost, readStyleLines } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function LandedCostPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  let rows: Awaited<ReturnType<typeof loadLandedCost>> = [];
  let styleLineMap: Record<string, string> = {};
  let loadError: string | null = null;
  try {
    const [r, sl] = await Promise.all([loadLandedCost(), readStyleLines()]);
    rows = r;
    styleLineMap = Object.fromEntries(sl);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl mb-1">Landed Cost</h1>
          <p className="text-sm text-charcoal/60">
            Per-SKU blended landed cost, computed live from Received POs and their shipping + fees.
            Allocation is pro-rata by line value (qty × unit cost). Click any row to see the per-PO contribution detail.
          </p>
        </div>
        {loadError ? (
          <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
            <p className="font-semibold text-ironclad mb-2">Couldn’t load landed cost.</p>
            <pre className="text-xs whitespace-pre-wrap">{loadError}</pre>
          </div>
        ) : (
          <LandedCostView rows={rows} styleLineMap={styleLineMap} />
        )}
      </main>
    </>
  );
}
