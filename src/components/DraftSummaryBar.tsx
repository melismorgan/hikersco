'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createDraftPosFromDrafts, type DraftPushLine } from '@/app/pos/actions';
import type { DraftPoSummary } from '@/lib/inventory';

export interface DraftAgg {
  distinctSkus: number;
  gross: number;
  amzTotal: number;
  sbTotal: number;
  estCost: number;
  lines: DraftPushLine[];
}

interface Props {
  agg: DraftAgg;
  onClear: () => void;
  /** Existing Draft POs the user can append to — populates the destination picker. */
  existingDrafts: DraftPoSummary[];
}

/**
 * Sticky bar that appears whenever any drafts are entered. Lets the user
 * choose between starting a new PO (auto-generated PO#) or appending to an
 * existing Draft PO across both Apparel and Accessories. Used by both grids.
 */
export function DraftSummaryBar({ agg, onClear, existingDrafts }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [target, setTarget] = useState<string>('NEW');  // 'NEW' or an existing PO#

  const onPush = () => {
    setFeedback(null);
    startTransition(async () => {
      const res = await createDraftPosFromDrafts(
        agg.lines,
        target === 'NEW' ? {} : { poNumber: target },
      );
      if (res.ok) {
        const verb = target === 'NEW' ? 'Created' : 'Appended';
        const poList = res.poNumbers.length === 1
          ? `PO ${res.poNumbers[0]}`
          : `${res.poNumbers.length} POs (${res.poNumbers.join(', ')})`;
        setFeedback({
          tone: 'ok',
          text: `${verb} ${res.created} row${res.created === 1 ? '' : 's'} across ${poList}.`,
        });
        onClear();
        setTarget('NEW');
        router.refresh();
      } else {
        setFeedback({ tone: 'error', text: res.error ?? 'Push failed.' });
      }
    });
  };

  return (
    <div className="rounded-lg border border-indigo/30 bg-indigo-wash p-3 space-y-2">
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <span className="font-display text-lg text-indigo">{agg.distinctSkus}</span>
        <span className="text-charcoal/70">{agg.distinctSkus === 1 ? 'SKU' : 'SKUs'} drafted</span>
        <span className="text-warm-gray">·</span>
        <span className="font-mono">{agg.gross.toLocaleString()}</span>
        <span className="text-charcoal/70">gross</span>
        <span className="text-warm-gray">·</span>
        <span className="font-mono">{agg.amzTotal.toLocaleString()}</span>
        <span className="text-charcoal/70">→ AWD</span>
        <span className="text-warm-gray">·</span>
        <span className="font-mono">{agg.sbTotal.toLocaleString()}</span>
        <span className="text-charcoal/70">→ ShipBob</span>
        {agg.estCost > 0 && (
          <>
            <span className="text-warm-gray">·</span>
            <span className="font-mono">{fmtCurrency(agg.estCost)}</span>
            <span className="text-charcoal/70">est.</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap text-sm">
        <label className="flex items-center gap-2">
          <span className="text-charcoal/70">Push to:</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="px-2 py-1 rounded-md border border-warm-gray/60 bg-warm-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo/40"
          >
            <option value="NEW">New PO (auto-generated)</option>
            {existingDrafts.length > 0 && (
              <optgroup label="Add to existing Draft">
                {existingDrafts.map((d) => (
                  <option key={d.poNumber} value={d.poNumber}>
                    {d.poNumber} — {d.lineCount} line{d.lineCount === 1 ? '' : 's'} · {d.totalQty.toLocaleString()}u{d.totalCost > 0 ? ` · ${fmtCurrency(d.totalCost)}` : ''}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {feedback && (
          <span className={`text-xs ${feedback.tone === 'ok' ? 'text-sage' : 'text-ironclad'}`}>{feedback.text}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onClear}
            disabled={pending}
            className="px-3 py-1.5 rounded-md text-sm text-charcoal/70 hover:bg-warm-beige disabled:opacity-50"
          >
            Clear all
          </button>
          <button
            onClick={onPush}
            disabled={pending || agg.distinctSkus === 0}
            className="px-4 py-1.5 rounded-md bg-indigo text-warm-white text-sm font-medium hover:bg-indigo/90 disabled:opacity-50"
          >
            {pending ? 'Pushing…' : (target === 'NEW' ? 'Push to new PO' : `Append to ${target}`)}
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
