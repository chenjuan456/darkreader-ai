/**
 * AI 方案生成编排：摘要 -> Prompt -> LLM -> 校验 -> 落盘
 */

import * as AIClient from './client';
import type {PageDigest} from './types';
import {buildFeedbackPrompt, buildUserPrompt, extractJSON, normalizeScheme, SCHEME_JSON_SCHEMA, type AIScheme, type UserFeedback} from './scheme';
import {loadAISettings} from './settings';

const SYSTEM_PROMPT = `你是 Dark Reader 浏览器扩展的站点适配专家。

背景：Dark Reader 已经把网页自动转成暗色，但有少数元素会出现颜色错误（白块残留、文字看不清、深色图标消失）。
你的任务是分析页面摘要，输出：(1) 一套与该站视觉风格协调的暗色配色；(2) 修复上述错误的规则。

## 字段说明

theme.darkSchemeBackgroundColor：主背景色。参考该站品牌色，选一个协调的深色。
theme.darkSchemeTextColor：主文字色，需与背景有足够对比度。
theme.brightness / contrast / sepia：通常 100 / 100 / 0。

fixes.invert：需要反色的元素选择器数组（深色图标在暗背景上看不见时使用）。
fixes.css：补充 CSS 字符串，每条属性必须带 !important。
fixes.ignoreInlineStyle：不要分析其内联样式的元素。
fixes.ignoreImageAnalysis：不要分析其背景图的元素。

## 关键约束

1. 颜色占位符：在 fixes.css 里表达颜色时用 \${white} 或 \${black}，引擎会自动换算成暗色。
   不要写死 #ffffff、rgb(255,255,255)，那会导致暗色模式下依然是白的。
   例：.card { background-color: \${white} !important; }

2. 可用 CSS 变量：var(--darkreader-neutral-background)、var(--darkreader-neutral-text)

3. 宁可少写，不要多写。只修明确会出错的地方。

4. 选择器要短且稳定：优先 class 或 id，避免 nth-child 和动态 hash 类名。

5. 不要处理 <img>/<video> 内容本身，扩展会自动保护。

6. 若页面已经是暗色（base.background 亮度低、alreadyDark 多），theme 与之一致，fixes 留空，
   并在 reason 里说明。

## 摘要字段

base            主背景色与主文字色
outline         有视觉意义的节点：选择器 + 背景色 + 文字色
cssVars         站点 CSS 变量，往往是配色中枢
alreadyDark     已暗色区块（不要重复处理）
brandColors     品牌主色
topBackgrounds  高频背景色
framework       CSS 框架`;

export interface GenerateResult {
    ok: boolean;
    scheme?: AIScheme;
    error?: string;
    durationMs: number;
    usage?: {promptTokens?: number; completionTokens?: number; totalTokens?: number};
}

/**
 * 生成某站点的深色方案。
 * 阶段：本地摘要（调用方提供）-> LLM -> 解析 -> 规范化
 */
export async function generateScheme(digest: PageDigest): Promise<GenerateResult> {
    return await runGeneration(digest, null, []);
}

/**
 * 基于已有方案 + 用户指出的问题元素，做增量修复。
 *
 * 与首次生成的区别在于 prompt：明确「只修这几处，不要推翻重来」，
 * 避免原本正常的部分被改坏。
 */
export async function refineScheme(
    digest: PageDigest,
    current: {theme?: any; fixes?: any},
    feedbacks: UserFeedback[],
): Promise<GenerateResult> {
    if (!feedbacks || feedbacks.length === 0) {
        return {ok: false, error: '没有待修复的元素', durationMs: 0};
    }
    return await runGeneration(digest, current, feedbacks);
}

async function runGeneration(
    digest: PageDigest,
    current: {theme?: any; fixes?: any} | null,
    feedbacks: UserFeedback[],
): Promise<GenerateResult> {
    const start = Date.now();

    const settings = await loadAISettings();
    if (!settings.enabled) {
        return {ok: false, error: 'AI 功能未启用（请在设置中打开）', durationMs: 0};
    }

    const isRefine = Boolean(current) && feedbacks.length > 0;
    const userPrompt = isRefine
        ? buildFeedbackPrompt(digest, current!, feedbacks)
        : buildUserPrompt(digest);

    const result = await AIClient.chat(settings, {
        messages: [
            {role: 'system', content: SYSTEM_PROMPT},
            {role: 'user', content: userPrompt},
        ],
        jsonSchema: {name: 'dark_scheme', schema: SCHEME_JSON_SCHEMA},
        temperature: 0.2,
        maxTokens: settings.maxTokens || 8000,
    });

    if (!result.ok) {
        return {ok: false, error: result.error, durationMs: Date.now() - start, usage: result.usage};
    }

    const parsed = extractJSON(result.content);
    if (!parsed) {
        return {
            ok: false,
            error: `模型返回的内容不是合法 JSON。开头片段：${result.content.trim().slice(0, 200)}`,
            durationMs: Date.now() - start,
            usage: result.usage,
        };
    }

    const scheme = normalizeScheme(parsed, settings.model);
    if (!scheme) {
        return {
            ok: false,
            error: '模型返回的方案结构不符合预期',
            durationMs: Date.now() - start,
            usage: result.usage,
        };
    }

    return {
        ok: true,
        scheme,
        durationMs: Date.now() - start,
        usage: result.usage,
    };
}

