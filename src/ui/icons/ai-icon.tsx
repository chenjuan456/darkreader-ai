import {m} from 'malevic';

interface AIIconProps {
    class?: string;
    color?: string;
}

export function AIIcon(props: AIIconProps): Malevic.Child {
    const fill = props.color ?? 'currentColor';
    return (
        <svg viewBox="0 0 16 16" class={props.class}>
            <g fill={fill}>
                {/* 中心星芒：代表 AI 生成 */}
                <path d="M8,2.2 L9.1,6.2 L13.1,7.3 L9.1,8.4 L8,12.4 L6.9,8.4 L2.9,7.3 L6.9,6.2 Z" />
                {/* 右上小星 */}
                <path d="M12.6,2.1 L13.1,3.6 L14.6,4.1 L13.1,4.6 L12.6,6.1 L12.1,4.6 L10.6,4.1 L12.1,3.6 Z" />
            </g>
        </svg>
    );
}
