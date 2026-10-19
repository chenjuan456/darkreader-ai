import {m} from 'malevic';
import {getContext} from 'malevic/dom';

import type {ViewProps} from '../../../definitions';
import {CopyButton} from '../../controls';

/**
 * popup 里独立的 AI 页面。
 *
 * 与塞在筛选页底部的版本不同，这里占满整个 tab 区域，
 * 内容可滚动，能完整展示配色方案、AI 理由、修复规则摘要。
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

interface SchemeDetail {
    theme?: {
        darkSchemeBackgroundColor?: string;
        darkSchemeTextColor?: string;
        brightness?: number;
        contrast?: number;
        sepia?: number;
    };
    fixes?: {
        invert?: string[];
        css?: string;
        ignoreInlineStyle?: string[];
        ignoreImageAnalysis?: string[];
    };
    reason?: string;
    createdAt?: number;
    model?: string;
}

type Status =
    | {kind: 'loading'}
    | {kind: 'idle'}
    | {kind: 'working'}
    | {kind: 'ready'; detail: SchemeDetail}
    | {kind: 'error'; message: string};

interface Store {
    status: Status;
    started: boolean;
    /** 上次加载对应的标签页 id，用于感知侧边栏里的标签页切换 */
    lastTabId: number | null;
    showCSS: boolean;
    /** 待修复的元素（已拾取，等待提交） */
    pending: Array<{selector: string; tag: string; background: string; color: string; note: string; textPreview: string}>;
    /** 正在拾取 */
    picking: boolean;
    /** 修复进行中 */
    refining: boolean;
    /** 拾取/修复的提示信息 */
    pickError: string | null;
}

function formatTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
    lines.push(`界面: AI 页面`);
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
    }
    lines.push('');
    lines.push('[说明] 本报告不包含网页正文与 API Key。');
    return lines.join('\n');
}

export default function AIPage(props: ViewProps): Malevic.Child {
    const context = getContext();
    const store = context.getStore<Store>({
        status: {kind: 'loading'},
        started: false,
        lastTabId: null,
        showCSS: false,
        pending: [],
        picking: false,
        refining: false,
        pickError: null,
    });

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
                store.status = {kind: 'ready', detail: s.scheme || {reason: s.reason, createdAt: s.createdAt}};
            } else {
                store.status = {kind: 'idle'};
            }
            context.refresh();
        });
    }

    // 侧边栏是常驻的，切换标签页时组件不会重建，
    // 所以必须自己感知 tabId 变化并重新加载，否则会一直显示上一个标签页的状态。
    if (!store.started || store.lastTabId !== tabId) {
        store.started = true;
        store.lastTabId = tabId;
        store.pending = [];
        store.pickError = null;
        store.showCSS = false;
        loadStatus();
        // 恢复上次拾取但未提交的元素（popup 关闭后重开的情况）
        reloadPending();
    }

    function generate() {
        if (tabId == null) {
            return;
        }
        store.status = {kind: 'working'};
        store.showCSS = false;
        context.refresh();
        sendMessage('ui-bg-ai-generate-scheme', {tabId}).then((response) => {
            const r = response && response.data;
            if (!response) {
                store.status = {kind: 'error', message: '后台无响应，请重新加载扩展'};
            } else if (response.error) {
                store.status = {kind: 'error', message: response.error};
            } else if (r && r.ok) {
                loadStatus();
                return;
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
            store.showCSS = false;
            context.refresh();
        });
    }

    const status = store.status;

    /** 启动页面元素拾取 */
    function pickElement() {
        if (tabId == null || store.picking) {
            return;
        }
        store.picking = true;
        store.pickError = null;
        context.refresh();

        // 注意：点下之后 popup 很快会因失焦而关闭，
        // 拾取结果由 background 写入 storage.session，
        // 下次打开 popup 时会通过 loadPending 恢复。
        sendMessage('ui-bg-ai-pick-element', {tabId}).then((response) => {
            // 若 popup 还活着（比如点的是 iframe 内部），就地更新
            store.picking = false;
            const r = response && response.data;
            if (!response) {
                store.pickError = '后台无响应';
            } else if (response.error) {
                store.pickError = response.error;
            } else if (r && r.ok && r.element) {
                const el = r.element;
                const exists = store.pending.some((p) => p.selector === el.selector);
                if (!exists) {
                    store.pending = [...store.pending, {
                        selector: el.selector,
                        tag: el.tag,
                        background: el.background,
                        color: el.color,
                        textPreview: el.textPreview || '',
                        note: '',
                    }];
                }
            } else {
                store.pickError = (r && r.error) || '未选中元素';
            }
            context.refresh();
        });
    }

    /** 从 storage 恢复上次拾取的元素 */
    function reloadPending() {
        if (tabId == null) {
            return;
        }
        sendMessage('ui-bg-ai-get-pending', {tabId}).then((response) => {
            const list = response && response.data;
            if (Array.isArray(list) && list.length > 0) {
                store.pending = list.map((p: any) => ({
                    selector: p.selector,
                    tag: p.tag,
                    background: p.background,
                    color: p.color,
                    textPreview: p.textPreview || '',
                    note: p.note || '',
                }));
                context.refresh();
            }
        });
    }

    function removePending(index: number) {
        store.pending = store.pending.filter((_, i) => i !== index);
        if (store.pending.length === 0) {
            sendMessage('ui-bg-ai-clear-pending');
        }
        context.refresh();
    }

    function updateNote(index: number, note: string) {
        store.pending = store.pending.map((p, i) => (i === index ? {...p, note} : p));
        context.refresh();
    }

    /** 提交反馈，触发增量修复 */
    function applyFeedback() {
        if (tabId == null || store.pending.length === 0 || store.refining) {
            return;
        }
        store.refining = true;
        store.pickError = null;
        context.refresh();

        const feedbacks = store.pending.map((p) => ({
            selector: p.selector,
            tag: p.tag,
            background: p.background,
            color: p.color,
            borderColor: '',
            width: 0,
            height: 0,
            textPreview: p.textPreview,
            note: p.note,
        }));

        sendMessage('ui-bg-ai-refine-scheme', {tabId, feedbacks}).then((response) => {
            store.refining = false;
            const r = response && response.data;
            if (!response) {
                store.pickError = '后台无响应';
            } else if (response.error) {
                store.pickError = response.error;
            } else if (r && r.ok) {
                store.pending = [];
                // 清掉持久化的待修复列表
                sendMessage('ui-bg-ai-clear-pending');
                loadStatus();
                return;
            } else {
                store.pickError = (r && r.error) || '修复失败';
            }
            context.refresh();
        });
    }

    if (status.kind === 'loading') {
        return (
            <div class="ai-page">
                <div class="ai-page__scroll">
                    <div class="ai-page__hint">读取中…</div>
                </div>
            </div>
        );
    }

    if (status.kind === 'working') {
        return (
            <div class="ai-page">
                <div class="ai-page__scroll">
                    <div class="ai-page__hint">正在分析页面并生成方案…</div>
                    <div class="ai-page__hint ai-page__hint--dim">这通常需要 5–20 秒</div>
                </div>
            </div>
        );
    }

    if (status.kind === 'error') {
        return (
            <div class="ai-page">
                <div class="ai-page__scroll">
                    <div class="ai-page__error">{status.message}</div>
                    <div class="ai-page__actions">
                        <button class="ai-page__button ai-page__button--secondary" onclick={generate}>重试</button>
                        <CopyButton
                            class="ai-page__copy"
                            getText={() => buildErrorReport(status.message, props)}
                        />
                    </div>
                </div>
            </div>
        );
    }

    if (status.kind === 'ready') {
        const d = status.detail || {};
        const th = d.theme || {};
        const fx = d.fixes || {};
        const invertCount = (fx.invert || []).length;
        const ignoreCount = (fx.ignoreInlineStyle || []).length + (fx.ignoreImageAnalysis || []).length;
        const css = fx.css || '';

        return (
            <div class="ai-page">
                <div class="ai-page__scroll">
                    <div class="ai-page__section">
                        <div class="ai-page__label">状态</div>
                        <div class="ai-page__value ai-page__value--ok">
                            已应用{d.createdAt ? ` · ${formatTime(d.createdAt)}` : ''}
                        </div>
                        {d.model ? <div class="ai-page__meta">模型：{d.model}</div> : null}
                    </div>

                    {d.reason ?
                        <div class="ai-page__section">
                            <div class="ai-page__label">AI 分析</div>
                            <div class="ai-page__reason">{d.reason}</div>
                        </div> : null}

                    <div class="ai-page__section">
                        <div class="ai-page__label">配色</div>
                        <div class="ai-page__swatches">
                            <div class="ai-page__swatch">
                                <span class="ai-page__swatch-color" style={{'background-color': th.darkSchemeBackgroundColor || '#181a1b'}} />
                                <span class="ai-page__swatch-text">背景 · {th.darkSchemeBackgroundColor || '默认'}</span>
                            </div>
                            <div class="ai-page__swatch">
                                <span class="ai-page__swatch-color" style={{'background-color': th.darkSchemeTextColor || '#e8e6e3'}} />
                                <span class="ai-page__swatch-text">文字 · {th.darkSchemeTextColor || '默认'}</span>
                            </div>
                        </div>
                        <div class="ai-page__meta">
                            {`亮度 ${th.brightness ?? 100} · 对比度 ${th.contrast ?? 100} · 棕褐 ${th.sepia ?? 0}`}
                        </div>
                    </div>

                    <div class="ai-page__section">
                        <div class="ai-page__label">修复规则</div>
                        <div class="ai-page__meta">{`反色元素 ${invertCount} 个 · 忽略规则 ${ignoreCount} 条`}</div>
                        {css ?
                            <div class="ai-page__css-wrap">
                                <button
                                    class="ai-page__toggle"
                                    onclick={() => { store.showCSS = !store.showCSS; context.refresh(); }}
                                >
                                    {store.showCSS ? '收起自定义 CSS' : `展开自定义 CSS（${css.length} 字符）`}
                                </button>
                                {store.showCSS ? <pre class="ai-page__css">{css}</pre> : null}
                            </div>
                            : <div class="ai-page__meta ai-page__meta--dim">无自定义 CSS</div>}
                    </div>

                    <div class="ai-page__section">
                        <div class="ai-page__label">指出问题</div>
                        <div class="ai-page__notice">
                            页面某处仍然是亮的或看不清？点「选取问题元素」，
                            然后在页面上点击那个元素。这个面板会自动关闭（浏览器限制），
                            点完后再回到这里提交修复。
                        </div>

                        {store.pending.length > 0 ?
                            <div class="ai-page__pending-list">
                                {store.pending.map((p, i) => (
                                    <div class="ai-page__pending">
                                        <div class="ai-page__pending-head">
                                            <code class="ai-page__pending-sel">{p.selector}</code>
                                            <button class="ai-page__pending-del" onclick={() => removePending(i)}>×</button>
                                        </div>
                                        <div class="ai-page__pending-meta">
                                            {`背景 ${p.background} · 文字 ${p.color}`}
                                            {p.textPreview ? ` · "${p.textPreview}"` : ''}
                                        </div>
                                        <input
                                            class="ai-page__pending-note"
                                            placeholder="可选：描述问题，如「这里还是白底」"
                                            value={p.note}
                                            oninput={(e: any) => updateNote(i, e.target.value)}
                                        />
                                    </div>
                                ))}
                            </div>
                            : null}

                        {store.pickError ? <div class="ai-page__error">{store.pickError}</div> : null}

                        <div class="ai-page__actions">
                            <button
                                class="ai-page__button ai-page__button--secondary"
                                disabled={store.picking || store.refining}
                                onclick={pickElement}
                            >
                                {store.picking ? '请在页面上点击…' : '+ 选取问题元素'}
                            </button>
                            {store.pending.length > 0 ?
                                <button
                                    class="ai-page__button"
                                    disabled={store.refining}
                                    onclick={applyFeedback}
                                >
                                    {store.refining ? '修复中…' : `修复这 ${store.pending.length} 处`}
                                </button>
                                : null}
                        </div>

                        {store.picking ?
                            <div class="ai-page__hint ai-page__hint--dim">
                                正在等待你在页面上点击元素…（按 Esc 取消）
                            </div>
                            : null}
                        {store.refining ?
                            <div class="ai-page__hint ai-page__hint--dim">正在生成针对性修复…</div>
                            : null}
                    </div>

                    <div class="ai-page__actions">
                        <button class="ai-page__button" onclick={generate}>重新生成</button>
                        <button class="ai-page__button ai-page__button--secondary" onclick={clear}>移除方案</button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div class="ai-page">
            <div class="ai-page__scroll">
                <div class="ai-page__section">
                    <div class="ai-page__label">AI 定制</div>
                    <div class="ai-page__hint">让 AI 分析当前网站，生成专属的深色配色与修复规则。</div>
                    <div class="ai-page__hint ai-page__hint--dim">
                        生成的方案会缓存，下次访问该站点自动生效。
                    </div>
                    <div class="ai-page__actions">
                        <button class="ai-page__button" onclick={generate}>生成方案</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
