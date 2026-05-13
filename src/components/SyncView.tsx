'use client';

import { useEffect, useState } from 'react';

/**
 * /sync page client component.
 *
 *   - Big "Sync all now" button → POSTs to /api/sync/run, which forwards
 *     to the Apps Script orchestrator (fire-and-forget).
 *   - Polls /api/sync/status every 5s while pending, every 30s when idle,
 *     so the page reflects the current orchestrator state without manual
 *     refresh.
 *   - Shows the last completed run's per-handler summary: status, elapsed
 *     time, error message if any.
 *
 * Status response shape (from Apps Script doGet):
 *   { ok: true, pending: boolean, lastRun: LastRun | null }
 *
 * Run response shape (from Apps Script doPost):
 *   { ok: true, scheduledAt: string, expectedSyncs: string[], message: string }
 */

interface SyncResult {
  fn: string;
  label: string;
  status: 'ok' | 'soft-fail' | 'error' | 'missing';
  elapsedMs: number;
  error?: string;
}

interface LastRun {
  finishedAt: string;
  durationSec: number;
  okCount: number;
  softFailCount: number;
  errorCount: number;
  missingCount: number;
  results: SyncResult[];
}

interface StatusResponse {
  ok: boolean;
  pending?: boolean;
  lastRun?: LastRun | null;
  error?: string;
}

export function SyncView() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Initial load + adaptive polling
  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const r = await fetch('/api/sync/status', { cache: 'no-store' });
        const data: StatusResponse = await r.json();
        if (canceled) return;
        setStatus(data);
        setStatusError(data.ok ? null : (data.error ?? 'Unknown status error'));
        const delay = data.pending ? 5000 : 30000;
        timer = setTimeout(tick, delay);
      } catch (err) {
        if (canceled) return;
        setStatusError(err instanceof Error ? err.message : String(err));
        timer = setTimeout(tick, 10000);
      }
    }
    tick();
    return () => {
      canceled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  async function handleSyncAll() {
    setTriggering(true);
    setTriggerError(null);
    try {
      const r = await fetch('/api/sync/run', { method: 'POST' });
      const data: { ok: boolean; error?: string } = await r.json();
      if (!data.ok) throw new Error(data.error ?? 'Failed to trigger sync');
      // Re-poll after 2s — by then the one-shot trigger should be visible
      setTimeout(async () => {
        const sr = await fetch('/api/sync/status', { cache: 'no-store' });
        setStatus(await sr.json());
      }, 2000);
    } catch (err) {
      setTriggerError(err instanceof Error ? err.message : String(err));
    } finally {
      setTriggering(false);
    }
  }

  const pending = !!status?.pending;
  const lastRun = status?.lastRun ?? null;

  return (
    <div className="space-y-6">
      {/* Trigger card */}
      <div className="rounded-lg border border-warm-gray/60 bg-warm-white p-6">
        <div className="flex items-center gap-4 flex-wrap">
          <button
            onClick={handleSyncAll}
            disabled={triggering || pending}
            className={
              'px-6 py-3 rounded-lg font-semibold text-warm-white transition-colors text-base ' +
              (triggering || pending
                ? 'bg-charcoal/30 cursor-not-allowed'
                : 'bg-indigo hover:bg-indigo/90')
            }
          >
            {pending ? 'Syncing — ETA ~15 min' : triggering ? 'Starting…' : 'Sync all now'}
          </button>
          {pending && (
            <span className="text-sm text-charcoal/60">
              Orchestrator running on Apps Script. This page polls every 5 sec — leave it open or come back later.
            </span>
          )}
        </div>
        {triggerError && (
          <p className="mt-3 text-sm text-clay">Trigger failed: {triggerError}</p>
        )}
        {statusError && !pending && (
          <p className="mt-3 text-xs text-charcoal/60">Status check error: {statusError}</p>
        )}
      </div>

      {/* Last run summary */}
      {lastRun ? (
        <div className="rounded-lg border border-warm-gray/60 bg-warm-white">
          <div className="px-6 py-4 border-b border-warm-gray/30 flex items-baseline justify-between flex-wrap gap-2">
            <div>
              <h2 className="font-display text-lg">Last sync</h2>
              <p className="text-xs text-charcoal/60 mt-0.5">
                {fmtRelative(lastRun.finishedAt)} · {lastRun.durationSec}s total
              </p>
            </div>
            <div className="text-sm flex gap-4 tabular-nums">
              <span className="text-charcoal">✓ {lastRun.okCount}</span>
              {lastRun.softFailCount > 0 && (
                <span className="text-clay">⚠ {lastRun.softFailCount}</span>
              )}
              {lastRun.errorCount > 0 && (
                <span className="text-ironclad">✗ {lastRun.errorCount}</span>
              )}
              {lastRun.missingCount > 0 && (
                <span className="text-charcoal/40">? {lastRun.missingCount}</span>
              )}
            </div>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {lastRun.results.map((r) => (
                <tr key={r.fn} className="border-b border-warm-gray/20 last:border-b-0">
                  <td className="px-6 py-2.5 w-8 text-center align-top">
                    {r.status === 'ok' && <span className="text-charcoal">✓</span>}
                    {r.status === 'soft-fail' && <span className="text-clay">⚠</span>}
                    {r.status === 'error' && <span className="text-ironclad">✗</span>}
                    {r.status === 'missing' && <span className="text-charcoal/40">?</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{r.label}</div>
                    <div className="text-[11px] text-charcoal/50 font-mono">{r.fn}</div>
                    {r.error && (
                      <div className="text-[11px] text-ironclad mt-1 font-mono whitespace-pre-wrap">
                        {r.error}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-2.5 text-right tabular-nums text-charcoal/60 align-top">
                    {Math.round(r.elapsedMs / 1000)}s
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-warm-gray/60 bg-warm-white p-6 text-sm text-charcoal/60">
          No sync runs recorded yet. Click &ldquo;Sync all now&rdquo; to kick one off — full sequence takes ~15 minutes.
        </div>
      )}
    </div>
  );
}

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toLocaleString();
}
