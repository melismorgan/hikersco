import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/sync/run
 *
 * Forwards a "sync all" request to the Apps Script Web App orchestrator.
 * The shared secret + the deploy URL are server-side env vars — they
 * never reach the browser. Apps Script runs the orchestrator
 * fire-and-forget; this endpoint returns the schedule confirmation
 * within ~1 sec.
 *
 * Required env vars:
 *   APPS_SCRIPT_WEBAPP_URL — full /exec URL of the deployed Web App
 *   SYNC_API_SECRET        — shared secret matching the value in the
 *                            Apps Script project's SYNC_API_SECRET
 *                            Script Property
 */
export async function POST() {
  const url    = process.env.APPS_SCRIPT_WEBAPP_URL;
  const secret = process.env.SYNC_API_SECRET;
  if (!url || !secret) {
    return NextResponse.json({
      ok: false,
      error: 'Sync API not configured. Set APPS_SCRIPT_WEBAPP_URL and SYNC_API_SECRET as Fly secrets.',
    }, { status: 500 });
  }

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, action: 'syncAll' }),
      // Apps Script /exec issues a 302 → /usercontent/exec; fetch follows
      // by default. Explicit here for clarity.
      redirect: 'follow',
      cache: 'no-store',
    });
    const text = await r.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      // Apps Script returned non-JSON — usually means an HTML error page
      // (auth issue, bad URL, deploy not active). Surface the first chunk.
      return NextResponse.json({
        ok: false,
        error: 'Apps Script returned non-JSON response',
        body: text.slice(0, 500),
      }, { status: 502 });
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
