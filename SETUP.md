# SETUP — first-time setup runbook

This is the do-once dance. After this, deploys are just `fly deploy`. Plan ~45
minutes the first time. Stop and ask if anything is unclear — most of these
steps have small "gotchas" hiding inside them.

## 1. Install local prerequisites

You probably already have Node from other work. If not:

```sh
# macOS — install Node 20+ via Homebrew
brew install node@20

# Fly CLI
brew install flyctl
```

Verify:

```sh
node --version    # should be >= 20.0
flyctl version
```

## 2. Install project dependencies

From this directory (`inventory-app/`):

```sh
npm install
```

Then create your local env file:

```sh
cp .env.example .env.local
```

Leave it open in your editor — the next steps fill it in.

## 3. Generate a NextAuth secret

```sh
openssl rand -base64 32
```

Copy the output into `.env.local` as `NEXTAUTH_SECRET=...`.

## 4. Google Cloud — OAuth credentials (for sign-in)

You may already have a Google Cloud project from the SP-API work. You can reuse
it or create a new one. I'd reuse — fewer projects to babysit.

1. Open [console.cloud.google.com](https://console.cloud.google.com).
2. Pick the HIKERS project (top bar). If creating new, name it `hikers-inventory`.
3. **APIs & Services → Library** → enable **Google Sheets API**.
4. **APIs & Services → OAuth consent screen** → External → fill in app name
   "HIKERS Inventory", your email as support contact. Add `melissa@hikersco.com`
   as a test user. Save.
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Name: `HIKERS Inventory web`
   - Authorized JavaScript origins:
     - `http://localhost:3000`
     - `https://inventory.hikersco.com`
   - Authorized redirect URIs:
     - `http://localhost:3000/api/auth/callback/google`
     - `https://inventory.hikersco.com/api/auth/callback/google`
6. Copy the **Client ID** → `GOOGLE_CLIENT_ID` in `.env.local`.
7. Copy the **Client secret** → `GOOGLE_CLIENT_SECRET` in `.env.local`.

## 5. Google Cloud — service account (for Sheets API reads/writes)

OAuth lets *you* sign in. The service account is how the *server* talks to the
sheet for syncs and dashboard reads.

1. Same Cloud project → **IAM & Admin → Service Accounts → Create**.
2. Name: `hikers-inventory-sheets`. Description: "Reads/writes the ATS - 2026 sheet."
3. Skip the optional role grants (we control access at the sheet level).
4. After creation, click into the service account → **Keys → Add Key → JSON**.
   A JSON file downloads. Open it.
5. From that JSON:
   - `client_email` value → `GOOGLE_SERVICE_ACCOUNT_EMAIL` in `.env.local`
   - `private_key` value (the whole BEGIN/END block, quotes and all) →
     `GOOGLE_SERVICE_ACCOUNT_KEY` in `.env.local`. The literal `\n` characters
     are fine; the loader converts them.
6. **Share your sheet** with that service account email as **Editor**, just
   like sharing with a person:
   - Open the ATS - 2026 sheet
   - Click Share
   - Paste `hikers-inventory-sheets@<project>.iam.gserviceaccount.com`
   - Set to **Editor**, uncheck "Notify people", Send.
7. Move the downloaded JSON somewhere safe (1Password, password manager) and
   delete it from Downloads. **Never commit it to git.**

## 6. Confirm the sheet ID

Default in `.env.example` is the live "ATS - 2026" workbook. Confirm it matches
the URL of your sheet (the long string between `/d/` and `/edit`).

## 7. Run it locally

```sh
npm run dev
```

Open `http://localhost:3000`. You should land on the login page, sign in with
Google, and arrive at the dashboard. If you see "AccessDenied," check that
your email matches `ALLOWED_EMAILS` in `.env.local` (case-insensitive).

## 8. Set up Fly.io for the first deploy

```sh
fly auth signup       # or: fly auth login if you already have an account
```

From this directory:

```sh
# This reads fly.toml. Don't accept the prompt to create a new app — say no
# to "Would you like to copy its configuration to the new app?" and let it
# use the existing fly.toml.
fly launch --no-deploy --copy-config --name hikers-inventory --region ord
```

If `hikers-inventory` is already taken globally on Fly, pick a different name
and update `app = "..."` in `fly.toml`.

## 9. Push secrets to Fly

Fly doesn't read `.env.local` — secrets must be set explicitly:

```sh
fly secrets set \
  NEXTAUTH_SECRET="$(grep ^NEXTAUTH_SECRET .env.local | cut -d= -f2-)" \
  NEXTAUTH_URL="https://inventory.hikersco.com" \
  GOOGLE_CLIENT_ID="$(grep ^GOOGLE_CLIENT_ID .env.local | cut -d= -f2-)" \
  GOOGLE_CLIENT_SECRET="$(grep ^GOOGLE_CLIENT_SECRET .env.local | cut -d= -f2-)" \
  ALLOWED_EMAILS="$(grep ^ALLOWED_EMAILS .env.local | cut -d= -f2-)" \
  GOOGLE_SERVICE_ACCOUNT_EMAIL="$(grep ^GOOGLE_SERVICE_ACCOUNT_EMAIL .env.local | cut -d= -f2-)" \
  SHEET_ID="$(grep ^SHEET_ID .env.local | cut -d= -f2-)"
```

The service-account private key is multi-line, so push it separately to avoid
shell-quoting headaches:

```sh
fly secrets set GOOGLE_SERVICE_ACCOUNT_KEY="$(grep ^GOOGLE_SERVICE_ACCOUNT_KEY .env.local | cut -d= -f2-)"
```

If that misbehaves, paste the value into a file `key.txt` and run
`fly secrets set GOOGLE_SERVICE_ACCOUNT_KEY="$(cat key.txt)"`. Delete `key.txt`
after.

## 10. First deploy

```sh
fly deploy
```

When it finishes, `fly open` to verify it's serving on the fly.dev URL. You
won't be able to sign in yet from that URL because the OAuth redirect is set to
`inventory.hikersco.com`. That's fine — DNS step next.

## 11. DNS — point inventory.hikersco.com at Fly

In Fly:

```sh
fly certs create inventory.hikersco.com
fly certs show inventory.hikersco.com
```

Fly will print the exact DNS records you need to add. Typically two:
- A CNAME (or A/AAAA pair if your DNS doesn't allow CNAME at the apex — not
  applicable here since we're on a subdomain).
- An `_acme-challenge` CNAME for cert validation.

In Network Solutions:
1. Log in → Manage Account → DNS Settings for `hikersco.com`.
2. Add a **CNAME** record:
   - Host: `inventory`
   - Points to: the value Fly gave you (typically `<app>.fly.dev` or the
     specific edge target shown in `fly certs show`).
   - TTL: 3600 (or default).
3. Add the `_acme-challenge.inventory` CNAME if Fly requested one.
4. Save. Network Solutions usually propagates within 15 minutes.

Verify:

```sh
fly certs show inventory.hikersco.com
# Wait for "Configured" / "Valid" status, then:
open https://inventory.hikersco.com
```

## 12. You're live

Sign in. You should see the dashboard placeholder confirming auth and brand are
wired correctly.

## Troubleshooting

**"AccessDenied" after sign-in.** Your email isn't in `ALLOWED_EMAILS`. Update
`.env.local` and `fly secrets set ALLOWED_EMAILS=...` and redeploy.

**"Missing GOOGLE_SERVICE_ACCOUNT_EMAIL" on Fly.** You forgot a `fly secrets set`.
Run `fly secrets list` to see what's there.

**"PERMISSION_DENIED" reading the sheet.** You forgot to share the sheet with
the service account email. Do step 5.6 above.

**OAuth redirect_uri_mismatch.** The redirect URI in Google Cloud Credentials
doesn't exactly match what NextAuth is sending. Common cause: missing trailing
path or `http` vs `https`. Re-check step 4.5.

**Cert stuck on "Awaiting configuration".** DNS hasn't propagated. Give it 15
minutes. `dig inventory.hikersco.com` from terminal will show what's resolving.

## What's next

After you're live, ping me and we'll start filling in the Apparel dashboard
with the real parent/child grid. Week 1 wraps when you can pull up live SKU
on-hand for any style on your phone in the warehouse.
