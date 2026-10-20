import type {ExtensionData, Theme, TabInfo, MessageUItoBG, UserSettings, DevToolsData, MessageCStoBG, MessageBGtoUI, DevFixType} from '../definitions';
import {MessageTypeBGtoUI, MessageTypeUItoBG} from '../utils/message';
import {HOMEPAGE_URL} from '../utils/links';
import {isFirefox} from '../utils/platform';

import {makeFirefoxHappy} from './make-firefox-happy';
import {ASSERT} from './utils/log';

declare const __PLUS__: boolean;

export interface ExtensionAdapter {
    collect: () => Promise<ExtensionData>;
    collectDevToolsData: () => Promise<DevToolsData>;
    changeSettings: (settings: Partial<UserSettings>) => void;
    setTheme: (theme: Partial<Theme>) => void;
    markNewsAsRead: (ids: string[]) => Promise<void>;
    markNewsAsDisplayed: (ids: string[]) => Promise<void>;
    toggleActiveTab: () => void;
    loadConfig: (options: {local: boolean}) => Promise<void>;
    applyDevFixes: (type: DevFixType, text: string) => Error | null;
    resetDevFixes: (type: DevFixType) => void;
    startActivation: (email: string, key: string) => Promise<void>;
    resetActivation: () => Promise<void>;
    hideHighlights: (ids: string[]) => Promise<void>;
    waitUntilReady: () => Promise<void>;
    getAISettings: () => Promise<any>;
    saveAISettings: (settings: any) => Promise<any>;
    getAIStore: () => Promise<any>;
    saveAIStore: (store: any) => Promise<any>;
    reapplyAIToAllTabs: () => Promise<any>;
    testAIConnection: (settings: any) => Promise<any>;
    generateAIScheme: (tabId: number) => Promise<any>;
    refineAIScheme: (data: any) => Promise<any>;
    pickAIElement: (tabId: number) => Promise<any>;
    getAIPending: (tabId: number) => Promise<any>;
    clearAIPending: () => Promise<any>;
    getAISchemeStatus: (tabId: number) => Promise<any>;
    setAISiteMode: (data: any) => Promise<any>;
    clearAIScheme: (tabId: number) => Promise<any>;
    exportAISchemes: () => Promise<any>;
    importAISchemes: (data: any) => Promise<any>;
    setAIScope: (data: any) => Promise<any>;
}

export default class Messenger {
    private static adapter: ExtensionAdapter;
    private static changeListenerCount: number;

    static init(adapter: ExtensionAdapter): void {
        Messenger.adapter = adapter;
        Messenger.changeListenerCount = 0;

        chrome.runtime.onMessage.addListener(Messenger.messageListener);

        // This is a work-around for Firefox bug which does not permit responding to onMessage handler above.
        if (isFirefox) {
            chrome.runtime.onConnect.addListener(Messenger.firefoxPortListener);
        }
    }

    private static messageListener(message: MessageUItoBG | MessageCStoBG, sender: chrome.runtime.MessageSender, sendResponse: (response: {data?: ExtensionData | DevToolsData | TabInfo; error?: string} | 'unsupportedSender') => void) {
        if (isFirefox && makeFirefoxHappy(message, sender, sendResponse)) {
            return;
        }
        const allowedSenderURL = [
            chrome.runtime.getURL('/ui/popup/index.html'),
            chrome.runtime.getURL('/ui/devtools/index.html'),
            chrome.runtime.getURL('/ui/options/index.html'),
            chrome.runtime.getURL('/ui/sidepanel/index.html'),
            chrome.runtime.getURL('/ui/stylesheet-editor/index.html'),
        ];
        if (
            allowedSenderURL.includes(sender.url!) || (
                message.type === MessageTypeUItoBG.CHANGE_SETTINGS && (
                    sender.url?.startsWith(`${HOMEPAGE_URL}/activate/`) ||
                    (__PLUS__ && sender.url?.startsWith(`${HOMEPAGE_URL}/plus/activate/`))
                )
            )
        ) {
            Messenger.adapter
                .waitUntilReady()
                .then(() => Messenger.onUIMessage(message as MessageUItoBG, sendResponse));
            return ([
                MessageTypeUItoBG.GET_DATA,
                MessageTypeUItoBG.GET_DEVTOOLS_DATA,
                MessageTypeUItoBG.AI_GET_SETTINGS,
                MessageTypeUItoBG.AI_SAVE_SETTINGS,
                MessageTypeUItoBG.AI_GET_STORE,
                MessageTypeUItoBG.AI_SAVE_STORE,
                MessageTypeUItoBG.AI_REAPPLY,
                MessageTypeUItoBG.AI_TEST_CONNECTION,
                MessageTypeUItoBG.AI_GENERATE_SCHEME,
                MessageTypeUItoBG.AI_REFINE_SCHEME,
                MessageTypeUItoBG.AI_PICK_ELEMENT,
                MessageTypeUItoBG.AI_GET_PENDING,
                MessageTypeUItoBG.AI_CLEAR_PENDING,
                MessageTypeUItoBG.AI_GET_SCHEME_STATUS,
                MessageTypeUItoBG.AI_SET_SITE_MODE,
                MessageTypeUItoBG.AI_CLEAR_SCHEME,
                MessageTypeUItoBG.AI_EXPORT_SCHEMES,
                MessageTypeUItoBG.AI_IMPORT_SCHEMES,
                MessageTypeUItoBG.AI_SET_SCOPE,
            ].includes(message.type as MessageTypeUItoBG));
        }
    }

    private static firefoxPortListener(port: chrome.runtime.Port) {
        ASSERT('Messenger.firefoxPortListener() is used only on Firefox', isFirefox);

        if (!isFirefox) {
            return;
        }

        let promise: Promise<ExtensionData | DevToolsData | TabInfo | null>;
        switch (port.name) {
            case MessageTypeUItoBG.GET_DATA:
                promise = Messenger.adapter.collect();
                break;
            case MessageTypeUItoBG.GET_DEVTOOLS_DATA:
                promise = Messenger.adapter.collectDevToolsData();
                break;
            // These types require data, so we need to add a listener to the port.
            case MessageTypeUItoBG.APPLY_DEV_FIXES:
                promise = new Promise((resolve, reject) => {
                    port.onMessage.addListener((message: MessageUItoBG | MessageCStoBG) => {
                        const {data} = message;
                        const error = Messenger.adapter.applyDevFixes(data.type, data.text);
                        if (error) {
                            reject(error);
                        } else {
                            resolve(null);
                        }
                    });
                });
                break;
            default:
                return;
        }
        promise.then((data) => port.postMessage({data}))
            .catch((error) => port.postMessage({error}));
    }

    private static onUIMessage({type, data}: MessageUItoBG, sendResponse: (response: {data?: ExtensionData | DevToolsData | TabInfo; error?: string}) => void) {
        switch (type) {
            case MessageTypeUItoBG.GET_DATA:
                Messenger.adapter.collect().then((data) => sendResponse({data}));
                break;
            case MessageTypeUItoBG.GET_DEVTOOLS_DATA:
                Messenger.adapter.collectDevToolsData().then((data) => sendResponse({data}));
                break;
            case MessageTypeUItoBG.SUBSCRIBE_TO_CHANGES:
                Messenger.changeListenerCount++;
                break;
            case MessageTypeUItoBG.UNSUBSCRIBE_FROM_CHANGES:
                Messenger.changeListenerCount--;
                break;
            case MessageTypeUItoBG.CHANGE_SETTINGS:
                Messenger.adapter.changeSettings(data);
                break;
            case MessageTypeUItoBG.SET_THEME:
                Messenger.adapter.setTheme(data);
                break;
            case MessageTypeUItoBG.TOGGLE_ACTIVE_TAB:
                Messenger.adapter.toggleActiveTab();
                break;
            case MessageTypeUItoBG.MARK_NEWS_AS_READ:
                Messenger.adapter.markNewsAsRead(data);
                break;
            case MessageTypeUItoBG.MARK_NEWS_AS_DISPLAYED:
                Messenger.adapter.markNewsAsDisplayed(data);
                break;
            case MessageTypeUItoBG.LOAD_CONFIG:
                Messenger.adapter.loadConfig(data);
                break;
            case MessageTypeUItoBG.APPLY_DEV_FIXES: {
                const error = Messenger.adapter.applyDevFixes(data.type, data.text);
                sendResponse({error: (error ? error.message : undefined)});
                break;
            }
            case MessageTypeUItoBG.RESET_DEV_FIXES:
                Messenger.adapter.resetDevFixes(data.type);
                break;
            case MessageTypeUItoBG.START_ACTIVATION:
                Messenger.adapter.startActivation(data.email, data.key);
                break;
            case MessageTypeUItoBG.RESET_ACTIVATION:
                Messenger.adapter.resetActivation();
                break;
            case MessageTypeUItoBG.HIDE_HIGHLIGHTS:
                Messenger.adapter.hideHighlights(data);
                break;
            case MessageTypeUItoBG.AI_GET_SETTINGS:
                Messenger.adapter.getAISettings().then((settings) => sendResponse({data: settings}));
                break;
            case MessageTypeUItoBG.AI_SAVE_SETTINGS:
                Messenger.adapter.saveAISettings(data).then((settings) => sendResponse({data: settings}));
                break;
            case MessageTypeUItoBG.AI_GET_STORE:
                Messenger.adapter.getAIStore().then((store) => sendResponse({data: store}));
                break;
            case MessageTypeUItoBG.AI_SAVE_STORE:
                Messenger.adapter.saveAIStore(data).then((store) => sendResponse({data: store}));
                break;
            case MessageTypeUItoBG.AI_REAPPLY:
                Messenger.adapter.reapplyAIToAllTabs().then((result) => sendResponse({data: result}));
                break;
            case MessageTypeUItoBG.AI_TEST_CONNECTION:
                Messenger.adapter.testAIConnection(data).then((result) => sendResponse({data: result}));
                break;
            case MessageTypeUItoBG.AI_GENERATE_SCHEME:
                Messenger.adapter.generateAIScheme(data.tabId).then((result) => sendResponse({data: result}));
                break;
            case MessageTypeUItoBG.AI_GET_SCHEME_STATUS:
                Messenger.adapter.getAISchemeStatus(data.tabId).then((result) => sendResponse({data: result}));
                break;
            case MessageTypeUItoBG.AI_SET_SITE_MODE:
                Messenger.adapter.setAISiteMode(data).then((result) => sendResponse({data: result}));
                break;
            case MessageTypeUItoBG.AI_CLEAR_SCHEME:
                Messenger.adapter.clearAIScheme(data.tabId).then((result) => sendResponse({data: result}));
                break;
            case MessageTypeUItoBG.AI_REFINE_SCHEME:
                Messenger.adapter.refineAIScheme(data).then((result) => sendResponse({data: result}));
                break;
            case MessageTypeUItoBG.AI_PICK_ELEMENT:
                Messenger.adapter.pickAIElement(data.tabId).then((result) => sendResponse({data: result}));
                break;
            case MessageTypeUItoBG.AI_GET_PENDING:
                Messenger.adapter.getAIPending(data.tabId).then((result) => sendResponse({data: result}));
                break;
            case MessageTypeUItoBG.AI_CLEAR_PENDING:
                Messenger.adapter.clearAIPending().then((result) => sendResponse({data: result}));
                break;
            case MessageTypeUItoBG.AI_EXPORT_SCHEMES:
                Messenger.adapter.exportAISchemes().then((result) => sendResponse({data: result}));
                break;
            case MessageTypeUItoBG.AI_IMPORT_SCHEMES:
                Messenger.adapter.importAISchemes(data).then((result) => sendResponse({data: result}));
                break;
            case MessageTypeUItoBG.AI_SET_SCOPE:
                Messenger.adapter.setAIScope(data).then((result) => sendResponse({data: result}));
                break;
            default:
                break;
        }
    }

    static reportChanges(data: ExtensionData): void {
        if (Messenger.changeListenerCount > 0) {
            chrome.runtime.sendMessage<MessageBGtoUI>({
                type: MessageTypeBGtoUI.CHANGES,
                data,
            });
        }
    }
}
