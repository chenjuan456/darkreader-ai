import type {DebugMessageBGtoCS, MessageBGtoCS, MessageCStoBG, MessageCStoUI, MessageUItoCS, DynamicThemeFix, Theme} from '../definitions';
import {detectInvisibleIcons} from '../ai/icons';
import {isSystemDarkModeEnabled, runColorSchemeChangeDetector, stopColorSchemeChangeDetector, emulateColorScheme} from '../utils/media-query';
import {DebugMessageTypeBGtoCS, MessageTypeBGtoCS, MessageTypeCStoBG, MessageTypeCStoUI, MessageTypeUItoCS} from '../utils/message';
import {generateUID} from '../utils/uid';
import {HOMEPAGE_URL} from '../utils/links';
import {activateTheme} from '@plus/utils/theme';

import {writeEnabledForHost} from './cache';
import {runDarkThemeDetector, stopDarkThemeDetector} from './detector';
import {createOrUpdateDynamicTheme, removeDynamicTheme, cleanDynamicThemeCache} from './dynamic-theme';
import {collectCSS} from './dynamic-theme/css-collection';
import {createOrUpdateStyle, removeStyle} from './style';
import {createOrUpdateSVGFilter, removeSVGFilter} from './svg-filter';
import {logWarn, logInfoCollapsed} from './utils/log';

declare const __DEBUG__: boolean;
declare const __TEST__: boolean;

let unloaded = false;

let darkReaderDynamicThemeStateForTesting: 'loading' | 'ready' = 'loading';

declare const __CHROMIUM_MV2__: boolean;
declare const __CHROMIUM_MV3__: boolean;
declare const __THUNDERBIRD__: boolean;
declare const __FIREFOX_MV2__: boolean;

declare function cloneInto<T>(obj: T, scope: Window): T;

// --------------------------------------
// 本地图标可见性检测
// --------------------------------------

/** 图标检测结果的缓存（同一页面只算一次） */
let iconFixCache: {selectors: string[]; url: string} | null = null;

/** 是否已安排检测 */
let iconDetectionScheduled = false;

/**
 * 把检测到的图标选择器合并进 fixes.invert。
 * 纯函数，便于测试。
 */
function mergeIconSelectors(fixes: DynamicThemeFix[] | null, selectors: string[]): DynamicThemeFix[] | null {
    if (!selectors || selectors.length === 0) {
        return fixes;
    }
    const existing = new Set<string>();
    if (fixes) {
        for (const f of fixes) {
            (f.invert || []).forEach((s) => existing.add(s));
        }
    }
    // 已明确忽略图片分析的，不覆盖
    const ignored = new Set<string>();
    if (fixes) {
        for (const f of fixes) {
            (f.ignoreImageAnalysis || []).forEach((s) => ignored.add(s));
        }
    }

    const toAdd = selectors.filter((s) => !existing.has(s) && !ignored.has(s));
    if (toAdd.length === 0) {
        return fixes;
    }

    if (!fixes || fixes.length === 0) {
        // 没有内置规则时也要满足「通配块在首位」的约束
        return [{
            url: ['*'],
            invert: toAdd,
            css: '',
            ignoreInlineStyle: [],
            ignoreImageAnalysis: [],
            ignoreCSSUrl: [],
            disableStyleSheetsProxy: false,
            disableCustomElementRegistryProxy: false,
        }];
    }

    const result = fixes.slice();
    const last = result[result.length - 1];
    result[result.length - 1] = {
        ...last,
        invert: [...(last.invert || []), ...toAdd],
    };
    return result;
}

/** 应用主题时合并已缓存的图标规则 */
function mergeIconFixes(fixes: DynamicThemeFix[] | null): DynamicThemeFix[] | null {
    if (!iconFixCache || iconFixCache.url !== location.href) {
        return fixes;
    }
    return mergeIconSelectors(fixes, iconFixCache.selectors);
}

/**
 * 安排一次图标检测。
 *
 * 为什么异步：
 * - 检测需要读取布局（getBoundingClientRect），页面刚加载时可能算不准
 * - 图标可能延迟渲染（SPA）
 * - 不能让主流程等待，否则用户会感到卡顿
 *
 * 检测完成后重新应用一次主题，把新规则合进去。
 */
function scheduleIconDetection(theme: Theme, fixes: DynamicThemeFix[] | null, isIFrame: boolean): void {
    if (iconDetectionScheduled) {
        return;
    }
    iconDetectionScheduled = true;

    const run = () => {
        try {
            const icons = detectInvisibleIcons(document.body);
            const selectors = icons.map((i) => i.selector);
            if (selectors.length === 0) {
                return;
            }
            iconFixCache = {selectors, url: location.href};
            // 用新规则重算主题
            createOrUpdateDynamicTheme(theme, mergeIconSelectors(fixes, selectors), isIFrame);
            console.info(`[Dark Reader AI] 本地图标检测：为 ${selectors.length} 个图标添加了反色`);
        } catch (err) {
            // 检测失败不影响正常使用
        }
    };

    // 首屏先给 300ms 让布局稳定，然后执行
    setTimeout(() => {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(run, {timeout: 1000});
        } else {
            run();
        }
    }, 300);
}

/** 页面切换（SPA）时重置缓存 */
function resetIconDetectionCache(): void {
    iconFixCache = null;
    iconDetectionScheduled = false;
}

// Identifier for this particular script instance. It is used as an alternative to chrome.runtime.MessageSender.documentId
const scriptId = generateUID();

const CONNECTION_TIMEOUT = 1000;
const CONNECTION_RETRIES = 10;
let didConnect = false;
let connectionRetries = 0;
let connectionTimeoutId = 0;

function cleanup() {
    unloaded = true;
    stopConnectionRetry();
    removeEventListener('pagehide', onPageHide);
    removeEventListener('freeze', onFreeze);
    removeEventListener('resume', onResume);
    cleanDynamicThemeCache();
    stopDarkThemeDetector();
    stopColorSchemeChangeDetector();
}

function sendMessageForTesting(uuid: string) {
    document.dispatchEvent(new CustomEvent('test-message', {detail: uuid}));
}

function sendMessage(message: MessageCStoBG | MessageCStoUI): true | undefined {
    if (unloaded) {
        return;
    }
    const responseHandler = (response: MessageBGtoCS | 'unsupportedSender' | undefined) => {
        // Vivaldi bug workaround. See TabManager for details.
        if (response === 'unsupportedSender' || response?.type === MessageTypeBGtoCS.UNSUPPORTED_SENDER) {
            removeStyle();
            removeSVGFilter();
            removeDynamicTheme();
            cleanup();
        }
    };

    try {
        if (__CHROMIUM_MV3__) {
            const promise = chrome.runtime.sendMessage<MessageCStoBG | MessageCStoUI, MessageBGtoCS | 'unsupportedSender'>(message);
            promise.then(responseHandler).catch(cleanup);
        } else {
            chrome.runtime.sendMessage<MessageCStoBG | MessageCStoUI, 'unsupportedSender' | undefined>(message, responseHandler);
        }
    } catch (error: any) {
        /*
         * We get here if Background context is unreachable which occurs when:
         *  - extension was disabled
         *  - extension was uninstalled
         *  - extension was updated and this is the old instance of content script
         *
         * Any async operations can be ignored here, but sync ones should run to completion.
         *
         * Regular message passing errors are returned via rejected promise or runtime.lastError.
         */
        if (error.message === 'Extension context invalidated.') {
            console.log('Dark Reader: instance of old CS detected, cleaning up.');
            cleanup();
        } else {
            console.log('Dark Reader: unexpected error during message passing.');
        }
    }
}

function onMessage(message: MessageBGtoCS | MessageUItoCS | DebugMessageBGtoCS) {
    if (__DEBUG__ && message.type === DebugMessageTypeBGtoCS.RELOAD) {
        logWarn('Cleaning up before update');
        cleanup();
        return;
    }

    if ((message as MessageBGtoCS).scriptId !== scriptId && message.type !== MessageTypeUItoCS.EXPORT_CSS) {
        return;
    }

    if ((message as MessageBGtoCS).scriptId === scriptId) {
        didConnect = true;
        stopConnectionRetry();
    }

    logInfoCollapsed(`onMessage[${message.type}]`, message);
    switch (message.type) {
        case MessageTypeBGtoCS.ADD_CSS_FILTER:
        case MessageTypeBGtoCS.ADD_STATIC_THEME: {
            const {css, detectDarkTheme, detectorHints} = message.data;
            removeDynamicTheme();
            createOrUpdateStyle(css, message.type === MessageTypeBGtoCS.ADD_STATIC_THEME ? 'static' : 'filter');
            writeEnabledForHost(true);
            if (detectDarkTheme) {
                runDarkThemeDetector((hasDarkTheme) => {
                    if (hasDarkTheme) {
                        removeStyle();
                        onDarkThemeDetected();
                    }
                }, detectorHints);
            }
            break;
        }
        case MessageTypeBGtoCS.ADD_SVG_FILTER: {
            const {css, svgMatrix, svgReverseMatrix, detectDarkTheme, detectorHints} = message.data;
            removeDynamicTheme();
            createOrUpdateSVGFilter(svgMatrix, svgReverseMatrix);
            createOrUpdateStyle(css, 'filter');
            writeEnabledForHost(true);
            if (detectDarkTheme) {
                runDarkThemeDetector((hasDarkTheme) => {
                    if (hasDarkTheme) {
                        removeStyle();
                        removeSVGFilter();
                        onDarkThemeDetected();
                    }
                }, detectorHints);
            }
            break;
        }
        case MessageTypeBGtoCS.ADD_DYNAMIC_THEME: {
            const {theme, fixes, isIFrame, detectDarkTheme, detectorHints} = message.data;
            removeStyle();
            // 本地图标可见性检测：把「深色图标 + 会被转暗的容器」加进 invert，
            // 避免图标转暗后消失。检测是异步的（需要读布局），先应用主题再补丁，
            // 用户不会看到明显延迟。
            createOrUpdateDynamicTheme(theme, mergeIconFixes(fixes), isIFrame);
            scheduleIconDetection(theme, fixes, isIFrame);
            writeEnabledForHost(true);
            if (detectDarkTheme) {
                runDarkThemeDetector((hasDarkTheme) => {
                    if (hasDarkTheme) {
                        removeDynamicTheme();
                        onDarkThemeDetected();
                    }
                }, detectorHints);
            }
            if (__TEST__) {
                darkReaderDynamicThemeStateForTesting = 'ready';
                sendMessageForTesting('darkreader-dynamic-theme-ready');
                sendMessageForTesting(`darkreader-dynamic-theme-ready-${document.location.pathname}`);
            }
            break;
        }
        case MessageTypeUItoCS.EXPORT_CSS:
            collectCSS().then((collectedCSS) => sendMessage({type: MessageTypeCStoUI.EXPORT_CSS_RESPONSE, data: collectedCSS}));
            break;
        case MessageTypeBGtoCS.UNSUPPORTED_SENDER:
        case MessageTypeBGtoCS.CLEAN_UP:
            removeStyle();
            removeSVGFilter();
            removeDynamicTheme();
            stopDarkThemeDetector();
            resetIconDetectionCache();
            writeEnabledForHost(false);
            break;
        default:
            break;
    }
}

function sendConnectionOrResumeMessage(type: MessageTypeCStoBG.DOCUMENT_CONNECT | MessageTypeCStoBG.DOCUMENT_RESUME) {
    sendMessage(
        {
            type,
            scriptId,
            data: (__CHROMIUM_MV2__ || __CHROMIUM_MV3__) ? {
                isDark: isSystemDarkModeEnabled(),
                isTopFrame: window === window.top,
            } : {
                isDark: isSystemDarkModeEnabled(),
            },
        });
}

function scheduleConnectionRetry() {
    stopConnectionRetry();
    if (didConnect || unloaded || connectionRetries >= CONNECTION_RETRIES) {
        return;
    }
    connectionTimeoutId = setTimeout(() => {
        connectionTimeoutId = 0;
        if (didConnect || unloaded) {
            return;
        }
        connectionRetries++;
        sendConnectionOrResumeMessage(MessageTypeCStoBG.DOCUMENT_CONNECT);
        scheduleConnectionRetry();
    }, CONNECTION_TIMEOUT);
}

function stopConnectionRetry() {
    if (connectionTimeoutId) {
        clearTimeout(connectionTimeoutId);
        connectionTimeoutId = 0;
    }
}

runColorSchemeChangeDetector((isDark) =>
    sendMessage({type: MessageTypeCStoBG.COLOR_SCHEME_CHANGE, data: {isDark}})
);

chrome.runtime.onMessage.addListener(onMessage);
sendConnectionOrResumeMessage(MessageTypeCStoBG.DOCUMENT_CONNECT);
scheduleConnectionRetry();

function onPageHide(e: PageTransitionEvent) {
    if (e.persisted === false) {
        sendMessage({type: MessageTypeCStoBG.DOCUMENT_FORGET, scriptId});
    }
}

function onFreeze() {
    sendMessage({type: MessageTypeCStoBG.DOCUMENT_FREEZE});
}

function onResume() {
    sendConnectionOrResumeMessage(MessageTypeCStoBG.DOCUMENT_RESUME);
}

function onDarkThemeDetected() {
    writeEnabledForHost(false);
    sendMessage({type: MessageTypeCStoBG.DARK_THEME_DETECTED});
}

// Thunderbird does not have "tabs", and emails aren't 'frozen' or 'cached'.
// And will currently error: `Promise rejected after context unloaded: Actor 'Conduits' destroyed before query 'RuntimeMessage' was resolved`
if (!__THUNDERBIRD__) {
    addEventListener('pagehide', onPageHide, {passive: true});
    addEventListener('freeze', onFreeze, {passive: true});
    addEventListener('resume', onResume, {passive: true});
}

if (location.origin === HOMEPAGE_URL) {
    document.addEventListener('__darkreader_activate__', async (e) => {
        const {email, key} = (e as CustomEvent).detail;
        const result = await activateTheme(email, key);
        const detail = {result};
        document.dispatchEvent(new CustomEvent('__darkreader_activationResult__', {
            detail: __FIREFOX_MV2__ && typeof cloneInto === 'function' ? cloneInto(detail, window) : detail,
        }));
    }, {once: true});
}

if (__TEST__) {
    async function awaitDOMContentLoaded() {
        if (document.readyState === 'loading') {
            return new Promise<void>((resolve) => {
                addEventListener('DOMContentLoaded', () => resolve(), {passive: true});
            });
        }
    }

    async function awaitDarkReaderReady() {
        if (darkReaderDynamicThemeStateForTesting !== 'ready') {
            return new Promise<void>((resolve) => {
                document.addEventListener('test-message', (event) => {
                    const message = (event as CustomEvent).detail;
                    if (message === 'darkreader-dynamic-theme-ready' && darkReaderDynamicThemeStateForTesting === 'ready') {
                        resolve();
                    }
                }, {passive: true});
            });
        }
    }

    const socket = new WebSocket(`ws://localhost:8894`);
    socket.onopen = async () => {
        document.addEventListener('test-message', (e) => {
            socket.send(JSON.stringify({
                data: {
                    type: 'page',
                    uuid: (e as CustomEvent).detail,
                },
                id: null,
            }));
        }, {passive: true});

        // Wait for DOM to be complete
        // Note that here we wait only for DOM parsing and not for sub-resource load
        await awaitDOMContentLoaded();
        await awaitDarkReaderReady();
        socket.send(JSON.stringify({
            data: {
                type: 'page',
                message: 'page-ready',
                uuid: `ready-${document.location.pathname}`,
            },
            id: null,
        }));
    };

    if (__FIREFOX_MV2__) {
        socket.onmessage = (e) => {
            function respond(data: any) {
                socket.send(JSON.stringify({id, data}));
            }

            const {id, data, type} = JSON.parse(e.data);
            switch (type) {
                case 'firefox-getColorScheme': {
                    respond(isSystemDarkModeEnabled() ? 'dark' : 'light');
                    break;
                }
                case 'firefox-emulateColorScheme': {
                    emulateColorScheme(data);
                    respond(undefined);
                    break;
                }
            }
        };
    }
}


