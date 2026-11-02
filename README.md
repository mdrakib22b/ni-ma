# Ni'ma — Personal Finance PWA

Net worth, budgets, investments and savings goals in one calm place.
An installable, offline-capable Progressive Web App — no framework, no build
step, client-side by default, with all data stored (optionally AES-256-encrypted)
on your own device. Optional end-to-end encrypted sync keeps devices in step
without the server ever being able to read your data.

**The app lives in [`project/pwa/`](project/pwa/) — see its README for
architecture, the security model, and development notes.**

## Quick start (local)

```bash
cd project/pwa
python3 -m http.server 8080     # or: npx serve .
```

Open http://localhost:8080. First launch runs onboarding; Settings › Data
lets you load a sample dataset or erase everything.

## Deploy (GitHub → Vercel)

1. **Push this repo to GitHub** (private recommended — it's a personal
   finance app):
   ```bash
   git remote add origin https://github.com/<you>/nimah-finance.git
   git push -u origin main
   ```
2. **Import into Vercel**: vercel.com → Add New → Project → import the repo.
   - Set **Root Directory** to `project/pwa`.
   - Framework preset: **Other** (static). No build command, no output dir.
   - `api/quotes.mjs` is picked up automatically as a serverless function;
     `vercel.json` applies the security headers (CSP, HSTS, frame denial…).
3. **Deploy**, open the `*.vercel.app` URL on your phone, and
   **Add to Home Screen** for the standalone app.
   On a computer, the same URL works as a regular website (sidebar
   navigation, centred dialogs); no install needed.
4. **Live prices (optional, any time later)**: add a `FINNHUB_KEY`
   environment variable in Vercel (free key at https://finnhub.io) and
   redeploy. The app probes its own `api/quotes` on startup and starts
   polling live quotes + real USD→CAD FX automatically — no code change
   needed. Without a key, prices simply hold at their last-known values
   (there is no simulator).
5. **Sync, password reset and bill reminders (optional)**: create a free
   Supabase project, run [`supabase/schema.sql`](supabase/schema.sql) in its
   SQL editor, and add the Supabase + VAPID environment variables in Vercel.
   Step-by-step in [`project/pwa/README.md`](project/pwa/README.md#encrypted-sync--reminders-optional).
   Without them the app works exactly as before: local-only, no accounts.

Every push to `main` redeploys production automatically.

## Repository layout

| Path | What it is |
|---|---|
| `project/pwa/` | **The deployable app** — HTML/JS, service worker, manifest, icons, quote proxy, sync functions |
| `supabase/schema.sql` | Database tables + row-level security for the optional sync backend |

## Security model (summary)

- Data stays on the device unless you turn on sync. Sync is end-to-end
  encrypted: the app encrypts everything with a random data key before upload,
  and only your password or recovery key (neither of which reaches the server)
  can unlock that key. The server stores ciphertext, your email, and — with
  reminders on — the dates bills fall due.
- Optional app passcode encrypts the store at rest (AES-256-GCM, key derived
  via PBKDF2-SHA-256 · 600k rounds, held only in memory).
- CSP + hardened headers ship as both a `<meta>` tag and Vercel headers.
- The Finnhub key stays server-side in the quote proxy; same-origin only by
  default (`ALLOWED_ORIGIN` env var to allowlist others).

Details in [`project/pwa/README.md`](project/pwa/README.md).
