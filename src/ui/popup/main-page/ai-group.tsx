import {m} from 'malevic';
import {getContext} from 'malevic/dom';

import type {ViewProps} from '../../../definitions';
import {CopyButton} from '../../controls';

/**
 * popup 里的 AI 定制区块。
 *
 * 交互刻意保持简单：
 * - 未生成 -> 一个按钮「为本站生成深色方案」
 * - 生成中 -> 显示进度，禁用按钮
 * - 已生成 -> 显示时间 + 「重新生成」「移除」两个次要动作
 */

function sendMessage(type: string, data?: any): Promise<any> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({type, data}, (response) => {
            if (chrome.runtime.lastError) {
                resolve({error: chrome.runtime.lastError.message});
                return;
            }
            resolve(response);
        });
    });
}

type Status =
    | {kind: 'loading'}
    | {kind: 'idle'}
    | {kind: 'working'}
    | {kind: 'ready'; createdAt: number; reason: string}
    | {kind: 'error'; message: string};

interface Store {
    status: Status;
    started: boolean;
}

function formatTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 组装可复制的错误报告。
 *
 * 目标：贴给开发者就能定位问题，所以带上环境上下文，
 * 但不包含网页正文、API Key 等敏感信息。
 */
function buildErrorReport(message: string, props: ViewProps): string {
    const data = props.data;
    const tab = data.activeTab;
    const theme = data.settings.theme;
    const lines: string[] = [];

    lines.push('=== Dark Reader AI 错误报告 ===');
    lines.push(`时间: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('[错误信息]');
    lines.push(message || '(空)');
    lines.push('');
    lines.push('[环境]');
    lines.push(`扩展版本: ${chrome.runtime.getManifest().version}`);
    lines.push(`界面: 旧版 popup`);
    try {
        lines.push(`平台: ${navigator.platform}`);
        lines.push(`UA: ${navigator.userAgent}`);
    } catch (err) {
        // 忽略
    }
    lines.push('');
    lines.push('[当前页面]');
    if (tab) {
        lines.push(`URL: ${tab.url || '(未知)'}`);
        lines.push(`受保护: ${tab.isProtected ? '是' : '否'}`);
        lines.push(`已注入: ${tab.isInjected ? '是' : '否'}`);
        lines.push(`暗色列表: ${tab.isInDarkList ? '是' : '否'}`);
    } else {
        lines.push('(无活动标签页)');
    }
    lines.push('');
    lines.push('[主题设置]');
    if (theme) {
        lines.push(`引擎: ${theme.engine}`);
        lines.push(`模式: ${theme.mode === 1 ? '暗色' : '暗化'}`);
        lines.push(`亮度/对比度/棕褐: ${theme.brightness}/${theme.contrast}/${theme.sepia}`);
        lines.push(`背景/文字: ${theme.darkSchemeBackgroundColor} / ${theme.darkSchemeTextColor}`);
    }
    lines.push('');
    lines.push('[说明] 本报告不包含网页正文与 API Key。');

    return lines.join('\n');
}

export default function AIGroup(props: ViewProps): Malevic.Child {
    const context = getContext();
    const store = context.getStore<Store>({status: {kind: 'loading'}, started: false});

    const tabId = props.data.activeTab ? props.data.activeTab.id : null;

    function loadStatus() {
        if (tabId == null) {
            store.status = {kind: 'idle'};
            context.refresh();
            return;
        }
        sendMessage('ui-bg-ai-get-scheme-status', {tabId}).then((response) => {
            const s = response && response.data;
            if (s && s.hasScheme) {
                store.status = {kind: 'ready', createdAt: s.createdAt, reason: s.reason};
            } else {
                store.status = {kind: 'idle'};
            }
            context.refresh();
        });
    }

    if (!store.started) {
        store.started = true;
        loadStatus();
    }

    function generate() {
        if (tabId == null) {
            return;
        }
        store.status = {kind: 'working'};
        context.refresh();
        sendMessage('ui-bg-ai-generate-scheme', {tabId}).then((response) => {
            const r = response && response.data;
            if (!response) {
                store.status = {kind: 'error', message: '后台无响应，请重新加载扩展'};
            } else if (response.error) {
                store.status = {kind: 'error', message: response.error};
            } else if (r && r.ok) {
                store.status = {kind: 'ready', createdAt: Date.now(), reason: r.reason || ''};
            } else {
                store.status = {kind: 'error', message: (r && r.error) || '未知错误'};
            }
            context.refresh();
        });
    }

    function clear() {
        if (tabId == null) {
            return;
        }
        store.status = {kind: 'working'};
        context.refresh();
        sendMessage('ui-bg-ai-clear-scheme', {tabId}).then(() => {
            store.status = {kind: 'idle'};
            context.refresh();
        });
    }

    const status = store.status;

    if (status.kind === 'loading') {
        return (
            <div class="ai-group">
                <div class="ai-group__title">AI 定制</div>
                <div class="ai-group__hint">读取中…</div>
            </div>
        );
    }

    if (status.kind === 'working') {
        return (
            <div class="ai-group">
                <div class="ai-group__title">AI 定制</div>
                <div class="ai-group__hint">正在分析页面并生成方案…</div>
            </div>
        );
    }

    if (status.kind === 'error') {
        return (
            <div class="ai-group">
                <div class="ai-group__title">AI 定制</div>
                <div class="ai-group__error">{status.message}</div>
                <div class="ai-group__actions">
                    <button class="ai-group__button ai-group__button--secondary" onclick={generate}>重试</button>
                    <CopyButton
                        class="ai-group__copy"
                        getText={() => buildErrorReport(status.message, props)}
                    />
                </div>
            </div>
        );
    }

    if (status.kind === 'ready') {
        return (
            <div class="ai-group">
                <div class="ai-group__title">AI 定制</div>
                <div class="ai-group__hint">已应用 · {formatTime(status.createdAt)}</div>
                {status.reason ? <div class="ai-group__reason">{status.reason}</div> : null}
                <div class="ai-group__actions">
                    <button class="ai-group__button ai-group__button--secondary" onclick={generate}>重新生成</button>
                    <button class="ai-group__button ai-group__button--secondary" onclick={clear}>移除</button>
                </div>
            </div>
        );
    }

    return (
        <div class="ai-group">
            <div class="ai-group__title">AI 定制</div>
            <div class="ai-group__hint">让 AI 为本站生成专属深色方案</div>
            <button class="ai-group__button" onclick={generate}>生成方案</button>
        </div>
    );
}
