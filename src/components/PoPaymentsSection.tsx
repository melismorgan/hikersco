'use client';

/**
 * PO-level payment summary — one row per PO #. Edit modal lets the user
 * (a) set the PLAN: deposit %, deposit due date, balance due date, notes;
 * (b) record actual transactions as a list — N deposits, balances, and
 *     shipping payments per PO, each carrying an optional platform fee.
 *
 * Transactions support real workflows: deposit split across two transfers,
 * balance paid in stages with delivery batches, shipping paid separately
 * to the freight forwarder. Computed totals (PO Total, Deposit Amount,
 * Balance Amount) come from line items at read time; paid amounts and fees
 * are sums over the transactions tab.
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { PoSummary, PaymentStatus, PoPaymentTxn, Shipment } from '@/lib/inventory';
import {
  updatePoPayment,
  addPoPaymentTransaction,
  updatePoPaymentTransaction,
  deletePoPaymentTransactions,
  deleteShipment,
  type PoPaymentUpdateFields,
} from '@/app/pos/actions';
import { ShipmentEditor, ShipmentStatusPill } from './ShipmentEditor';

interface Props {
  summaries: PoSummary[];
}

const PAYMENT_STATUSES: PaymentStatus[] = [
  'Pending Deposit',
  'Awaiting Balance',
  'Paid In Full',
  'Cancelled',
];

export function PoPaymentsSection({ summaries }: Props) {
  const [filter, setFilter] = useState<PaymentStatus | 'All'>('All');
  const [editing, setEditing] = useState<PoSummary | null>(null);

  const counts = useMemo(() => {
    const out: Record<PaymentStatus, number> = {
      'Pending Deposit': 0,
      'Awaiting Balance': 0,
      'Paid In Full': 0,
      'Cancelled': 0,
    };
    for (const s of summaries) out[s.paymentStatus]++;
    return out;
  }, [summaries]);

  const totals = useMemo(() => {
    let outstandingDeposit = 0;
    let outstandingBalance = 0;
    let paidYTD = 0;
    let shippingPaid = 0;
    let totalFees = 0;
    for (const s of summaries) {
      if (s.paymentStatus === 'Cancelled') continue;
      outstandingDeposit += s.depositRemaining;
      outstandingBalance += s.balanceRemaining;
      paidYTD            += s.depositPaidAmount + s.balancePaidAmount + s.shippingPaidAmount;
      shippingPaid       += s.shippingPaidAmount;
      totalFees          += s.totalFees;
    }
    return { outstandingDeposit, outstandingBalance, paidYTD, shippingPaid, totalFees };
  }, [summaries]);

  const visible = useMemo(() => {
    if (filter === 'All') return summaries;
    return summaries.filter((s) => s.paymentStatus === filter);
  }, [summaries, filter]);

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-xl">Payments</h2>
          <p className="text-xs text-charcoal/60 mt-1">
            One row per PO. Click a row to set deposit terms and record transactions — multiple deposit or balance transfers per PO are supported.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <KpiTile label="Outstanding deposit" value={fmtCurrency(totals.outstandingDeposit)} accent="indigo" />
          <KpiTile label="Outstanding balance" value={fmtCurrency(totals.outstandingBalance)} accent="ironclad" />
          <KpiTile label="Shipping paid"        value={fmtCurrency(totals.shippingPaid)}      accent="periwinkle" />
          <KpiTile label="Fees"                 value={fmtCurrency(totals.totalFees)}         accent="sage" />
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm flex-wrap">
        <span className="text-charcoal/60">Filter:</span>
        <button
          onClick={() => setFilter('All')}
          className={`px-2 py-1 rounded ${filter === 'All' ? 'bg-indigo text-warm-white' : 'bg-warm-beige/40 hover:bg-warm-beige'}`}
        >
          All ({summaries.length})
        </button>
        {PAYMENT_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-2 py-1 rounded ${filter === s ? 'bg-indigo text-warm-white' : 'bg-warm-beige/40 hover:bg-warm-beige'}`}
          >
            {s} ({counts[s]})
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-warm-gray/40 bg-warm-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr className="bg-periwinkle/15 text-charcoal/80 text-xs uppercase tracking-wider">
                <Th className="text-left">PO #</Th>
                <Th className="text-left">Supplier</Th>
                <Th className="text-left">Order Date</Th>
                <Th className="text-right">Units</Th>
                <Th className="text-right">PO Total</Th>
                <Th className="text-right">Deposit</Th>
                <Th className="text-left">Deposit Paid</Th>
                <Th className="text-right">Balance</Th>
                <Th className="text-left">Balance Paid</Th>
                <Th className="text-left">Shipping</Th>
                <Th className="text-left">Payment Status</Th>
                <Th className="text-right">{''}</Th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={12} className="text-center text-charcoal/60 py-8">No POs match this filter.</td></tr>
              )}
              {visible.map((s, i) => (
                <tr
                  key={s.poNumber}
                  className={`${i % 2 === 0 ? 'bg-warm-white' : 'bg-warm-beige/20'} border-b border-warm-gray/20 hover:bg-indigo/5 cursor-pointer`}
                  onClick={() => setEditing(s)}
                >
                  <Td className="font-mono text-xs">{s.poNumber}</Td>
                  <Td>{s.supplier || '—'}</Td>
                  <Td className="text-xs">{s.orderDate || '—'}</Td>
                  <Td className="text-right tabular-nums">{s.totalUnits.toLocaleString()}</Td>
                  <Td className="text-right tabular-nums">{fmtCurrency(s.totalCost)}</Td>
                  <Td className="text-right tabular-nums">
                    <span className="text-charcoal/60">{Math.round(s.depositPct * 100)}% · </span>
                    {fmtCurrency(s.depositAmount)}
                  </Td>
                  <Td className="text-xs"><LegPaidCell expected={s.depositAmount} paid={s.depositPaidAmount} latestDate={s.depositPaidDate} dueDate={s.depositDueDate} txnCount={s.transactions.filter((t) => t.type === 'Deposit').length} /></Td>
                  <Td className="text-right tabular-nums">{fmtCurrency(s.balanceAmount)}</Td>
                  <Td className="text-xs"><LegPaidCell expected={s.balanceAmount} paid={s.balancePaidAmount} latestDate={s.balancePaidDate} dueDate={s.balanceDueDate} txnCount={s.transactions.filter((t) => t.type === 'Balance').length} /></Td>
                  <Td className="text-xs"><ShippingCell paid={s.shippingPaidAmount} latestDate={s.shippingPaidDate} txnCount={s.transactions.filter((t) => t.type === 'Shipping').length} /></Td>
                  <Td><PaymentPill status={s.paymentStatus} /></Td>
                  <Td className="text-right">
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditing(s); }}
                      className="text-xs text-indigo hover:underline"
                    >
                      Edit
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <PaymentEditModal po={editing} onClose={() => setEditing(null)} />
      )}
    </section>
  );
}

// --- LegPaidCell: shows progress for the deposit OR balance leg --------------

function LegPaidCell({
  expected, paid, latestDate, dueDate, txnCount,
}: {
  expected: number;
  paid: number;
  latestDate: string;
  dueDate: string;
  txnCount: number;
}) {
  if (paid <= 0) {
    if (dueDate) return <DueLabel date={dueDate} />;
    return <span className="text-charcoal/40">—</span>;
  }
  const fullyPaid = paid >= expected - 0.005;
  if (fullyPaid) {
    return (
      <span className="text-sage font-medium">
        ✓ {latestDate || ''}
        {txnCount > 1 && <span className="ml-1 text-charcoal/50 font-normal">({txnCount} tx)</span>}
      </span>
    );
  }
  // Partial — show paid/expected
  return (
    <span className="text-clay font-medium">
      {fmtCurrency(paid)} of {fmtCurrency(expected)}
      <span className="ml-1 text-charcoal/50 font-normal">
        ({txnCount} tx{txnCount === 1 ? '' : 's'})
      </span>
    </span>
  );
}

function ShippingCell({ paid, latestDate, txnCount }: { paid: number; latestDate: string; txnCount: number }) {
  if (paid <= 0) return <span className="text-charcoal/40">—</span>;
  return (
    <span className="text-periwinkle font-medium">
      {fmtCurrency(paid)}
      <span className="ml-1 text-charcoal/50 font-normal">
        · {latestDate || ''} ({txnCount} tx)
      </span>
    </span>
  );
}

// --- Edit modal --------------------------------------------------------------

function PaymentEditModal({ po, onClose }: { po: PoSummary; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Plan form state
  const [depositPct,     setDepositPct]     = useState(String(Math.round(po.depositPct * 100)));
  const [depositDueDate, setDepositDueDate] = useState(po.depositDueDate);
  const [balanceDueDate, setBalanceDueDate] = useState(po.balanceDueDate);
  const [notes,          setNotes]          = useState(po.paymentNotes);

  // Add-transaction form (collapsed by default; expands on click)
  const [showAddForm,    setShowAddForm]    = useState(false);
  const [addType,        setAddType]        = useState<'Deposit' | 'Balance' | 'Shipping'>(
    po.depositPaidAmount >= po.depositAmount - 0.005 ? 'Balance' : 'Deposit'
  );
  const [addDate,        setAddDate]        = useState(new Date().toISOString().slice(0, 10));
  const [addAmount,      setAddAmount]      = useState('');
  const [addFee,         setAddFee]         = useState('');
  const [addNotes,       setAddNotes]       = useState('');
  const [addShipmentId,  setAddShipmentId]  = useState('');

  // Re-compute previews so deposit % edits show live numbers
  const previewPct = (() => {
    const n = Number(depositPct);
    if (!Number.isFinite(n) || n < 0 || n > 100) return po.depositPct;
    return n / 100;
  })();
  const previewDeposit = po.totalCost * previewPct;
  const previewBalance = Math.max(po.totalCost - previewDeposit, 0);

  const depositTxns  = po.transactions.filter((t) => t.type === 'Deposit');
  const balanceTxns  = po.transactions.filter((t) => t.type === 'Balance');
  const shippingTxns = po.transactions.filter((t) => t.type === 'Shipping');

  function savePlan(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const pctNum = Number(depositPct);
    if (!Number.isFinite(pctNum) || pctNum < 0 || pctNum > 100) {
      setError('Deposit % must be between 0 and 100.');
      return;
    }
    const fields: PoPaymentUpdateFields = {
      depositPct: pctNum / 100,
      depositDueDate,
      balanceDueDate,
      notes,
    };
    startTransition(async () => {
      const res = await updatePoPayment(po.poNumber, fields);
      if (!res.ok) {
        setError(res.error ?? 'Update failed.');
        return;
      }
      router.refresh();
      onClose();
    });
  }

  function addTransaction() {
    setError(null);
    const amount = Number(addAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Amount must be a positive number.');
      return;
    }
    let fee = 0;
    if (addFee !== '') {
      fee = Number(addFee);
      if (!Number.isFinite(fee) || fee < 0) {
        setError('Fee must be a non-negative number (or blank).');
        return;
      }
    }
    if (!addDate) {
      setError('Date is required.');
      return;
    }
    startTransition(async () => {
      const res = await addPoPaymentTransaction(po.poNumber, {
        type: addType, date: addDate, amount, fee, notes: addNotes,
        shipmentId: addType === 'Shipping' ? addShipmentId : '',
      });
      if (!res.ok) {
        setError(res.error ?? 'Add failed.');
        return;
      }
      // Reset add form, keep modal open so user sees the new transaction.
      setAddAmount('');
      setAddFee('');
      setAddNotes('');
      setAddShipmentId('');
      setShowAddForm(false);
      router.refresh();
    });
  }

  function handleDelete(rowIndex: number) {
    if (!confirm('Delete this transaction? This cannot be undone.')) return;
    setError(null);
    startTransition(async () => {
      const res = await deletePoPaymentTransactions([rowIndex]);
      if (!res.ok) {
        setError(res.error ?? 'Delete failed.');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="fixed inset-0 bg-charcoal/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-warm-white rounded-lg border border-warm-gray/40 shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-warm-gray/40">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-display text-xl">{po.poNumber} payment</h3>
              <p className="text-xs text-charcoal/60 mt-1">
                {po.supplier} · {po.totalUnits.toLocaleString()} units · {fmtCurrency(po.totalCost)} total · {po.lineCount} line{po.lineCount === 1 ? '' : 's'}
              </p>
            </div>
            <PaymentPill status={po.paymentStatus} />
          </div>
        </div>

        {/* Plan section — saves with the form button */}
        <form onSubmit={savePlan} className="p-6 border-b border-warm-gray/40 space-y-4">
          <div className="flex items-baseline justify-between">
            <h4 className="font-medium">Plan</h4>
            <span className="text-xs text-charcoal/50">deposit %, due dates, notes</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="Deposit %">
              <input
                type="number" min={0} max={100} step={1}
                value={depositPct}
                onChange={(e) => setDepositPct(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm tabular-nums"
              />
            </Field>
            <Field label="Deposit due">
              <input type="date" value={depositDueDate} onChange={(e) => setDepositDueDate(e.target.value)} className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm" />
            </Field>
            <Field label="Balance due">
              <input type="date" value={balanceDueDate} onChange={(e) => setBalanceDueDate(e.target.value)} className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm" />
            </Field>
          </div>
          <Field label="Notes" hint="Alibaba TA #, exchange rate, etc.">
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm"
              placeholder="e.g. Alibaba TA #800123456789 · CNY→USD 0.138"
            />
          </Field>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div className="rounded border border-warm-gray/40 bg-warm-beige/30 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-charcoal/50">Deposit</div>
              <div className="tabular-nums">{fmtCurrency(previewDeposit)}</div>
              <div className="text-xs text-charcoal/50">paid {fmtCurrency(po.depositPaidAmount)}</div>
            </div>
            <div className="rounded border border-warm-gray/40 bg-warm-beige/30 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-charcoal/50">Balance</div>
              <div className="tabular-nums">{fmtCurrency(previewBalance)}</div>
              <div className="text-xs text-charcoal/50">paid {fmtCurrency(po.balancePaidAmount)}</div>
            </div>
            <div className="rounded border border-warm-gray/40 bg-warm-beige/30 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-charcoal/50">Shipping</div>
              <div className="tabular-nums">{fmtCurrency(po.shippingPaidAmount)}</div>
              <div className="text-xs text-charcoal/50">{shippingTxns.length} tx · no plan</div>
            </div>
            <div className="rounded border border-warm-gray/40 bg-warm-beige/30 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-charcoal/50">Fees + landed</div>
              <div className="tabular-nums">{fmtCurrency(po.totalFees)} <span className="text-charcoal/50 text-xs">fees</span></div>
              <div className="text-xs text-charcoal/50">landed: {fmtCurrency(po.landedCost)}</div>
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={pending}
              className="px-4 py-2 rounded-md bg-indigo text-warm-white text-sm font-medium hover:bg-indigo/90 disabled:opacity-50"
            >
              {pending ? 'Saving…' : 'Save plan'}
            </button>
          </div>
        </form>

        {/* Shipments section — physical shipments for this PO */}
        <ShipmentsPanel po={po} />

        {/* Transactions section — each transaction is its own server action */}
        <div className="p-6 space-y-4 border-t border-warm-gray/40">
          <div className="flex items-baseline justify-between">
            <h4 className="font-medium">Transactions</h4>
            <span className="text-xs text-charcoal/50">{po.transactions.length} record{po.transactions.length === 1 ? '' : 's'}</span>
          </div>

          {po.transactions.length > 0 && (
            <div className="rounded-md border border-warm-gray/40 bg-warm-white overflow-hidden">
              <table className="w-full text-sm border-separate border-spacing-0">
                <thead>
                  <tr className="bg-warm-beige/40 text-charcoal/70 text-[11px] uppercase tracking-wider">
                    <Th className="text-left">Type</Th>
                    <Th className="text-left">Date</Th>
                    <Th className="text-right">Amount</Th>
                    <Th className="text-right">Fee</Th>
                    <Th className="text-left">Shipment</Th>
                    <Th className="text-left">Notes</Th>
                    <Th className="text-right w-16">{''}</Th>
                  </tr>
                </thead>
                <tbody>
                  {po.transactions.map((t, i) => (
                    <tr key={t.rowIndex} className={`${i % 2 === 0 ? 'bg-warm-white' : 'bg-warm-beige/15'} border-b border-warm-gray/20`}>
                      <Td><TxnTypePill type={t.type} /></Td>
                      <Td className="text-xs">{t.date || '—'}</Td>
                      <Td className="text-right tabular-nums">{fmtCurrency(t.amount)}</Td>
                      <Td className="text-right tabular-nums text-charcoal/70">{t.fee > 0 ? fmtCurrency(t.fee) : <span className="text-charcoal/30">—</span>}</Td>
                      <Td className="text-xs font-mono text-charcoal/70">
                        {t.shipmentId
                          ? <span>{t.shipmentId}</span>
                          : t.type === 'Shipping' ? <span className="text-charcoal/40">unassigned</span> : <span className="text-charcoal/30">—</span>}
                      </Td>
                      <Td className="text-xs text-charcoal/70">{t.notes || ''}</Td>
                      <Td className="text-right">
                        <button
                          onClick={() => handleDelete(t.rowIndex)}
                          disabled={pending}
                          className="text-xs text-ironclad hover:underline disabled:opacity-40"
                          title="Delete transaction"
                        >
                          Delete
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="text-xs text-charcoal/60">
                    <Td colSpan={7} className="text-left">
                      Deposit: {fmtCurrency(po.depositPaidAmount)} of {fmtCurrency(po.depositAmount)} ({depositTxns.length} tx)
                      {' · '}
                      Balance: {fmtCurrency(po.balancePaidAmount)} of {fmtCurrency(po.balanceAmount)} ({balanceTxns.length} tx)
                      {shippingTxns.length > 0 && <> {' · '} Shipping: {fmtCurrency(po.shippingPaidAmount)} ({shippingTxns.length} tx)</>}
                      {po.totalFees > 0 && <> {' · '} Fees: {fmtCurrency(po.totalFees)}</>}
                    </Td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {!showAddForm ? (
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="w-full px-4 py-2 rounded-md border border-dashed border-indigo/40 text-indigo text-sm font-medium hover:bg-indigo/5"
            >
              + Add payment transaction
            </button>
          ) : (
            <div className="rounded-md border border-indigo/40 bg-indigo/5 p-4 space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Field label="Type">
                  <select
                    value={addType}
                    onChange={(e) => setAddType(e.target.value as 'Deposit' | 'Balance' | 'Shipping')}
                    className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm"
                  >
                    <option value="Deposit">Deposit</option>
                    <option value="Balance">Balance</option>
                    <option value="Shipping">Shipping</option>
                  </select>
                </Field>
                <Field label="Date">
                  <input type="date" value={addDate} onChange={(e) => setAddDate(e.target.value)} className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm" />
                </Field>
                <Field label="Amount" hint="principal sent">
                  <input
                    type="number" min={0} step={0.01}
                    placeholder={
                      addType === 'Deposit' ? Math.max(po.depositAmount - po.depositPaidAmount, 0).toFixed(2) :
                      addType === 'Balance' ? Math.max(po.balanceAmount - po.balancePaidAmount, 0).toFixed(2) :
                      '0.00'
                    }
                    value={addAmount}
                    onChange={(e) => setAddAmount(e.target.value)}
                    className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm tabular-nums"
                  />
                </Field>
                <Field label="Fee" hint="Alibaba/platform fee, blank = 0">
                  <input
                    type="number" min={0} step={0.01}
                    placeholder="0.00"
                    value={addFee}
                    onChange={(e) => setAddFee(e.target.value)}
                    className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm tabular-nums"
                  />
                </Field>
              </div>
              {addType === 'Shipping' && (
                <Field label="Assign to shipment" hint="optional — leave blank to record without linking">
                  <select
                    value={addShipmentId}
                    onChange={(e) => setAddShipmentId(e.target.value)}
                    className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm"
                  >
                    <option value="">(unassigned)</option>
                    {po.shipments.map((s) => (
                      <option key={s.shipmentId} value={s.shipmentId}>
                        {s.shipmentId} — {s.mode || '?'} → {s.destination || '?'}{s.label ? ` · ${s.label}` : ''}
                      </option>
                    ))}
                  </select>
                  {po.shipments.length === 0 && (
                    <div className="text-[11px] text-charcoal/50 mt-1">
                      No shipments yet for this PO. You can still record this transaction; assign it later by editing the row.
                    </div>
                  )}
                </Field>
              )}
              <Field label="Notes">
                <input
                  type="text"
                  placeholder="e.g. 1 of 2 · TA receipt # · freight forwarder name"
                  value={addNotes}
                  onChange={(e) => setAddNotes(e.target.value)}
                  className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm"
                />
              </Field>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setShowAddForm(false); setAddAmount(''); setAddFee(''); setAddNotes(''); }}
                  className="px-3 py-1.5 rounded border border-warm-gray/60 text-sm hover:bg-warm-beige/40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={addTransaction}
                  disabled={pending}
                  className="px-3 py-1.5 rounded bg-indigo text-warm-white text-sm font-medium hover:bg-indigo/90 disabled:opacity-50"
                >
                  {pending ? 'Saving…' : 'Add transaction'}
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded border border-ironclad/40 bg-ironclad/10 px-3 py-2 text-sm text-ironclad">{error}</div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-warm-gray/30">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-md border border-warm-gray/60 text-sm hover:bg-warm-beige/40">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Shipments panel ---------------------------------------------------------

function ShipmentsPanel({ po }: { po: PoSummary }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Shipment | 'new' | null>(null);

  function handleDelete(shipmentId: string) {
    if (!confirm(`Delete shipment ${shipmentId}? Its line allocations will also be removed. Any shipping payments tagged with it will become unassigned (still count toward PO totals).`)) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteShipment(shipmentId);
      if (!res.ok) {
        setError(res.error ?? 'Delete failed.');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="p-6 border-t border-warm-gray/40 space-y-4">
      <div className="flex items-baseline justify-between">
        <h4 className="font-medium">Shipments</h4>
        <span className="text-xs text-charcoal/50">{po.shipments.length} shipment{po.shipments.length === 1 ? '' : 's'}</span>
      </div>

      {po.shipments.length > 0 && (
        <div className="rounded-md border border-warm-gray/40 bg-warm-white overflow-hidden">
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr className="bg-warm-beige/40 text-charcoal/70 text-[11px] uppercase tracking-wider">
                <Th className="text-left">ID</Th>
                <Th className="text-left">Mode → Dest</Th>
                <Th className="text-left">ETA</Th>
                <Th className="text-left">Status</Th>
                <Th className="text-left">Lines</Th>
                <Th className="text-left">Receiving</Th>
                <Th className="text-right">Shipping paid</Th>
                <Th className="text-right">{''}</Th>
              </tr>
            </thead>
            <tbody>
              {po.shipments.map((s, i) => {
                const lineUnits = s.lines.reduce((a, l) => a + l.qty, 0);
                return (
                  <tr key={s.shipmentId} className={`${i % 2 === 0 ? 'bg-warm-white' : 'bg-warm-beige/15'} border-b border-warm-gray/20`}>
                    <Td className="font-mono text-xs">{s.shipmentId}</Td>
                    <Td className="text-xs">
                      <span className="font-medium">{s.mode || '—'}</span>
                      <span className="text-charcoal/50"> → {s.destination || '—'}</span>
                      {s.label && <div className="text-charcoal/50 text-[11px]">{s.label}</div>}
                    </Td>
                    <Td className="text-xs">{s.eta || '—'}</Td>
                    <Td><ShipmentStatusPill status={s.status} /></Td>
                    <Td className="text-xs">
                      {s.lines.length === 0
                        ? <span className="text-charcoal/40">none</span>
                        : <span>{s.lines.length} SKU{s.lines.length === 1 ? '' : 's'} · {lineUnits.toLocaleString()} units</span>}
                    </Td>
                    <Td className="text-xs text-charcoal/70">{s.receivingOrderId || <span className="text-charcoal/40">—</span>}</Td>
                    <Td className="text-right tabular-nums">
                      {s.shippingPaidAmount > 0
                        ? <>{fmtCurrency(s.shippingPaidAmount)} <span className="text-charcoal/50 text-[11px]">({s.shippingTxnCount} tx)</span></>
                        : <span className="text-charcoal/40">—</span>}
                    </Td>
                    <Td className="text-right">
                      <button onClick={() => setEditing(s)}              className="text-xs text-indigo hover:underline">Edit</button>
                      <span className="mx-1 text-charcoal/30">·</span>
                      <button onClick={() => handleDelete(s.shipmentId)} disabled={pending} className="text-xs text-ironclad hover:underline disabled:opacity-40">Delete</button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && (
        <div className="rounded border border-ironclad/40 bg-ironclad/10 px-3 py-2 text-sm text-ironclad">{error}</div>
      )}

      <button
        type="button"
        onClick={() => setEditing('new')}
        className="w-full px-4 py-2 rounded-md border border-dashed border-indigo/40 text-indigo text-sm font-medium hover:bg-indigo/5"
      >
        + Plan shipment
      </button>

      {editing && (
        <ShipmentEditor
          po={po}
          shipment={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ShipmentEditor + ShipmentStatusPill moved to ./ShipmentEditor.tsx
// for reuse on the standalone /shipments page.


// --- Small helpers -----------------------------------------------------------

function PaymentPill({ status }: { status: PaymentStatus }) {
  const cls =
    status === 'Paid In Full'      ? 'bg-sage/20 text-sage' :
    status === 'Awaiting Balance'  ? 'bg-clay/20 text-clay' :
    status === 'Pending Deposit'   ? 'bg-indigo/15 text-indigo' :
    /* Cancelled */                  'bg-cancelled text-charcoal/50';
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{status}</span>;
}

function TxnTypePill({ type }: { type: PoPaymentTxn['type'] }) {
  const cls =
    type === 'Deposit'  ? 'bg-indigo/15 text-indigo' :
    type === 'Balance'  ? 'bg-periwinkle/20 text-periwinkle' :
    /* Shipping */        'bg-clay/15 text-clay';
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${cls}`}>{type}</span>;
}

function DueLabel({ date }: { date: string }) {
  const ts = Date.parse(date);
  if (!Number.isFinite(ts)) return <span className="text-charcoal/60">Due {date}</span>;
  const days = Math.floor((ts - Date.now()) / 86_400_000);
  if (days < 0) return <span className="text-ironclad font-medium">Overdue · {date}</span>;
  if (days <= 7) return <span className="text-clay font-medium">Due in {days}d · {date}</span>;
  return <span className="text-charcoal/60">Due {date}</span>;
}

function KpiTile({ label, value, accent }: { label: string; value: string; accent: 'indigo' | 'ironclad' | 'periwinkle' | 'sage' }) {
  const ring =
    accent === 'indigo'     ? 'border-indigo/30' :
    accent === 'ironclad'   ? 'border-ironclad/30' :
    accent === 'periwinkle' ? 'border-periwinkle/40' :
                              'border-sage/30';
  return (
    <div className={`rounded border ${ring} bg-warm-white px-3 py-2`}>
      <div className="text-[10px] uppercase tracking-wider text-charcoal/50">{label}</div>
      <div className="font-display text-lg tabular-nums">{value}</div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children?: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-charcoal/60 mb-1">
        {label}
        {hint && <span className="ml-1 normal-case tracking-normal text-charcoal/40">· {hint}</span>}
      </div>
      {children}
    </label>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-medium ${className}`} scope="col">{children}</th>;
}
function Td({ children, className = '', colSpan }: { children?: React.ReactNode; className?: string; colSpan?: number }) {
  return <td className={`px-3 py-1.5 ${className}`} colSpan={colSpan}>{children}</td>;
}
function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
