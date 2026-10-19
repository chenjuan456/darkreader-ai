/**
 * 页面内的元素拾取器。
 *
 * 用于「指出 AI 方案哪里不对」：用户点某个仍然出错的元素，
 * 我们把它的选择器与计算样式抓回来，作为反馈喂给模型。
 *
 * 关键约束：这段代码通过 chrome.scripting.executeScript 注入，
 * 必须完全自包含，不能引用外部变量。
 */

export interface PickedElement {
    /** 尽量短且稳定的选择器 */
    selector: string;
    /** 元素标签名 */
    tag: string;
    /** 计算后的背景色 */
    background: string;
    /** 计算后的文字色 */
    color: string;
    /** 边框色 */
    borderColor: string;
    /** 元素尺寸，便于判断是否为区块 */
    width: number;
    height: number;
    /** 元素上的简要文字（截断，用于用户确认选对了） */
    textPreview: string;
}

/**
 * 启动拾取模式，返回一个 Promise，resolve 用户点选的元素。
 * 注入到页面后立即执行。
 */
export function startElementPicker(): Promise<PickedElement> {
    return new Promise<PickedElement>((resolve) => {
        const OVERLAY_ID = 'darkreader-ai-picker-overlay';
        const LABEL_ID = 'darkreader-ai-picker-label';
        const STYLE_ID = 'darkreader-ai-picker-style';

        // 清理可能残留的旧节点
        for (const id of [OVERLAY_ID, LABEL_ID, STYLE_ID]) {
            const old = document.getElementById(id);
            if (old) {
                old.remove();
            }
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
            '#darkreader-ai-picker-overlay{',
            'position:fixed;pointer-events:none;z-index:2147483646;',
            'border:2px solid #8b5cf6;background:rgba(139,92,246,0.12);',
            'transition:all .08s ease-out;display:none;box-sizing:border-box;',
            '}',
            '#darkreader-ai-picker-label{',
            'position:fixed;pointer-events:none;z-index:2147483647;',
            'background:#8b5cf6;color:#fff;font:11px/1.4 monospace;',
            'padding:2px 6px;border-radius:3px;white-space:nowrap;',
            'max-width:90vw;overflow:hidden;text-overflow:ellipsis;display:none;',
            '}',
        ].join('');
        document.documentElement.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        document.documentElement.appendChild(overlay);

        const label = document.createElement('div');
        label.id = LABEL_ID;
        document.documentElement.appendChild(label);

        let current: Element | null = null;

        function buildSelector(el: Element): string {
            const parts: string[] = [];
            let node: Element | null = el;
            let depth = 0;

            while (node && node !== document.body && node.nodeType === 1 && depth < 4) {
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

        function isIgnored(el: Element): boolean {
            if (el === overlay || el === label || el === style) {
                return true;
            }
            const id = el.getAttribute('id') || '';
            return id.indexOf('darkreader-ai-picker') === 0;
        }

        function showHighlight(el: Element) {
            const rect = el.getBoundingClientRect();
            overlay.style.display = 'block';
            overlay.style.left = rect.left + 'px';
            overlay.style.top = rect.top + 'px';
            overlay.style.width = rect.width + 'px';
            overlay.style.height = rect.height + 'px';

            const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
            const desc = el.tagName.toLowerCase() + (cls ? '.' + cls : '');

            label.textContent = desc;
            label.style.display = 'block';
            const labelTop = rect.top > 20 ? rect.top - 20 : rect.bottom + 4;
            label.style.left = Math.max(2, rect.left) + 'px';
            label.style.top = labelTop + 'px';
        }

        function hideHighlight() {
            overlay.style.display = 'none';
            label.style.display = 'none';
        }

        function onMove(e: MouseEvent) {
            const el = document.elementFromPoint(e.clientX, e.clientY);
            if (!el || isIgnored(el)) {
                return;
            }
            current = el;
            showHighlight(el);
        }

        function onClick(e: MouseEvent) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const el = current || document.elementFromPoint(e.clientX, e.clientY);
            if (!el || isIgnored(el)) {
                return;
            }

            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();

            // 只取直接文本，避免把整棵子树的文字带出去
            let textPreview = '';
            for (const child of Array.prototype.slice.call(el.childNodes)) {
                if (child.nodeType === 3) {
                    textPreview += child.textContent || '';
                }
            }
            textPreview = textPreview.replace(/\s+/g, ' ').trim().slice(0, 40);

            const picked: PickedElement = {
                selector: buildSelector(el),
                tag: el.tagName.toLowerCase(),
                background: cs.backgroundColor,
                color: cs.color,
                borderColor: cs.borderColor,
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                textPreview,
            };

            cleanup();
            resolve(picked);
        }

        function onKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape') {
                e.preventDefault();
                cleanup();
                resolve(null as any);
            }
        }

        function cleanup() {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('keydown', onKeyDown, true);
            hideHighlight();
            overlay.remove();
            label.remove();
            style.remove();
        }

        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKeyDown, true);
    });
}
