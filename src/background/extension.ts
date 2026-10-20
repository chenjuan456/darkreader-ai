import type {ExtensionData, Theme, Shortcuts, UserSettings, TabInfo, TabData, Command, DevToolsData, DynamicThemeFix} from '../definitions';
import * as AIClient from '../ai/client';
import {collectDigestInPage} from '../ai/collect-in-page';
import * as AIGenerate from '../ai/generate';
import * as AIPending from '../ai/pending';
import {startElementPicker} from '../ai/picker';
import type {AIScheme} from '../ai/scheme';
import * as AISettingsStore from '../ai/settings';
import * as AIStore from '../ai/store';
import createCSSFilterStylesheet from '../generators/css-filter';
import {getDetectorHintsFor} from '../generators/detector-hints';
import {getDynamicThemeFixesFor} from '../generators/dynamic-theme';
import createStaticStylesheet from '../generators/static-theme';
import {createSVGFilterStylesheet, getSVGFilterMatrixValue, getSVGReverseFilterMatrixValue} from '../generators/svg-filter';
import {ThemeEngine} from '../generators/theme-engines';
import {AutomationMode} from '../utils/automation';
import {debounce} from '../utils/debounce';
import {isSystemDarkModeEnabled, runColorSchemeChangeDetector} from '../utils/media-query';
import {MessageTypeBGtoCS} from '../utils/message';
import {isFirefox} from '../utils/platform';
import {PromiseBarrier} from '../utils/promise-barrier';
import {StateManager} from '../utils/state-manager';
import {getActiveTab} from '../utils/tabs';
import {isInTimeIntervalLocal, nextTimeInterval, isNightAtLocation, nextTimeChangeAtLocation, getDuration} from '../utils/time';
import {isURLInList, getURLHostOrProtocol, isURLEnabled, isPDF} from '../utils/url';

import ConfigManager from './config-manager';
import DevTools from './devtools';
import IconManager from './icon-manager';
import type {ExtensionAdapter} from './messenger';
import Messenger from './messenger';
import Newsmaker from './newsmaker';
import TabManager from './tab-manager';
import UIHighlights from './ui-highlights';
import UserStorage from './user-storage';
import {getCommands, canInjectScript, writeLocalStorage, removeLocalStorage} from './utils/extension-api';
import {logInfo, logWarn} from './utils/log';
import {setWindowTheme, resetWindowTheme} from './window-theme';


type AutomationState = 'turn-on' | 'turn-off' | 'scheme-dark' | 'scheme-light' | '';

interface ExtensionState extends Record<string, unknown> {
    autoState: AutomationState;
    wasEnabledOnLastCheck: boolean | null;
    registeredContextMenus: boolean | null;
}

interface SystemColorState extends Record<string, unknown> {
    wasLastColorSchemeDark: boolean | null;
}

declare const __CHROMIUM_MV2__: boolean;
declare const __CHROMIUM_MV3__: boolean;
declare const __PLUS__: boolean;
declare const __THUNDERBIRD__: boolean;

export class Extension {
    private static autoState: AutomationState = '';
    private static wasEnabledOnLastCheck: boolean | null = null;
    private static registeredContextMenus: boolean | null = null;
    /**
     * This value is used for two purposes:
     *  - to bypass Firefox bug
     *  - to filter out excessive Extension.onColorSchemeChange() invocations
     */
    private static wasLastColorSchemeDark: boolean | null = null;
    private static startBarrier: PromiseBarrier<void, void> | null = null;
    private static stateManager: StateManager<ExtensionState> | null = null;

    private static readonly AUTOMATION_ALARM_NAME = 'auto-time-alarm';
    private static readonly WAKEUP_ALARM_NAME = 'wakeup-alarm';
    private static readonly LOCAL_STORAGE_KEY = 'Extension-state';

    // Store system color theme
    private static readonly SYSTEM_COLOR_LOCAL_STORAGE_KEY = 'system-color-state';
    private static systemColorStateManager: StateManager<SystemColorState>;

    // Record whether Extension.init() already ran since the last GB start
    private static initialized = false;

    static isFirstLoad = false;

    // This sync initializer needs to run on every BG restart before anything else can happen
    private static init() {
        if (Extension.initialized) {
            return;
        }
        Extension.initialized = true;

        Messenger.init(Extension.getMessengerAdapter());
        TabManager.init({
            getConnectionMessage: Extension.getConnectionMessage,
            getTabMessage: Extension.getTabMessage,
            onColorSchemeChange: Extension.onColorSchemeChange,
            waitUntilReady: Extension.waitUntilReady,
        });

        Extension.startBarrier = new PromiseBarrier();
        Extension.stateManager = new StateManager<ExtensionState>(Extension.LOCAL_STORAGE_KEY, Extension, {
            autoState: '',
            wasEnabledOnLastCheck: null,
            registeredContextMenus: null,
        }, logWarn);

        chrome.alarms.onAlarm.addListener(Extension.alarmListener);

        if (chrome.commands) {
            // Firefox Android does not support chrome.commands
            if (isFirefox) {
                // Firefox may not register onCommand listener on extension startup so we need to use setTimeout
                setTimeout(() => chrome.commands.onCommand.addListener(async (command) => Extension.onCommand(command as Command, null, null, null)));
            } else {
                chrome.commands.onCommand.addListener(async (command, tab) => Extension.onCommand(command as Command, tab && tab.id! || null, 0, null));
            }
        }

        if (chrome.permissions.onRemoved) {
            chrome.permissions.onRemoved.addListener((permissions) => {
                // As far as we know, this code is never actually run because there
                // is no browser UI for removing 'contextMenus' permission.
                // This code exists for future-proofing in case browsers ever add such UI.
                if (!permissions?.permissions?.includes('contextMenus')) {
                    Extension.registeredContextMenus = false;
                }
            });
        }
    }

    private static async MV3syncSystemColorStateManager(isDark: boolean | null): Promise<void> {
        if (!__CHROMIUM_MV3__) {
            return;
        }
        if (!Extension.systemColorStateManager) {
            Extension.systemColorStateManager = new StateManager<SystemColorState>(Extension.SYSTEM_COLOR_LOCAL_STORAGE_KEY, Extension, {
                wasLastColorSchemeDark: isDark,
            }, logWarn);
        }
        if (isDark === null) {
            // Attempt to restore data from storage
            return Extension.systemColorStateManager.loadState();
        }
        Extension.wasLastColorSchemeDark = isDark;
        return Extension.systemColorStateManager.saveState();
    }

    private static alarmListener = async (alarm: chrome.alarms.Alarm): Promise<void> => {
        if (
            alarm.name === Extension.AUTOMATION_ALARM_NAME || (
                alarm.name === Extension.WAKEUP_ALARM_NAME &&
                (Date.now() - alarm.scheduledTime > getDuration({seconds: 30}))
            )
        ) {
            await Extension.waitUntilReady();
            await Extension.loadData();
            Extension.handleAutomationCheck();
        }
    };

    private static isExtensionSwitchedOn() {
        return (
            Extension.autoState === 'turn-on' ||
            Extension.autoState === 'scheme-dark' ||
            Extension.autoState === 'scheme-light' ||
            (Extension.autoState === '' && UserStorage.settings.enabled)
        );
    }

    private static updateAutoState() {
        const {mode, behavior, enabled} = UserStorage.settings.automation;

        let isAutoDark: boolean | null | undefined;
        let nextCheck: number | null | undefined;
        switch (mode) {
            case AutomationMode.TIME: {
                const {time} = UserStorage.settings;
                isAutoDark = isInTimeIntervalLocal(time.activation, time.deactivation);
                nextCheck = nextTimeInterval(time.activation, time.deactivation);
                break;
            }
            case AutomationMode.SYSTEM:
                if (__CHROMIUM_MV3__) {
                    isAutoDark = Extension.wasLastColorSchemeDark;
                    if (Extension.wasLastColorSchemeDark === null) {
                        logWarn('System color scheme is unknown. Defaulting to Dark.');
                        isAutoDark = true;
                    }
                    break;
                }
                isAutoDark = Extension.wasLastColorSchemeDark === null
                    ? isSystemDarkModeEnabled()
                    : Extension.wasLastColorSchemeDark;
                if (isFirefox) {
                    runColorSchemeChangeDetector(Extension.onColorSchemeChange);
                }
                break;
            case AutomationMode.LOCATION: {
                const {latitude, longitude} = UserStorage.settings.location;
                if (latitude != null && longitude != null) {
                    isAutoDark = isNightAtLocation(latitude, longitude);
                    nextCheck = nextTimeChangeAtLocation(latitude, longitude);
                }
                break;
            }
            case AutomationMode.NONE:
                break;
        }

        let state: AutomationState = '';
        if (enabled) {
            if (behavior === 'OnOff') {
                state = isAutoDark ? 'turn-on' : 'turn-off';
            } else if (behavior === 'Scheme') {
                state = isAutoDark ? 'scheme-dark' : 'scheme-light';
            }
        }
        Extension.autoState = state;

        if (nextCheck) {
            if (nextCheck < Date.now()) {
                logWarn(`Alarm is set in the past: ${nextCheck}. The time is: ${new Date()}. ISO: ${(new Date()).toISOString()}`);
            } else {
                chrome.alarms.create(Extension.AUTOMATION_ALARM_NAME, {when: nextCheck});
            }
        }
    }

    private static wakeInterval: number = -1;

    private static runWakeDetector() {
        if (__CHROMIUM_MV3__) {
            chrome.alarms.create(Extension.WAKEUP_ALARM_NAME, {periodInMinutes: 1});
            return;
        }

        const WAKE_CHECK_INTERVAL = getDuration({minutes: 1});
        const WAKE_CHECK_INTERVAL_ERROR = getDuration({seconds: 10});
        if (this.wakeInterval >= 0) {
            clearInterval(this.wakeInterval);
        }

        let lastRun = Date.now();
        this.wakeInterval = setInterval(() => {
            const now = Date.now();
            if (now - lastRun > WAKE_CHECK_INTERVAL + WAKE_CHECK_INTERVAL_ERROR) {
                Extension.handleAutomationCheck();
            }
            lastRun = now;
        }, WAKE_CHECK_INTERVAL);
    }

    static async start(): Promise<void> {
        Extension.init();
        await TabManager.cleanState();
        await DevTools.init(Extension.onSettingsChanged);
        await Promise.all([
            ConfigManager.load({local: true}),
            Extension.MV3syncSystemColorStateManager(null),
            UserStorage.loadSettings(),
            AIStore.loadAllSchemes(),
            // 预热 AI 设置缓存：getTabMessage 是同步的，需要同步读取「仅 AI 模式」
            AISettingsStore.loadAIStore(),
        ]);

        if (UserStorage.settings.enableContextMenus && !Extension.registeredContextMenus) {
            chrome.permissions.contains({permissions: ['contextMenus']}, (permitted) => {
                if (permitted) {
                    Extension.registerContextMenus();
                } else {
                    logWarn('User has enabled context menus, but did not provide permission.');
                }
            });
        }
        if (UserStorage.settings.syncSitesFixes) {
            await ConfigManager.load({local: false});
        }
        Extension.updateAutoState();
        Extension.runWakeDetector();
        Extension.onAppToggle();
        logInfo('loaded', UserStorage.settings);

        if (__THUNDERBIRD__) {
            TabManager.registerMailDisplayScript();
        } else if (!__CHROMIUM_MV3__ || Extension.isFirstLoad) {
            TabManager.updateContentScript({runOnProtectedPages: UserStorage.settings.enableForProtectedPages});
        }

        UserStorage.settings.fetchNews && Newsmaker.subscribe();
        Extension.startBarrier!.resolve();
    }

    private static getMessengerAdapter(): ExtensionAdapter {
        return {
            collect: async () => {
                return await Extension.collectData();
            },
            collectDevToolsData: async () => {
                return await Extension.collectDevToolsData();
            },
            changeSettings: Extension.changeSettings,
            setTheme: Extension.setTheme,
            toggleActiveTab: Extension.toggleActiveTab,
            markNewsAsRead: Newsmaker.markAsRead,
            markNewsAsDisplayed: Newsmaker.markAsDisplayed,
            loadConfig: ConfigManager.load,
            applyDevFixes: DevTools.applyFixes,
            resetDevFixes: DevTools.resetFixes,
            startActivation: Extension.startActivation,
            resetActivation: Extension.resetActivation,
            hideHighlights: UIHighlights.hideHighlights,
            waitUntilReady: Extension.waitUntilReady,
            getAISettings: () => AISettingsStore.loadAISettings(),
            saveAISettings: (settings) => AISettingsStore.saveAISettings(settings),
            getAIStore: () => AISettingsStore.loadAIStore(),
            saveAIStore: (store) => AISettingsStore.saveAIStore(store),
            reapplyAIToAllTabs: async () => {
                // 「仅 AI 模式」改变后，所有标签页的判定结果都会变，需要重新下发
                await Extension.waitUntilReady();
                await TabManager.sendMessage(false);
                return {ok: true};
            },
            testAIConnection: async (settings) => {
                const current = await AISettingsStore.loadAISettings();
                const effective = {...current, ...settings};
                return await AIClient.testConnectivity(effective);
            },
            generateAIScheme: (tabId) => Extension.generateAISchemeForTab(tabId),
            refineAIScheme: (data) => Extension.refineAIScheme(data),
            pickAIElement: (tabId) => Extension.pickAIElement(tabId),
            getAIPending: (tabId) => Extension.getAIPending(tabId),
            clearAIPending: () => AIPending.clearPending(),
            getAISchemeStatus: (tabId) => Extension.getAISchemeStatus(tabId),
            setAISiteMode: (data) => Extension.setAISiteMode(data),
            clearAIScheme: (tabId) => Extension.clearAISchemeForTab(tabId),
            exportAISchemes: () => Extension.exportAISchemes(),
            importAISchemes: (data) => Extension.importAISchemes(data),
            setAIScope: (data) => Extension.setAIScope(data),
        };
    }

    /** 读取指定标签页的 AI 方案状态 */
    private static async getAISchemeStatus(tabId: number): Promise<{domain: string; hasScheme: boolean; createdAt: number | null; reason: string; scheme: any; siteMode: 'ai' | 'default' | null} | null> {
        try {
            const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
                chrome.tabs.get(tabId, (t) => resolve(chrome.runtime.lastError ? null : t));
            });
            if (!tab || !tab.url) {
                return null;
            }
            const domain = AIStore.normalizeDomain(tab.url);
            const scheme = await AIStore.getScheme(tab.url);
            const siteMode = await AIStore.getSiteMode(tab.url);
            return {
                domain,
                hasScheme: Boolean(scheme),
                createdAt: scheme ? scheme.createdAt : null,
                reason: scheme ? scheme.reason : '',
                siteMode,
                scheme: scheme ? {
                    theme: scheme.theme,
                    fixes: scheme.fixes,
                    reason: scheme.reason,
                    createdAt: scheme.createdAt,
                    model: scheme.model,
                } : null,
            };
        } catch (err) {
            return null;
        }
    }

    /**
     * 切换某标签页所属站点的配色来源。
     *
     * mode = 'ai'      使用 AI 生成的方案
     * mode = 'default' 使用 Dark Reader 自带深色（忽略 AI 方案）
     */
    private static async setAISiteMode(payload: {tabId: number; mode: 'ai' | 'default'}): Promise<{ok: boolean; error?: string}> {
        const {tabId, mode} = payload || {} as any;
        if (mode !== 'ai' && mode !== 'default') {
            return {ok: false, error: '无效的模式'};
        }
        try {
            const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
                chrome.tabs.get(tabId, (t) => resolve(chrome.runtime.lastError ? null : t));
            });
            if (!tab || !tab.url) {
                return {ok: false, error: '无法获取当前标签页'};
            }
            await AIStore.setSiteMode(tab.url, mode);
            await Extension.applyToTab(tabId);
            return {ok: true};
        } catch (err: any) {
            return {ok: false, error: err?.message ?? String(err)};
        }
    }

    /**
     * 为指定标签页生成 AI 深色方案。
     *
     * 流程：注入采集脚本 -> 拿摘要 -> 调用 LLM -> 校验 -> 落盘 -> 重新应用主题
     */
    private static async generateAISchemeForTab(tabId: number): Promise<{ok: boolean; error?: string; reason?: string; durationMs: number; usage?: any}> {
        const start = Date.now();

        const settings = await AISettingsStore.loadAISettings();
        if (!settings.enabled) {
            return {ok: false, error: '请先在设置中启用 AI 定制', durationMs: Date.now() - start};
        }

        // 1. 在页面里执行采集（必须在「原始亮色」状态下采集，
        //    否则读到的背景/文字色都是被 Dark Reader 改暗之后的值，
        //    AI 会误判该站本来就是暗色）
        let digest: any = null;
        try {
            digest = await Extension.collectFromOriginalPage(tabId);
        } catch (err: any) {
            return {ok: false, error: `无法读取页面：${err?.message ?? String(err)}`, durationMs: Date.now() - start};
        }

        if (!digest) {
            return {ok: false, error: '页面采集失败（可能是不允许注入的页面）', durationMs: Date.now() - start};
        }

        // 2. 调用 LLM
        const generated = await AIGenerate.generateScheme(digest);
        if (!generated.ok || !generated.scheme) {
            return {ok: false, error: generated.error, durationMs: Date.now() - start};
        }

        // 3. 落盘（按域名范围）
        await AIStore.saveScheme(digest.domain, generated.scheme, 'domain');

        // 4. 立即应用到该标签页
        try {
            await Extension.applyToTab(tabId);
        } catch (err) {
            // 应用失败不影响落盘，用户刷新即可
        }

        return {
            ok: true,
            reason: generated.scheme.reason,
            durationMs: Date.now() - start,
            usage: generated.usage,
        };
    }

    /** 清除某标签页所属站点的 AI 方案，并恢复原生主题 */
    private static async clearAISchemeForTab(tabId: number): Promise<{ok: boolean}> {
        try {
            const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
                chrome.tabs.get(tabId, (t) => resolve(chrome.runtime.lastError ? null : t));
            });
            if (tab && tab.url) {
                await AIStore.removeScheme(tab.url);
            }
            await Extension.applyToTab(tabId);
            return {ok: true};
        } catch (err) {
            return {ok: false};
        }
    }

    /** 把当前主题重新下发给指定标签页 */
    private static async applyToTab(tabId: number): Promise<void> {
        await Extension.waitUntilReady();
        await TabManager.sendMessageToTab(tabId);
    }

    /**
     * 在「未被深色改造」的原始页面上采集摘要。
     *
     * 为什么需要：
     * Dark Reader 是通过注入高优先级 CSS 来改色的，`getComputedStyle`
     * 读到的是改暗之后的值。如果直接采集，AI 会把「已经变暗的页面」
     * 当成原始配色，生成的方案就会跑偏（例如误判该站本身就是暗色站）。
     *
     * 做法：临时发 CLEAN_UP 让页面恢复原样 → 等样式回退 → 采集 → 恢复主题。
     * 即使中途失败也一定会恢复主题，不会把页面留在亮色状态。
     */
    private static async collectFromOriginalPage(tabId: number): Promise<any> {
        const cleanUp = () => new Promise<void>((resolve) => {
            try {
                chrome.tabs.sendMessage(tabId, {type: MessageTypeBGtoCS.CLEAN_UP}, () => {
                    // 忽略 lastError：某些帧可能没有监听者
                    void chrome.runtime.lastError;
                    resolve();
                });
            } catch (err) {
                resolve();
            }
        });

        await cleanUp();
        // 给样式一次回退的机会（CSS 移除是同步的，但要等一次重排）
        await new Promise((resolve) => setTimeout(resolve, 120));

        try {
            const results = await chrome.scripting.executeScript({
                target: {tabId},
                func: collectDigestInPage,
            });
            return results && results[0] && results[0].result;
        } finally {
            // 无论采集成功与否，都把主题恢复回去
            try {
                await Extension.applyToTab(tabId);
            } catch (err) {
                // 忽略：下次导航会重新下发
            }
        }
    }

    /**
     * 在页面里启动元素拾取。
     *
     * 关键点：popup 在用户去点页面时必然关闭，所以拾取结果不能只靠
     * 消息回传给 popup —— 必须在这里直接写进 storage.session，
     * 用户重新打开 popup 时再恢复。
     */
    private static async pickAIElement(tabId: number): Promise<{ok: boolean; element?: any; error?: string}> {
        try {
            const results = await chrome.scripting.executeScript({
                target: {tabId},
                func: startElementPicker,
            });
            const picked = results && results[0] && results[0].result;
            if (!picked) {
                return {ok: false, error: '已取消选择'};
            }

            // 立刻持久化，这样即使 popup 已经关闭，重新打开也能恢复
            try {
                const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
                    chrome.tabs.get(tabId, (t) => resolve(chrome.runtime.lastError ? null : t));
                });
                const url = (tab && tab.url) || '';
                await AIPending.addPending(tabId, url, {
                    selector: picked.selector,
                    tag: picked.tag,
                    background: picked.background,
                    color: picked.color,
                    textPreview: picked.textPreview || '',
                    note: '',
                    tabId,
                });
            } catch (err) {
                // 持久化失败不影响本次返回，popup 还活着的话仍能收到
            }

            return {ok: true, element: picked};
        } catch (err: any) {
            return {ok: false, error: `无法在页面上拾取元素：${err?.message ?? String(err)}`};
        }
    }

    /** 读取某标签页已拾取但未提交的待修复元素 */
    private static async getAIPending(tabId: number): Promise<any[]> {
        try {
            const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
                chrome.tabs.get(tabId, (t) => resolve(chrome.runtime.lastError ? null : t));
            });
            const url = (tab && tab.url) || '';
            return await AIPending.loadPending(tabId, url);
        } catch (err) {
            return [];
        }
    }

    /**
     * 基于用户指出的问题元素，对现有方案做增量修复。
     */
    private static async refineAIScheme(payload: {tabId: number; feedbacks: any[]}): Promise<{ok: boolean; error?: string; reason?: string; durationMs: number; usage?: any}> {
        const start = Date.now();
        const {tabId, feedbacks} = payload || {} as any;

        const settings = await AISettingsStore.loadAISettings();
        if (!settings.enabled) {
            return {ok: false, error: '请先在设置中启用 AI 定制', durationMs: Date.now() - start};
        }
        if (!Array.isArray(feedbacks) || feedbacks.length === 0) {
            return {ok: false, error: '没有待修复的元素', durationMs: Date.now() - start};
        }

        const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
            chrome.tabs.get(tabId, (t) => resolve(chrome.runtime.lastError ? null : t));
        });
        if (!tab || !tab.url) {
            return {ok: false, error: '无法获取当前标签页', durationMs: Date.now() - start};
        }

        const current = await AIStore.getScheme(tab.url);
        if (!current) {
            return {ok: false, error: '当前站点还没有方案，请先生成', durationMs: Date.now() - start};
        }

        // 重新采集一次页面摘要（页面可能已变化）
        let digest: any = null;
        try {
            // 同样要在原始亮色页面上采集，否则读到的是已改暗的颜色
            digest = await Extension.collectFromOriginalPage(tabId);
        } catch (err: any) {
            return {ok: false, error: `无法读取页面：${err?.message ?? String(err)}`, durationMs: Date.now() - start};
        }
        if (!digest) {
            return {ok: false, error: '页面采集失败', durationMs: Date.now() - start};
        }

        const refined = await AIGenerate.refineScheme(digest, current, feedbacks);
        if (!refined.ok || !refined.scheme) {
            return {ok: false, error: refined.error, durationMs: Date.now() - start};
        }

        // 保留原来的存储范围（域名级还是路径级）
        const record = await AIStore.getRecord(tab.url);
        const scope = record ? record.scope : 'domain';
        const key = record ? record.key : digest.domain;
        await AIStore.saveScheme(key, refined.scheme, scope);

        try {
            await Extension.applyToTab(tabId);
        } catch (err) {
            // 忽略
        }

        return {
            ok: true,
            reason: refined.scheme.reason,
            durationMs: Date.now() - start,
            usage: refined.usage,
        };
    }

    /** 导出全部方案 */
    private static async exportAISchemes(): Promise<any> {
        return await AIStore.exportSchemes();
    }

    /** 导入方案 */
    private static async importAISchemes(payload: {data: any; mode: 'merge' | 'replace'}): Promise<any> {
        const result = await AIStore.importSchemes(payload?.data, payload?.mode || 'merge');
        await Extension.applyToTab(await Extension.getActiveTabId());
        return result;
    }

    /**
     * 调整当前站点方案的生效范围（域名级 / 路径级）。
     */
    private static async setAIScope(payload: {tabId: number; scope: 'domain' | 'path'}): Promise<{ok: boolean; error?: string}> {
        const {tabId, scope} = payload || {} as any;
        const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
            chrome.tabs.get(tabId, (t) => resolve(chrome.runtime.lastError ? null : t));
        });
        if (!tab || !tab.url) {
            return {ok: false, error: '无法获取当前标签页'};
        }
        const record = await AIStore.getRecord(tab.url);
        if (!record) {
            return {ok: false, error: '当前站点没有方案'};
        }
        if (record.scope === scope) {
            return {ok: true};
        }
        // 换 key 重新保存
        await AIStore.removeSchemeByKey(record.key);
        await AIStore.saveScheme(tab.url, record.scheme, scope);
        await Extension.applyToTab(tabId);
        return {ok: true};
    }

    private static async getActiveTabId(): Promise<number> {
        const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
            chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                resolve(chrome.runtime.lastError || !tabs || !tabs[0] ? null : tabs[0]);
            });
        });
        return tab && tab.id != null ? tab.id : -1;
    }

    private static onCommandInternal = async (command: Command, tabId: number | null, frameId: number | null, frameURL: string | null) => {
        await Extension.waitUntilReady();
        Extension.stateManager!.loadState();
        switch (command) {
            case 'toggle':
                logInfo('Toggle command entered');
                Extension.changeSettings({
                    enabled: !Extension.isExtensionSwitchedOn(),
                    automation: {...UserStorage.settings.automation, ...{enabled: false}},
                });
                break;
            case 'addSite': {
                logInfo('Add Site command entered');
                async function scriptPDF(tabId: number, frameId: number): Promise<boolean> {
                    // We can not detect PDF if we do not know where we are looking for it
                    if (!(Number.isInteger(tabId) && Number.isInteger(frameId))) {
                        return false;
                    }
                    function detectPDF(): boolean {
                        if (document.body.childElementCount !== 1) {
                            return false;
                        }
                        const {nodeName, type} = document.body.childNodes[0] as HTMLEmbedElement;
                        return nodeName === 'EMBED' && type === 'application/pdf';
                    }

                    if (__CHROMIUM_MV3__) {
                        return (await chrome.scripting.executeScript({
                            target: {tabId, frameIds: [frameId]},
                            func: detectPDF,
                        }))[0].result || false;
                    } else if (__CHROMIUM_MV2__) {
                        return new Promise<boolean>((resolve) => chrome.tabs.executeScript(tabId, {
                            frameId,
                            code: `(${detectPDF.toString()})()`,
                        }, (results) => resolve(results?.[0])));
                    }
                    return false;
                }

                const pdf = async () => isPDF(frameURL || await TabManager.getActiveTabURL());
                if (((__CHROMIUM_MV2__ || __CHROMIUM_MV3__) && await scriptPDF(tabId!, frameId!)) || await pdf()) {
                    Extension.changeSettings({enableForPDF: !UserStorage.settings.enableForPDF});
                } else {
                    Extension.toggleActiveTab();
                }
                break;
            }
            case 'switchEngine': {
                logInfo('Switch Engine command entered');
                const engines = Object.values(ThemeEngine);
                const index = engines.indexOf(UserStorage.settings.theme.engine);
                const next = engines[(index + 1) % engines.length];
                Extension.setTheme({engine: next});
                break;
            }
        }
    };

    // 75 is small enough to not notice it, and still catches when someone
    // is holding down a certain shortcut.
    private static onCommand = debounce(75, Extension.onCommandInternal);

    private static registerContextMenus() {
        chrome.contextMenus.onClicked.addListener(async ({menuItemId, frameId, frameUrl, pageUrl}, tab) =>
            Extension.onCommand(menuItemId as Command, tab && tab.id || null, frameId || null, frameUrl || pageUrl || null));
        chrome.contextMenus.removeAll(() => {
            Extension.registeredContextMenus = false;
            chrome.contextMenus.create({
                id: 'DarkReader-top',
                title: 'Dark Reader AI',
            }, () => {
                if (chrome.runtime.lastError) {
                    // Failed to create the context menu
                    return;
                }
                const msgToggle = chrome.i18n.getMessage('toggle_extension');
                const msgAddSite = chrome.i18n.getMessage('toggle_current_site');
                const msgSwitchEngine = chrome.i18n.getMessage('theme_generation_mode');
                chrome.contextMenus.create({
                    id: 'toggle',
                    parentId: 'DarkReader-top',
                    title: msgToggle || 'Toggle everywhere',
                });
                chrome.contextMenus.create({
                    id: 'addSite',
                    parentId: 'DarkReader-top',
                    title: msgAddSite || 'Toggle for current site',
                });
                chrome.contextMenus.create({
                    id: 'switchEngine',
                    parentId: 'DarkReader-top',
                    title: msgSwitchEngine || 'Switch engine',
                });
                Extension.registeredContextMenus = true;
            });
        });
    }

    private static async getShortcuts() {
        const commands = await getCommands();
        return commands.reduce((map, cmd) => Object.assign(map, {[cmd.name!]: cmd.shortcut}), {} as Shortcuts);
    }

    static async collectData(): Promise<ExtensionData> {
        await Extension.loadData();
        const [
            news,
            shortcuts,
            activeTab,
            isAllowedFileSchemeAccess,
            uiHighlights,
        ] = await Promise.all([
            Newsmaker.getLatest(),
            Extension.getShortcuts(),
            Extension.getActiveTabInfo(),
            new Promise<boolean>((r) => chrome.extension.isAllowedFileSchemeAccess(r)),
            UIHighlights.getHighlightsToShow(),
        ]);
        return {
            isEnabled: Extension.isExtensionSwitchedOn(),
            isReady: true,
            isAllowedFileSchemeAccess,
            settings: UserStorage.settings,
            news,
            shortcuts,
            colorScheme: ConfigManager.COLOR_SCHEMES_RAW!,
            forcedScheme: Extension.autoState === 'scheme-dark' ? 'dark' : Extension.autoState === 'scheme-light' ? 'light' : null,
            activeTab,
            uiHighlights,
        };
    }

    static async collectDevToolsData(): Promise<DevToolsData> {
        const [
            detector,
            dynamic,
            filter,
            staticThemesText,
        ] = await Promise.all([
            DevTools.getDetectorHintsText(),
            DevTools.getDynamicThemeFixesText(),
            DevTools.getInversionFixesText(),
            DevTools.getStaticThemesText(),
        ]);
        return {
            detector,
            dynamic,
            filter,
            static: staticThemesText,
        };
    }

    private static async getActiveTabInfo(): Promise<TabInfo> {
        await Extension.loadData();
        const tab = await getActiveTab();
        const url = await TabManager.getTabURL(tab);
        const {isInDarkList, isProtected} = Extension.getTabInfo(url);
        const isInjected = TabManager.canAccessTab(tab);
        const documentId = TabManager.getTabDocumentId(tab);
        let isDarkThemeDetected = null;
        if (UserStorage.settings.detectDarkTheme) {
            isDarkThemeDetected = TabManager.isTabDarkThemeDetected(tab);
        }
        const id = tab && tab.id || null;
        return {
            id,
            documentId,
            url,
            isInDarkList,
            isProtected,
            isInjected,
            isDarkThemeDetected,
        };
    }

    private static waitUntilReady = async (): Promise<void> => {
        if (Extension.startBarrier!.isPending()) {
            await Extension.startBarrier!.entry();
        }
    };

    private static async getConnectionMessage(tabURL: string, url: string, isTopFrame: boolean, topFrameHasDarkTheme?: boolean) {
        await Extension.loadData();
        return Extension.getTabMessage(tabURL, url, isTopFrame, topFrameHasDarkTheme);
    }

    private static async loadData() {
        Extension.init();
        await Promise.all([
            Extension.stateManager!.loadState(),
            UserStorage.loadSettings(),
        ]);
    }

    private static onColorSchemeChange = async (isDark: boolean) => {
        if (Extension.wasLastColorSchemeDark === isDark) {
            // If color scheme was already correct, we do not need to do anything
            return;
        }
        Extension.wasLastColorSchemeDark = isDark;
        await Extension.MV3syncSystemColorStateManager(isDark);
        await Extension.loadData();
        if (UserStorage.settings.automation.mode !== AutomationMode.SYSTEM) {
            return;
        }
        Extension.handleAutomationCheck();
    };

    private static handleAutomationCheck = () => {
        Extension.updateAutoState();

        const isSwitchedOn = Extension.isExtensionSwitchedOn();
        if (
            Extension.wasEnabledOnLastCheck === null ||
            Extension.wasEnabledOnLastCheck !== isSwitchedOn ||
            Extension.autoState === 'scheme-dark' ||
            Extension.autoState === 'scheme-light'
        ) {
            Extension.wasEnabledOnLastCheck = isSwitchedOn;
            Extension.onAppToggle();
            TabManager.sendMessage();
            Extension.reportChanges();
            Extension.stateManager!.saveState();
        }
    };

    static async changeSettings($settings: Partial<UserSettings>, onlyUpdateActiveTab = false): Promise<void> {
        const promises = [];
        const prev = {...UserStorage.settings};

        UserStorage.set($settings);

        if (
            (prev.enabled !== UserStorage.settings.enabled) ||
            (prev.automation.enabled !== UserStorage.settings.automation.enabled) ||
            (prev.automation.mode !== UserStorage.settings.automation.mode) ||
            (prev.automation.behavior !== UserStorage.settings.automation.behavior) ||
            (prev.time.activation !== UserStorage.settings.time.activation) ||
            (prev.time.deactivation !== UserStorage.settings.time.deactivation) ||
            (prev.location.latitude !== UserStorage.settings.location.latitude) ||
            (prev.location.longitude !== UserStorage.settings.location.longitude)
        ) {
            Extension.updateAutoState();
            Extension.onAppToggle();
        }
        if (prev.syncSettings !== UserStorage.settings.syncSettings) {
            const promise = UserStorage.saveSyncSetting(UserStorage.settings.syncSettings);
            promises.push(promise);
        }
        if (Extension.isExtensionSwitchedOn() && $settings.changeBrowserTheme != null && prev.changeBrowserTheme !== $settings.changeBrowserTheme) {
            if ($settings.changeBrowserTheme) {
                setWindowTheme(UserStorage.settings.theme);
            } else {
                resetWindowTheme();
            }
        }
        if (prev.fetchNews !== UserStorage.settings.fetchNews) {
            UserStorage.settings.fetchNews ? Newsmaker.subscribe() : Newsmaker.unSubscribe();
        }

        if (prev.enableContextMenus !== UserStorage.settings.enableContextMenus) {
            if (UserStorage.settings.enableContextMenus) {
                Extension.registerContextMenus();
            } else {
                chrome.contextMenus.removeAll();
            }
        }
        const promise = Extension.onSettingsChanged(onlyUpdateActiveTab);
        promises.push(promise);
        await Promise.all(promises);
    }

    private static setTheme($theme: Partial<Theme>) {
        UserStorage.set({theme: {...UserStorage.settings.theme, ...$theme}});

        if (Extension.isExtensionSwitchedOn() && UserStorage.settings.changeBrowserTheme) {
            setWindowTheme(UserStorage.settings.theme);
        }

        Extension.onSettingsChanged();
    }

    private static async reportChanges() {
        const info = await Extension.collectData();
        Messenger.reportChanges(info);
    }

    private static async toggleActiveTab() {
        const settings = UserStorage.settings;
        const tab = await Extension.getActiveTabInfo();
        if (!tab) {
            return;
        }
        const {url} = tab;
        const isInDarkList = ConfigManager.isURLInDarkList(url);
        const host = getURLHostOrProtocol(url);

        function getToggledList(sourceList: string[]) {
            const list = sourceList.slice();

            let index = list.indexOf(host);
            if (index < 0 && host.startsWith('www.')) {
                const noWwwHost = host.substring(4);
                index = list.indexOf(noWwwHost);
            }

            if (index < 0) {
                list.push(host);
            } else {
                list.splice(index, 1);
            }
            return list;
        }

        const darkThemeDetected = settings.enabledByDefault && settings.detectDarkTheme && tab.isDarkThemeDetected;
        if (!settings.enabledByDefault || isInDarkList || darkThemeDetected) {
            const toggledList = getToggledList(settings.enabledFor);
            Extension.changeSettings({enabledFor: toggledList}, true);
            return;
        }
        if (settings.enabledByDefault && settings.enabledFor.includes(host)) {
            const enabledFor = getToggledList(settings.enabledFor);
            const disabledFor = getToggledList(settings.disabledFor);
            Extension.changeSettings({enabledFor, disabledFor}, true);
            return;
        }

        const toggledList = getToggledList(settings.disabledFor);
        Extension.changeSettings({disabledFor: toggledList}, true);
    }

    //------------------------------------
    //
    //       Handle config changes
    //

    private static onAppToggle() {
        if (Extension.isExtensionSwitchedOn()) {
            IconManager.setIcon({isActive: true, colorScheme: UserStorage.settings.theme.mode ? 'dark' : 'light'});
        } else {
            IconManager.setIcon({isActive: false, colorScheme: UserStorage.settings.theme.mode ? 'dark' : 'light'});
        }

        if (UserStorage.settings.changeBrowserTheme) {
            if (Extension.isExtensionSwitchedOn() && Extension.autoState !== 'scheme-light') {
                setWindowTheme(UserStorage.settings.theme);
            } else {
                resetWindowTheme();
            }
        }
    }

    private static async onSettingsChanged(onlyUpdateActiveTab = false) {
        await Extension.loadData();
        Extension.wasEnabledOnLastCheck = Extension.isExtensionSwitchedOn();
        TabManager.sendMessage(onlyUpdateActiveTab);
        Extension.saveUserSettings();
        Extension.reportChanges();
        IconManager.setIcon({colorScheme: UserStorage.settings.theme.mode ? 'dark' : 'light'});
        Extension.stateManager!.saveState();
    }

    private static async startActivation(email: string, key: string) {
        const delay = 2000 + Math.round(Math.random() * 2000);
        const checkEmail = (email: string) => email && email.trim().includes('@');
        const checkKey = (key: string) => key.replaceAll('-', '').length === 25 && key.toLocaleLowerCase().startsWith('dr') && key.replaceAll('-', '').match(/^[0-9a-z]{25}$/i);
        setTimeout(async () => {
            await writeLocalStorage({activationEmail: email, activationKey: key});
            if (checkEmail(email) && checkKey(key)) {
                await UIHighlights.hideHighlights(['anniversary']);
                if (__PLUS__) {
                    await Extension.changeSettings({previewNewestDesign: true});
                }
            }
            Extension.reportChanges();
        }, delay);
    }

    private static async resetActivation() {
        await removeLocalStorage(['activationEmail', 'activationKey']);
        await UIHighlights.restoreHighlights(['anniversary']);
        if (__PLUS__) {
            await Extension.changeSettings({previewNewestDesign: false});
        }
        Extension.reportChanges();
    }

    //----------------------
    //
    // Add/remove css to tab
    //
    //----------------------

    private static getTabInfo(tabURL: string): Pick<TabInfo, 'isInDarkList' | 'isProtected'> {
        const isInDarkList = ConfigManager.isURLInDarkList(tabURL);
        const isProtected = !canInjectScript(tabURL);
        return {
            isInDarkList,
            isProtected,
        };
    }

    private static getTabMessage = (tabURL: string, url: string, isTopFrame: boolean, topFrameHasDarkTheme?: boolean): TabData => {
        const settings = UserStorage.settings;
        const tabInfo = Extension.getTabInfo(tabURL);
        if (Extension.isExtensionSwitchedOn() && isURLEnabled(tabURL, settings, tabInfo) && !topFrameHasDarkTheme) {
            // AI 方案（可能为 null）与站点偏好先取出来
            const aiScheme = AIStore.getCachedSchemeSync(tabURL);
            const siteMode = AIStore.getCachedSiteModeSync(tabURL);
            // 用户对该站点明确选了「默认深色」→ 忽略 AI 方案
            const wantsDefault = siteMode === 'default';
            // 该站点实际生效的 AI 方案（选默认深色时视为没有）
            const effectiveAIScheme = wantsDefault ? null : aiScheme;

            // 仅 AI 模式：既没有 AI 方案、也没选默认深色的站点保持原样
            if (AISettingsStore.isAIOnlyMode() && !effectiveAIScheme && !wantsDefault) {
                logInfo(`AI-only mode: no scheme for ${tabURL}, leaving page untouched`);
                return {type: MessageTypeBGtoCS.CLEAN_UP};
            }

            const custom = settings.customThemes.find(({url: urlList}) => isURLInList(tabURL, urlList));
            const preset = custom ? null : settings.presets.find(({urls}) => isURLInList(tabURL, urls));
            let theme = custom ? custom.theme : preset ? preset.theme : settings.theme;
            if (Extension.autoState === 'scheme-dark' || Extension.autoState === 'scheme-light') {
                const mode = Extension.autoState === 'scheme-dark' ? 1 : 0;
                theme = {...theme, mode};
            }
            // AI 定制的配色：站点级覆盖，优先级高于全局/预设，但不改变引擎选择
            if (effectiveAIScheme && effectiveAIScheme.theme) {
                theme = {...theme, ...effectiveAIScheme.theme};
            }
            const detectorHints = settings.detectDarkTheme ? getDetectorHintsFor(url, ConfigManager.DETECTOR_HINTS_RAW!, ConfigManager.DETECTOR_HINTS_INDEX!) : null;
            const detectDarkTheme = (
                settings.detectDarkTheme &&
                (isTopFrame || detectorHints?.some((h) => h.iframe)) &&
                !isURLInList(tabURL, settings.enabledFor) &&
                !isPDF(tabURL)
            );

            logInfo(`Creating CSS for url: ${url}`);
            logInfo(`Custom theme ${custom ? 'was found' : 'was not found'}, Preset theme ${preset ? 'was found' : 'was not found'}
            The theme(${custom ? 'custom' : preset ? 'preset' : 'global'} settings) used is: ${JSON.stringify(theme)}`);
            switch (theme.engine) {
                case ThemeEngine.cssFilter: {
                    return {
                        type: MessageTypeBGtoCS.ADD_CSS_FILTER,
                        data: {
                            css: createCSSFilterStylesheet(theme, url, isTopFrame, ConfigManager.INVERSION_FIXES_RAW!, ConfigManager.INVERSION_FIXES_INDEX!),
                            detectDarkTheme,
                            detectorHints,
                            theme,
                        },
                    };
                }
                case ThemeEngine.svgFilter: {
                    if (isFirefox) {
                        return {
                            type: MessageTypeBGtoCS.ADD_CSS_FILTER,
                            data: {
                                css: createSVGFilterStylesheet(theme, url, isTopFrame, ConfigManager.INVERSION_FIXES_RAW!, ConfigManager.INVERSION_FIXES_INDEX!),
                                detectDarkTheme,
                                detectorHints,
                                theme,
                            },
                        };
                    }
                    return {
                        type: MessageTypeBGtoCS.ADD_SVG_FILTER,
                        data: {
                            css: createSVGFilterStylesheet(theme, url, isTopFrame, ConfigManager.INVERSION_FIXES_RAW!, ConfigManager.INVERSION_FIXES_INDEX!),
                            svgMatrix: getSVGFilterMatrixValue(theme),
                            svgReverseMatrix: getSVGReverseFilterMatrixValue(),
                            detectDarkTheme,
                            detectorHints,
                            theme,
                        },
                    };
                }
                case ThemeEngine.staticTheme: {
                    return {
                        type: MessageTypeBGtoCS.ADD_STATIC_THEME,
                        data: {
                            css: theme.stylesheet && theme.stylesheet.trim() ?
                                theme.stylesheet :
                                createStaticStylesheet(theme, url, isTopFrame, ConfigManager.STATIC_THEMES_RAW!, ConfigManager.STATIC_THEMES_INDEX!),
                            detectDarkTheme: settings.detectDarkTheme,
                            detectorHints,
                            theme,
                        },
                    };
                }
                case ThemeEngine.dynamicTheme: {
                    const fixes = getDynamicThemeFixesFor(url, ConfigManager.DYNAMIC_THEME_FIXES_RAW!, ConfigManager.DYNAMIC_THEME_FIXES_INDEX!, UserStorage.settings.enableForPDF);
                    // AI 生成的站点修复规则：追加到内置规则之后，后者优先生效
                    // 选了「默认深色」的站点不合并 AI 规则
                    const mergedFixes = mergeAIFixes(fixes, effectiveAIScheme);
                    return {
                        type: MessageTypeBGtoCS.ADD_DYNAMIC_THEME,
                        data: {
                            theme,
                            fixes: mergedFixes,
                            isIFrame: !isTopFrame,
                            detectDarkTheme,
                            detectorHints,
                        },
                    };
                }
                default:
                    throw new Error(`Unknown engine ${theme.engine}`);
            }
        }

        logInfo(`Site is not inverted: ${tabURL}`);
        return {
            type: MessageTypeBGtoCS.CLEAN_UP,
        };
    };

    //-------------------------------------
    //          User settings

    private static async saveUserSettings() {
        await UserStorage.saveSettings();
        logInfo('saved', UserStorage.settings);
    }
}

/**
 * 把 AI 生成的站点修复规则合并进内置规则。
 *
 * 合并语义（与引擎的叠加顺序一致）：
 * - 数组类字段做并集去重（invert / ignoreInlineStyle / ignoreImageAnalysis / ignoreCSSUrl）
 * - css 字符串采用「内置在前 + AI 在后」，后写的规则优先级更高
 *
 * 注意 dynamic-theme.ts 的约束：fixes[0].url[0] 必须是 '*' 通配块，
 * 所以 AI 块只能追加在末尾，不能插到前面。
 */
function mergeAIFixes(base: DynamicThemeFix[] | null, aiScheme: AIScheme | null): DynamicThemeFix[] | null {
    if (!aiScheme || !aiScheme.fixes) {
        return base;
    }
    const ai = aiScheme.fixes;
    const hasContent = (ai.invert?.length || 0) + (ai.ignoreInlineStyle?.length || 0)
        + (ai.ignoreImageAnalysis?.length || 0) + (ai.css ? 1 : 0) > 0;
    if (!hasContent) {
        return base;
    }

    if (!base || base.length === 0) {
        // 没有内置规则时，AI 规则单独成块；仍需满足通配块在前的约束
        return [{
            url: ['*'],
            invert: ai.invert || [],
            css: ai.css || '',
            ignoreInlineStyle: ai.ignoreInlineStyle || [],
            ignoreImageAnalysis: ai.ignoreImageAnalysis || [],
            ignoreCSSUrl: ai.ignoreCSSUrl || [],
            disableStyleSheetsProxy: false,
            disableCustomElementRegistryProxy: false,
        }];
    }

    const result = base.slice();
    const last = result[result.length - 1];
    const union = (a: string[] | undefined, b: string[] | undefined) => {
        const set = new Set<string>();
        (a || []).forEach((x) => set.add(x));
        (b || []).forEach((x) => set.add(x));
        return Array.from(set);
    };

    result[result.length - 1] = {
        ...last,
        invert: union(last.invert, ai.invert),
        css: [last.css, ai.css].filter(Boolean).join('\n'),
        ignoreInlineStyle: union(last.ignoreInlineStyle, ai.ignoreInlineStyle),
        ignoreImageAnalysis: union(last.ignoreImageAnalysis, ai.ignoreImageAnalysis),
        ignoreCSSUrl: union(last.ignoreCSSUrl, ai.ignoreCSSUrl),
    };

    return result;
}

