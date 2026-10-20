/**
 * 页面内执行的采集函数。
 *
 * 关键约束：chrome.scripting.executeScript({func}) 会把这个函数序列化后注入页面，
 * **它不能引用任何外部作用域的变量或 import**，所有工具函数必须内联定义。
 *
 * 因此这里刻意与 collect.ts 分开：collect.ts 供 content script 直接使用，
 * 本文件提供一份完全自包含的等价实现。
 */

import type {PageDigest} from './types';

export function collectDigestInPage(): PageDigest {
    const MAX_OUTLINE = 100;
    const MAX_CSSVARS = 60;
    const MAX_ALREADY_DARK = 25;
    const MAX_BRAND = 4;

    function luminance(color: string): number {
        const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(color || '');
        if (!m) {
            return -1;
        }
        const r = Number(m[1]);
        const g = Number(m[2]);
        const b = Number(m[3]);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }

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

    function buildSelector(el: Element, root: Element): string {
        const parts: string[] = [];
        let node: Element | null = el;
        while (node && node !== root && node.nodeType === 1 && parts.length < 4) {
            let part = node.tagName.toLowerCase();
            const id = node.getAttribute('id');
            if (id && /^[a-zA-Z][\w-]*$/.test(id) && id.length < 40) {
                parts.unshift('#' + id);
                break;
            }
            const cls = (node.getAttribute('class') || '')
                .split(/\s+/)
                .filter((c) => c && /^[a-zA-Z][\w-]*$/.test(c) && c.length < 40 && !/^(is-|has-)/.test(c))
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
            const sibs = Array.prototype.slice.call(parent.children).filter((c: Element) => c.tagName === node!.tagName);
            if (sibs.length > 1) {
                const idx = sibs.indexOf(node) + 1;
                if (idx > 1) {
                    part += ':nth-of-type(' + idx + ')';
                }
            }
            parts.unshift(part);
            node = parent;
        }
        return parts.join(' > ') || el.tagName.toLowerCase();
    }

    function detectFramework(doc: Document): string {
        const cls = (doc.documentElement.getAttribute('class') || '').toLowerCase();
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

    function shouldSkip(el: Element): boolean {
        const tag = el.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'template', 'meta', 'link', 'head'].indexOf(tag) >= 0) {
            return true;
        }
        if (tag === 'input') {
            const type = (el.getAttribute('type') || '').toLowerCase();
            if (['password', 'hidden', 'file', 'submit', 'reset', 'button'].indexOf(type) >= 0) {
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
        const name = (el.getAttribute('name') || '').toLowerCase();
        if (/card|cvv|cvc|ssn|passport|iban/.test(name)) {
            return true;
        }
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

    const doc = document;
    const root = doc.body || doc.documentElement;
    const domain = location.hostname.toLowerCase();

    const bodyStyle = getComputedStyle(doc.body || doc.documentElement);
    const htmlStyle = getComputedStyle(doc.documentElement);
    const baseBg = isRealColor(bodyStyle.backgroundColor) ? bodyStyle.backgroundColor
        : isRealColor(htmlStyle.backgroundColor) ? htmlStyle.backgroundColor : 'rgb(255, 255, 255)';
    const baseColor = isRealColor(bodyStyle.color) ? bodyStyle.color : 'rgb(0, 0, 0)';

    // CSS 变量
    const cssVars: {[key: string]: string} = {};
    try {
        const rootStyle = getComputedStyle(doc.documentElement);
        const names: string[] = [];
        for (let i = 0; i < rootStyle.length && names.length < 400; i++) {
            const prop = rootStyle[i];
            if (prop.indexOf('--') === 0) {
                names.push(prop);
            }
        }
        for (let i = 0; i < names.length; i++) {
            const value = rootStyle.getPropertyValue(names[i]).trim();
            if (value && isRealColor(value) && Object.keys(cssVars).length < MAX_CSSVARS) {
                cssVars[names[i]] = value;
            }
        }
    } catch (err) {
        // 忽略
    }

    // 大纲
    const outline: Array<{tag: string; sel: string; bg?: string; color?: string; borderColor?: string}> = [];
    const seenSel: {[key: string]: boolean} = {};
    const walk = (el: Element, depth: number) => {
        if (outline.length >= MAX_OUTLINE || depth > 4) {
            return;
        }
        const children = Array.prototype.slice.call(el.children) as Element[];
        for (let i = 0; i < children.length; i++) {
            if (outline.length >= MAX_OUTLINE) {
                return;
            }
            const child = children[i];
            if (shouldSkip(child)) {
                continue;
            }
            const cs = getComputedStyle(child);
            const bg = cs.backgroundColor;
            const color = cs.color;
            const hasBg = isRealColor(bg) && luminance(bg) > 0.02;
            const hasColor = isRealColor(color);
            let rect = {width: 0, height: 0};
            try {
                rect = child.getBoundingClientRect();
            } catch (err) {
                // 忽略
            }
            if ((hasBg || hasColor) && rect.width >= 60 && rect.height >= 16) {
                const sel = buildSelector(child, root);
                if (sel && !seenSel[sel]) {
                    seenSel[sel] = true;
                    const entry: any = {tag: child.tagName.toLowerCase(), sel};
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
        // 忽略
    }

    // 已是暗色的区块
    const alreadyDark: string[] = [];
    const seenDark: {[key: string]: boolean} = {};
    try {
        const nodes = Array.prototype.slice.call(root.querySelectorAll('*')).slice(0, 3000) as Element[];
        for (let i = 0; i < nodes.length && alreadyDark.length < MAX_ALREADY_DARK; i++) {
            const el = nodes[i];
            const tag = el.tagName.toLowerCase();
            if (['img', 'video', 'canvas', 'svg', 'iframe', 'script', 'style'].indexOf(tag) >= 0) {
                continue;
            }
            const cs = getComputedStyle(el);
            const bg = cs.backgroundColor;
            if (!isRealColor(bg)) {
                continue;
            }
            const lum = luminance(bg);
            const rect = el.getBoundingClientRect();
            if (rect.width < 120 || rect.height < 40) {
                continue;
            }
            if (lum >= 0 && lum < 0.22) {
                const sel = buildSelector(el, root);
                if (sel && !seenDark[sel]) {
                    seenDark[sel] = true;
                    alreadyDark.push(sel);
                }
            }
        }
    } catch (err) {
        // 忽略
    }

    // 品牌色
    const brandColors: string[] = [];
    try {
        const add = (c: string) => {
            if (isRealColor(c) && brandColors.indexOf(c) < 0 && brandColors.length < MAX_BRAND) {
                const lum = luminance(c);
                if (lum > 0.08 && lum < 0.92) {
                    brandColors.push(c);
                }
            }
        };
        const cands = doc.querySelectorAll('header a, header button, nav a, [class*="logo"], [class*="brand"], .btn-primary, [class*="accent"]');
        const list = Array.prototype.slice.call(cands).slice(0, 40) as Element[];
        for (let i = 0; i < list.length; i++) {
            const cs = getComputedStyle(list[i]);
            add(cs.backgroundColor);
            add(cs.color);
            add(cs.borderColor);
        }
    } catch (err) {
        // 忽略
    }

    // 高频背景色
    const counter: {[key: string]: number} = {};
    try {
        const nodes = Array.prototype.slice.call(root.querySelectorAll('*')).slice(0, 3000) as Element[];
        for (let i = 0; i < nodes.length; i++) {
            const cs = getComputedStyle(nodes[i]);
            const bg = cs.backgroundColor;
            if (!isRealColor(bg)) {
                continue;
            }
            if (luminance(bg) <= 0.02) {
                continue;
            }
            const key = bg.replace(/\s+/g, '');
            counter[key] = (counter[key] || 0) + 1;
        }
    } catch (err) {
        // 忽略
    }
    const topBackgrounds = Object.keys(counter)
        .map((color) => ({color, count: counter[color]}))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

    return {
        url: location.href.slice(0, 300),
        domain,
        title: (doc.title || '').slice(0, 120),
        base: {background: baseBg, color: baseColor},
        outline,
        cssVars,
        alreadyDark,
        framework: detectFramework(doc),
        brandColors,
        topBackgrounds,
    };
}

