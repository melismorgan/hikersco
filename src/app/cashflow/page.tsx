import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { CashflowView } from '@/components/CashflowView';
import { loadPoSummaries } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function CashflowPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  let summaries: Awaited<ReturnType<typeof loadPoSummaries>> = [];
  let loadError: string | null = null;
  try {
    summaries = await loadPoSummaries('open');
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl mb-1">Cashflow</h1>
          <p className="text-sm text-charcoal/60">
            Rolling timeline of vendor payments — deposits and balances due over the next 90 days.
            Edit dates and paid status from the <Link href="/pos" className="text-indigo hover:underline">POs page</Link>.
          </p>
        </div>
        {loadError ? (
          <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
            <p className="font-semibold text-ironclad mb-2">Couldn’t load cashflow.</p>
            <pre className="text-xs whitespace-pre-wrap">{loadError}</pre>
          </div>
        ) : (
          <CashflowView summaries={summaries} />
        )}
      </main>
    </>
  );
}
