import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { VelocityGrid } from '@/components/VelocityGrid';
import { SyncStatus } from '@/components/SyncStatus';
import { readVelocityFull, readStyleLines, readSyncFreshness } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function VelocityPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  let rows: Awaited<ReturnType<typeof readVelocityFull>> = [];
  let styleLineMap: Record<string, string> = {};
  let freshness: Awaited<ReturnType<typeof readSyncFreshness>> = { shipbob: null, amazon: null, velocity: null };
  let loadError: string | null = null;
  try {
    const [r, sl, fr] = await Promise.all([readVelocityFull(), readStyleLines(), readSyncFreshness()]);
    rows = r;
    styleLineMap = Object.fromEntries(sl);
    freshness = fr;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl mb-1">Velocity</h1>
          <p className="text-sm text-charcoal/60">
            Sales velocity from your Velocity tab — Shopify + Amazon, 7d / 30d / 90d windows. Trend sparkline plots 90d → 30d → 7d.
          </p>
          <SyncStatus freshness={freshness} />
        </div>
        {loadError ? (
          <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
            <p className="font-semibold text-ironclad mb-2">Couldn’t load Velocity.</p>
            <pre className="text-xs whitespace-pre-wrap">{loadError}</pre>
          </div>
        ) : (
          <VelocityGrid rows={rows} styleLineMap={styleLineMap} />
        )}
      </main>
    </>
  );
}
