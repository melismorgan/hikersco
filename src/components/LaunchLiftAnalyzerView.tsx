'use client';

import { useMemo, useState } from 'react';
import type {
  LaunchLiftAnalysis,
  LaunchAnalysisRow,
} from '@/lib/launch-lift-analyzer';

interface Props {
  data: LaunchLiftAnalysis;
}

type SortKey = 'sendDate' | 'expandedSkuCount' | 'medianExistingLift' | 'avgPerNewSkuFirstWindowUnits';

export function LaunchLiftAnalyzerView({ data }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('sendDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [showIncomplete, setShowIncomplete] = useState(true);

  const launches = useMemo(() => {
    const filtered = showIncomplete
      ? data.launches
      : data.launches.filter((l) => l.postWindowComplete);
    const sorted = [...filtered].sort((a, b) => {
      const av = launchSortValue(a, sortKey);
      const bv = launchSortValue(b, sortKey);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return sorted;
  }, [data.launches, showIncomplete, sortKey, sortDir]);

  return (
    <div>
      {/* Aggregate KPI strip */}
      <AggregatePanel data={data} />

      {/* Warnings */}
      {data.warnings.length > 0 && (
        <div className="mb-6 rounded-lg border border-amber-400/40 bg-amber-50 p-4">
          <p className="text-sm font-semibold mb-2 text-amber-900">Heads up</p>
          <ul className="text-sm text-amber-900/90 space-y-1 list-disc pl-5">
            {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {data.launches.length === 0 ? (
        <div className="rounded-lg border border-warm-gray/40 bg-warm-white p-6 text-sm text-charcoal/70">
          No tagged Product Announcement rows found yet. Tag historical announcements on the{' '}
          <strong>Campaign Event Map</strong> tab (Campaign Type = &ldquo;Product Announcement&rdquo; +
          Announced SKUs filled in), then reload this page.
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-4 text-xs text-charcoal/70">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={showIncomplete}
                onChange={(e) => setShowIncomplete(e.target.checked)}
                className="cursor-pointer"
              />
              Show in-flight launches (post window not yet closed)
            </label>
            <span className="ml-auto tabular-nums">
              {launches.length} of {data.launches.length} launches · sorted by{' '}
              <SortButton current={sortKey} setSort={(k) => updateSort(k, sortKey, sortDir, setSortKey, setSortDir)} value="sendDate">date</SortButton>
              {' · '}
              <SortButton current={sortKey} setSort={(k) => updateSort(k, sortKey, sortDir, setSortKey, setSortDir)} value="expandedSkuCount">SKU count</SortButton>
              {' · '}
              <SortButton current={sortKey} setSort={(k) => updateSort(k, sortKey, sortDir, setSortKey, setSortDir)} value="medianExistingLift">existing lift</SortButton>
              {' · '}
              <SortButton current={sortKey} setSort={(k) => updateSort(k, sortKey, sortDir, setSortKey, setSortDir)} value="avgPerNewSkuFirstWindowUnits">new-SKU avg</SortButton>
            </span>
          </div>

          <div className="space-y-4">
            {launches.map((l) => (
              <LaunchCard key={l.sendDate + '|' + l.campaignName} launch={l} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function launchSortValue(l: LaunchAnalysisRow, key: SortKey): number | string | null {
  switch (key) {
    case 'sendDate': return l.sendDate;
    case 'expandedSkuCount': return l.expandedSkuCount;
    case 'medianExistingLift': return l.medianExistingLift;
    case 'avgPerNewSkuFirstWindowUnits': return l.avgPerNewSkuFirstWindowUnits;
  }
}

function updateSort(
  key: SortKey,
  currentKey: SortKey,
  currentDir: 'asc' | 'desc',
  setKey: (k: SortKey) => void,
  setDir: (d: 'asc' | 'desc') => void,
): void {
  if (key === currentKey) setDir(currentDir === 'asc' ? 'desc' : 'asc');
  else { setKey(key); setDir('desc'); }
}

function SortButton({ current, value, setSort, children }: { current: SortKey; value: SortKey; setSort: (k: SortKey) => void; children: React.ReactNode }) {
  return (
    <button
      onClick={() => setSort(value)}
      className={
        'px-1 ' + (current === value ? 'text-indigo font-medium' : 'text-charcoal/70 hover:text-charcoal')
      }
    >{children}</button>
  );
}

function AggregatePanel({ data }: { data: LaunchLiftAnalysis }) {
  const agg = data.aggregate;
  return (
    <div className="mb-6 rounded-lg border border-warm-gray/40 bg-warm-white p-4">
      <p className="text-xs uppercase tracking-wide text-charcoal/50 mb-3">Across all closed-window launches</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi
          label="Launches analyzed"
          value={agg.launchCount}
          hint={agg.launchCount === 0 ? 'tag some announcements' : agg.launchCount < 3 ? 'directional only' : 'confident enough to plan from'}
        />
        <Kpi
          label="Typical existing-SKU lift"
          value={fmtMult(agg.medianExistingLift)}
          hint={
            agg.p25ExistingLift !== null && agg.p75ExistingLift !== null
              ? `P25–P75: ${fmtMult(agg.p25ExistingLift)} – ${fmtMult(agg.p75ExistingLift)}`
              : 'median across launches'
          }
          accent
        />
        <Kpi
          label="Typical per-new-SKU 14d demand"
          value={agg.medianNewSkuFirstWindowUnits !== null ? agg.medianNewSkuFirstWindowUnits + ' units' : '—'}
          hint="median across launches"
          accent
        />
        <Kpi
          label="Sales History thru"
          value={data.salesHistoryAsOf || '—'}
          hint="post window must close by this date"
        />
      </div>
      <p className="text-xs text-charcoal/60 mt-3 leading-relaxed">
        Plug these into the Events tab for future Product Announcements: <strong>Manual Multiplier</strong> gets
        the existing-SKU lift; <strong>Expected Units</strong> gets per-new-SKU 14d demand × (# new SKUs).
      </p>
    </div>
  );
}

function Kpi({ label, value, hint, accent }: { label: string; value: string | number; hint?: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs text-charcoal/60">{label}</div>
      <div className={'text-2xl mt-0.5 tabular-nums ' + (accent ? 'text-indigo font-semibold' : '')}>{value}</div>
      {hint && <div className="text-[11px] text-charcoal/50 mt-0.5">{hint}</div>}
    </div>
  );
}

function LaunchCard({ launch }: { launch: LaunchAnalysisRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={
        'rounded-lg border p-4 ' +
        (launch.postWindowComplete
          ? 'border-warm-gray/40 bg-warm-white'
          : 'border-amber-300/50 bg-amber-50/40')
      }
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold uppercase tracking-wide text-charcoal/60">
              {launch.sendDate}
            </span>
            <span className="text-xs text-charcoal/50">{launch.platform}</span>
            {!launch.postWindowComplete && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-200/60 text-amber-900">
                post window still open
              </span>
            )}
          </div>
          <h3 className="text-base mt-0.5">{launch.campaignName || '(unnamed campaign)'}</h3>
          <p className="text-xs text-charcoal/60 mt-0.5">
            Announced: <code className="text-[11px] bg-warm-gray/20 px-1 rounded">{launch.announcedSkusRaw}</code>
            {' '}→ {launch.expandedSkuCount} SKU{launch.expandedSkuCount === 1 ? '' : 's'}
          </p>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-indigo hover:underline shrink-0"
        >{expanded ? 'Hide SKUs' : 'Show SKUs'}</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <Stat label={`Existing (${launch.existingCount})`} value={fmtMult(launch.medianExistingLift)} sub={launch.avgExistingLift !== null ? `avg ${fmtMult(launch.avgExistingLift)}` : undefined} />
        <Stat label={`New SKUs (${launch.newCount})`} value={launch.totalNewSkuFirstWindowUnits + ' units'} sub={launch.avgPerNewSkuFirstWindowUnits !== null ? `${launch.avgPerNewSkuFirstWindowUnits} avg` : undefined} />
        <Stat label="Pre / post windows" value="30d / 14d" sub={launch.postWindowComplete ? 'closed' : 'partial'} />
        <Stat label="" value="" />
      </div>

      {expanded && (
        <div className="mt-4 border-t border-warm-gray/40 pt-3">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="text-charcoal/60 text-left">
                <th className="py-1 pr-3">SKU</th>
                <th className="py-1 pr-3">Class</th>
                <th className="py-1 pr-3 text-right">Pre 30d</th>
                <th className="py-1 pr-3 text-right">Post 14d</th>
                <th className="py-1 pr-3 text-right">Pre /day</th>
                <th className="py-1 pr-3 text-right">Post /day</th>
                <th className="py-1 pr-3 text-right">Lift</th>
              </tr>
            </thead>
            <tbody>
              {launch.perSku.map((s) => (
                <tr key={s.sku} className="border-t border-warm-gray/20">
                  <td className="py-1 pr-3 font-mono">{s.sku}</td>
                  <td className={'py-1 pr-3 ' + (s.classification === 'new' ? 'text-indigo' : 'text-charcoal/70')}>
                    {s.classification}
                  </td>
                  <td className="py-1 pr-3 text-right">{s.preUnits30d}</td>
                  <td className="py-1 pr-3 text-right">{s.postUnits14d}</td>
                  <td className="py-1 pr-3 text-right">{s.preDailyAvg.toFixed(2)}</td>
                  <td className="py-1 pr-3 text-right">{s.postDailyAvg.toFixed(2)}</td>
                  <td className="py-1 pr-3 text-right">{fmtMult(s.liftMultiplier)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-charcoal/50">{label}</div>
      <div className="text-base mt-0.5 tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-charcoal/50 mt-0.5">{sub}</div>}
    </div>
  );
}

function fmtMult(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toFixed(2) + '×';
}
