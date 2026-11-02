# Dev tooling

These are **dev-only** checks. The shipped app (`project/pwa/`) has no build step
and does not depend on any of this — Vercel still serves the static files as-is.

```bash
npm install        # once, at the repo root
npm run lint       # static checks on the single-file app
npm run smoke      # boots the app in a headless browser and asserts behavior
npm run check      # lint + smoke
```

## Why these exist

The whole app lives in `project/pwa/index.html`: a `<x-dc>` markup block plus a
`<script data-dc-script>` that the dc-runtime compiles with `new Function`. That
means ordinary JS mistakes fail **silently at runtime** instead of at parse time.
Two real bugs of exactly this shape shipped before these checks existed:

- two `saveSection` methods — the second silently shadowed the first, so the
  Budget "Create section" button did nothing;
- a duplicate `remainStr` key in the `renderVals()` object.

### `lint.mjs`
Parses the embedded logic with a real JS parser and fails on:
1. duplicate class members (`no-dupe-class-members`),
2. duplicate object keys (`no-dupe-keys`),
3. template bindings `{{ name }}` in the markup that `renderVals()` never returns.

### `smoke.mjs`
Serves `project/pwa` and drives it in Chromium, asserting: the app boots without
a page error, the service worker controls the page and the app works offline, the
manifest meets install criteria, and Budget → Plan → "Create section" adds a
section (regression guard for the shadowing bug).

CI runs both on every push and PR (`.github/workflows/ci.yml`).
