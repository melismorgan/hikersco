import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { SeasonalAnalysisView } from '@/components/SeasonalAnalysisView';
import { loadSeasonalAnalysis, type SeasonalAnalysisData } from '@/lib/seasonal-analysis';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SalesPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  let data: SeasonalAnalysisData | null = null;
  let loadError: string | null = null;
  try {
    data = await loadSeasonalAnalysis();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl mb-1">Seasonal Sales Analysis</h1>
          <p className="text-sm text-charcoal/60">
            Year-over-year performance for the eleven events HIKERS actually runs (Memorial Day, BFCM, 4th of July, Labor Day,
            Anniversary, Hauliday, January Clearance, President&apos;s Day, Summer Restock, After-Holiday, Free Shipping CTA).
            Pulled from the Sales History tab, refreshed live on each load.
          </p>
        </div>
        {loadError ? (
          <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
            <p className="font-semibold text-ironclad mb-2">Couldn&rsquo;t load Seasonal Analysis.</p>
            <pre className="text-xs whitespace-pre-wrap">{loadError}</pre>
          </div>
        ) : data ? (
          <SeasonalAnalysisView data={data} />
        ) : null}
      </main>
    </>
  );
}
