# Ni'ma — Personal Finance PWA

An installable, offline-capable Progressive Web App. Net worth, budgets,
investments and savings goals in one place.

## Run locally

Any static file server works — the app itself is client-side (the optional
sync functions under `api/` only run on Vercel). From this folder:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open the printed URL. Installing (Add to Home Screen / install icon in the
address bar) gives a standalone, full-screen app that also works offline.

> Open via a server, **not** `file://` — service workers and the manifest only
> register over `http(s)`.

## First launch & your data

- **Onboarding** runs once on first launch (`Onboarding.dc.html`): name,
  display currency, starting account balances, an optional app passcode
  and reminders. Finishing it starts you with a
  clean ledger seeded from your answers (encrypted from the very first
  save if you set a passcode).
- **Everything persists on-device** in `localStorage` under `nima_data_v1` —
  transactions, budgets, accounts, holdings, goals, debts and settings survive
  reloads and app restarts. Nothing leaves the device unless you sign in to
  sync (Settings › Account & sync, shown only when the deployment has it).
- **Settings › Data › Load demo data** fills the app with the sample
  ledger/portfolio if you want to explore; **Erase all data** wipes the store
  and returns to onboarding.

## Security model

- **Local-first data.** Without sync, nothing is uploaded anywhere.
  React/ReactDOM **and the brand font** are self-hosted under `vendor/`
  (loaded same-origin — no runtime CDN, no Google Fonts, so the app boots and
  renders correctly even when a CDN is blocked or offline). Every outbound
  call goes to this deployment's own `api/` functions: `api/quotes` (quotes
  from Finnhub, daily ECB exchange rates) and, if you turn on sync,
  `api/account` / `api/vault` / `api/push`.
- **End-to-end encrypted sync (opt-in).** The app encrypts the store with a
  random 256-bit data key (AES-256-GCM) before uploading it. Your password is
  stretched on the device (PBKDF2-SHA-256, 600k rounds, salted with your
  email) and split with HKDF into a sign-in key — the only thing the server
  ever receives — and a key that locks the data key. A random 160-bit
  recovery key, shown once, locks it a second way. The server stores the
  ciphertext, the two locked copies of the data key, your email and, with
  reminders on, the dates bills fall due. It can't decrypt any of it.
  Password reset works by email; your data survives it if you still have a
  signed-in device or your recovery key. With neither, the synced copy is
  unrecoverable by design. On a device with an app passcode, the sync
  session (refresh token + data key) is sealed with the passcode key too.
- **Encryption at rest (opt-in).** Settings › App passcode encrypts the
  entire store with AES-256-GCM via WebCrypto. The key is derived from your
  passcode (PBKDF2-SHA-256, 600k rounds, random salt), held only in memory,
  and never written or transmitted. The app then boots to a lock screen;
  a forgotten passcode is unrecoverable by design (lock screen offers a full
  erase). "Lock app" in Settings locks instantly.
- **Content-Security-Policy** is set both as a `<meta>` tag (any host) and as
  response headers on Vercel (`vercel.json`), alongside `nosniff`,
  `frame-ancestors 'none'`/`X-Frame-Options: DENY` (no clickjacking),
  `Referrer-Policy: no-referrer`, COOP, HSTS and a restrictive
  Permissions-Policy. Note: `script-src` keeps `'unsafe-eval'` because the
  no-build template runtime compiles the app's logic class with
  `new Function`, and `'unsafe-inline'` for the inline SW registration.
- **Quote proxy** (`api/quotes.mjs`): GET-only, strict symbol validation,
  no CORS by default (same-origin); cross-origin callers must be allowlisted
  via the `ALLOWED_ORIGIN` env var. The Finnhub key stays server-side.
- **Service worker** never caches `/api/` responses or non-OK responses, and
  only falls back to the app shell for navigations.
- There is no Face ID / biometric unlock — the passcode lock above is the
  enforced protection.

## Files

- `index.html` — the whole app. It's a self-rendering template driven by
  `support.js` (the runtime is loaded from `<script src="./support.js">`).
  App logic lives in the `<script data-dc-script>` block near the bottom.
- `Onboarding.dc.html` — the first-launch flow, loaded as a sibling component
  and gated behind the persisted `hasOnboarded` flag.
- `support.js` — rendering runtime for the template. No build step.
- `vendor/` — self-hosted React/ReactDOM and the Geist variable font (SIL OFL)
  (all precached by the service worker; no runtime CDN).
- `price-feed.js` — client that polls the quote proxy for live prices.
- `sync.js` — the sync client's crypto (key derivation, data-key wrapping,
  AES-GCM) and its calls to the `api/` functions.
- `manifest.webmanifest` — PWA metadata (name, icons, theme, standalone).
- `sw.js` — service worker: precaches the app shell, serves it offline, and
  always bypasses the cache for `/api/` so quotes stay fresh. Bump `CACHE`
  (`nimah-vN`) whenever you change cached assets.
- `icon-*.png`, `apple-touch-icon.png` — app icons (incl. a maskable icon).
- `api/quotes.mjs` — **server-side** price proxy (Vercel / Netlify / Cloudflare).
  Keeps your Finnhub key off the client. Must stay `.mjs`: the repo is
  `type:module`, so a `.js` handler is loaded as ESM and crashes on Vercel.
- `api/account.mjs`, `api/vault.mjs`, `api/push.mjs` — **server-side** sync
  functions: thin pass-throughs to Supabase Auth and Postgres (no SDK, plain
  `fetch`), running every query as the signed-in user so row-level security
  applies. `api/reminders.mjs` is the daily cron job. Files starting with `_`
  are shared helpers, not functions.
- `vercel.json` — security headers (CSP, HSTS, frame denial, etc.) for the
  deployed site, and the daily reminders cron.

## Deploy (GitHub → Vercel)

1. Push this repo to GitHub.
2. In Vercel: **Add New → Project**, import the repo, and set
   **Root Directory** to `project/pwa`. No build command needed (static site;
   `api/quotes.mjs` is picked up automatically as a serverless function).
3. Deploy. Open the `*.vercel.app` URL in Safari/Chrome on your phone and
   **Add to Home Screen** — you get a standalone, offline-capable app.
   On a computer the same URL works as a regular website: a sidebar replaces
   the phone's bottom tab bar and sheets open as centred dialogs. Installing
   there is optional, through the browser's own install button in the address
   bar.

## Live prices

Prices are live-only — there is no simulator. The app **auto-detects** the
feed: when served over https it probes the same-origin `api/quotes` once at
startup and starts polling real quotes (15s + live USD→CAD FX) if the proxy
answers; otherwise prices hold at their last-known values and the invest
header reads Offline (or Market Closed outside 9:30–16:00 ET / weekends).

To make the proxy answer, set the env var `FINNHUB_KEY` on your Vercel project
(free key from https://finnhub.io) and redeploy. No client change needed.
You can still hard-wire a different proxy by setting `this.PRICE_FEED_URL`
in `index.html`.

## Encrypted sync & reminders (optional)

Adds sign-in, sync across devices, password reset and bill reminders that
arrive while the app is closed. Free tiers cover personal use. Until the env
vars below exist, the app hides all of it and stays local-only.

1. **Supabase** — create a project at https://supabase.com (free tier). In
   **SQL Editor**, paste and run [`supabase/schema.sql`](../../supabase/schema.sql)
   from the repo root (two tables, both locked down with row-level security).
2. **Auth URLs** — in Supabase, **Authentication → URL Configuration**: set
   **Site URL** to your deployed URL (e.g. `https://your-app.vercel.app`) and
   add the same URL under **Redirect URLs**. Confirmation and reset emails
   link back there. Supabase's built-in email sender is heavily rate-limited
   and meant for testing; for real use, add your own SMTP (e.g. Resend's free
   tier) under **Authentication → Emails → SMTP Settings**.
3. **Vercel env vars** (Settings → Environment Variables), from Supabase
   **Project Settings → API Keys**:
   - `SUPABASE_URL` — `https://<project>.supabase.co`
   - `SUPABASE_ANON_KEY` — the anon / publishable key
   - `SUPABASE_SERVICE_ROLE_KEY` — the service_role / secret key (used only
     server-side, for "Delete account" and the reminders job)
4. **Reminders** (optional): run `npm run vapid` at the repo root and add the
   two lines it prints (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`), plus
   `VAPID_SUBJECT` (`mailto:you@example.com`) and `CRON_SECRET` (any long
   random string). `vercel.json` runs `api/reminders` once a day at 12:00 UTC
   (Vercel Hobby allows daily crons); it sends an **empty** push to each device
   with a bill due that day, and the service worker shows a fixed "a bill is
   due" notification. On iPhone, push works only for the app added to the Home
   Screen (iOS 16.4+).
5. **Redeploy** (functions only see env vars from a deployment built after
   they were added).

Notes: a free Supabase project pauses after about a week without activity;
the reminders job queries it daily once it's configured, which should keep it
awake (if it does pause, un-pause it from the Supabase dashboard). Email
change isn't supported (the email salts the password key).

## Notes for further development

- No framework, no bundler — edit `index.html` and reload. (Dev-only lint +
  smoke tests live at the repo root: `npm install && npm run check` there.)
- Styling is inline; shared animations are in the `<style>` block in `<helmet>`.
- State is a single React-style class in the `<script data-dc-script>` block;
  `renderVals()` returns everything the template binds to. Durable keys are
  listed in `DATA_KEYS`; anything else is transient UI state.
- The display currency (Settings › Currency) really converts: everything is
  stored in CAD and rendered in the chosen currency using daily ECB rates
  fetched through the quote proxy. When live rates aren't available the app
  falls back to showing CAD rather than faking a conversion. Investment
  holdings keep their native currency and convert only at display time.
