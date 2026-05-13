import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { SyncView } from '@/components/SyncView';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SyncPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl mb-1">Sync</h1>
          <p className="text-sm text-charcoal/60">
            Trigger an on-demand refresh of every dashboard data source. The full sequence runs ~15 minutes.
            Daily triggers fire automatically every morning between 4–9am PT — use this when you want fresher
            data sooner (or to investigate why a tile looks stale).
          </p>
        </div>
        <SyncView />
      </main>
    </>
  );
}
