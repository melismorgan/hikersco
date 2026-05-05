import Link from 'next/link';

interface HeaderProps {
  email?: string | null;
}

export function Header({ email }: HeaderProps) {
  return (
    <header className="border-b border-warm-gray/60 bg-warm-white">
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        <Link href="/dashboard" className="font-display text-2xl tracking-tight">
          HIKERS Inventory
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <Link href="/dashboard" className="hover:text-indigo">Apparel</Link>
          <span className="text-warm-gray cursor-not-allowed" title="Coming week 2">Accessories</span>
          <span className="text-warm-gray cursor-not-allowed" title="Coming week 2">Velocity</span>
          <span className="text-warm-gray cursor-not-allowed" title="Coming week 3">POs</span>
          {email && (
            <span className="text-charcoal/60 ml-4 hidden md:inline">{email}</span>
          )}
        </nav>
      </div>
    </header>
  );
}
