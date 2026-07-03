import { getServerSession } from 'next-auth';
import Link from 'next/link';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { LaunchLiftAnalyzerView } from '@/components/LaunchLiftAnalyzerView';
import { loadLaunchLiftAnalysis, type LaunchLiftAnalysis } from '@/lib/launch-lift-analyzer';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function LaunchesPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  let data: LaunchLiftAnalysis | null = null;
  let loadError: string | null = null;
  try {
    data = await loadLaunchLiftAnalysis();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-3xl">Launch Lift Analyzer</h1>
            <Link
              href="/sales"
              className="text-sm text-indigo hover:underline"
            >
              ← Back to Seasonal Analysis
            </Link>
          </div>
          <p className="text-sm text-charcoal/60">
            Data-derived multipliers for product announcements. Reads every campaign tagged{' '}
            <code className="text-xs bg-warm-gray/20 px-1">Campaign Type = Product Announcement</code>{' '}
            on the Campaign Event Map tab, joins to Sales History, and measures: 30-day pre-window
            velocity vs. 14-day post-window velocity on the Announced SKUs. Existing SKUs yield a lift
            multiplier; brand-new SKUs (zero pre-window sales) yield first-window absolute demand.
          </p>
        </div>
        {loadError ? (
          <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
            <p className="font-semibold text-ironclad mb-2">Couldn&rsquo;t load Launch Lift Analyzer.</p>
            <pre className="text-xs whitespace-pre-wrap">{loadError}</pre>
          </div>
        ) : data ? (
          <LaunchLiftAnalyzerView data={data} />
        ) : null}
      </main>
    </>
  );
}
