import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Header } from '@/components/Header';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  // Middleware enforces auth; this is a defensive null check.
  const email = session?.user?.email ?? null;

  return (
    <>
      <Header email={email} />
      <main className="max-w-7xl mx-auto px-6 py-12">
        <div className="mb-10">
          <h1 className="text-4xl mb-2">Apparel dashboard</h1>
          <p className="text-charcoal/70">
            Hello, {email}. The foundation is live — week 1 will fill this in with the
            real parent/child rollup pulled from the live tracker workbook.
          </p>
        </div>

        <div className="rounded-lg border border-warm-gray/60 bg-warm-beige/40 p-6">
          <p className="text-sm text-charcoal/70 mb-4">
            <span className="font-semibold">Day-1 status:</span> auth, brand, Sheets client,
            and Fly deploy config are wired. Next up: read SKU Master from the live sheet
            and render the parent/child grid.
          </p>
          <details className="text-xs text-charcoal/60 mt-3">
            <summary className="cursor-pointer">What lights up next</summary>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Apparel grid — Style / Color / SKU / Size with editorial-minimal styling</li>
              <li>Multi-location on-hand — ShipBob WI, Amazon FBA, in-transit, Draft POs</li>
              <li>Accessories tab, Velocity tab, Snapshots browser</li>
              <li>PO wizard, barcode generator, bookkeeper monthly export</li>
              <li>Forecasting using your PO-policy memo (75/25 Amz:SB, 100-unit floor, 45-day slow-mover gate)</li>
            </ul>
          </details>
        </div>
      </main>
    </>
  );
}
