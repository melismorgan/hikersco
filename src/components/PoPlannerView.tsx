'use client';

import { Fragment, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { PoCoveragePlan, MultiplierMode, PoCoverageRow } from '@/lib/po-planner';
import { lineOrderIndex } from '@/lib/line-order';
import { useDrafts } from '@/lib/use-drafts';

interface Props {
  plan: PoCoveragePlan;
}

type SortKey =
  | 'styleGroup'      // Style/Line grouping with banners (default)
  | 'urgency'
  | 'sku'
  | 'velocity'
  | 'onHand'
  | 'available'
  | 'demand'
  | 'totalPlan';

export function PoPlannerView({ plan }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Default sort: style-group, matching the Apparel page so the planner reads
  // like Melissa's existing inventory view.
  const [sortKey, setSortKey] = useState<SortKey>('styleGroup');

  // Drafts integration — push computed PO quantities to the same
  // localStorage-backed Draft column workflow Matt uses on the Stock
  // pages. Lets him review/edit in his familiar surface.
  const { drafts, setDraft, hydrated: draftsHydrated } = useDrafts();
  const [pushConfirmOpen, setPushConfirmOpen] = useState(false);
  const [pushedSummary, setPushedSummary] = useState<{ skus: number; units: number } | null>(null);

  // ---- Inputs (URL-synced via shallow query string updates) ----
  function updateParam(key: string, value: string | undefined) {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set('mode', 'planning');
    if (value === undefined || value === '') sp.delete(key);
    else sp.set(key, value);
    router.push(`/reorder?${sp.toString()}`);
  }

  // ---- Sorted SKU rows ----
  // Style-group sort mirrors the Apparel page: line canonical order →
  // style alphabetical → active first → color alphabetical → sizeOrder.
  // Other sorts are flat (no banners). When sorting is style-group, we
  // also build a "show banner before this row" set.
  const sortedSkus = useMemo(() => {
    const rows = [...plan.perSku];
    const cmp: Record<SortKey, (a: PoCoverageRow, b: PoCoverageRow) => number> = {
      styleGroup: (a, b) => {
        const aLi = lineOrderIndex(a.line);
        const bLi = lineOrderIndex(b.line);
        if (aLi !== bLi) return aLi - bLi;
        if (a.line !== b.line) return a.line.localeCompare(b.line);
        if (a.style !== b.style) return a.style.localeCompare(b.style);
        const aAct = a.active ? 0 : 1;
        const bAct = b.active ? 0 : 1;
        if (aAct !== bAct) return aAct - bAct;
        if (a.color !== b.color) return a.color.localeCompare(b.color);
        return (a.sizeOrder || 99) - (b.sizeOrder || 99);
      },
      urgency: (a, b) => a.availableAtLanding / Math.max(1, a.currentDailyVelocity) -
        b.availableAtLanding / Math.max(1, b.currentDailyVelocity),
      sku: (a, b) => a.sku.localeCompare(b.sku),
      velocity: (a, b) => b.currentDailyVelocity - a.currentDailyVelocity,
      onHand: (a, b) => b.totalOnHandNow - a.totalOnHandNow,
      available: (a, b) => b.availableAtLanding - a.availableAtLanding,
      demand: (a, b) => b.totalDemandInWindow - a.totalDemandInWindow,
      totalPlan: (a, b) => b.totalPlan - a.totalPlan,
    };
    return rows.sort(cmp[sortKey]);
  }, [plan.perSku, sortKey]);

  // Style-group mode shows every row (you want to see the whole line at
  // once). Other sorts cap at 300 rows so a long tail doesn't blow up.
  const skusToShow = sortKey === 'styleGroup' ? sortedSkus : sortedSkus.slice(0, 300);

  // Compute banner-insertion points for style-group mode: insert before
  // any row where the line changed vs. the previous row.
  const bannerBeforeIndex = useMemo(() => {
    if (sortKey !== 'styleGroup') return new Set<number>();
    const out = new Set<number>();
    let prevLine: string | null = null;
    skusToShow.forEach((r, i) => {
      if (r.line !== prevLine) {
        out.add(i);
        prevLine = r.line;
      }
    });
    return out;
  }, [skusToShow, sortKey]);

  return (
    <div className="space-y-6">
      {/* ---- Inputs panel ---- */}
      <div className="rounded-lg border border-warm-gray/40 bg-warm-white p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-charcoal/60 uppercase tracking-wide">This PO lands</label>
            <input
              type="date"
              defaultValue={plan.thisPoLandsAt}
              onBlur={(e) => updateParam('landing', e.target.value)}
              className="border border-warm-gray/50 rounded-md px-2 py-1 text-sm bg-warm-white"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-charcoal/60 uppercase tracking-wide">Next PO lands</label>
            <input
              type="date"
              defaultValue={plan.nextPoLandsAt}
              onBlur={(e) => updateParam('nextLanding', e.target.value)}
              className="border border-warm-gray/50 rounded-md px-2 py-1 text-sm bg-warm-white"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-charcoal/60 uppercase tracking-wide">Multiplier source</label>
            <select
              defaultValue={plan.multiplierMode}
              onChange={(e) => updateParam('multiplier', e.target.value)}
              className="border border-warm-gray/50 rounded-md px-2 py-1 text-sm bg-warm-white"
            >
              <option value="latest">Latest year only</option>
              <option value="weighted">Recency-weighted (default)</option>
              <option value="avg">All-years simple average</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-charcoal/60 uppercase tracking-wide">Buffer</label>
            <select
              defaultValue={plan.buffer.toFixed(2)}
              onChange={(e) => updateParam('buffer', e.target.value)}
              className="border border-warm-gray/50 rounded-md px-2 py-1 text-sm bg-warm-white"
            >
              <option value="1.00">none (1.0×)</option>
              <option value="1.10">10% (1.1×)</option>
              <option value="1.15">15% (1.15×)</option>
              <option value="1.20">20% (1.2×)</option>
              <option value="1.25">25% (1.25×)</option>
              <option value="1.30">30% (1.3×)</option>
            </select>
          </div>
          <div className="text-xs text-charcoal/55 ml-auto leading-snug">
            <div><strong>{plan.daysToLanding}</strong> days from now to landing</div>
            <div><strong>{plan.coverageWindowDays}</strong> days of coverage to next PO</div>
            <div className="font-mono text-[10px] mt-1 opacity-70">data as of {plan.asOf}</div>
          </div>
        </div>
      </div>

      {/* ---- Events panel ---- */}
      <div className="rounded-lg border border-warm-gray/40 bg-warm-white">
        <div className="px-4 pt-4 pb-2 border-b border-warm-gray/30">
          <h2 className="text-base font-semibold">Events in the coverage window ({plan.eventsInWindow.length})</h2>
          <p className="text-xs text-charcoal/60 mt-0.5">
            Each event multiplies SKU demand inside its window. Events-tab entries override calendar defaults when both match the same week.
          </p>
        </div>
        <div className="p-4">
          {plan.eventsInWindow.length === 0 ? (
            <div className="text-sm text-charcoal/50 py-3 text-center">No events fall in this window.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-charcoal/60 border-b border-warm-gray/40">
                  <th className="py-2 font-normal">Event</th>
                  <th className="py-2 font-normal">Window</th>
                  <th className="py-2 font-normal">Source</th>
                  <th className="py-2 font-normal text-right">Multiplier</th>
                  <th className="py-2 font-normal text-right">Existing Expected Units</th>
                  <th className="py-2 font-normal text-right">Suggested Expected Units</th>
                </tr>
              </thead>
              <tbody>
                {plan.eventsInWindow.map((ev) => {
                  const delta = ev.suggestedExpectedUnits - ev.existingExpectedUnits;
                  return (
                    <tr key={ev.eventKey} className="border-b border-warm-gray/20 last:border-b-0">
                      <td className="py-2 font-medium">{ev.eventName}</td>
                      <td className="py-2 text-charcoal/70 tabular-nums">{ev.start} → {ev.end} ({ev.durationDays}d)</td>
                      <td className="py-2 text-xs">
                        <span className={
                          'inline-block px-2 py-0.5 rounded text-[11px] ' +
                          (ev.source === 'events-tab'
                            ? 'bg-sage/15 text-sage'
                            : 'bg-warm-gray/30 text-charcoal/70')
                        }>
                          {ev.source === 'events-tab' ? 'Events tab' : 'Calendar'}
                        </span>
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {ev.hasMultiplier
                          ? <span className="font-semibold text-indigo">{ev.multiplier.toFixed(2)}×</span>
                          : <span className="text-charcoal/40">—</span>}
                      </td>
                      <td className="py-2 text-right tabular-nums">{ev.existingExpectedUnits.toLocaleString() || '—'}</td>
                      <td className="py-2 text-right tabular-nums">
                        <span className="font-semibold text-indigo">{ev.suggestedExpectedUnits.toLocaleString()}</span>
                        {ev.existingExpectedUnits > 0 && delta !== 0 && (
                          <span className={'text-[10px] ml-1.5 ' + (delta > 0 ? 'text-sage' : 'text-ironclad')}>
                            ({delta > 0 ? '+' : ''}{delta.toLocaleString()})
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="mt-3 text-xs text-charcoal/55 leading-relaxed">
            <em>Suggested Expected Units</em> = sum across linked SKUs of (current daily velocity × event multiplier × event duration).
            These haven&apos;t been written to the Events tab yet — use the &quot;Preview write-back&quot; action below the SKU table to send them to the workbook so the tactical reorder view picks them up too.
            <em> Existing</em> values you&apos;ve already typed on the Events tab take precedence until you accept a new write.
          </div>
        </div>
      </div>

      {/* ---- Totals strip ---- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="SKUs needing reorder" value={plan.totals.distinctSkus.toLocaleString()} />
        <Kpi label="Amazon units" value={plan.totals.amzUnits.toLocaleString()} accent="sage" />
        <Kpi label="ShipBob units" value={plan.totals.sbUnits.toLocaleString()} accent="peri" />
        <Kpi label="Estimated cost" value={fmtMoney(plan.totals.estimatedCost)} accent="indigo" />
      </div>

      {/* ---- Push to Drafts action ----
          Writes the planner's recommended quantities into the same
          localStorage-backed Draft state that the Apparel and Accessories
          dashboards already read from. Lets Matt continue his familiar
          "open Stock-Apparel, review Draft column, push to POs" workflow
          while the planner does the upstream forecasting work. */}
      <div className="rounded-lg border border-indigo/30 bg-indigo/5 p-4 flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[280px]">
          <h3 className="text-base font-semibold text-indigo">Push to Stock-Apparel / Accessories Draft columns</h3>
          <p className="text-sm text-charcoal/70 mt-1">
            Populates the per-SKU Draft column on the Apparel + Accessories pages with the recommended quantities above. Matt&apos;s normal review-and-push-to-POs workflow continues from there. Existing drafts for these SKUs get overwritten; SKUs not in this plan stay untouched.
          </p>
          {pushedSummary && (
            <p className="text-xs text-sage mt-2">
              ✓ Pushed {pushedSummary.skus} SKUs ({pushedSummary.units.toLocaleString()} units total) to the Draft state. Open
              {' '}<Link href="/dashboard" className="underline">Apparel</Link>{' '}or
              {' '}<Link href="/accessories" className="underline">Accessories</Link>{' '}to review.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {Object.keys(drafts).length > 0 && (
            <span className="text-xs text-charcoal/60">
              {Object.keys(drafts).length} draft{Object.keys(drafts).length === 1 ? '' : 's'} currently in localStorage
            </span>
          )}
          <button
            type="button"
            disabled={!draftsHydrated || plan.totals.distinctSkus === 0}
            onClick={() => setPushConfirmOpen(true)}
            className="px-4 py-2 text-sm font-medium bg-indigo text-white rounded-md hover:bg-indigo/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Push {plan.totals.distinctSkus} SKUs to Drafts
          </button>
        </div>
      </div>

      {/* ---- Confirm modal ---- */}
      {pushConfirmOpen && (
        <div className="fixed inset-0 bg-charcoal/40 z-50 flex items-center justify-center p-4" onClick={() => setPushConfirmOpen(false)}>
          <div className="bg-warm-white rounded-lg shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">Push to Draft columns?</h2>
            <p className="text-sm text-charcoal/70 mt-2">
              This will set the per-SKU Draft quantity for <strong>{plan.totals.distinctSkus}</strong> SKU{plan.totals.distinctSkus === 1 ? '' : 's'},
              totaling <strong>{plan.totals.totalUnits.toLocaleString()}</strong> units (
              <strong>{fmtMoney(plan.totals.estimatedCost)}</strong> at current unit costs).
            </p>
            {Object.keys(drafts).length > 0 && (() => {
              const overwrittenSkus = plan.perSku.filter((r) => r.totalPlan > 0 && drafts[r.sku] !== undefined && drafts[r.sku] !== r.totalPlan).length;
              return overwrittenSkus > 0 ? (
                <p className="text-sm text-clay mt-3">
                  ⚠ {overwrittenSkus} SKU{overwrittenSkus === 1 ? '' : 's'} already have different Draft values that will be overwritten.
                </p>
              ) : null;
            })()}
            <p className="text-xs text-charcoal/55 mt-3">
              Draft state lives in this browser&apos;s localStorage. Switching to another device means re-pushing from there.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPushConfirmOpen(false)}
                className="px-4 py-1.5 text-sm border border-warm-gray/50 rounded-md hover:bg-warm-gray/20"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  let skuCount = 0;
                  let unitTotal = 0;
                  plan.perSku.forEach((r) => {
                    if (r.totalPlan > 0) {
                      setDraft(r.sku, r.totalPlan);
                      skuCount++;
                      unitTotal += r.totalPlan;
                    }
                  });
                  setPushedSummary({ skus: skuCount, units: unitTotal });
                  setPushConfirmOpen(false);
                }}
                className="px-4 py-1.5 text-sm font-medium bg-indigo text-white rounded-md hover:bg-indigo/90"
              >
                Push to Drafts
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Per-SKU table ---- */}
      <div className="rounded-lg border border-warm-gray/40 bg-warm-white">
        <div className="px-4 pt-4 pb-2 border-b border-warm-gray/30 flex items-baseline justify-between">
          <div>
            <h2 className="text-base font-semibold">Per-SKU recommendation</h2>
            <p className="text-xs text-charcoal/60 mt-0.5">
              available_at_landing + new PO must cover (organic + event) demand × buffer through next PO landing.
            </p>
          </div>
          <label className="text-xs flex items-center gap-2">
            <span className="text-charcoal/60">Sort:</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="border border-warm-gray/50 rounded-md px-2 py-1 text-xs bg-warm-white"
            >
              <option value="styleGroup">Style group (line banners, Color → Size)</option>
              <option value="totalPlan">Recommended order (desc)</option>
              <option value="urgency">Lowest cover at landing (most urgent)</option>
              <option value="demand">Total window demand</option>
              <option value="velocity">Daily velocity</option>
              <option value="onHand">On-hand today</option>
              <option value="available">Available at landing</option>
              <option value="sku">SKU code (A-Z)</option>
            </select>
          </label>
        </div>
        {/* dash-scroll + dash-table pattern (see globals.css). The wrapper is
            the constrained-height scroll context, and globals.css applies
            `position: sticky; top: 0` to dash-table thead th — that combo is
            what actually makes the header pin while scrolling. A bare
            `overflow-x-auto` div would silently create a y-scroll context
            without setting one up, so sticky inside it stays anchored to the
            wrong element. */}
        <div className="dash-scroll">
          <table className="dash-table w-full text-sm">
            <thead>
              <tr className="text-left text-charcoal/60 border-b border-warm-gray/40">
                <th className="py-2 px-3 font-normal">SKU</th>
                <th className="py-2 font-normal text-right">Vel/day</th>
                <th className="py-2 font-normal text-right">On-hand</th>
                <th className="py-2 font-normal text-right">Burn to landing</th>
                <th className="py-2 font-normal text-right">Arriving before</th>
                <th className="py-2 font-normal text-right">Available at landing</th>
                <th className="py-2 font-normal text-right">Window demand</th>
                <th className="py-2 font-normal text-right">Arriving in window</th>
                <th className="py-2 font-normal text-right">Amz</th>
                <th className="py-2 font-normal text-right">SB</th>
                <th className="py-2 font-normal text-right px-3">Total order</th>
              </tr>
            </thead>
            <tbody>
              {skusToShow.map((r, i) => {
                const showBanner = bannerBeforeIndex.has(i);
                return (
                  <Fragment key={r.sku}>
                    {showBanner && (
                      <tr className="bg-indigo/10">
                        <td colSpan={11} className="py-1.5 px-3">
                          <span className="text-xs font-semibold text-indigo uppercase tracking-wide">
                            {r.line}
                          </span>
                        </td>
                      </tr>
                    )}
                    <tr className={
                      'border-b border-warm-gray/20 last:border-b-0 ' +
                      (r.totalPlan === 0 ? 'opacity-60' : '')
                    }>
                      <td className="py-2 px-3">
                        <div className="font-mono text-xs">{r.sku}</div>
                        <div className="text-[10px] text-charcoal/55">{r.style} · {r.color}{r.size ? ' · ' + r.size : ''}</div>
                      </td>
                      <td className="py-2 text-right tabular-nums">{r.currentDailyVelocity.toFixed(2)}</td>
                      <td className="py-2 text-right tabular-nums">{r.totalOnHandNow.toLocaleString()}</td>
                      <td className="py-2 text-right tabular-nums text-charcoal/70">−{Math.round(r.organicBurnToLanding + r.preLandingEventDemand).toLocaleString()}</td>
                      <td className="py-2 text-right tabular-nums text-sage">+{r.arrivalsBeforeLanding.toLocaleString()}</td>
                      <td className="py-2 text-right tabular-nums font-medium">{Math.round(r.availableAtLanding).toLocaleString()}</td>
                      <td className="py-2 text-right tabular-nums">{Math.round(r.totalDemandInWindow).toLocaleString()}</td>
                      <td className="py-2 text-right tabular-nums text-sage">+{r.arrivalsInWindow.toLocaleString()}</td>
                      <td className="py-2 text-right tabular-nums">{r.amzPlan > 0 ? r.amzPlan.toLocaleString() : <span className="text-charcoal/30">—</span>}</td>
                      <td className="py-2 text-right tabular-nums">{r.sbPlan > 0 ? r.sbPlan.toLocaleString() : <span className="text-charcoal/30">—</span>}</td>
                      <td className="py-2 text-right tabular-nums font-semibold text-indigo px-3">
                        {r.totalPlan > 0 ? r.totalPlan.toLocaleString() : <span className="text-charcoal/30">—</span>}
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {sortedSkus.length > skusToShow.length && (
          <div className="text-xs text-charcoal/55 mt-2 text-center px-4 pb-3">
            Showing top {skusToShow.length} of {sortedSkus.length} SKUs by sort.
          </div>
        )}
      </div>

      {/* Events-tab write-back is still on the roadmap as Phase 2 — it'd
          let computed Suggested Expected Units flow back to the workbook
          so the tactical reorder view picks them up automatically. For now
          the planner is self-contained: forecast → review → push to Drafts
          → Matt's existing review-and-push-to-POs flow. */}
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: 'indigo' | 'sage' | 'peri' }) {
  const accentClass = accent === 'indigo' ? 'text-indigo' : accent === 'sage' ? 'text-sage' : accent === 'peri' ? 'text-peri' : 'text-charcoal';
  return (
    <div className="rounded-md border border-warm-gray/40 bg-warm-white p-4">
      <div className="text-xs uppercase tracking-wide text-charcoal/60 font-medium">{label}</div>
      <div className={'text-2xl mt-1 ' + accentClass}>{value}</div>
    </div>
  );
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
