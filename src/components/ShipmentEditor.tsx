'use client';

/**
 * Modal for creating or editing a Shipment attached to a PO.
 *
 * Header fields cover mode/destination/dates/status/carrier/tracking + the
 * destination warehouse's receiving order ID and an optional freight estimate.
 * Below that is a per-SKU allocation table where the user sets how many
 * units of each PO line go in this shipment.
 *
 * Reused by both the in-PO modal (PoPaymentsSection) and the standalone
 * /shipments page (ShipmentsView).
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { PoSummary, Shipment, ShipmentStatus } from '@/lib/inventory';
import {
  createShipment,
  updateShipment,
  replaceShipmentLines,
  type ShipmentFields,
  type ShipmentLineInput,
} from '@/app/pos/actions';

export function ShipmentEditor({
  po, shipment, onClose,
}: {
  po: PoSummary;
  shipment: Shipment | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Header form state — initialize from existing shipment, or sensible defaults.
  const [label,            setLabel]            = useState(shipment?.label ?? '');
  const [mode,             setMode]             = useState(shipment?.mode ?? 'Sea');
  const [destination,      setDestination]      = useState(shipment?.destination ?? 'ShipBob WI');
  const [departureDate,    setDepartureDate]    = useState(shipment?.departureDate ?? '');
  const [eta,              setEta]              = useState(shipment?.eta ?? '');
  const [status,           setStatus]           = useState<ShipmentStatus>(shipment?.status || 'Planning');
  const [carrier,          setCarrier]          = useState(shipment?.carrier ?? '');
  const [trackingNumber,   setTrackingNumber]   = useState(shipment?.trackingNumber ?? '');
  const [receivingOrderId, setReceivingOrderId] = useState(shipment?.receivingOrderId ?? '');
  const [estimatedCost,    setEstimatedCost]    = useState(shipment?.estimatedCost && shipment.estimatedCost > 0 ? shipment.estimatedCost.toFixed(2) : '');
  const [notes,            setNotes]            = useState(shipment?.notes ?? '');

  // Allocation: per-SKU qty for this shipment. Initialize from existing
  // shipment lines (when editing), 0 for everything else (when creating).
  const allocInit = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of shipment?.lines ?? []) {
      m.set(l.sku, (m.get(l.sku) ?? 0) + l.qty);
    }
    return m;
  }, [shipment]);

  // Already-allocated to OTHER shipments on this PO (i.e. excluding the
  // shipment we're editing). Used to compute "remaining to allocate" per
  // SKU so the Fill Empty Rows shortcut doesn't propose more than is left.
  const otherAllocated = useMemo(() => {
    const m = new Map<string, number>();
    for (const sh of po.shipments) {
      if (shipment && sh.shipmentId === shipment.shipmentId) continue;
      for (const l of sh.lines) {
        m.set(l.sku, (m.get(l.sku) ?? 0) + l.qty);
      }
    }
    return m;
  }, [po.shipments, shipment]);

  // Group PO line rows by SKU (same SKU may appear twice — Amz vs SB legs).
  // We sum the line qtys per SKU and let the user split how they want; the
  // original Dest is shown as a hint only. Sorted by destination convention:
  // ShipBob → Line order then size order (matches dashboard); AWD → alpha.
  const skuRows = useMemo(() => {
    const m = new Map<string, { sku: string; totalQty: number; dests: string[] }>();
    for (const r of po.lineRows) {
      if (!r.sku) continue;
      const prev = m.get(r.sku);
      if (prev) {
        prev.totalQty += r.qty;
        if (r.dest && !prev.dests.includes(r.dest)) prev.dests.push(r.dest);
      } else {
        m.set(r.sku, { sku: r.sku, totalQty: r.qty, dests: r.dest ? [r.dest] : [] });
      }
    }
    const arr = Array.from(m.values());
    if (destination === 'ShipBob WI') {
      // Style alpha → Color alpha → Size order, matching the Apparel
      // dashboard. e.g. H501-2-BK XS,S,M,L,...,4X then H501-2-GYBK XS,S,...
      arr.sort((a, b) => {
        const ma = po.skuMeta[a.sku];
        const mb = po.skuMeta[b.sku];
        const styleA = ma?.style ?? '';
        const styleB = mb?.style ?? '';
        if (styleA !== styleB) return styleA.localeCompare(styleB);
        const colorA = ma?.color ?? '';
        const colorB = mb?.color ?? '';
        if (colorA !== colorB) return colorA.localeCompare(colorB);
        const sa = ma?.sizeOrder ?? 99;
        const sb = mb?.sizeOrder ?? 99;
        if (sa !== sb) return sa - sb;
        return a.sku.localeCompare(b.sku);
      });
    } else {
      // AWD or anything else → alphabetical (current behavior)
      arr.sort((a, b) => a.sku.localeCompare(b.sku));
    }
    return arr;
  }, [po.lineRows, po.skuMeta, destination]);

  const [alloc, setAlloc] = useState<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const sk of skuRows) {
      const init = allocInit.get(sk.sku);
      m.set(sk.sku, init && init > 0 ? String(init) : '');
    }
    return m;
  });

  const allocLines: ShipmentLineInput[] = useMemo(() => {
    const out: ShipmentLineInput[] = [];
    for (const [sku, qtyStr] of alloc) {
      const q = Number(qtyStr);
      if (Number.isFinite(q) && q > 0) out.push({ sku, qty: q });
    }
    return out;
  }, [alloc]);
  const allocTotal = allocLines.reduce((a, l) => a + l.qty, 0);

  function setAllocQty(sku: string, value: string) {
    setAlloc((prev) => {
      const next = new Map(prev);
      next.set(sku, value);
      return next;
    });
  }

  function fillAllRemaining() {
    setAlloc((prev) => {
      const next = new Map(prev);
      for (const sk of skuRows) {
        const cur = Number(prev.get(sk.sku) ?? '');
        if (!Number.isFinite(cur) || cur === 0) {
          // Remaining to allocate = PO qty − already on other shipments.
          // If 0, leave the field blank (nothing to add for this SKU).
          const remaining = Math.max(sk.totalQty - (otherAllocated.get(sk.sku) ?? 0), 0);
          if (remaining > 0) next.set(sk.sku, String(remaining));
        }
      }
      return next;
    });
  }

  function clearAll() {
    setAlloc((prev) => {
      const next = new Map(prev);
      for (const sk of skuRows) next.set(sk.sku, '');
      return next;
    });
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!mode || !destination) {
      setError('Mode and destination are required.');
      return;
    }
    let estCost: number | undefined = undefined;
    if (estimatedCost !== '') {
      estCost = Number(estimatedCost);
      if (!Number.isFinite(estCost) || estCost < 0) {
        setError('Estimated cost must be a non-negative number (or blank).');
        return;
      }
    }
    const fields: ShipmentFields = {
      label, mode, destination, departureDate, eta, status,
      carrier, trackingNumber, receivingOrderId, notes,
      estimatedCost: estCost,
    };
    startTransition(async () => {
      if (shipment) {
        const r1 = await updateShipment(shipment.shipmentId, fields);
        if (!r1.ok) { setError(r1.error ?? 'Update failed.'); return; }
        const r2 = await replaceShipmentLines(shipment.shipmentId, allocLines);
        if (!r2.ok) { setError(r2.error ?? 'Line update failed.'); return; }
      } else {
        const r1 = await createShipment(po.poNumber, fields, allocLines);
        if (!r1.ok) { setError(r1.error ?? 'Create failed.'); return; }
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <div className="fixed inset-0 bg-charcoal/50 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-warm-white rounded-lg border border-warm-gray/40 shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-warm-gray/40 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-display text-xl">
              {shipment ? `Edit ${shipment.shipmentId}` : 'Plan shipment'}
            </h3>
            <p className="text-xs text-charcoal/60 mt-1">
              {po.poNumber} · {po.supplier} · {po.totalUnits.toLocaleString()} units total
            </p>
          </div>
          {shipment && <ShipmentStatusPill status={shipment.status} />}
        </div>

        <form onSubmit={save} className="p-6 space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="Mode">
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm"
              >
                <option value="Air">Air</option>
                <option value="Sea">Sea</option>
                <option value="Truck">Truck</option>
              </select>
            </Field>
            <Field label="Destination">
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm"
              >
                <option value="AWD Storage">AWD Storage</option>
                <option value="ShipBob WI">ShipBob WI</option>
              </select>
            </Field>
            <Field label="Status">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as ShipmentStatus)}
                className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm"
              >
                <option value="Planning">Planning</option>
                <option value="In Transit">In Transit</option>
                <option value="Received">Received</option>
                <option value="Cancelled">Cancelled</option>
              </select>
            </Field>
            <Field label="Departure date">
              <input type="date" value={departureDate} onChange={(e) => setDepartureDate(e.target.value)} className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm" />
            </Field>
            <Field label="ETA">
              <input type="date" value={eta} onChange={(e) => setEta(e.target.value)} className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm" />
            </Field>
            <Field label="Estimated freight" hint="optional quote">
              <input
                type="number" min={0} step={0.01}
                placeholder="0.00"
                value={estimatedCost}
                onChange={(e) => setEstimatedCost(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm tabular-nums"
              />
            </Field>
            <Field label="Carrier / Forwarder">
              <input
                type="text"
                placeholder="e.g. Flexport, DHL"
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm"
              />
            </Field>
            <Field label="Tracking #">
              <input
                type="text"
                value={trackingNumber}
                onChange={(e) => setTrackingNumber(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm"
              />
            </Field>
            <Field label="Receiving Order ID" hint="AWD inbound or ShipBob WRO">
              <input
                type="text"
                placeholder="WRO-... / inbound ID"
                value={receivingOrderId}
                onChange={(e) => setReceivingOrderId(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm"
              />
            </Field>
          </div>

          <Field label="Label" hint="short descriptor — shown in the shipments list">
            <input
              type="text"
              placeholder='e.g. "Air restock — XS sizes urgent"'
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm"
            />
          </Field>

          <Field label="Notes">
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-2 py-1.5 rounded border border-warm-gray/60 bg-warm-white text-sm"
            />
          </Field>

          {/* Allocation */}
          <div>
            <div className="flex items-baseline justify-between mb-2">
              <h4 className="font-medium text-sm">Line allocation</h4>
              <div className="flex items-center gap-2 text-xs">
                <button type="button" onClick={fillAllRemaining} className="text-indigo hover:underline">Fill empty rows</button>
                <span className="text-charcoal/30">·</span>
                <button type="button" onClick={clearAll} className="text-ironclad hover:underline">Clear all</button>
              </div>
            </div>
            <div className="rounded-md border border-warm-gray/40 bg-warm-white overflow-hidden">
              <table className="w-full text-sm border-separate border-spacing-0">
                <thead>
                  <tr className="bg-warm-beige/40 text-charcoal/70 text-[11px] uppercase tracking-wider">
                    <Th className="text-left">SKU</Th>
                    <Th className="text-right">PO qty</Th>
                    <Th className="text-right">On other ship.</Th>
                    <Th className="text-right">Remaining</Th>
                    <Th className="text-right w-32">Ship qty</Th>
                  </tr>
                </thead>
                <tbody>
                  {skuRows.length === 0 && (
                    <tr><td colSpan={5} className="text-center text-charcoal/60 py-4 text-xs">No line items on this PO yet.</td></tr>
                  )}
                  {skuRows.map((sk, i) => {
                    const onOther = otherAllocated.get(sk.sku) ?? 0;
                    const remaining = Math.max(sk.totalQty - onOther, 0);
                    return (
                      <tr key={sk.sku} className={`${i % 2 === 0 ? 'bg-warm-white' : 'bg-warm-beige/15'} border-b border-warm-gray/20`}>
                        <Td className="font-mono text-xs">{sk.sku}</Td>
                        <Td className="text-right tabular-nums">{sk.totalQty.toLocaleString()}</Td>
                        <Td className="text-right tabular-nums text-charcoal/60">
                          {onOther > 0 ? onOther.toLocaleString() : <span className="text-charcoal/30">—</span>}
                        </Td>
                        <Td className={`text-right tabular-nums ${remaining === 0 ? 'text-charcoal/40' : 'text-charcoal/70'}`}>
                          {remaining.toLocaleString()}
                        </Td>
                        <Td className="text-right">
                          <input
                            type="number" min={0} step={1}
                            placeholder="0"
                            value={alloc.get(sk.sku) ?? ''}
                            onChange={(e) => setAllocQty(sk.sku, e.target.value)}
                            className="w-24 px-2 py-1 rounded border border-warm-gray/60 bg-warm-white text-sm tabular-nums text-right"
                          />
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-warm-beige/30 text-charcoal/70 text-xs">
                    <Td colSpan={4} className="text-right font-medium">Allocated</Td>
                    <Td className="text-right tabular-nums font-medium">{allocTotal.toLocaleString()} units</Td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {error && (
            <div className="rounded border border-ironclad/40 bg-ironclad/10 px-3 py-2 text-sm text-ironclad">{error}</div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-warm-gray/30">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-md border border-warm-gray/60 text-sm hover:bg-warm-beige/40">
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="px-4 py-2 rounded-md bg-indigo text-warm-white text-sm font-medium hover:bg-indigo/90 disabled:opacity-50"
            >
              {pending ? 'Saving…' : (shipment ? 'Save shipment' : 'Create shipment')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ShipmentStatusPill({ status }: { status: ShipmentStatus | '' }) {
  const cls =
    status === 'Received'   ? 'bg-sage/20 text-sage' :
    status === 'In Transit' ? 'bg-periwinkle/20 text-periwinkle' :
    status === 'Planning'   ? 'bg-indigo/15 text-indigo' :
    status === 'Cancelled'  ? 'bg-cancelled text-charcoal/50' :
                              'bg-warm-beige text-charcoal/50';
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${cls}`}>{status || '—'}</span>;
}

// Local helpers (kept private to this file).
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
