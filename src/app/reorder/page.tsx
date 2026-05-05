import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { ReorderTable } from '@/components/ReorderTable';
import { loadReorderReport } from '@/lib/reorder';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface SearchParams {
  searchParams: Promise<{ target?: string }>;
}

export default async function ReorderPage({ searchParams }: SearchParams) {
  const sp = await searchParams;
  const targetDays = clampTarget(parseInt(sp.target ?? '90', 10));

  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  let report: Awaited<ReturnType<typeof loadReorderReport>> | null = null;
  let loadError: string | null = null;
  try {
    report = await loadReorderReport({ targetDays });
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl mb-1">Suggested reorder</h1>
          <p className="text-sm text-charcoal/60">
            Active SKUs sorted by urgency. 75/25 Amazon:ShipBob split, 100-unit floor, 45-day Amazon slow-mover gate.
          </p>
        </div>

        {loadError ? (
          <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
            <p className="font-semibold text-ironclad mb-2">Couldn’t load reorder data.</p>
            <pre className="text-xs whitespace-pre-wrap">{loadError}</pre>
          </div>
        ) : report ? (
          <ReorderTable report={report} initialTargetDays={targetDays} />
        ) : null}
      </main>
    </>
  );
}

function clampTarget(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 90;
  return Math.min(Math.max(Math.round(n), 30), 365);
}
