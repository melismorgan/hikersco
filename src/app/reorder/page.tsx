import { getServerSession } from 'next-auth';
import Link from 'next/link';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { ReorderTable } from '@/components/ReorderTable';
import { PoPlannerView } from '@/components/PoPlannerView';
import { loadReorderReport } from '@/lib/reorder';
import { loadPoCoveragePlan, type MultiplierMode } from '@/lib/po-planner';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface SearchParams {
  searchParams: Promise<{
    mode?: string;
    target?: string;
    landing?: string;
    nextLanding?: string;
    multiplier?: string;
    buffer?: string;
  }>;
}

export default async function ReorderPage({ searchParams }: SearchParams) {
  const sp = await searchParams;
  // Default to planning mode — the strategic PO sizing view is the one
  // Melissa lands on most often. ?mode=tactical opts into the older
  // single-target-days view (still useful for between-PO restocking
  // calls, just not the home base).
  const mode: 'tactical' | 'planning' = sp.mode === 'tactical' ? 'tactical' : 'planning';

  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  return (
    <>
      <Header email={email} />
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl mb-1">
            {mode === 'planning' ? 'PO coverage planner' : 'Suggested reorder'}
          </h1>
          <p className="text-sm text-charcoal/60">
            {mode === 'planning'
              ? "Forward-looking PO sizing — pick a landing date and the next PO landing date; the planner computes per-SKU demand using event multipliers + organic velocity, subtracts what'll be on hand + incoming, and recommends the new order. Same 75/25 split, 100-unit floor, and Amazon slow-mover gate as tactical mode."
              : 'Active SKUs sorted by urgency. 75/25 Amazon:ShipBob split, 100-unit floor, 45-day Amazon slow-mover gate.'}
          </p>
        </div>

        <ModeSwitcher mode={mode} />

        {mode === 'planning'
          ? <PlanningPane sp={sp} />
          : <TacticalPane sp={sp} />}
      </main>
    </>
  );
}

function ModeSwitcher({ mode }: { mode: 'tactical' | 'planning' }) {
  // Planning is on the left because it's the default — convention: active /
  // default tab on the left.
  return (
    <div className="mb-6 inline-flex rounded-md border border-warm-gray/40 bg-warm-white p-0.5">
      <Link
        href="/reorder"
        className={
          'px-4 py-1.5 text-sm rounded-sm transition-colors ' +
          (mode === 'planning'
            ? 'bg-indigo text-white font-medium'
            : 'text-charcoal/70 hover:bg-warm-gray/20')
        }
      >
        Planning (size the next PO)
      </Link>
      <Link
        href="/reorder?mode=tactical"
        className={
          'px-4 py-1.5 text-sm rounded-sm transition-colors ' +
          (mode === 'tactical'
            ? 'bg-indigo text-white font-medium'
            : 'text-charcoal/70 hover:bg-warm-gray/20')
        }
      >
        Tactical (restock today)
      </Link>
    </div>
  );
}

async function TacticalPane({ sp }: { sp: Awaited<SearchParams['searchParams']> }) {
  const targetDays = clampTarget(parseInt(sp.target ?? '90', 10));
  try {
    const report = await loadReorderReport({ targetDays });
    return <ReorderTable report={report} initialTargetDays={targetDays} />;
  } catch (err) {
    return (
      <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
        <p className="font-semibold text-ironclad mb-2">Couldn&rsquo;t load reorder data.</p>
        <pre className="text-xs whitespace-pre-wrap">{err instanceof Error ? err.message : String(err)}</pre>
      </div>
    );
  }
}

async function PlanningPane({ sp }: { sp: Awaited<SearchParams['searchParams']> }) {
  // Defaults: this PO lands in 12 weeks (sea-freight lead time per
  // 16_po_calendar.gs — 4-6w production + 4-6w ocean), next PO lands 16
  // weeks after that. Air freight has gotten cost-prohibitive in 2026, so
  // sea is now the conservative-but-realistic default. Override the
  // landing dates anytime via the date pickers.
  const today = ptToday();
  const defaultLanding = addDaysIso(today, 84);
  const defaultNextLanding = addDaysIso(defaultLanding, 112);
  const thisPoLandsAt = sp.landing && /^\d{4}-\d{2}-\d{2}$/.test(sp.landing)
    ? sp.landing
    : defaultLanding;
  const nextPoLandsAt = sp.nextLanding && /^\d{4}-\d{2}-\d{2}$/.test(sp.nextLanding)
    ? sp.nextLanding
    : defaultNextLanding;
  const multiplierMode: MultiplierMode = sp.multiplier === 'latest'
    ? 'latest'
    : sp.multiplier === 'avg' ? 'avg' : 'weighted';
  const buffer = clampBuffer(parseFloat(sp.buffer ?? '1.2'));

  try {
    const plan = await loadPoCoveragePlan({
      thisPoLandsAt,
      nextPoLandsAt,
      multiplierMode,
      buffer,
    });
    return <PoPlannerView plan={plan} />;
  } catch (err) {
    return (
      <div className="rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
        <p className="font-semibold text-ironclad mb-2">Couldn&rsquo;t load planning data.</p>
        <pre className="text-xs whitespace-pre-wrap">{err instanceof Error ? err.message : String(err)}</pre>
      </div>
    );
  }
}

function clampTarget(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 90;
  return Math.min(Math.max(Math.round(n), 30), 365);
}

function clampBuffer(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1.2;
  return Math.min(Math.max(n, 1.0), 1.5);
}

function ptToday(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
