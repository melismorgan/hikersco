'use client';

/**
 * Events page — list view + create/edit modal for the Events tab.
 *
 * Mirrors the editor pattern from PoPaymentsSection: table on top, click a
 * row to open an inline modal with all editable fields, save/cancel
 * round-trips through the server actions in src/app/events/actions.ts which
 * write straight to the workbook. Same Events tab the workbook can edit
 * directly — both UIs converge on identical data.
 *
 * Fields are organized into three sections in the modal:
 *   1. Identity — Type, Name, Status (auto-derived but overridable)
 *   2. Plan — dates, channels, Linked Parents wildcards, Expected Units,
 *             Exclude From Velocity Avg flag
 *   3. Results — email metrics + Units Sold + Lift % + Gross Revenue +
 *                Result Notes (filled in post-event)
 *
 * Status auto-flip: the Status column on the table shows the *derived*
 * status (Planned/Active/Ended based on dates) — not the raw cell. This
 * matches what the Reorder math actually uses, so the UI doesn't lie about
 * what's driving the numbers.
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { EventRow, EventStatus, EventType } from '@/lib/events';
import { createEvent, updateEvent, deleteEvent } from '@/app/events/actions';

interface Props {
  events: EventRow[];
}

const TYPE_OPTIONS: EventType[] = ['Launch', 'Restock', 'Promo', 'Email Blast', 'External'];
const STATUS_OPTIONS: EventStatus[] = ['Planned', 'Active', 'Ended'];

const CHANNEL_OPTIONS = ['Email', 'Ads', 'Organic', 'Banner', 'Influencer'];

export function EventsView({ events }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<EventRow | 'new' | null>(null);
  const [filter, setFilter] = useState<EventStatus | 'All'>('All');
  const [query, setQuery] = useState('');

  const counts = useMemo(() => {
    const c = { Planned: 0, Active: 0, Ended: 0 } as Record<EventStatus, number>;
    for (const ev of events) {
      if (ev.status === 'Planned' || ev.status === 'Active' || ev.status === 'Ended') {
        c[ev.status]++;
      }
    }
    return c;
  }, [events]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((ev) => {
      if (filter !== 'All' && ev.status !== filter) return false;
      if (!q) return true;
      return (
        ev.eventId.toLowerCase().includes(q) ||
        ev.name.toLowerCase().includes(q) ||
        ev.linkedParents.toLowerCase().includes(q) ||
        ev.type.toLowerCase().includes(q)
      );
    });
  }, [events, filter, query]);

  return (
    <section className="space-y-6">
      {/* Top KPIs + filter + new */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiTile label="All events" value={events.length} />
        <KpiTile label="Planned" value={counts.Planned} accent="periwinkle" />
        <KpiTile label="Active"  value={counts.Active}  accent="indigo" />
        <KpiTile label="Ended"   value={counts.Ended}   />
      </div>

      <div className="rounded-lg border border-warm-gray/40 bg-warm-white p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-charcoal/60">Filter:</span>
          <FilterPill label={`All (${events.length})`} active={filter === 'All'} onClick={() => setFilter('All')} />
          <FilterPill label={`Planned (${counts.Planned})`} active={filter === 'Planned'} onClick={() => setFilter('Planned')} />
          <FilterPill label={`Active (${counts.Active})`}   active={filter === 'Active'}   onClick={() => setFilter('Active')} />
          <FilterPill label={`Ended (${counts.Ended})`}     active={filter === 'Ended'}     onClick={() => setFilter('Ended')} />
          <input
            type="text" placeholder="Search ID, name, SKU…"
            value={query} onChange={(e) => setQuery(e.target.value)}
            className="ml-auto px-3 py-1.5 rounded-md border border-warm-gray/60 bg-warm-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo/40 min-w-[200px]"
          />
          <button
            onClick={() => setEditing('new')}
            className="px-4 py-2 rounded-md bg-indigo text-warm-white text-sm font-medium hover:bg-indigo/90"
          >
            + New event
          </button>
        </div>

        <div className="dash-scroll">
          <table className="dash-table w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr className="bg-periwinkle/15 text-charcoal/80 text-xs uppercase tracking-wider">
                <Th>ID</Th>
                <Th>Type</Th>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th className="text-right">Start</Th>
                <Th className="text-right">End</Th>
                <Th>Channels</Th>
                <Th>Linked Parents</Th>
                <Th className="text-right">Expected</Th>
                <Th className="text-center" title="Exclude this window from rolling 30d Avg/Day in Reorder math">Excl</Th>
                <Th><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((ev) => (
                <tr
                  key={ev.eventId}
                  onClick={() => setEditing(ev)}
                  className="border-b border-warm-gray/20 hover:bg-indigo/5 cursor-pointer"
                >
                  <Td className="font-mono text-xs">{ev.eventId}</Td>
                  <Td className="text-xs">{ev.type || <span className="text-charcoal/30">—</span>}</Td>
                  <Td className="font-medium">{ev.name}</Td>
                  <Td><StatusPill status={ev.status} /></Td>
                  <Td className="text-right font-mono text-xs">{ev.startDate || ''}</Td>
                  <Td className="text-right font-mono text-xs">{ev.endDate || ''}</Td>
                  <Td className="text-xs text-charcoal/70">{ev.channels.join(', ')}</Td>
                  <Td className="font-mono text-xs text-charcoal/70">{ev.linkedParents}</Td>
                  <Td className="text-right font-mono">{ev.expectedUnits ? ev.expectedUnits.toLocaleString() : ''}</Td>
                  <Td className="text-center text-xs">{ev.excludeFromVelocityAvg ? 'Y' : ''}</Td>
                  <Td className="text-right">
                    <span className="text-indigo text-xs hover:underline">Edit</span>
                  </Td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={11} className="text-center text-charcoal/60 py-8">
                    {events.length === 0
                      ? 'No events yet — click "New event" to add the first one.'
                      : 'No events match the filter.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <EventModal
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

// ---- Modal ----------------------------------------------------------------

function EventModal({
  editing,
  onClose,
  onSaved,
}: {
  editing: EventRow | 'new';
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = editing === 'new';
  const ev = isNew ? null : editing;
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    startTransition(async () => {
      const res = isNew
        ? await createEvent(form)
        : await updateEvent(ev!.rowIndex, form);
      if (!res.ok) {
        setError(res.error ?? 'Save failed.');
        return;
      }
      onSaved();
    });
  };

  const handleDelete = () => {
    if (!ev) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await deleteEvent(ev.rowIndex);
      if (!res.ok) {
        setError(res.error ?? 'Delete failed.');
        return;
      }
      onSaved();
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-charcoal/40 overflow-y-auto py-8" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-warm-white rounded-lg shadow-xl w-full max-w-3xl mx-4 my-auto"
      >
        <form onSubmit={handleSubmit}>
          <div className="px-6 py-4 border-b border-warm-gray/40 flex items-baseline justify-between">
            <h2 className="font-display text-xl">
              {isNew ? 'New event' : `Edit ${ev!.eventId}`}
            </h2>
            {!isNew && (
              <span className="text-xs text-charcoal/50 font-mono">row {ev!.rowIndex}</span>
            )}
          </div>

          <div className="px-6 py-5 space-y-6">
            {/* ---- Identity ---- */}
            <Section title="Identity">
              <Field label="Type">
                <select name="type" defaultValue={ev?.type ?? ''} className={inputCls}>
                  <option value="">—</option>
                  {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Name" wide>
                <input
                  name="name" defaultValue={ev?.name ?? ''} required
                  placeholder="e.g. H503-4 Heavy Duty — June Email + New Colors + Restock"
                  className={inputCls}
                />
              </Field>
              <Field label="Status" hint="Auto-derived from dates if blank — set explicitly to override.">
                <select name="status" defaultValue={ev?.statusRaw ?? ''} className={inputCls}>
                  <option value="">— auto from dates —</option>
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
            </Section>

            {/* ---- Plan ---- */}
            <Section title="Plan">
              <Field label="Start Date">
                <input
                  type="date" name="startDate"
                  defaultValue={toDateInput(ev?.startDate ?? '')}
                  className={inputCls}
                />
              </Field>
              <Field label="Window Length (days)" hint="Used to auto-compute End Date and the post-event measurement window.">
                <input
                  type="number" name="windowLengthDays" min={0} max={365}
                  defaultValue={ev?.windowLengthDays || ''}
                  className={inputCls}
                />
              </Field>
              <Field label="End Date" hint="Leave blank to auto-derive from Start + Window Length.">
                <input
                  type="date" name="endDate"
                  defaultValue={toDateInput(ev?.endDate ?? '')}
                  className={inputCls}
                />
              </Field>
              <Field label="Channels" hint="Comma list — Email, Ads, Organic, Banner, Influencer." wide>
                <input
                  name="channels" defaultValue={ev?.channels.join(', ') ?? ''}
                  placeholder="Email, Banner"
                  list="channel-options"
                  className={inputCls}
                />
                <datalist id="channel-options">
                  {CHANNEL_OPTIONS.map((c) => <option key={c} value={c} />)}
                </datalist>
              </Field>
              <Field label="Linked Parents" hint='Comma list of Style+Color or wildcards (e.g. "H503-4-*" or "H503-4-NGBK, H503-4-GYBK").' wide>
                <input
                  name="linkedParents" defaultValue={ev?.linkedParents ?? ''}
                  placeholder="H503-4-*"
                  className={inputCls + ' font-mono text-sm'}
                />
              </Field>
              <Field label="New SKUs (subset)" hint='Linked Parents that are brand-new with no baseline. Drives Lift % vs First-Window Units split.' wide>
                <input
                  name="newSkus" defaultValue={ev?.newSkus ?? ''}
                  placeholder="H503-4-NGBK, H503-4-GYBK, H503-4-WHLG"
                  className={inputCls + ' font-mono text-sm'}
                />
              </Field>
              <Field label="Discount %" hint="0..1 fraction or 0..100 percent — both accepted.">
                <input
                  type="number" name="discountPct" step="any" min={0} max={100}
                  defaultValue={ev?.discountPct ? Math.round(ev.discountPct * 1000) / 10 : ''}
                  className={inputCls}
                />
              </Field>
              <Field label="Expected Units" hint="Forward forecast across all linked SKUs over the window. Drives Reorder demand-spike.">
                <input
                  type="number" name="expectedUnits" step="1" min={0}
                  defaultValue={ev?.expectedUnits || ''}
                  className={inputCls}
                />
              </Field>
              <Field label="Notes" wide>
                <textarea
                  name="notes" defaultValue={ev?.notes ?? ''} rows={2}
                  className={inputCls + ' resize-y'}
                />
              </Field>
              <Field label="Exclude from Velocity Avg" hint="When Y, this window's units don't drive the rolling 30d Avg/Day used by Reorder. Recommended for launches and big promos." wide>
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input
                    type="checkbox" name="excludeFromVelocityAvg"
                    defaultChecked={ev?.excludeFromVelocityAvg ?? true}
                    className="accent-indigo"
                  />
                  <span className="text-charcoal/70">Substitute 90d Avg/Day for SKUs in this window</span>
                </label>
              </Field>
            </Section>

            {/* ---- Results ---- */}
            <Section title="Results" hint="Fill in after the window closes — drives the comparable for next time.">
              <Field label="Email Recipients">
                <input type="number" name="emailRecipients" min={0} step="1"
                  defaultValue={ev?.emailRecipients || ''} className={inputCls} />
              </Field>
              <Field label="Email Open %" hint="Fraction or percent.">
                <input type="number" name="emailOpenPct" step="any" min={0} max={100}
                  defaultValue={ev?.emailOpenPct ? Math.round(ev.emailOpenPct * 1000) / 10 : ''}
                  className={inputCls} />
              </Field>
              <Field label="Email Click %">
                <input type="number" name="emailClickPct" step="any" min={0} max={100}
                  defaultValue={ev?.emailClickPct ? Math.round(ev.emailClickPct * 1000) / 10 : ''}
                  className={inputCls} />
              </Field>
              <Field label="Units Sold (Window)">
                <input type="number" name="unitsSoldWindow" min={0} step="1"
                  defaultValue={ev?.unitsSoldWindow || ''} className={inputCls} />
              </Field>
              <Field label="Baseline Avg/Day" hint="Avg/day for non-new linked SKUs across the prior 30d.">
                <input type="number" name="baselineAvgPerDay" step="any" min={0}
                  defaultValue={ev?.baselineAvgPerDay || ''} className={inputCls} />
              </Field>
              <Field label="Lift %" hint="Established SKUs only — ignore for pure new-color launches.">
                <input type="number" name="liftPct" step="any"
                  defaultValue={ev?.liftPct ? Math.round(ev.liftPct * 1000) / 10 : ''}
                  className={inputCls} />
              </Field>
              <Field label="New SKU First-Window Units" hint="Launch-only number — sum across the New SKUs during the window.">
                <input type="number" name="newSkuFirstWindowUnits" min={0} step="1"
                  defaultValue={ev?.newSkuFirstWindowUnits || ''} className={inputCls} />
              </Field>
              <Field label="Gross Revenue">
                <input type="number" name="grossRevenue" step="0.01" min={0}
                  defaultValue={ev?.grossRevenue || ''} className={inputCls} />
              </Field>
              <Field label="Result Notes" wide>
                <textarea
                  name="resultNotes" defaultValue={ev?.resultNotes ?? ''} rows={2}
                  className={inputCls + ' resize-y'}
                />
              </Field>
            </Section>

            {error && (
              <div className="rounded-md bg-ironclad/10 border border-ironclad/40 px-3 py-2 text-sm text-ironclad">
                {error}
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-warm-gray/40 flex items-center justify-between gap-3">
            <div>
              {!isNew && (
                <button
                  type="button" onClick={handleDelete} disabled={pending}
                  className={`px-3 py-2 rounded-md text-sm ${
                    confirmDelete
                      ? 'bg-ironclad text-warm-white hover:bg-ironclad/90'
                      : 'text-ironclad hover:bg-ironclad/5'
                  }`}
                >
                  {confirmDelete ? 'Confirm delete' : 'Delete'}
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button type="button" onClick={onClose} className="px-4 py-2 rounded-md text-sm text-charcoal/70 hover:bg-warm-beige/50">
                Cancel
              </button>
              <button
                type="submit" disabled={pending}
                className="px-4 py-2 rounded-md bg-indigo text-warm-white text-sm font-medium hover:bg-indigo/90 disabled:opacity-50"
              >
                {pending ? 'Saving…' : isNew ? 'Create event' : 'Save changes'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- Helpers --------------------------------------------------------------

const inputCls =
  'w-full px-3 py-1.5 rounded-md border border-warm-gray/60 bg-warm-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo/40';

/** Convert a sheet date string (could be ISO, "5/20/2026", etc.) to the
 *  YYYY-MM-DD format that <input type="date"> expects. Returns '' if
 *  unparsable so the field renders blank rather than spewing junk. */
function toDateInput(s: string): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="font-display text-base">
        {title}
        {hint && <span className="ml-2 text-xs text-charcoal/50 font-sans">— {hint}</span>}
      </legend>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
        {children}
      </div>
    </fieldset>
  );
}

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`block text-sm ${wide ? 'md:col-span-2' : ''}`}>
      <span className="block text-xs uppercase tracking-wider text-charcoal/60 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-charcoal/50 mt-1">{hint}</span>}
    </label>
  );
}

function StatusPill({ status }: { status: EventStatus }) {
  if (!status) return <span className="text-charcoal/30">—</span>;
  const style =
    status === 'Active'  ? 'bg-indigo/15 text-indigo'  :
    status === 'Planned' ? 'bg-periwinkle/30 text-charcoal/80' :
    'bg-warm-beige/60 text-charcoal/60';
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${style}`}>{status}</span>;
}

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button" onClick={onClick}
      className={`px-3 py-1 rounded text-sm ${active ? 'bg-indigo text-warm-white' : 'bg-warm-beige/40 hover:bg-warm-beige'}`}
    >
      {label}
    </button>
  );
}

function KpiTile({ label, value, accent }: { label: string; value: number | string; accent?: 'indigo' | 'periwinkle' }) {
  const accentCls = accent === 'indigo' ? 'text-indigo' : accent === 'periwinkle' ? 'text-charcoal/80' : '';
  return (
    <div className="rounded-lg border border-warm-gray/40 bg-warm-white px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-charcoal/50">{label}</div>
      <div className={`font-display text-2xl ${accentCls}`}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
    </div>
  );
}

function Th({ children, className = '', title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <th className={`px-3 py-2 font-medium text-left ${className}`} title={title} scope="col">{children}</th>;
}
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-1.5 ${className}`}>{children}</td>;
}
