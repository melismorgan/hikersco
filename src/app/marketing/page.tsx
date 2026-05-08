import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { MarketingDashboard } from '@/components/MarketingDashboard';
import { loadSalesMarketing, type SalesMarketingData } from '@/lib/sales-marketing';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface PageProps {
  searchParams?: Promise<{ window?: string }>;
}

export default async function MarketingPage({ searchParams }: PageProps) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  // Allow ?window=1|7|30|90 to override the default. Default is 1 day
  // (= "Yesterday"), since the morning-after view is the most common
  // operator check-in pattern. Wider windows are one click away.
  const params = (await searchParams) ?? {};
  const requestedWindow = Number(params.window);
  const windowDays = [1, 7, 30, 90].includes(requestedWindow) ? requestedWindow : 1;

  let data: SalesMarketingData | null = null;
  let loadError: string | null = null;
  try {
    data = await loadSalesMarketing(windowDays);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6 flex items-end justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-3xl mb-1">Sales &amp; Marketing</h1>
            <p className="text-sm text-charcoal/60">
              Cross-channel revenue and ad performance, refreshed daily by the workbook syncs.
            </p>
          </div>
          <WindowSwitcher current={windowDays} />
        </div>

        {loadError ? (
          <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
            <p className="font-semibold text-ironclad mb-2">Couldn&rsquo;t load Sales &amp; Marketing data.</p>
            <pre className="text-xs whitespace-pre-wrap">{loadError}</pre>
          </div>
        ) : data ? (
          <MarketingDashboard data={data} />
        ) : null}
      </main>
    </>
  );
}

function WindowSwitcher({ current }: { current: number }) {
  const options: { days: number; label: string }[] = [
    { days: 1, label: 'Yesterday' },
    { days: 7, label: '7d' },
    { days: 30, label: '30d' },
    { days: 90, label: '90d' },
  ];
  return (
    <div className="flex items-center gap-1 border border-warm-gray/40 rounded-md bg-warm-white p-0.5">
      {options.map((o) => (
        <a
          key={o.days}
          href={`/marketing?window=${o.days}`}
          className={
            'px-3 py-1 text-sm rounded-sm transition-colors ' +
            (o.days === current
              ? 'bg-indigo text-white font-medium'
              : 'text-charcoal/70 hover:bg-warm-gray/20')
          }
        >
          {o.label}
        </a>
      ))}
    </div>
  );
}
