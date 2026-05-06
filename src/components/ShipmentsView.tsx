'use client';

/**
 * Standalone /shipments page — list every shipment across all POs with status
 * filtering, search, and inline edit. "+ Plan shipment" picks a PO first
 * (small dialog), then opens the shared ShipmentEditor.
 *
 * Each row shows enough context (PO #, mode→dest, ETA, status, line summary,
 * receiving ID, shipping paid) to answer "what's in flight, what still needs
 * a payment, what's about to arrive?" at a glance.
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { PoSummary, Shipment, ShipmentStatus } from '@/lib/inventory';
import { deleteShipment } from '@/app/pos/actions';
import { ShipmentEditor, ShipmentStatusPill } from './ShipmentEditor';

interface Props {
  summaries: PoSummary[];
}

const STATUSES: ShipmentStatus[] = ['Planning', 'In Transit', 'Received', 'Cancelled'];

interface FlatShipment extends Shipment {
  // Carry the parent PoSummary so the editor has line allocation context
  // and we can show supplier/totals on the row.
  po: PoSummary;
}

export function ShipmentsView({ summaries }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [filter, setFilter] = useState<ShipmentStatus | 'All'>('All');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<FlatShipment | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [creating, setCreating] = useState<PoSummary | null>(null);

  // Flatten all shipments + tag with parent PO
  const all = useMemo<FlatShipment[]>(() => {
    const out: FlatShipment[] = [];
    for (const po of summaries) {
      for (const s of po.shipments) {
        out.push({ ...s, po });
      }
    }
    // Most recent first by Shipment ID
    out.sort((a, b) => b.shipmentId.localeCompare(a.shipmentId));
    return out;
  }, [summaries]);

  // POs available for "Plan shipment" — exclude Cancelled, sort newest first
  const eligiblePOs = useMemo(() => {
    return summaries
      .filter((p) => p.paymentStatus !== 'Cancelled')
      .sort((a, b) => b.poNumber.localeCompare(a.poNumber));
  }, [summaries]);

  const counts = useMemo(() => {
    const out: Record<ShipmentStatus, number> = { Planning: 0, 'In Transit': 0, Received: 0, Cancelled: 0 };
    for (const s of all) {
      const st = s.status as ShipmentStatus;
      if (st in out) out[st]++;
    }
    return out;
  }, [all]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((s) => {
      if (filter !== 'All' && s.status !== filter) return false;
      if (!q) return true;
      const hay = [
        s.shipmentId, s.poNumber, s.label, s.mode, s.destination,
        s.carrier, s.trackingNumber, s.receivingOrderId, s.notes,
        s.po.supplier,
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [all, filter, query]);

  const totals = useMemo(() => {
    let unitsInFlight = 0;
    let unitsPlanning = 0;
    let unitsArrived  = 0;
    let shippingPaid  = 0;
    for (const s of visible) {
      const u = s.lines.reduce((a, l) => a + l.qty, 0);
      if (s.status === 'In Transit') unitsInFlight += u;
      if (s.status === 'Planning')   unitsPlanning += u;
      if (s.status === 'Received')   unitsArrived  += u;
      shippingPaid += s.shippingPaidAmount;
    }
    return { unitsInFlight, unitsPlanning, unitsArrived, shippingPaid };
  }, [visible]);

  function handleDelete(shipmentId: string) {
    if (!confirm(`Delete shipment ${shipmentId}? Its line allocations will also be removed. Any shipping payments tagged with it will become unassigned (still count toward PO totals).`)) return;
    setDeleteError(null);
    startTransition(async () => {
      const res = await deleteShipment(shipmentId);
      if (!res.ok) {
        setDeleteError(res.error ?? 'Delete failed.');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile label="In transit"        value={`${totals.unitsInFlight.toLocaleString()} units`} accent="periwinkle" />
        <KpiTile label="Planning"          value={`${totals.unitsPlanning.toLocaleString()} units`} accent="indigo" />
        <KpiTile label="Received"          value={`${totals.unitsArrived.toLocaleString()} units`}  accent="sage" />
        <KpiTile label="Shipping paid"     value={fmtCurrency(totals.shippingPaid)}                 accent="charcoal" />
      </div>

      <div className="rounded-lg border border-warm-gray/40 bg-warm-white p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-charcoal/60">Filter:</span>
              <button
                onClick={() => setFilter('All')}
                className={`px-2 py-1 rounded ${filter === 'All' ? 'bg-indigo text-warm-white' : 'bg-warm-beige/40 hover:bg-warm-beige'}`}
              >
                All ({all.length})
              </button>
              {STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => setFilter(s)}
                  className={`px-2 py-1 rounded ${filter === s ? 'bg-indigo text-warm-white' : 'bg-warm-beige/40 hover:bg-warm-beige'}`}
                >
                  {s} ({counts[s]})
                </button>
              ))}
            </div>
            <input
              type="text"
              placeholder="Search shipment, PO, SKU, tracking…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 min-w-[200px] max-w-md px-3 py-2 rounded-md border border-warm-gray/60 bg-warm-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo/40"
            />
          </div>
          <button
            onClick={() => setShowPicker(true)}
            className="px-4 py-2 rounded-md bg-indigo text-warm-white text-sm font-medium hover:bg-indigo/90"
          >
            + Plan shipment
          </button>
        </div>
      </div>

      {deleteError && (
        <div className="rounded border border-ironclad/40 bg-ironclad/10 px-3 py-2 text-sm text-ironclad">{deleteError}</div>
      )}

      <div className="rounded-lg border border-warm-gray/40 bg-warm-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr className="bg-periwinkle/15 text-charcoal/80 text-xs uppercase tracking-wider">
                <Th className="text-left">Shipment</Th>
                <Th className="text-left">PO #</Th>
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
              {visible.length === 0 && (
                <tr><td colSpan={9} className="text-center text-charcoal/60 py-12">
                  {all.length === 0
                    ? <>No shipments yet. Hit <strong>+ Plan shipment</strong> to start one.</>
                    : 'No shipments match this filter.'}
                </td></tr>
              )}
              {visible.map((s, i) => {
                const lineUnits = s.lines.reduce((a, l) => a + l.qty, 0);
                return (
                  <tr
                    key={s.shipmentId}
                    className={`${i % 2 === 0 ? 'bg-warm-white' : 'bg-warm-beige/20'} border-b border-warm-gray/20 hover:bg-indigo/5 cursor-pointer`}
                    onClick={() => setEditing(s)}
                  >
                    <Td className="font-mono text-xs">
                      <div>{s.shipmentId}</div>
                      {s.label && <div className="text-charcoal/50 text-[11px] font-sans">{s.label}</div>}
                    </Td>
                    <Td className="font-mono text-xs">
                      <div>{s.poNumber}</div>
                      <div className="text-charcoal/50 text-[11px] font-sans">{s.po.supplier}</div>
                    </Td>
                    <Td className="text-xs">
                      <span className="font-medium">{s.mode || '—'}</span>
                      <span className="text-charcoal/50"> → {s.destination || '—'}</span>
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
                      <button onClick={(e) => { e.stopPropagation(); setEditing(s); }} className="text-xs text-indigo hover:underline">Edit</button>
                      <span className="mx-1 text-charcoal/30">·</span>
                      <button onClick={(e) => { e.stopPropagation(); handleDelete(s.shipmentId); }} disabled={pending} className="text-xs text-ironclad hover:underline disabled:opacity-40">Delete</button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit modal */}
      {editing && (
        <ShipmentEditor
          po={editing.po}
          shipment={editing}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Create flow: pick a PO first */}
      {showPicker && (
        <PoPicker
          pos={eligiblePOs}
          onPick={(po) => { setShowPicker(false); setCreating(po); }}
          onClose={() => setShowPicker(false)}
        />
      )}

      {creating && (
        <ShipmentEditor
          po={creating}
          shipment={null}
          onClose={() => setCreating(null)}
        />
      )}
    </div>
  );
}

// --- PO picker --------------------------------------------------------------

function PoPicker({
  pos, onPick, onClose,
}: {
  pos: PoSummary[];
  onPick: (po: PoSummary) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pos;
    return pos.filter((p) => {
      const hay = `${p.poNumber} ${p.supplier} ${p.lineRows.map((r) => r.sku).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }, [pos, query]);

  return (
    <div className="fixed inset-0 bg-charcoal/50 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-warm-white rounded-lg border border-warm-gray/40 shadow-xl w-full max-w-xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-warm-gray/40">
          <h3 className="font-display text-lg">Plan shipment</h3>
          <p className="text-xs text-charcoal/60 mt-1">Pick a PO to allocate lines from.</p>
        </div>
        <div className="p-5 space-y-3">
          <input
            type="text"
            placeholder="Search by PO, supplier, or SKU…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-warm-gray/60 bg-warm-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo/40"
          />
          <div className="rounded-md border border-warm-gray/40 bg-warm-white max-h-[55vh] overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-charcoal/60">No matches.</div>
            )}
            {filtered.map((p) => (
              <button
                key={p.poNumber}
                onClick={() => onPick(p)}
                className="w-full text-left px-4 py-3 border-b border-warm-gray/20 hover:bg-indigo/5 last:border-b-0"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div>
                    <span className="font-mono text-sm">{p.poNumber}</span>
                    <span className="text-charcoal/60 text-xs ml-2">{p.supplier}</span>
                  </div>
                  <div className="text-xs text-charcoal/60">
                    {p.totalUnits.toLocaleString()} units · {p.shipments.length} shipment{p.shipments.length === 1 ? '' : 's'}
                  </div>
                </div>
                {p.orderDate && (
                  <div className="text-[11px] text-charcoal/50 mt-1">
                    Ordered {p.orderDate}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
        <div className="p-4 border-t border-warm-gray/40 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-md border border-warm-gray/60 text-sm hover:bg-warm-beige/40">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Helpers ----------------------------------------------------------------

function KpiTile({ label, value, accent }: { label: string; value: string; accent: 'indigo' | 'periwinkle' | 'sage' | 'charcoal' }) {
  const ring =
    accent === 'indigo'     ? 'border-indigo/30' :
    accent === 'periwinkle' ? 'border-periwinkle/40' :
    accent === 'sage'       ? 'border-sage/30' :
                              'border-warm-gray/60';
  return (
    <div className={`rounded border ${ring} bg-warm-white px-4 py-3`}>
      <div className="text-[10px] uppercase tracking-wider text-charcoal/50">{label}</div>
      <div className="font-display text-xl mt-1 tabular-nums">{value}</div>
    </div>
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
