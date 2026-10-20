import {m} from 'malevic';
import {sync} from 'malevic/dom';

import type {ExtensionData} from '../../definitions';
import {isFirefox} from '../../utils/platform';
import {isURLEnabled} from '../../utils/url';
import Connector from '../connect/connector';
import {MultiSwitch} from '../controls';
import AIPage from '../popup/ai-page';

/**
 * 侧边栏入口。
 *
 * 与 popup 的区别：
 * - 常驻，不会因为用户去点击页面元素而销毁
 * - 高度是整屏，布局需要自适应
 * - 需要跟随当前活动标签页变化
 *
 * 目前只承载 AI 面板；完整设置通过「设置」按钮跳到 options 页面。
 */

declare const __CHROMIUM_MV3__: boolean;

interface SidePanelStore {
    data: ExtensionData | null;
    actions: Connector | null;
    error: string | null;
    /** 当前站点使用的配色来源；null = 尚未读取 */
    siteMode: 'ai' | 'default' | null;
    /** 当前站点是否已生成 AI 方案 */
    hasScheme: boolean;
    /** 切换配色来源进行中 */
    switching: boolean;
}

/** 配色来源的两个选项，顺序与 SiteMode 对应 */
const MODE_LABELS = ['AI 方案', '默认深色'];

function modeLabel(mode: 'ai' | 'default' | null): string {
    return mode === 'default' ? MODE_LABELS[1] : MODE_LABELS[0];
}

/** 从 URL 提取干净的站点显示名（去协议，截断路径） */
function siteLabel(url: string | undefined | null): string {
    if (!url) {
        return '(无地址)';
    }
    try {
        const u = new URL(url);
        const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
        return `${u.hostname}${path}`.slice(0, 60);
    } catch (err) {
        return url.slice(0, 60);
    }
}

function renderRoot(store: SidePanelStore, onRefresh: () => void): Malevic.Spec {
    // 根节点必须是 <body>：malevic 的 sync(document.body, spec) 要求 spec 本身
    // 就是那个节点（popup 的 Body 组件也是这么返回的）。
    if (store.error) {
        return (
            <body class="sidepanel-body">
                <div class="sidepanel sidepanel--error">
                    <div class="sidepanel__glyph">✕</div>
                    <div class="sidepanel__error">{store.error}</div>
                    <button class="sidepanel__retry" onclick={() => location.reload()}>重新加载</button>
                </div>
            </body>
        );
    }

    if (!store.data || !store.actions) {
        return (
            <body class="sidepanel-body">
                <div class="sidepanel sidepanel--loading">
                    <div class="sidepanel__spinner"></div>
                    <div class="sidepanel__loading">载入中…</div>
                </div>
            </body>
        );
    }

    const tab = store.data.activeTab;
    const settings = store.data.settings;
    const isGloballyOn = store.data.isEnabled;
    const isSiteOn = tab
        ? isURLEnabled(tab.url, settings, tab, store.data.isAllowedFileSchemeAccess)
        : false;

    /** 全局开关：同时关掉自动化，避免被时间/位置规则立刻改回去 */
    function toggleGlobal(next: boolean) {
        store.actions!.changeSettings({
            enabled: next,
            automation: {...settings.automation, enabled: false},
        });
    }

    /** 当前站点开关 */
    function toggleSite() {
        store.actions!.toggleActiveTab();
    }

    /** 切换本站配色来源：AI 方案 / Dark Reader 默认深色 */
    function switchSchemeSource(label: string) {
        if (!tab || store.switching) {
            return;
        }
        const nextMode: 'ai' | 'default' = label === MODE_LABELS[0] ? 'ai' : 'default';
        if (nextMode === store.siteMode) {
            return;
        }
        store.switching = true;
        store.siteMode = nextMode;
        onRefresh();
        sendMessage('ui-bg-ai-set-site-mode', {tabId: tab.id, mode: nextMode}).then((response) => {
            store.switching = false;
            if (!response || response.error) {
                // 失败时回滚显示
                store.siteMode = nextMode === 'ai' ? 'default' : 'ai';
            }
            onRefresh();
        });
    }

    return (
        <body class="sidepanel-body">
            <div class="sidepanel">
                <header class="sidepanel__header">
                    <div class="sidepanel__title-row">
                        <span class="sidepanel__logo">
                            <svg viewBox="0 0 16 16" class="sidepanel__logo-icon">
                                <path d="M8,2.2 L9.1,6.2 L13.1,7.3 L9.1,8.4 L8,12.4 L6.9,8.4 L2.9,7.3 L6.9,6.2 Z" fill="currentColor"/>
                            </svg>
                            Dark Reader
                        </span>
                        <span class="sidepanel__badge">AI</span>
                    </div>
                    {tab ?
                        <span class="sidepanel__site" title={tab.url}>
                            <span class="sidepanel__site-dot"></span>
                            {siteLabel(tab.url)}
                        </span>
                        : <span class="sidepanel__site sidepanel__site--none">未打开网页</span>}

                    <div class="sidepanel__controls">
                        <div class="sidepanel__control">
                            <span class="sidepanel__control-label">扩展</span>
                            <MultiSwitch
                                class="sidepanel__switch"
                                options={['开启', '关闭']}
                                value={isGloballyOn ? '开启' : '关闭'}
                                onChange={(value) => toggleGlobal(value === '开启')}
                            />
                        </div>
                        {tab ?
                            <div class="sidepanel__control">
                                <span class="sidepanel__control-label">本站</span>
                                <button
                                    class={{
                                        'sidepanel__site-toggle': true,
                                        'sidepanel__site-toggle--on': isSiteOn,
                                        'sidepanel__site-toggle--off': !isSiteOn,
                                    }}
                                    onclick={toggleSite}
                                >
                                    {isSiteOn ? '已开启' : '已关闭'}
                                </button>
                            </div>
                            : null}
                    </div>

                    {tab ?
                        <div class="sidepanel__controls">
                            <div class="sidepanel__control sidepanel__control--wide">
                                <span class="sidepanel__control-label">配色</span>
                                <MultiSwitch
                                    class="sidepanel__switch"
                                    options={MODE_LABELS}
                                    value={modeLabel(store.siteMode)}
                                    onChange={(value) => switchSchemeSource(value)}
                                />
                            </div>
                        </div>
                        : null}
                </header>
                <main class="sidepanel__body">
                    {tab ?
                        <AIPage data={store.data} actions={store.actions} />
                        : <div class="sidepanel__empty">
                            <div class="sidepanel__empty-icon">🌐</div>
                            <div>切换到一个网页标签页<br/>即可使用 AI 定制深色方案</div>
                          </div>}
                </main>
                <footer class="sidepanel__footer">
                    <button
                        class="sidepanel__link"
                        onclick={() => chrome.tabs.create({url: chrome.runtime.getURL('/ui/options/index.html')})}
                    >
                        完整设置
                    </button>
                    <button
                        class="sidepanel__link sidepanel__link--ghost"
                        onclick={() => {
                            store.data = null;
                            onRefresh();
                            void refreshData(store, onRefresh);
                        }}
                    >
                        刷新
                    </button>
                </footer>
            </div>
        </body>
    );
}

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

async function refreshData(store: SidePanelStore, onRefresh: () => void): Promise<void> {
    try {
        if (!store.actions) {
            store.actions = new Connector();
        }
        const data = await store.actions.getData();
        store.data = data;
        store.error = null;

        // 顺带取当前站点的方案状态（用于配色来源切换按钮）
        const tabId = data.activeTab ? data.activeTab.id : null;
        if (tabId != null) {
            const resp = await sendMessage('ui-bg-ai-get-scheme-status', {tabId});
            const s = resp && resp.data;
            if (s) {
                store.hasScheme = Boolean(s.hasScheme);
                // 未显式设置过则跟随全局：有方案时按 AI，无方案时按默认
                store.siteMode = s.siteMode || (s.hasScheme ? 'ai' : 'default');
            } else {
                store.hasScheme = false;
                store.siteMode = 'default';
            }
        } else {
            store.hasScheme = false;
            store.siteMode = null;
        }
    } catch (err: any) {
        store.error = `无法读取数据：${err?.message ?? String(err)}`;
    }
    onRefresh();
}

function start(): void {
    // Connector 必须同步创建：下面要立刻用它订阅设置变化，
    // 若延后到 refreshData 里创建，订阅会因 actions 尚为 null 而被跳过
    const store: SidePanelStore = {
        data: null,
        actions: new Connector(),
        error: null,
        siteMode: null,
        hasScheme: false,
        switching: false,
    };
    const root = document.body;

    const onRefresh = () => {
        sync(root, renderRoot(store, onRefresh));
    };

    // 首次渲染
    onRefresh();
    void refreshData(store, onRefresh);

    // 活动标签页变化时刷新（侧边栏跨越标签页存在）
    chrome.tabs.onActivated.addListener(() => {
        void refreshData(store, onRefresh);
    });
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
        if (changeInfo.status === 'complete' && tab.active) {
            void refreshData(store, onRefresh);
        }
    });

    // 设置变化时刷新
    const connector = store.actions;
    if (connector) {
        connector.subscribeToChanges((data) => {
            store.data = data;
            onRefresh();
        });
    }

    window.addEventListener('unload', () => {
        if (store.actions) {
            store.actions.disconnect();
        }
    });
}

document.documentElement.classList.toggle('firefox', isFirefox);
document.documentElement.classList.toggle('sidepanel-root', true);

start();
