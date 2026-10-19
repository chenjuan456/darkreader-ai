/**
 * 页面内执行的图标检测。
 *
 * 关键约束：chrome.scripting.executeScript({func}) 会序列化该函数，
 * 不能引用外部作用域。因此与 icons.ts 有一份等价的内联实现 ——
 * icons.ts 供单元测试与 content script 使用，本文件供运行时注入使用。
 */

import type {InvisibleIcon} from './icons';

export function detectInvisibleIconsInPage(): InvisibleIcon[] {
    const MIN_ICON_SIZE = 8;
    const MAX_ICON_SIZE = 64;
    const ICON_DARK_MAX = 0.30;
    const BG_DARK_MAX = 0.35;
    const BG_LIGHT_MIN = 0.75;
    const MIN_CONTRAST = 0.22;
    const MAX_SCAN_NODES = 1500;
    const MAX_RESULTS = 40;

    function parseLuminance(color: string): number {
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
            return -1;
        }
        const r = Number(m[1]);
        const g = Number(m[2]);
        const b = Number(m[3]);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }

    function sampleImageLuminance(img: HTMLImageElement): number {
        try {
            if (!img.complete || img.naturalWidth === 0) {
                return -1;
            }
            const canvas = document.createElement('canvas');
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
                if (data[i + 3] < 32) {
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
            const darkRatio = darkPixels / opaquePixels;
            return darkRatio >= 0.7 ? 0.15 : 0.6;
        } catch (err) {
            return -1;
        }
    }

    function estimateIconLuminance(el: Element): number {
        const tag = el.tagName.toLowerCase();

        if (tag === 'svg') {
            const cs = getComputedStyle(el);
            const values = [cs.fill, cs.stroke, cs.color];
            for (let i = 0; i < values.length; i++) {
                const lum = parseLuminance(values[i]);
                if (lum >= 0) {
                    return lum;
                }
            }
            const child = el.querySelector('path, circle, rect, polygon');
            if (child) {
                const ccs = getComputedStyle(child);
                const l1 = parseLuminance(ccs.fill);
                if (l1 >= 0) {
                    return l1;
                }
                const l2 = parseLuminance(ccs.color);
                if (l2 >= 0) {
                    return l2;
                }
            }
            return -1;
        }

        if (tag === 'img') {
            return sampleImageLuminance(el as HTMLImageElement);
        }

        const cs = getComputedStyle(el);
        return parseLuminance(cs.color);
    }

    function getEffectiveBackgroundLuminance(el: Element): number {
        let node: Element | null = el.parentElement;
        let depth = 0;
        while (node && depth < 6) {
            const lum = parseLuminance(getComputedStyle(node).backgroundColor);
            if (lum >= 0) {
                return lum;
            }
            node = node.parentElement;
            depth++;
        }
        if (document.body) {
            return parseLuminance(getComputedStyle(document.body).backgroundColor);
        }
        return -1;
    }

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

    function looksLikeIcon(el: Element): boolean {
        const cls = (el.getAttribute('class') || '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        return /(^|[\s-])(icon|fa|glyph|svg|ico|symbol)([\s-]|$)/.test(cls)
            || /icon|图标/.test(aria)
            || role === 'img';
    }

    const root = document.body || document.documentElement;
    if (!root) {
        return [];
    }

    const results: InvisibleIcon[] = [];
    const seen: {[key: string]: boolean} = {};

    const candidates: Element[] = [];
    try {
        const all = root.querySelectorAll('img, svg, i, span, div');
        const limit = Math.min(all.length, MAX_SCAN_NODES);
        for (let i = 0; i < limit; i++) {
            const el = all[i];
            const tag = el.tagName.toLowerCase();
            if (tag !== 'img' && tag !== 'svg') {
                if (!looksLikeIcon(el)) {
                    continue;
                }
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

    for (let i = 0; i < candidates.length && results.length < MAX_RESULTS; i++) {
        const el = candidates[i];
        let rect: DOMRect;
        try {
            rect = el.getBoundingClientRect();
        } catch (err) {
            continue;
        }
        const w = rect.width;
        const h = rect.height;

        if (w > MAX_ICON_SIZE || h > MAX_ICON_SIZE) {
            continue;
        }
        if (w < MIN_ICON_SIZE && h < MIN_ICON_SIZE) {
            continue;
        }
        if (w === 0 || h === 0) {
            continue;
        }
        const ratio = w / h;
        if (ratio > 4 || ratio < 0.25) {
            continue;
        }

        const cs = getComputedStyle(el);

        const ownBgLum = parseLuminance(cs.backgroundColor);
        if (ownBgLum >= 0) {
            continue;
        }
        if (cs.borderWidth && cs.borderWidth !== '0px' && cs.borderStyle !== 'none') {
            continue;
        }

        const iconLum = estimateIconLuminance(el);
        if (iconLum < 0 || iconLum > ICON_DARK_MAX) {
            continue;
        }

        const bgLum = getEffectiveBackgroundLuminance(el);
        if (bgLum < 0) {
            continue;
        }

        const bgWillBeDark = bgLum >= BG_LIGHT_MIN;
        const bgIsDark = bgLum < BG_DARK_MAX;
        if (!bgWillBeDark && !bgIsDark) {
            continue;
        }
        if (bgIsDark) {
            const contrast = Math.abs(iconLum - bgLum);
            if (contrast >= MIN_CONTRAST) {
                continue;
            }
        }

        const selector = buildIconSelector(el);
        if (!selector || seen[selector]) {
            continue;
        }
        seen[selector] = true;

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

