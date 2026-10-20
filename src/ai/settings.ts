/**
 * AI 配置的持久化。
 *
 * 设计要点：
 * - 支持多套配置（不同端点 + 不同 API Key），可随时切换
 * - 独立于 UserSettings —— 避免污染既有 settings schema 与同步逻辑
 * - 只用 chrome.storage.local —— API Key 绝不能进 sync（会同步到云端）
 * - loadAISettings() 始终返回「当前激活」那一套，调用方无需感知多配置
 */

const AI_SETTINGS_KEY = 'ai-settings';

/** 单套 AI 配置 */
export interface AISettings {
    /** OpenAI 兼容端点，如 https://api.openai.com/v1 */
    baseURL: string;
    /** API Key，仅存本地 */
    apiKey: string;
    /** 模型名，如 gpt-4o-mini */
    model: string;
    /** 额外请求头（JSON 字符串），如 Azure 需要 api-key */
    extraHeaders: string;
    /** 是否启用 AI 功能 */
    enabled: boolean;
    /** 单次请求超时（毫秒） */
    timeoutMs: number;
    /**
     * 最大输出 token。
     * 推理模型会先用大量 token「思考」，给太小会导致正文为空，
     * 所以默认放宽到 8000。
     */
    maxTokens: number;
}

/** 带标识与名称的配置项 */
export interface AIConfig extends AISettings {
    /** 唯一 id */
    id: string;
    /** 用户可见名称，如「OpenAI 官方」「讯飞星火」 */
    name: string;
}

/** 多配置容器 */
export interface AIStore {
    configs: AIConfig[];
    /** 当前激活的配置 id */
    activeId: string;
    /**
     * 只在「已生成 AI 方案」的站点启用深色。
     * 开启后没有 AI 方案的网站保持原样，不再套用 Dark Reader 默认深色。
     * 未设置时按 true 处理（本 fork 的默认取向）。
     */
    aiOnly?: boolean;
}

/**
 * AI 模块设置的同步缓存。
 *
 * getTabMessage() 是同步函数，但设置读取是异步的，
 * 因此启动时把整份 store 读进内存，之后由读写操作负责更新。
 */
let cachedStore: AIStore | null = null;

/** 当前是否「仅 AI 方案生效」模式 */
export function isAIOnlyMode(): boolean {
    if (!cachedStore) {
        // 缓存尚未就绪：保守地按默认取向（只认 AI 方案）
        return true;
    }
    return cachedStore.aiOnly !== false;
}

/** 供同步调用点读取完整 store（可能为 null） */
export function getAIStoreSync(): AIStore | null {
    return cachedStore;
}

export const DEFAULT_AI_SETTINGS: AISettings = {
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    extraHeaders: '',
    enabled: false,
    timeoutMs: 120000,
    maxTokens: 8000,
};

/** 生成一个稳定的配置 id */
export function generateConfigId(): string {
    return `cfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 默认的一套配置 */
export function createDefaultConfig(name = '默认配置'): AIConfig {
    return {
        id: generateConfigId(),
        name,
        ...DEFAULT_AI_SETTINGS,
    };
}

/** 把旧版单配置结构迁移为多配置结构 */
function migrateLegacy(stored: any): AIStore {
    // 旧结构：{baseURL, apiKey, model, ...} 直接是 AISettings
    if (stored && !Array.isArray(stored.configs) && typeof stored.baseURL === 'string') {
        const config: AIConfig = {
            id: generateConfigId(),
            name: '默认配置',
            baseURL: stored.baseURL ?? DEFAULT_AI_SETTINGS.baseURL,
            apiKey: stored.apiKey ?? DEFAULT_AI_SETTINGS.apiKey,
            model: stored.model ?? DEFAULT_AI_SETTINGS.model,
            extraHeaders: stored.extraHeaders ?? DEFAULT_AI_SETTINGS.extraHeaders,
            enabled: stored.enabled ?? DEFAULT_AI_SETTINGS.enabled,
            timeoutMs: stored.timeoutMs ?? DEFAULT_AI_SETTINGS.timeoutMs,
            maxTokens: stored.maxTokens ?? DEFAULT_AI_SETTINGS.maxTokens,
        };
        return {configs: [config], activeId: config.id};
    }
    // 新结构
    if (stored && Array.isArray(stored.configs) && stored.configs.length > 0) {
        const configs: AIConfig[] = stored.configs.map((c: any) => ({
            id: c.id || generateConfigId(),
            name: c.name || '未命名配置',
            ...DEFAULT_AI_SETTINGS,
            ...c,
        }));
        const activeId = configs.some((c) => c.id === stored.activeId) ? stored.activeId : configs[0].id;
        return {configs, activeId};
    }
    // 空：初始化一个
    const config = createDefaultConfig();
    return {configs: [config], activeId: config.id};
}

function readStore(): Promise<AIStore> {
    return new Promise<AIStore>((resolve) => {
        chrome.storage.local.get({[AI_SETTINGS_KEY]: null}, (result) => {
            if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError.message);
                resolve(migrateLegacy(null));
                return;
            }
            resolve(migrateLegacy(result[AI_SETTINGS_KEY]));
        });
    });
}

function writeStore(store: AIStore): Promise<AIStore> {
    return new Promise<AIStore>((resolve) => {
        chrome.storage.local.set({[AI_SETTINGS_KEY]: store}, () => {
            resolve(store);
        });
    });
}

/** 读取完整的配置列表（供设置页使用） */
export async function loadAIStore(): Promise<AIStore> {
    const store = await readStore();
    cachedStore = store;
    return store;
}

/** 保存整个配置列表 */
export async function saveAIStore(store: AIStore): Promise<AIStore> {
    // 保证 activeId 合法
    if (!store.configs.some((c) => c.id === store.activeId)) {
        store.activeId = store.configs[0]?.id || '';
    }
    const saved = await writeStore(store);
    cachedStore = saved;
    return saved;
}

/** 读取「当前激活」的配置——所有业务调用点用这个 */
export async function loadAISettings(): Promise<AISettings> {
    const store = await readStore();
    cachedStore = store;
    const active = store.configs.find((c) => c.id === store.activeId) || store.configs[0];
    if (!active) {
        return {...DEFAULT_AI_SETTINGS};
    }
    const {id, name, ...settings} = active;
    return settings;
}

/**
 * 更新「当前激活」的配置。
 * 保持与旧 API 兼容，避免改动 client / generate 等调用方。
 */
export async function saveAISettings(patch: Partial<AISettings>): Promise<AISettings> {
    const store = await readStore();
    cachedStore = store;
    const idx = store.configs.findIndex((c) => c.id === store.activeId);
    if (idx < 0) {
        return {...DEFAULT_AI_SETTINGS, ...patch};
    }
    store.configs[idx] = {...store.configs[idx], ...patch};
    await writeStore(store);
    const {id, name, ...settings} = store.configs[idx];
    return settings;
}

/** 把用户输入的 baseURL 规范化为不带尾斜杠的形式 */
export function normalizeBaseURL(baseURL: string): string {
    return baseURL.trim().replace(/\/+$/, '');
}

/** 拼出 chat completions 端点。允许用户直接粘完整 URL。 */
export function buildChatCompletionsURL(baseURL: string): string {
    const base = normalizeBaseURL(baseURL);
    if (/\/chat\/completions$/.test(base)) {
        return base;
    }
    return `${base}/chat/completions`;
}

/** 拼出 models 端点，用于连通性测试 */
export function buildModelsURL(baseURL: string): string {
    const base = normalizeBaseURL(baseURL);
    if (/\/chat\/completions$/.test(base)) {
        return base.replace(/\/chat\/completions$/, '/models');
    }
    return `${base}/models`;
}

/** 解析用户填的自定义头，出错时返回空对象而不是抛异常 */
export function parseExtraHeaders(text: string): Record<string, string> {
    if (!text.trim()) {
        return {};
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const result: Record<string, string> = {};
            for (const key of Object.keys(parsed)) {
                if (typeof parsed[key] === 'string') {
                    result[key] = parsed[key];
                } else {
                    result[key] = String(parsed[key]);
                }
            }
            return result;
        }
    } catch (err) {
        // 忽略，返回空
    }
    return {};
}
