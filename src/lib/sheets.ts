import { google, sheets_v4 } from 'googleapis';

/**
 * Google Sheets client wrapper — backend reads/writes against the live
 * "ATS - 2026" tracker workbook using a service account.
 *
 * The service account email needs Editor access on the sheet (share the
 * sheet with it like a human). See SETUP.md for the full credential dance.
 *
 * Reads are intentionally simple. We pull whole tabs as 2D arrays and
 * project them into typed rows in code. At ~185 SKUs this is fine; if the
 * sheet ever grows past ~10k cells in a hot path, swap to batchGet or move
 * that tab into a real DB.
 */

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let cachedClient: sheets_v4.Sheets | null = null;

function getAuthClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !rawKey) {
    throw new Error(
      'Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_KEY. ' +
      'See SETUP.md → "Service account for Sheets API".',
    );
  }
  // The key arrives in slightly different shapes depending on how it was set:
  //  - .env.local via dotenv: dotenv strips surrounding quotes for us.
  //  - Fly secrets: stored verbatim, so wrapping quotes from the JSON or
  //    .env file pass through and break PEM parsing ("DECODER unsupported").
  // Strip wrapping quotes (if any), then convert literal "\n" to real newlines.
  const stripped = rawKey.trim().replace(/^["']/, '').replace(/["']$/, '');
  const privateKey = stripped.replace(/\\n/g, '\n');
  return new google.auth.JWT({ email, key: privateKey, scopes: SCOPES });
}

export function sheets(): sheets_v4.Sheets {
  if (cachedClient) return cachedClient;
  cachedClient = google.sheets({ version: 'v4', auth: getAuthClient() });
  return cachedClient;
}

export function sheetId(): string {
  const id = process.env.SHEET_ID;
  if (!id) throw new Error('Missing SHEET_ID env var. See .env.example.');
  return id;
}

/**
 * Read a tab as a 2D string array. First row is headers.
 * Empty trailing cells are returned as ''.
 */
export async function readTab(tabName: string): Promise<string[][]> {
  const res = await sheets().spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: `'${tabName}'`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  return (res.data.values ?? []) as string[][];
}

/**
 * Read a tab and project it into row objects keyed by header name.
 * Cells stay as raw values (string | number | boolean) so callers can
 * coerce per-column.
 */
export async function readTabAsRows<T extends Record<string, unknown> = Record<string, unknown>>(
  tabName: string,
): Promise<T[]> {
  const grid = await readTab(tabName);
  if (grid.length < 2) return [];
  const headers = grid[0].map((h) => String(h).trim());
  return grid.slice(1).map((row) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => (obj[h] = row[i] ?? ''));
    return obj as T;
  });
}

/** Append rows to the bottom of a tab. Each row is an array of cell values. */
export async function appendRows(tabName: string, rows: (string | number)[][]): Promise<void> {
  await sheets().spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: `'${tabName}'`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

// Cache of tab name → numeric sheet id (gid). Required for batchUpdate
// requests that target a specific sheet (delete row, etc.).
let _sheetIdCache: Map<string, number> | null = null;

async function getTabSheetId(tabName: string): Promise<number> {
  if (_sheetIdCache?.has(tabName)) return _sheetIdCache.get(tabName)!;
  const res = await sheets().spreadsheets.get({
    spreadsheetId: sheetId(),
    fields: 'sheets(properties(sheetId,title))',
  });
  const m = new Map<string, number>();
  for (const s of res.data.sheets ?? []) {
    if (s.properties?.title && typeof s.properties.sheetId === 'number') {
      m.set(s.properties.title, s.properties.sheetId);
    }
  }
  _sheetIdCache = m;
  const id = m.get(tabName);
  if (id === undefined) throw new Error(`Sheet tab "${tabName}" not found.`);
  return id;
}

/**
 * Ensure a tab with the given name exists. If absent, creates it via
 * batchUpdate addSheet. Returns whether the tab was just created.
 */
export async function ensureTabExists(tabName: string): Promise<{ created: boolean }> {
  // Drop the cache before checking so we don't see a stale "doesn't exist".
  _sheetIdCache = null;
  try {
    await getTabSheetId(tabName);
    return { created: false };
  } catch {
    // Not found — create it.
    await sheets().spreadsheets.batchUpdate({
      spreadsheetId: sheetId(),
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      },
    });
    _sheetIdCache = null;
    return { created: true };
  }
}

/**
 * Delete entire rows from a tab. Rows are identified by 1-based sheet row
 * number (header is 1, first data row is 2). We sort descending and submit
 * one batchUpdate so each deletion doesn't invalidate the still-pending
 * indexes — Sheets API processes batchUpdate requests sequentially against
 * the running state, so descending order keeps everything pointing at the
 * correct cells.
 */
export async function deleteRows(tabName: string, rowIndices: number[]): Promise<void> {
  if (rowIndices.length === 0) return;
  const tabId = await getTabSheetId(tabName);
  const sorted = [...new Set(rowIndices)].sort((a, b) => b - a);
  await sheets().spreadsheets.batchUpdate({
    spreadsheetId: sheetId(),
    requestBody: {
      requests: sorted.map((rowIndex) => ({
        deleteDimension: {
          range: {
            sheetId: tabId,
            dimension: 'ROWS',
            startIndex: rowIndex - 1,  // batchUpdate uses 0-based, exclusive end
            endIndex: rowIndex,
          },
        },
      })),
    },
  });
}

/**
 * Update specific cells via batch — efficient when you're modifying a few
 * fields on a known row rather than rewriting the whole row. Each entry's
 * `range` is an A1-style range (e.g. "'POs'!F12") and `value` is the single
 * cell value to write. Caller is responsible for column↔field mapping.
 */
export async function batchUpdateCells(
  updates: Array<{ range: string; value: string | number }>,
): Promise<void> {
  if (updates.length === 0) return;
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId(),
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates.map((u) => ({ range: u.range, values: [[u.value]] })),
    },
  });
}
