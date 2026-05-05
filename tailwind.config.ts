import type { Config } from 'tailwindcss';

// HIKERS Co. brand palette — ratified by Matt 2026-04-20.
// Single source of truth shared with src/lib/brand.ts. If you edit one, edit both.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Core brand
        indigo: {
          DEFAULT: '#4A5490', // primary
          wash: '#E6E8F1',    // PO status — Draft
        },
        periwinkle: {
          DEFAULT: '#7A84AC', // secondary, column headers, data-bar fill
          wash: '#DDE1EE',    // PO status — Submitted
        },
        ironclad: {
          DEFAULT: '#B63B38', // Days Cover <14 / ETA past due
        },
        clay: {
          DEFAULT: '#C98A55', // Days Cover 14–30 / ETA within 7 days
        },
        sage: {
          DEFAULT: '#7F8B6C', // Days Cover ≥30
          wash: '#EAEDE2',    // PO status — Received
        },
        // Neutrals
        warm: {
          white: '#FAF8F3',
          beige: '#EFE9DD',
          gray:  '#D3CEC4',
          // Pre-blended `warmWhite × 70% + warmBeige × 30%` — used for the
          // alternating row tint. Must be OPAQUE (not an alpha overlay) so it
          // works correctly under sticky-positioned identity columns.
          tint:  '#F7F4EC',
        },
        charcoal: '#1F2337',
        // PO-status: cancelled
        cancelled: '#E5E2DA',
      },
      fontFamily: {
        // Fraunces — display serif (page titles, KPI numbers)
        // Work Sans — body sans (everything else)
        // Roboto Mono — hex codes, SKUs, numeric tabular columns
        display: ['var(--font-fraunces)', 'ui-serif', 'Georgia', 'serif'],
        sans:    ['var(--font-work-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono:    ['var(--font-roboto-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
