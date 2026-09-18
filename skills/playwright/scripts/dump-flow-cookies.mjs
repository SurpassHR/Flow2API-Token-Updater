// Dump the real Chrome profile's cookies for the Flow/Labs domains.
// Proves whether a Flow session exists where the extension runs.
//
//   node skills/playwright/scripts/dump-flow-cookies.mjs            # Default profile
//   node skills/playwright/scripts/dump-flow-cookies.mjs "Profile 1"
//
// Quit Chrome first (profile lock). Chrome 136+ refuses --user-data-dir on the
// live profile, so this copies the profile to a temp dir and reads that.

import { chromium } from 'playwright';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const profile = process.argv[2] ?? 'Default';
const src = join(process.env.HOME, 'Library/Application Support/Google/Chrome', profile);

try {
  execSync('pgrep -x "Google Chrome" >/dev/null 2>&1');
  console.error('⚠️  Chrome 正在运行，先完全退出（否则 profile 被锁 / cookie 副本不完整）');
} catch {
  // not running, fine
}

const dir = mkdtempSync(join(tmpdir(), 'chrome-profile-'));
const dst = join(dir, 'Default');
console.log(`copying ${src} -> ${dst}`);
cpSync(src, dst, { recursive: true, errorOnExist: false });

const ctx = await chromium.launchPersistentContext(dir, {
  channel: 'chrome',
  headless: false,
  args: ['--no-first-run'],
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
// 只访问 labs.google 入口：flow.google.com/about 是营销页，不会建立会话
await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded' });
try {
  await page.waitForURL(/flow\.google\.com\/(fx|tools)/, { timeout: 15000 });
} catch {
  // 可能没跳转或未登录，继续看 cookie 状态
}
await page.waitForTimeout(10000); // let the SPA finish its auth round-trips
console.log('final url:', page.url());

const interesting = /labs\.google|flow\.google\.com|next-auth|session|OSID/i;
const cookies = await ctx.cookies();
const hits = cookies.filter((c) => interesting.test(c.name) || interesting.test(c.domain));

const fmt = (c) =>
  `${(c.partitionKey?.topLevelSite ?? '-').padEnd(28)} ${c.domain.padEnd(28)} ${c.path.padEnd(22)} ` +
  `${c.name.padEnd(34)} len=${c.value.length} httpOnly=${!!c.httpOnly}`;

console.log(`\n== total cookies: ${cookies.length}, matching: ${hits.length}`);
console.log(hits.map(fmt).join('\n'));
console.log('\n== all cookie names ==');
console.log([...new Set(cookies.map((c) => `${c.domain}:${c.name}`))].sort().join('\n'));

await ctx.close();
rmSync(dir, { recursive: true, force: true });
