// logs.js - 日志查看页面脚本

let currentLogs = [];

// 格式化时间
function formatTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;

    // 如果是今天
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // 如果是昨天
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
        return '昨天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }

    // 其他日期
    return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// 单条日志的可复制文本
function logToText(log) {
    const time = log.timestamp ? new Date(log.timestamp).toLocaleString('zh-CN') : '';
    const lines = [`[${log.level}] ${time}`, log.message || ''];
    if (log.details !== undefined && log.details !== null) {
        try {
            lines.push(JSON.stringify(log.details, null, 2));
        } catch (e) {
            lines.push(String(log.details));
        }
    }
    return lines.join('\n');
}

// 复制文本（优先 clipboard API，失败回退 textarea）
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (e2) {
            return false;
        }
    }
}

function flashCopied(btn, label) {
    const original = btn.dataset.label || btn.textContent;
    btn.dataset.label = original;
    btn.textContent = label || '已复制';
    btn.classList.add('copied');
    setTimeout(() => {
        btn.textContent = btn.dataset.label;
        btn.classList.remove('copied');
    }, 1200);
}

// 渲染日志
function renderLogs(logs) {
    const container = document.getElementById('logsContainer');
    currentLogs = logs || [];

    if (!currentLogs.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📝</div>
                <div>暂无日志记录</div>
            </div>
        `;
        return;
    }

    container.innerHTML = currentLogs.map((log, index) => {
        const detailsHtml = log.details
            ? `<div class="log-details">${JSON.stringify(log.details, null, 2)}</div>`
            : '';

        return `
            <div class="log-entry ${log.level}">
                <div class="log-header">
                    <span class="log-level ${log.level}">${log.level}</span>
                    <span class="log-header-right">
                        <span class="log-time">${formatTime(log.timestamp)}</span>
                        <button class="copy-btn" data-index="${index}" title="复制这条日志">复制</button>
                    </span>
                </div>
                <div class="log-message">${log.message}</div>
                ${detailsHtml}
            </div>
        `;
    }).join('');

    container.querySelectorAll('.copy-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const log = currentLogs[Number(btn.dataset.index)];
            if (!log) return;
            const ok = await copyText(logToText(log));
            flashCopied(btn, ok ? '已复制' : '复制失败');
        });
    });
}

// 加载日志
async function loadLogs() {
    chrome.runtime.sendMessage({ action: 'getLogs' }, (response) => {
        if (response && response.success) {
            renderLogs(response.logs);
        } else {
            document.getElementById('logsContainer').innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">❌</div>
                    <div>加载日志失败</div>
                </div>
            `;
        }
    });
}

// 清空日志
async function clearLogs() {
    if (!confirm('确定要清空所有日志吗？')) {
        return;
    }

    chrome.runtime.sendMessage({ action: 'clearLogs' }, (response) => {
        if (response && response.success) {
            loadLogs();
        }
    });
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    loadLogs();

    // 刷新按钮
    document.getElementById('refreshBtn').addEventListener('click', loadLogs);

    // 复制全部按钮
    document.getElementById('copyAllBtn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (!currentLogs.length) {
            flashCopied(btn, '暂无日志');
            return;
        }
        const text = currentLogs.map(logToText).join('\n\n');
        const ok = await copyText(text);
        flashCopied(btn, ok ? `已复制 ${currentLogs.length} 条` : '复制失败');
    });

    // 清空按钮
    document.getElementById('clearBtn').addEventListener('click', clearLogs);

    // 返回按钮
    document.getElementById('backBtn').addEventListener('click', () => {
        window.location.href = 'popup.html';
    });

    // 自动刷新（每5秒）
    setInterval(loadLogs, 5000);
});
