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
