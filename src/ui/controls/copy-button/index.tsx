import {m} from 'malevic';
import {getContext} from 'malevic/dom';

/**
 * 一键复制文本的小按钮。
 *
 * 用于把错误信息整块复制出来，方便反馈问题。
 * 复制成功后短暂显示「已复制」，2 秒后复位。
 */

interface CopyButtonProps {
    /** 要复制的文本，支持函数形式以便延迟取值 */
    getText: () => string;
    label?: string;
    copiedLabel?: string;
    class?: string;
}

interface CopyState {
    copied: boolean;
    failed: boolean;
    timer: number | null;
}

/** 优先用 Clipboard API，失败时回退到 execCommand */
async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (err) {
        // 回退
    }

    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
    } catch (err) {
        return false;
    }
}

export default function CopyButton(props: CopyButtonProps): Malevic.Child {
    const context = getContext();
    const store = context.getStore<CopyState>({copied: false, failed: false, timer: null});

    function onClick() {
        const text = props.getText();
        if (!text) {
            return;
        }
        copyText(text).then((ok) => {
            store.copied = ok;
            store.failed = !ok;
            if (store.timer) {
                clearTimeout(store.timer);
            }
            store.timer = setTimeout(() => {
                store.copied = false;
                store.failed = false;
                store.timer = null;
                context.refresh();
            }, 2000) as any;
            context.refresh();
        });
    }

    const label = store.failed
        ? '复制失败'
        : store.copied
            ? (props.copiedLabel || '已复制')
            : (props.label || '复制错误信息');

    return (
        <button
            class={['copy-button', props.class, store.copied ? 'copy-button--done' : '', store.failed ? 'copy-button--failed' : ''].filter(Boolean).join(' ')}
            onclick={onClick}
        >
            {label}
        </button>
    );
}
