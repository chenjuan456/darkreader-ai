/**
 * AI 模块的共享类型。
 *
 * 说明：采集/检测逻辑会以两种形态存在一份「注入副本」——
 * chrome.scripting.executeScript 要求函数完全自包含，不能引用外部作用域，
 * 因此运行时使用的是 collect-in-page.ts / icons.ts 里的实现。
 * 类型本身没有运行时约束，集中放在这里供各处引用。
 */

/** 页面大纲里的一条可视元素 */
export interface OutlineEntry {
    tag: string;
    sel: string;
    bg?: string;
    color?: string;
    borderColor?: string;
}

/** 发给 AI 的页面摘要（只含结构与颜色，不含正文） */
export interface PageDigest {
    url: string;
    domain: string;
    title: string;
    /** 页面主背景/主文字色 */
    base: {background: string; color: string};
    /** 有视觉意义的节点 */
    outline: OutlineEntry[];
    /** :root 上的 CSS 自定义属性 */
    cssVars: Record<string, string>;
    /** 已经是暗色的区块选择器 */
    alreadyDark: string[];
    /** 框架特征 */
    framework: string;
    /** 页面主色（参考） */
    brandColors: string[];
    /** 颜色直方图：出现频次最高的背景色 */
    topBackgrounds: Array<{color: string; count: number}>;
}

/** 被判定为「在暗色下会消失」的图标 */
export interface InvisibleIcon {
    selector: string;
    /** 'img' | 'svg' | 'font' | 'bg' */
    kind: string;
    /** 图标亮度 0..1，-1 表示无法判定 */
    iconLuminance: number;
    /** 父容器背景亮度 0..1 */
    bgLuminance: number;
    width: number;
    height: number;
}
