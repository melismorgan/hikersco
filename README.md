# HIKERS Inventory

Custom multi-location inventory tracker for HIKERS Co. — sits beside the live
"ATS - 2026" Google Sheet, reads/writes through the Sheets API, hosted on Fly.io
at `inventory.hikersco.com`.

The Google Sheet remains the system of record. This app is a nicer skin and a
workflow engine on top: parent/child dashboards, PO wizard, barcode generation,
forecasting, mobile lookup.

## Stack

| Layer       | Choice                                        |
|-------------|-----------------------------------------------|
| Framework   | Next.js 14 (App Router) + React 18 + TypeScript |
| Styling     | Tailwind CSS 3 with HIKERS brand tokens baked in |
| Auth        | NextAuth (Google OAuth, email allow-list)     |
| Data        | Google Sheets API via `googleapis` + service account |
| Hosting     | Fly.io (Chicago region) — Docker standalone build |
| DNS         | Network Solutions → CNAME → Fly app           |

## First-time setup

See **[SETUP.md](./SETUP.md)** for the step-by-step. Plan ~45 minutes the first
time through.

## Local dev (after setup)

```sh
npm install
cp .env.example .env.local   # fill in the values
npm run dev
# → http://localhost:3000
```

## Deploy

```sh
fly deploy
```

## Layout

```
src/
  app/
    layout.tsx              Root layout, fonts, metadata
    page.tsx                Redirects → /login or /dashboard
    login/page.tsx          Google sign-in button
    dashboard/page.tsx      Main app (placeholder for week 1 fill-in)
    api/auth/[...nextauth]/ NextAuth route handler
  components/
    Header.tsx              Top nav
  lib/
    auth.ts                 NextAuth config + email allow-list
    brand.ts                BRAND palette (mirrors 13_brand.gs)
    sheets.ts               Google Sheets API wrapper
    utils.ts                cn() helper
  middleware.ts             Route protection
```

## Build plan reference

- **Week 1** — foundation + Apparel dashboard live (you're here)
- **Week 2** — read everything: Accessories, Velocity, Snapshots browser, multi-location on-hand
- **Week 3** — PO wizard, barcode generator UI, bookkeeper monthly CSV
- **Week 4** — forecasting v1 (PO-policy memo math)
- **Week 5** — alerts, mobile polish
- **Week 6** — migrate sync jobs from Apps Script to web app cron
