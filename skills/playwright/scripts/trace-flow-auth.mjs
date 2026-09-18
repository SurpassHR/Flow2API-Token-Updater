// Drive real Chrome on the Flow app, capture auth-relevant network traffic.
// Output: JSON trace on stdout + flow-trace.json (values truncated, no cookie dump).
//
//   node skills/playwright/scripts/trace-flow-auth.mjs
//   node skills/playwright/scripts/trace-flow-auth.mjs --headless
//
// Run from repo root. Uses a COPY of the Chrome Default profile (Chrome must be
// quit; the copy keeps the live profile untouched).

import { chromium } from 'playwright';
import { cpSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const headless = process.argv.includes('--headless');
const src = join(process.env.HOME, 'Library/Application Support/Google/Chrome/Default');

try {
  execSync('pgrep -x "Google Chrome" >/dev/null 2>&1');
  console.error('⚠️  Chrome 正在运行：请先 Cmd+Q 完全退出，否则 profile 副本不完整，会误报"未登录"');
} catch {}

const dir = mkdtempSync(join(tmpdir(), 'chrome-flow-'));
cpSync(src, join(dir, 'Default'), { recursive: true, errorOnExist: false });
console.log(`profile copied -> ${dir}`);

const ctx = await chromium.launchPersistentContext(dir, {
  channel: 'chrome',
  headless,
  args: ['--no-first-run'],
});

const trace = [];
ctx.on('response', async (res) => {
  const req = res.request();
  const url = res.url();
  const u = new URL(url);
  if (!/google|gstatic/.test(u.hostname)) return;

  const authish =
    /auth|session|token|account|oauth|csrf|identity|user|me(\?|$)/i.test(u.pathname) ||
    u.hostname.includes('apis') ||
    u.pathname.startsWith('/v1') ||
    u.pathname.startsWith('/fx/api');

  if (!authish) return;

  const headers = await req.allHeaders().catch(() => ({}));
  trace.push({
    method: req.method(),
    host: u.hostname,
    path: u.pathname.slice(0, 120),
    query: u.search.slice(0, 200),
    status: res.status(),
    reqAuth: headers.authorization ? `${headers.authorization.slice(0, 24)}... (len ${headers.authorization.length})` : null,
    reqCookieNames: (headers.cookie ?? '').split(';').map((s) => s.trim().split('=')[0]).filter(Boolean),
    reqOther: Object.fromEntries(
      Object.entries(headers).filter(([k]) => /x-|origin|referer|content-type/i.test(k)),
    ),
  });
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded' });
try {
  await page.waitForURL(/flow\.google\.com\/(fx|tools)/, { timeout: 20000 });
} catch {}
await page.waitForTimeout(12000);

const cookies = await ctx.cookies();
const cookieNames = [...new Set(cookies.map((c) => `${c.domain}\t${c.name}`))].sort();

// What does the labs session endpoint say for this profile?
const sessionProbe = await page
  .evaluate(async () => {
    const out = {};
    for (const origin of ['https://labs.google', 'https://flow.google.com']) {
      try {
        const r = await fetch(`${origin}/fx/api/auth/session`, { credentials: 'include' });
        out[origin] = { status: r.status, body: (await r.text()).slice(0, 300) };
      } catch (e) {
        out[origin] = { error: String(e).slice(0, 120) };
      }
    }
    return out;
  })
  .catch((e) => ({ error: String(e) }));

const report = {
  finalUrl: page.url(),
  pageTitle: await page.title().catch(() => ''),
  sessionProbe,
  cookieNames,
  traceCount: trace.length,
  trace,
};

const out = join(process.cwd(), 'flow-trace.json');
writeFileSync(out, JSON.stringify(report, null, 2));

console.log('\n== final url:', report.finalUrl);
console.log('== session probe:', JSON.stringify(sessionProbe, null, 2));
console.log(`== cookies: ${cookieNames.length} 条 (见 ${out})`);
console.log(`== traced auth-ish requests: ${trace.length}`);
for (const t of trace.slice(0, 40)) {
  console.log(`${t.status} ${t.method} ${t.host}${t.path}${t.query ? '?' + t.query : ''} auth=${t.reqAuth ?? '-'}`);
}

await ctx.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n完整结果: ${out}`);
