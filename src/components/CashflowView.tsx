'use client';

/**
 * Rolling cashflow timeline. For each open PO we project two streams:
 *
 *   Due events  — one per leg (Deposit, Balance) showing REMAINING
 *                 expected amount (max(expected − paid, 0)). If the leg is
 *                 fully paid, no due event is generated.
 *
 *   Paid events — one per actual transaction (rows on the PO Payment
 *                 Transactions tab). Shows up in the collapsible "Paid" rail.
 *
 * Buckets group due events by how soon they're owed (Overdue, This Week,
 * Next Week, etc.). The headline tiles sum due-event REMAINING amounts so
 * "next 30 days" reflects cash-out that hasn't gone yet — partial payments
 * are subtracted out.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { PoSummary } from '@/lib/inventory';

interface Props {
  summaries: PoSummary[];
}

interface DueEvent {
  id: string;
  poNumber: string;
  supplier: string;
  leg: 'Deposit' | 'Balance';
  expected: number;
  paid: number;
  remaining: number;
  txnCount: number;       // how many transactions have already chipped in
  dueDate: string;
  dueTs: number;
  daysFromNow: number;
}

interface PaidEvent {
  id: string;
  poNumber: string;
  supplier: string;
  leg: 'Deposit' | 'Balance' | 'Shipping';
  amount: number;
  fee: number;
  paidDate: string;
  paidTs: number;
  notes: string;
}

const BUCKETS: Array<{
  key: string;
  label: string;
  match: (e: DueEvent) => boolean;
  accent: 'ironclad' | 'clay' | 'indigo' | 'periwinkle' | 'sage' | 'charcoal';
}> = [
  { key: 'overdue',  label: 'Overdue',         match: (e) => Number.isFinite(e.dueTs) && e.daysFromNow < 0,                       accent: 'ironclad' },
  { key: 'thisWeek', label: 'This week',       match: (e) => Number.isFinite(e.dueTs) && e.daysFromNow >= 0 && e.daysFromNow <= 7, accent: 'clay' },
  { key: 'nextWeek', label: 'Next week',       match: (e) => Number.isFinite(e.dueTs) && e.daysFromNow > 7 && e.daysFromNow <= 14, accent: 'clay' },
  { key: '2-4',      label: 'In 2-4 weeks',    match: (e) => Number.isFinite(e.dueTs) && e.daysFromNow > 14 && e.daysFromNow <= 28, accent: 'indigo' },
  { key: '4-8',      label: 'In 4-8 weeks',    match: (e) => Number.isFinite(e.dueTs) && e.daysFromNow > 28 && e.daysFromNow <= 56, accent: 'indigo' },
  { key: '8-12',     label: 'In 8-12 weeks',   match: (e) => Number.isFinite(e.dueTs) && e.daysFromNow > 56 && e.daysFromNow <= 84, accent: 'periwinkle' },
  { key: 'beyond',   label: 'Beyond 12 weeks', match: (e) => Number.isFinite(e.dueTs) && e.daysFromNow > 84,                       accent: 'periwinkle' },
  { key: 'noDate',   label: 'No date set',     match: (e) => !Number.isFinite(e.dueTs),                                            accent: 'charcoal' },
];

const EPS = 0.005;

export function CashflowView({ summaries }: Props) {
  const [showPaid, setShowPaid] = useState(false);

  const dueEvents = useMemo<DueEvent[]>(() => {
    const now = Date.now();
    const out: DueEvent[] = [];
    for (const s of summaries) {
      if (s.paymentStatus === 'Cancelled') continue;
      // Deposit leg
      if (s.depositRemaining > EPS) {
        const ts = s.depositDueDate ? Date.parse(s.depositDueDate) : NaN;
        out.push({
          id: `${s.poNumber}-D`,
          poNumber: s.poNumber, supplier: s.supplier, leg: 'Deposit',
          expected: s.depositAmount,
          paid: s.depositPaidAmount,
          remaining: s.depositRemaining,
          txnCount: s.transactions.filter((t) => t.type === 'Deposit').length,
          dueDate: s.depositDueDate,
          dueTs: ts,
          daysFromNow: Number.isFinite(ts) ? Math.floor((ts - now) / 86_400_000) : 0,
        });
      }
      // Balance leg
      if (s.balanceRemaining > EPS) {
        const ts = s.balanceDueDate ? Date.parse(s.balanceDueDate) : NaN;
        out.push({
          id: `${s.poNumber}-B`,
          poNumber: s.poNumber, supplier: s.supplier, leg: 'Balance',
          expected: s.balanceAmount,
          paid: s.balancePaidAmount,
          remaining: s.balanceRemaining,
          txnCount: s.transactions.filter((t) => t.type === 'Balance').length,
          dueDate: s.balanceDueDate,
          dueTs: ts,
          daysFromNow: Number.isFinite(ts) ? Math.floor((ts - now) / 86_400_000) : 0,
        });
      }
    }
    return out;
  }, [summaries]);

  const paidEvents = useMemo<PaidEvent[]>(() => {
    const out: PaidEvent[] = [];
    for (const s of summaries) {
      for (const t of s.transactions) {
        const ts = Date.parse(t.date);
        out.push({
          id: `tx-${t.rowIndex}`,
          poNumber: s.poNumber,
          supplier: s.supplier,
          leg: t.type,
          amount: t.amount,
          fee: t.fee,
          paidDate: t.date,
          paidTs: Number.isFinite(ts) ? ts : 0,
          notes: t.notes,
        });
      }
    }
    // Most recent first
    out.sort((a, b) => b.paidTs - a.paidTs);
    return out;
  }, [summaries]);

  const buckets = useMemo(() => {
    return BUCKETS.map((b) => {
      const list = dueEvents
        .filter(b.match)
        .sort((a, b) => {
          const aTs = Number.isFinite(a.dueTs) ? a.dueTs : Number.MAX_SAFE_INTEGER;
          const bTs = Number.isFinite(b.dueTs) ? b.dueTs : Number.MAX_SAFE_INTEGER;
          return aTs - bTs;
        });
      const total = list.reduce((s, e) => s + e.remaining, 0);
      return { ...b, list, total };
    });
  }, [dueEvents]);

  const headline = useMemo(() => {
    let next30 = 0, next60 = 0, next90 = 0, overdue = 0;
    for (const e of dueEvents) {
      if (!Number.isFinite(e.dueTs)) continue;
      if (e.daysFromNow < 0) overdue += e.remaining;
      else {
        if (e.daysFromNow <= 30) next30 += e.remaining;
        if (e.daysFromNow <= 60) next60 += e.remaining;
        if (e.daysFromNow <= 90) next90 += e.remaining;
      }
    }
    return { next30, next60, next90, overdue };
  }, [dueEvents]);

  const totalUnpaid = dueEvents.reduce((s, e) => s + e.remaining, 0);
  const totalPaid   = paidEvents.reduce((s, e) => s + e.amount, 0);

  return (
    <div className="space-y-8">
      {/* Headline */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Headline label="Overdue"         value={headline.overdue} accent="ironclad" />
        <Headline label="Next 30 days"    value={headline.next30}  accent="clay" />
        <Headline label="Next 60 days"    value={headline.next60}  accent="indigo" />
        <Headline label="Next 90 days"    value={headline.next90}  accent="periwinkle" />
      </div>

      <div className="text-xs text-charcoal/60">
        {dueEvents.length} unpaid leg{dueEvents.length === 1 ? '' : 's'} · {fmtCurrency(totalUnpaid)} outstanding
        {paidEvents.length > 0 && (
          <>  ·  {paidEvents.length} transaction{paidEvents.length === 1 ? '' : 's'} · {fmtCurrency(totalPaid)} cleared</>
        )}
      </div>

      {/* Buckets */}
      <div className="space-y-4">
        {buckets.map((b) => (
          <Bucket key={b.key} label={b.label} accent={b.accent} list={b.list} total={b.total} />
        ))}
      </div>

      {/* Paid section */}
      {paidEvents.length > 0 && (
        <section>
          <button
            onClick={() => setShowPaid((v) => !v)}
            className="flex items-baseline justify-between w-full px-4 py-3 rounded-lg border border-warm-gray/40 bg-warm-white hover:bg-warm-beige/40 text-left"
          >
            <span className="font-medium text-sm">
              {showPaid ? '▾' : '▸'} Paid transactions ({paidEvents.length})
            </span>
            <span className="text-sm text-sage tabular-nums">{fmtCurrency(totalPaid)}</span>
          </button>
          {showPaid && (
            <div className="mt-2 rounded-lg border border-warm-gray/40 bg-warm-white">
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-separate border-spacing-0">
                  <thead>
                    <tr className="bg-sage/15 text-charcoal/80 text-xs uppercase tracking-wider">
                      <Th className="text-left">PO #</Th>
                      <Th className="text-left">Supplier</Th>
                      <Th className="text-left">Leg</Th>
                      <Th className="text-left">Paid</Th>
                      <Th className="text-right">Amount</Th>
                      <Th className="text-right">Fee</Th>
                      <Th className="text-left">Notes</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {paidEvents.map((e, i) => (
                      <tr key={e.id} className={`${i % 2 === 0 ? 'bg-warm-white' : 'bg-warm-beige/20'} border-b border-warm-gray/20`}>
                        <Td className="font-mono text-xs"><Link href="/pos" className="hover:underline">{e.poNumber}</Link></Td>
                        <Td>{e.supplier || '—'}</Td>
                        <Td className="text-xs">{e.leg}</Td>
                        <Td className="text-xs text-sage">✓ {e.paidDate || '—'}</Td>
                        <Td className="text-right tabular-nums">{fmtCurrency(e.amount)}</Td>
                        <Td className="text-right tabular-nums text-charcoal/60">{e.fee > 0 ? fmtCurrency(e.fee) : <span className="text-charcoal/30">—</span>}</Td>
                        <Td className="text-xs text-charcoal/60">{e.notes || ''}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {dueEvents.length === 0 && paidEvents.length === 0 && (
        <div className="rounded-lg border border-warm-gray/40 bg-warm-white p-8 text-center text-sm text-charcoal/60">
          No open POs. Once you create a PO and set deposit/balance due dates, payments will appear here.
        </div>
      )}
    </div>
  );
}

// --- Bucket -----------------------------------------------------------------

function Bucket({
  label, accent, list, total,
}: {
  label: string;
  accent: 'ironclad' | 'clay' | 'indigo' | 'periwinkle' | 'sage' | 'charcoal';
  list: DueEvent[];
  total: number;
}) {
  if (list.length === 0) return null;
  const ring =
    accent === 'ironclad'   ? 'border-ironclad/40 bg-ironclad/5' :
    accent === 'clay'       ? 'border-clay/40 bg-clay/5' :
    accent === 'indigo'     ? 'border-indigo/30 bg-indigo/5' :
    accent === 'periwinkle' ? 'border-periwinkle/40 bg-periwinkle/5' :
    accent === 'sage'       ? 'border-sage/40 bg-sage/5' :
                              'border-warm-gray/40 bg-warm-beige/30';
  const text =
    accent === 'ironclad'   ? 'text-ironclad' :
    accent === 'clay'       ? 'text-clay' :
    accent === 'indigo'     ? 'text-indigo' :
    accent === 'periwinkle' ? 'text-periwinkle' :
    accent === 'sage'       ? 'text-sage' :
                              'text-charcoal/70';
  return (
    <section className={`rounded-lg border ${ring}`}>
      <div className="flex items-baseline justify-between px-4 py-3 border-b border-warm-gray/30">
        <h3 className={`font-medium ${text}`}>{label}</h3>
        <div className="text-sm tabular-nums">
          <span className="text-charcoal/50">{list.length} · </span>
          <span className={`font-medium ${text}`}>{fmtCurrency(total)}</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-separate border-spacing-0">
          <thead>
            <tr className="text-charcoal/60 text-xs uppercase tracking-wider">
              <Th className="text-left">PO #</Th>
              <Th className="text-left">Supplier</Th>
              <Th className="text-left">Leg</Th>
              <Th className="text-left">Due</Th>
              <Th className="text-right">Remaining</Th>
              <Th className="text-right">Of</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((e, i) => (
              <tr key={e.id} className={`${i % 2 === 0 ? 'bg-warm-white' : 'bg-warm-beige/20'} border-b border-warm-gray/20`}>
                <Td className="font-mono text-xs">
                  <Link href="/pos" className="hover:underline">{e.poNumber}</Link>
                </Td>
                <Td>{e.supplier || '—'}</Td>
                <Td className="text-xs">{e.leg}</Td>
                <Td className="text-xs"><DueLabel days={e.daysFromNow} date={e.dueDate} hasDate={Number.isFinite(e.dueTs)} /></Td>
                <Td className="text-right tabular-nums">
                  {fmtCurrency(e.remaining)}
                  {e.txnCount > 0 && (
                    <span className="ml-1 text-[11px] text-charcoal/50 font-normal">({e.txnCount} tx · {fmtCurrency(e.paid)} paid)</span>
                  )}
                </Td>
                <Td className="text-right tabular-nums text-charcoal/50 text-xs">{fmtCurrency(e.expected)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- Small helpers -----------------------------------------------------------

function DueLabel({ days, date, hasDate }: { days: number; date: string; hasDate: boolean }) {
  if (!hasDate) return <span className="text-charcoal/50">No date</span>;
  if (days < 0) return <span className="text-ironclad font-medium">{Math.abs(days)}d overdue · {date}</span>;
  if (days === 0) return <span className="text-clay font-medium">Today · {date}</span>;
  if (days === 1) return <span className="text-clay font-medium">Tomorrow · {date}</span>;
  if (days <= 7) return <span className="text-clay">In {days}d · {date}</span>;
  return <span className="text-charcoal/70">{date}</span>;
}

function Headline({ label, value, accent }: { label: string; value: number; accent: 'ironclad' | 'clay' | 'indigo' | 'periwinkle' }) {
  const ring =
    accent === 'ironclad'   ? 'border-ironclad/30' :
    accent === 'clay'       ? 'border-clay/30' :
    accent === 'indigo'     ? 'border-indigo/30' :
                              'border-periwinkle/30';
  const text =
    accent === 'ironclad'   ? 'text-ironclad' :
    accent === 'clay'       ? 'text-clay' :
    accent === 'indigo'     ? 'text-indigo' :
                              'text-periwinkle';
  return (
    <div className={`rounded-lg border ${ring} bg-warm-white px-4 py-3`}>
      <div className="text-[10px] uppercase tracking-wider text-charcoal/50">{label}</div>
      <div className={`font-display text-2xl mt-1 tabular-nums ${text}`}>{fmtCurrency(value)}</div>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-medium ${className}`} scope="col">{children}</th>;
}
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-1.5 ${className}`}>{children}</td>;
}
function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
