import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/sync/status
 *
 * Polls the Apps Script Web App for orchestrator status: whether a sync
 * is currently pending/running, and the summary of the last completed
 * run (per-handler results, timing, error messages).
 *
 * The /sync page polls this every 5 sec while pending, every 30 sec
 * when idle.
 */
export async function GET() {
  const url    = process.env.APPS_SCRIPT_WEBAPP_URL;
  const secret = process.env.SYNC_API_SECRET;
  if (!url || !secret) {
    return NextResponse.json({
      ok: false,
      error: 'Sync API not configured. Set APPS_SCRIPT_WEBAPP_URL and SYNC_API_SECRET as Fly secrets.',
    }, { status: 500 });
  }

  try {
    const r = await fetch(`${url}?secret=${encodeURIComponent(secret)}`, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
    });
    const text = await r.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
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
