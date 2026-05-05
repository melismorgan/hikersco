import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import Link from 'next/link';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';
import { loadSkuDetail } from '@/lib/inventory';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Params {
  params: Promise<{ sku: string }>;
}

export default async function SkuDetailPage({ params }: Params) {
  const { sku: rawSku } = await params;
  const sku = decodeURIComponent(rawSku);

  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;

  let detail: Awaited<ReturnType<typeof loadSkuDetail>> = null;
  let loadError: string | null = null;
  try {
    detail = await loadSkuDetail(sku);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  if (!loadError && !detail) notFound();

  return (
    <>
      <Header email={email} />
      <main className="max-w-2xl mx-auto px-4 py-6">
        <Link href="/dashboard" className="text-sm text-charcoal/60 hover:text-indigo">
          ← Back to dashboard
        </Link>

        {loadError ? (
          <div className="mt-6 rounded-lg border border-ironclad/40 bg-ironclad/5 p-6">
            <p className="font-semibold text-ironclad mb-2">Couldn’t load this SKU.</p>
            <pre className="text-xs whitespace-pre-wrap">{loadError}</pre>
          </div>
        ) : detail ? (
          <SkuCard d={detail} />
        ) : null}
      </main>
    </>
  );
}

function SkuCard({ d }: { d: NonNullable<Awaited<ReturnType<typeof loadSkuDetail>>> }) {
  return (
    <div className="mt-4 space-y-6">
      {/* Header card — identity */}
      <div className="rounded-xl bg-warm-white border border-warm-gray/40 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-charcoal/50">{d.category}{!d.active && ' · INACTIVE'}</div>
            <h1 className="font-display text-2xl mt-1 leading-tight">{d.style} {d.color}</h1>
            {d.size && <div className="text-charcoal/70">Size {d.size}</div>}
            <div className="font-mono text-xs text-charcoal/60 mt-2">{d.sku}</div>
          </div>
          <DaysCoverBadge days={d.daysCover} />
        </div>
        {d.productTitle && (
          <p className="text-sm text-charcoal/70 mt-3 italic">{d.productTitle}</p>
        )}
      </div>

      {/* Big total */}
      <div className="rounded-xl bg-indigo/5 border border-indigo/20 p-5 text-center">
        <div className="text-xs uppercase tracking-wider text-charcoal/60">Total on hand</div>
        <div className="font-display text-5xl text-indigo font-semibold tabular-nums mt-1">
          {d.totalOnHand.toLocaleString()}
        </div>
        {d.avgPerDay30d > 0 && (
          <div className="text-sm text-charcoal/60 mt-2">
            Selling {d.avgPerDay30d.toFixed(1)}/day on average
          </div>
        )}
      </div>

      {/* Location breakdown */}
      <div className="rounded-xl bg-warm-white border border-warm-gray/40 overflow-hidden">
        <div className="px-5 py-3 bg-periwinkle/15 text-xs uppercase tracking-wider text-charcoal/70">
          ShipBob — Twin Lakes, WI
        </div>
        <div className="p-5 space-y-2">
          <Row label="Individual on-hand" value={d.shipbobIndiv} />
          <Row label="Case-pack equivalent" value={d.shipbobCasePackEqv} muted />
          <RowTotal label="ShipBob total" value={d.shipbobWiTotal} />
        </div>
      </div>

      <div className="rounded-xl bg-warm-white border border-warm-gray/40 overflow-hidden">
        <div className="px-5 py-3 bg-periwinkle/15 text-xs uppercase tracking-wider text-charcoal/70">
          Amazon
        </div>
        <div className="p-5 space-y-2">
          <Row label="FBA available" value={d.fbaAvailable} />
          <Row label="FBA reserved" value={d.fbaReserved} muted />
          <Row label="FBA inbound" value={d.fbaInbound} muted />
          <Row label="AWD storage" value={d.awdStorage} />
          <Row label="AWD → FBA transit" value={d.awdTransit} muted />
          <RowTotal label="Amazon total" value={d.amazonTotal} />
        </div>
      </div>

      <div className="rounded-xl bg-warm-white border border-warm-gray/40 overflow-hidden">
        <div className="px-5 py-3 bg-periwinkle/15 text-xs uppercase tracking-wider text-charcoal/70">
          Inbound supply
        </div>
        <div className="p-5 space-y-2">
          <Row label="In-transit by air" value={d.inTransitAir} />
          <Row label="In-transit by sea" value={d.inTransitSea} />
          <Row label="Draft POs" value={d.draftPo} muted />
        </div>
      </div>

      {/* Identifiers — small print at the bottom for warehouse use */}
      <div className="rounded-xl bg-warm-beige/40 p-5 text-xs text-charcoal/60 space-y-1">
        {d.fbaSku && <div>FBA SKU: <span className="font-mono">{d.fbaSku}</span></div>}
        {d.shipbobInventoryId && <div>ShipBob ID: <span className="font-mono">{d.shipbobInventoryId}</span></div>}
        {d.shipbobCasePackId && <div>ShipBob Case Pack ID: <span className="font-mono">{d.shipbobCasePackId}</span></div>}
        {d.unitCost > 0 && <div>Unit cost: ${d.unitCost.toFixed(2)} · Value on hand: ${(d.totalOnHand * d.unitCost).toFixed(0)}</div>}
      </div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={`flex justify-between text-sm ${muted ? 'text-charcoal/60' : ''}`}>
      <span>{label}</span>
      <span className="font-mono tabular-nums">{value.toLocaleString()}</span>
    </div>
  );
}

function RowTotal({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-sm font-semibold pt-2 border-t border-warm-gray/30 mt-1">
      <span>{label}</span>
      <span className="font-mono tabular-nums">{value.toLocaleString()}</span>
    </div>
  );
}

function DaysCoverBadge({ days }: { days: number | null }) {
  if (days === null) {
    return (
      <div className="text-right">
        <div className="text-xs uppercase tracking-wider text-charcoal/40">Days cover</div>
        <div className="font-display text-2xl text-charcoal/30">—</div>
      </div>
    );
  }
  let cls = 'text-sage';
  if (days < 14) cls = 'text-ironclad';
  else if (days < 30) cls = 'text-clay';
  return (
    <div className="text-right">
      <div className="text-xs uppercase tracking-wider text-charcoal/50">Days cover</div>
      <div className={`font-display text-3xl font-semibold tabular-nums ${cls}`}>
        {days < 100 ? days.toFixed(0) : '99+'}
      </div>
    </div>
  );
}
