/**
 * AI 方案的持久化。
 *
 * 存储结构按「域名 + 路径」分层：
 * - 默认按域名存（scope: 'domain'）
 * - 也可按路径前缀存（scope: 'path'），用于同一站点不同区域结构差异大的情况
 *
 * 匹配优先级：路径越精确越优先，其次域名级，最后通配。
 * 全部存 chrome.storage.local —— 体积较大且不宜同步。
 */

import type {AIScheme} from './scheme';

const STORAGE_KEY = 'ai-schemes';

/** 单条方案记录 */
export interface SchemeRecord {
    /** 完整 URL 或域名的规范化 key */
    key: string;
    /** 'domain' = 整站生效；'path' = 仅该路径前缀生效 */
    scope: 'domain' | 'path';
    /** 记录创建/更新时间 */
    updatedAt: number;
    scheme: AIScheme;
}

/** key -> 记录 */
export type SchemeStore = Record<string, SchemeRecord>;

/** 某站点使用哪种配色：AI 方案 / Dark Reader 默认深色 */
export type SiteMode = 'ai' | 'default';

/** 域名 -> 站点配色偏好 */
export type SiteModeStore = Record<string, SiteMode>;

/** 方案版本号：改 Prompt 或 schema 时递增，让旧缓存自动失效 */
export const SCHEME_VERSION = 2;

interface VersionedStore {
    version: number;
    schemes: SchemeStore;
    /**
     * 每站点的配色偏好。
     * 故意不参与 version 判断 —— 加这个字段不能让已生成的方案失效。
     */
    modes?: SiteModeStore;
}

/** 提取域名 */
export function normalizeDomain(domainOrUrl: string): string {
    const raw = (domainOrUrl || '').trim().toLowerCase();
    if (!raw) {
        return '';
    }
    try {
        return new URL(raw).hostname.toLowerCase();
    } catch (err) {
        return raw.replace(/^https?:\/\//, '').split('/')[0];
    }
}

/** 提取「域名 + 路径」，去掉查询串与 hash */
export function normalizePathKey(urlOrKey: string): string {
    const raw = (urlOrKey || '').trim().toLowerCase();
    if (!raw) {
        return '';
    }
    try {
        const u = new URL(raw);
        const path = u.pathname.replace(/\/+$/, '');
        return `${u.hostname}${path}`;
    } catch (err) {
        return raw
            .replace(/^https?:\/\//, '')
            .replace(/[?#].*$/, '')
            .replace(/\/+$/, '');
    }
}

/**
 * 规范化存储 key。
 * - domain 范围：只保留 hostname
 * - path 范围：保留 hostname + 路径
 */
export function buildKey(domainOrUrl: string, scope: 'domain' | 'path'): string {
    if (scope === 'domain') {
        return normalizeDomain(domainOrUrl);
    }
    return normalizePathKey(domainOrUrl);
}

/** 从旧版（v1：scheme 直接按域名存）迁移 */
function migrateFromV1(old: any): SchemeStore {
    const result: SchemeStore = {};
    if (!old || typeof old !== 'object') {
        return result;
    }
    for (const key of Object.keys(old)) {
        const scheme = old[key];
        if (!scheme || typeof scheme !== 'object') {
            continue;
        }
        result[key] = {
            key,
            scope: 'domain',
            updatedAt: scheme.createdAt || Date.now(),
            scheme,
        };
    }
    return result;
}

function readStore(): Promise<VersionedStore> {
    return new Promise((resolve) => {
        chrome.storage.local.get({[STORAGE_KEY]: null}, (result) => {
            if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError.message);
                resolve({version: SCHEME_VERSION, schemes: {}, modes: {}});
                return;
            }
            const stored = result[STORAGE_KEY] as any;
            if (!stored || typeof stored !== 'object') {
                resolve({version: SCHEME_VERSION, schemes: {}, modes: {}});
                return;
            }
            // 旧版本：schemes 里直接是 AIScheme
            if (stored.version !== SCHEME_VERSION) {
                const migrated = migrateFromV1(stored.schemes || stored);
                resolve({version: SCHEME_VERSION, schemes: migrated, modes: stored.modes || {}});
                return;
            }
            resolve({version: SCHEME_VERSION, schemes: stored.schemes || {}, modes: stored.modes || {}});
        });
    });
}

function writeStore(store: VersionedStore): Promise<void> {
    return new Promise((resolve) => {
        chrome.storage.local.set({[STORAGE_KEY]: store}, () => {
            resolve();
        });
    });
}

/**
 * 按 URL 查找最匹配的方案。
 * 优先级：精确路径 > 逐级缩短的路径前缀 > 域名级。
 */
export function findMatchingScheme(schemes: SchemeStore, url: string): SchemeRecord | null {
    const domain = normalizeDomain(url);
    if (!domain) {
        return null;
    }
    const pathKey = normalizePathKey(url);

    // 1) 精确路径命中
    if (pathKey && schemes[pathKey]) {
        return schemes[pathKey];
    }

    // 2) 逐级缩短路径：/a/b/c -> /a/b -> /a
    if (pathKey) {
        const withoutHost = pathKey.slice(domain.length);
        const segments = withoutHost.split('/').filter(Boolean);
        for (let i = segments.length - 1; i >= 1; i--) {
            const candidate = `${domain}/${segments.slice(0, i).join('/')}`;
            if (schemes[candidate]) {
                return schemes[candidate];
            }
        }
    }

    // 3) 域名级
    if (schemes[domain]) {
        return schemes[domain];
    }

    return null;
}

// ---------------- 同步缓存（供 background 的同步调用点使用） ----------------

let memoryCache: SchemeStore | null = null;
/** 站点配色偏好缓存（与 memoryCache 同步维护） */
let modeCache: SiteModeStore = {};

export function primeMemoryCache(schemes: SchemeStore): void {
    memoryCache = schemes;
}

export function getCachedSchemeSync(url: string): AIScheme | null {
    if (!memoryCache) {
        return null;
    }
    const record = findMatchingScheme(memoryCache, url);
    return record ? record.scheme : null;
}

/** 同步查询记录（含 scope 信息） */
export function getCachedRecordSync(url: string): SchemeRecord | null {
    if (!memoryCache) {
        return null;
    }
    return findMatchingScheme(memoryCache, url);
}

/** 同步查询某 URL 的配色偏好；未设置返回 null（表示跟随全局策略） */
export function getCachedSiteModeSync(url: string): SiteMode | null {
    const domain = normalizeDomain(url);
    if (!domain) {
        return null;
    }
    return modeCache[domain] || null;
}

// ---------------- 异步读写 ----------------

export async function loadAllSchemes(): Promise<SchemeStore> {
    const store = await readStore();
    memoryCache = store.schemes;
    modeCache = store.modes || {};
    return store.schemes;
}

/** 读取某 URL 匹配到的方案 */
export async function getScheme(url: string): Promise<AIScheme | null> {
    const store = await readStore();
    const record = findMatchingScheme(store.schemes, url);
    return record ? record.scheme : null;
}

/** 读取某 URL 匹配到的完整记录 */
export async function getRecord(url: string): Promise<SchemeRecord | null> {
    const store = await readStore();
    return findMatchingScheme(store.schemes, url);
}

/** 保存方案（可指定范围） */
export async function saveScheme(
    urlOrKey: string,
    scheme: AIScheme,
    scope: 'domain' | 'path' = 'domain',
): Promise<SchemeRecord> {
    const key = buildKey(urlOrKey, scope);
    const store = await readStore();
    const record: SchemeRecord = {
        key,
        scope,
        updatedAt: Date.now(),
        scheme,
    };
    if (!key) {
        return record;
    }
    store.schemes[key] = record;
    await writeStore(store);
    memoryCache = store.schemes;
    return record;
}

/**
 * 设置某站点的配色偏好。
 * mode = 'default' 时该站点忽略 AI 方案，改用 Dark Reader 默认深色。
 */
export async function setSiteMode(urlOrDomain: string, mode: SiteMode): Promise<void> {
    const domain = normalizeDomain(urlOrDomain);
    if (!domain) {
        return;
    }
    const store = await readStore();
    if (!store.modes) {
        store.modes = {};
    }
    store.modes[domain] = mode;
    await writeStore(store);
    modeCache = store.modes;
}

/** 读取某站点的配色偏好 */
export async function getSiteMode(urlOrDomain: string): Promise<SiteMode | null> {
    const domain = normalizeDomain(urlOrDomain);
    if (!domain) {
        return null;
    }
    const store = await readStore();
    return (store.modes && store.modes[domain]) || null;
}

/** 清除某站点的配色偏好（回到跟随全局策略） */
export async function clearSiteMode(urlOrDomain: string): Promise<void> {
    const domain = normalizeDomain(urlOrDomain);
    if (!domain) {
        return;
    }
    const store = await readStore();
    if (store.modes && store.modes[domain]) {
        delete store.modes[domain];
        await writeStore(store);
        modeCache = store.modes;
    }
}

/** 按 key 精确删除 */
export async function removeSchemeByKey(key: string): Promise<void> {    const store = await readStore();
    if (store.schemes[key]) {
        delete store.schemes[key];
        await writeStore(store);
        memoryCache = store.schemes;
    }
}

/** 删除与某 URL 匹配的方案 */
export async function removeScheme(url: string): Promise<void> {
    const store = await readStore();
    const record = findMatchingScheme(store.schemes, url);
    if (record) {
        delete store.schemes[record.key];
        await writeStore(store);
        memoryCache = store.schemes;
    }
}

/** 列出所有记录的 key */
export async function listSchemeKeys(): Promise<string[]> {
    const store = await readStore();
    return Object.keys(store.schemes);
}

/** 导出全部方案（供备份/分享） */
export async function exportSchemes(): Promise<{version: number; exportedAt: number; schemes: SchemeStore}> {
    const store = await readStore();
    return {
        version: SCHEME_VERSION,
        exportedAt: Date.now(),
        schemes: store.schemes,
    };
}

/**
 * 导入方案。
 * mode = 'merge'：同名 key 覆盖；mode = 'replace'：清空后导入。
 */
export async function importSchemes(
    payload: any,
    mode: 'merge' | 'replace' = 'merge',
): Promise<{imported: number; skipped: number}> {
    const incoming: SchemeStore = payload && payload.schemes ? payload.schemes : payload;
    if (!incoming || typeof incoming !== 'object') {
        return {imported: 0, skipped: 0};
    }

    const store = mode === 'replace'
        ? {version: SCHEME_VERSION, schemes: {} as SchemeStore}
        : await readStore();

    let imported = 0;
    let skipped = 0;

    for (const key of Object.keys(incoming)) {
        const raw: any = (incoming as any)[key];
        if (!raw || typeof raw !== 'object') {
            skipped++;
            continue;
        }
        // 兼容两种格式：新格式（含 scheme 字段）与旧格式（直接是 AIScheme）
        const record: SchemeRecord = raw.scheme
            ? {
                key,
                scope: raw.scope === 'path' ? 'path' : 'domain',
                updatedAt: raw.updatedAt || Date.now(),
                scheme: raw.scheme,
            }
            : {
                key,
                scope: 'domain',
                updatedAt: raw.createdAt || Date.now(),
                scheme: raw as AIScheme,
            };

        if (!record.scheme || typeof record.scheme !== 'object') {
            skipped++;
            continue;
        }
        store.schemes[key] = record;
        imported++;
    }

    await writeStore(store);
    memoryCache = store.schemes;
    return {imported, skipped};
}
