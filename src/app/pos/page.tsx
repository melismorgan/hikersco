import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { PosView } from '@/components/PosView';
import { readPos } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function PosPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  let rows: Awaited<ReturnType<typeof readPos>> = [];
  let loadError: string | null = null;
  try {
    rows = await readPos();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl mb-1">Purchase orders</h1>
          <p className="text-sm text-charcoal/60">
            Live read of the POs tab. Filter by status, click "New PO" to add a row to the sheet.
          </p>
        </div>
        {loadError ? (
          <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
            <p className="font-semibold text-ironclad mb-2">Couldn’t load POs.</p>
            <pre className="text-xs whitespace-pre-wrap">{loadError}</pre>
          </div>
        ) : (
          <PosView rows={rows} />
        )}
      </main>
    </>
  );
}
