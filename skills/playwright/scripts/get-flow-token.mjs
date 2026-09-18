// Fully automated: obtain the labs.google NextAuth session token with Playwright,
// using the logged-in Google account of the real Chrome Default profile.
// Prints token metadata and (optionally) POSTs it to your flow2api endpoint.
//
//   node skills/playwright/scripts/get-flow-token.mjs
//   node skills/playwright/scripts/get-flow-token.mjs --write-token token.txt
//   node skills/playwright/scripts/get-flow-token.mjs --post https://your-host/api/xxx --auth <connectionToken>
//
// Chrome must be quit (Cmd+Q): the profile is copied so the live one is untouched.

import { chromium } from 'playwright';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? null : args[i + 1];
};

const src = join(process.env.HOME, 'Library/Application Support/Google/Chrome/Default');
const TOKEN_NAME = '__Secure-next-auth.session-token';
const SESSION_URL = 'https://labs.google/fx/api/auth/session';
const SIGNIN_URL = 'https://labs.google/fx/api/auth/signin/google';

try {
  execSync('pgrep -x "Google Chrome" >/dev/null 2>&1');
  console.error('❌ Chrome 正在运行。请先 Cmd+Q 完全退出再运行本脚本。');
  process.exit(2);
} catch {}

const dir = mkdtempSync(join(tmpdir(), 'chrome-token-'));
cpSync(src, join(dir, 'Default'), { recursive: true, errorOnExist: false });

const ctx = await chromium.launchPersistentContext(dir, {
  channel: 'chrome',
  headless: false,
  args: ['--no-first-run'],
});

const cookieValue = async (name) => {
  const cs = await ctx.cookies('https://labs.google');
  return cs.find((c) => c.name === name)?.value ?? null;
};

// Google account "choose an account" pages put the account buttons outside iframes.
async function clickAccountChooser() {
  const selectors = [
    'div[data-identifier]',
    'li div[role="link"]',
    'div[role="link"]',
    '#identifierNext',
    'button:has-text("Continue")',
    'button:has-text("继续")',
    'button:has-text("允许")',
    'button:has-text("Allow")',
  ];
  for (const sel of selectors) {
    const loc = ctx.pages().at(-1)?.locator(sel).first();
    if (!loc) continue;
    try {
      if (await loc.isVisible({ timeout: 1500 })) {
        console.log(`  -> 点击 ${sel}`);
        await loc.click({ timeout: 4000 });
        await new Promise((r) => setTimeout(r, 2500));
        return true;
      }
    } catch {}
  }
  return false;
}

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(SIGNIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log('after goto:', page.url());

// If labs.google already has a session, signin redirects straight back to the app.
let token = await cookieValue(TOKEN_NAME);
console.log('session cookie after redirect:', token ? `yes (len ${token.length})` : 'no');

for (let i = 0; i < 20 && !token; i++) {
  const url = ctx.pages().at(-1)?.url() ?? '';
  console.log(`[round ${i + 1}] ${url.slice(0, 120)}`);
  if (/accounts\.google\.com|consent|oauth|signin|challenge/.test(url)) {
    const clicked = await clickAccountChooser();
    if (!clicked) await new Promise((r) => setTimeout(r, 2500));
  } else {
    await new Promise((r) => setTimeout(r, 2500));
  }
  token = await cookieValue(TOKEN_NAME);
}

// last resort: hit the session endpoint from the labs.google origin itself
if (!token) {
  const probe = ctx.pages().at(-1);
  if (probe && probe.url().startsWith('https://labs.google')) {
    const body = await probe
      .evaluate(async (u) => (await fetch(u, { credentials: 'include' })).text(), SESSION_URL)
      .catch((e) => `probe failed: ${e}`);
    console.log('session endpoint body:', String(body).slice(0, 200));
  } else {
    await page.goto('https://labs.google', { waitUntil: 'domcontentloaded' });
    const body = await page
      .evaluate(async (u) => (await fetch(u, { credentials: 'include' })).text(), SESSION_URL)
      .catch((e) => `probe failed: ${e}`);
    console.log('session endpoint body:', String(body).slice(0, 200));
  }
  token = await cookieValue(TOKEN_NAME);
}

if (!token) {
  console.error('\n❌ 仍未拿到 session-token。把上面日志发我（尤其 accounts.google.com 那几行）。');
  console.error('   cookie 现状:', (await ctx.cookies('https://labs.google')).map((c) => c.name).join(', '));
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

console.log(`\n✅ 拿到 ${TOKEN_NAME}，长度 ${token.length}`);
const out = flag('--write-token');
if (out) {
  writeFileSync(out, token);
  console.log(`已写入 ${out}`);
}

const post = flag('--post');
if (post) {
  const auth = flag('--auth') ?? '';
  const res = await fetch(post, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify({ session_token: token }),
  });
  console.log(`POST ${post} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
}

await ctx.close();
rmSync(dir, { recursive: true, force: true });
