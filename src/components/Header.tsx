'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface HeaderProps {
  email?: string | null;
}

interface NavItem {
  href: string;
  label: string;
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

// Noun-based grouping (Stock / Sales / Orders / Money) — picked over the
// verb framing because the labels read naturally and Events lands where it
// feels right (with Sales & Marketing). Worth re-evaluating after a couple
// weeks of use; if anyone reaches for the wrong dropdown twice, regroup.
const NAV: NavGroup[] = [
  {
    label: 'Sales',
    items: [
      { href: '/marketing', label: 'Sales & Marketing' },
      { href: '/velocity', label: 'Velocity' },
      { href: '/events', label: 'Events' },
    ],
  },
  {
    label: 'Stock',
    items: [
      { href: '/dashboard', label: 'Apparel' },
      { href: '/accessories', label: 'Accessories' },
    ],
  },
  {
    label: 'Orders',
    items: [
      { href: '/reorder', label: 'Reorder' },
      { href: '/pos', label: 'POs' },
      { href: '/shipments', label: 'Shipments' },
    ],
  },
  {
    label: 'Money',
    items: [
      { href: '/cashflow', label: 'Cashflow' },
      { href: '/landed-cost', label: 'Landed Cost' },
      { href: '/costs', label: 'Costs' },
    ],
  },
  {
    label: 'Customer',
    items: [
      { href: '/cs', label: 'CS Dashboard' },
    ],
  },
];

export function Header({ email }: HeaderProps) {
  const pathname = usePathname();
  return (
    <header className="border-b border-warm-gray/60 bg-warm-white">
      <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
        <Link href="/marketing" className="font-display text-2xl tracking-tight">
          HIKERS Dashboard
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {NAV.map((group) => (
            <NavDropdown key={group.label} group={group} pathname={pathname} />
          ))}
          {email && (
            <span className="text-charcoal/60 ml-4 hidden md:inline">{email}</span>
          )}
        </nav>
      </div>
    </header>
  );
}

function NavDropdown({
  group,
  pathname,
}: {
  group: NavGroup;
  pathname: string | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside (so opening another dropdown / clicking elsewhere
  // dismisses the currently-open one).
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  // Highlight the parent label when the current page lives inside this group.
  const isActiveGroup = group.items.some((item) => pathname === item.href);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        className={
          'px-3 py-1.5 rounded-md transition-colors flex items-center gap-1 ' +
          (isActiveGroup
            ? 'text-indigo font-medium'
            : 'text-charcoal/80 hover:text-indigo')
        }
      >
        {group.label}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={'opacity-60 transition-transform ' + (open ? 'rotate-180' : '')}
          aria-hidden
        >
          <path
            d="M2 4l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          className="absolute top-full right-0 mt-1 min-w-[180px] bg-warm-white border border-warm-gray/40 rounded-md shadow-lg py-1 z-50"
          role="menu"
        >
          {group.items.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                role="menuitem"
                className={
                  'block px-3 py-2 text-sm transition-colors ' +
                  (active
                    ? 'bg-indigo/10 text-indigo font-medium'
                    : 'text-charcoal/80 hover:bg-warm-gray/20')
                }
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
