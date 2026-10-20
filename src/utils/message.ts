export enum MessageTypeUItoBG {
    GET_DATA = 'ui-bg-get-data',
    GET_DEVTOOLS_DATA = 'ui-bg-get-devtools-data',
    SUBSCRIBE_TO_CHANGES = 'ui-bg-subscribe-to-changes',
    UNSUBSCRIBE_FROM_CHANGES = 'ui-bg-unsubscribe-from-changes',
    CHANGE_SETTINGS = 'ui-bg-change-settings',
    SET_THEME = 'ui-bg-set-theme',
    TOGGLE_ACTIVE_TAB = 'ui-bg-toggle-active-tab',
    MARK_NEWS_AS_READ = 'ui-bg-mark-news-as-read',
    MARK_NEWS_AS_DISPLAYED = 'ui-bg-mark-news-as-displayed',
    LOAD_CONFIG = 'ui-bg-load-config',
    APPLY_DEV_FIXES = 'ui-bg-apply-dev-fixes',
    RESET_DEV_FIXES = 'ui-bg-reset-dev-fixes',
    START_ACTIVATION = 'ui-bg-start-activation',
    RESET_ACTIVATION = 'ui-bg-reset-activation',
    COLOR_SCHEME_CHANGE = 'ui-bg-color-scheme-change',
    HIDE_HIGHLIGHTS = 'ui-bg-hide-highlights',
    AI_GET_SETTINGS = 'ui-bg-ai-get-settings',
    AI_SAVE_SETTINGS = 'ui-bg-ai-save-settings',
    AI_GET_STORE = 'ui-bg-ai-get-store',
    AI_SAVE_STORE = 'ui-bg-ai-save-store',
    AI_REAPPLY = 'ui-bg-ai-reapply',
    AI_TEST_CONNECTION = 'ui-bg-ai-test-connection',
    AI_GENERATE_SCHEME = 'ui-bg-ai-generate-scheme',
    AI_REFINE_SCHEME = 'ui-bg-ai-refine-scheme',
    AI_PICK_ELEMENT = 'ui-bg-ai-pick-element',
    AI_GET_PENDING = 'ui-bg-ai-get-pending',
    AI_CLEAR_PENDING = 'ui-bg-ai-clear-pending',
    AI_GET_SCHEME_STATUS = 'ui-bg-ai-get-scheme-status',
    AI_SET_SITE_MODE = 'ui-bg-ai-set-site-mode',
    AI_CLEAR_SCHEME = 'ui-bg-ai-clear-scheme',
    AI_EXPORT_SCHEMES = 'ui-bg-ai-export-schemes',
    AI_IMPORT_SCHEMES = 'ui-bg-ai-import-schemes',
    AI_SET_SCOPE = 'ui-bg-ai-set-scope'
}

export enum MessageTypeBGtoUI {
    CHANGES = 'bg-ui-changes'
}

export enum DebugMessageTypeBGtoUI {
    CSS_UPDATE = 'debug-bg-ui-css-update',
    UPDATE = 'debug-bg-ui-update'
}

export enum MessageTypeBGtoCS {
    ADD_CSS_FILTER = 'bg-cs-add-css-filter',
    ADD_DYNAMIC_THEME = 'bg-cs-add-dynamic-theme',
    ADD_STATIC_THEME = 'bg-cs-add-static-theme',
    ADD_SVG_FILTER = 'bg-cs-add-svg-filter',
    CLEAN_UP = 'bg-cs-clean-up',
    FETCH_RESPONSE = 'bg-cs-fetch-response',
    UNSUPPORTED_SENDER = 'bg-cs-unsupported-sender'
}

export enum DebugMessageTypeBGtoCS {
    RELOAD = 'debug-bg-cs-reload'
}

export enum MessageTypeCStoBG {
    COLOR_SCHEME_CHANGE = 'cs-bg-color-scheme-change',
    DARK_THEME_DETECTED = 'cs-bg-dark-theme-detected',
    DARK_THEME_NOT_DETECTED = 'cs-bg-dark-theme-not-detected',
    FETCH = 'cs-bg-fetch',
    DOCUMENT_CONNECT = 'cs-bg-document-connect',
    DOCUMENT_FORGET = 'cs-bg-document-forget',
    DOCUMENT_FREEZE = 'cs-bg-document-freeze',
    DOCUMENT_RESUME = 'cs-bg-document-resume',
    AI_PAGE_DIGEST = 'cs-bg-ai-page-digest'
}

export enum DebugMessageTypeCStoBG {
    LOG = 'debug-cs-bg-log'
}

export enum MessageTypeCStoUI {
    EXPORT_CSS_RESPONSE = 'cs-ui-export-css-response'
}

export enum MessageTypeUItoCS {
    EXPORT_CSS = 'ui-cs-export-css'
}
