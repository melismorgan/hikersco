import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { CsView } from '@/components/CsView';
import { loadCsDashboard } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function CsPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  let data: Awaited<ReturnType<typeof loadCsDashboard>> | null = null;
  let loadError: string | null = null;
  try {
    data = await loadCsDashboard();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl mb-1">Customer</h1>
          <p className="text-sm text-charcoal/60">
            Customer-experience signal across Gorgias tickets, Judge.me reviews (published + moderated),
            CSAT surveys, and Amazon returns. Designed to surface where products and operations are
            creating friction — sizing, fulfillment, quality — so we can fix the upstream cause.
          </p>
        </div>
        {loadError ? (
          <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
            <p className="font-semibold text-ironclad mb-2">Couldn’t load CS dashboard.</p>
            <pre className="text-xs whitespace-pre-wrap">{loadError}</pre>
          </div>
        ) : data ? (
          <CsView data={data} />
        ) : null}
      </main>
    </>
  );
}
