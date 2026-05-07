import Link from 'next/link';

interface HeaderProps {
  email?: string | null;
}

export function Header({ email }: HeaderProps) {
  return (
    <header className="border-b border-warm-gray/60 bg-warm-white">
      <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
        <Link href="/dashboard" className="font-display text-2xl tracking-tight">
          HIKERS Inventory
        </Link>
        {/* Visual grouping: pipes separate logical groups without forcing dropdowns.
            • Stock        : Apparel, Accessories
            • Sales        : Velocity, Reorder, Events
            • Pipeline     : POs, Shipments
            • Finance      : Cashflow, Landed Cost
        */}
        <nav className="flex items-center gap-x-4 gap-y-2 text-sm flex-wrap">
          <Link href="/dashboard" className="hover:text-indigo">Apparel</Link>
          <Link href="/accessories" className="hover:text-indigo">Accessories</Link>
          <span className="text-warm-gray select-none" aria-hidden>|</span>
          <Link href="/velocity" className="hover:text-indigo">Velocity</Link>
          <Link href="/reorder" className="hover:text-indigo">Reorder</Link>
          <Link href="/events" className="hover:text-indigo">Events</Link>
          <span className="text-warm-gray select-none" aria-hidden>|</span>
          <Link href="/pos" className="hover:text-indigo">POs</Link>
          <Link href="/shipments" className="hover:text-indigo">Shipments</Link>
          <span className="text-warm-gray select-none" aria-hidden>|</span>
          <Link href="/cashflow" className="hover:text-indigo">Cashflow</Link>
          <Link href="/landed-cost" className="hover:text-indigo">Landed Cost</Link>
          {email && (
            <span className="text-charcoal/60 ml-4 hidden md:inline">{email}</span>
          )}
        </nav>
      </div>
    </header>
  );
}
