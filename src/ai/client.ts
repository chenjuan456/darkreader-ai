/**
 * OpenAI 兼容端点的极简客户端。
 *
 * 刻意不引 openai SDK：
 * - 减小体积（扩展已 3.1MB）
 * - 兼容所有「OpenAI 格式」的服务：OpenAI / Azure / DeepSeek / Kimi / Groq /
 *   Ollama / LM Studio / OneAPI 网关等
 *
 * 所有请求必须从 background service worker 发出 —— content script 受页面
 * 同源策略约束，且绝不应该接触 API Key。
 */

import type {AISettings} from './settings';
import {buildChatCompletionsURL, buildModelsURL, parseExtraHeaders} from './settings';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface AICallResult {
    ok: boolean;
    content: string;
    error?: string;
    /** 便于排查的服务端原始响应 */
    raw?: string;
    /** 耗时（毫秒） */
    durationMs: number;
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
    };
}

interface RequestOptions {
    messages: ChatMessage[];
    /** 要求模型返回 JSON */
    jsonMode?: boolean;
    /** JSON Schema，走 response_format 结构化输出 */
    jsonSchema?: {name: string; schema: object};
    temperature?: number;
    maxTokens?: number;
}

function buildHeaders(settings: AISettings): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...parseExtraHeaders(settings.extraHeaders),
    };
    // 若用户已在 extraHeaders 里指定了鉴权（如 Azure 用 api-key），则不再覆盖
    if (!hasAuthHeader(headers) && settings.apiKey) {
        headers.Authorization = `Bearer ${settings.apiKey}`;
    }
    return headers;
}

/** 判断请求头里是否已带鉴权字段 */
function hasAuthHeader(headers: Record<string, string>): boolean {
    return Object.keys(headers).some((k) => {
        const lower = k.toLowerCase();
        return lower === 'authorization' || lower === 'api-key' || lower === 'x-api-key';
    });
}

/** 是否具备发起请求所需的鉴权信息 */
function hasCredentials(settings: AISettings): boolean {
    return Boolean(settings.apiKey) || hasAuthHeader(parseExtraHeaders(settings.extraHeaders));
}

function withTimeout(timeoutMs: number): {signal: AbortSignal; cleanup: () => void} {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer),
    };
}

function extractErrorMessage(status: number, body: string): string {
    try {
        const parsed = JSON.parse(body);
        const msg = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
        if (typeof msg === 'string' && msg) {
            return `HTTP ${status}: ${msg}`;
        }
    } catch (err) {
        // 不是 JSON，落到下面
    }
    const trimmed = body.trim().slice(0, 300);
    return `HTTP ${status}${trimmed ? ': ' + trimmed : ''}`;
}

/**
 * 从一个 chat completion 响应里取出正文。
 *
 * 「OpenAI 兼容」实际有多个变体，这里按优先级依次尝试：
 * 1. choices[0].message.content        标准 OpenAI
 * 2. choices[0].text                   旧版 completions / 部分兼容实现
 * 3. choices[0].delta.content          流式响应（非流式请求一般不会有）
 * 4. output_text                       Responses API
 * 5. content / response / text         某些轻量网关
 * 6. output[]（Responses API 的结构化输出）
 * 7. Anthropic 风格的 content[] 数组
 */
function extractContent(parsed: any): string | null {
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;

    if (choice) {
        // 1
        const c = choice.message && choice.message.content;
        if (typeof c === 'string') {
            return c;
        }
        // content 可能是分段数组（某些实现）
        if (Array.isArray(c)) {
            const joined = c.map((part: any) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
            if (joined) {
                return joined;
            }
        }
        // 2
        if (typeof choice.text === 'string') {
            return choice.text;
        }
        // 3
        const d = choice.delta && choice.delta.content;
        if (typeof d === 'string') {
            return d;
        }
    }

    // 4
    if (typeof parsed.output_text === 'string') {
        return parsed.output_text;
    }

    // 5
    for (const key of ['content', 'response', 'text', 'result', 'answer']) {
        if (typeof parsed[key] === 'string' && parsed[key]) {
            return parsed[key];
        }
    }

    // 6 Responses API: output[].content[].text
    if (Array.isArray(parsed.output)) {
        const parts: string[] = [];
        for (const item of parsed.output) {
            if (Array.isArray(item?.content)) {
                for (const c of item.content) {
                    if (typeof c?.text === 'string') {
                        parts.push(c.text);
                    }
                }
            }
        }
        if (parts.length) {
            return parts.join('');
        }
    }

    // 7 Anthropic: content[] 数组
    if (Array.isArray(parsed.content)) {
        const parts = parsed.content
            .map((c: any) => (typeof c === 'string' ? c : c?.text ?? ''))
            .filter(Boolean);
        if (parts.length) {
            return parts.join('');
        }
    }

    return null;
}

/**
 * 识别「推理模型吃光了 token」这种情况。
 *
 * 推理模型（DeepSeek-R1、QwQ、Qwen3-thinking、o1 等）会先输出
 * reasoning_content 再输出 content。当 max_tokens 不够时，
 * 思考过程把预算耗尽，正式回答就完全没有了。
 */
function detectReasoningTruncation(parsed: any): {isReasoning: boolean; finishReason: string | null} {
    const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
    const message = choice?.message;
    const hasReasoning = Boolean(
        (typeof message?.reasoning_content === 'string' && message.reasoning_content)
        || (typeof message?.reasoning === 'string' && message.reasoning)
        || (typeof message?.thinking === 'string' && message.thinking)
    );
    return {
        isReasoning: hasReasoning,
        finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    };
}

/** 描述响应结构，便于诊断（不泄露内容，只描述形状） */
function describeResponseShape(parsed: any): string {
    if (!parsed || typeof parsed !== 'object') {
        return `顶层类型为 ${typeof parsed}`;
    }
    const keys = Object.keys(parsed).slice(0, 8);
    let detail = `顶层字段 [${keys.join(', ')}]`;

    if (Array.isArray(parsed.choices)) {
        if (parsed.choices.length === 0) {
            detail += '；choices 为空数组';
        } else {
            const c = parsed.choices[0];
            detail += `；choices[0] 字段 [${Object.keys(c || {}).join(', ')}]`;
            if (c?.message && typeof c.message === 'object') {
                detail += `；message 字段 [${Object.keys(c.message).join(', ')}]`;
            }
        }
    } else if ('choices' in parsed) {
        detail += '；choices 类型异常';
    }

    if (parsed.error) {
        const msg = parsed.error?.message ?? parsed.error;
        detail += `；错误: ${typeof msg === 'string' ? msg.slice(0, 200) : '未知'}`;
    }

    return detail;
}

/**
 * 发起一次 chat completion 请求。
 * 任何失败都以 {ok:false, error} 返回，绝不抛异常 —— 调用方据此静默回退到原生行为。
 */
export async function chat(settings: AISettings, options: RequestOptions): Promise<AICallResult> {
    const start = Date.now();
    const duration = () => Date.now() - start;

    if (!hasCredentials(settings)) {
        return {ok: false, content: '', error: '未配置 API Key', durationMs: 0};
    }
    if (!settings.baseURL.trim()) {
        return {ok: false, content: '', error: '未配置 Base URL', durationMs: 0};
    }
    if (!settings.model.trim()) {
        return {ok: false, content: '', error: '未配置模型名', durationMs: 0};
    }

    const payload: Record<string, unknown> = {
        model: settings.model.trim(),
        messages: options.messages,
        temperature: options.temperature ?? 0.3,
    };
    if (options.maxTokens) {
        payload.max_tokens = options.maxTokens;
    }
    if (options.jsonSchema) {
        payload.response_format = {
            type: 'json_schema',
            json_schema: {
                name: options.jsonSchema.name,
                strict: false,
                schema: options.jsonSchema.schema,
            },
        };
    } else if (options.jsonMode) {
        payload.response_format = {type: 'json_object'};
    }

    const {signal, cleanup} = withTimeout(settings.timeoutMs || 60000);

    try {
        const response = await fetch(buildChatCompletionsURL(settings.baseURL), {
            method: 'POST',
            headers: buildHeaders(settings),
            body: JSON.stringify(payload),
            signal,
        });

        const raw = await response.text();

        if (!response.ok) {
            return {ok: false, content: '', error: extractErrorMessage(response.status, raw), raw, durationMs: duration()};
        }

        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            return {ok: false, content: '', error: '响应不是合法 JSON', raw, durationMs: duration()};
        }

        const content = extractContent(parsed);
        if (typeof content !== 'string' || (content === '' && extractContent(parsed) === null)) {
            const {isReasoning, finishReason} = detectReasoningTruncation(parsed);

            if (isReasoning) {
                const reason = finishReason === 'length'
                    ? 'token 上限被思考过程耗尽'
                    : finishReason
                        ? `finish_reason=${finishReason}`
                        : '未返回正文';
                return {
                    ok: false,
                    content: '',
                    error: `这是推理模型（返回了 reasoning_content），但响应中没有 content（${reason}）。`
                        + `推理模型会先用大量 token 思考，建议在设置中把「最大输出 token」调大到 8000 以上，`
                        + `或改用非推理模型（如 gpt-4o-mini、deepseek-chat）。`,
                    raw,
                    durationMs: duration(),
                };
            }

            return {
                ok: false,
                content: '',
                error: `响应结构无法解析：${describeResponseShape(parsed)}`,
                raw,
                durationMs: duration(),
            };
        }

        return {
            ok: true,
            content,
            raw,
            durationMs: duration(),
            usage: parsed?.usage ? {
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens,
                totalTokens: parsed.usage.total_tokens,
            } : undefined,
        };
    } catch (err: any) {
        if (err?.name === 'AbortError') {
            return {ok: false, content: '', error: `请求超时（${settings.timeoutMs}ms）`, durationMs: duration()};
        }
        return {ok: false, content: '', error: `网络错误: ${err?.message ?? String(err)}`, durationMs: duration()};
    } finally {
        cleanup();
    }
}

export interface ConnectivityResult {
    ok: boolean;
    message: string;
    durationMs: number;
    modelEcho?: string;
    /** 实际请求的 URL，便于排查配置错误 */
    endpoint?: string;
}

/**
 * 连通性测试。
 *
 * 策略：先探 /models（便宜、快，不用生成 token）。
 * 有些兼容端点不实现 /models，则回退到一次最小 chat 请求。
 * 这样既省钱又能覆盖绝大多数服务。
 */
export async function testConnectivity(settings: AISettings): Promise<ConnectivityResult> {
    const start = Date.now();

    if (!hasCredentials(settings)) {
        return {ok: false, message: '未配置 API Key', durationMs: 0};
    }
    if (!normalizeURLOrEmpty(settings.baseURL)) {
        return {ok: false, message: '未配置 Base URL', durationMs: 0};
    }

    const {signal, cleanup} = withTimeout(Math.min(settings.timeoutMs || 60000, 15000));
    const endpoint = buildModelsURL(settings.baseURL);

    try {
        const response = await fetch(endpoint, {
            method: 'GET',
            headers: buildHeaders(settings),
            signal,
        });
        const raw = await response.text();
        const durationMs = Date.now() - start;

        if (response.ok) {
            let count = 0;
            let hasModel = false;
            try {
                const parsed = JSON.parse(raw);
                const list = parsed?.data ?? parsed?.models ?? [];
                if (Array.isArray(list)) {
                    count = list.length;
                    hasModel = list.some((item: any) => {
                        const id = item?.id ?? item?.name ?? item?.model;
                        return typeof id === 'string' && id === settings.model.trim();
                    });
                }
            } catch (err) {
                // 响应不是标准格式，但 HTTP 200 也算通
            }
            const suffix = count > 0 ? `，可用模型 ${count} 个${hasModel ? `，包含 ${settings.model}` : ''}` : '';
            return {ok: true, message: `连接成功${suffix}`, durationMs, modelEcho: hasModel ? settings.model : undefined, endpoint};
        }

        // /models 不可用，回退到最小 chat 请求
        if (response.status === 404 || response.status === 405) {
            const chatResult = await chat(settings, {
                messages: [{role: 'user', content: 'ping'}],
                maxTokens: 8,
            });
            if (chatResult.ok) {
                return {
                    ok: true,
                    message: `连接成功（/models 不可用，已用 chat 验证）`,
                    durationMs: chatResult.durationMs,
                    endpoint,
                };
            }
            return {ok: false, message: chatResult.error ?? '未知错误', durationMs: chatResult.durationMs, endpoint};
        }

        return {ok: false, message: extractErrorMessage(response.status, raw), durationMs, endpoint};
    } catch (err: any) {
        const durationMs = Date.now() - start;
        if (err?.name === 'AbortError') {
            return {ok: false, message: '连接超时', durationMs, endpoint};
        }
        return {ok: false, message: `网络错误: ${err?.message ?? String(err)}`, durationMs, endpoint};
    } finally {
        cleanup();
    }
}

function normalizeURLOrEmpty(url: string): string {
    return (url ?? '').trim();
}
