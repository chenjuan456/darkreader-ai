/**
 * 页面采集器：从当前页面提取「深色方案」所需的视觉特征。
 *
 * 设计原则（隐私优先）：
 * - 只采集结构、选择器、颜色，**绝不采集网页正文**
 * - 明确剔除密码框、支付表单、contenteditable、脚本内容
 * - 输出体积受控，避免 token 爆炸
 *
 * 该模块在 content script 环境执行，直接读 computed style。
 */

export interface OutlineEntry {
    tag: string;
    sel: string;
    bg?: string;
    color?: string;
    borderColor?: string;
}

export interface PageDigest {
    url: string;
    domain: string;
    title: string;
    /** 页面主背景/主文字色（最常见的组合） */
    base: {background: string; color: string};
    /** 有视觉意义的节点，上限控制 */
    outline: OutlineEntry[];
    /** :root 上的 CSS 自定义属性 */
    cssVars: Record<string, string>;
    /** 已经是暗色的区块选择器 */
    alreadyDark: string[];
    /** 框架特征 */
    framework: string;
    /** 页面主色（从 logo 采样） */
    brandColors: string[];
    /** 颜色直方图：出现频次最高的背景色 */
    topBackgrounds: Array<{color: string; count: number}>;
}

const MAX_OUTLINE = 100;
const MAX_CSSVARS = 60;
const MAX_ALREADY_DARK = 25;
const MAX_BRAND = 4;

/** 解析 rgb/rgba 字符串为亮度 0..1 */
export function luminance(color: string): number {
    const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(color || '');
    if (!m) {
        return -1;
    }
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // 相对亮度近似（够用即可，不做完整 sRGB 线性化）
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 判断是否为「有效」颜色值 */
function isRealColor(color: string | null | undefined): boolean {
    if (!color) {
        return false;
    }
    const c = color.trim().toLowerCase();
    if (!c || c === 'transparent' || c === 'inherit' || c === 'initial' || c === 'unset') {
        return false;
    }
    return /^rgba?\(|^#|^hsl/.test(c);
}

/** 生成一个尽量短且稳定的选择器 */
export function buildSelector(el: Element, root: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;

    while (node && node !== root && node.nodeType === 1 && parts.length < 4) {
        let part = node.tagName.toLowerCase();

        const id = node.getAttribute('id');
        if (id && /^[a-zA-Z][\w-]*$/.test(id) && id.length < 40) {
            parts.unshift(`#${id}`);
            break;
        }

        const cls = (node.getAttribute('class') || '')
            .split(/\s+/)
            .filter((c) => c && /^[a-zA-Z][\w-]*$/.test(c) && c.length < 40 && !/^(is-|has-)/.test(c))
            // 排除明显动态生成的 hash 类名
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
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        if (siblings.length > 1) {
            const idx = siblings.indexOf(node) + 1;
            if (idx > 1) {
                part += `:nth-of-type(${idx})`;
            }
        }
        parts.unshift(part);
        node = parent;
    }

    return parts.join(' > ') || el.tagName.toLowerCase();
}

/** 检测站点使用的 CSS 框架 */
function detectFramework(doc: Document): string {
    const html = doc.documentElement;
    const cls = (html.getAttribute('class') || '').toLowerCase();
    if (/\b(tailwind|tw-)/.test(cls) || doc.querySelector('[class*="tw-"],[class*="bg-slate-"],[class*="text-gray-"]')) {
        return 'tailwind';
    }
    if (doc.querySelector('.container-fluid,.row,.col-md-6,.navbar-expand-lg')) {
        return 'bootstrap';
    }
    if (doc.querySelector('.MuiButton-root,.MuiPaper-root')) {
        return 'mui';
    }
    if (doc.querySelector('.ant-btn,.ant-layout')) {
        return 'antd';
    }
    return 'unknown';
}

/** 读取 :root 上的自定义属性 */
function collectCssVars(doc: Document): Record<string, string> {
    const result: Record<string, string> = {};
    try {
        const rootStyle = getComputedStyle(doc.documentElement);
        // CSSStyleDeclaration 遍历成本高，用样式表反向收集更实际：
        // 但跨域样式表读不到 cssRules。这里走 computedStyle 的属性枚举。
        const names: string[] = [];
        for (let i = 0; i < rootStyle.length && names.length < 400; i++) {
            const prop = rootStyle[i];
            if (prop.startsWith('--')) {
                names.push(prop);
            }
        }
        for (const name of names) {
            const value = rootStyle.getPropertyValue(name).trim();
            if (value && isRealColor(value) && Object.keys(result).length < MAX_CSSVARS) {
                result[name] = value;
            }
        }
    } catch (err) {
        // 忽略：某些环境不支持遍历
    }
    return result;
}

/** 从页面中挑选出已是暗色的区块 */
function collectAlreadyDark(doc: Document, root: Element): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const nodes = Array.from(root.querySelectorAll('*')).slice(0, 3000);

    for (const el of nodes) {
        if (result.length >= MAX_ALREADY_DARK) {
            break;
        }
        // 跳过媒体元素
        const tag = el.tagName.toLowerCase();
        if (['img', 'video', 'canvas', 'svg', 'iframe', 'script', 'style'].includes(tag)) {
            continue;
        }
        const cs = getComputedStyle(el);
        const bg = cs.backgroundColor;
        if (!isRealColor(bg)) {
            continue;
        }
        const lum = luminance(bg);
        // 面积够大才算「区块」
        const rect = el.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 40) {
            continue;
        }
        if (lum >= 0 && lum < 0.22) {
            const sel = buildSelector(el, root);
            if (sel && !seen.has(sel)) {
                seen.add(sel);
                result.push(sel);
            }
        }
    }
    return result;
}

/** 采样页面主色：优先取 logo/header 里的图片周边元素的主色 */
function collectBrandColors(doc: Document): string[] {
    const colors: string[] = [];
    const add = (c: string) => {
        if (isRealColor(c) && !colors.includes(c) && colors.length < MAX_BRAND) {
            const lum = luminance(c);
            // 只保留有一定彩度的颜色（排除黑/白/灰）
            if (lum > 0.08 && lum < 0.92) {
                colors.push(c);
            }
        }
    };

    const candidates = doc.querySelectorAll('header a, header button, nav a, [class*="logo"], [class*="brand"], .btn-primary, [class*="accent"]');
    for (const el of Array.from(candidates).slice(0, 40)) {
        const cs = getComputedStyle(el);
        add(cs.backgroundColor);
        add(cs.color);
        add(cs.borderColor);
    }
    return colors;
}

/** 统计出现最多的背景色 */
function collectTopBackgrounds(root: Element): Array<{color: string; count: number}> {
    const counter = new Map<string, number>();
    const nodes = Array.from(root.querySelectorAll('*')).slice(0, 3000);

    for (const el of nodes) {
        const cs = getComputedStyle(el);
        const bg = cs.backgroundColor;
        if (!isRealColor(bg)) {
            continue;
        }
        const lum = luminance(bg);
        if (lum <= 0.02) {
            continue;
        }
        const key = bg.replace(/\s+/g, '');
        counter.set(key, (counter.get(key) || 0) + 1);
    }

    return Array.from(counter.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([color, count]) => ({color, count}));
}

/** 是否应该跳过该元素（隐私/无意义） */
function shouldSkip(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'meta', 'link', 'head'].includes(tag)) {
        return true;
    }
    if (tag === 'input') {
        const type = (el.getAttribute('type') || '').toLowerCase();
        // 密码、支付、隐藏都不采
        if (['password', 'hidden', 'file', 'submit', 'reset', 'button'].includes(type)) {
            return true;
        }
    }
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/^cc-|password/.test(autocomplete)) {
        return true;
    }
    if ((el as HTMLElement).isContentEditable) {
        return true;
    }
    // 隐私域：银行/支付相关常见的字段名
    const name = (el.getAttribute('name') || '').toLowerCase();
    if (/card|cvv|cvc|ssn|passport|iban/.test(name)) {
        return true;
    }
    // 完全不可见的元素
    try {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            return true;
        }
    } catch (err) {
        return true;
    }
    return false;
}

/** 采集页面视觉摘要 */
export function collectPageDigest(): PageDigest {
    const doc = document;
    const root = doc.body || doc.documentElement;
    const domain = location.hostname.toLowerCase();

    // 基础色：body 优先，退回 html
    const bodyStyle = getComputedStyle(doc.body || doc.documentElement);
    const htmlStyle = getComputedStyle(doc.documentElement);
    const baseBg = isRealColor(bodyStyle.backgroundColor) ? bodyStyle.backgroundColor
        : isRealColor(htmlStyle.backgroundColor) ? htmlStyle.backgroundColor
            : 'rgb(255, 255, 255)';
    const baseColor = isRealColor(bodyStyle.color) ? bodyStyle.color : 'rgb(0, 0, 0)';

    // 采样大纲
    const outline: OutlineEntry[] = [];
    const seenSel = new Set<string>();

    const walk = (el: Element, depth: number) => {
        if (outline.length >= MAX_OUTLINE || depth > 4) {
            return;
        }
        for (const child of Array.from(el.children)) {
            if (outline.length >= MAX_OUTLINE) {
                return;
            }
            if (shouldSkip(child)) {
                continue;
            }
            const cs = getComputedStyle(child);
            const bg = cs.backgroundColor;
            const color = cs.color;
            const hasBg = isRealColor(bg) && luminance(bg) > 0.02;
            const hasColor = isRealColor(color);
            const rect = child.getBoundingClientRect();

            // 只记录有视觉意义、且占地够大的节点
            if ((hasBg || hasColor) && rect.width >= 60 && rect.height >= 16) {
                const sel = buildSelector(child, root);
                if (sel && !seenSel.has(sel) && outline.length < MAX_OUTLINE) {
                    seenSel.add(sel);
                    const entry: OutlineEntry = {tag: child.tagName.toLowerCase(), sel};
                    if (hasBg) {
                        entry.bg = bg;
                    }
                    if (hasColor) {
                        entry.color = color;
                    }
                    if (isRealColor(cs.borderColor) && cs.borderStyle !== 'none') {
                        entry.borderColor = cs.borderColor;
                    }
                    outline.push(entry);
                }
            }
            walk(child, depth + 1);
        }
    };

    try {
        walk(root, 0);
    } catch (err) {
        // 忽略采集异常，返回已有结果
    }

    return {
        url: location.href.slice(0, 300),
        domain,
        title: (doc.title || '').slice(0, 120),
        base: {background: baseBg, color: baseColor},
        outline,
        cssVars: collectCssVars(doc),
        alreadyDark: collectAlreadyDark(doc, root),
        framework: detectFramework(doc),
        brandColors: collectBrandColors(doc),
        topBackgrounds: collectTopBackgrounds(root),
    };
}
