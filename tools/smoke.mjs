#!/usr/bin/env node
// End-to-end smoke test for the Ni'ma PWA. Boots the static app in a real
// browser and asserts the things that have actually broken before:
//   - the app renders without a page error
//   - the service worker registers, controls the page, and the app works OFFLINE
//   - the manifest is installable (name + 192/512 icons + standalone)
//   - Budget -> Plan -> New section -> "Create section" actually adds a section
//     (regression guard for the duplicate-`saveSection` shadowing bug)
//
// Self-contained: serves project/pwa on an ephemeral port, runs, tears down.
// Requires a Chromium (Playwright downloads one, or set PLAYWRIGHT_BROWSERS_PATH).

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { chromium } from 'playwright';

// -- tiny zip/xlsx builder so the smoke test can feed the app a REAL .xlsx --
const crc32 = (buf) => {
  let crc = 0xFFFFFFFF;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
};
const buildZip = (entries) => {
  const parts = [], cd = []; let off = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text, 'utf8'), comp = deflateRawSync(data), n = Buffer.from(name), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    parts.push(lh, n, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    cd.push(ch, n);
    off += 30 + n.length + comp.length;
  }
  const cdBuf = Buffer.concat(cd), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
};
const buildXlsx = () => {
  // one sheet, fuzzy name ("My Trades"), shared strings, and the date as an
  // Excel serial (45719 = 2025-03-03) to exercise serial->ISO conversion.
  const sst = ['date', 'account', 'ticker', 'action', 'shares', 'price', 'currency', 'fees', 'QT-TFSA', 'SPUS', 'BUY', 'USD'];
  const s = (i) => `<c t="s"><v>${i}</v></c>`, num = (v) => `<c><v>${v}</v></c>`;
  return buildZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'],
    ['xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="My Trades" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/sharedStrings.xml', `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sst.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`],
    ['xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + `<row r="1">${[0, 1, 2, 3, 4, 5, 6, 7].map(s).join('')}</row>`
      + `<row r="2">${num(45719)}${s(8)}${s(9)}${s(10)}${num(10)}${num(41.25)}${s(11)}${num(1.5)}</row>`
      + '</sheetData></worksheet>'],
  ]);
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PWA = join(root, 'project', 'pwa');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' || p.endsWith('/')) p += 'index.html';
    const file = normalize(join(PWA, p));
    if (!file.startsWith(PWA)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
});

const failures = [];
const check = (cond, label) => { if (!cond) failures.push(label); console.log(`  ${cond ? '✓' : '✗'} ${label}`); };

// --- proxy FX-table derivation (no network): stub fetch + invoke the handler ---
console.log('quotes proxy — FX table:');
{
  // quotes.mjs is a native-ESM serverless function (the repo is type:module and
  // Vercel loads it as ESM). Import it and drive the default handler with a
  // stubbed global fetch (no network) and a test key.
  const prevKey = process.env.FINNHUB_KEY;
  const prevFetch = globalThis.fetch;
  process.env.FINNHUB_KEY = 'test-key';
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => url.includes('frankfurter')
      ? { base: 'CAD', rates: { USD: 0.734, EUR: 0.68, GBP: 0.58 } }   // units per 1 CAD
      : { c: 100, pc: 99, t: Math.floor(Date.now() / 1000) },           // finnhub quote
  });
  const { default: handler } = await import(pathToFileURL(join(PWA, 'api', 'quotes.mjs')).href);
  let out = null;
  // native-style res: the handler writes JSON via res.end(payload)
  const res = { setHeader() {}, statusCode: 200, end(body) { out = body ? JSON.parse(body) : null; } };
  await handler({ method: 'GET', query: { symbols: 'AAPL' }, headers: {}, url: '/api/quotes?symbols=AAPL' }, res);
  check(!!out && out.fxRates && out.fxRates.CAD === 1 && out.fxRates.USD === 0.734,
    'proxy returns a base-CAD fxRates table (CAD:1, live rates)');
  check(!!out && out.fx && Math.abs(out.fx.USDCAD - 1 / 0.734) < 0.01,
    'proxy derives USD→CAD (fx.USDCAD) from the same table');
  // history endpoint: keyless daily closes (Yahoo source, stubbed) that the
  // client backfills into the portfolio chart so day-to-day moves show even for
  // days the app wasn't open. now-relative dates so the check never rots.
  const hd1 = new Date(Date.now() - 5 * 86400000), hd2 = new Date(Date.now() - 2 * 86400000);
  const hIso = (dt) => dt.toISOString().slice(0, 10), hEp = (dt) => Math.floor(dt.getTime() / 1000);
  globalThis.fetch = async (url) => ({
    ok: true,
    text: async () => '',
    json: async () => url.includes('finance.yahoo.com')
      ? { chart: { result: [{ timestamp: [hEp(hd1), hEp(hd2)], indicators: { quote: [{ close: [100, 98] }] } }] } }
      : {},
  });
  let hout = null;
  const hres = { setHeader() {}, statusCode: 200, end(body) { hout = body ? JSON.parse(body) : null; } };
  await handler({ method: 'GET', query: { history: 'AAPL', days: '30' }, headers: {}, url: '/api/quotes?history=AAPL&days=30' }, hres);
  check(!!hout && Array.isArray(hout.history) && hout.history.length === 2 && hout.history[0][0] === hIso(hd1) && hout.history[1][1] === 98,
    'proxy history endpoint returns native daily closes ([date, close]) for chart backfill');
  globalThis.fetch = prevFetch;
  if (prevKey === undefined) delete process.env.FINNHUB_KEY; else process.env.FINNHUB_KEY = prevKey;
}

// --- sync / push serverless functions (no network): stub Supabase + invoke ---
console.log('sync backend — account / vault / push / reminders handlers:');
{
  const { generateKeyPairSync, createPublicKey, verify } = await import('node:crypto');
  const prevFetch = globalThis.fetch;
  const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'svc-key',
    CRON_SECRET: 'cron-secret', VAPID_SUBJECT: 'mailto:test@example.com' };
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  ENV.VAPID_PRIVATE_KEY = jwk.d;
  ENV.VAPID_PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  const prevEnv = {};
  for (const k in ENV) { prevEnv[k] = process.env[k]; process.env[k] = ENV[k]; }
  const load = async (name) => (await import(pathToFileURL(join(PWA, 'api', name)).href)).default;
  const call = async (handler, req) => {
    let out = null, status = 0;
    const res = { setHeader() {}, set statusCode(s) { status = s; }, get statusCode() { return status; }, end(b) { out = b ? JSON.parse(b) : null; } };
    await handler({ headers: {}, query: {}, url: '/', ...req }, res);
    return { status, body: out };
  };
  const calls = [];
  const stub = (fn) => { globalThis.fetch = async (url, opts = {}) => { calls.push({ url, opts }); const [st, body] = fn(url, opts); return { ok: st < 300, status: st, text: async () => (body == null ? '' : JSON.stringify(body)) }; }; };

  const account = await load('account.mjs');
  let r = await call(account, { method: 'GET' });
  check(r.status === 200 && r.body.sync === true && r.body.push === true && r.body.vapidKey === ENV.VAPID_PUBLIC_KEY,
    'GET api/account reports sync + push configured (and serves only the public VAPID key)');
  stub(() => [400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' }]);
  r = await call(account, { method: 'POST', body: { action: 'signin', email: 'a@b.co', password: 'f'.repeat(64) } });
  check(r.status === 401 && r.body.error === 'bad_login', 'a wrong password maps to 401 bad_login');
  stub(() => [200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: { id: 'u1', email: 'a@b.co' } }]);
  r = await call(account, { method: 'POST', body: { action: 'signin', email: 'A@B.co ', password: 'f'.repeat(64) } });
  check(r.status === 200 && r.body.session.access_token === 'AT' && r.body.session.user.id === 'u1', 'sign-in returns a session');
  check(JSON.parse(calls[calls.length - 1].opts.body).email === 'a@b.co', 'emails are normalized before they reach Supabase');
  stub(() => [422, { error_code: 'same_password' }]);
  r = await call(account, { method: 'POST', headers: { authorization: 'Bearer AT' }, body: { action: 'password', password: 'f'.repeat(64) } });
  check(r.status === 200, 're-setting the same password is not an error');

  const vault = await load('vault.mjs');
  stub((url, o) => (o.method === 'PATCH' ? [200, []] : [200, [{ version: 7 }]]));
  r = await call(vault, { method: 'PUT', headers: { authorization: 'Bearer AT' }, body: { base: 5, blob: 'x' } });
  check(r.status === 409 && r.body.version === 7, 'a write on a stale version is refused with 409 and the current version');
  const patch = calls.find((c) => c.opts.method === 'PATCH');
  check(!!patch && patch.url.includes('version=eq.5') && patch.opts.headers.Authorization === 'Bearer AT',
    'vault writes are conditional on the version and run as the user (row-level security)');
  r = await call(vault, { method: 'PUT', body: { base: 0, blob: 'x' } });
  check(r.status === 401, 'the vault refuses a request with no user token');

  const push = await load('push.mjs');
  stub(() => [201, null]);
  r = await call(push, { method: 'POST', headers: { authorization: 'Bearer AT' }, body: { endpoint: 'https://evil.example.com/x', days: [] } });
  check(r.status === 400, 'a push endpoint outside the known push services is refused');

  const reminders = await load('reminders.mjs');
  r = await call(reminders, { method: 'GET', headers: { authorization: 'Bearer nope' } });
  check(r.status === 401, 'the reminders job refuses a caller without CRON_SECRET');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  calls.length = 0;
  stub((url, o) => {
    if (url.includes('/rest/v1/push_subs?select')) return [200, [
      { endpoint: 'https://fcm.googleapis.com/fcm/send/due', tz: 'UTC', days: [today], last_sent: null },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/later', tz: 'UTC', days: ['2099-01-01'], last_sent: null },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/gone', tz: 'UTC', days: [today], last_sent: null },
    ]];
    if (url.endsWith('/gone')) return [410, null];
    if (url.startsWith('https://fcm.googleapis.com')) return [201, null];
    return [204, null];
  });
  r = await call(reminders, { method: 'GET', headers: { authorization: 'Bearer cron-secret' } });
  check(r.status === 200 && r.body.sent === 1 && r.body.removed === 1, `reminders wake only devices with a bill due today, and drop dead subscriptions (${JSON.stringify(r.body)})`);
  const sent = calls.find((c) => c.url.endsWith('/due'));
  const m = sent && /^vapid t=([^,]+), k=(.+)$/.exec(sent.opts.headers.Authorization);
  let jwtOk = false;
  if (m) {
    const [h, p, sig] = m[1].split('.');
    const pubKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } });
    jwtOk = verify('sha256', Buffer.from(h + '.' + p), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))
      && JSON.parse(Buffer.from(p, 'base64url')).aud === 'https://fcm.googleapis.com' && m[2] === ENV.VAPID_PUBLIC_KEY;
  }
  check(jwtOk && sent.opts.headers['Content-Length'] === '0', 'each reminder is an empty push carrying a valid VAPID signature');

  globalThis.fetch = prevFetch;
  for (const k in ENV) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
}

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.PLAYWRIGHT_BROWSERS_PATH
  ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium')
  : undefined;

let browser;
try {
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
  // Seed an onboarded (empty -> demo defaults) store, reload into the app.
  await page.evaluate(() => localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {} })));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);

  console.log('app boot & PWA:');
  check(await page.evaluate(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0), 'app shell renders');
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? ': ' + pageErrors.join('; ') : ''}`);
  check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker controls the page');

  const mani = await page.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]')?.getAttribute('href');
    const j = await (await fetch(href)).json();
    const sizes = (j.icons || []).map((i) => i.sizes);
    return { name: !!j.name, standalone: j.display === 'standalone', has192: sizes.includes('192x192'),
      has512: sizes.includes('512x512'), shortcuts: (j.shortcuts || []).length };
  });
  check(mani.name && mani.standalone && mani.has192 && mani.has512, 'manifest is installable (name + standalone + 192/512 icons)');
  check(mani.shortcuts >= 2, `manifest declares app shortcuts (${mani.shortcuts})`);
  check(await page.getByText('Demo data · start fresh').count() > 0, 'Home shows a Demo-data pill while running on seed data');

  // Home carousels: the Investments/Debt account rows must be real scroll
  // containers that are NOT nested inside a <button> — a scrollable region
  // inside a button is not touch-scrollable in WebKit, which is what froze
  // these rows while the Savings-goals row (a plain div scroller) worked.
  const carousels = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('div')]
      .filter((d) => getComputedStyle(d).overflowX === 'auto' && d.childElementCount > 1);
    const named = (label) => rows.find((d) => (d.textContent || '').includes(label));
    const probe = (d) => (d ? { found: true, inButton: !!d.closest('button'), kids: d.childElementCount } : { found: false });
    return { goals: probe(named('Emergency savings')), invest: probe(named('Questrade')), debt: probe(named('Everyday Visa')) };
  });
  check(carousels.goals.found && !carousels.goals.inButton, 'Home: Savings goals row is a plain scroll container');
  check(carousels.invest.found && !carousels.invest.inButton,
    `Home: Investments account row scrolls side-to-side (not trapped in a <button>)`);
  check(carousels.debt.found && !carousels.debt.inButton,
    'Home: Debt card row scrolls side-to-side (not trapped in a <button>)');
  // the account tiles are now buttons of their own — tapping one still opens Invest
  await page.getByRole('button', { name: /Questrade/ }).first().click();
  await page.waitForTimeout(400);
  check(await page.getByRole('button', { name: 'Refresh prices' }).first().isVisible().catch(() => false),
    'Home: tapping an investment account tile opens the Invest screen');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.waitForTimeout(400);

  console.log('Budget -> Plan -> create section (regression guard):');
  // role-based tab clicks: loose text= matching would also hit the budget-alert
  // banner copy ("… over budget this month") on Home
  await page.getByRole('button', { name: 'Budget', exact: true }).click(); await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Plan', exact: true }).click(); await page.waitForTimeout(400);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('nima_data_v1')).data.budgetGroups?.length ?? 0);
  await page.locator('text=New section').first().click(); await page.waitForTimeout(400);
  await page.locator('input[placeholder="e.g. Giving"]').fill('Investment'); await page.waitForTimeout(200);
  await page.locator('text=Create section').first().click();
  // Persistence is debounced (~400ms) and the mock price feed keeps bumping the
  // save timer, so poll localStorage rather than racing a fixed sleep.
  const persisted = await page.waitForFunction(
    (n) => (JSON.parse(localStorage.getItem('nima_data_v1')).data.budgetGroups?.length ?? 0) === n + 1,
    before, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('nima_data_v1')).data.budgetGroups?.length ?? 0);
  check(persisted && after === before + 1, `"Create section" adds & persists a budget group (${before} -> ${after})`);
  check(await page.locator('text=Investment').count() > 0, 'new section appears in the plan list');

  console.log('debt payoff planner:');
  await page.getByRole('button', { name: 'Open payoff planner' }).click(); await page.waitForTimeout(400);
  const payoffDlg = page.locator('[role=dialog]').filter({ hasText: 'Payoff plan' });
  check(await payoffDlg.getByText('Debt-free in').count() > 0, 'payoff planner projects a debt-free date');
  check(await payoffDlg.getByText('Payoff order').count() > 0, 'payoff planner lists the payoff order');
  // Snowball orders by smallest balance; avalanche by highest APR — toggling re-ranks.
  const avaFirst = await payoffDlg.locator('text=/% APR/').first().textContent();
  await payoffDlg.getByRole('button', { name: 'Snowball', exact: true }).click(); await page.waitForTimeout(300);
  check(await payoffDlg.getByText(/smallest balance first/).count() > 0, 'switching to Snowball updates the strategy hint');
  await payoffDlg.getByRole('button', { name: 'Avalanche', exact: true }).click(); await page.waitForTimeout(200);
  await payoffDlg.locator('input[aria-label="Extra monthly payment"]').fill('300'); await page.waitForTimeout(400);
  check(await payoffDlg.getByText(/saves .* in interest/).count() > 0, 'an extra payment shows the interest saved vs minimums');
  void avaFirst;
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  check(await page.locator('[role=dialog]').filter({ hasText: 'Payoff plan' }).count() === 0, 'Escape closes the payoff planner');

  console.log('offline:');
  await ctx.setOffline(true);
  const status = await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).then((r) => r?.status()).catch(() => 0);
  await page.waitForTimeout(1200);
  check(status === 200 && await page.evaluate(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0), 'app still renders with the network offline');
  await ctx.setOffline(false);

  console.log('app-shortcut deep link:');
  await page.goto(`${base}/index.html?add=expense`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const sheetOpen = await page.locator('[role=dialog]').filter({ hasText: 'Transfer' }).count() > 0;
  const urlCleaned = await page.evaluate(() => !location.search.includes('add='));
  check(sheetOpen, '?add=expense opens the add-entry sheet');
  check(urlCleaned, 'deep-link param is cleared from the URL after handling');

  console.log('ledger search + undo delete + duplicate + recap:');
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Budget', exact: true }).click(); await page.waitForTimeout(400);
  check(await page.locator('text=/recap/').count() > 0, 'Budget › This month shows the month recap card');
  // categories lead the This month view: right under the summary, ahead of income and the trend
  const budgetOrder = await page.evaluate(() => {
    const vis = el => el.offsetParent !== null;
    const head = t => [...document.querySelectorAll('div')].find(d => vis(d) && d.childElementCount === 0 && d.textContent.trim() === t);
    const y = t => { const el = head(t); return el ? el.getBoundingClientRect().top : null; };
    return { cats: y('Categories'), inc: y('Income'), trend: y('Spending trend'), spent: y('Spent'), planned: y('Planned') };
  });
  check(budgetOrder.cats != null && budgetOrder.spent != null && budgetOrder.planned != null
    && budgetOrder.spent < budgetOrder.cats
    && (budgetOrder.inc == null || budgetOrder.cats < budgetOrder.inc)
    && (budgetOrder.trend == null || budgetOrder.cats < budgetOrder.trend),
    `Budget › This month: Spent/Planned summary, then Categories ahead of Income and the trend (${JSON.stringify(budgetOrder)})`);
  await page.getByRole('button', { name: 'Entries', exact: true }).click(); await page.waitForTimeout(500);
  await page.locator('input[placeholder="Search entries"]').fill('payroll'); await page.waitForTimeout(400);
  check(await page.locator('text=Payroll').count() > 0, 'ledger search finds entries by note ("payroll" -> Payroll rows)');
  check(await page.locator('text=Showing matches from all months').count() > 0, 'ledger search widens scope to all months');

  const entriesBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('nima_data_v1')).data.entries.length);
  await page.locator('text=Payroll').first().click(); await page.waitForTimeout(500);
  check(await page.locator('text=Duplicate as new entry').count() > 0, 'edit-entry sheet offers "Duplicate as new entry"');
  await page.locator('text=Delete entry').click(); await page.waitForTimeout(400);
  check(await page.locator('text=Undo').count() > 0, 'deleting an entry shows the Undo toast (no blocking confirm)');
  const deleted = await page.waitForFunction(
    (n) => JSON.parse(localStorage.getItem('nima_data_v1')).data.entries.length === n - 1,
    entriesBefore, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(deleted, 'delete persists (entry count -1)');
  await page.locator('text=Undo').click();
  const undone = await page.waitForFunction(
    (n) => JSON.parse(localStorage.getItem('nima_data_v1')).data.entries.length === n,
    entriesBefore, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(undone, 'Undo restores the deleted entry (entry count back)');
  await page.locator('text=Payroll').first().click(); await page.waitForTimeout(400);
  await page.locator('text=Duplicate as new entry').click(); await page.waitForTimeout(300);
  check(await page.locator('text=Duplicate as new entry').count() === 0
    && await page.locator('[role=dialog] >> text=Add income').count() > 0,
    'Duplicate flips the sheet to a prefilled "Add income"');

  console.log('backup download + restore:');
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Accounts', exact: true }).click(); await page.waitForTimeout(400);
  await page.locator('[aria-label="Settings"]').click(); await page.waitForTimeout(500);
  const dlPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  await page.locator('text=Backup file').click();
  const dl = await dlPromise;
  check(!!dl && /^nima-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), `backup downloads as nima-backup-YYYY-MM-DD.json (${dl ? dl.suggestedFilename() : 'no download'})`);
  let backupFull = false;
  if (dl) {
    try {
      const j = JSON.parse(await readFile(await dl.path(), 'utf8'));
      backupFull = j.v === 1 && j.data && Array.isArray(j.data.entries) && Array.isArray(j.data.budgetCats);
    } catch { /* leave false */ }
  }
  check(backupFull, 'backup file is the full v1 store (entries + budget structure included)');

  // import template (Settings › Data › Import data files)
  await page.locator('text=Import spreadsheet').click(); await page.waitForTimeout(400);
  const tplPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  await page.locator('text=Download Excel template').click();
  const tpl = await tplPromise;
  let tplOk = false;
  if (tpl) {
    try {
      const xml = await readFile(await tpl.path(), 'utf8');
      tplOk = tpl.suggestedFilename() === 'nima-import-template.xls'
        && xml.includes('<Worksheet ss:Name="trades">') && xml.includes('<Comment')
        && xml.includes('invest_deposit');
      check(xml.includes('AI assistant') && xml.includes('copy from here') && xml.includes('EXACTLY these columns'),
        'template Start-here sheet carries the copy-paste AI formatting prompt');
    } catch { /* leave false */ }
  }
  check(tplOk, 'import sheet offers an .xls template with column comments + demo rows');
  check(await page.locator('[role=dialog]:has-text("Choose Excel file") input[type=file]').count() === 1,
    'import sheet has exactly ONE file input (no per-sheet CSV pickers)');
  check(await page.getByText('the portfolio backbone').count() === 0,
    'sheet-status checklist stays hidden until a file is imported');

  // single-workbook import: feeding the template itself back in must fill all
  // four slots (template <-> parser sync), demo rows included.
  if (tpl) {
    const tplCopy = join(tmpdir(), `nima-template-${Date.now()}.xls`);
    await writeFile(tplCopy, await readFile(await tpl.path()));
    await page.locator('label:has-text("Choose Excel file") input[type=file]').setInputFiles(tplCopy);
    let slotsOk = false;
    for (let i = 0; i < 20 && !slotsOk; i++) {
      await page.waitForTimeout(300);
      slotsOk = await page.getByText('rows · valid').count() === 4;
    }
    check(slotsOk, 'importing the template workbook as ONE file fills all four sheet slots');
    check(await page.getByRole('button', { name: 'Rebuild portfolio from 2 holdings' }).count() === 1,
      'one-file import reconstructs the demo portfolio (2 holdings) without per-CSV steps');
  }

  // real .xlsx (zip + sharedStrings + date serials) lands in the trades slot
  const xlsxFile = join(tmpdir(), `nima-trades-${Date.now()}.xlsx`);
  await writeFile(xlsxFile, buildXlsx());
  await page.locator('label:has-text("Choose Excel file") input[type=file]').setInputFiles(xlsxFile);
  let xlsxOk = false;
  for (let i = 0; i < 20 && !xlsxOk; i++) {
    await page.waitForTimeout(300);
    xlsxOk = await page.getByText('1 rows · valid').count() === 1;
  }
  check(xlsxOk, '.xlsx workbook is unzipped and its "My Trades" sheet fills the trades slot');
  check(await page.getByText('2025-03-03', { exact: false }).count() > 0,
    'Excel serial dates are converted to ISO (45719 -> 2025-03-03)');

  // run the import: success toast fires, demo flag clears, sheet closes
  await page.getByRole('button', { name: /Rebuild portfolio from/ }).click();
  let toastOk = false;
  for (let i = 0; i < 15 && !toastOk; i++) {
    await page.waitForTimeout(200);
    toastOk = await page.getByText(/Portfolio rebuilt: \d+ holding/).count() > 0;
  }
  check(toastOk, 'running the import shows a success toast (no silent close)');
  let demoCleared = false;
  for (let i = 0; i < 15 && !demoCleared; i++) {
    await page.waitForTimeout(200);
    demoCleared = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('nima_data_v1')).data.demoData === false; } catch { return false; } });
  }
  check(demoCleared, 'import clears the demoData flag');
  await page.waitForTimeout(300);

  const restoreFile = join(tmpdir(), `nima-restore-${Date.now()}.json`);
  await writeFile(restoreFile, JSON.stringify({ v: 1, data: { householdName: 'Restored Household' } }));
  page.once('dialog', (d) => d.accept());
  await page.locator('label:has-text("Restore backup") input[type=file]').setInputFiles(restoreFile);
  let restored = false;
  for (let i = 0; i < 20 && !restored; i++) {
    await page.waitForTimeout(500);
    restored = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('nima_data_v1')).data.householdName === 'Restored Household'; } catch { return false; }
    }).catch(() => false);
  }
  check(restored, 'Restore backup replaces the store and survives the reload');

  console.log('market status + help centre:');
  // No live feed on localhost and the simulator is gone — the invest header
  // must say Offline / Market Closed, never claim "Live".
  await page.getByRole('button', { name: 'Invest', exact: true }).click(); await page.waitForTimeout(600);
  check(await page.getByText(/^(Offline|Market Closed)$/).count() > 0
    && await page.getByText('Live', { exact: true }).count() === 0,
    'without a live feed the price status is honest (Offline/Market Closed, never "Live")');
  // Holdings sort — the row's second line follows the chosen sort's return family:
  // the all-time sorts show all-time $ (%), the today sorts show today's $ (%), and
  // a closed market falls the today rows back to the all-time figure.
  const grabRets = () => page.evaluate(() =>
    (document.body.innerText.match(/[+\-]\$[\d,]+\.\d{2} \([+\-][\d.]+%\)/g) || []).sort());
  await page.getByRole('button', { name: 'Total value', exact: true }).click(); await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'All-time return ($)', exact: true }).click(); await page.waitForTimeout(300);
  const retsAll = await grabRets();
  check(retsAll.length > 0, 'holdings second line shows a return as $ and % (all-time sort)');
  await page.getByRole('button', { name: 'All-time return ($)', exact: true }).click(); await page.waitForTimeout(200);
  await page.getByRole('button', { name: "Today's return ($)", exact: true }).click(); await page.waitForTimeout(300);
  const retsToday = await grabRets();
  const mktClosed = await page.getByText('Market Closed', { exact: true }).count() > 0;
  check(retsToday.length > 0 && (mktClosed
      ? JSON.stringify(retsToday) === JSON.stringify(retsAll)
      : JSON.stringify(retsToday) !== JSON.stringify(retsAll)),
    mktClosed
      ? "market closed: today's-return sort falls back to the all-time figures"
      : "today's-return sort swaps the second line to the day's move");
  // reset to the default sort so later invest checks see the usual order
  await page.getByRole('button', { name: "Today's return ($)", exact: true }).click(); await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Total value', exact: true }).click(); await page.waitForTimeout(300);
  // Add-holding auto-fill: typing a known ticker fills company + last-known price
  // from local data — works offline / market-closed (no live feed on localhost).
  await page.getByRole('button', { name: '+ Add' }).click(); await page.waitForTimeout(300);
  await page.locator('input[placeholder="AAPL"]').fill('AAPL'); await page.waitForTimeout(500);
  check(await page.locator('input[placeholder="Apple Inc."]').inputValue() === 'Apple',
    'add-holding fills the company name from a known ticker offline');
  check(parseFloat(await page.locator('input[placeholder="0.00"]').nth(1).inputValue()) === 235,
    'add-holding prefills the last-known price even with the market closed');
  // Asset class now auto-selects to match the ticker's sector (ETF ticker -> ETF class).
  await page.locator('input[placeholder="AAPL"]').fill('VOO'); await page.waitForTimeout(500);
  check((await page.locator('[aria-label="Choose asset class"]').innerText()).includes('ETF'),
    'add-holding auto-selects the asset class from the ticker (VOO -> ETF)');
  // Sector & Asset class are collapsed summary buttons; tapping opens the chip list + "+ New".
  check(await page.locator('[aria-label="Choose sector"]').count() === 1
    && await page.locator('[aria-label="Choose asset class"]').count() === 1,
    'sector and asset class are collapsed into tappable summary controls');
  await page.locator('[aria-label="Choose asset class"]').click(); await page.waitForTimeout(300);
  check(await page.getByRole('button', { name: '+ New' }).count() > 0,
    'the asset-class picker offers a "+ New" action, like sector');
  // Cash mode: picking asset class = Cash turns the form into a "cash & settled" deposit.
  await page.getByRole('button', { name: 'Cash', exact: true }).click(); await page.waitForTimeout(300);
  check(await page.locator('input[aria-label="Cash amount"]').count() === 1
    && await page.locator('input[placeholder="AAPL"]').count() === 0,
    'asset class = Cash switches the form to a cash amount (no ticker/shares)');
  check(await page.getByRole('button', { name: 'Add cash' }).count() > 0,
    'the cash form action reads "Add cash"');
  // Adding cash creates a "Cash & settled" holding for the chosen broker.
  await page.getByRole('button', { name: 'Wealthsimple', exact: true }).click(); await page.waitForTimeout(200);
  await page.locator('input[aria-label="Cash amount"]').fill('750'); await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Add cash' }).click(); await page.waitForTimeout(400);
  const cashAdded = await page.evaluate(() => {
    try {
      const hs = JSON.parse(localStorage.getItem('nima_data_v1')).data.holdings || [];
      return hs.some((h) => h.t === 'CASH' && h.broker === 'Wealthsimple' && Math.round(h.cashVal) === 750);
    } catch { return false; }
  });
  check(cashAdded, 'adding cash creates a Cash & settled holding for the chosen broker');
  // A trade's commission rides into that lot's avg cost and leaves the broker's cash:
  // 4 shares @ CA$100 with a CA$50 commission is a CA$112.50 cost per share, $450 spent.
  await page.getByRole('button', { name: '+ Add' }).click(); await page.waitForTimeout(300);
  await page.locator('input[placeholder="AAPL"]').fill('ZZTEST'); await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'CAD', exact: true }).click(); await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Wealthsimple', exact: true }).click(); await page.waitForTimeout(200);
  await page.locator('input[placeholder="0.00"]').nth(0).fill('4');
  await page.locator('input[placeholder="0.00"]').nth(1).fill('100');
  const wsCashBefore = await page.evaluate(() => {
    try {
      const hs = JSON.parse(localStorage.getItem('nima_data_v1')).data.holdings || [];
      return hs.filter((h) => h.t === 'CASH' && h.broker === 'Wealthsimple')
        .reduce((s, h) => s + (h.cashVal || 0), 0);
    } catch { return 0; }
  });
  await page.locator('input[aria-label="Commission"]').fill('50'); await page.waitForTimeout(300);
  check(await page.getByText('CA$112.50', { exact: true }).count() > 0,
    'the buy sheet folds the commission into the cost per share (4 @ 100 + 50 = CA$112.50)');
  check(await page.getByText('$450', { exact: true }).count() > 0,
    'the buy sheet counts the commission in the total cost basis');
  await page.getByRole('button', { name: 'Add to portfolio' }).click(); await page.waitForTimeout(500);
  const buyFee = await page.evaluate(() => {
    try {
      const hs = JSON.parse(localStorage.getItem('nima_data_v1')).data.holdings || [];
      const h = hs.find((x) => x.t === 'ZZTEST');
      const cash = hs.filter((x) => x.t === 'CASH' && x.broker === 'Wealthsimple')
        .reduce((s, x) => s + (x.cashVal || 0), 0);
      return { avg: h && h.lots[0].avgCost, price: h && h.price, cash };
    } catch { return {}; }
  });
  check(buyFee.avg === 112.5 && buyFee.price === 100,
    'the commission lands in the saved lot’s avg cost, leaving the market price alone');
  check(Math.round((wsCashBefore - buyFee.cash) * 100) / 100 === 450,
    'the commission leaves the brokerage’s settled cash with the purchase');
  await page.getByRole('button', { name: 'Accounts', exact: true }).click(); await page.waitForTimeout(400);
  await page.locator('[aria-label="Settings"]').click(); await page.waitForTimeout(400);
  await page.getByText('Help', { exact: true }).click(); await page.waitForTimeout(400);
  check(await page.locator('text=How do recurring entries work?').count() > 0, 'help centre renders its FAQs');
  check(await page.locator('text=How do I delete my account?').count() === 0, 'the "delete my account" FAQ is gone (no user accounts exist)');
  check(await page.getByText('Live chat').count() === 0 && await page.getByText(/Talk to a specialist/).count() === 0,
    'the fake live-chat / specialist support is gone (email only)');

  console.log('Esc-to-close + app-update toast:');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  check(await page.locator('text=Help centre').count() === 0, 'Escape closes the topmost sheet (Help)');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  check(await page.locator('[role=dialog]:has-text("Settings")').count() === 0, 'Escape then closes the sheet beneath it (Settings)');

  console.log('Privacy & terms is a real page (not a dead noop):');
  await page.locator('[aria-label="Settings"]').click(); await page.waitForTimeout(400);
  await page.getByText('Privacy & terms', { exact: true }).click(); await page.waitForTimeout(400);
  check(await page.getByText('What leaves your device').count() > 0, 'Privacy & terms opens the privacy page');
  check(await page.getByText('No warranty').count() > 0, 'the Terms section renders below Privacy');
  check(await page.getByText('Rate Ni’ma').count() === 0 && await page.getByText('Rate Ni\'ma').count() === 0, 'the App-Store "Rate Ni\'ma" row is gone (PWA)');
  await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  await page.keyboard.press('Escape'); await page.waitForTimeout(250);

  console.log('date of birth drives every tool’s age:');
  await page.locator('[aria-label="Settings"]').click(); await page.waitForTimeout(400);
  await page.getByText('Edit', { exact: true }).first().click(); await page.waitForTimeout(400);
  const pfDlg = page.locator('[role=dialog]:has-text("Edit profile")');
  const bornYear = String(new Date().getFullYear() - 35);
  await pfDlg.locator('select[aria-label="Birth month"]').selectOption('01'); await page.waitForTimeout(150);
  await pfDlg.locator('select[aria-label="Birth year"]').selectOption(bornYear); await page.waitForTimeout(300);
  check(await pfDlg.getByText('35 years old').count() > 0, 'the profile derives an age from the birth month and year');
  await pfDlg.getByRole('button', { name: 'Save profile' }).click(); await page.waitForTimeout(500);
  check(await page.evaluate((ym) => {
    try { return JSON.parse(localStorage.getItem('nima_data_v1')).data.birthYM === ym; } catch { return false; }
  }, bornYear + '-01'), 'the date of birth persists to the store');
  await page.keyboard.press('Escape'); await page.waitForTimeout(250);

  console.log('Tools (Settings › Tools):');
  await page.locator('[aria-label="Settings"]').click(); await page.waitForTimeout(400);
  await page.locator('[aria-label="Tools"]').click(); await page.waitForTimeout(400);
  check(await page.locator('[aria-label="Holdings X-ray tool"]').count() > 0, 'Settings › Tools opens the tools dashboard');
  // compound growth — starting amount pre-fills from the live portfolio value
  await page.locator('[aria-label="Compound growth calculator"]').click(); await page.waitForTimeout(400);
  // anchor on hero copy unique to the tool sheet — the dashboard card also says "Compound growth"
  const ciDlg = page.locator('[role=dialog]:has-text("you could have")');
  const ciInitPrefill = await ciDlg.locator('input[aria-label="Starting amount"]').inputValue();
  check(/^\d+$/.test(ciInitPrefill) && parseInt(ciInitPrefill, 10) > 0,
    `compound starting amount pre-fills from the portfolio value (${ciInitPrefill || 'empty'})`);
  // deterministic math: $1,000 at 10%/yr compounded monthly for 5 years -> $1,645
  await ciDlg.locator('input[aria-label="Starting amount"]').fill('1000'); await page.waitForTimeout(150);
  await ciDlg.locator('input[aria-label="Monthly contribution"]').fill('0'); await page.waitForTimeout(150);
  await ciDlg.locator('input[aria-label="Expected yearly return percent"]').fill('10'); await page.waitForTimeout(150);
  await ciDlg.getByRole('button', { name: '5', exact: true }).click(); await page.waitForTimeout(300);
  check(await ciDlg.getByText('$1,645').count() > 0, 'compound future value math checks out ($1,000 @10%, 5y monthly -> $1,645)');
  check(await ciDlg.getByText('Contributions', { exact: true }).count() > 0
    && await ciDlg.getByText('Growth', { exact: true }).count() > 0, 'compound chart renders its stacked-series legend');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  // retirement planning — the reverse tool: name the retirement, solve for today
  await page.locator('[aria-label="Retirement planning calculator"]').click(); await page.waitForTimeout(400);
  // anchor on hero copy unique to the tool sheet — the dashboard card also says "Retirement planning"
  const rpDlg = page.locator('[role=dialog]:has-text("you need")');
  const rpSpendPrefill = await rpDlg.locator('input[aria-label="Yearly spending in retirement"]').inputValue();
  check(/^\d+$/.test(rpSpendPrefill) && parseInt(rpSpendPrefill, 10) > 0,
    `retirement spending pre-fills from the budget plan (${rpSpendPrefill || 'empty'})`);
  const rpSavedPrefill = await rpDlg.locator('input[aria-label="Saved so far"]').inputValue();
  check(/^\d+$/.test(rpSavedPrefill) && parseInt(rpSavedPrefill, 10) > 0,
    `retirement "saved so far" pre-fills from the portfolio and savings (${rpSavedPrefill || 'empty'})`);
  // the 4% rule, exactly: $60,000 a year -> $1,500,000
  await rpDlg.locator('input[aria-label="Yearly spending in retirement"]').fill('60000'); await page.waitForTimeout(150);
  await rpDlg.locator('input[aria-label="Yearly pension and benefits"]').fill('0'); await page.waitForTimeout(150);
  await rpDlg.getByRole('button', { name: '4%', exact: true }).click(); await page.waitForTimeout(300);
  check(await rpDlg.getByText('$1,500,000').count() > 0,
    'retirement target follows the withdrawal rule ($60k a year at 4% -> $1.5M)');
  // pension income comes off what the portfolio has to carry
  await rpDlg.locator('input[aria-label="Yearly pension and benefits"]').fill('20000'); await page.waitForTimeout(300);
  check(await rpDlg.getByText('$1,000,000').count() > 0,
    'pension & benefits reduce the number the portfolio must carry ($40k at 4% -> $1M)');
  await rpDlg.locator('input[aria-label="Yearly pension and benefits"]').fill('0'); await page.waitForTimeout(300);
  // today's dollars runs a real return and leaves the target uninflated;
  // future dollars inflates the target forward — same plan, two honest numbers
  check(await rpDlg.locator('input[aria-label="Age today"]').count() === 0
    && await rpDlg.getByText('Age today').count() > 0,
    'the tool reads the age from the profile instead of asking for one');
  check(await rpDlg.getByText('Born January ' + bornYear).count() > 0,
    'and names the birth month it came from');
  await rpDlg.locator('input[aria-label="Inflation percent"]').fill('2.5'); await page.waitForTimeout(150);
  await rpDlg.locator('input[aria-label="Retirement age"]').fill('65'); await page.waitForTimeout(300);
  check(await rpDlg.getByText('30 years away').count() > 0,
    'the horizon comes from the derived age (35 -> 65 is 30 years)');
  check(await rpDlg.getByText('% a year after inflation').count() > 0,
    'today\u2019s-dollars mode shows the real return, not the nominal one');
  await rpDlg.getByRole('button', { name: 'Future $', exact: true }).click(); await page.waitForTimeout(400);
  const rpFutureTarget = await rpDlg.getByText('$3,146,', { exact: false }).count();
  check(rpFutureTarget > 0, 'future-dollars mode inflates the target forward ($1.5M over 30y at 2.5% -> ~$3.15M)');
  check(await rpDlg.getByText('in today\u2019s money').count() > 0,
    'future-dollars mode still shows the today\u2019s-money equivalent');
  await rpDlg.getByRole('button', { name: 'Today\u2019s $', exact: true }).click(); await page.waitForTimeout(400);
  // the reverse solve: required contribution, the gap, and when you get there
  await rpDlg.locator('input[aria-label="Saved so far"]').fill('0'); await page.waitForTimeout(150);
  await rpDlg.locator('input[aria-label="Adding monthly"]').fill('0'); await page.waitForTimeout(150);
  await rpDlg.locator('input[aria-label="Expected yearly return percent"]').fill('7'); await page.waitForTimeout(150);
  await rpDlg.locator('input[aria-label="Inflation percent"]').fill('0'); await page.waitForTimeout(400);
  // $1.5M in 30y at 7% nominal, monthly, from zero -> $1,230/mo
  check(await rpDlg.getByText('$1,230/mo').count() > 0,
    'required monthly contribution solves the target ($1.5M, 30y @7% from zero -> $1,230/mo)');
  check(await rpDlg.getByText('Short by').count() > 0, 'the plan reports the gap when the contribution falls short');
  await rpDlg.locator('input[aria-label="Adding monthly"]').fill('1230'); await page.waitForTimeout(400);
  check(await rpDlg.getByText('On track').count() > 0, 'contributing the required amount reads as on track');
  check(await rpDlg.getByText('Age 6', { exact: false }).count() > 0, 'the plan names the age the number is reached');
  check(await rpDlg.getByText('Your number').count() > 0, 'the path chart marks the target line');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  // emergency fund — essentials pre-fill from the budget plan's head categories
  await page.locator('[aria-label="Emergency fund calculator"]').click(); await page.waitForTimeout(400);
  // anchor on hero copy unique to the tool sheet — the dashboard card also says "Emergency fund"
  const efDlg = page.locator('[role=dialog]:has-text("Your safety net target")');
  check(await efDlg.getByText('3 months ×').count() > 0, 'emergency fund opens at 3 months of cover');
  const efFirstVal = await efDlg.locator('input[inputmode="decimal"]').first().inputValue();
  check(/^\d+$/.test(efFirstVal) && parseInt(efFirstVal, 10) > 0,
    `emergency essentials pre-fill from the budget plan (${efFirstVal || 'empty'})`);
  const efSavedPrefill = await efDlg.locator('input[aria-label="Saved so far"]').inputValue();
  check(/^\d+$/.test(efSavedPrefill) && parseInt(efSavedPrefill, 10) > 0,
    `emergency "saved so far" pre-fills from the savings accounts (${efSavedPrefill || 'empty'})`);
  await efDlg.getByRole('button', { name: '6 mo', exact: true }).click(); await page.waitForTimeout(300);
  check(await efDlg.getByText('6 months ×').count() > 0, 'months-of-cover chips retarget the fund');
  check(await efDlg.getByText('% funded').count() > 0, 'emergency fund shows funding progress');
  // Esc unwinds tool -> tools dashboard -> settings, one layer at a time
  await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  check(await page.getByText('Your safety net target').count() === 0
    && await page.locator('[aria-label="Holdings X-ray tool"]').count() > 0, 'Escape closes the tool but keeps the tools dashboard');
  // Holdings X-ray — upload an ETF breakdown, unpack a held ETF, re-aggregate exposure
  await page.locator('[aria-label="Holdings X-ray tool"]').click(); await page.waitForTimeout(400);
  const ltDlg = page.locator('[role=dialog]:has-text("Your true exposure")');
  check(await ltDlg.count() > 0, 'Holdings X-ray tool opens');
  // the tool offers a downloadable breakdown template (.xls with column comments + AI prompt)
  const [xtpl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    ltDlg.getByText('Download breakdown template').click(),
  ]);
  let xtplOk = false;
  if (xtpl) {
    try {
      const xml = await readFile(await xtpl.path(), 'utf8');
      xtplOk = xtpl.suggestedFilename() === 'nima-xray-template.xls'
        && xml.includes('<Worksheet ss:Name="breakdown">') && xml.includes('<Comment')
        && /fund[\s\S]*ticker[\s\S]*sector[\s\S]*weight/.test(xml)
        && xml.includes('copy from here');
    } catch { /* leave false */ }
  }
  check(xtplOk, 'X-ray tool offers an .xls breakdown template with column comments + AI prompt');
  // VTI is a held demo ETF; feed it a breakdown using Bloomberg composite tickers
  // ("AAPL US", "CP CN") — the app holds the bare symbols (AAPL, MSFT, CP).
  await ltDlg.locator('input[type=file]').setInputFiles({
    name: 'VTI_Holdings.csv', mimeType: 'text/csv',
    buffer: Buffer.from('Fund,Ticker,Name,Weight\nVTI,AAPL US,Apple Inc,50%\nVTI,MSFT US,Microsoft Corp,30%\nVTI,CP CN,Canadian Pacific,20%\n'),
  });
  await page.waitForTimeout(500);
  check(await ltDlg.getByText(/1 ETF unpacked/).count() > 0, 'uploading a breakdown unpacks the matching held ETF (VTI)');
  check(await ltDlg.getByText('VTI', { exact: true }).count() > 0
    && await ltDlg.getByText('Applied', { exact: true }).count() > 0, 'the loaded breakdown is applied to the held VTI holding');
  // AAPL is both a direct holding and a VTI constituent -> its exposure row shows "Direct + ETF"
  check(await ltDlg.getByText('Direct + ETF').count() > 0, 'a company held directly and inside an ETF is tagged "Direct + ETF"');
  // the Bloomberg exchange suffix is stripped so suffixed constituents merge with the
  // bare-symbol holdings instead of splitting into a separate line
  check(await ltDlg.getByText('CP CN').count() === 0 && await ltDlg.getByText('AAPL US').count() === 0,
    'Bloomberg exchange suffixes are stripped from constituent tickers (no "CP CN"/"AAPL US")');
  check(await ltDlg.getByText('Direct + ETF').count() >= 3,
    'suffixed constituents (AAPL US, MSFT US, CP CN) merge with the held AAPL, MSFT, CP holdings');
  // export writes an .xls look-through
  const [ltDl] = await Promise.all([
    page.waitForEvent('download'),
    ltDlg.locator('[aria-label="Export look-through to Excel"]').click(),
  ]);
  check(!!ltDl && /^nima-lookthrough-\d{4}-\d{2}-\d{2}\.xls$/.test(ltDl.suggestedFilename()),
    `X-ray exports a look-through workbook (${ltDl ? ltDl.suggestedFilename() : 'no download'})`);
  // the uploaded breakdown persists across reload (durable lookEtfs)
  await page.waitForTimeout(500);
  const ltPersisted = await page.evaluate(() => {
    const raw = localStorage.getItem('nima_data_v1');
    try { return (JSON.parse(raw).data.lookEtfs || []).some(e => e.map === 'VTI'); } catch (e) { return false; }
  });
  check(ltPersisted, 'the ETF breakdown persists to the durable store (survives reload)');
  await page.keyboard.press('Escape'); await page.waitForTimeout(250);

  await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  check(await page.getByText('pre-filled with your own numbers').count() === 0
    && await page.locator('[role=dialog]:has-text("Settings")').count() > 0, 'Escape then closes the dashboard back to Settings');
  await page.keyboard.press('Escape'); await page.waitForTimeout(250);

  // a new service worker taking control (deploy) prompts a reload instead of a stale shell
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  let swToast = false;
  for (let i = 0; i < 10 && !swToast; i++) { await page.waitForTimeout(150); swToast = await page.getByText('A new version is ready').count() > 0; }
  check(swToast, 'a service-worker update surfaces a "new version is ready" refresh toast');

  console.log('backup nudge:');
  const bkCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const bp = await bkCtx.newPage();
  await bp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await bp.evaluate(() => {
    localStorage.removeItem('nima_backup_count');
    const entries = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, type: 'expense', cat: 'Groceries', amount: 10, date: '2026-06-01', note: '', recur: 'none' }));
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: { demoData: false, entries } }));
  });
  await bp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await bp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await bp.waitForTimeout(600);
  await bp.getByRole('button', { name: 'Accounts', exact: true }).click(); await bp.waitForTimeout(300);
  await bp.locator('[aria-label="Settings"]').click(); await bp.waitForTimeout(400);
  check(await bp.getByText(/entries since your last backup/).count() > 0, 'Settings nudges to back up after many entries with no backup');
  await bkCtx.close();

  console.log('display currency — honest offline fallback:');
  // Choosing a non-CAD display currency with no live rate table must NOT fake a
  // conversion: amounts stay in CAD ($) and the setting says so.
  const curCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const cp = await curCtx.newPage();
  await cp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await cp.evaluate(() => localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: { setCurrency: 'USD' } })));
  await cp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await cp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await cp.waitForTimeout(700);
  // net worth hero shows a plain $ figure (CAD), never a converted USD value
  check(await cp.locator('text=/^\\$[0-9]/').count() > 0, 'amounts render as $ (CAD) when no live rate exists');
  await cp.getByRole('button', { name: 'Accounts', exact: true }).click(); await cp.waitForTimeout(300);
  await cp.locator('[aria-label="Settings"]').click(); await cp.waitForTimeout(400);
  check(await cp.getByText('Live rates offline, showing CAD').count() > 0,
    'Currency row is honest when the chosen currency has no live rate');
  await curCtx.close();

  console.log('due card + one-tap post + fixed/variable grading:');
  // Seed: a monthly bill established last month (due on the 1st, so it is
  // always due "today"), a VARIABLE category at 95% of budget, and a FIXED
  // category spent exactly to budget.
  const dueCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const dp = await dueCtx.newPage();
  await dp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await dp.evaluate(() => {
    const d = new Date();
    const ym = (k) => { const t = new Date(d.getFullYear(), d.getMonth() + k, 1); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'); };
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      budgetGroups: [{ name: 'Home', color: '#B0763F', kind: 'expense' }],
      budgetCats: [
        { name: 'Utilities', group: 'Home', kind: 'expense', budget: 100, endDate: null },
        { name: 'Phone', group: 'Home', kind: 'expense', budget: 50, endDate: null, fixed: true },
      ],
      plan: {},
      entries: [
        { id: 1, type: 'expense', cat: 'Utilities', amount: 95, date: ym(0) + '-01', note: '', recur: 'none' },
        { id: 2, type: 'expense', cat: 'Internet', amount: 123.45, date: ym(-1) + '-01', note: '', recur: 'monthly' },
        { id: 3, type: 'expense', cat: 'Phone', amount: 50, date: ym(0) + '-02', note: '', recur: 'none' },
      ] } }));
  });
  await dp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await dp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await dp.waitForTimeout(700);
  check(await dp.locator('text=/is at \\d+% of budget/').count() === 0, 'no budget-alert banners anywhere (alerts removed)');
  check(await dp.locator('text=Due').count() > 0 && await dp.locator('text=/123\\.45/').count() > 0, 'Due card lists the unposted recurring bill');
  await dp.getByRole('button', { name: 'Post', exact: true }).first().click();
  const posted = await dp.waitForFunction(
    () => JSON.parse(localStorage.getItem('nima_data_v1')).data.entries.length === 4,
    null, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(posted, 'one-tap Post logs the due occurrence as a real entry');
  check(await dp.getByRole('button', { name: 'Post', exact: true }).count() === 0, 'posted occurrence leaves the Due card');
  // usage color-grading in Budget › This month: variable-only
  await dp.getByRole('button', { name: 'Budget', exact: true }).click(); await dp.waitForTimeout(500);
  const barStyleOf = (nm) => dp.evaluate((n) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(n));
    const bar = btn && [...btn.querySelectorAll('div')].find((d) => (d.getAttribute('style') || '').includes('height: 100%'));
    return bar ? bar.getAttribute('style') : '';
  }, nm);
  check((await barStyleOf('Utilities')).includes('181, 121, 58'), 'variable category at 95% shades its bar amber');
  check((await barStyleOf('Phone')).includes('176, 118, 63'), 'fixed category at 100% keeps the neutral group color');
  await dueCtx.close();

  console.log('due card cap + expand + post-all:');
  // Six monthly bills established last month => six occurrences due this month,
  // so the Home Due card must cap the list, offer an expander, and Post all.
  const dueBigCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const dbp2 = await dueBigCtx.newPage();
  await dbp2.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await dbp2.evaluate(() => {
    const d = new Date();
    const ym = (k) => { const t = new Date(d.getFullYear(), d.getMonth() + k, 1); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'); };
    const bills = ['Rent', 'Phone', 'Internet', 'Gym', 'Music', 'Cloud'];
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      entries: bills.map((c, i) => ({ id: i + 1, type: 'expense', cat: c, amount: (i + 1) * 10, date: ym(-1) + '-01', note: '', recur: 'monthly' })),
    } }));
  });
  await dbp2.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await dbp2.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await dbp2.waitForTimeout(700);
  const duePostCount = () => dbp2.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Post').length);
  check(await duePostCount() === 2, 'Due card caps the list at 2 rows');
  check(await dbp2.getByRole('button', { name: /^Show all 6/ }).count() === 1, 'shows a "Show all N" expander when over the cap');
  await dbp2.getByRole('button', { name: /^Show all/ }).click();
  await dbp2.waitForTimeout(300);
  check(await duePostCount() === 6, 'the expander reveals every due row');
  await dbp2.getByRole('button', { name: 'Post all', exact: true }).click();
  const allPosted = await dbp2.waitForFunction(
    () => JSON.parse(localStorage.getItem('nima_data_v1')).data.entries.length === 12,
    null, { timeout: 6000 },
  ).then(() => true).catch(() => false);
  check(allPosted, 'Post all logs every due occurrence in one batch (no id collisions)');
  check(await dbp2.getByRole('button', { name: 'Post', exact: true }).count() === 0, 'the Due card clears after Post all');
  await dueBigCtx.close();

  console.log('theme (real token dark mode, not an invert filter):');
  const themeCtx = await browser.newContext();
  const thp = await themeCtx.newPage();
  await thp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await thp.evaluate(() => localStorage.setItem('nima_theme', 'dark'));
  await thp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await thp.waitForTimeout(300);
  check(await thp.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark', 'dark theme sets <html data-theme="dark"> pre-paint');
  check(await thp.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--card').trim().toLowerCase() === '#1b1d1b'), 'dark theme overrides the --card design token');
  check(await thp.evaluate(() => !/1f6452|16463a/i.test(getComputedStyle(document.documentElement).getPropertyValue('--hero') + getComputedStyle(document.documentElement).getPropertyValue('--hero-flat'))),
    'dark heroes are a neutral surface, not the saturated green panel');
  check(await thp.evaluate(() => getComputedStyle(document.documentElement).filter === 'none' || !getComputedStyle(document.querySelector('#dc-root')).filter.includes('invert')), 'dark theme uses tokens, not a whole-app invert() filter');
  check(await thp.evaluate(() => !document.querySelector('link[href*="fonts.googleapis"]')), 'no runtime Google Fonts stylesheet (Geist is self-hosted)');
  // dark palette + typography: the action green carries dark ink (never white),
  // both themes render in the self-hosted Geist, light keeps white-on-green
  const themeLook = async () => {
    await thp.evaluate(() => localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {} })));
    await thp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
    await thp.waitForFunction(() => !!document.querySelector('.ty-root .side-logo'), null, { timeout: 15000 }).catch(() => {});
    return thp.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const logo = document.querySelector('.side-logo'), root = document.querySelector('.ty-root'), sec = document.querySelector('.ty-sec');
      return { solid: css.getPropertyValue('--brand-solid').trim().toLowerCase(), on: logo && getComputedStyle(logo).color,
        font: root && getComputedStyle(root).fontFamily, secW: sec && getComputedStyle(sec).fontWeight,
        loaded: document.fonts.check('600 16px Geist') && [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Geist' && f.status === 'loaded') };
    });
  };
  const dk = await themeLook();
  check(dk.solid === '#50c995' && dk.on === 'rgb(8, 39, 27)', `dark: the action green carries its paired dark ink, not white (${dk.solid} / ${dk.on})`);
  check(/^"?Geist/.test(dk.font || '') && dk.loaded && dk.secW === '600',
    `dark: the self-hosted Geist loads and headings use the calmer weight (${dk.font} · loaded ${dk.loaded} · ${dk.secW})`);
  await thp.evaluate(() => localStorage.setItem('nima_theme', 'light'));
  const lt = await themeLook();
  check(lt.solid === '#1c5d4c' && lt.on === 'rgb(255, 255, 255)' && /^"?Geist/.test(lt.font || '') && lt.secW === '650',
    `light mode keeps its green and white-on-green, in Geist at the stepped-down heading weight (${lt.solid} / ${lt.on} · ${lt.secW})`);
  await themeCtx.close();

  console.log('empty account reads honestly (no fake gains, intentional empty states):'); {
    const emCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const emp = await emCtx.newPage();
    await emp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
    await emp.evaluate(() => localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      demoData: false, entries: [], goals: [], holdings: [], investAccounts: [], brokerDeposits: {}, debts: [] } })));
    await emp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
    await emp.waitForTimeout(1200);
    check(await emp.getByText('No activity yet', { exact: true }).count() > 0, 'Home shows "No activity yet" instead of an empty card');
    check(await emp.getByText('No savings goals yet', { exact: true }).first().isVisible().catch(() => false), 'Home shows "No savings goals yet" with a New goal action');
    const todayLine = await emp.getByText(/· today$/).first().textContent().catch(() => '');
    check(/^\$0 \(0\.00%\)/.test((todayLine || '').trim()), `a zero portfolio change reads unsigned, not as a gain (${(todayLine || '').trim()})`);
    await emCtx.close();
  }

  console.log('invest allocation — Asset Class tab:');
  // Seed two holdings (an ETF + a stock) and cash so exactly three asset classes exist.
  const acCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const acp = await acCtx.newPage();
  await acp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await acp.evaluate(() => {
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      holdings: [
        { t: 'VTI', name: 'Vanguard Total', sector: 'ETF', ccy: 'USD', price: 100, lots: [{ broker: 'IBKR', shares: 10, avgCost: 90 }] },
        { t: 'AAPL', name: 'Apple', sector: 'Technology', ccy: 'USD', price: 200, lots: [{ broker: 'IBKR', shares: 10, avgCost: 150 }] },
        { t: 'CASH', name: 'Cash & settled', sector: 'Cash', price: 0, ccy: 'CAD', cashVal: 500, broker: 'IBKR' },
      ],
      brokerDeposits: { IBKR: 3000 },
    } }));
  });
  await acp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await acp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await acp.getByRole('button', { name: 'Invest', exact: true }).click();
  await acp.waitForTimeout(500);
  check(await acp.getByRole('button', { name: 'Asset Class', exact: true }).count() === 1, 'invest allocation has an Asset Class tab');
  // default view is Asset Class -> centre caption reads "Asset class"
  check(await acp.locator('text=Asset class').count() > 0, 'Asset Class is the default allocation view');
  // only held classes appear as ring labels (ETF, Stock); Bonds/Crypto/etc. must NOT
  check(await acp.evaluate(() => [...document.querySelectorAll('span')].some((s) => s.textContent.trim() === 'ETF')), 'held asset classes (ETF) get a slice');
  check(await acp.evaluate(() => ![...document.querySelectorAll('span')].some((s) => ['BONDS', 'CRYPTO', 'REIT', 'METAL'].includes(s.textContent.trim()))), 'unheld asset classes get no slice');
  await acCtx.close();

  console.log('invest allocation — Sectors look through X-ray breakdowns:');
  // A held ETF with a loaded breakdown is unpacked into its constituents' real
  // sectors, so "ETF" stops being a sector slice. VTI here maps to 100% JPM
  // (Finance via the built-in reconMeta table), so its value should land on
  // Finance — not ETF — alongside the direct AAPL (Technology).
  const scCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const scp = await scCtx.newPage();
  await scp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await scp.evaluate(() => {
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      holdings: [
        { t: 'VTI', name: 'Vanguard Total', sector: 'ETF', ccy: 'USD', price: 100, lots: [{ broker: 'IBKR', shares: 20, avgCost: 90 }] },
        { t: 'AAPL', name: 'Apple', sector: 'Technology', ccy: 'USD', price: 200, lots: [{ broker: 'IBKR', shares: 5, avgCost: 150 }] },
        { t: 'CASH', name: 'Cash & settled', sector: 'Cash', price: 0, ccy: 'CAD', cashVal: 100, broker: 'IBKR' },
      ],
      brokerDeposits: { IBKR: 3000 },
      lookEtfs: [{ id: 'ltx1', src: 'VTI', file: 'vti.csv', at: '2025-01-01', cons: [{ t: 'JPM', name: 'JPMorgan Chase', w: 100 }], map: 'VTI' }],
    } }));
  });
  await scp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await scp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await scp.getByRole('button', { name: 'Invest', exact: true }).click(); await scp.waitForTimeout(400);
  await scp.getByRole('button', { name: 'Sectors', exact: true }).click(); await scp.waitForTimeout(400);
  const secBadge = (t) => scp.evaluate((tx) => [...document.querySelectorAll('span')].some((s) => s.textContent.trim() === tx), t);
  check(await secBadge('FIN'), 'a held ETF is unpacked to its constituents\' sector (VTI -> Finance)');
  check(await secBadge('TECH'), 'the direct stock keeps its own sector (AAPL -> Technology)');
  check(!(await secBadge('ETF')), 'ETF is no longer shown as a sector once the breakdown is loaded');
  await scCtx.close();

  console.log('portfolio value chart — recorded daily price history:');
  // The chart used to draw a single straight line from each holding's cost to its
  // latest price, so real mid-period moves (e.g. "down 2% last week") never showed.
  // Recorded daily closes (pxHist, a durable DATA_KEY) now feed real anchors into
  // the reconstruction. Guard: pxHist round-trips through persistence and the Invest
  // chart renders with it present.
  const phCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const php = await phCtx.newPage();
  let phPageErr = false; php.on('pageerror', () => { phPageErr = true; });
  await php.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await php.evaluate(() => {
    const iso = (k) => { const t = new Date(); t.setDate(t.getDate() + k); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      holdings: [{ t: 'VTI', name: 'Vanguard Total', sector: 'ETF', ccy: 'USD', price: 100, lots: [{ date: iso(-40), broker: 'IBKR', shares: 10, avgCost: 100 }] }],
      // a real dip 7 days ago that a cost->today straight line would hide
      pxHist: { VTI: { [iso(-14)]: 100, [iso(-7)]: 80, [iso(-1)]: 99 } },
    } }));
  });
  await php.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await php.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  check(await php.evaluate(() => { const d = JSON.parse(localStorage.getItem('nima_data_v1')).data; return d.pxHist && d.pxHist.VTI && d.pxHist.VTI[Object.keys(d.pxHist.VTI)[1]] === 80; }), 'recorded daily price history (pxHist) persists as a durable key');
  await php.getByRole('button', { name: 'Invest', exact: true }).click();
  await php.waitForTimeout(400);
  check(!phPageErr && await php.evaluate(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0), 'Invest portfolio chart renders with recorded price history');
  await phCtx.close();

  console.log('scheduled (pending) future entries:');
  // Seed one chequing account (bal 1000) and two chq-paid expenses: one dated in
  // the FUTURE (must stay pending — no balance move) and one dated YESTERDAY but
  // still flagged pending (simulating a schedule that came due while the app was
  // closed — boot must auto-post it).
  const pendCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const pp = await pendCtx.newPage();
  await pp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await pp.evaluate(() => {
    const iso = (k) => { const t = new Date(); t.setDate(t.getDate() + k); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      acctSections: {
        chequing:  { label: 'Chequing',  color: '#1C5D4C', accounts: [{ id: 'c1', name: 'Everyday', sub: '', bal: 1000 }] },
        savings:   { label: 'Savings',   color: '#6BA391', accounts: [] },
        investing: { label: 'Investing', color: '#1C5D4C', accounts: [] },
        lent:      { label: 'IOU',       color: '#C9A14A', accounts: [] },
      },
      budgetGroups: [{ name: 'Home', color: '#B0763F', kind: 'expense' }],
      budgetCats: [{ name: 'Bills', group: 'Home', kind: 'expense', budget: 900, endDate: null }],
      plan: {},
      entries: [
        { id: 1, type: 'expense', cat: 'Bills', amount: 200, date: iso(10), note: 'Future rent', recur: 'none', payVia: 'chq:c1', pending: true },
        { id: 2, type: 'expense', cat: 'Bills', amount: 300, date: iso(-1), note: 'Due yesterday', recur: 'none', payVia: 'chq:c1', pending: true },
      ] } }));
  });
  await pp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await pp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await pp.waitForTimeout(800);
  const balOf = () => pp.evaluate(() => (JSON.parse(localStorage.getItem('nima_data_v1')).data.acctSections.chequing.accounts.find((a) => a.id === 'c1') || {}).bal);
  const entryById = (id) => pp.evaluate((i) => JSON.parse(localStorage.getItem('nima_data_v1')).data.entries.find((e) => e.id === i), id);
  // boot posts only the entry whose date has arrived: 1000 - 300 = 700
  const autoPosted = await pp.waitForFunction(
    () => (JSON.parse(localStorage.getItem('nima_data_v1')).data.acctSections.chequing.accounts[0].bal) === 700,
    null, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(autoPosted, 'a due pending entry auto-posts on boot (chequing 1000 -> 700)');
  check(!(await entryById(2)).pending, 'the auto-posted entry is no longer pending');
  check((await entryById(1)).pending === true && (await balOf()) === 700, 'the still-future entry stays pending and holds its balance');
  // find the pending entry in the ledger (search widens scope to every month, so
  // it's found whatever day-of-month "today" is). The ledger opens from Budget.
  await pp.getByRole('button', { name: 'Budget', exact: true }).click(); await pp.waitForTimeout(400);
  await pp.getByRole('button', { name: 'Entries', exact: true }).click(); await pp.waitForTimeout(500);
  await pp.locator('input[placeholder="Search entries"]').fill('Future rent'); await pp.waitForTimeout(400);
  check(await pp.locator('text=Pending').count() > 0, 'the pending entry is labelled "Pending" in the ledger');
  const pendRow = pp.locator(':text-is("Future rent"):visible').first();
  const pendOpacity = await pendRow.count() ? await pendRow.evaluate(t => {
    let el = t, op = 1; while (el) { op *= parseFloat(getComputedStyle(el).opacity); el = el.parentElement; } return op;
  }) : null;
  check(pendOpacity === 1, `a pending ledger row is drawn at full contrast, not faded (opacity ${pendOpacity})`);
  // "Post now" realizes the still-future entry early: 700 - 200 = 500
  await pp.locator('text=Future rent').first().click(); await pp.waitForTimeout(400);
  check(await pp.getByRole('button', { name: 'Post now', exact: true }).count() > 0, 'editing a pending entry offers "Post now"');
  await pp.getByRole('button', { name: 'Post now', exact: true }).click();
  const postedNow = await pp.waitForFunction(
    () => (JSON.parse(localStorage.getItem('nima_data_v1')).data.acctSections.chequing.accounts[0].bal) === 500,
    null, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(postedNow, '"Post now" realizes the future entry early (700 -> 500)');
  check(!(await entryById(1)).pending, 'the manually posted entry is no longer pending');
  await pendCtx.close();

  console.log('exclude-from-budget entries:');
  // Seed a chequing account (bal 1000) and a Groceries budget ($500), no entries.
  // Add an expense through the sheet with "Exclude from budget" ON: the balance
  // must still move, but the budget "Spent" must stay $0.
  const exclCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const ep = await exclCtx.newPage();
  await ep.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await ep.evaluate(() => {
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      acctSections: {
        chequing:  { label: 'Chequing',  color: '#1C5D4C', accounts: [{ id: 'c1', name: 'Everyday', sub: '', bal: 1000 }] },
        savings:   { label: 'Savings',   color: '#6BA391', accounts: [] },
        investing: { label: 'Investing', color: '#1C5D4C', accounts: [] },
        lent:      { label: 'IOU',       color: '#C9A14A', accounts: [] },
      },
      budgetGroups: [{ name: 'Home', color: '#B0763F', kind: 'expense' }],
      budgetCats: [{ name: 'Groceries', group: 'Home', kind: 'expense', budget: 500, endDate: null }],
      plan: {},
      entries: [] } }));
  });
  await ep.goto(`${base}/index.html?add=expense`, { waitUntil: 'domcontentloaded' });
  await ep.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await ep.waitForTimeout(900);
  await ep.locator('input[placeholder="0.00"]').first().fill('100'); await ep.waitForTimeout(200);
  check(await ep.getByRole('switch', { name: 'Exclude from budget' }).count() > 0, 'the entry sheet has an "Exclude from budget" toggle');
  await ep.getByRole('switch', { name: 'Exclude from budget' }).click(); await ep.waitForTimeout(200);
  await ep.getByRole('button', { name: 'Add expense', exact: true }).click();
  const exclSaved = await ep.waitForFunction(
    () => { const es = JSON.parse(localStorage.getItem('nima_data_v1')).data.entries; return es.length === 1 && es[0].excl === true; },
    null, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(exclSaved, 'the expense saves with excl:true');
  check(await ep.evaluate(() => JSON.parse(localStorage.getItem('nima_data_v1')).data.acctSections.chequing.accounts[0].bal) === 900,
    'an excluded expense still moves the account balance (1000 -> 900)');
  await ep.getByRole('button', { name: 'Budget', exact: true }).click(); await ep.waitForTimeout(500);
  check(await ep.locator('text=/\\$0\\s*\\/\\s*\\$500/').count() > 0, 'the excluded expense does NOT count toward budget spending ($0 / $500)');
  await exclCtx.close();

  console.log('transfer source account:');
  // A "Transfer" to savings must debit a SOURCE account (chequing) as well as
  // credit the destination, so net worth is unchanged. The source is a
  // collapsible chip group: collapsed to the default account, tap to pick another.
  const trCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const tp = await trCtx.newPage();
  await tp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await tp.evaluate(() => {
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      acctSections: {
        chequing:  { label: 'Chequing',  color: '#1C5D4C', accounts: [{ id: 'c1', name: 'Everyday', sub: '', bal: 1000 }, { id: 'c2', name: 'Bills', sub: '', bal: 200 }] },
        savings:   { label: 'Savings',   color: '#6BA391', accounts: [{ id: 's1', name: 'Rainy day', sub: '', bal: 3000 }] },
        investing: { label: 'Investing', color: '#1C5D4C', accounts: [] },
        lent:      { label: 'IOU',       color: '#C9A14A', accounts: [] },
      },
      budgetGroups: [{ name: 'Savings', color: '#5E7CA3', kind: 'savings' }],
      budgetCats: [], plan: {}, entries: [] } }));
  });
  await tp.goto(`${base}/index.html?add=expense`, { waitUntil: 'domcontentloaded' });
  await tp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await tp.waitForTimeout(900);
  await tp.getByRole('button', { name: 'Transfer', exact: true }).click(); await tp.waitForTimeout(400);
  check(await tp.locator('text=Source account').count() > 0, 'the Transfer sheet has a "Source account" selector');
  // collapsed: only the default source (Everyday) shows, the other chequing (Bills) is hidden
  check(await tp.getByRole('button', { name: /^Everyday/ }).count() > 0 && await tp.getByRole('button', { name: 'Bills', exact: true }).count() === 0,
    'the source is collapsed to the default account (Everyday shown, Bills hidden)');
  await tp.getByRole('button', { name: /^Everyday/ }).first().click(); await tp.waitForTimeout(300);
  check(await tp.getByRole('button', { name: 'Bills', exact: true }).count() > 0, 'tapping the source expands to reveal the other accounts');
  await tp.getByRole('button', { name: /^Everyday/ }).first().click(); await tp.waitForTimeout(300); // collapse back, keep Everyday
  await tp.locator('input[placeholder="0.00"]').first().fill('500'); await tp.waitForTimeout(200);
  await tp.getByRole('button', { name: 'Add to savings', exact: true }).click();
  const trSaved = await tp.waitForFunction(
    () => { const e = JSON.parse(localStorage.getItem('nima_data_v1')).data.entries[0]; return e && e.dest === 'sav:s1' && e.src === 'chq:c1'; },
    null, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(trSaved, 'the transfer saves with dest sav:s1 and src chq:c1');
  const trBal = await tp.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('nima_data_v1')).data.acctSections;
    return { chq: s.chequing.accounts.find((a) => a.id === 'c1').bal, sav: s.savings.accounts.find((a) => a.id === 's1').bal };
  });
  check(trBal.chq === 500, 'the source chequing account is debited (1000 -> 500)');
  check(trBal.sav === 3500, 'the destination savings account is credited (3000 -> 3500)');
  check(trBal.chq + trBal.sav === 4000, 'net worth is unchanged by the transfer (500 + 3500 = 4000)');
  await trCtx.close();

  console.log('ledger amounts are colored by direction:');
  // An expense reads red and income green at a glance, in the ledger and on Home.
  const colCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const cop = await colCtx.newPage();
  await cop.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await cop.evaluate(() => {
    const d = new Date();
    const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      demoData: false,
      acctSections: {
        chequing:  { label: 'Chequing',  color: '#1C5D4C', accounts: [{ id: 'c1', name: 'Everyday', sub: '', bal: 2000 }] },
        savings:   { label: 'Savings',   color: '#6BA391', accounts: [] },
        investing: { label: 'Investing', color: '#1C5D4C', accounts: [] },
        lent:      { label: 'IOU',       color: '#C9A14A', accounts: [] },
      },
      budgetGroups: [{ name: 'Food & drinks', color: '#5C9CE0', kind: 'expense' }],
      budgetCats: [{ name: 'Groceries', group: 'Food & drinks', kind: 'expense', budget: 300, endDate: null }],
      plan: {}, incomeSources: ['Salary'], incomePlan: {}, debts: [],   // no demo cards: an overdue one adds an interest row to Recent
      entries: [
        { id: 1, type: 'expense', cat: 'Groceries', amount: 42, note: 'Market run', date: ym + '-05', recur: 'none', payVia: 'chq:c1' },
        { id: 2, type: 'income', cat: 'Salary', amount: 1500, note: 'Payday', date: ym + '-06', recur: 'none', dest: 'chq:c1' },
      ] } }));
  });
  await cop.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await cop.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await cop.waitForTimeout(800);
  // read the amount color sitting beside each row title
  const amountColor = (title) => cop.evaluate((t) => {
    const el = [...document.querySelectorAll('div')].find((d) => d.offsetParent && d.textContent.trim() === t);
    const row = el && el.closest('div[style*="cursor"]');
    if (!row) return null;
    const amt = [...row.querySelectorAll('div')].find((d) => /^[+-−]?\$/.test(d.textContent.trim()));
    return amt ? getComputedStyle(amt).color : null;
  }, title);
  const expColor = await amountColor('Market run');
  const incColor = await amountColor('Payday');
  check(expColor === 'rgb(192, 83, 63)', `an expense amount is red, got ${expColor}`);
  check(incColor === 'rgb(28, 122, 86)', `an income amount is green, got ${incColor}`);
  await colCtx.close();

  console.log('selling a holding:');
  // Selling is not deleting: the shares leave the position, the proceeds settle as
  // cash in the SAME brokerage, net deposits don't move (no new money came in), and
  // the trade is logged so net-worth history still shows the shares before the sale.
  const sellCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const slp = await sellCtx.newPage();
  await slp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await slp.evaluate(() => {
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      demoData: false,
      investAccounts: [{ broker: 'Questrade', acctType: 'TFSA', glyph: 'QU', color: '#1C5D4C' }],
      brokerDeposits: { Questrade: 1000 },
      holdings: [
        { t: 'ACME', name: 'Acme Corp', sector: 'Technology', assetClass: 'Stock', ccy: 'CAD', price: 60,
          lots: [{ broker: 'Questrade', shares: 20, avgCost: 50, date: '2026-01-15' }] },
        { t: 'CASH', name: 'Cash & settled', sector: 'Cash', assetClass: 'Cash', ccy: 'CAD', price: 0,
          cashVal: 100, broker: 'Questrade' },
      ],
      budgetGroups: [], budgetCats: [], plan: {}, entries: [] } }));
  });
  await slp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await slp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await slp.waitForTimeout(800);
  await slp.getByRole('button', { name: 'Invest', exact: true }).click(); await slp.waitForTimeout(500);
  await slp.getByText('Acme Corp', { exact: true }).first().click(); await slp.waitForTimeout(500);
  check(await slp.getByRole('button', { name: /^Sell ACME/ }).count() > 0, 'the holding sheet offers a Sell action');
  await slp.getByRole('button', { name: /^Sell ACME/ }).click(); await slp.waitForTimeout(500);
  // sell half the position at 60
  await slp.getByRole('textbox', { name: 'Shares to sell' }).fill('10');
  await slp.getByRole('textbox', { name: 'Sale price per share' }).fill('60');
  await slp.waitForTimeout(300);
  check(await slp.getByText('+$100', { exact: true }).count() > 0,
    'the sheet shows the realized gain (10 sh x ($60 - $50) = +$100)');
  await slp.getByRole('button', { name: /^Sell for/ }).click(); await slp.waitForTimeout(900);
  const sold = await slp.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('nima_data_v1')).data;
    const pos = d.holdings.find((h) => h.t === 'ACME');
    const cash = d.holdings.find((h) => h.t === 'CASH' && h.broker === 'Questrade');
    return { shares: pos ? pos.lots[0].shares : null, cash: cash ? cash.cashVal : null,
      sales: d.sales || [], dep: (d.brokerDeposits || {}).Questrade };
  });
  check(sold.shares === 10, 'the sold shares leave the position (20 -> 10)');
  check(sold.cash === 700, 'the proceeds settle as cash in the same brokerage (100 + 600)');
  check(sold.sales.length === 1 && sold.sales[0].realized === 100 && sold.sales[0].shares === 10,
    'the sale is kept in the durable sales log with its realized gain');
  check(sold.dep === 1000, 'net deposits are unchanged by a sale (no new money came in)');
  // selling the rest closes the position but keeps the cash and the log
  await slp.getByText('Acme Corp', { exact: true }).first().click(); await slp.waitForTimeout(500);
  await slp.getByRole('button', { name: /^Sell ACME/ }).click(); await slp.waitForTimeout(500);
  await slp.getByRole('button', { name: 'All', exact: true }).click(); await slp.waitForTimeout(200);
  await slp.getByRole('textbox', { name: 'Sale price per share' }).fill('60'); await slp.waitForTimeout(300);
  await slp.getByRole('button', { name: /^Sell for/ }).click(); await slp.waitForTimeout(900);
  const closed = await slp.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('nima_data_v1')).data;
    return { pos: d.holdings.some((h) => h.t === 'ACME'),
      cash: (d.holdings.find((h) => h.t === 'CASH' && h.broker === 'Questrade') || {}).cashVal,
      sales: (d.sales || []).length };
  });
  check(closed.pos === false, 'selling the last shares closes the position');
  check(closed.cash === 1300, 'the full proceeds are still settled cash (700 + 600)');
  check(closed.sales === 2, 'both sales stay in the log after the position is gone');
  await sellCtx.close();

  console.log('a sale keeps net-worth history honest:');
  // Selling at the market price leaves today's portfolio value unchanged (shares
  // become the same amount of cash) AND leaves the range change unchanged, because
  // the shares were really held before the sale date. Deleting the holding, or
  // dropping the sale from the reconstruction, flattens the curve to today's cash.
  const histCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const hp = await histCtx.newPage();
  const seedHist = () => ({ v: 1, data: {
    demoData: false,
    investAccounts: [{ broker: 'Questrade', acctType: 'TFSA', glyph: 'QU', color: '#1C5D4C' }],
    brokerDeposits: { Questrade: 1000 },
    holdings: [{ t: 'ACME', name: 'Acme Corp', sector: 'Technology', assetClass: 'Stock', ccy: 'CAD',
      price: 60, lots: [{ broker: 'Questrade', shares: 20, avgCost: 50, date: '2026-01-15' }] }],
    budgetGroups: [], budgetCats: [], plan: {}, entries: [] } });
  await hp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await hp.evaluate((d) => localStorage.setItem('nima_data_v1', JSON.stringify(d)), seedHist());
  const readChart = async () => {
    await hp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
    await hp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
    await hp.waitForTimeout(800);
    await hp.getByRole('button', { name: 'Invest', exact: true }).click(); await hp.waitForTimeout(600);
    return hp.evaluate(() => {
      const lab = [...document.querySelectorAll('div')].find((d) => d.offsetParent && d.textContent.trim() === 'Portfolio value');
      const head = lab && lab.closest('div').parentElement;
      const rows = head ? [...head.parentElement.querySelectorAll('div')].map((d) => d.textContent.trim()) : [];
      return { value: rows.find((t) => /^\$[\d,]+$/.test(t)) || '', change: rows.find((t) => /%\)/.test(t)) || '' };
    });
  };
  const nwBefore = await readChart();
  check(/\$1,200/.test(nwBefore.value), `the chart values the position at market ($1,200), got ${nwBefore.value || 'nothing'}`);
  check(/\+/.test(nwBefore.change), `the range shows a gain before the sale, got ${nwBefore.change || 'nothing'}`);
  // sell the whole position at the market price
  await hp.getByText('Acme Corp', { exact: true }).first().click(); await hp.waitForTimeout(500);
  await hp.getByRole('button', { name: /^Sell ACME/ }).click(); await hp.waitForTimeout(500);
  await hp.getByRole('textbox', { name: 'Sale price per share' }).fill('60'); await hp.waitForTimeout(300);
  await hp.getByRole('button', { name: /^Sell for/ }).click(); await hp.waitForTimeout(1000);
  const nwAfter = await readChart();
  check(nwAfter.value === nwBefore.value,
    `selling at market leaves today's portfolio value unchanged (${nwBefore.value} -> ${nwAfter.value})`);
  // The percentage can drift a hair: before the sale the curve interpolates toward
  // today's price anchor, after it toward the sale-price anchor. The dollar change
  // must still match, and the percentage stay within a rounding hair — a lost
  // history would collapse both to +$0 (0.00%).
  const pctOf = (t) => parseFloat((t.match(/\(([+-]?[\d.]+)%\)/) || [])[1] || 'NaN');
  const dollarOf = (t) => (t.match(/^[+-]?\$[\d,]+/) || [''])[0];
  check(dollarOf(nwAfter.change) === dollarOf(nwBefore.change)
      && Math.abs(pctOf(nwAfter.change) - pctOf(nwBefore.change)) < 0.05,
    `and leaves the history before the sale untouched (${nwBefore.change} -> ${nwAfter.change})`);
  await histCtx.close();

  console.log('any account type can fund a transfer:');
  // The source is no longer limited to chequing: every section (savings, investing,
  // IOU) and every brokerage's settled cash can fund a transfer. The IOU section is
  // seeded with its legacy "Lent" label, so this store also covers the rename.
  const srcCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const sp = await srcCtx.newPage();
  await sp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await sp.evaluate(() => {
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      acctSections: {
        chequing:  { label: 'Chequing',  color: '#1C5D4C', accounts: [{ id: 'c1', name: 'Everyday', sub: '', bal: 1000 }] },
        savings:   { label: 'Savings',   color: '#6BA391', accounts: [{ id: 's1', name: 'Rainy day', sub: '', bal: 3000 }, { id: 's2', name: 'Vacation fund', sub: '', bal: 800 }] },
        investing: { label: 'Investing', color: '#1C5D4C', accounts: [{ id: 'i1', name: 'Locked GIC', sub: '', bal: 5000 }] },
        lent:      { label: 'Lent',      color: '#C9A14A', accounts: [{ id: 'l1', name: 'Lent to Sam', sub: '', bal: 400 }] },
      },
      budgetGroups: [{ name: 'Savings', color: '#5E7CA3', kind: 'savings' }],
      budgetCats: [], plan: {}, entries: [] } }));
  });
  await sp.goto(`${base}/index.html?add=expense`, { waitUntil: 'domcontentloaded' });
  await sp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await sp.waitForTimeout(900);
  await sp.getByRole('button', { name: 'Transfer', exact: true }).click(); await sp.waitForTimeout(400);
  await sp.getByRole('button', { name: /^Everyday/ }).first().click(); await sp.waitForTimeout(300);  // expand
  check(await sp.getByRole('button', { name: 'Vacation fund', exact: true }).count() > 0,
    'a savings account is offered as a transfer source');
  check(await sp.getByRole('button', { name: 'Locked GIC', exact: true }).count() > 0
     && await sp.getByRole('button', { name: 'Lent to Sam', exact: true }).count() > 0,
    'investing and IOU accounts are offered too');
  check(await sp.getByRole('button', { name: 'Rainy day', exact: true }).count() === 0,
    'the destination account is not offered as its own source');
  await sp.getByRole('button', { name: 'Vacation fund', exact: true }).click(); await sp.waitForTimeout(300);
  await sp.locator('input[placeholder="0.00"]').first().fill('200'); await sp.waitForTimeout(200);
  await sp.getByRole('button', { name: 'Add to savings', exact: true }).click();
  const srcSaved = await sp.waitForFunction(
    () => { const e = JSON.parse(localStorage.getItem('nima_data_v1')).data.entries[0]; return e && e.dest === 'sav:s1' && e.src === 'sav:s2'; },
    null, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(srcSaved, 'the transfer saves with a savings account as its source (src sav:s2)');
  const srcBal = await sp.evaluate(() => {
    const a = JSON.parse(localStorage.getItem('nima_data_v1')).data.acctSections.savings.accounts;
    return { s1: a.find((x) => x.id === 's1').bal, s2: a.find((x) => x.id === 's2').bal };
  });
  check(srcBal.s2 === 600, 'the source savings account is debited (800 -> 600)');
  check(srcBal.s1 === 3200, 'the destination savings account is credited (3000 -> 3200)');
  check(srcBal.s1 + srcBal.s2 === 3800, 'net worth is unchanged (3200 + 600 = 3800)');
  const iouSec = await sp.evaluate(() => JSON.parse(localStorage.getItem('nima_data_v1')).data.acctSections.lent);
  check(iouSec.label === 'IOU' && iouSec.accounts[0].name === 'Lent to Sam',
    'a stored "Lent" section label is renamed IOU (account names the user typed are kept)');
  await srcCtx.close();

  console.log('condensed category picker:');
  // The scattered category chips are now a single row that opens a grouped picker
  // with a quick "New category" add that persists for future transactions.
  const catCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const kp = await catCtx.newPage();
  await kp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await kp.evaluate(() => {
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      acctSections: {
        chequing:  { label: 'Chequing',  color: '#1C5D4C', accounts: [{ id: 'c1', name: 'Everyday', sub: '', bal: 1000 }] },
        savings:   { label: 'Savings',   color: '#6BA391', accounts: [] },
        investing: { label: 'Investing', color: '#1C5D4C', accounts: [] },
        lent:      { label: 'IOU',       color: '#C9A14A', accounts: [] },
      },
      budgetGroups: [{ name: 'Everyday', color: '#3E7C6B', kind: 'expense' }],
      budgetCats: [
        { name: 'Groceries', group: 'Everyday', kind: 'expense', budget: 300, endDate: null },
        { name: 'Transportation', group: 'Everyday', kind: 'expense', budget: 100, endDate: null },
      ],
      plan: {}, entries: [] } }));
  });
  await kp.goto(`${base}/index.html?add=expense`, { waitUntil: 'domcontentloaded' });
  await kp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await kp.waitForTimeout(900);
  // the scattered chips are gone: a single row (aria-label "Choose category") shows the pick
  const catRow = kp.getByRole('button', { name: 'Choose category', exact: true });
  check(await catRow.count() > 0 && /Groceries/.test(await catRow.first().innerText()), 'the entry sheet shows the selected category in a condensed row');
  await catRow.first().click(); await kp.waitForTimeout(400);
  check(await kp.getByText('Choose category', { exact: true }).count() > 0, 'tapping the row opens the category picker');
  check(await kp.getByText('New category', { exact: true }).count() > 0, 'the picker offers a "New category" action');
  check(await kp.getByRole('button', { name: 'Edit categories' }).count() > 0, 'the picker offers an "Edit" action');
  // pick an existing tile: shown with its emoji, selecting closes the picker
  await kp.getByRole('button', { name: 'Transportation', exact: true }).click(); await kp.waitForTimeout(400);
  check(await kp.getByText('Choose category', { exact: true }).count() === 0, 'selecting a category closes the picker');
  check(/Transportation/.test(await catRow.first().innerText()), 'the row updates to the newly selected category');
  // edit mode: tap a tile -> edit form, change its emoji, save
  await catRow.first().click(); await kp.waitForTimeout(400);
  await kp.getByRole('button', { name: 'Edit categories' }).click(); await kp.waitForTimeout(300);
  await kp.getByRole('button', { name: 'Groceries', exact: true }).click(); await kp.waitForTimeout(400);
  check(await kp.getByText('Edit category', { exact: true }).count() > 0, 'edit mode opens the category editor for a tapped tile');
  await kp.getByRole('button', { name: '🍔', exact: true }).first().click(); await kp.waitForTimeout(150);
  await kp.getByRole('button', { name: 'Save changes', exact: true }).click(); await kp.waitForTimeout(400);
  const emojiSaved = await kp.waitForFunction(
    () => (JSON.parse(localStorage.getItem('nima_data_v1')).data.budgetCats.find((c) => c.name === 'Groceries') || {}).emoji === '🍔',
    null, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(emojiSaved, 'editing a category persists its new emoji');
  // reopen, search-filter the tile grid
  await catRow.first().click(); await kp.waitForTimeout(400);
  await kp.locator('input[placeholder^="Search categories"]').fill('grocer'); await kp.waitForTimeout(400);
  check(await kp.getByRole('button', { name: 'Groceries', exact: true }).count() > 0
    && await kp.getByRole('button', { name: 'Transportation', exact: true }).count() === 0,
    'the search box filters the category grid');
  await kp.locator('input[placeholder^="Search categories"]').fill(''); await kp.waitForTimeout(300);
  // new category + brand-new head category (name + color) via the form
  await kp.getByText('New category', { exact: true }).click(); await kp.waitForTimeout(400);
  await kp.locator('input[placeholder^="Category name"]').fill('Pet care'); await kp.waitForTimeout(150);
  await kp.getByRole('button', { name: '🐾', exact: true }).first().click(); await kp.waitForTimeout(150);
  await kp.getByRole('button', { name: '+ New', exact: true }).click(); await kp.waitForTimeout(200);
  await kp.locator('input[placeholder="New head category name"]').fill('Wellness'); await kp.waitForTimeout(150);
  await kp.getByRole('button', { name: 'Create category', exact: true }).click(); await kp.waitForTimeout(400);
  const madeCat = await kp.waitForFunction(
    () => { const d = JSON.parse(localStorage.getItem('nima_data_v1')).data;
      const c = d.budgetCats.find((x) => x.name === 'Pet care');
      return !!c && c.emoji === '🐾' && c.group === 'Wellness' && d.budgetGroups.some((g) => g.name === 'Wellness'); },
    null, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(madeCat, 'a new category with a new head category (name + color) persists');
  await kp.locator('input[placeholder="0.00"]').first().fill('20'); await kp.waitForTimeout(200);
  await kp.getByRole('button', { name: 'Add expense', exact: true }).click();
  const savedCat = await kp.waitForFunction(
    () => { const es = JSON.parse(localStorage.getItem('nima_data_v1')).data.entries; return es.length === 1 && es[0].cat === 'Pet care'; },
    null, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(savedCat, 'the new category is applied to the saved entry');
  await catCtx.close();

  console.log('catalog vs budget screen:');
  // A catalog-only category (off:true) shows in the picker but stays off the Budget
  // screen until it's spent on. Basics always show; Savings renders first.
  const cvCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const vp = await cvCtx.newPage();
  await vp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await vp.evaluate(() => {
    const d = new Date();
    const ym = (k) => { const t = new Date(d.getFullYear(), d.getMonth() + (k || 0), 1); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'); };
    const c = (name, group, budget, off, kind) => ({ name, group, budget: budget || 0, kind: kind || 'expense', off: off || undefined, endDate: null });
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      acctSections: {
        chequing:  { label: 'Chequing',  color: '#1C5D4C', accounts: [{ id: 'c1', name: 'Everyday', sub: '', bal: 2000 }] },
        savings:   { label: 'Savings',   color: '#6BA391', accounts: [{ id: 's1', name: 'Savings', sub: '', bal: 3000 }] },
        investing: { label: 'Investing', color: '#1C5D4C', accounts: [] },
        lent:      { label: 'IOU',       color: '#C9A14A', accounts: [] },
      },
      budgetGroups: [{ name: 'Savings', color: '#5E7CA3', kind: 'savings' }, { name: 'Transportation', color: '#8B5CF6', kind: 'expense' }],
      budgetCats: [
        c('Emergency savings', 'Savings', 250, false, 'savings'),
        c('Gas', 'Transportation', 80, false), c('Taxi', 'Transportation', 0, false),
        c('Flight', 'Transportation', 0, true), c('Repair', 'Transportation', 0, true),
      ],
      plan: {}, incomeSources: ['Salary', 'Other'], incomePlan: { Salary: 3000, Other: 0 },
      // dated in the browser's current month — a catalog-only category joins the
      // Budget screen for the month it was spent in, not for every month
      entries: [
        { id: 1, type: 'expense', cat: 'Flight', amount: 300, date: ym() + '-02', recur: 'none', payVia: 'chq:c1' },
        // last month has ordinary spending only — it gives the month nav somewhere
        // to go back to, and must not pick up the Flight category
        { id: 2, type: 'expense', cat: 'Gas', amount: 40, date: ym(-1) + '-05', recur: 'none', payVia: 'chq:c1' },
      ] } }));
  });
  await vp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await vp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await vp.waitForTimeout(800);
  await vp.getByRole('button', { name: 'Budget', exact: true }).click(); await vp.waitForTimeout(300);
  await vp.getByRole('button', { name: 'Plan', exact: true }).click(); await vp.waitForTimeout(500);
  check(await vp.getByText('Gas', { exact: true }).count() > 0, 'a basic category shows on the Budget screen');
  check(await vp.getByText('Repair', { exact: true }).count() === 0, 'an unused catalog-only category is hidden from the Budget screen');
  check(await vp.getByText('Flight', { exact: true }).count() > 0, 'a catalog-only category joins the Budget screen once it is spent on');
  // ...but only for the month it was spent in — it must not appear in earlier months
  await vp.getByRole('button', { name: 'Previous month' }).click(); await vp.waitForTimeout(500);
  check(await vp.getByText('Flight', { exact: true }).count() === 0,
    'the catalog-only category does NOT appear in a month it was never spent in');
  await vp.getByRole('button', { name: 'Next month' }).click(); await vp.waitForTimeout(500);
  // Savings section renders before the expense groups
  const savingsFirst = await vp.evaluate(() => {
    const t = document.body.innerText;
    return t.indexOf('Savings') >= 0 && t.indexOf('Savings') < t.indexOf('Transportation');
  });
  check(savingsFirst, 'the Savings head category renders first');
  // the picker shows the full catalog, including the unused catalog-only one
  await vp.goto(`${base}/index.html?add=expense`, { waitUntil: 'domcontentloaded' });
  await vp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await vp.waitForTimeout(800);
  await vp.getByRole('button', { name: 'Choose category', exact: true }).first().click(); await vp.waitForTimeout(400);
  check(await vp.getByRole('button', { name: 'Repair', exact: true }).count() > 0, 'the picker catalog still lists the unused category');
  await cvCtx.close();

  console.log('income source drill (This month):');
  const idCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const ip = await idCtx.newPage();
  await ip.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await ip.evaluate(() => {
    const d = new Date();
    const ym = () => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      acctSections: {
        chequing:  { label: 'Chequing',  color: '#1C5D4C', accounts: [{ id: 'c1', name: 'Everyday', sub: '', bal: 2000 }] },
        savings:   { label: 'Savings',   color: '#6BA391', accounts: [] },
        investing: { label: 'Investing', color: '#1C5D4C', accounts: [] },
        lent:      { label: 'IOU',       color: '#C9A14A', accounts: [] },
      },
      budgetGroups: [{ name: 'Food & drinks', color: '#5C9CE0', kind: 'expense' }],
      budgetCats: [{ name: 'Groceries', group: 'Food & drinks', kind: 'expense', budget: 300, endDate: null }],
      plan: {}, incomeSources: ['Salary', 'Other'], incomePlan: { Salary: 3450, Other: 0 },
      // dated in the browser's current month so the drill (which is month-scoped)
      // finds it whatever "today" is
      entries: [{ id: 1, type: 'income', cat: 'Salary', amount: 1725, note: 'Payroll', date: ym() + '-06', recur: 'none', dest: 'chq:c1' }] } }));
  });
  await ip.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await ip.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await ip.waitForTimeout(800);
  await ip.getByRole('button', { name: 'Budget', exact: true }).click(); await ip.waitForTimeout(500);
  // the Salary income row is now a clickable button that drills in
  await ip.getByRole('button').filter({ hasText: 'Salary' }).first().click(); await ip.waitForTimeout(400);
  check(await ip.getByText(/planned/).count() > 0, 'clicking an income source opens its drill ("planned", not "budget")');
  check(await ip.getByText('Payroll').count() > 0, 'the income drill lists the source’s entries');
  // and each entry opens the edit sheet, like expenses
  await ip.getByText('Payroll').first().click(); await ip.waitForTimeout(400);
  check(await ip.getByText('Edit entry', { exact: true }).count() > 0, 'an income entry opens the edit sheet from the drill');
  await idCtx.close();

  console.log('plan edits are month-scoped (earlier months never change):');
  // The Plan/category editor writes forward only: a revision stamped on the selected
  // month applies to it and every month after, while earlier months keep whatever
  // they were budgeted with. Same for planned income, new categories and deletes.
  const msCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const ms = await msCtx.newPage();
  await ms.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await ms.evaluate(() => {
    const d = new Date();
    const ym = (k) => { const t = new Date(d.getFullYear(), d.getMonth() + k, 1); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'); };
    const m1 = ym(-1);
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      budgetGroups: [{ name: 'Home', color: '#B0763F', kind: 'expense' }],
      budgetCats: [{ name: 'Rent', group: 'Home', kind: 'expense', budget: 0, endDate: null }],
      // last month was planned at $100 and the current month inherits it
      plan: { Rent: { [m1]: 100 } },
      incomeSources: ['Salary'], incomePlan: { Salary: { [m1]: 1000 } },
      entries: [{ id: 1, type: 'expense', cat: 'Rent', amount: 90, date: m1 + '-10', note: '', recur: 'none' }] } }));
  });
  await ms.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await ms.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await ms.waitForTimeout(700);
  await ms.getByRole('button', { name: 'Budget', exact: true }).click(); await ms.waitForTimeout(400);
  await ms.getByRole('button', { name: 'Plan', exact: true }).click(); await ms.waitForTimeout(400);
  const rentAmt = ms.getByRole('textbox', { name: 'Rent planned amount' });
  const salaryAmt = ms.getByRole('textbox', { name: 'Salary planned amount' });
  const prevMonth = ms.getByRole('button', { name: 'Previous month' });
  const nextMonth = ms.getByRole('button', { name: 'Next month' });
  check(await rentAmt.inputValue() === '100', 'the current month inherits last month’s planned amount ($100)');
  await rentAmt.fill('400'); await rentAmt.blur(); await ms.waitForTimeout(400);
  await salaryAmt.fill('2000'); await salaryAmt.blur(); await ms.waitForTimeout(400);
  check(await rentAmt.inputValue() === '400', 'the edit lands on the selected month ($400)');
  await prevMonth.click(); await ms.waitForTimeout(500);
  check(await rentAmt.inputValue() === '100', 'the previous month keeps its own planned amount ($100), not the new one');
  check(await salaryAmt.inputValue() === '1000', 'the previous month keeps its own planned income ($1,000)');
  await nextMonth.click(); await ms.waitForTimeout(500);
  check(await rentAmt.inputValue() === '400', 'the current month (and every month after) carries the new amount');

  // a category added this month must not appear in the months before it
  // target the sheet's controls by accessible name — hidden sc-if subtrees stay in
  // the DOM, so text-based locators can latch onto an invisible copy
  await ms.locator('[data-budget-section="Home"]').getByRole('button', { name: 'Add category' }).click();
  await ms.waitForTimeout(400);
  await ms.getByRole('textbox', { name: 'Category name' }).fill('Yard care');
  await ms.getByRole('textbox', { name: 'Monthly amount' }).fill('75');
  await ms.getByRole('button', { name: 'Add category', exact: true }).click(); await ms.waitForTimeout(600);
  check(await ms.getByRole('textbox', { name: 'Yard care planned amount' }).inputValue() === '75',
    'a new category shows on the month it was created, at the amount entered');
  await prevMonth.click(); await ms.waitForTimeout(500);
  check(await ms.getByRole('textbox', { name: 'Yard care planned amount' }).count() === 0, 'the new category does NOT appear in the previous month');

  // deleting a category with history retires it forward instead of erasing the past
  await nextMonth.click(); await ms.waitForTimeout(500);
  await ms.getByRole('button', { name: /^Rent/ }).first().click(); await ms.waitForTimeout(400);
  await ms.getByRole('button', { name: 'Delete category' }).click(); await ms.waitForTimeout(600);
  check(await ms.getByRole('textbox', { name: 'Rent planned amount' }).count() === 0, 'the deleted category is gone from the selected month');
  await prevMonth.click(); await ms.waitForTimeout(500);
  check(await ms.getByRole('textbox', { name: 'Rent planned amount' }).count() > 0, 'the previous month still has the category it was budgeted with');
  check(await ms.getByRole('textbox', { name: 'Rent planned amount' }).inputValue() === '100', 'and still at its own planned amount ($100)');

  // Deleting must never orphan real spending, whichever month it sits in. Entries in
  // the selected month (or a later one) used to leave the category unprotected: it
  // took the hard-delete path and vanished from every month that held entries.
  const orphCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const op = await orphCtx.newPage();
  await op.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await op.evaluate(() => {
    const d = new Date();
    const ym = (k) => { const t = new Date(d.getFullYear(), d.getMonth() + k, 1); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'); };
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      budgetGroups: [{ name: 'Lifestyle', color: '#9C6FA0', kind: 'expense' }],
      budgetCats: [
        { name: 'Gym', group: 'Lifestyle', kind: 'expense', budget: 0, endDate: null },
        { name: 'Books', group: 'Lifestyle', kind: 'expense', budget: 0, endDate: null },
      ],
      plan: {},
      entries: [
        // Gym is spent on THIS month only — nothing before it
        { id: 1, type: 'expense', cat: 'Gym', amount: 65, date: ym(0) + '-04', note: '', recur: 'none' },
        // Books is spent on NEXT month (a scheduled entry), nothing before
        { id: 2, type: 'expense', cat: 'Books', amount: 30, date: ym(1) + '-04', note: '', recur: 'none' },
        { id: 3, type: 'expense', cat: 'Gym', amount: 65, date: ym(-1) + '-04', note: '', recur: 'none' },
      ] } }));
  });
  await op.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await op.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await op.waitForTimeout(700);
  await op.getByRole('button', { name: 'Budget', exact: true }).click(); await op.waitForTimeout(400);
  await op.getByRole('button', { name: 'Plan', exact: true }).click(); await op.waitForTimeout(400);
  // delete Gym while standing on the month that holds one of its entries
  await op.getByRole('button', { name: /^Gym/ }).first().click(); await op.waitForTimeout(400);
  await op.getByRole('button', { name: 'Delete category' }).click(); await op.waitForTimeout(600);
  check(await op.getByRole('textbox', { name: 'Gym planned amount' }).count() > 0,
    'deleting a category keeps it on the month whose spending it holds');
  await op.getByRole('button', { name: 'Previous month' }).click(); await op.waitForTimeout(500);
  check(await op.getByRole('textbox', { name: 'Gym planned amount' }).count() > 0,
    'and on the earlier month that also has entries — the spend is never orphaned');
  await op.getByRole('button', { name: 'Next month' }).click(); await op.waitForTimeout(500);
  // Books' only entry is next month: deleting it now must not erase it from there
  await op.getByRole('button', { name: /^Books/ }).first().click(); await op.waitForTimeout(400);
  await op.getByRole('button', { name: 'Delete category' }).click(); await op.waitForTimeout(600);
  await op.getByRole('button', { name: 'Next month' }).click(); await op.waitForTimeout(500);
  check(await op.getByRole('textbox', { name: 'Books planned amount' }).count() > 0,
    'deleting in an earlier month leaves a later month that holds entries intact');
  await orphCtx.close();

  // The picker offers the whole catalog on purpose, so a retired category can still
  // be chosen. Spending must never land in a month that doesn't show the category:
  // saving the entry un-retires it rather than hiding the money.
  await ms.goto(`${base}/index.html?add=expense`, { waitUntil: 'domcontentloaded' });
  await ms.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await ms.waitForTimeout(800);
  await ms.getByRole('button', { name: 'Choose category', exact: true }).first().click(); await ms.waitForTimeout(400);
  await ms.getByRole('button', { name: 'Rent', exact: true }).first().click(); await ms.waitForTimeout(400);
  await ms.locator('input[inputmode="decimal"]').first().fill('55');
  await ms.getByRole('button', { name: /^(Save|Add) /i }).last().click(); await ms.waitForTimeout(800);
  await ms.getByRole('button', { name: 'Budget', exact: true }).click(); await ms.waitForTimeout(400);
  await ms.getByRole('button', { name: 'Plan', exact: true }).click(); await ms.waitForTimeout(500);
  check(await ms.getByRole('textbox', { name: 'Rent planned amount' }).count() > 0,
    'logging an expense into a retired category brings it back, so the spend is visible');
  await msCtx.close();

  console.log('budget rollover:');
  // Fresh context: isolates from the pending debounced saves of the earlier
  // sections, which would otherwise clobber the seeded store on reload.
  // Seed a rolling category with two prior months of underspend, relative to the
  // browser's current month so it works whatever "today" is:
  //   month-2: budget 100, spent 60  -> +40
  //   month-1: budget 100, spent 80  -> +20   => carry +60, available 160
  const rollCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const rp = await rollCtx.newPage();
  await rp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await rp.evaluate(() => {
    const d = new Date();
    const ym = (k) => { const t = new Date(d.getFullYear(), d.getMonth() + k, 1); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'); };
    const m2 = ym(-2), m1 = ym(-1);
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      budgetGroups: [{ name: 'Home', color: '#B0763F', kind: 'expense' }],
      budgetCats: [{ name: 'Rent', group: 'Home', kind: 'expense', budget: 100, endDate: null, roll: true, rollStart: m2 }],
      plan: {},
      entries: [
        { id: 1, type: 'expense', cat: 'Rent', amount: 60, date: m2 + '-10', note: '', recur: 'none' },
        { id: 2, type: 'expense', cat: 'Rent', amount: 80, date: m1 + '-10', note: '', recur: 'none' },
      ] } }));
  });
  await rp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await rp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await rp.waitForTimeout(700);
  await rp.locator('text=Budget').first().click(); await rp.waitForTimeout(500);
  check(await rp.locator('text=/\\+\\$60/').count() > 0, 'rolling category shows the carried-over amount (+$60)');
  check(await rp.locator('text=/\\$0\\s*\\/\\s*\\$160/').count() > 0, 'group total reflects available = planned + carry ($160)');
  await rollCtx.close();

  console.log('debt interest only accrues when overdue:');
  // A card whose payment due date is still in the future can be paid in full within
  // the grace period, so it must NOT show an interest expense yet; only a card past
  // its due date accrues interest.
  const intCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const dbp = await intCtx.newPage();
  await dbp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await dbp.evaluate(() => {
    const td = new Date().getDate();
    const overdueStmt = td >= 3 ? td - 2 : 28;   // most recent statement's due date is in the past
    const futureStmt = Math.min(td, 28);          // due ~25 days out -> still in the future
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      demoData: false,
      budgetGroups: [{ name: 'Bills', color: '#B0763F', kind: 'expense' }],
      // off:true — a catalog-only category, so this also proves the accrued interest
      // surfaces its own row on the Budget screen without a real entry or a budget
      budgetCats: [{ name: 'Interest & fees', group: 'Bills', kind: 'expense', budget: 0, endDate: null, off: true }],
      plan: {},
      debts: [
        { id: 'od', name: 'Overdue Card', glyph: 'OD', color: '#B5793A', balance: 1000, apr: 24, minType: 'greater', minFixed: 10, minPercent: 2, stmtDay: overdueStmt, grace: 0 },
        { id: 'fu', name: 'Future Card', glyph: 'FU', color: '#3E7C6B', balance: 1000, apr: 24, minType: 'greater', minFixed: 10, minPercent: 2, stmtDay: futureStmt, grace: 25 },
      ],
      entries: [] } }));
  });
  await dbp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await dbp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await dbp.waitForTimeout(700);
  await dbp.getByRole('button', { name: 'Budget', exact: true }).click(); await dbp.waitForTimeout(400);
  await dbp.getByRole('button', { name: 'Entries', exact: true }).click(); await dbp.waitForTimeout(500);
  await dbp.locator('input[placeholder="Search entries"]').fill('Interest'); await dbp.waitForTimeout(400);
  check(await dbp.locator('text=Overdue Card').count() > 0, 'an overdue card accrues an interest expense');
  check(await dbp.locator('text=Future Card').count() === 0, 'a card whose due date is still in the future accrues NO interest');
  await dbp.locator('input[placeholder="Search entries"]').fill(''); await dbp.waitForTimeout(300);
  await dbp.keyboard.press('Escape'); await dbp.waitForTimeout(500);
  // :visible matters here — hidden sc-if subtrees stay in the DOM, and the ledger
  // behind the closed sheet carries the same text
  check(await dbp.locator('[data-budget-section="Bills"] :text-is("Interest & fees"):visible').count() > 0,
    'the accrued interest surfaces its catalog-only category on the Budget screen');
  await intCtx.close();

  console.log('a card bills by statement cycle, not by running balance:');
  // What a card asks for on its due date is the balance as its statement CLOSED.
  // Charges made after the close ride on the NEXT statement, so paying a statement
  // in full must read as $0 due however much has been spent since — while those
  // charges still show in "balance owing" and still count in the month they were spent.
  const cycCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const cp2 = await cycCtx.newPage();
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortD = (d) => `${d.getDate()} ${MON[d.getMonth()]}`;
  const now0 = new Date(); now0.setHours(0, 0, 0, 0);
  let cycClose = new Date(now0.getFullYear(), now0.getMonth(), 11);
  if (cycClose > now0) cycClose = new Date(now0.getFullYear(), now0.getMonth() - 1, 11);
  const cycDue = new Date(cycClose); cycDue.setDate(cycDue.getDate() + 21);
  const cycNextClose = new Date(cycClose.getFullYear(), cycClose.getMonth() + 1, 11);
  const cycNextDue = new Date(cycNextClose); cycNextDue.setDate(cycNextDue.getDate() + 21);
  await cp2.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await cp2.evaluate(() => {
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const card = (id, name, glyph, balance) => ({ id, name, glyph, color: '#B5793A', balance, apr: 21.99,
      minType: 'greater', minFixed: 10, minPercent: 2, stmtDay: 11, grace: 21 });
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      demoData: false,
      budgetGroups: [{ name: 'Home', color: '#B0763F', kind: 'expense' }],
      budgetCats: [{ name: 'Groceries', group: 'Home', kind: 'expense', budget: 1000, endDate: null }],
      plan: {},
      debts: [
        // statement paid in full; the $400 owing is all post-close charges
        card('settled', 'Settled Card', 'ST', 400),
        // $800 statement still unpaid, plus the same $400 of post-close charges
        card('carried', 'Carried Card', 'CA', 1200),
      ],
      entries: [
        { id: 1, type: 'expense', cat: 'Groceries', amount: 400, date: today, note: '', recur: 'none', payVia: 'card:settled' },
        { id: 2, type: 'expense', cat: 'Groceries', amount: 400, date: today, note: '', recur: 'none', payVia: 'card:carried' },
      ] } }));
  });
  await cp2.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await cp2.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await cp2.waitForTimeout(700);
  await cp2.getByRole('button', { name: 'Accounts', exact: true }).click(); await cp2.waitForTimeout(500);
  const settledRow = await cp2.getByRole('button', { name: /Settled Card/ }).first().innerText();
  check(/-\$400/.test(settledRow), 'the card still shows the full balance owing (-$400), post-close charges included');
  check(settledRow.includes(`due ${shortD(cycNextDue)}`),
    `a settled statement points at the NEXT due date (${shortD(cycNextDue)})`);
  await cp2.getByRole('button', { name: /Settled Card/ }).first().click(); await cp2.waitForTimeout(500);
  const settledSheet = await cp2.locator('[role=dialog]:has-text("Edit debt account")').first().innerText();
  check(/Statement balance\s*\n\s*\$0\b/.test(settledSheet),
    'a paid statement reads $0 due, not the post-close charges');
  check(/Minimum due\s*\n\s*\$0\b/.test(settledSheet), 'and nothing is the minimum due');
  check(new RegExp(`Charged since ${shortD(cycClose)}\\s*\\n\\s*\\$400`).test(settledSheet),
    `the $400 charged since ${shortD(cycClose)} is broken out separately`);
  check(new RegExp(`Payment due\\s*\\n\\s*${shortD(cycNextDue)}`).test(settledSheet),
    `and the card points at the next due date (${shortD(cycNextDue)})`);
  await cp2.locator('[role=dialog]:has-text("Edit debt account")').first()
    .getByRole('button', { name: '✕' }).first().click(); await cp2.waitForTimeout(400);
  await cp2.getByRole('button', { name: /Carried Card/ }).first().click(); await cp2.waitForTimeout(500);
  const carriedSheet = await cp2.locator('[role=dialog]:has-text("Edit debt account")').first().innerText();
  check(/Statement balance\s*\n\s*\$800\b/.test(carriedSheet),
    'an unpaid statement asks for the statement balance ($800 of the $1,200 owing)');
  check(/Minimum due\s*\n\s*\$16\b/.test(carriedSheet), 'the minimum is 2% of the statement, not of the balance ($16)');
  check(new RegExp(`Payment due\\s*\\n\\s*${shortD(cycDue)}`).test(carriedSheet),
    `it stays on this cycle's due date (${shortD(cycDue)})`);
  await cp2.locator('[role=dialog]:has-text("Edit debt account")').first()
    .getByRole('button', { name: '✕' }).first().click(); await cp2.waitForTimeout(400);
  await cp2.getByRole('button', { name: 'Budget', exact: true }).click(); await cp2.waitForTimeout(600);
  check(await cp2.locator('text=/\\$800\\s*\\/\\s*\\$1,000/').count() > 0,
    'card spending still counts in the month it was spent, whatever cycle it bills on');
  // The Plan screen is month-scoped, so a card opened from it reports THAT month's
  // statement — the next month's cycle is still open and bills the charges made
  // since this month's close, rather than repeating the live statement.
  await cp2.getByRole('button', { name: 'Plan', exact: true }).click(); await cp2.waitForTimeout(500);
  await cp2.getByRole('button', { name: 'Next month' }).click(); await cp2.waitForTimeout(500);
  await cp2.getByRole('button', { name: /Carried Card/ }).first().click(); await cp2.waitForTimeout(500);
  const nextSheet = await cp2.locator('[role=dialog]:has-text("Edit debt account")').first().innerText();
  // the $400 was charged today: it rides next month's statement only once this
  // month's has closed (the 11th)
  const ridesNext = now0.getDate() >= 11;
  const nextBal = await cp2.locator('[role=dialog]:has-text("Edit debt account")').first()
    .getByRole('textbox', { name: 'Balance owing' }).inputValue();
  check(nextBal === (ridesNext ? '400' : '0'),
    `balance owing is that month's own cycle (${nextBal} charged into the statement closing ${shortD(cycNextClose)})`);
  check(new RegExp(`Charged ${shortD(cycClose)} – ${shortD(cycNextClose)}`).test(nextSheet),
    'captioned with the period it covers');
  check(!/Statement balance/.test(nextSheet), 'the live statement row is not repeated on another month');
  check(new RegExp(`Payment due\\s*\\n\\s*${shortD(cycNextDue)}`).test(nextSheet),
    `and it is due on its own date (${shortD(cycNextDue)})`);
  // correcting that month by hand: the difference lands on the cycle AND on the
  // running balance, so net worth follows it
  const beforeBal = await cp2.evaluate(() => JSON.parse(localStorage.getItem('nima_data_v1')).data.debts.find((d) => d.id === 'carried').balance);
  const scopedSheet = cp2.locator('[role=dialog]:has-text("Edit debt account")').first();
  await scopedSheet.getByRole('textbox', { name: 'Balance owing' }).fill(String(Number(nextBal) + 50));
  await cp2.waitForTimeout(200);
  await scopedSheet.getByRole('button', { name: 'Save changes', exact: true }).click(); await cp2.waitForTimeout(600);
  const corrected = await cp2.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('nima_data_v1')).data.debts.find((x) => x.id === 'carried');
    return { bal: d.balance, adj: d.stmtAdj };
  });
  check(corrected.bal === beforeBal + 50,
    `a month-scoped balance edit moves the running balance by the difference (${beforeBal} -> ${corrected.bal})`);
  check(!!corrected.adj && Object.values(corrected.adj)[0] === 50,
    'and records it against that statement, not as a rewrite of the balance');
  await cp2.getByRole('button', { name: /Carried Card/ }).first().click(); await cp2.waitForTimeout(500);
  const reopened = await cp2.locator('[role=dialog]:has-text("Edit debt account")').first()
    .getByRole('textbox', { name: 'Balance owing' }).inputValue();
  check(reopened === String(Number(nextBal) + 50), 'the month reopens on the corrected figure');
  // the settled card's running balance says $0 while its open cycle carries $400 of
  // tagged charges (a payment logged against a pre-tracking statement ate them):
  // saving that month reconciles the balance up to what the screen is showing
  await cp2.locator('[role=dialog]:has-text("Edit debt account")').first()
    .getByRole('button', { name: '✕' }).first().click(); await cp2.waitForTimeout(400);
  await cp2.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('nima_data_v1'));
    s.data.debts.find((d) => d.id === 'settled').balance = 0;   // as if a payment had eaten them
    localStorage.setItem('nima_data_v1', JSON.stringify(s));
  });
  await cp2.reload({ waitUntil: 'domcontentloaded' });
  await cp2.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await cp2.waitForTimeout(700);
  await cp2.getByRole('button', { name: 'Budget', exact: true }).click(); await cp2.waitForTimeout(400);
  await cp2.getByRole('button', { name: 'Plan', exact: true }).click(); await cp2.waitForTimeout(400);
  await cp2.getByRole('button', { name: 'Next month' }).click(); await cp2.waitForTimeout(500);
  await cp2.getByRole('button', { name: /Settled Card/ }).first().click(); await cp2.waitForTimeout(500);
  const openSheet = cp2.locator('[role=dialog]:has-text("Edit debt account")').first();
  const openShown = await openSheet.getByRole('textbox', { name: 'Balance owing' }).inputValue();
  await openSheet.getByRole('button', { name: 'Save changes', exact: true }).click(); await cp2.waitForTimeout(600);
  const reconciled = await cp2.evaluate(() => JSON.parse(localStorage.getItem('nima_data_v1')).data.debts.find((d) => d.id === 'settled').balance);
  check(reconciled === Number(openShown),
    `saving an unclosed month brings a stale balance up to what it shows (0 -> ${reconciled})`);
  await cp2.getByRole('button', { name: 'Accounts', exact: true }).click(); await cp2.waitForTimeout(600);
  const nwAfter2 = await cp2.locator('#dc-root').innerText();
  const liabExp = (1250 + Number(openShown)).toLocaleString('en-US');
  check(new RegExp(`Liabilities\\s*\\n\\s*\\$${liabExp}`).test(nwAfter2),
    `and net worth counts it as a liability ($${liabExp} across both cards)`);
  await cycCtx.close();

  console.log('This month summary gauge (left to spend vs planned budget):');
  // The cluttered "used of income" tile is now a single segmented gauge: one central
  // "Left to spend" number measured against the total PLANNED budget (expenses +
  // savings), never income. Spending/contributions this month reduce what's left.
  const bmCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const mp = await bmCtx.newPage();
  await mp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await mp.evaluate(() => {
    const d = new Date();
    const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      demoData: false,
      acctSections: {
        chequing:  { label: 'Chequing',  color: '#1C5D4C', accounts: [{ id: 'c1', name: 'Everyday', sub: '', bal: 1000 }] },
        savings:   { label: 'Savings',   color: '#6BA391', accounts: [{ id: 's1', name: 'Rainy day', sub: '', bal: 0 }] },
        investing: { label: 'Investing', color: '#1C5D4C', accounts: [] },
        lent:      { label: 'IOU',       color: '#C9A14A', accounts: [] },
      },
      // total planned = 500 (Groceries) + 300 (savings) = 800; used = 200 + 100 = 300
      budgetGroups: [{ name: 'Home', color: '#B0763F', kind: 'expense' }, { name: 'Savings', color: '#5E7CA3', kind: 'savings' }],
      budgetCats: [
        { name: 'Groceries', group: 'Home', kind: 'expense', budget: 500, endDate: null },
        { name: 'Emergency', group: 'Savings', kind: 'savings', budget: 300, endDate: null },
      ],
      plan: {},
      entries: [
        { id: 1, type: 'income', cat: 'Salary', amount: 9999, date: ym + '-05', note: '', recur: 'none', dest: 'chq:c1' },
        { id: 2, type: 'expense', cat: 'Groceries', amount: 200, date: ym + '-06', note: '', recur: 'none', payVia: 'chq:c1' },
        { id: 3, type: 'savings', cat: 'Emergency', amount: 100, date: ym + '-07', note: '', recur: 'none', dest: 'sav:s1', src: 'chq:c1' },
      ] } }));
  });
  await mp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await mp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await mp.waitForTimeout(700);
  await mp.getByRole('button', { name: 'Budget', exact: true }).click(); await mp.waitForTimeout(500);
  check(await mp.getByText('Left to spend', { exact: true }).count() > 0, 'the tile shows a single "Left to spend" label');
  // 800 planned − 300 used = 500 left; NOT measured against the $9,999 income
  check(await mp.getByText('$500', { exact: true }).count() > 0, 'the centre shows left-to-spend against the plan ($800 − $300 = $500), not the $9,999 income');
  check(await mp.getByText('$200', { exact: true }).count() > 0 && await mp.getByText('$100', { exact: true }).count() > 0,
    'each category is labelled beside its slice with its spend so far ($200 Home, $100 Savings)');
  await bmCtx.close();

  console.log('fresh store shows honest empty states, never a seeded plan:');
  // A brand-new store keeps the taxonomy but ships budget:0 — so nothing is committed on
  // the user's behalf. The ring/donut/trend must read empty, and the Plan seed shows as a
  // grey placeholder, not a value.
  const esCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const esp = await esCtx.newPage();
  await esp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await esp.evaluate(() => {
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      demoData: false,
      budgetGroups: [{ name: 'Savings', color: '#5E7CA3', kind: 'savings' }, { name: 'Food & drinks', color: '#5C9CE0', kind: 'expense' }],
      // seeded taxonomy, zero budgets (as freshData now produces)
      budgetCats: [
        { name: 'Groceries', group: 'Food & drinks', kind: 'expense', budget: 0, off: false },
        { name: 'Emergency savings', group: 'Savings', kind: 'savings', budget: 0, off: false },
      ],
      // a complete-but-empty store (as freshData produces) — no demo debts/income leaking in
      plan: {}, entries: [], debts: [], incomePlan: {},
    } }));
  });
  await esp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await esp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await esp.waitForTimeout(700);
  await esp.getByRole('button', { name: 'Budget', exact: true }).click(); await esp.waitForTimeout(500);
  check(await esp.getByText('Nothing budgeted yet').count() > 0, 'This-month ring shows the "Nothing budgeted yet" empty state, not a $0 gauge');
  check(await esp.getByText('Left to spend', { exact: true }).count() === 0, 'no fake "Left to spend" number on a fresh store');
  check(await esp.getByText('Spending trend').count() === 0, 'the trend card is hidden until there are two months of entries');
  await esp.getByRole('button', { name: 'Plan', exact: true }).click(); await esp.waitForTimeout(500);
  check(await esp.getByText('Nothing planned yet').count() > 0, 'the Plan donut shows the "Nothing planned yet" empty state');
  check(await esp.locator('input[placeholder="320"]').count() > 0, 'the Groceries seed default (320) rides along as a grey placeholder');
  check(await esp.locator('input[placeholder="320"]').first().inputValue() === '', 'the seed default is a placeholder, not a committed value');
  await esCtx.close();

  console.log('a card payment never silently eats tracked charges:');
  // The card balance used to be clamped at 0, so paying more than the app had
  // tracked wiped the charges underneath it (the card read $0 owing while the
  // tagged charges said otherwise) and the payment no longer reversed exactly.
  const ovCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const ov = await ovCtx.newPage();
  await ov.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await ov.evaluate(() => {
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      demoData: false,
      acctSections: {
        chequing:  { label: 'Chequing',  color: '#1C5D4C', accounts: [{ id: 'c1', name: 'Daily', sub: '', bal: 2000 }] },
        savings:   { label: 'Savings',   color: '#6BA391', accounts: [] },
        investing: { label: 'Investing', color: '#1C5D4C', accounts: [] },
        lent:      { label: 'IOU',       color: '#C9A14A', accounts: [] },
      },
      budgetGroups: [{ name: 'Home', color: '#B0763F', kind: 'expense' }],
      budgetCats: [{ name: 'Groceries', group: 'Home', kind: 'expense', budget: 500, endDate: null }],
      plan: {}, holdings: [], goals: [], investAccounts: [], brokerDeposits: {},
      debts: [{ id: 'wm', name: 'Store Card', glyph: 'ST', color: '#B5793A', balance: 0, apr: 21.99,
        minType: 'fixed', minFixed: 10, minPercent: 2, stmtDay: 11, grace: 21 }],
      entries: [] } }));
  });
  await ov.goto(`${base}/index.html?add=expense`, { waitUntil: 'domcontentloaded' });
  await ov.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await ov.waitForTimeout(800);
  await ov.locator('input[placeholder="0.00"]').first().fill('301'); await ov.waitForTimeout(200);
  await ov.getByRole('button', { name: 'Store Card', exact: true }).click(); await ov.waitForTimeout(300);
  await ov.getByRole('button', { name: 'Add expense', exact: true }).click(); await ov.waitForTimeout(700);
  const charged = await ov.evaluate(() => JSON.parse(localStorage.getItem('nima_data_v1')).data.debts[0].balance);
  check(charged === 301, `tagging a charge to the card raises the balance owing (${charged})`);
  await ov.getByRole('button', { name: 'Accounts', exact: true }).click(); await ov.waitForTimeout(500);
  const nwText = await ov.locator('#dc-root').innerText();
  check(/Liabilities\s*\n\s*\$301/.test(nwText), 'and shows up as a liability in net worth');
  // now pay $800 against a card the app has only tracked $301 of
  await ov.goto(`${base}/index.html?add=expense`, { waitUntil: 'domcontentloaded' });
  await ov.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await ov.waitForTimeout(800);
  await ov.getByRole('button', { name: 'Transfer', exact: true }).click(); await ov.waitForTimeout(400);
  await ov.getByRole('button', { name: 'Pay debt', exact: true }).click(); await ov.waitForTimeout(400);
  await ov.locator('input[placeholder="0.00"]').first().fill('800'); await ov.waitForTimeout(200);
  await ov.getByRole('button', { name: 'Make payment', exact: true }).click(); await ov.waitForTimeout(700);
  const afterPay = await ov.evaluate(() => JSON.parse(localStorage.getItem('nima_data_v1')).data.debts[0].balance);
  check(afterPay === -499,
    `an over-payment leaves the card in credit rather than swallowing the charges (${afterPay}, not 0)`);
  await ovCtx.close();

  console.log('repeats every 4 weeks (28 days — not monthly):');
  // A 4-weekly rule steps 28 days, so it drifts through the calendar and falls 13
  // times a year. Projecting it on its day-of-month (what monthly rules do) would
  // silently turn it into a monthly rule, and would read every posted occurrence
  // as a separate rule, since each lands on a different day.
  const fwCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const fw = await fwCtx.newPage();
  const dayShift = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
  const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const shortOf = (d) => `${d.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`;
  const fwNext = dayShift(14);   // 28 days after the most recent occurrence
  await fw.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await fw.evaluate(() => {
    const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      demoData: false,
      budgetGroups: [{ name: 'Home', color: '#B0763F', kind: 'expense' }],
      budgetCats: [{ name: 'Groceries', group: 'Home', kind: 'expense', budget: 500, endDate: null }],
      plan: {},
      // two postings of the SAME rule, 28 days apart and on different days of the month
      entries: [
        { id: 1, type: 'expense', cat: 'Groceries', amount: 61, date: iso(-42), note: '', recur: 'fourweekly' },
        { id: 2, type: 'expense', cat: 'Groceries', amount: 61, date: iso(-14), note: '', recur: 'fourweekly' },
      ] } }));
  });
  await fw.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await fw.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await fw.waitForTimeout(800);
  const fwHome = await fw.locator('#dc-root').innerText();
  check(/↻ Every 4 weeks/.test(fwHome), 'a 4-weekly entry is labelled "Every 4 weeks"');
  const nextHits = fwHome.split(shortOf(fwNext)).length - 1;
  check(nextHits === 1,
    `the next occurrence lands 28 days on (${shortOf(fwNext)}), once — not per posted occurrence (${nextHits})`);
  await fw.goto(`${base}/index.html?add=expense`, { waitUntil: 'domcontentloaded' });
  await fw.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await fw.waitForTimeout(800);
  const fwChip = fw.getByRole('button', { name: 'Every 4 weeks', exact: true });
  check(await fwChip.count() > 0, 'the entry sheet offers an "Every 4 weeks" repeat chip');
  await fwChip.first().click(); await fw.waitForTimeout(300);
  await fw.locator('input[placeholder="0.00"]').first().fill('61'); await fw.waitForTimeout(200);
  await fw.getByRole('button', { name: 'Add expense', exact: true }).click();
  const fwSaved = await fw.waitForFunction(
    () => (JSON.parse(localStorage.getItem('nima_data_v1')).data.entries || []).some((e) => e.recur === 'fourweekly' && e.amount === 61 && e.id > 2),
    null, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(fwSaved, 'saving stores the 4-weekly cadence on the entry');
  await fwCtx.close();

  console.log('portfolio chart net deposits is an accurate level:');
  // The dashed "Net deposits" legend must show the cumulative cost basis as a LEVEL
  // (from the real reconstruction), not a nonsensical per-range signed delta.
  const ndCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const np = await ndCtx.newPage();
  await np.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await np.evaluate(() => {
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      demoData: false,
      investAccounts: [{ broker: 'Questrade', acctType: 'TFSA', glyph: 'QT', color: '#1C5D4C' }],
      brokerNames: {}, brokerDeposits: { Questrade: 500 },
      holdings: [{ t: 'SHOP.TO', name: 'Shopify', sector: 'Technology', price: 60, ccy: 'CAD',
        lots: [{ broker: 'Questrade', shares: 10, avgCost: 50, date: '2021-01-04' }] }],
      px: { 'SHOP.TO': { cur: 60, prev: 60 } },
      entries: [] } }));
  });
  await np.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await np.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await np.waitForTimeout(700);
  await np.getByRole('button', { name: 'Invest', exact: true }).click(); await np.waitForTimeout(700);
  const legendVal = () => np.evaluate(() => {
    const lbl = [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === 'Net deposits');
    return lbl && lbl.nextElementSibling ? lbl.nextElementSibling.textContent.trim() : null;
  });
  const ndAll = await legendVal();
  check(ndAll === '$500', 'Net deposits shows the real cost basis as a level ($500 for 10 sh @ $50)');
  check(!/^[+\-]/.test(ndAll || '+'), 'Net deposits is a level, not a signed per-range delta');
  await np.getByRole('button', { name: '1M', exact: true }).click(); await np.waitForTimeout(400);
  check(await legendVal() === '$500', 'Net deposits stays consistent when the chart range changes');
  await ndCtx.close();

  console.log('manual balance adjustment is stamped with the real date:');
  // A hardcoded appToday() made every adjustment read "25 Jun"; the stamp must be
  // the day it happened, and rows written by the old build must still render.
  const adjCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const ap = await adjCtx.newPage();
  await ap.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await ap.evaluate(() => {
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      demoData: false,
      acctSections: {
        chequing:  { label: 'Chequing',  color: '#1C5D4C', accounts: [{ id: 'c1', name: 'Daily Spending', sub: '', bal: 1000 }] },
        savings:   { label: 'Savings',   color: '#6BA391', accounts: [] },
        investing: { label: 'Investing', color: '#1C5D4C', accounts: [] },
        lent:      { label: 'IOU',       color: '#C9A14A', accounts: [] },
      },
      acctAdjust: { c1: [{ amt: -100, kind: 'Balance adjusted', date: '25 Jun' }] },
      holdings: [], entries: [] } }));
  });
  await ap.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await ap.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await ap.waitForTimeout(700);
  await ap.getByRole('button', { name: 'Accounts', exact: true }).click(); await ap.waitForTimeout(500);
  const adjRow = ap.getByRole('button', { name: /Daily Spending/ });
  check(!/Adjusted/.test(await adjRow.innerText()),
    'the account row does not repeat the adjustment — the sheet lists them');
  await adjRow.click(); await ap.waitForTimeout(500);
  const adjSheet = ap.locator('[role=dialog]:has-text("Edit account")');
  await adjSheet.locator('input[placeholder="0"]').first().fill('1500'); await ap.waitForTimeout(200);
  await adjSheet.getByRole('button', { name: 'Save changes', exact: true }).click(); await ap.waitForTimeout(600);
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const stamped = await ap.evaluate(() => (JSON.parse(localStorage.getItem('nima_data_v1')).data.acctAdjust.c1 || [])[0]);
  check(stamped && stamped.amt === 500 && stamped.date === iso,
    `the new adjustment is stamped with today's date (${stamped ? stamped.date : 'none'} === ${iso})`);
  const shortToday = `${today.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][today.getMonth()]}`;
  await adjRow.click(); await ap.waitForTimeout(500);
  const adjSheetText = await ap.locator('[role=dialog]:has-text("Edit account")').first().innerText();
  check(new RegExp(`\\+\\$500\\s*\\n\\s*${shortToday}`).test(adjSheetText),
    `the sheet shows the adjustment on today's date (${shortToday})`);
  check(/\$100\s*\n\s*25 Jun/.test(adjSheetText),
    'an adjustment written by the old build still renders its stored label');
  await adjCtx.close();

  console.log('deleting an account section (built-in and custom):'); {

  // A built-in section is structural (the chq:/sav:/ivs:/lnt: tags resolve through
  // it), so deleting it empties + hides it rather than dropping the key; "Add
  // section" must then offer it back. Custom sections are removed outright.
  const dsCtx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const dsp = await dsCtx.newPage();
  await dsp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await dsp.evaluate(() => {
    localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {
      demoData: false,
      acctSections: {
        chequing:  { label: 'Chequing',  color: '#1C5D4C', accounts: [{ id: 'c1', name: 'Daily Spending', sub: '', bal: 1000 }] },
        savings:   { label: 'Savings',   color: '#6BA391', accounts: [{ id: 's1', name: 'Rainy Day', sub: '', bal: 900 }] },
        investing: { label: 'Investing', color: '#1C5D4C', accounts: [] },
        lent:      { label: 'IOU',       color: '#C9A14A', accounts: [] },
      },
      customSections: [{ id: 'secX', label: 'Vehicles', kind: 'asset', color: '#5E7CA3',
        accounts: [{ id: 'v1', name: 'Car', bal: 8000 }] }],
      investAccounts: [], brokerDeposits: {}, holdings: [], goals: [], entries: [] } }));
  });
  await dsp.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await dsp.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
  await dsp.waitForTimeout(700);
  await dsp.getByRole('button', { name: 'Accounts', exact: true }).click(); await dsp.waitForTimeout(500);
  const dsSheet = () => dsp.locator('[role=dialog]:has-text("Edit section")').first();
  const dsNw = () => dsp.evaluate(() => {
    const lbl = [...document.querySelectorAll('div')].find((d) => d.textContent.trim() === 'Total net worth');
    return lbl && lbl.nextElementSibling ? lbl.nextElementSibling.textContent.trim() : '';
  });
  const dsMoney = (t) => parseFloat(String(t).replace(/[^0-9.\-]/g, '')) || 0;
  const dsNwBefore = dsMoney(await dsNw());

  // built-in: two-tap delete, then the section is gone from the screen
  await dsp.locator('text=Savings').last().click(); await dsp.waitForTimeout(500);
  check(await dsSheet().getByRole('button', { name: /Delete section/ }).count() > 0,
    'a built-in section offers Delete section, not just Save changes');
  await dsSheet().getByRole('button', { name: /Delete section/ }).click(); await dsp.waitForTimeout(300);
  check(await dsSheet().getByRole('button', { name: /Tap again to delete 1 account/ }).count() > 0,
    'deleting a section with accounts arms a confirm before it removes anything');
  await dsSheet().getByRole('button', { name: /Tap again to delete/ }).click(); await dsp.waitForTimeout(600);
  const savedSecs = await dsp.waitForFunction(
    () => JSON.parse(localStorage.getItem('nima_data_v1')).data.acctSections.savings.hidden === true,
    null, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  const secStore = await dsp.evaluate(() => JSON.parse(localStorage.getItem('nima_data_v1')).data.acctSections.savings);
  check(savedSecs && secStore.accounts.length === 0,
    'deleting a built-in section empties and hides it (the key survives for the tag prefixes)');
  check(await dsp.getByRole('button', { name: /Rainy Day/ }).count() === 0,
    'the deleted section and its accounts leave the Accounts screen');
  const dsNwAfter = dsMoney(await dsNw());
  check(dsNwBefore - dsNwAfter === 900,
    `the deleted balances leave net worth (${dsNwBefore} -> ${dsNwAfter}, the $900 account gone)`);

  // custom: removed outright
  await dsp.locator('text=Vehicles').first().click(); await dsp.waitForTimeout(500);
  await dsSheet().getByRole('button', { name: /Delete section/ }).click(); await dsp.waitForTimeout(300);
  await dsSheet().getByRole('button', { name: /Tap again to delete/ }).click(); await dsp.waitForTimeout(600);
  const customGone = await dsp.waitForFunction(
    () => (JSON.parse(localStorage.getItem('nima_data_v1')).data.customSections || []).length === 0,
    null, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(customGone, 'deleting a custom section removes it from the store');

  // the hidden built-in comes back through "Add section"
  await dsp.getByRole('button', { name: /Add section/ }).click(); await dsp.waitForTimeout(500);
  const dsNewSheet = dsp.locator('[role=dialog]:has-text("New section")').first();
  check(await dsNewSheet.getByRole('button', { name: 'Savings', exact: true }).count() > 0,
    'the New section sheet offers the deleted built-in back');
  await dsNewSheet.getByRole('button', { name: 'Savings', exact: true }).click(); await dsp.waitForTimeout(500);
  await dsSheet().locator('input[placeholder="Account name"]').first().fill('Rebuilt Savings'); await dsp.waitForTimeout(150);
  await dsSheet().locator('input[placeholder="0"]').first().fill('250'); await dsp.waitForTimeout(150);
  await dsSheet().getByRole('button', { name: 'Save changes', exact: true }).click(); await dsp.waitForTimeout(600);
  const restored = await dsp.waitForFunction(
    () => JSON.parse(localStorage.getItem('nima_data_v1')).data.acctSections.savings.hidden === false,
    null, { timeout: 6000 }
  ).then(() => true).catch(() => false);
  check(restored && await dsp.getByRole('button', { name: /Rebuilt Savings/ }).count() > 0,
    'restoring a built-in section brings it back to the Accounts screen');
  await dsCtx.close();
  }

  console.log('onboarding (fresh install, no birthday step):'); {
  // Onboarding only runs on a store that has never been written, so this needs
  // its own context. Steps: 0 welcome, 1 name, 2 currency, 3 accounts, 4 perms,
  // 5 done. There is no birthday step (a tool that needs an age asks for the
  // date of birth in the profile instead) and no "Three kinds of money" step.
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const pg = await ctx.newPage();
  await pg.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
  await pg.evaluate(() => localStorage.clear());
  await pg.reload({ waitUntil: 'networkidle' });
  await pg.waitForTimeout(1500);
  check(await pg.getByRole('button', { name: /Get started|Continue/ }).count() > 0, 'a cleared store boots into onboarding');
  const obGone = ['Where your money is', 'Change it anytime', 'Three kinds', 'AES-256', 'If you want a nudge', 'No analytics and no ads'];
  check(await pg.evaluate((g) => { const ob = document.querySelector('.ob-frame'); return !!ob && g.every((t) => !ob.innerHTML.includes(t)); }, obGone), 'onboarding carries none of the removed explanatory copy');
  await pg.getByRole('button', { name: /Get started|Continue/ }).first().click(); await pg.waitForTimeout(500);
  await pg.locator('input[placeholder="e.g. Alex"]').fill('Sam'); await pg.waitForTimeout(200);
  await pg.getByRole('button', { name: 'Continue', exact: true }).click(); await pg.waitForTimeout(500);
  check(await pg.locator('select[aria-label="Birth month"]').count() === 0 && await pg.getByText('When were', { exact: false }).count() === 0,
    'setup goes from the name straight on, with no birthday step');
  // 2 currency -> 3 accounts -> 4 perms, then finish
  for (let i = 0; i < 2; i++) {
    await pg.getByRole('button', { name: /^(Continue|Skip for now)$/ }).first().click();
    await pg.waitForTimeout(450);
  }
  check(await pg.getByRole('button', { name: 'Finish setup', exact: true }).count() > 0, 'the renumbered steps still land on the perms step (Finish setup)');
  await pg.getByRole('button', { name: 'Finish setup', exact: true }).click(); await pg.waitForTimeout(700);
  await pg.getByRole('button', { name: /^Enter/ }).first().click();
  await pg.waitForTimeout(1200);
  const stored = await pg.evaluate(() => { try { return JSON.parse(localStorage.getItem('nima_data_v1')).data; } catch { return null; } });
  check(stored && stored.profileNameOverride === 'Sam', 'the name comes through to the store');
  check(stored && stored.birthYM === null, `no date of birth is guessed (${stored ? String(stored.birthYM) : 'no store'})`);
  // The retirement tool asks for the date of birth when it needs an age.
  await pg.locator('[aria-label="Settings"]').click(); await pg.waitForTimeout(400);
  await pg.getByRole('button', { name: 'Tools' }).click(); await pg.waitForTimeout(400);
  await pg.getByRole('button', { name: 'Retirement planning calculator' }).click(); await pg.waitForTimeout(500);
  const addDob = pg.getByRole('button', { name: 'Add your date of birth' });
  check(await addDob.isVisible(), 'with no age set, the retirement tool offers "Add your date of birth"');
  await addDob.click(); await pg.waitForTimeout(400);
  check(await pg.locator('select[aria-label="Birth month"]:visible').count() > 0, 'and it opens the profile to set it');
  await ctx.close();
  }

  // On a computer the app lays out as a website: sidebar nav instead of the
  // bottom tab bar, dialogs centred instead of bottom sheets. The phone layout
  // must be untouched, so check both sides of the breakpoint.
  console.log('desktop layout (website on a computer, phone layout untouched):'); {
    const seed = async (w, h) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const pg = await ctx.newPage();
      await pg.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
      await pg.evaluate(() => localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: {} })));
      await pg.reload({ waitUntil: 'networkidle' });
      await pg.waitForTimeout(1200);
      return { ctx, pg };
    };
    const { ctx: dCtx, pg: d } = await seed(1366, 820);
    const nav = await d.locator('nav.tabbar').boundingBox();
    check(!!nav && nav.x === 0 && nav.width < 320 && nav.height > 700, 'a wide screen gets a full-height sidebar, not a bottom tab bar');
    check(await d.evaluate(() => [...document.querySelectorAll('.mob-only')].every((e) => getComputedStyle(e).display === 'none')),
      'the phone header buttons (settings, +) give way to the sidebar');
    await d.getByRole('button', { name: 'Budget', exact: true }).click();
    await d.waitForTimeout(300);
    check(await d.evaluate(() => document.querySelector('nav.tabbar button[aria-current="page"]')?.textContent.trim() === 'Budget'),
      'the sidebar marks the current screen');
    await d.locator('nav.tabbar').getByRole('button', { name: /Add entry/ }).click();
    await d.waitForTimeout(500);
    const dlg = await d.locator('.sheet[role=dialog]').first().boundingBox();
    check(!!dlg && Math.abs(dlg.x + dlg.width / 2 - 683) < 4 && dlg.y > 8 && dlg.y + dlg.height < 812 && dlg.width <= 560,
      `"Add entry" opens a centred dialog, not a bottom sheet (${dlg ? Math.round(dlg.x) + ',' + Math.round(dlg.y) + ' ' + Math.round(dlg.width) + '×' + Math.round(dlg.height) : 'none'})`);
    await d.keyboard.press('Escape');
    await d.locator('nav.tabbar').getByRole('button', { name: 'Settings' }).click();
    await d.waitForTimeout(400);
    check(await d.getByText('Preferences', { exact: false }).first().isVisible(), 'the sidebar Settings item opens Settings');
    await dCtx.close();

    // two-column screens are levelled: Home's hero lines up with the first
    // goal card, Invest's chart card shares the Allocation column's top and
    // bottom, and the tile rows fill their column instead of truncating
    const { ctx: wCtx, pg: w } = await seed(1470, 850);
    const lv = await w.evaluate(() => {
      const r = (el) => el && el.getBoundingClientRect();
      const hero = r(document.querySelector('.hg-a > div')), goal = r(document.querySelector('.hg-b .tile-row'));
      const tiles = [...document.querySelectorAll('.hg-b .tile-row')].map((row) => { const rr = r(row), last = r(row.lastElementChild); return rr.right - last.right; });
      return { hero: Math.round(hero.top), goal: Math.round(goal.top), slack: Math.max(...tiles.map(Math.round)) };
    });
    check(lv.hero === lv.goal, `Home: the hero lines up with the first savings-goal card (${lv.hero} vs ${lv.goal})`);
    check(lv.slack <= 2, `Home: goal / brokerage / debt tiles fill their column (widest gap ${lv.slack}px)`);
    await w.getByRole('button', { name: 'Invest', exact: true }).click(); await w.waitForTimeout(500);
    const iv = await w.evaluate(() => { const a = document.querySelector('.ig-a').getBoundingClientRect(), b = document.querySelector('.ig-b').getBoundingClientRect();
      return [a.top, a.bottom, b.top, b.bottom].map(Math.round); });
    check(iv[0] === iv[2] && iv[1] === iv[3], `Invest: the chart card and the Allocation column share top and bottom edges (${iv.join(',')})`);
    await wCtx.close();

    const { ctx: mCtx, pg: m } = await seed(430, 900);
    const tb = await m.locator('nav.tabbar').boundingBox();
    check(!!tb && tb.y + tb.height === 900 && tb.height < 100 && tb.width === 430, 'a phone keeps the bottom tab bar');
    check(await m.evaluate(() => [...document.querySelectorAll('.desk-only')].every((e) => getComputedStyle(e).display === 'none')),
      'and none of the sidebar-only items show on a phone');
    await mCtx.close();
  }

  console.log('encrypted sync (fake backend): sign up, second device, conflicts, password reset:');
  {
    // In-memory stand-in for api/account + api/vault + api/push, shared by every
    // "device" (browser context) below. It stores exactly what the app sends,
    // so the checks can confirm the server never sees anything readable.
    const fake = { users: {}, tokens: {}, rts: {}, vaults: {}, offline: new Set(), n: 0 };
    const sess = (u) => {
      const at = 'at' + (++fake.n), rt = 'rt' + fake.n;
      fake.tokens[at] = u.id; fake.rts[rt] = u.id;
      return { access_token: at, refresh_token: rt, expires_in: 3600, user: { id: u.id, email: u.email } };
    };
    const byId = (id) => Object.values(fake.users).find((u) => u.id === id);
    const fakeApi = (dev) => async (route) => {
      if (fake.offline.has(dev)) return route.abort();
      const req = route.request(), url = new URL(req.url()), path = url.pathname.replace(/^.*\/api\//, '');
      const body = req.postData() ? JSON.parse(req.postData()) : {};
      const uid = fake.tokens[(req.headers().authorization || '').replace(/^Bearer /, '')];
      const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
      if (path === 'account') {
        if (req.method() === 'GET') return json(200, { sync: true, push: false, vapidKey: null });
        const u = fake.users[body.email];
        switch (body.action) {
          case 'signup':
            if (u) return json(409, { error: 'exists' });
            fake.users[body.email] = { id: 'u' + (++fake.n), email: body.email, pw: body.password };
            return json(200, { session: sess(fake.users[body.email]) });
          case 'signin': return (u && u.pw === body.password) ? json(200, { session: sess(u) }) : json(401, { error: 'bad_login' });
          case 'refresh': { const id = fake.rts[body.refresh_token]; return id ? json(200, { session: sess(byId(id)) }) : json(401, { error: 'signed_out' }); }
          case 'user': return uid ? json(200, { user: { id: uid, email: byId(uid).email } }) : json(401, { error: 'signed_out' });
          case 'password': if (!uid) return json(401, { error: 'signed_out' }); byId(uid).pw = body.password; return json(200, { ok: true });
          default: return json(200, { ok: true });
        }
      }
      if (path === 'vault') {
        if (!uid) return json(401, { error: 'signed_out' });
        const v = fake.vaults[uid];
        if (req.method() === 'GET') {
          if (!v) return json(200, { vault: null });
          if (url.searchParams.get('meta')) return json(200, { vault: { version: v.version } });
          if (url.searchParams.get('keys')) return json(200, { vault: { version: v.version, keys: v.keys } });
          return json(200, { vault: { ...v } });
        }
        if (body.blob === undefined) { if (!v) return json(404, { error: 'no_vault' }); v.keys = body.keys; return json(200, { version: v.version }); }
        if (body.base === 0) {
          if (v) return json(409, { error: 'conflict', version: v.version });
          fake.vaults[uid] = { version: 1, keys: body.keys, blob: body.blob };
          return json(200, { version: 1 });
        }
        if (!v || v.version !== body.base) return json(409, { error: 'conflict', version: v ? v.version : 0 });
        v.version += 1; v.blob = body.blob; if (body.keys) v.keys = body.keys;
        return json(200, { version: v.version });
      }
      return json(200, { ok: true });
    };
    const device = async (dev, seed, hash = '') => {
      const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
      await ctx.route('**/api/**', fakeApi(dev));
      const pg = await ctx.newPage();
      pg.on('dialog', (d) => d.accept());
      await pg.goto(`${base}/index.html${hash}`, { waitUntil: 'domcontentloaded' });
      if (seed) {
        await pg.evaluate((d) => localStorage.setItem('nima_data_v1', JSON.stringify({ v: 1, data: d })), seed);
        await pg.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
      }
      await pg.waitForFunction(() => (document.querySelector('#dc-root')?.childElementCount || 0) > 0, null, { timeout: 15000 }).catch(() => {});
      await pg.waitForTimeout(800);
      return { ctx, pg };
    };
    const stored = (pg) => pg.evaluate(() => (JSON.parse(localStorage.getItem('nima_data_v1') || 'null') || { data: {} }).data);
    const sheet = (pg) => pg.locator('.sheet[role=dialog][aria-label]').last();
    const field = (pg, label) => pg.locator(`input[aria-label="${label}"]:visible`);
    const openAccount = async (pg) => {
      const row = pg.getByRole('button', { name: /Account & sync/ });
      if (!(await row.isVisible())) { await pg.locator('[aria-label="Settings"]').click(); await pg.waitForTimeout(400); }
      await row.click(); await pg.waitForTimeout(300);
    };
    const openSettings = async (pg) => {
      if (!(await pg.getByRole('button', { name: /Load demo data/ }).isVisible())) { await pg.locator('[aria-label="Settings"]').click(); await pg.waitForTimeout(400); }
    };
    const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };
    const EMAIL = 'sam@example.com', PW = 'correct horse battery';

    // Device A: a store with data creates the account and the vault.
    const { ctx: aCtx, pg: a } = await device('A', {});
    await openAccount(a);
    check(await field(a, 'Email').isVisible(), 'Settings › Account & sync opens sign-in when the backend is there');
    await sheet(a).getByRole('button', { name: 'Create account' }).click();
    await field(a, 'Email').fill(EMAIL);
    await field(a, 'New password').fill(PW);
    await field(a, 'Repeat password').fill(PW);
    await sheet(a).getByRole('button', { name: 'Create account' }).click();
    const keyEl = a.locator('[aria-label="Recovery key value"]');
    await keyEl.waitFor({ timeout: 15000 }).catch(() => {});
    const rk = ((await keyEl.textContent().catch(() => '')) || '').trim();
    check(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/.test(rk), `creating the account shows a recovery key once (${rk})`);
    const userA = fake.users[EMAIL], vA = userA && fake.vaults[userA.id];
    const aData = await stored(a);
    check(!!vA && vA.version === 1, 'the first device uploads its data as vault version 1');
    check(!!userA && userA.pw !== PW && /^[0-9a-f]{64}$/.test(userA.pw), 'the server never receives the real password (only a derived sign-in key)');
    const firstCat = aData.budgetCats[0].name;
    check(!!vA && !vA.blob.includes(firstCat) && !vA.blob.includes('entries') && !JSON.stringify(vA.keys).includes(rk.replace(/-/g, '')),
      'the vault holds only ciphertext (no category names, field names or the recovery key)');
    await sheet(a).getByRole('button', { name: "I've saved it" }).click();
    await a.waitForTimeout(300);
    check(await a.getByText(EMAIL).first().isVisible(), 'Settings shows the signed-in account');

    // Device B: a fresh install signs in from onboarding and gets A's data.
    const { ctx: bCtx, pg: b } = await device('B', null);
    const haveAcct = b.getByRole('button', { name: 'Already have an account?' });
    await haveAcct.waitFor({ timeout: 8000 }).catch(() => {});
    check(await haveAcct.isVisible() && await b.getByRole('button', { name: 'Continue without an account' }).isVisible(),
      'with sync available the welcome screen offers Get started, Continue without an account, and Already have an account?');
    check(await b.getByText('About a minute to set up', { exact: false }).count() === 0, 'the welcome screen has no "About a minute" subtext');
    const appShowing = (pg) => pg.evaluate(() => { const n = document.querySelector('nav.tabbar'); return !!n && n.offsetParent !== null; });
    await haveAcct.click(); await b.waitForTimeout(400);
    check(await field(b, 'Email').isVisible() && !(await appShowing(b)),
      '"Already have an account?" opens sign-in over the welcome screen, not over a blank app');
    await b.keyboard.press('Escape'); await b.waitForTimeout(300);
    check(await haveAcct.isVisible() && !(await appShowing(b)), 'closing sign-in goes back to the welcome screen');
    await haveAcct.click(); await b.waitForTimeout(400);
    await field(b, 'Email').fill(EMAIL);
    await field(b, 'Password').fill(PW);
    await sheet(b).getByRole('button', { name: 'Sign in' }).click();
    const bGot = await until(async () => { const d = await stored(b); return d.entries && d.entries.length === aData.entries.length && d.budgetCats[0].name === firstCat; }, 20000);
    check(bGot, 'a second device signs in and receives the same data, decrypted locally');

    // B changes something; A catches up with "Sync now".
    await openSettings(b);
    await b.getByRole('button', { name: /Load demo data/ }).click();
    const bPushed = await until(() => fake.vaults[userA.id].version === 2, 10000);
    check(bPushed, 'a change on one device is pushed to the vault (version 2)');
    const bData = await stored(b);
    await openAccount(a);
    await sheet(a).getByRole('button', { name: 'Sync now' }).click();
    const aCaught = await until(async () => JSON.stringify((await stored(a)).entries) === JSON.stringify(bData.entries), 10000);
    check(aCaught, 'the other device pulls the change');
    await a.keyboard.press('Escape'); await a.waitForTimeout(300);

    // Conflict: A edits while offline, B edits online, A comes back.
    fake.offline.add('A');
    await openSettings(a);
    await a.getByRole('button', { name: /Load demo data/ }).click();
    await a.waitForTimeout(3500);
    await openSettings(b);
    await b.getByRole('button', { name: /Load demo data/ }).click();
    await until(() => fake.vaults[userA.id].version === 3, 10000);
    const bData2 = await stored(b);
    fake.offline.delete('A');
    await openAccount(a);
    await sheet(a).getByRole('button', { name: 'Sync now' }).click();
    const conflict = a.getByRole('button', { name: 'Use synced data' });
    await conflict.waitFor({ timeout: 8000 }).catch(() => {});
    check(await conflict.isVisible(), 'edits on two devices ask which copy to keep instead of overwriting either');
    await conflict.click();
    const aResolved = await until(async () => JSON.stringify((await stored(a)).entries) === JSON.stringify(bData2.entries), 10000);
    check(aResolved && fake.vaults[userA.id].version === 3, '"Use synced data" replaces this device\'s copy and leaves the vault alone');

    // With an app passcode on, the session's secrets are sealed with it, and
    // syncing picks up again after the device is unlocked.
    await openSettings(a);
    await a.getByRole('button', { name: /App passcode/ }).click(); await a.waitForTimeout(300);
    await a.locator('input[aria-label="New passcode"]:visible').fill('123456');
    await a.locator('input[aria-label="Repeat passcode"]:visible').fill('123456');
    await a.getByRole('button', { name: 'Turn on & encrypt' }).click();
    const sealed = await until(() => a.evaluate(() => {
      const r = JSON.parse(localStorage.getItem('nima_sync_v1') || 'null');
      return !!r && r.v === 2 && !('rt' in r) && !('dek' in r) && !!r.ct;
    }), 15000);
    check(sealed, 'with an app passcode on, the sync session is sealed too (no refresh token or data key in the clear)');
    await a.reload({ waitUntil: 'domcontentloaded' });
    await a.locator('input[aria-label="Passcode"]').fill('123456');
    await a.locator('input[aria-label="Passcode"]').press('Enter');
    await a.waitForTimeout(1500);
    await openSettings(b);
    await b.getByRole('button', { name: /Load demo data/ }).click();
    await until(() => fake.vaults[userA.id].version === 4, 10000);
    const bData3 = await stored(b);
    await openAccount(a);
    await sheet(a).getByRole('button', { name: 'Sync now' }).click();
    // the store is ciphertext now, but the session record's version is plain
    const aUnlocked = await until(() => a.evaluate(() => JSON.parse(localStorage.getItem('nima_sync_v1') || '{}').ver === 4), 10000);
    check(aUnlocked, 'after unlocking, the device keeps syncing (pulled vault version 4)');
    await a.keyboard.press('Escape');

    // Password reset on a fresh device: the email link + recovery key.
    const keysBefore = JSON.stringify(fake.vaults[userA.id].keys), pwBefore = userA.pw;
    const rec = sess(userA);   // what the reset email's link carries
    const { ctx: cCtx, pg: c } = await device('C', null,
      `#access_token=${rec.access_token}&refresh_token=${rec.refresh_token}&expires_in=3600&type=recovery`);
    const rkField = field(c, 'Recovery key');
    await rkField.waitFor({ timeout: 15000 }).catch(() => {});
    check(await rkField.isVisible(), 'a reset link on a device without the data key asks for the recovery key');
    check(await c.evaluate(() => !location.hash), 'the session in the reset link is cleared from the address bar');
    const NEWPW = 'a brand new passphrase';
    await field(c, 'New password').fill(NEWPW);
    await field(c, 'Repeat password').fill(NEWPW);
    await rkField.fill('0000-0000-0000-0000-0000-0000-0000-0000');
    await c.getByRole('button', { name: 'Set password' }).click();
    await c.waitForTimeout(400);
    check(await c.getByText('That recovery key doesn’t match.').isVisible(), 'a wrong recovery key is refused');
    await rkField.fill(rk.toLowerCase());
    await c.getByRole('button', { name: 'Set password' }).click();
    const cGot = await until(async () => { const d = await stored(c).catch(() => null); return !!d && JSON.stringify(d.entries) === JSON.stringify(bData3.entries); }, 20000);
    check(cGot, 'the recovery key brings the synced data back after a password reset');
    check(JSON.stringify(fake.vaults[userA.id].keys) !== keysBefore && fake.users[EMAIL].pw !== pwBefore,
      'the data key is re-locked with the new password');

    // The new password works for a normal sign-in; the old one doesn't.
    const { ctx: dCtx2, pg: d2 } = await device('D', {});
    await openAccount(d2);
    await field(d2, 'Email').fill(EMAIL);
    await field(d2, 'Password').fill(PW);
    await sheet(d2).getByRole('button', { name: 'Sign in' }).click();
    await d2.waitForTimeout(1500);
    check(await d2.getByText('Wrong email or password.').isVisible(), 'the old password stops working after a reset');
    await field(d2, 'Password').fill(NEWPW);
    await sheet(d2).getByRole('button', { name: 'Sign in' }).click();
    const keep = d2.getByRole('button', { name: "Keep this device's data" });
    await keep.waitFor({ timeout: 15000 }).catch(() => {});
    check(await keep.isVisible(), 'signing in on a device that already has its own data asks which copy to keep');
    // "Get started" on a deployment with sync is create-account first, then setup,
    // and the app (with the new account's vault) only appears at the end.
    const { ctx: eCtx, pg: e } = await device('E', null);
    await e.getByRole('button', { name: 'Get started', exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    await e.waitForTimeout(600);   // let the sync probe land so the welcome knows sync exists
    await e.getByRole('button', { name: 'Get started', exact: true }).click(); await e.waitForTimeout(450);
    check(await field(e, 'Repeat password').isVisible() && !(await appShowing(e)),
      '"Get started" opens Create account over the welcome screen');
    await field(e, 'Email').fill('new@example.com');
    await field(e, 'New password').fill(PW);
    await field(e, 'Repeat password').fill(PW);
    await sheet(e).getByRole('button', { name: 'Create account' }).click();
    const nameBox = e.locator('input[placeholder="e.g. Alex"]');
    await nameBox.waitFor({ timeout: 15000 }).catch(() => {});
    check(await nameBox.isVisible() && !(await appShowing(e)) && !fake.vaults[fake.users['new@example.com'].id],
      'a new account goes into setup next, with no app and no vault yet');
    await nameBox.fill('Sam');
    await e.getByRole('button', { name: 'Continue', exact: true }).click(); await e.waitForTimeout(450);
    for (let i = 0; i < 2; i++) { await e.getByRole('button', { name: /^(Continue|Skip for now)$/ }).first().click(); await e.waitForTimeout(400); }
    await e.getByRole('button', { name: 'Finish setup', exact: true }).click(); await e.waitForTimeout(600);
    await e.getByRole('button', { name: /^Enter/ }).first().click();
    const eKey = e.locator('[aria-label="Recovery key value"]');
    await eKey.waitFor({ timeout: 15000 }).catch(() => {});
    const eVault = fake.vaults[fake.users['new@example.com'].id];
    check(await eKey.isVisible() && !!eVault && eVault.version === 1,
      'finishing setup opens the app, seals the new vault from the setup data, and shows the recovery key');
    // "Continue without an account" is the plain local path: setup, no sheet.
    const { ctx: fCtx, pg: f } = await device('F', null);
    await f.getByRole('button', { name: 'Continue without an account' }).waitFor({ timeout: 8000 }).catch(() => {});
    await f.getByRole('button', { name: 'Continue without an account' }).click(); await f.waitForTimeout(450);
    check(await f.locator('input[placeholder="e.g. Alex"]').isVisible() && await f.locator('input[aria-label="Email"]:visible').count() === 0,
      '"Continue without an account" goes straight into setup with no account form');
    await fCtx.close();
    await aCtx.close(); await bCtx.close(); await cCtx.close(); await dCtx2.close(); await eCtx.close();
  }
} finally {
  if (browser) await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\nsmoke: ${failures.length} check(s) FAILED:\n` + failures.map((f) => '  ✗ ' + f).join('\n'));
  process.exit(1);
}
console.log('\nsmoke: OK — all checks passed');
