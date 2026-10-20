/**
 * AI 深色方案的生成与校验。
 *
 * 输出契约刻意对齐 Dark Reader 的两套现成结构：
 * - theme  -> Partial<Theme>（配色）
 * - fixes  -> DynamicThemeFix（站点修复规则）
 * 这样产物可以直接喂进引擎，不需要二次翻译。
 */

import type {DynamicThemeFix, Theme} from '../definitions';

import type {PageDigest} from './types';

export interface AIScheme {
    /** 配色方案 */
    theme: Partial<Theme>;
    /** 站点修复规则 */
    fixes: DynamicThemeFix;
    /** AI 给出的理由（便于人工判断是否可信） */
    reason: string;
    /** 生成时间戳 */
    createdAt: number;
    /** 生成时使用的模型 */
    model: string;
}

/** JSON Schema：约束模型输出，降低解析失败率 */
export const SCHEME_JSON_SCHEMA = {
    type: 'object',
    properties: {
        theme: {
            type: 'object',
            properties: {
                darkSchemeBackgroundColor: {type: 'string'},
                darkSchemeTextColor: {type: 'string'},
                brightness: {type: 'number'},
                contrast: {type: 'number'},
                sepia: {type: 'number'},
            },
            required: ['darkSchemeBackgroundColor', 'darkSchemeTextColor'],
        },
        fixes: {
            type: 'object',
            properties: {
                invert: {type: 'array', items: {type: 'string'}},
                css: {type: 'string'},
                ignoreInlineStyle: {type: 'array', items: {type: 'string'}},
                ignoreImageAnalysis: {type: 'array', items: {type: 'string'}},
            },
            required: ['invert', 'css'],
        },
        reason: {type: 'string'},
    },
    required: ['theme', 'fixes', 'reason'],
};

/** 把摘要压成提示词；控制体积，避免 token 爆炸 */
export function buildUserPrompt(digest: PageDigest): string {
    const lines: string[] = [];

    lines.push(`站点: ${digest.domain}`);
    lines.push(`标题: ${digest.title}`);
    lines.push(`框架: ${digest.framework}`);
    lines.push('');
    lines.push(`主背景: ${digest.base.background}`);
    lines.push(`主文字: ${digest.base.color}`);
    lines.push('');

    if (digest.brandColors.length) {
        lines.push(`品牌色: ${digest.brandColors.join(', ')}`);
        lines.push('');
    }

    if (digest.topBackgrounds.length) {
        lines.push('高频背景色:');
        for (const t of digest.topBackgrounds) {
            lines.push(`  ${t.color}  x${t.count}`);
        }
        lines.push('');
    }

    const varNames = Object.keys(digest.cssVars);
    if (varNames.length) {
        lines.push('CSS 变量:');
        for (const name of varNames) {
            lines.push(`  ${name}: ${digest.cssVars[name]}`);
        }
        lines.push('');
    }

    if (digest.alreadyDark.length) {
        lines.push('已是暗色的区块（不要动）:');
        for (const sel of digest.alreadyDark) {
            lines.push(`  ${sel}`);
        }
        lines.push('');
    }

    if (digest.outline.length) {
        lines.push('页面结构（选择器 / 背景 / 文字）:');
        for (const o of digest.outline) {
            const parts = [o.sel];
            if (o.bg) {
                parts.push(`bg=${o.bg}`);
            }
            if (o.color) {
                parts.push(`fg=${o.color}`);
            }
            lines.push(`  ${parts.join('  ')}`);
        }
    }

    return lines.join('\n');
}

/** 用户反馈的一条「这里不对」 */
export interface UserFeedback {
    selector: string;
    tag: string;
    background: string;
    color: string;
    borderColor: string;
    width: number;
    height: number;
    textPreview: string;
    /** 用户补充说明，可选 */
    note: string;
}

/**
 * 构建「基于已有方案 + 用户反馈」的增量修复提示词。
 *
 * 与首次生成的区别：明确告知模型「方案基本可用，只修这些问题」，
 * 避免它推翻重来导致原本正常的部分也被改坏。
 */
export function buildFeedbackPrompt(
    digest: PageDigest,
    current: {theme?: any; fixes?: any},
    feedbacks: UserFeedback[],
): string {
    const lines: string[] = [];

    lines.push('## 背景');
    lines.push('你已经为这个站点生成过一套深色方案，整体可用，但有少数元素仍然是亮的或看不清。');
    lines.push('用户已经点出了这些元素。你的任务：**只针对这些元素补充修复规则**，不要改动其余部分的配色。');
    lines.push('');

    lines.push('## 当前方案');
    const th = current.theme || {};
    lines.push(`背景: ${th.darkSchemeBackgroundColor || '(默认)'}`);
    lines.push(`文字: ${th.darkSchemeTextColor || '(默认)'}`);
    const fx = current.fixes || {};
    if (Array.isArray(fx.invert) && fx.invert.length) {
        lines.push(`已反色: ${fx.invert.join(', ')}`);
    }
    if (typeof fx.css === 'string' && fx.css.trim()) {
        lines.push('已应用的自定义 CSS:');
        lines.push('```css');
        lines.push(fx.css.slice(0, 3000));
        lines.push('```');
    }
    lines.push('');

    lines.push('## 用户指出的问题元素');
    feedbacks.forEach((f, i) => {
        lines.push(`${i + 1}. 选择器: ${f.selector}`);
        lines.push(`   标签: <${f.tag}>  尺寸: ${f.width}x${f.height}`);
        lines.push(`   当前背景色: ${f.background}`);
        lines.push(`   当前文字色: ${f.color}`);
        if (f.borderColor && f.borderColor !== 'rgba(0, 0, 0, 0)') {
            lines.push(`   当前边框色: ${f.borderColor}`);
        }
        if (f.textPreview) {
            lines.push(`   元素内文字: "${f.textPreview}"`);
        }
        if (f.note) {
            lines.push(`   用户描述: ${f.note}`);
        }
        lines.push('');
    });

    lines.push('## 页面整体情况（供参考，不要重新设计配色）');
    lines.push(`主背景: ${digest.base.background}   主文字: ${digest.base.color}`);
    lines.push(`框架: ${digest.framework}`);
    if (digest.alreadyDark.length) {
        lines.push(`已是暗色的区块（不要动）: ${digest.alreadyDark.slice(0, 10).join(', ')}`);
    }
    lines.push('');

    lines.push('## 要求');
    lines.push('1. theme 保持与当前方案一致，除非用户指出的问题确实需要调整主色。');
    lines.push('2. 针对每个问题元素，用 CSS 规则修正背景色或文字色。');
    lines.push('3. 颜色一律用 ${white} / ${black} 占位符，或 var(--darkreader-neutral-background) / var(--darkreader-neutral-text)。');
    lines.push('4. 保留已有且有效的规则，只追加新的修正。');
    lines.push('5. 在 reason 中说明每个元素是怎么修的。');

    return lines.join('\n');
}

export function extractJSON(text: string): any {
    const trimmed = text.trim();

    // 直接是 JSON
    try {
        return JSON.parse(trimmed);
    } catch (err) {
        // 继续尝试
    }

    // ```json ... ``` 包裹
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    if (fence) {
        try {
            return JSON.parse(fence[1].trim());
        } catch (err) {
            // 继续
        }
    }

    // 最外层大括号
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(trimmed.slice(start, end + 1));
        } catch (err) {
            // 放弃
        }
    }

    return null;
}

/**
 * 校验选择器是否「看起来合法」。
 *
 * 注意：这里**不能**用 document.querySelector 验证。
 * 本模块运行在 background service worker 里，没有 DOM，
 * 那样的写法会因 `document is not defined` 直接返回 false，
 * 导致 AI 给出的所有 invert / ignore* 选择器被整体丢弃（曾经的真实 bug）。
 *
 * 因此改用纯语法检查。即使有漏网的非法选择器，浏览器解析样式表时
 * 也只会丢弃那一条规则，不会影响其他规则。
 */
function isValidSelector(sel: unknown): boolean {
    if (typeof sel !== 'string') {
        return false;
    }
    const s = sel.trim();
    if (!s || s.length > 300) {
        return false;
    }
    // 会破坏样式表结构的字符。
    // 先把引号内的内容剔除，避免误伤 [data-x="a!b"] 这类合法属性值。
    const withoutQuoted = s.replace(/"[^"]*"|'[^']*'/g, '""');
    if (/[{};@\\!]/.test(withoutQuoted)) {
        return false;
    }
    // 方括号与圆括号必须配平
    for (const [open, close] of [['[', ']'], ['(', ')']]) {
        let depth = 0;
        for (const ch of s) {
            if (ch === open) {
                depth++;
            } else if (ch === close) {
                depth--;
                if (depth < 0) {
                    return false;
                }
            }
        }
        if (depth !== 0) {
            return false;
        }
    }
    // 不能以组合符或逗号开头/结尾
    if (/^[>+~,]/.test(s) || /[>+~,]$/.test(s)) {
        return false;
    }
    // 至少要有一个有效的选择器构成（标签/类/id/属性/伪类/通配）
    if (!/[a-zA-Z#.*:[]/.test(s)) {
        return false;
    }
    return true;
}

/** 校验颜色值基本合法 */
function sanitizeColor(value: unknown, fallback: string): string {
    if (typeof value !== 'string') {
        return fallback;
    }
    const v = value.trim();
    if (/^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\(/i.test(v) || /^hsla?\(/i.test(v)) {
        return v;
    }
    return fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!isFinite(n)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, n));
}

/**
 * 把模型输出规范化为可信的 AIScheme。
 * 任何不合法的字段都会被丢弃或替换为安全默认值 —— 绝不把脏数据喂进引擎。
 */
export function normalizeScheme(raw: any, model: string): AIScheme | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const rawTheme = raw.theme && typeof raw.theme === 'object' ? raw.theme : {};
    const rawFixes = raw.fixes && typeof raw.fixes === 'object' ? raw.fixes : {};

    const theme: Partial<Theme> = {
        darkSchemeBackgroundColor: sanitizeColor(rawTheme.darkSchemeBackgroundColor, '#181a1b'),
        darkSchemeTextColor: sanitizeColor(rawTheme.darkSchemeTextColor, '#e8e6e3'),
    };
    if (rawTheme.brightness !== undefined) {
        theme.brightness = clampNumber(rawTheme.brightness, 50, 150, 100);
    }
    if (rawTheme.contrast !== undefined) {
        theme.contrast = clampNumber(rawTheme.contrast, 50, 150, 100);
    }
    if (rawTheme.sepia !== undefined) {
        theme.sepia = clampNumber(rawTheme.sepia, 0, 100, 0);
    }

    const asSelectorArray = (v: unknown): string[] => {
        if (!Array.isArray(v)) {
            return [];
        }
        return v.filter(isValidSelector).slice(0, 30);
    };

    let css = typeof rawFixes.css === 'string' ? rawFixes.css : '';
    // 限制体积并过滤危险内容（不允许 @import / url() 外链）
    css = css.slice(0, 8000)
        .replace(/@import[^;]*;?/gi, '')
        .replace(/url\(\s*['"]?https?:[^)]*\)/gi, 'none');

    const fixes: DynamicThemeFix = {
        url: [],
        invert: asSelectorArray(rawFixes.invert),
        css,
        ignoreInlineStyle: asSelectorArray(rawFixes.ignoreInlineStyle),
        ignoreImageAnalysis: asSelectorArray(rawFixes.ignoreImageAnalysis),
        ignoreCSSUrl: [],
        disableStyleSheetsProxy: false,
        disableCustomElementRegistryProxy: false,
    };

    return {
        theme,
        fixes,
        reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 500) : '',
        createdAt: Date.now(),
        model,
    };
}

