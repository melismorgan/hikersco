import { createElement, type ReactElement } from 'react';
import { NextResponse } from 'next/server';
import { renderToStream, type DocumentProps } from '@react-pdf/renderer';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { buildPoPdfData } from '@/lib/build-po-pdf-data';
import { PoPdf } from '@/lib/po-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ poNumber: string }>;
}

/**
 * GET /api/po/[poNumber]/pdf
 *
 * Builds the PoPdfData payload for the given PO# (joining POs tab + SKU
 * Master), renders it through @react-pdf/renderer, and streams the resulting
 * PDF back to the browser as `attachment` so it triggers a Save dialog.
 */
export async function GET(_req: Request, ctx: RouteContext) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { poNumber: rawPoNumber } = await ctx.params;
  const poNumber = decodeURIComponent(rawPoNumber).trim();
  if (!poNumber) {
    return new NextResponse('Missing PO number', { status: 400 });
  }

  const data = await buildPoPdfData(poNumber);
  if (!data) {
    return new NextResponse(`No PO rows found for ${poNumber}`, { status: 404 });
  }

  // The cast is safe — PoPdf returns a <Document> root, but TypeScript can't
  // narrow the wrapper-component return type through createElement.
  const element = createElement(PoPdf, { data }) as unknown as ReactElement<DocumentProps>;
  const stream = await renderToStream(element);

  // Convert Node Readable to web ReadableStream for the Response body.
  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      stream.on('end', () => controller.close());
      stream.on('error', (err: Error) => controller.error(err));
    },
  });

  const filename = `${poNumber}-HIKERS-PO.pdf`;
  return new NextResponse(webStream, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
