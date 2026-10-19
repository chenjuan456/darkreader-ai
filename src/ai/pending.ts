/**
 * 拾取待修复元素的临时状态。
 *
 * 为什么需要它：
 * Chrome 扩展 popup 失焦即销毁。用户点「选取问题元素」后必须去页面上点击，
 * 这时 popup 必然关闭，内存里的 pending 列表就没了。
 *
 * 解决办法：把待修复列表存进 chrome.storage.session（内存级、不落盘、关浏览器即清），
 * 重新打开 popup 时恢复。这样整个流程对用户是连贯的。
 */

const PENDING_KEY = 'ai-pending-picks';

/** 一条待修复记录 */
export interface PendingPick {
    selector: string;
    tag: string;
    background: string;
    color: string;
    textPreview: string;
    note: string;
    /** 所属标签页，避免不同页面串味 */
    tabId: number;
}

interface PendingStore {
    tabId: number;
    url: string;
    picks: PendingPick[];
}

function getSessionArea(): chrome.storage.StorageArea | null {
    // storage.session 需要 Chrome 102+，且 MV3 默认可用
    try {
        if (chrome.storage && chrome.storage.session) {
            return chrome.storage.session;
        }
    } catch (err) {
        // 忽略
    }
    return null;
}

function readRaw(): Promise<PendingStore | null> {
    const area = getSessionArea();
    if (!area) {
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        area.get({[PENDING_KEY]: null}, (result) => {
            if (chrome.runtime.lastError) {
                resolve(null);
                return;
            }
            resolve((result[PENDING_KEY] as PendingStore | null) || null);
        });
    });
}

function writeRaw(value: PendingStore | null): Promise<void> {
    const area = getSessionArea();
    if (!area) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        if (value === null) {
            area.remove(PENDING_KEY, () => resolve());
            return;
        }
        area.set({[PENDING_KEY]: value}, () => resolve());
    });
}

/** 读取指定标签页的待修复列表 */
export async function loadPending(tabId: number, url: string): Promise<PendingPick[]> {
    const data = await readRaw();
    if (!data) {
        return [];
    }
    // 标签页不符或页面已变，视为过期
    if (data.tabId !== tabId || data.url !== url) {
        return [];
    }
    return data.picks || [];
}

/** 覆盖保存某标签页的待修复列表 */
export async function savePending(tabId: number, url: string, picks: PendingPick[]): Promise<void> {
    if (!picks || picks.length === 0) {
        await clearPending();
        return;
    }
    await writeRaw({tabId, url, picks});
}

/** 追加一条（自动去重） */
export async function addPending(tabId: number, url: string, pick: PendingPick): Promise<PendingPick[]> {
    const existing = await loadPending(tabId, url);
    if (existing.some((p) => p.selector === pick.selector)) {
        return existing;
    }
    const next = [...existing, pick];
    await savePending(tabId, url, next);
    return next;
}

/** 清空 */
export async function clearPending(): Promise<void> {
    await writeRaw(null);
}
