import type { SyncFreshness } from '@/lib/inventory';

/**
 * Inline freshness strip — designed to live just under the page heading on
 * any data dashboard. Renders a one-liner like:
 *   "Last sync: ShipBob 4h ago · Amazon 4h ago · Velocity 4h ago"
 * Anything older than 36h shows the timestamp in clay (warning) instead of
 * sage (fresh) so a stuck trigger is obvious at a glance.
 *
 * Server component — accepts the SyncFreshness object directly so each
 * page can fetch it alongside its own data without re-querying.
 */
export function SyncStatus({ freshness }: { freshness: SyncFreshness }) {
  const items: { label: string; raw: string | null }[] = [
    { label: 'ShipBob', raw: freshness.shipbob },
    { label: 'Amazon', raw: freshness.amazon },
    { label: 'Velocity', raw: freshness.velocity },
  ];
  return (
    <div className="text-xs text-charcoal/60 mt-1 flex items-center gap-2 flex-wrap">
      <span className="text-charcoal/45">Last sync:</span>
      {items.map((it, i) => (
        <span key={it.label} className="flex items-center gap-2">
          {i > 0 && <span className="text-charcoal/25">·</span>}
          <span className="font-medium text-charcoal/55">{it.label}</span>
          <FreshnessChip raw={it.raw} />
        </span>
      ))}
    </div>
  );
}

function FreshnessChip({ raw }: { raw: string | null }) {
  if (!raw) {
    return <span className="text-warm-gray italic">never</span>;
  }
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) {
    return <span className="text-warm-gray italic">unknown</span>;
  }
  const ageMs = Date.now() - parsed.getTime();
  const ageHr = ageMs / 3_600_000;
  const stale = ageHr > 36;
  return (
    <span
      title={parsed.toLocaleString()}
      className={stale ? 'text-clay font-medium' : 'text-sage'}
    >
      {formatAge(ageMs)}
    </span>
  );
}

/** "4m ago", "3h ago", "2d ago" — same shape Shopify/Linear use. */
function formatAge(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
