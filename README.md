# Dark Reader AI

> ⚠️ **这是一个纯 vibe coding 仓库** —— 全部代码由 AI 编写，人类只负责提需求、看效果和拍板。
> 本 README 也是 AI 写的。

基于 [Dark Reader](https://github.com/darkreader/darkreader)（MIT License）二次开发的浏览器扩展：
在保留原版 80 万行规则引擎的基础上，接入了 AI 能力 —— **让 AI 读取网页，为每个网站定制专属的深色方案**。

---

## 它能做什么

原版 Dark Reader 对所有网站用同一套算法。这个 fork 让你多一个选项：

```
打开网站 → 点扩展图标（侧边栏）→ 生成方案
   ↓
AI 分析该站的品牌色 / 结构 / CSS 变量
   ↓
输出一套「配色 + 修复规则」，直接喂进 Dark Reader 原生引擎
   ↓
方案按站点缓存，下次访问自动生效
```

### 核心特性

- **AI 定制配色** —— 每个网站一套独立的背景/文字色，参考该站品牌色生成，而不是千篇一律的默认深灰
- **指出问题，增量修复** —— 页面某处还是白的？点「选取问题元素」，去页面上点它，AI 只修这一处，不动其他部分
- **多服务商配置** —— 同时保存多套 API 配置（OpenAI / DeepSeek / 讯飞 / Ollama…任何 OpenAI 兼容端点），一键切换
- **常驻侧边栏** —— 用 Chrome Side Panel 替代了 popup，在页面上点元素时面板不会消失
- **图标可见性检测** —— 纯本地算法，自动发现「深色图标落在暗背景上」导致的图标消失并反色修复，不消耗 token
- **方案导入导出** —— JSON 备份，换机迁移
- **一键复制错误报告** —— 出错时点一下，带上下文的诊断信息进剪贴板

## 隐私设计

- API Key 只存在 `chrome.storage.local`，不进 sync、不写代码
- 发给 AI 的只有页面**结构和颜色**（选择器、背景色、CSS 变量），**不含网页正文**
- 密码框、支付字段、`contenteditable` 在采集阶段就被剔除
- 默认关闭，纯手动触发，不自动分析任何网站

## 安装

没有上架商店，从源码构建：

```bash
git clone https://github.com/chenjuan456/darkreader-ai.git
cd darkreader-ai
npm install --ignore-scripts
node --max-old-space-size=3072 tasks/build.js --release --chrome-mv3
```

然后 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `build/release/chrome-mv3` 目录。

> 需要 Chrome 116+（Side Panel API）。

## 使用

1. 扩展选项 → **AI** 标签 → 填 Base URL / API Key / 模型 → 勾选「启用 AI 定制」→ 保存
2. 打开任意网站 → 点扩展图标唤出侧边栏 → **生成方案**
3. 不满意？**选取问题元素** → 在页面上点出错的区域 → **修复这 N 处**

## 技术上怎么实现的

关键决策一句话：**AI 不重做引擎，AI 当「高级规则作者」。**

Dark Reader 的动态引擎已经处理了颜色映射、CSS 变量、Shadow DOM、图片分析这些脏活，还有一份 800KB / 3 万行的站点修复规则库。让 LLM 从零生成整页 CSS 是其他同类产品的做法，也是它们效果平庸的原因。

这个项目的做法是把 AI 的输出**对齐到引擎的原生数据结构**：

```
LLM 输出 JSON
  ├─ theme  → Partial<Theme>      （配色，走 Dark Reader 原生主题管道）
  └─ fixes  → DynamicThemeFix     （修复规则，与内置规则叠加合并）
```

AI 生成的规则里允许用 `${white}` / `${black}` 占位符 —— 引擎会按用户的亮度/对比度设置自动换算成暗色，**AI 不需要会算颜色**。所有模型输出经过校验（选择器合法性、颜色格式、CSS 体积与危险内容过滤），脏数据不进引擎。

目录结构：

```
src/ai/            AI 模块（本次开发的全部增量）
  client.ts        OpenAI 兼容客户端（手写 fetch，不引 SDK）
  collect*.ts      页面采集器（结构/颜色/CSS 变量，含脱敏）
  scheme.ts        Prompt、JSON Schema、输出规范化
  generate.ts      生成编排（含基于用户反馈的增量修复）
  store.ts         方案持久化（域名/路径两级作用域）
  icons.ts         图标可见性启发式检测
  picker.ts        页面元素拾取器
  pending.ts       拾取状态持久化（storage.session）
src/ui/sidepanel/  侧边栏入口（替代 popup）
src/ui/popup/      AI 面板（popup 与侧边栏共用）
src/ui/options/ai/ 设置页 AI 标签
```

其余部分（引擎、规则库、构建系统）保持上游 4.9.133 原样。

## 已知限制

- 只构建了 Chrome MV3 目标（Firefox/Safari 未适配）
- 不跟进上游 —— fork 冻结在 4.9.133，往后各自发展
- AI 生成的 CSS 质量取决于所用模型，推理模型需把「最大输出 token」调到 8000+

## License

MIT —— 继承自 [Dark Reader](https://github.com/darkreader/darkreader)，感谢 Alexander Shutau 和所有上游贡献者。

## 关于 vibe coding

这个仓库是一次实验：**从 fork 到可用产品，全程只动嘴不动手。**

过程中 AI 读上游源码定位注入点、写功能、写测试（构建产物级的端到端验证，不是摆设的单元测试）、修自己引入的 bug、被用户打回重做 UI —— 人做的事是提需求、验收、以及决定「这个方向对不对」。

如果你想看 AI 在一个 80 万行的真实项目里怎么干活，这个仓库的 diff 就是完整记录。
