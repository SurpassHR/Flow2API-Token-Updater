---
name: playwright
description: Use Playwright (Node) to drive a real Chromium browser for scraping, screenshots, and reading live site cookies/session state. Use when a page needs JavaScript, when curl returns an empty shell, when you must inspect cookies/localStorage of an authenticated site, or when verifying extension behavior in a real browser profile.
---

# Playwright (Node)

Installed locally in this repo: `playwright` + Chromium under `~/.cache/ms-playwright`.
Always run scripts with `npx playwright ...` or `node script.mjs` **from the repo root** so the local
`node_modules` resolves.

## Core patterns

### 1. Inspect cookies of an authenticated site (no login automation)

Use the real Chrome profile so the existing session is reused. Chrome must be **fully quit** first
(profile lock). Note: Chrome ≥ 136 refuses `--user-data-dir` on the default profile; copy the
profile directory if that happens.

```js
import { chromium } from 'playwright';

const ctx = await chromium.launchPersistentContext('/tmp/chrome-profile-copy', {
  channel: 'chrome',           // real Chrome, not bundled Chromium
  headless: false,
});
const page = await ctx.newPage();
await page.goto('https://example.com/fx/tools', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);              // let the SPA do its auth round-trips

const cookies = await ctx.cookies();          // includes httpOnly + partitioned cookies
console.log(cookies.map(c => `${c.name}\t${c.domain}\t${c.path}`).join('\n'));
await ctx.close();
```

`ctx.cookies()` is the ground truth for what a browser session actually holds — use it before
theorizing about why an extension's `chrome.cookies.getAll` is empty.

### 2. Login once, reuse the session

```js
const ctx = await chromium.launchPersistentContext('./pw-profile', { channel: 'chrome', headless: false });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://accounts.google.com/');   // log in by hand, then press Enter in terminal
await page.pause();                                 // opens Inspector; resume when logged in
await ctx.storageState({ path: 'auth-state.json' }); // reuse later via storageState
```

### 3. Screenshot + DOM text of a JS-heavy page

```js
await page.goto(url, { waitUntil: 'networkidle' });
await page.screenshot({ path: 'shot.png', fullPage: true });
console.log(await page.locator('body').innerText());
```

### 4. Watch network calls to find the real API/auth endpoint

```js
page.on('response', r => {
  const u = r.url();
  if (/api|auth|session/.test(u)) console.log(r.status(), u);
});
```

## Gotchas

- `page.goto` + `waitUntil: 'load'` returns before SPA auth completes → always add an explicit
  `waitForTimeout` or wait for a selector that only exists when logged in.
- Third-party cookies are partitioned in modern Chrome. A cookie set by site A inside a top-level
  page on site B is a **partitioned** cookie and will not appear in a plain unpartitioned cookie
  query. `ctx.cookies()` returns them; `document.cookie` does not show httpOnly ones.
- Use `channel: 'chrome'` when site behavior depends on real Chrome; bundled Chromium has different
  codecs and sometimes different auth behavior.
- Headless is fine for scraping, but Google login flows often require `headless: false`.
- Downloads: `npx playwright install chromium` (add `firefox`/`webkit` only if actually needed).
