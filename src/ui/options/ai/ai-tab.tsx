import {m} from 'malevic';
import {getContext} from 'malevic/dom';

import type {AIConfig, AIStore} from '../../../ai/settings';
import {createDefaultConfig} from '../../../ai/settings';
import type {ViewProps} from '../../../definitions';
import {Button, CheckButton, CopyButton} from '../../controls';
import TextBox from '../../controls/textbox';

type TestState =
    | {status: 'idle'}
    | {status: 'testing'}
    | {status: 'ok'; message: string; durationMs: number; endpoint?: string}
    | {status: 'error'; message: string; endpoint?: string};

interface AITabStore {
    data: AIStore | null;
    test: TestState;
    saving: boolean;
    loading: boolean;
    loadError: string | null;
    savedAt: number | null;
    /** 展开的「高级」区域 */
    advanced: boolean;
    /** 导入导出结果提示 */
    transferMsg: {ok: boolean; text: string} | null;
    /** 文本快捷导入的输入内容 */
    importText: string;
    /** 文本快捷导入的结果提示 */
    importMsg: {ok: boolean; text: string} | null;
}

/** 文本导入的幽灵提示（placeholder） */
const IMPORT_PLACEHOLDER = [
    'https://api.deepseek.com/v1',
    'sk-xxxxxxxxxxxxxxxxxxxxxxxx',
    'deepseek-chat',
].join('\n');

/**
 * 解析「三行文本」为一份配置。
 *
 * 约定：第一行 Base URL，第二行 API Key，第三行模型。
 * 容错策略（避免用户因为多一个空格或标签就导入失败）：
 * - 忽略空行与以 # 开头的注释行
 * - 允许 "url:" / "apikey:" / "model:" 这类标签前缀
 * - 模型行可省略（之后可在表单里补）
 */
export function parseConfigText(text: string): {baseURL: string; apiKey: string; model: string} | null {
    const lines = (text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));

    if (lines.length < 2) {
        return null;
    }

    const stripLabel = (s: string) => s
        .replace(/^(base\s*url|url|接口地址|地址)\s*[:：=]\s*/i, '')
        .replace(/^(api\s*key|apikey|key|密钥)\s*[:：=]\s*/i, '')
        .replace(/^(model|模型)\s*[:：=]\s*/i, '')
        .trim();

    const baseURL = stripLabel(lines[0]);
    const apiKey = stripLabel(lines[1]);
    const model = lines[2] ? stripLabel(lines[2]) : '';

    if (!baseURL || !/^https?:\/\//i.test(baseURL)) {
        return null;
    }
    if (!apiKey) {
        return null;
    }

    return {baseURL, apiKey, model};
}

/** 从 Base URL 里取一个便于识别的配置名 */
function configNameFromURL(baseURL: string): string {
    try {
        const host = new URL(baseURL).hostname.toLowerCase();
        return host.replace(/^api\./, '') || '导入的配置';
    } catch (err) {
        return '导入的配置';
    }
}

function sendMessage(type: string, data?: any): Promise<any> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({type, data}, (response) => {
            if (chrome.runtime.lastError) {
                resolve({error: chrome.runtime.lastError.message});
                return;
            }
            resolve(response);
        });
    });
}

function Field(props: {label: string; description?: string}, ...children: Malevic.Child[]): Malevic.Child {
    return (
        <div class="ai-tab__field">
            <label class="ai-tab__label">{props.label}</label>
            {...children}
            {props.description ? <div class="ai-tab__description">{props.description}</div> : null}
        </div>
    );
}

function buildErrorReport(
    test: {message: string; endpoint?: string},
    config: AIConfig,
): string {
    const lines: string[] = [];
    lines.push('=== Dark Reader AI 连接测试报告 ===');
    lines.push(`时间: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('[错误信息]');
    lines.push(test.message || '(空)');
    if (test.endpoint) {
        lines.push(`请求地址: ${test.endpoint}`);
    }
    lines.push('');
    lines.push('[配置]');
    lines.push(`名称: ${config.name}`);
    lines.push(`Base URL: ${config.baseURL || '(空)'}`);
    lines.push(`模型: ${config.model || '(空)'}`);
    lines.push(`API Key: ${config.apiKey ? `已设置（长度 ${config.apiKey.length}）` : '未设置'}`);
    lines.push(`自定义请求头: ${config.extraHeaders ? config.extraHeaders : '(无)'}`);
    lines.push(`超时: ${config.timeoutMs}ms`);
    lines.push(`最大输出 token: ${config.maxTokens}`);
    lines.push('');
    lines.push('[环境]');
    lines.push(`扩展版本: ${chrome.runtime.getManifest().version}`);
    try {
        lines.push(`平台: ${navigator.platform}`);
        lines.push(`UA: ${navigator.userAgent}`);
    } catch (err) {
        // 忽略
    }
    lines.push('');
    lines.push('[说明] 本报告不包含完整 API Key。');
    return lines.join('\n');
}

export function AITab(props: ViewProps): Malevic.Child {
    const context = getContext();
    const store = context.getStore<AITabStore>({
        data: null,
        test: {status: 'idle'},
        saving: false,
        loading: false,
        loadError: null,
        savedAt: null,
        advanced: false,
        transferMsg: null,
        importText: '',
        importMsg: null,
    });

    if (!store.loading && store.data === null) {
        store.loading = true;
        sendMessage('ui-bg-ai-get-store')
            .then((response) => {
                store.loading = false;
                if (response && response.data) {
                    store.data = response.data as AIStore;
                } else {
                    store.loadError = (response && response.error) || '无法读取配置（后台无响应）';
                }
                context.refresh();
            })
            .catch((err) => {
                store.loading = false;
                store.loadError = `读取配置异常: ${err?.message ?? String(err)}`;
                context.refresh();
            });
    }

    function persist(next: AIStore, markSaved = true): Promise<void> {
        store.data = next;
        store.test = {status: 'idle'};
        store.saving = true;
        context.refresh();
        return sendMessage('ui-bg-ai-save-store', next).then((response) => {
            store.saving = false;
            if (response && response.data) {
                store.data = response.data as AIStore;
                if (markSaved) {
                    store.savedAt = Date.now();
                }
            } else {
                store.loadError = (response && response.error) || '保存失败（后台无响应）';
            }
            context.refresh();
        });
    }

    /** 切换「仅 AI 模式」：保存后让后台把新策略下发到所有标签页 */
    function setAIOnly(value: boolean) {
        if (!store.data) {
            return;
        }
        persist({...store.data, aiOnly: value}, false).then(() => {
            sendMessage('ui-bg-ai-reapply');
        });
    }

    /**
     * 从三行纯文本导入一份新配置，并立即切换到它。
     * 导入后各字段照常可改（表单就是普通输入框）。
     */
    function importFromText() {
        if (!store.data) {
            return;
        }
        const parsed = parseConfigText(store.importText);
        if (!parsed) {
            store.importMsg = {
                ok: false,
                text: '格式不对：需要第一行 Base URL（以 http 开头）、第二行 API Key，第三行模型可选',
            };
            context.refresh();
            return;
        }

        const base = createDefaultConfig(configNameFromURL(parsed.baseURL));
        const config: AIConfig = {
            ...base,
            baseURL: parsed.baseURL,
            apiKey: parsed.apiKey,
            model: parsed.model || base.model,
            // 能导入说明用户想用，直接置为启用
            enabled: true,
        };

        const next: AIStore = {
            ...store.data,
            configs: [...store.data.configs, config],
            activeId: config.id,
        };

        const count = next.configs.length;
        persist(next, true).then(() => {
            store.importText = '';
            store.importMsg = {ok: true, text: `已导入「${config.name}」，共 ${count} 套配置，可在上方直接修改`};
            context.refresh();
            sendMessage('ui-bg-ai-reapply');
        });
    }

    function updateActive(patch: Partial<AIConfig>, persistNow = false) {
        if (!store.data) {
            return;
        }
        const configs = store.data.configs.map((c) => (
            c.id === store.data!.activeId ? {...c, ...patch} : c
        ));
        const next = {...store.data, configs};
        if (persistNow) {
            persist(next);
        } else {
            store.data = next;
            store.savedAt = null;
            context.refresh();
        }
    }

    function switchConfig(id: string) {
        if (!store.data) {
            return;
        }
        persist({...store.data, activeId: id}, false);
    }

    function addConfig() {
        if (!store.data) {
            return;
        }
        const config = createDefaultConfig(`配置 ${store.data.configs.length + 1}`);
        persist({
            configs: [...store.data.configs, config],
            activeId: config.id,
        }, false);
    }

    function removeConfig(id: string) {
        if (!store.data || store.data.configs.length <= 1) {
            return;
        }
        const configs = store.data.configs.filter((c) => c.id !== id);
        const activeId = store.data.activeId === id ? configs[0].id : store.data.activeId;
        persist({configs, activeId}, false);
    }

    async function runTest() {
        const data = store.data;
        if (!data) {
            return;
        }
        const active = data.configs.find((c) => c.id === data.activeId);
        if (!active) {
            return;
        }
        store.test = {status: 'testing'};
        context.refresh();
        try {
            const response = await sendMessage('ui-bg-ai-test-connection', active);
            if (!response) {
                store.test = {status: 'error', message: '后台无响应（扩展可能未重新加载）'};
            } else if (response.error) {
                store.test = {status: 'error', message: response.error};
            } else {
                const result = response.data;
                if (!result) {
                    store.test = {status: 'error', message: '后台返回空结果'};
                } else if (result.ok) {
                    store.test = {status: 'ok', message: result.message, durationMs: result.durationMs, endpoint: result.endpoint};
                } else {
                    store.test = {status: 'error', message: result.message || '未知错误', endpoint: result.endpoint};
                }
            }
        } catch (err: any) {
            store.test = {status: 'error', message: `调用异常: ${err?.message ?? String(err)}`};
        }
        context.refresh();
    }

    function saveNow() {
        if (!store.data) {
            return;
        }
        persist(store.data, true);
    }

    /** 导出全部方案为 JSON 文件 */
    function exportSchemes() {
        sendMessage('ui-bg-ai-export-schemes').then((response) => {
            const payload = response && response.data;
            if (!payload) {
                store.transferMsg = {ok: false, text: '导出失败：后台无响应'};
                context.refresh();
                return;
            }
            const count = payload.schemes ? Object.keys(payload.schemes).length : 0;
            try {
                const text = JSON.stringify(payload, null, 2);
                const blob = new Blob([text], {type: 'application/json'});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const stamp = new Date().toISOString().slice(0, 10);
                a.href = url;
                a.download = `darkreader-ai-schemes-${stamp}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
                store.transferMsg = {ok: true, text: `已导出 ${count} 个站点方案`};
            } catch (err: any) {
                store.transferMsg = {ok: false, text: `导出失败：${err?.message ?? String(err)}`};
            }
            context.refresh();
        });
    }

    /** 触发隐藏的 file input */
    function triggerImport() {
        const input = document.querySelector('.ai-tab__file') as HTMLInputElement | null;
        if (input) {
            input.value = '';
            input.click();
        }
    }

    /** 读取用户选择的 JSON 并导入 */
    function importSchemes(input: HTMLInputElement) {
        const file = input.files && input.files[0];
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            let parsed: any;
            try {
                parsed = JSON.parse(String(reader.result));
            } catch (err: any) {
                store.transferMsg = {ok: false, text: '导入失败：文件不是合法 JSON'};
                context.refresh();
                return;
            }
            sendMessage('ui-bg-ai-import-schemes', {data: parsed, mode: 'merge'}).then((response) => {
                const r = response && response.data;
                if (!response) {
                    store.transferMsg = {ok: false, text: '导入失败：后台无响应'};
                } else if (response.error) {
                    store.transferMsg = {ok: false, text: `导入失败：${response.error}`};
                } else if (r) {
                    store.transferMsg = {
                        ok: true,
                        text: `已导入 ${r.imported} 个方案${r.skipped ? `，跳过 ${r.skipped} 个` : ''}`,
                    };
                } else {
                    store.transferMsg = {ok: false, text: '导入失败：未知错误'};
                }
                context.refresh();
            });
        };
        reader.onerror = () => {
            store.transferMsg = {ok: false, text: '读取文件失败'};
            context.refresh();
        };
        reader.readAsText(file);
    }

    if (store.loadError && !store.data) {
        return (
            <div class="settings-tab ai-tab">
                <div class="ai-tab__status ai-tab__status--error">{store.loadError}</div>
            </div>
        );
    }

    if (!store.data) {
        return (
            <div class="settings-tab ai-tab">
                <div class="ai-tab__description">载入中…</div>
            </div>
        );
    }

    const data = store.data;
    const active = data.configs.find((c) => c.id === data.activeId) || data.configs[0];
    const test = store.test;
    const canRemove = data.configs.length > 1;

    return (
        <div class="settings-tab ai-tab">
            <div class="ai-tab__notice">
                API Key 仅保存在本地，不会同步到云端。页面结构信息会发送到你自行配置的端点，不包含网页正文。
            </div>

            <div class="ai-tab__section">
                <div class="ai-tab__section-title">生效方式</div>
                <CheckButton
                    checked={data.aiOnly !== false}
                    label="只对已生成 AI 方案的网站启用"
                    description={data.aiOnly !== false
                        ? '没有 AI 方案的网站保持原样，不套用默认深色'
                        : '所有网站都会套用 Dark Reader 默认深色，AI 方案只做覆盖'}
                    onChange={(checked: boolean) => setAIOnly(checked)}
                />
                <div class="ai-tab__description">
                    切换后所有已打开的标签页会立即刷新。
                </div>
            </div>

            <Field label="配置" description={`共 ${data.configs.length} 套，点击切换`}>
                <div class="ai-tab__config-list">
                    {data.configs.map((c) => (
                        <div
                            class={{
                                'ai-tab__config-item': true,
                                'ai-tab__config-item--active': c.id === data.activeId,
                            }}
                            onclick={() => switchConfig(c.id)}
                        >
                            <span class="ai-tab__config-name">{c.name}</span>
                            <span class="ai-tab__config-meta">
                                {c.enabled ? c.model || '(未填模型)' : '未启用'}
                            </span>
                        </div>
                    ))}
                </div>
                <div class="ai-tab__config-actions">
                    <button class="ai-tab__mini-wide" onclick={addConfig}>＋ 新增配置</button>
                    <button
                        class="ai-tab__mini-wide"
                        disabled={!canRemove}
                        title={canRemove ? '删除当前配置' : '至少保留一套配置'}
                        onclick={() => removeConfig(active.id)}
                    >－ 删除当前</button>
                </div>
            </Field>

            <Field
                label="从文本导入"
                description="粘贴三行：第一行 Base URL，第二行 API Key，第三行模型（可选）。导入后可随时修改。"
            >
                <textarea
                    class="ai-tab__textarea"
                    rows="3"
                    spellcheck="false"
                    placeholder={IMPORT_PLACEHOLDER}
                    value={store.importText}
                    oninput={(e: any) => {
                        store.importText = e.target.value;
                        store.importMsg = null;
                        context.refresh();
                    }}
                />
                <div class="ai-tab__config-actions">
                    <button
                        class="ai-tab__mini-wide"
                        disabled={!store.importText.trim() || store.saving}
                        onclick={importFromText}
                    >导入为新配置</button>
                </div>
                {store.importMsg ?
                    <div class={`ai-tab__status ${store.importMsg.ok ? 'ai-tab__status--ok' : 'ai-tab__status--error'}`}>
                        {store.importMsg.text}
                    </div> : null}
            </Field>

            <Field label="名称" description="便于区分不同的服务商">
                <TextBox
                    value={active.name}
                    placeholder="如：OpenAI 官方 / 讯飞星火"
                    oninput={(e: any) => updateActive({name: e.target.value})}
                />
            </Field>

            <CheckButton
                checked={active.enabled}
                label="启用 AI 定制"
                description={active.enabled ? '此配置已启用' : '此配置未启用，生成会失败'}
                onChange={(checked: boolean) => updateActive({enabled: checked}, true)}
            />

            <Field label="Base URL" description="OpenAI 兼容端点，如 https://api.openai.com/v1">
                <TextBox
                    value={active.baseURL}
                    placeholder="https://api.openai.com/v1"
                    oninput={(e: any) => updateActive({baseURL: e.target.value})}
                />
            </Field>

            <Field label="API Key" description="留空则使用自定义请求头里的鉴权字段">
                <TextBox
                    value={active.apiKey}
                    placeholder="sk-..."
                    oninput={(e: any) => updateActive({apiKey: e.target.value})}
                />
            </Field>

            <Field label="模型" description="如 gpt-4o-mini / deepseek-chat / qwen-plus">
                <TextBox
                    value={active.model}
                    placeholder="gpt-4o-mini"
                    oninput={(e: any) => updateActive({model: e.target.value})}
                />
            </Field>

            <div class="ai-tab__advanced-toggle" onclick={() => { store.advanced = !store.advanced; context.refresh(); }}>
                {store.advanced ? '▾ 收起高级设置' : '▸ 高级设置'}
            </div>

            {store.advanced ?
                <div class="ai-tab__advanced">
                    <Field
                        label="最大输出 token"
                        description="推理模型（R1 / QwQ 等）需 8000 以上，否则思考完就没正文了"
                    >
                        <TextBox
                            value={String(active.maxTokens ?? 8000)}
                            placeholder="8000"
                            oninput={(e: any) => {
                                const n = parseInt(e.target.value, 10);
                                updateActive({maxTokens: isNaN(n) ? 8000 : Math.max(500, Math.min(64000, n))});
                            }}
                        />
                    </Field>

                    <Field label="超时（毫秒）" description="推理模型较慢，建议 120000 以上">
                        <TextBox
                            value={String(active.timeoutMs ?? 120000)}
                            placeholder="120000"
                            oninput={(e: any) => {
                                const n = parseInt(e.target.value, 10);
                                updateActive({timeoutMs: isNaN(n) ? 120000 : Math.max(5000, Math.min(600000, n))});
                            }}
                        />
                    </Field>

                    <Field label="自定义请求头" description="JSON 格式，可选。Azure 用 api-key 字段">
                        <TextBox
                            value={active.extraHeaders}
                            placeholder='{"api-key": "..."}'
                            oninput={(e: any) => updateActive({extraHeaders: e.target.value})}
                        />
                    </Field>
                </div>
                : null}

            <div class="ai-tab__actions">
                <Button class="ai-tab__button" disabled={store.saving} onclick={saveNow}>
                    {store.saving ? '保存中…' : '保存'}
                </Button>
                <Button class="ai-tab__button" disabled={test.status === 'testing'} onclick={runTest}>
                    {test.status === 'testing' ? '测试中…' : '测试连接'}
                </Button>
            </div>

            {store.savedAt && test.status === 'idle' ?
                <div class="ai-tab__status ai-tab__status--ok">已保存</div> : null}

            {test.status === 'ok' ?
                <div class="ai-tab__status ai-tab__status--ok">
                    {`${test.message}（${test.durationMs}ms）`}
                    {test.endpoint ? <div class="ai-tab__endpoint">{test.endpoint}</div> : null}
                </div> : null}

            {test.status === 'error' ?
                <div class="ai-tab__status ai-tab__status--error">
                    连接失败：{test.message}
                    {test.endpoint ? <div class="ai-tab__endpoint">{test.endpoint}</div> : null}
                    <div class="ai-tab__copy">
                        <CopyButton getText={() => buildErrorReport(test, active)} />
                    </div>
                </div> : null}

            <div class="ai-tab__section">
                <div class="ai-tab__section-title">方案备份</div>
                <div class="ai-tab__description">
                    导出所有已生成的站点方案（JSON），或从备份文件恢复。
                </div>
                {store.transferMsg ?
                    <div class={`ai-tab__status ${store.transferMsg.ok ? 'ai-tab__status--ok' : 'ai-tab__status--error'}`}>
                        {store.transferMsg.text}
                    </div> : null}
                <div class="ai-tab__actions">
                    <Button class="ai-tab__button" onclick={exportSchemes}>导出方案</Button>
                    <Button class="ai-tab__button" onclick={triggerImport}>导入方案</Button>
                </div>
                <input
                    type="file"
                    accept="application/json,.json"
                    class="ai-tab__file"
                    onchange={(e: any) => importSchemes(e.target)}
                />
            </div>
        </div>
    );
}
