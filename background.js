// background.js - Chrome扩展后台脚本

// 定时器名称
const ALARM_NAME = 'tokenRefresh';

// 日志系统
const Logger = {
    async log(level, message, details = null) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            message,
            details
        };

        console.log(`[${level}] ${message}`, details || '');

        // 存储到chrome.storage.local（单次会话有效）
        const { logs = [] } = await chrome.storage.local.get(['logs']);
        logs.unshift(logEntry); // 最新的在前面

        // 只保留最近50条日志
        if (logs.length > 50) {
            logs.splice(50);
        }

        await chrome.storage.local.set({ logs });
    },

    info(message, details) {
        return this.log('INFO', message, details);
    },

    error(message, details) {
        return this.log('ERROR', message, details);
    },

    success(message, details) {
        return this.log('SUCCESS', message, details);
    },

    async getLogs() {
        const { logs = [] } = await chrome.storage.local.get(['logs']);
        return logs;
    },

    async clearLogs() {
        await chrome.storage.local.set({ logs: [] });
    }
};

// 初始化：设置定时器
chrome.runtime.onInstalled.addListener(async () => {
    await Logger.info('Flow2API Token Updater installed');
    await setupAlarm();
});

// 监听来自popup的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'updateConfig') {
        // 更新配置后重新设置定时器
        setupAlarm().then(async () => {
            await Logger.info('Config updated, alarm reset');
        });
    } else if (request.action === 'testNow') {
        // 立即执行一次
        extractAndSendToken().then((result) => {
            sendResponse(result);
        }).catch((error) => {
            sendResponse({ success: false, error: error.message });
        });
        return true; // 保持消息通道开启
    } else if (request.action === 'getLogs') {
        // 获取日志
        Logger.getLogs().then((logs) => {
            sendResponse({ success: true, logs });
        });
        return true;
    } else if (request.action === 'clearLogs') {
        // 清除日志
        Logger.clearLogs().then(() => {
            sendResponse({ success: true });
        });
        return true;
    }
});

// 监听定时器触发
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
        await Logger.info('Alarm triggered, extracting token...');
        const result = await extractAndSendToken();

        // 发送通知
        if (result.success) {
            const title = result.action === 'updated' ? '✅ Token已更新' : '✅ Token已添加';
            const message = result.displayMessage || result.message || 'Token已成功同步到Flow2API';

            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icon48.png',
                title: title,
                message: message
            });
        } else {
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icon48.png',
                title: '❌ Token同步失败',
                message: result.error || '未知错误'
            });
        }
    }
});

// 设置定时器
async function setupAlarm() {
    // 清除旧的定时器
    await chrome.alarms.clear(ALARM_NAME);

    // 获取配置
    const config = await chrome.storage.sync.get(['refreshInterval']);
    const intervalMinutes = config.refreshInterval || 60;

    // 创建新的定时器
    chrome.alarms.create(ALARM_NAME, {
        periodInMinutes: intervalMinutes
    });

    await Logger.info(`Alarm set to ${intervalMinutes} minutes`);
}

// 收集所有可访问的cookies
async function collectCookies() {
    const allCookiesFound = [];

    try {
        // 方法1: 当前标签页URL下的cookies
        const tabCookies = await chrome.cookies.getAll({ url: 'https://labs.google/fx/vi/tools/flow' });
        allCookiesFound.push(...tabCookies);
        await Logger.info(`从标签页URL找到 ${tabCookies.length} 个cookies`);

        // 方法2: labs.google 域名
        const labsCookies = await chrome.cookies.getAll({ domain: 'labs.google' });
        allCookiesFound.push(...labsCookies);
        await Logger.info(`从labs.google域名找到 ${labsCookies.length} 个cookies`);

        // 方法3: flow.google.com 域名（Flow 已迁移到该域名）
        const flowCookies = await chrome.cookies.getAll({ domain: 'flow.google.com' });
        allCookiesFound.push(...flowCookies);
        await Logger.info(`从flow.google.com域名找到 ${flowCookies.length} 个cookies`);

        // 方法4: google.com 域名
        const googleCookies = await chrome.cookies.getAll({ domain: 'google.com' });
        allCookiesFound.push(...googleCookies);
        await Logger.info(`从google.com域名找到 ${googleCookies.length} 个cookies`);

        // 方法5: 兜底，列出所有可访问的cookies（含子域，但不含分区cookie）
        const allCookies = await chrome.cookies.getAll({});
        allCookiesFound.push(...allCookies);
        await Logger.info(`全量扫描找到 ${allCookies.length} 个cookies`);

        // 方法6: 分区cookie（Flow 页面访问 labs.google 的接口，session-token 通常是
        // top-level=flow.google.com 的 partitioned cookie，默认查询拿不到）
        for (const site of ['https://flow.google.com', 'https://labs.google']) {
            try {
                const partitioned = await chrome.cookies.getAll({
                    partitionKey: { topLevelSite: site }
                });
                allCookiesFound.push(...partitioned);
                await Logger.info(`分区cookie(topLevel=${site})找到 ${partitioned.length} 个`);
            } catch (err) {
                await Logger.info(`分区cookie查询不支持或失败(topLevel=${site})`, { error: err.message });
            }
        }
    } catch (err) {
        await Logger.error('获取cookies失败', { error: err.message });
    }

    return Array.from(
        new Map(allCookiesFound.map(c => [
            [c.name, c.domain, c.path, c.partitionKey ? c.partitionKey.topLevelSite : ''].join('|'),
            c
        ])).values()
    );
}

const TOKEN_COOKIE_NAMES = [
    '__Secure-next-auth.session-token',
    '__Host-next-auth.session-token',
    'next-auth.session-token'
];

// 从cookie列表中定位 session-token（兼容 __Secure-/__Host- 前缀与分区cookie）
function pickSessionToken(uniqueCookies) {
    const now = Date.now() / 1000;
    const candidates = uniqueCookies.filter(c =>
        TOKEN_COOKIE_NAMES.includes(c.name) &&
        (!c.expirationDate || c.expirationDate > now) &&
        c.value
    );

    if (!candidates.length) {
        return null;
    }

    // 同名多值时取最长（最完整）的
    return candidates.reduce((a, b) => (b.value.length > a.value.length ? b : a));
}

// 服务端打码/protocol 需要 .google.com 账号态 Cookie（SID/HSID/SSID/SAPISID/__Secure-*PSID(TS)/OSID…）
// 缺了它，服务端浏览器打开 Flow 会被判匿名 → 落到 /about（无 grecaptcha）→ 打码必然失败
const COOKIE_EXCLUDE_NAMES = ['SMSV', 'GAPS'];

async function collectGoogleAccountCookies() {
    const found = [];
    for (const domain of ['google.com', 'flow.google.com', 'labs.google']) {
        try {
            found.push(...await chrome.cookies.getAll({ domain }));
        } catch (e) {
            // 单个域名失败不影响整体
        }
    }

    const best = new Map();
    for (const c of found) {
        const name = (c.name || '').trim();
        if (!name || !c.value) continue;
        if (COOKIE_EXCLUDE_NAMES.includes(name)) continue;
        if (name.startsWith('__Host-')) continue;
        const host = (c.domain || '').replace(/^\./, '').toLowerCase();
        if (!host.endsWith('google.com')) continue;
        const domainWide = (c.domain || '').startsWith('.');
        const current = best.get(name);
        if (!current || (domainWide && !current._domainWide)) {
            best.set(name, {
                name,
                value: c.value,
                domain: c.domain,
                path: c.path || '/',
                _domainWide: domainWide
            });
        }
    }

    return Array.from(best.values()).map(({ _domainWide, ...rest }) => rest);
}

// 服务端接受扁平的 "name=value;name=value" 文本格式（与 flow2api 面板导出格式一致）
function buildGoogleCookieHeader(items) {
    return (items || []).map(c => `${c.name}=${c.value}`).join(';');
}

// 在 flow.google.com 页面上下文里调新版建项目 RPC
// （batchexecute 必须在已登录页面里发；纯 HTTP 请求即使带对 SNlM0e 也会 400）
async function createProjectInPage(tabId, projectTitle, hintProjectId) {
    // 第 0 步：如果标签已经在项目页，直接复用该项目，什么都不用做
    const here = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => location.href
    }).then((r) => (r && r[0] && r[0].result) || '').catch(() => '');
    const existing = here.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    if (existing) {
        await Logger.success('已在项目页，直接复用该项目', { projectId: existing[0], url: here });
        return { ok: true, projectId: existing[0], reusedExisting: true };
    }

    // 第 1 步：装 hook，记录页面自己发出的 batchexecute 请求（URL + 表单字段 + 头）
    await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
            if (window.__F2A_HOOKED) return;
            window.__F2A_HOOKED = true;
            window.__F2A_SEEN = [];
            const orig = window.fetch;
            window.fetch = function (input, init) {
                try {
                    const url = typeof input === 'string' ? input : (input && input.url) || '';
                    if (url.indexOf('batchexecute') !== -1 && init && init.body) {
                        window.__F2A_SEEN.push({
                            url,
                            body: typeof init.body === 'string' ? init.body : String(init.body),
                            headers: Object.assign({}, init.headers || {})
                        });
                        if (window.__F2A_SEEN.length > 8) window.__F2A_SEEN.shift();
                    }
                } catch (e) { /* ignore */ }
                return orig.apply(this, arguments);
            };
        }
    });

    // 第 2 步：导航到应用入口触发 batchexecute（首页是营销页，不发 RPC）
    const candidates = [
        'https://labs.google/fx/tools/flow',
        'https://flow.google.com/fx/tools/flow',
        hintProjectId ? `https://flow.google.com/project/${hintProjectId}` : null
    ].filter(Boolean);

    let seen = 0;
    const visited = [];
    for (const url of candidates) {
        await chrome.tabs.update(tabId, { url }).catch(() => {});
        // 等跳转落定
        for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 800));
            let landed = '';
            try { landed = (await chrome.tabs.get(tabId)).url || ''; } catch (e) { break; }
            if (/flow\.google\.com\//.test(landed) && !/\/about(\b|\/|$)/.test(landed)) break;
        }
        await new Promise(r => setTimeout(r, 3000));

        // 若落在营销页 /about，尝试点页面的入口按钮进入应用
        const clicked = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
                const wantEntry = /^(get ?started|try ?it|launch|open ?flow|enter|start|进入|开始|打开|免费使用)/i;
                const els = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"]'));
                const label = (el) => (el.innerText || el.getAttribute('aria-label') || el.textContent || '').trim();
                for (const el of els) {
                    const t = label(el);
                    if (t && wantEntry.test(t)) {
                        const href = el.getAttribute('href') || '';
                        el.click();
                        return { text: t.slice(0, 40), href: href.slice(0, 120) };
                    }
                }
                return { text: null, buttons: els.map(label).filter(Boolean).slice(0, 20) };
            }
        }).then((r) => (r && r[0] && r[0].result) || null).catch(() => null);
        if (clicked) {
            await Logger.info('尝试点击应用入口', clicked);
            await new Promise(r => setTimeout(r, 6000));
        }

        // 每次导航/点击之后都可能已经进了项目页 —— 统一在这里检测复用
        const landedUrl = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => location.href
        }).then((r) => (r && r[0] && r[0].result) || '').catch(() => '');
        const landedProject = landedUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
        if (landedProject) {
            await Logger.success('已在项目页，直接复用该项目', { projectId: landedProject[0], url: landedUrl });
            return { ok: true, projectId: landedProject[0], reusedExisting: true };
        }

        // 应用内点 "New project"，让应用自己建项目（这是唯一被官方认可的创建路径）
        let newProject = null;
        for (let i = 0; i < 4 && !newProject; i++) {
            const res = await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => {
                    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    const targets = ['new project', 'new projects', 'add project', 'create project', '新建项目', '新项目', '添加项目'];
                    const els = Array.from(document.querySelectorAll('a,button,[role="button"],[role="menuitem"],[tabindex]'));
                    const label = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
                    for (const el of els) {
                        const t = norm(label(el));
                        if (t && targets.includes(t)) { el.click(); return { clicked: label(el).slice(0, 40) }; }
                    }
                    // 次级匹配：包含 new project 且不含 removed/duplicate
                    for (const el of els) {
                        const t = norm(label(el));
                        if (t && /new ?projects?|新建项目/.test(t) && !/template|remove|duplicate|draft/.test(t)) {
                            el.click(); return { clicked: label(el).slice(0, 40) };
                        }
                    }
                    return { clicked: null, buttons: els.map(label).filter(Boolean).slice(0, 30) };
                }
            }).then((r) => (r && r[0] && r[0].result) || null).catch(() => null);

            if (!res) break;
            if (res.clicked) {
                await Logger.info('已点击 New Project', res);
                // 等 URL 变成项目页
                for (let k = 0; k < 15; k++) {
                    await new Promise(r => setTimeout(r, 800));
                    let u = '';
                    try { u = (await chrome.tabs.get(tabId)).url || ''; } catch (e) { break; }
                    const m = u.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
                    if (m) { newProject = m[0]; break; }
                }
                if (newProject) break;
            } else {
                // 找不到按钮（多数情况是已经在项目里）——不再刷日志
                await new Promise(r => setTimeout(r, 2500));
            }
        }
        if (newProject) {
            await Logger.success('应用已新建项目', { projectId: newProject, visited });
            return { ok: true, projectId: newProject, createdByApp: true };
        }

        const res = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => ({ seen: (window.__F2A_SEEN || []).length, url: location.href })
        }).then((r) => (r && r[0] && r[0].result) || { seen: 0, url: '' }).catch(() => ({ seen: 0, url: '' }));
        visited.push({ tried: url, landed: res.url, seen: res.seen, clicked });
        seen = res.seen;
        if (seen > 0) break;
    }
    await Logger.info('页面 RPC 采样完成', { seen, visited, hintProjectId: hintProjectId || null });

    // 第 3 步：读出它用的参数，照抄 + 换成建项目 RPC
    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [projectTitle],
        func: async (title) => {
            const diag = { url: location.href, seen: (window.__F2A_SEEN || []).length, used: null, attempt: 0 };
            try {
                const wiz = window.WIZ_global_data || {};
                if (!wiz.SNlM0e) return { ok: false, error: '页面未登录(无 SNlM0e)', debug: diag };

                const inner = JSON.stringify(['projects/*', [null, [title]], [null, 22]]);
                const fReq = JSON.stringify([['jHPbke', inner, null, 'generic']]);
                const at = wiz.SNlM0e;

                const buildFrom = (base) => {
                    // 以页面真实请求的 URL/search 与头为模板，只替换 rpcids
                    const u = new URL(base.url, location.origin);
                    u.searchParams.set('rpcids', 'jHPbke');
                    const headers = Object.assign(
                        { 'X-Same-Domain': '1', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                        base.headers || {}
                    );
                    delete headers['content-length'];
                    return { url: u.toString(), headers };
                };

                let tmpl = (window.__F2A_SEEN || [])[0];
                diag.used = tmpl ? tmpl.url : 'fallback';
                let url, headers;
                if (tmpl) {
                    const built = buildFrom(tmpl);
                    url = built.url; headers = built.headers;
                } else {
                    const filter = wiz.Im6cmf || '/_/AiSandboxAngularFrontend';
                    url = filter + '/data/batchexecute?rpcids=jHPbke&source-path=%2F'
                        + '&bl=' + encodeURIComponent(wiz.cfb2h || '')
                        + '&f.sid=' + encodeURIComponent(wiz.FdrFJe || '')
                        + '&hl=en-US&_reqid=' + (Date.now() % 1000000) + '&rt=c';
                    headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' };
                }

                let last = '';
                for (let i = 0; i < 3; i++) {
                    diag.attempt = i + 1;
                    const res = await fetch(url, {
                        method: 'POST',
                        credentials: 'include',
                        headers,
                        body: 'f.req=' + encodeURIComponent(fReq) + '&at=' + encodeURIComponent(at)
                    });
                    const text = await res.text();
                    last = `HTTP ${res.status} 响应=${text.slice(0, 300)}`;
                    const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
                    if (m) return { ok: true, projectId: m[0], debug: { ...diag, url } };
                    if (res.status !== 400) break;
                    // 400 时换用页面模板重试
                    if (tmpl) { const b = buildFrom(tmpl); url = b.url; headers = b.headers; }
                    await new Promise(r => setTimeout(r, 500));
                }
                return { ok: false, error: last, debug: { ...diag, url, headers } };
            } catch (e) {
                return { ok: false, error: (e && e.message) || String(e), debug: diag };
            }
        }
    });
    return result;
}

// 提取cookie并发送到服务器
async function extractAndSendToken() {
    let tab = null;

    try {
        await Logger.info('开始提取Token...');

        // 获取配置
        const config = await chrome.storage.sync.get(['apiUrl', 'connectionToken', 'projectId']);

        if (!config.apiUrl || !config.connectionToken) {
            await Logger.error('配置未设置');
            return { success: false, error: '配置未设置' };
        }

        await Logger.info('配置已加载', { apiUrl: config.apiUrl });

        // 1. 打开 Flow 页面（前台可见，便于完成登录/授权）
        await Logger.info('正在打开Flow页面...');
        tab = await chrome.tabs.create({
            url: 'https://labs.google/fx/vi/tools/flow',
            active: true
        });

        await Logger.info('页面已创建，等待加载...', { tabId: tab.id });

        // 等待页面落定：labs.google 会 308 跳到 flow.google.com，必须等最终 URL 到 flow 域名
        const deadline = Date.now() + 30000;
        let currentUrl = '';
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 500));
            try {
                const t = await chrome.tabs.get(tab.id);
                currentUrl = t.url || '';
            } catch (e) {
                break; // 标签被关掉了
            }
            if (/^https:\/\/flow\.google\.com\//.test(currentUrl) && !/\/about(\b|\/|$)/.test(currentUrl)) {
                break;
            }
        }

        await Logger.info('页面已加载', { url: currentUrl });

        // 再等应用脚本把 WIZ_global_data 写好
        await new Promise(resolve => setTimeout(resolve, 4000));

        await Logger.info('开始提取Cookies...');

        // 2. 获取session-token
        let allCookiesFound = [];
        let uniqueCookies = await collectCookies();
        let matched = pickSessionToken(uniqueCookies);

        // 2.1 未找到时不静默失败：页面已在前台，等待用户完成登录，再重试
        if (!matched) {
            await Logger.info('暂未找到session-token，请在该标签页完成 Google 登录，等待重试...');

            try {
                await chrome.tabs.update(tab.id, { active: true });
            } catch (e) {
                // 忽略
            }

            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icon48.png',
                title: '⚠️ 需要登录 Google Flow',
                message: '请在该标签页完成 Google 登录并等待 Flow 界面出现，完成后会自动继续提取（最多等5分钟）。'
            });

            const deadline = Date.now() + 5 * 60 * 1000;
            while (!matched && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                try {
                    allCookiesFound = await collectCookies();
                    matched = pickSessionToken(allCookiesFound);
                } catch (e) {
                    // 页面导航中，稍后重试
                }
            }
            uniqueCookies = allCookiesFound.length ? allCookiesFound : uniqueCookies;
        }

        await Logger.info(`去重后共 ${uniqueCookies.length} 个cookie`, {
            cookieNames: uniqueCookies.map(c => ({
                name: c.name,
                domain: c.domain,
                path: c.path,
                partitioned: c.partitionKey ? c.partitionKey.topLevelSite : null
            }))
        });

        const sessionToken = matched ? matched.value : null;

        if (matched) {
            await Logger.success('找到session-token', {
                name: matched.name,
                domain: matched.domain,
                path: matched.path,
                length: sessionToken.length
            });
        }

        // 3. 新版 Flow 已废弃 labs.google 的建项目 tRPC，改由插件在页面里建项目
        let projectId = config.projectId || null;

        if (sessionToken && !projectId && tab) {
            // 注意：service worker 里 tabs.create 返回的对象没有 url，必须重新 tabs.get
            let pageUrl = currentUrl;
            try {
                pageUrl = (await chrome.tabs.get(tab.id)).url || currentUrl;
            } catch (e) {
                // 标签可能已被关闭
            }

            // 取证：把当前所有标签的 URL 都打出来，确认到底停在哪个页面
            let allTabs = [];
            try {
                allTabs = (await chrome.tabs.query({})).map(t => t.url || '(no-url)');
            } catch (e) {
                allTabs = ['query失败: ' + e.message];
            }
            await Logger.info('标签状态取证', { tabId: tab.id, pageUrl, currentUrl, allTabs });

            if (/^https:\/\/flow\.google\.com\//.test(pageUrl)) {
                await Logger.info('在页面内创建项目（新版 batchexecute）...');
                const created = await createProjectInPage(
                    tab.id,
                    `F2A ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
                    config.projectId || null
                ).catch((e) => ({ ok: false, error: e.message }));

                if (created && created.ok) {
                    projectId = created.projectId;
                    await Logger.success('项目创建成功', { projectId });
                } else {
                    await Logger.error('页面内创建项目失败，改用配置里的项目ID（若为空则让服务端自行处理）', {
                        error: created ? created.error : '未知错误',
                        debug: created ? created.debug : null,
                        pageUrl: pageUrl
                    });
                }
            } else {
                await Logger.info('当前标签不是 Flow 应用页，跳过页面内建项目', { pageUrl: pageUrl });
            }
        }

        // 关闭标签页
        if (tab) {
            try {
                await chrome.tabs.remove(tab.id);
            } catch (e) {
                // 忽略关闭标签页的错误
            }
            tab = null;
            await Logger.info('标签页已关闭');
        }

        if (!sessionToken) {
            await Logger.error('未找到session-token', {
                cookieCount: uniqueCookies.length,
                foundCookies: uniqueCookies.map(c => ({
                    name: c.name,
                    domain: c.domain
                }))
            });

            return {
                success: false,
                error: `未找到session-token。请手动打开 https://labs.google/fx/tools/flow 确认已登录并出现 Flow 界面后再试（当前可读到 ${uniqueCookies.length} 个cookie，均非session-token）。`
            };
        }

        await Logger.info('Session-token提取成功', { tokenLength: sessionToken.length });

        // 4. 发送到服务器
        const accountCookies = await collectGoogleAccountCookies().catch(() => []);
        await Logger.info('正在发送到服务器...', {
            googleCookies: accountCookies.length,
            cookieNames: accountCookies.map(c => c.name)
        });

        const response = await fetch(config.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.connectionToken}`
            },
            body: JSON.stringify({
                session_token: sessionToken,
                // 指定已有项目ID：服务端据此跳过已废弃的"创建项目"接口
                ...(projectId ? { project_id: projectId } : {}),
                // 账号态 Cookie：服务端 protocol 刷新 ST / 浏览器打码都依赖它
                // 格式：name=value;name=value（与 flow2api 面板导出格式一致）
                ...(accountCookies.length ? { google_cookies: buildGoogleCookieHeader(accountCookies) } : {})
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            await Logger.error('服务器错误', {
                status: response.status,
                error: errorText
            });
            return { success: false, error: `服务器错误: ${response.status}` };
        }

        const result = await response.json();

        // 根据action显示不同的日志信息
        if (result.action === 'updated') {
            await Logger.success('✅ Token已更新到上游', {
                action: '更新现有Token',
                message: result.message
            });
        } else if (result.action === 'added') {
            await Logger.success('✅ Token已添加到上游', {
                action: '添加新Token',
                message: result.message
            });
        } else {
            await Logger.success('✅ Token已同步到上游', result);
        }

        return {
            success: true,
            message: result.message || 'Token更新成功',
            action: result.action,
            displayMessage: result.action === 'updated'
                ? `✅ 成功更新到上游\n${result.message}`
                : `✅ 成功添加到上游\n${result.message}`
        };

    } catch (error) {
        await Logger.error('提取过程出错', {
            error: error.message,
            stack: error.stack
        });

        // 确保关闭标签页
        if (tab) {
            try {
                await chrome.tabs.remove(tab.id);
            } catch (e) {
                // 忽略关闭标签页的错误
            }
        }

        return { success: false, error: error.message };
    }
}
