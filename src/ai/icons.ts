/**
 * 图标可见性检测（纯本地启发式，不调用 AI）。
 *
 * 解决的问题：网页转暗色后，「本身是深色的图标」在暗背景上几乎看不见。
 *
 * 思路：对每个候选图标，比较「图标自身亮度」与「父容器背景亮度」。
 * 两者都暗、且对比度不足时，判定为不可见，给它加 invert 反色。
 *
 * 设计原则：
 * - 严格限制候选范围（尺寸窗口、排除照片、排除已有视觉容器的元素），
 *   宁可漏判也不要误伤深色图片
 * - 结果确定、可复现，不依赖网络或模型
 * - 拿不到像素时（跨域图片）退回保守判断，不硬猜
 */

/** 单个被判定为不可见的图标 */
export interface InvisibleIcon {
    selector: string;
    /** 'img' | 'svg' | 'font' | 'bg' */
    kind: string;
    /** 图标亮度 0..1，-1 表示无法判定 */
    iconLuminance: number;
    /** 父容器背景亮度 0..1 */
    bgLuminance: number;
    width: number;
    height: number;
}

/** 图标尺寸窗口：小于下限的可能是装饰点，大于上限的通常是插图 */
const MIN_ICON_SIZE = 8;
const MAX_ICON_SIZE = 64;

/** 判定阈值 */
const ICON_DARK_MAX = 0.30;   // 图标亮度低于此值算「深色」
const BG_DARK_MAX = 0.35;     // 容器背景亮度低于此值算「暗」
const BG_LIGHT_MIN = 0.75;    // 容器背景亮度高于此值算「亮」（转暗后必成暗底）
const MIN_CONTRAST = 0.22;    // 两者亮度差小于此值则认为对比不足

/** 扫描上限，避免大页面卡顿 */
const MAX_SCAN_NODES = 1500;
const MAX_RESULTS = 40;

/** 解析 rgb/rgba 为相对亮度 0..1；失败返回 -1 */
export function parseLuminance(color: string): number {
    if (!color) {
        return -1;
    }
    const c = color.trim().toLowerCase();
    if (c === 'transparent' || c === 'none' || c === 'inherit' || c === 'initial') {
        return -1;
    }
    const m = /rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?/.exec(c);
    if (!m) {
        return -1;
    }
    const alpha = m[4] !== undefined ? Number(m[4]) : 1;
    if (alpha < 0.1) {
        // 几乎透明，等同于没有背景
        return -1;
    }
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * 估算图标自身亮度。
 * 返回值 -1 表示无法判断（调用方应跳过，不要硬猜）。
 */
export function estimateIconLuminance(el: Element): number {
    const tag = el.tagName.toLowerCase();

    // 内联 SVG：优先看 fill，其次 stroke，最后 color
    if (tag === 'svg' || el instanceof SVGElement) {
        const cs = getComputedStyle(el as unknown as Element);
        const candidates = [cs.fill, cs.stroke, cs.color];
        for (const value of candidates) {
            const lum = parseLuminance(value);
            if (lum >= 0) {
                return lum;
            }
        }
        // fill 可能是 url(#gradient)，退回到子元素查找
        const child = el.querySelector('path, circle, rect, polygon');
        if (child) {
            const childCs = getComputedStyle(child);
            const lum = parseLuminance(childCs.fill) >= 0
                ? parseLuminance(childCs.fill)
                : parseLuminance(childCs.color);
            if (lum >= 0) {
                return lum;
            }
        }
        return -1;
    }

    // <img> / <picture>：像素级判断需要 canvas，跨域会失败
    if (tag === 'img') {
        return sampleImageLuminance(el as HTMLImageElement);
    }

    // icon font / 其它：读文字颜色
    const cs = getComputedStyle(el);
    const lum = parseLuminance(cs.color);
    if (lum >= 0) {
        return lum;
    }
    // 有些图标用 background-image，读不到内容，退回背景色（极少见）
    return -1;
}

/**
 * 用 canvas 采样图片亮度。
 * 跨域图片会污染 canvas 导致 getImageData 抛错 —— 此时返回 -1，不硬判。
 */
export function sampleImageLuminance(img: HTMLImageElement): number {
    try {
        if (!img.complete || img.naturalWidth === 0) {
            return -1;
        }
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (w === 0 || h === 0) {
            return -1;
        }
        const canvas = document.createElement('canvas');
        // 采样到 16x16 足够判断明暗
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return -1;
        }
        ctx.drawImage(img, 0, 0, 16, 16);
        const data = ctx.getImageData(0, 0, 16, 16).data;

        let darkPixels = 0;
        let opaquePixels = 0;
        for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            if (a < 32) {
                continue;
            }
            opaquePixels++;
            const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
            if (lum < 0.4) {
                darkPixels++;
            }
        }
        if (opaquePixels === 0) {
            return -1;
        }
        // 深色像素占比高 => 整体偏暗，返回一个偏低的亮度估计
        const darkRatio = darkPixels / opaquePixels;
        return darkRatio >= 0.7 ? 0.15 : 0.6;
    } catch (err) {
        // 跨域或其它原因读不到像素
        return -1;
    }
}

/** 取最近的非透明祖先背景色亮度 */
function getEffectiveBackgroundLuminance(el: Element): number {
    let node: Element | null = el.parentElement;
    let depth = 0;
    while (node && depth < 6) {
        const cs = getComputedStyle(node);
        const lum = parseLuminance(cs.backgroundColor);
        if (lum >= 0) {
            return lum;
        }
        node = node.parentElement;
        depth++;
    }
    // 一路都是透明，退回 body
    if (document.body) {
        return parseLuminance(getComputedStyle(document.body).backgroundColor);
    }
    return -1;
}

/** 生成短选择器 */
function buildIconSelector(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;

    while (node && node !== document.body && node.nodeType === 1 && depth < 5) {
        let part = node.tagName.toLowerCase();

        const id = node.getAttribute('id');
        if (id && /^[a-zA-Z][\w-]*$/.test(id) && id.length < 50) {
            parts.unshift('#' + id);
            break;
        }

        const cls = (node.getAttribute('class') || '')
            .split(/\s+/)
            .filter((c) => c && /^[a-zA-Z][\w-]*$/.test(c) && c.length < 50)
            .filter((c) => !/^(is-|has-|js-)/.test(c))
            .filter((c) => !/^[a-z]{1,3}[0-9]{4,}$/i.test(c))
            .filter((c) => !/^(css|sc|jsx|emotion)-/.test(c))
            .slice(0, 2);

        if (cls.length) {
            part += '.' + cls.join('.');
            parts.unshift(part);
            break;
        }

        const parent: Element | null = node.parentElement;
        if (!parent) {
            break;
        }
        const siblings = Array.prototype.slice.call(parent.children)
            .filter((c: Element) => c.tagName === node!.tagName);
        if (siblings.length > 1) {
            const idx = siblings.indexOf(node) + 1;
            if (idx > 1) {
                part += ':nth-of-type(' + idx + ')';
            }
        }
        parts.unshift(part);
        node = parent;
        depth++;
    }

    return parts.join(' > ') || el.tagName.toLowerCase();
}

/** 是否为候选图标容器（类名启发） */
function looksLikeIcon(el: Element): boolean {
    const cls = (el.getAttribute('class') || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    return /(^|[\s-])(icon|fa|glyph|svg|ico|symbol)([\s-]|$)/.test(cls)
        || /icon|图标/.test(aria)
        || role === 'img';
}

/**
 * 检测「因深色而看不见的图标」。
 *
 * @param root 扫描根节点，通常是 document.body
 * @returns 需要反色的元素选择器列表（去重）
 */
export function detectInvisibleIcons(root: Element = document.body): InvisibleIcon[] {
    if (!root) {
        return [];
    }

    const results: InvisibleIcon[] = [];
    const seen = new Set<string>();

    // 候选集合：小尺寸 img/svg + 类名像图标的小元素
    const candidates: Element[] = [];
    try {
        const all = root.querySelectorAll('img, svg, i, span, div');
        const limit = Math.min(all.length, MAX_SCAN_NODES);

        for (let i = 0; i < limit; i++) {
            const el = all[i];
            const tag = el.tagName.toLowerCase();

            // i / span / div 只接受「看起来像图标」的
            if (tag !== 'img' && tag !== 'svg') {
                if (!looksLikeIcon(el)) {
                    continue;
                }
                // 类名像图标但里面还有大段文字，说明不是图标
                const text = (el.textContent || '').trim();
                if (text.length > 4) {
                    continue;
                }
            }
            candidates.push(el);
        }
    } catch (err) {
        return [];
    }

    for (const el of candidates) {
        if (results.length >= MAX_RESULTS) {
            break;
        }

        let rect: DOMRect;
        try {
            rect = el.getBoundingClientRect();
        } catch (err) {
            continue;
        }

        const w = rect.width;
        const h = rect.height;

        // 尺寸窗口
        if (w > MAX_ICON_SIZE || h > MAX_ICON_SIZE) {
            continue;
        }
        if (w < MIN_ICON_SIZE && h < MIN_ICON_SIZE) {
            continue;
        }
        // 长宽比异常（如分割线）跳过
        if (w === 0 || h === 0) {
            continue;
        }
        const ratio = w / h;
        if (ratio > 4 || ratio < 0.25) {
            continue;
        }

        const cs = getComputedStyle(el);

        // 排除：元素本身有明显背景色或边框（说明是按钮/卡片，不是裸图标）
        const ownBgLum = parseLuminance(cs.backgroundColor);
        if (ownBgLum >= 0) {
            continue;
        }
        if (cs.borderWidth && cs.borderWidth !== '0px' && cs.borderStyle !== 'none') {
            continue;
        }

        // 图标自身亮度
        const iconLum = estimateIconLuminance(el);
        if (iconLum < 0) {
            // 读不到就跳过，不硬猜
            continue;
        }
        if (iconLum > ICON_DARK_MAX) {
            // 图标本身不暗，不需要反色
            continue;
        }

        // 容器背景亮度（此处读的是「原始页面」的颜色，
        // 但 Dark Reader 会把亮背景转暗，所以只要原本是亮的，
        // 转换后就是暗的 —— 这正是图标消失的条件）
        const bgLum = getEffectiveBackgroundLuminance(el);
        if (bgLum < 0) {
            continue;
        }

        // 原本背景是「亮」的（会转成暗色），图标是暗的 => 转换后消失
        const bgWillBeDark = bgLum >= BG_LIGHT_MIN;
        // 原本背景已经是暗的
        const bgIsDark = bgLum < BG_DARK_MAX;

        if (!bgWillBeDark && !bgIsDark) {
            // 中灰背景：转换后仍是不深不浅的灰，深色图标通常还能看见，
            // 为避免误伤（中灰底上常放彩色插画），保守跳过
            continue;
        }

        // 对比度检查：暗图标 + 亮背景 = 原本可见，但有转化风险
        // 暗图标 + 暗背景 = 转换后不可见（最需要处理）
        if (bgIsDark) {
            const contrast = Math.abs(iconLum - bgLum);
            if (contrast >= MIN_CONTRAST) {
                continue;
            }
        }

        const selector = buildIconSelector(el);
        if (!selector || seen.has(selector)) {
            continue;
        }
        seen.add(selector);

        results.push({
            selector,
            kind: el.tagName.toLowerCase(),
            iconLuminance: Math.round(iconLum * 100) / 100,
            bgLuminance: Math.round(bgLum * 100) / 100,
            width: Math.round(w),
            height: Math.round(h),
        });
    }

    return results;
}
