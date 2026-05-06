'use server';

import { revalidatePath } from 'next/cache';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { appendRows, batchUpdateCells, deleteRows } from '@/lib/sheets';
import { ensureEventsTab, EVENTS_TAB, readEvents } from '@/lib/events';

/**
 * Server actions for the Events tab. Mirrors the create/update/delete pattern
 * established by /pos and /shipments. The actions reach into the same `Events`
 * sheet tab the lazy-create code path manages — Melissa can edit either via
 * this UI or directly in the workbook; both write the same rows.
 *
 * Field-to-column map (mirrors lib/events.ts EventRow + the schema comment):
 */
const EVENT_COL: Record<string, string> = {
  eventId:                'A',
  type:                   'B',
  name:                   'C',
  startDate:              'D',
  windowLengthDays:       'E',
  endDate:                'F',
  status:                 'G',
  channels:               'H',
  linkedParents:          'I',
  newSkus:                'J',
  discountPct:            'K',
  expectedUnits:          'L',
  notes:                  'M',
  excludeFromVelocityAvg: 'N',
  emailRecipients:        'O',
  emailOpenPct:           'P',
  emailClickPct:          'Q',
  unitsSoldWindow:        'R',
  baselineAvgPerDay:      'S',
  liftPct:                'T',
  newSkuFirstWindowUnits: 'U',
  grossRevenue:           'V',
  resultNotes:            'W',
};

/** Allowed Type values — anything else risks confusing the dashboard reader.
 *  Empty string is permitted (lets a row sit on the tab in draft form). */
const ALLOWED_TYPES = ['', 'Launch', 'Restock', 'Promo', 'Email Blast', 'External'];
const ALLOWED_STATUSES = ['', 'Planned', 'Active', 'Ended'];

/** Auto-generate the next sequential Event ID by scanning existing rows
 *  for the highest EVT-NNNNN suffix and incrementing. Robust to gaps,
 *  manually-edited IDs, or non-conforming entries (those are skipped). */
async function nextEventId(): Promise<string> {
  const events = await readEvents();
  let maxN = 0;
  for (const ev of events) {
    const m = /^EVT-(\d+)$/.exec(ev.eventId);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
  }
  return `EVT-${String(maxN + 1).padStart(5, '0')}`;
}

/** Read & validate every editable field off the FormData. Returns either
 *  a strongly-typed values object OR an error string for the caller to
 *  bubble back to the form. Centralizes validation so create + update don't
 *  drift apart. */
function parseEventForm(form: FormData): { ok: true; values: EventValues } | { ok: false; error: string } {
  const v: EventValues = {
    type:                   String(form.get('type') ?? '').trim(),
    name:                   String(form.get('name') ?? '').trim(),
    startDate:              String(form.get('startDate') ?? '').trim(),
    windowLengthDays:       parseNumLoose(form.get('windowLengthDays')),
    endDate:                String(form.get('endDate') ?? '').trim(),
    status:                 String(form.get('status') ?? '').trim(),
    channels:               String(form.get('channels') ?? '').trim(),
    linkedParents:          String(form.get('linkedParents') ?? '').trim(),
    newSkus:                String(form.get('newSkus') ?? '').trim(),
    discountPct:            parseNumLoose(form.get('discountPct')),
    expectedUnits:          parseNumLoose(form.get('expectedUnits')),
    notes:                  String(form.get('notes') ?? '').trim(),
    excludeFromVelocityAvg: form.get('excludeFromVelocityAvg') === 'on'
                              || form.get('excludeFromVelocityAvg') === 'true'
                              || form.get('excludeFromVelocityAvg') === 'Y',
    emailRecipients:        parseNumLoose(form.get('emailRecipients')),
    emailOpenPct:           parseNumLoose(form.get('emailOpenPct')),
    emailClickPct:          parseNumLoose(form.get('emailClickPct')),
    unitsSoldWindow:        parseNumLoose(form.get('unitsSoldWindow')),
    baselineAvgPerDay:      parseNumLoose(form.get('baselineAvgPerDay')),
    liftPct:                parseNumLoose(form.get('liftPct')),
    newSkuFirstWindowUnits: parseNumLoose(form.get('newSkuFirstWindowUnits')),
    grossRevenue:           parseNumLoose(form.get('grossRevenue')),
    resultNotes:            String(form.get('resultNotes') ?? '').trim(),
  };

  if (!v.name) {
    return { ok: false, error: 'Name is required.' };
  }
  if (!ALLOWED_TYPES.includes(v.type)) {
    return { ok: false, error: `Type must be one of: ${ALLOWED_TYPES.filter(Boolean).join(', ')}` };
  }
  if (!ALLOWED_STATUSES.includes(v.status)) {
    return { ok: false, error: `Status must be one of: ${ALLOWED_STATUSES.filter(Boolean).join(', ')}` };
  }
  // Window length sanity
  if (v.windowLengthDays !== '' && (typeof v.windowLengthDays !== 'number' || v.windowLengthDays < 0 || v.windowLengthDays > 365)) {
    return { ok: false, error: 'Window length must be 0..365 days.' };
  }
  // Discount must be 0..1 or 0..100; we accept either, normalize on write.
  if (v.discountPct !== '' && typeof v.discountPct === 'number') {
    const d = v.discountPct;
    if (d < 0 || d > 100) {
      return { ok: false, error: 'Discount must be a fraction (0..1) or percent (0..100).' };
    }
  }
  return { ok: true, values: v };
}

/** Build the (col → value) update list for a single event row. Used by both
 *  the create row-builder and update batch. Skips empty-string entries on
 *  numeric fields so blank-on-form leaves the cell blank rather than 0. */
function buildEventCellPairs(values: EventValues): Array<{ col: string; value: string | number }> {
  return [
    { col: EVENT_COL.type,                   value: values.type },
    { col: EVENT_COL.name,                   value: values.name },
    { col: EVENT_COL.startDate,              value: values.startDate },
    { col: EVENT_COL.windowLengthDays,       value: values.windowLengthDays },
    { col: EVENT_COL.endDate,                value: values.endDate },
    { col: EVENT_COL.status,                 value: values.status },
    { col: EVENT_COL.channels,               value: values.channels },
    { col: EVENT_COL.linkedParents,          value: values.linkedParents },
    { col: EVENT_COL.newSkus,                value: values.newSkus },
    { col: EVENT_COL.discountPct,            value: values.discountPct },
    { col: EVENT_COL.expectedUnits,          value: values.expectedUnits },
    { col: EVENT_COL.notes,                  value: values.notes },
    { col: EVENT_COL.excludeFromVelocityAvg, value: values.excludeFromVelocityAvg ? 'Y' : 'N' },
    { col: EVENT_COL.emailRecipients,        value: values.emailRecipients },
    { col: EVENT_COL.emailOpenPct,           value: values.emailOpenPct },
    { col: EVENT_COL.emailClickPct,          value: values.emailClickPct },
    { col: EVENT_COL.unitsSoldWindow,        value: values.unitsSoldWindow },
    { col: EVENT_COL.baselineAvgPerDay,      value: values.baselineAvgPerDay },
    { col: EVENT_COL.liftPct,                value: values.liftPct },
    { col: EVENT_COL.newSkuFirstWindowUnits, value: values.newSkuFirstWindowUnits },
    { col: EVENT_COL.grossRevenue,           value: values.grossRevenue },
    { col: EVENT_COL.resultNotes,            value: values.resultNotes },
  ];
}

/** Append a new event row. Auto-generates an Event ID. */
export async function createEvent(formData: FormData): Promise<{ ok: boolean; error?: string; eventId?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, error: 'Not authenticated.' };

  const parsed = parseEventForm(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  await ensureEventsTab();
  const eventId = await nextEventId();

  // Build the row in column order A..W. Empty-string cells stay empty.
  const v = parsed.values;
  const row: (string | number)[] = [
    eventId,                                                  // A
    v.type,                                                   // B
    v.name,                                                   // C
    v.startDate,                                              // D
    v.windowLengthDays,                                       // E
    v.endDate,                                                // F
    v.status,                                                 // G
    v.channels,                                               // H
    v.linkedParents,                                          // I
    v.newSkus,                                                // J
    v.discountPct,                                            // K
    v.expectedUnits,                                          // L
    v.notes,                                                  // M
    v.excludeFromVelocityAvg ? 'Y' : 'N',                     // N
    v.emailRecipients,                                        // O
    v.emailOpenPct,                                           // P
    v.emailClickPct,                                          // Q
    v.unitsSoldWindow,                                        // R
    v.baselineAvgPerDay,                                      // S
    v.liftPct,                                                // T
    v.newSkuFirstWindowUnits,                                 // U
    v.grossRevenue,                                           // V
    v.resultNotes,                                            // W
  ];

  await appendRows(EVENTS_TAB, [row]);
  revalidatePath('/events');
  revalidatePath('/reorder'); // events influence reorder math
  return { ok: true, eventId };
}

/** Update an existing event row by 1-based sheet rowIndex. */
export async function updateEvent(
  rowIndex: number,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, error: 'Not authenticated.' };
  if (!Number.isFinite(rowIndex) || rowIndex < 2) {
    return { ok: false, error: 'Invalid row index.' };
  }

  const parsed = parseEventForm(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  await ensureEventsTab();
  const updates = buildEventCellPairs(parsed.values).map(({ col, value }) => ({
    range: `'${EVENTS_TAB}'!${col}${rowIndex}`,
    value,
  }));
  await batchUpdateCells(updates);
  revalidatePath('/events');
  revalidatePath('/reorder');
  return { ok: true };
}

/** Delete an event row by 1-based sheet rowIndex. Permanent. */
export async function deleteEvent(
  rowIndex: number,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return { ok: false, error: 'Not authenticated.' };
  if (!Number.isFinite(rowIndex) || rowIndex < 2) {
    return { ok: false, error: 'Invalid row index.' };
  }
  await deleteRows(EVENTS_TAB, [rowIndex]);
  revalidatePath('/events');
  revalidatePath('/reorder');
  return { ok: true };
}

// ---- Local helpers --------------------------------------------------------

interface EventValues {
  type: string;
  name: string;
  startDate: string;
  windowLengthDays: number | '';
  endDate: string;
  status: string;
  channels: string;
  linkedParents: string;
  newSkus: string;
  discountPct: number | '';
  expectedUnits: number | '';
  notes: string;
  excludeFromVelocityAvg: boolean;
  emailRecipients: number | '';
  emailOpenPct: number | '';
  emailClickPct: number | '';
  unitsSoldWindow: number | '';
  baselineAvgPerDay: number | '';
  liftPct: number | '';
  newSkuFirstWindowUnits: number | '';
  grossRevenue: number | '';
  resultNotes: string;
}

/** Coerce a FormDataEntryValue to either a number or '' for blank. Strips
 *  commas, percent signs, and surrounding whitespace before parsing. */
function parseNumLoose(v: FormDataEntryValue | null): number | '' {
  if (v === null || v === undefined) return '';
  const s = String(v).trim().replace(/,/g, '').replace(/%/g, '');
  if (s === '') return '';
  const n = Number(s);
  return Number.isFinite(n) ? n : '';
}
