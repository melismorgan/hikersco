'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { PoRow } from '@/lib/inventory';
import { createPo, updatePo, bulkUpdatePos, bulkCancelPos, deletePos, type PoUpdateFields } from '@/app/pos/actions';

interface Props {
  rows: PoRow[];
}

const STATUSES = ['Draft', 'Incoming', 'Received', 'Cancelled'] as const;
type Status = typeof STATUSES[number];

export function PosView({ rows }: Props) {
  const [filter, setFilter] = useState<Status | 'All'>('All');
  const [query, setQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PoRow | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());  // by rowIndex
  const [showBulkEdit, setShowBulkEdit] = useState(false);

  const toggleSelected = (rowIndex: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  const counts = useMemo(() => {
    const out: Record<Status, number> = { Draft: 0, Incoming: 0, Received: 0, Cancelled: 0 };
    for (const r of rows) {
      const s = r.status as Status;
      if (s in out) out[s]++;
    }
    return out;
  }, [rows]);

  const totals = useMemo(() => {
    const out: Record<Status, { qty: number; cost: number }> = {
      Draft:     { qty: 0, cost: 0 },
      Incoming:  { qty: 0, cost: 0 },
      Received:  { qty: 0, cost: 0 },
      Cancelled: { qty: 0, cost: 0 },
    };
    for (const r of rows) {
      const s = r.status as Status;
      if (s in out) {
        out[s].qty += r.qty;
        out[s].cost += r.qty * r.unitCost;
      }
    }
    return out;
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== 'All' && r.status !== filter) return false;
      if (!q) return true;
      return (
        r.sku.toLowerCase().includes(q) ||
        r.poNumber.toLowerCase().includes(q) ||
        r.supplier.toLowerCase().includes(q) ||
        r.notes.toLowerCase().includes(q)
      );
    });
  }, [rows, filter, query]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setFilter((cur) => (cur === s ? 'All' : s))}
            className={`text-left rounded-lg border bg-warm-white p-4 transition-colors ${
              filter === s ? 'border-indigo bg-indigo/5' : 'border-warm-gray/40 hover:border-indigo/40'
            }`}
          >
            <div className="text-xs uppercase tracking-wider text-charcoal/50">{s}</div>
            <div className="font-display text-2xl mt-1">{counts[s].toLocaleString()}</div>
            <div className="text-xs text-charcoal/60 mt-1">
              {totals[s].qty.toLocaleString()} units{totals[s].cost > 0 ? ` · ${fmtCurrency(totals[s].cost)}` : ''}
            </div>
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-warm-gray/40 bg-warm-white p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-charcoal/60">Filter:</span>
              <button onClick={() => setFilter('All')} className={`px-2 py-1 rounded ${filter === 'All' ? 'bg-indigo text-warm-white' : 'bg-warm-beige/40 hover:bg-warm-beige'}`}>
                All ({rows.length})
              </button>
              {STATUSES.map((s) => (
                <button key={s} onClick={() => setFilter(s)} className={`px-2 py-1 rounded ${filter === s ? 'bg-indigo text-warm-white' : 'bg-warm-beige/40 hover:bg-warm-beige'}`}>
                  {s} ({counts[s]})
                </button>
              ))}
            </div>
            <input
              type="text"
              placeholder="Search SKU, PO #, supplier, notes…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 min-w-[200px] max-w-md px-3 py-2 rounded-md border border-warm-gray/60 bg-warm-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo/40"
            />
          </div>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="px-4 py-2 rounded-md bg-indigo text-warm-white text-sm font-medium hover:bg-indigo/90"
          >
            {showForm ? 'Close form' : '+ New PO'}
          </button>
        </div>
      </div>

      {showForm && <NewPoForm onDone={() => setShowForm(false)} />}
      {editing && <EditPoModal po={editing} onClose={() => setEditing(null)} />}
      {showBulkEdit && (
        <BulkEditModal
          rowCount={selected.size}
          rowIndices={Array.from(selected)}
          onDone={() => {
            setShowBulkEdit(false);
            clearSelection();
          }}
          onCancel={() => setShowBulkEdit(false)}
        />
      )}

      {selected.size > 0 && (
        <BulkToolbar
          rowIndices={Array.from(selected)}
          visibleCount={visible.filter((r) => selected.has(r.rowIndex)).length}
          onClear={clearSelection}
          onOpenBulkEdit={() => setShowBulkEdit(true)}
        />
      )}

      <div className="rounded-lg border border-warm-gray/40 bg-warm-white">
        <div className="dash-scroll">
          <table className="dash-table w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr className="bg-periwinkle/15 text-charcoal/80 text-xs uppercase tracking-wider">
                <Th className="w-8 text-center">
                  <input
                    type="checkbox"
                    aria-label="Select all visible"
                    className="accent-indigo"
                    checked={visible.length > 0 && visible.every((r) => selected.has(r.rowIndex))}
                    onChange={(e) => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) visible.forEach((r) => next.add(r.rowIndex));
                        else visible.forEach((r) => next.delete(r.rowIndex));
                        return next;
                      });
                    }}
                  />
                </Th>
                <Th className="text-left">Status</Th>
                <Th className="text-left">PO #</Th>
                <Th className="text-left">Supplier</Th>
                <Th className="text-left">Mode</Th>
                <Th className="text-left">Order Date</Th>
                <Th className="text-left">ETA</Th>
                <Th className="text-left font-mono">SKU</Th>
                <Th className="text-right">Qty</Th>
                <Th className="text-right">Unit Cost</Th>
                <Th className="text-right">Line Total</Th>
                <Th className="text-left">Notes</Th>
                <Th className="text-right">{''}</Th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={13} className="text-center text-charcoal/60 py-8">No POs match.</td></tr>
              )}
              {visible.map((r, i) => (
                <tr key={`${r.poNumber}-${r.sku}-${i}`} className={`${i % 2 === 0 ? 'bg-warm-white' : 'bg-warm-beige/20'} ${selected.has(r.rowIndex) ? 'bg-indigo/10' : ''} border-b border-warm-gray/20 hover:bg-indigo/5`}>
                  <Td className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.sku}`}
                      className="accent-indigo"
                      checked={selected.has(r.rowIndex)}
                      onChange={() => toggleSelected(r.rowIndex)}
                    />
                  </Td>
                  <Td><StatusPill status={r.status} /></Td>
                  <Td className="font-mono text-xs">{r.poNumber || '—'}</Td>
                  <Td>{r.supplier || '—'}</Td>
                  <Td>{r.mode || '—'}</Td>
                  <Td>{r.orderDate || '—'}</Td>
                  <Td>{r.eta || '—'}</Td>
                  <Td className="font-mono text-xs">
                    <a href={`/sku/${encodeURIComponent(r.sku)}`} className="hover:text-indigo hover:underline">{r.sku}</a>
                  </Td>
                  <Td className="text-right font-mono">{r.qty.toLocaleString()}</Td>
                  <Td className="text-right font-mono">{r.unitCost > 0 ? `$${r.unitCost.toFixed(2)}` : '—'}</Td>
                  <Td className="text-right font-mono">{r.unitCost > 0 ? fmtCurrency(r.qty * r.unitCost) : '—'}</Td>
                  <Td className="text-charcoal/70 max-w-md truncate" >{r.notes}</Td>
                  <Td className="text-right whitespace-nowrap">
                    <button
                      onClick={() => setEditing(r)}
                      className="text-xs text-indigo hover:underline"
                      title="Edit this PO line"
                    >
                      Edit
                    </button>
                    <span className="text-warm-gray mx-1">·</span>
                    {r.poNumber ? (
                      <a
                        href={`/api/po/${encodeURIComponent(r.poNumber)}/pdf`}
                        className="text-xs text-indigo hover:underline"
                        title={`Generate the full PDF for ${r.poNumber} (all lines on this PO #)`}
                      >
                        PDF
                      </a>
                    ) : (
                      <span
                        className="text-xs text-charcoal/30 cursor-not-allowed"
                        title="Set a PO # on this row to enable the PDF download"
                      >
                        PDF
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function NewPoForm({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const res = await createPo(fd);
      if (!res.ok) {
        setError(res.error ?? 'Unknown error.');
        return;
      }
      onDone();
      router.refresh();
    });
  };

  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-indigo/30 bg-indigo/5 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl">New PO</h2>
        <span className="text-xs text-charcoal/60">Writes one row to the POs tab.</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Field label="SKU" name="sku" required placeholder="H503-2-BK-XL" />
        <Field label="Qty" name="qty" type="number" required placeholder="500" min="1" />
        <Field label="Unit cost" name="unitCost" type="number" step="0.01" placeholder="3.25" min="0" />
        <Field label="Status" name="status" defaultValue="Draft" type="select" options={['Draft', 'Incoming', 'Received', 'Cancelled']} />
        <Field label="Mode" name="mode" type="select" options={['', 'Air', 'Sea']} />
        <Field label="Supplier" name="supplier" placeholder="RX Suspenders" />
        <Field label="Order date" name="orderDate" type="date" defaultValue={today} />
        <Field label="ETA" name="eta" type="date" />
        <Field label="PO #" name="poNumber" placeholder="auto / your code" />
      </div>
      <Field label="Notes" name="notes" placeholder="Optional notes — visible in the sheet" full />
      {error && (
        <div className="rounded border border-ironclad/40 bg-ironclad/5 px-3 py-2 text-sm text-ironclad">
          {error}
        </div>
      )}
      <div className="flex items-center justify-end gap-3">
        <button type="button" onClick={onDone} className="px-3 py-2 rounded-md text-sm text-charcoal/70 hover:bg-warm-beige">
          Cancel
        </button>
        <button type="submit" disabled={pending} className="px-4 py-2 rounded-md bg-indigo text-warm-white text-sm font-medium hover:bg-indigo/90 disabled:opacity-50">
          {pending ? 'Saving…' : 'Save PO'}
        </button>
      </div>
    </form>
  );
}

/**
 * Sticky toolbar that appears whenever any rows are checked. Three actions:
 *   Bulk edit…         — open the multi-field modal for ETA/Mode/Status
 *   Cancel selected    — soft cancel, status=Cancelled, audit trail preserved
 *   Delete selected    — hard delete, rows permanently removed (with confirm)
 */
function BulkToolbar({ rowIndices, visibleCount, onClear, onOpenBulkEdit }: {
  rowIndices: number[];
  visibleCount: number;
  onClear: () => void;
  onOpenBulkEdit: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const count = rowIndices.length;

  const onCancel = () => {
    setFeedback(null);
    startTransition(async () => {
      const res = await bulkCancelPos(rowIndices);
      if (res.ok) {
        setFeedback({ tone: 'ok', text: `Cancelled ${res.updated} PO${res.updated === 1 ? '' : 's'} (kept on sheet for audit).` });
        onClear();
        router.refresh();
      } else {
        setFeedback({ tone: 'error', text: res.error ?? 'Cancel failed.' });
      }
    });
  };

  const onDelete = () => {
    setFeedback(null);
    const yes = window.confirm(
      `Permanently DELETE ${count} PO row${count === 1 ? '' : 's'}? This cannot be undone — for an audit trail, use Cancel instead.`,
    );
    if (!yes) return;
    startTransition(async () => {
      const res = await deletePos(rowIndices);
      if (res.ok) {
        setFeedback({ tone: 'ok', text: `Deleted ${res.deleted} row${res.deleted === 1 ? '' : 's'}.` });
        onClear();
        router.refresh();
      } else {
        setFeedback({ tone: 'error', text: res.error ?? 'Delete failed.' });
      }
    });
  };

  return (
    <div className="rounded-lg border border-indigo/30 bg-indigo-wash p-3 flex items-center gap-3 flex-wrap">
      <span className="text-sm">
        <span className="font-display text-lg text-indigo mr-1">{count}</span>
        <span className="text-charcoal/70">{count === 1 ? 'PO selected' : 'POs selected'}</span>
        {count > visibleCount && (
          <span className="text-charcoal/50 text-xs ml-2">
            ({visibleCount} visible · others off-screen via filter/search)
          </span>
        )}
      </span>
      {feedback && (
        <span className={`text-xs ${feedback.tone === 'ok' ? 'text-sage' : 'text-ironclad'}`}>{feedback.text}</span>
      )}
      <button
        onClick={onClear}
        disabled={pending}
        className="ml-auto text-xs text-charcoal/60 hover:text-charcoal disabled:opacity-50"
      >
        Clear
      </button>
      <button
        onClick={onOpenBulkEdit}
        disabled={pending}
        className="px-3 py-1.5 rounded-md bg-indigo text-warm-white text-sm font-medium hover:bg-indigo/90 disabled:opacity-50"
      >
        Bulk edit…
      </button>
      <button
        onClick={onCancel}
        disabled={pending}
        className="px-3 py-1.5 rounded-md border border-clay text-clay text-sm font-medium hover:bg-clay/10 disabled:opacity-50"
        title="Soft cancel — status flips to Cancelled, rows kept for audit trail"
      >
        Cancel selected
      </button>
      <button
        onClick={onDelete}
        disabled={pending}
        className="px-3 py-1.5 rounded-md border border-ironclad text-ironclad text-sm font-medium hover:bg-ironclad/10 disabled:opacity-50"
        title="Permanently delete rows — no audit trail. Use Cancel for official cancellations."
      >
        Delete
      </button>
    </div>
  );
}

/**
 * Edit modal for an existing PO row. Pre-populates from the row's current
 * values, sends a sparse update via updatePo(rowIndex, fields). The whole
 * thing is keyed off rowIndex so each line on a multi-line PO can be
 * edited independently.
 */
function EditPoModal({ po, onClose }: { po: PoRow; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const fields: PoUpdateFields = {
      poNumber:     String(fd.get('poNumber') ?? '').trim(),
      status:       String(fd.get('status') ?? po.status).trim(),
      supplier:     String(fd.get('supplier') ?? '').trim(),
      mode:         String(fd.get('mode') ?? '').trim(),
      orderDate:    String(fd.get('orderDate') ?? '').trim(),
      eta:          String(fd.get('eta') ?? '').trim(),
      sku:          String(fd.get('sku') ?? '').trim(),
      qty:          Number(fd.get('qty') ?? 0),
      unitCost:     Number(fd.get('unitCost') ?? 0),
      receivedDate: String(fd.get('receivedDate') ?? '').trim(),
      notes:        String(fd.get('notes') ?? '').trim(),
    };
    startTransition(async () => {
      const res = await updatePo(po.rowIndex, fields);
      if (!res.ok) {
        setError(res.error ?? 'Update failed.');
        return;
      }
      onClose();
      router.refresh();
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-charcoal/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <form
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-warm-white rounded-xl border border-warm-gray/40 max-w-2xl w-full p-5 space-y-4 shadow-xl"
      >
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-xl">Edit PO</h2>
          <span className="text-xs text-charcoal/50 font-mono">row {po.rowIndex}</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="SKU" name="sku" defaultValue={po.sku} required />
          <Field label="Qty" name="qty" type="number" defaultValue={String(po.qty)} required min="0" />
          <Field label="Unit cost" name="unitCost" type="number" step="0.01" defaultValue={po.unitCost ? String(po.unitCost) : ''} min="0" />
          <Field label="Status" name="status" type="select" defaultValue={po.status || 'Draft'} options={['Draft', 'Incoming', 'Received', 'Cancelled']} />
          <Field label="Mode" name="mode" type="select" defaultValue={po.mode} options={['', 'Air', 'Sea']} />
          <Field label="Supplier" name="supplier" defaultValue={po.supplier} />
          <Field label="Order date" name="orderDate" type="date" defaultValue={toDateInputValue(po.orderDate)} />
          <Field label="ETA" name="eta" type="date" defaultValue={toDateInputValue(po.eta)} />
          <Field label="Received date" name="receivedDate" type="date" defaultValue={toDateInputValue(po.receivedDate)} />
          <Field label="PO #" name="poNumber" defaultValue={po.poNumber} />
        </div>
        <Field label="Notes" name="notes" defaultValue={po.notes} full />
        {error && (
          <div className="rounded border border-ironclad/40 bg-ironclad/5 px-3 py-2 text-sm text-ironclad">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-md text-sm text-charcoal/70 hover:bg-warm-beige">
            Cancel
          </button>
          <button type="submit" disabled={pending} className="px-4 py-2 rounded-md bg-indigo text-warm-white text-sm font-medium hover:bg-indigo/90 disabled:opacity-50">
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Bulk-edit modal — applies one or more field values to a set of PO rows
 * in a single batched Sheets API call. Empty inputs are skipped, so you
 * can leave Mode/Status blank and only set ETA, etc.
 */
function BulkEditModal({ rowCount, rowIndices, onDone, onCancel }: {
  rowCount: number;
  rowIndices: number[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const eta    = String(fd.get('eta') ?? '').trim();
    const mode   = String(fd.get('mode') ?? '').trim();
    const status = String(fd.get('status') ?? '').trim();

    const fields: PoUpdateFields = {};
    if (eta)    fields.eta = eta;
    if (mode)   fields.mode = mode;
    if (status) fields.status = status;

    if (Object.keys(fields).length === 0) {
      setError('Set at least one field — leave the others blank to keep them.');
      return;
    }

    const updates = rowIndices.map((rowIndex) => ({ rowIndex, fields }));
    startTransition(async () => {
      const res = await bulkUpdatePos(updates);
      if (!res.ok) {
        setError(res.error ?? 'Bulk update failed.');
        return;
      }
      onDone();
      router.refresh();
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-charcoal/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <form
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-warm-white rounded-xl border border-warm-gray/40 max-w-lg w-full p-5 space-y-4 shadow-xl"
      >
        <div>
          <h2 className="font-display text-xl">Bulk edit</h2>
          <p className="text-sm text-charcoal/60 mt-1">
            Applying to <span className="font-semibold text-indigo">{rowCount}</span> {rowCount === 1 ? 'row' : 'rows'}.
            Leave a field blank to keep its current value across the selection.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Set ETA" name="eta" type="date" />
          <Field label="Set Mode" name="mode" type="select" options={['', 'Air', 'Sea']} />
          <Field label="Set Status" name="status" type="select" options={['', 'Draft', 'Incoming', 'Received', 'Cancelled']} />
        </div>
        {error && (
          <div className="rounded border border-ironclad/40 bg-ironclad/5 px-3 py-2 text-sm text-ironclad">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-3">
          <button type="button" onClick={onCancel} className="px-3 py-2 rounded-md text-sm text-charcoal/70 hover:bg-warm-beige">
            Cancel
          </button>
          <button type="submit" disabled={pending} className="px-4 py-2 rounded-md bg-indigo text-warm-white text-sm font-medium hover:bg-indigo/90 disabled:opacity-50">
            {pending ? 'Updating…' : `Apply to ${rowCount}`}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Coerce whatever date string the sheet returns ("5/30/2026", "2026-05-30",
 * "May 30, 2026") into the YYYY-MM-DD format that <input type="date">
 * requires. Falls back to empty if unparsable so the input renders blank.
 */
function toDateInputValue(raw: string): string {
  if (!raw) return '';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function Field({
  label, name, type = 'text', placeholder, defaultValue, required, options, step, min, full,
}: {
  label: string; name: string; type?: string; placeholder?: string; defaultValue?: string;
  required?: boolean; options?: string[]; step?: string; min?: string; full?: boolean;
}) {
  const wrapClass = full ? 'col-span-full' : '';
  const baseInput = 'w-full px-3 py-2 rounded-md border border-warm-gray/60 bg-warm-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo/40';
  return (
    <label className={`block text-xs font-medium text-charcoal/70 ${wrapClass}`}>
      <span className="block mb-1">{label}{required && <span className="text-ironclad ml-0.5">*</span>}</span>
      {type === 'select' ? (
        <select name={name} defaultValue={defaultValue ?? ''} className={baseInput}>
          {options!.map((o) => <option key={o} value={o}>{o || '—'}</option>)}
        </select>
      ) : (
        <input
          type={type}
          name={name}
          placeholder={placeholder}
          defaultValue={defaultValue}
          required={required}
          step={step}
          min={min}
          className={baseInput}
        />
      )}
    </label>
  );
}

function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase();
  let cls = 'bg-warm-beige text-charcoal/70';
  if (s === 'draft')     cls = 'bg-indigo-wash text-indigo';
  if (s === 'incoming')  cls = 'bg-periwinkle-wash text-periwinkle';
  if (s === 'received')  cls = 'bg-sage-wash text-sage';
  if (s === 'cancelled') cls = 'bg-cancelled text-charcoal/50';
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{status || '—'}</span>;
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
