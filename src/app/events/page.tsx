import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { EventsView } from '@/components/EventsView';
import { readEvents } from '@/lib/events';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function EventsPage() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  let events: Awaited<ReturnType<typeof readEvents>> = [];
  let loadError: string | null = null;
  try {
    events = await readEvents();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl mb-1">Events</h1>
          <p className="text-sm text-charcoal/60">
            Plan, track, and analyze launches, restocks, promos, and announcement
            emails. Events with <span className="font-mono">Exclude From Velocity Avg</span> flag
            stop launch bursts from polluting reorder math; events with{' '}
            <span className="font-mono">Expected Units</span> drive demand-spike pre-stocking
            on the Reorder dashboard.
          </p>
        </div>
        {loadError ? (
          <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
            <p className="font-semibold text-ironclad mb-2">Couldn’t load events.</p>
            <pre className="text-xs whitespace-pre-wrap">{loadError}</pre>
          </div>
        ) : (
          <EventsView events={events} />
        )}
      </main>
    </>
  );
}
