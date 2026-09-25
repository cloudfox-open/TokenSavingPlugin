# 💾 TokenSaving

> 为 SillyTavern 打造的 **n+m 分段生长策略** 上下文压缩插件  
> 极致缓存命中优化 · 自动滑动窗口 · 智能预设

[![Version](https://img.shields.io/badge/version-1.4.0-blue)](https://github.com/cloudfox-open/TokenSavingPlugin)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![SillyTavern](https://img.shields.io/badge/SillyTavern-1.12.0%2B-purple)](https://github.com/SillyTavern/SillyTavern)
[![Author](https://img.shields.io/badge/author-cloudfox--open-orange)](https://github.com/cloudfox-open)

---

## 📖 目录

- [项目简介](#-项目简介)
- [核心特性](#-核心特性)
- [安装](#-安装)
- [快速开始](#-快速开始)
- [参数详解](#-参数详解)
- [智能预设](#-智能预设)
- [工作原理](#-工作原理)
- [实测成本数据](#-实测成本数据)
- [常见问题](#-常见问题)
- [兼容性](#-兼容性)
- [更新日志](#-更新日志)
- [许可证](#-许可证)

---

## 🎯 项目简介

TokenSaving 是一款为 SillyTavern 设计的**上下文压缩插件**。它通过独创的 **n+m 分段生长策略**，在对话超过阈值时自动将最旧的对话压缩为摘要，并追加到 **FCC（冻结压缩典籍）** 块中，从而在保留对话连贯性的同时大幅降低 Token 消耗。

### 为什么需要它？

- **长对话 Token 爆炸**：聊到几十轮后，聊天记录会迅速占满上下文窗口
- **截断丢记忆**：SillyTavern 默认截断最旧消息，导致角色"失忆"
- **API 费用失控**：每一轮对话都要重复发送完整历史，费用线性增长
- **缓存命中差**：历史记录不断变化，API 缓存前缀频繁失效

### TokenSaving 怎么解决？

| 问题 | 方案 |
|---|---|
| Token 爆炸 | 把滑出窗口的对话压成摘要，压缩比可达 80%+ |
| 截断丢记忆 | 摘要保留关键事件 / 关系 / 情感，AI 记得住 |
| API 费用失控 | 通过稳定前缀命中 API 缓存，单次成本降低 30-50% |
| 缓存命中差 | FCC 只追加不修改，`[系统+角色卡+世界书+FCC]` 构成稳定前缀 |

---

## ✨ 核心特性

### 🪟 n+m 分段生长策略

独创的滑动窗口机制：对话从 `n` 轮生长到 `n+m` 轮，超过时触发压缩并回落到 `n` 轮。

```
时刻      可见轮数   触发压缩   压缩后
─────────────────────────────────────
1~9 轮    1→9       否         3~9
第 10 轮  10        ✅         3
11~16 轮  4→9       否         4~9
第 17 轮  10        ✅         3
...循环...
```

- **日常压缩靠窗口滑动** —— 稳定、可预测
- **80% Token 阈值兜底** —— 应对单条超长回复

### 🧊 冻结压缩典籍（FCC）

压缩后的摘要保存在 FCC 块中，注入到 `[世界书之后 / 聊天记录之前]`：

```text
[系统提示]
[角色卡]
[世界书]
⭐ [FCC: 累积历史摘要]     ← 只追加不修改，稳定前缀
[最近 n 轮对话原文]         ← 保留完整连贯性
[本次用户输入]
```

**FCC 只增不改** → API 缓存完美命中 → 成本大幅降低。

### 🎛️ 智能预设

根据上下文长度自动选择最优参数（基于实测成本数据）：

- **自动**：按上下文推荐（4096 / 8192 / 16k / 32k）
- **省成本**：更少触发频率，单价最低
- **省内存**：更勤压缩，上下文更小
- **高质量**：更长摘要，保留更多细节

### 🛡️ 三重防爆

1. **Prompt 层**：明确告诉 AI 摘要字数上限
2. **代码层**：硬截断，AI 不听话也不怕
3. **架构层**：FCC 总预算折叠，防止累积爆炸

### 🔍 Feynman 质量自检

压缩后自动对比原文与摘要，检测关键信息遗漏。**自检失败则回退，不隐藏原文**。

### ⛔ 压缩期间锁定输入

压缩进行中禁用输入框和发送按钮，防止用户误发消息。提供 **停止压缩** 按钮，可随时中断。

### 🎨 现代化毛玻璃 UI

- 磨砂白玻璃质感（`backdrop-filter`）
- 香槟金点缀 + 紫罗兰渐变
- 实时状态卡片：轮数 / 上下文 / FCC 指标
- 窗口可视化格子图
- 暗色 / 亮色主题自适应

---

## 📦 安装

### 方式一：Git 安装（推荐）

在 SillyTavern 扩展面板粘贴此仓库链接：

```
https://github.com/cloudfox-open/TokenSavingPlugin
```

点击 **Install Extension** 即可。

### 方式二：手动安装

1. 下载本仓库
2. 把文件夹重命名为 `TokenSavingPlugin`
3. 放到 `SillyTavern/public/scripts/extensions/third-party/` 下
4. 刷新浏览器页面（F5）

> ⚠️ 手动安装方式下，启动时的 auto-update 会报 "not a Git repository" 错误，不影响功能。用 Git 安装方式则无此问题。

### 目录结构

```
TokenSavingPlugin/
├── manifest.json    # 扩展清单
├── index.js         # 核心逻辑
├── settings.html    # 设置面板
├── style.css        # 样式
└── README.md        # 本文档
```

---

## 🚀 快速开始

1. **加载角色卡**，开始聊天
2. 打开 **扩展面板** → 找到 **💾 TokenSaving**
3. 点击 **智能预设** 中的 **自动** 按钮（按上下文自动配置）
4. 正常聊天。达到阈值后会自动压缩，状态卡片实时显示进度
5. 若自动没触发，点 **⚡ 立即压缩** 手动触发

---

## 🔧 参数详解

| 参数 | 说明 | 默认值 | 推荐范围 |
|---|---|---|---|
| **启用自动压缩** | 总开关 | 开 | — |
| **n（保留原文轮数）** | 始终保留最近 n 轮对话原文，不压缩 | 2 | 1~4 |
| **m（滑动窗口增量）** | 可见轮数超过 n+m 时触发压缩 | 8 | 见下表 |
| **Token 兜底阈值** | 窗口未溢出但 Token 逼近上限时兜底触发 | 80% | 75~90% |
| **单次摘要上限** | 每次压缩产出的摘要最大 Token 数 | 180 | 100~300 |
| **FCC 总预算** | FCC 块的最大 Token 数，超过触发折叠 | 300 | 200~800 |
| **Feynman 自检** | 压缩后检测关键信息遗漏 | 开 | 推荐开启 |

### m 值推荐

| 上下文 | 推荐 m | 说明 |
|---|---|---|
| 4096 | 8~12 | 太小触发频繁，太大单次成本高 |
| 8192 | 24~32 | 甜点：m=28 |
| 16k | 28~40 | — |
| 32k+ | 36~50 | — |

> 💡 **经验公式**：`m ≈ 上下文 / 300`，即 4096 → 13，8192 → 27，16k → 54（上限建议 50）

---

## 🎯 智能预设

面板顶部提供 4 个预设按钮，点击即可一键切换：

| 预设 | 适用场景 | 特点 |
|---|---|---|
| ⚡ **自动** | 默认推荐 | 根据上下文长度自动选择最优配置 |
| 🍃 **省成本** | 预算敏感 | m 值更大，触发频率更低，单价最低 |
| 🐇 **省内存** | 上下文紧张 | m 值更小，压缩更勤，占用更小 |
| 💎 **高质量** | 剧情复杂 | 摘要更长，保留更多细节 |

### 预设参数速查

| 上下文 | 预设 | n | m | 摘要 | FCC |
|---|---|---|---|---|---|
| 4096 | 自动 | 2 | 8 | 180 | 300 |
| 4096 | 省成本 | 2 | 12 | 180 | 300 |
| 4096 | 省内存 | 2 | 5 | 150 | 250 |
| 4096 | 高质量 | 3 | 10 | 250 | 400 |
| 8192 | 自动 | 2 | 28 | 200 | 300 |
| 8192 | 省成本 | 2 | 32 | 200 | 300 |
| 8192 | 省内存 | 2 | 16 | 180 | 250 |
| 8192 | 高质量 | 3 | 30 | 280 | 500 |
| 16k | 自动 | 3 | 30 | 250 | 400 |
| 32k+ | 自动 | 3 | 40 | 300 | 600 |

> 💡 手动修改任意参数会自动切换到"自定义配置"状态，预设按钮取消选中。

---

## ⚙️ 工作原理

### 数据流

```text
┌──────────────────────────────────────────────────┐
│ 1. AI 回复完成                                    │
│    ↓                                              │
│ 2. 计算当前可见轮数 与 Token 占比                  │
│    ↓                                              │
│ 3. 判断触发：                                     │
│    窗口溢出 (轮数 > n+m)  OR  Token ≥ 阈值        │
│    ↓                                              │
│ 4. 锁定输入 + 隐藏待压缩消息                      │
│    ↓                                              │
│ 5. 分块发给 AI 压缩（每块 ≤ 800 tok）              │
│    ↓                                              │
│ 6. Feynman 自检（可选）                           │
│    ↓                                              │
│ 7. 追加到 FCC + 保存 + 注入 prompt                │
│    ↓                                              │
│ 8. 解锁输入                                       │
└──────────────────────────────────────────────────┘
```

### 压缩流程

1. **分块**：把待压缩文本按 800 tok 切块，避免 quiet prompt 超预算被裁剪
2. **结构化压缩**：用 JSON Schema 硬约束模型输出 `{events, relationship, emotion}`
3. **降级容错**：JSON Schema 失败 → 普通模式重试 → 正则提取兜底
4. **硬截断**：超过单次摘要上限时按 token 截断
5. **自检**：对比原文检查遗漏，失败即回退
6. **FCC 预算控制**：超过总预算时触发折叠重组

### 注入位置

```javascript
ctx.setExtensionPrompt(EXT_KEY, fccContent, 1, 9999, false, 0);
//                                    ↑  ↑     ↑
//                                    │  │     └ 角色：SYSTEM
//                                    │  └ depth=9999（聊天记录最前）
//                                    └ position=1（IN_CHAT）
```

在 prompt 中的位置：

```text
[系统提示] [角色卡] [世界书] ⭐[FCC] [聊天记录] [本次输入]
                       ↑
                 稳定前缀，缓存命中
```

### 缓存命中原理

- FCC 采用 **Append-Only**（只追加），不修改已生成部分
- 位置固定（depth=9999），不随对话滑动
- `[系统+角色卡+世界书+FCC]` 构成**稳定前缀**
- DeepSeek / Anthropic / OpenAI 的 Prompt Cache 反复命中这部分 → 计费打折

---

## 📊 实测成本数据

以下数据来自 DeepSeek API 实测（作者本人测试）：

| 上下文 | m 值 | 调用次数 | 总花费（元） | 单价（元/次） | 结论 |
|---|---|---|---|---|---|
| 4096 | 3 | 56 | 0.06 | 0.00107 | 触发过频 |
| 4096 | 3 | 122 | 0.10 | 0.00082 | — |
| 4096 | 3 | 246 | 0.20 | 0.00081 | — |
| 4096 | 12 | 118 | 0.10 | **0.00085** | ✅ 明显改善 |
| 8192 | 28 | 106 | 0.05 | **0.00047** | ⭐ **甜点** |
| 8192 | 28 | 123 | 0.06 | **0.00049** | ⭐ **甜点** |
| 8192 | 60 | 329 | 0.18 | 0.00055 | 单次成本上升 |

**核心发现**：

1. `m` 太小 → 触发频繁 → 单价高
2. `m` 太大 → 单次压缩原文过长 → 单价也高
3. **最佳 m ≈ 上下文 × 0.35%**（8192 × 0.34 ≈ 28 是甜点）
4. 8192 上下文单次成本是 4096 的 **约一半**（缓存前缀更长）

**结论**：默认参数已针对 4096 上下文优化；如果你用 8192，请务必点击「自动」预设。

---

## ❓ 常见问题

### Q1: 为什么第一次不压缩？

需要满足以下**任一**条件才会触发：

- 可见轮数超过 `n + m`（如 `n=2, m=8` → 超过 10 轮）
- Token 占比达到阈值（默认 80%）

前几轮是"生长阶段"，正常聊天即可。状态卡片会显示 `🌱 生长阶段（x/y 轮）`。

### Q2: 压缩太频繁 / 太稀疏？

- **太频繁**：增大 `m` 或点击「省成本」预设
- **太稀疏**：减小 `m` 或点击「省内存」预设

### Q3: 摘要很长，占了很多 Token？

降低「单次摘要上限」（如 100~150），AI 会被强制精简。

### Q4: 如何回到未压缩状态？

点击 **🗑 清除 FCC** 按钮，所有被隐藏的聊天消息会重新显示。

### Q5: 压缩时输入框为什么变灰？

这是**特性**，不是 Bug。压缩期间禁用输入防止用户误发消息导致主生成与压缩冲突。

如需中断，点击红色 **⏹ 停止压缩** 按钮，会恢复原文。

### Q6: 支持哪些 API？

理论上支持所有 SillyTavern 支持的 API：

- ✅ DeepSeek（实测最优）
- ✅ OpenAI / OpenAI Compatible
- ✅ Anthropic Claude
- ✅ Gemini
- ✅ 本地模型（Ollama / KoboldCpp / llama.cpp 等）

**不支持 JSON Schema 的 API** 会自动降级为普通模式。

### Q7: 会不会丢记忆？

**不会**。三层保护：

1. Feynman 自检：遗漏关键信息 → 回退
2. 压缩失败 → 自动恢复原文
3. FCC 只追加，历史摘要永不丢失

最坏情况：压缩失败，聊天保持原样，不隐藏任何消息。

### Q8: 缓存命中是怎么回事？

SillyTavern 每次请求都会把完整 prompt 发给 API。TokenSaving 让 `[系统+角色卡+世界书+FCC]` 这部分**内容稳定且位置固定**，API 服务商（如 DeepSeek）会缓存这个前缀，下次请求时这部分 Token 计费打折。

**简单说**：同样的前缀不会重复收全款。

### Q9: 我可以关闭自检吗？

可以。关闭后每次压缩只调用 1 次 API，更省钱。但**没有质量兜底**，如果模型输出质量差，可能丢记忆。

推荐：保留开启，除非 API 调用费用极为敏感。

### Q10: 为什么单次摘要上限和 FCC 预算都这么小？

因为压缩的**目的是省 Token**，不是"完整记录历史"。摘要应该只保留**改变剧情的关键信息**，大量寒暄和细节可以省略。

参考参数：
- **单次摘要**：180 tok（约 270 个汉字）
- **FCC 预算**：300 tok（约 450 个汉字）

小上下文（4096）尤其要严格控制。

---

## 🔌 兼容性

| 项目 | 要求 |
|---|---|
| SillyTavern | ≥ 1.12.0 |
| 浏览器 | Chrome / Edge / Firefox 最新版 |
| 依赖 | 无（纯前端） |
| 主题 | 暗色 / 亮色自适应 |

### 与其他扩展的兼容性

- ✅ 与「World Info」「Author's Note」「Summarize」共存
- ⚠️ 与「Vector Storage」同时使用可能增加上下文占用
- ⚠️ 与「Smart Context」等上下文管理类扩展可能冲突

---

## 📝 更新日志

### v1.4.0

- ✨ 新增智能预设（自动 / 省成本 / 省内存 / 高质量）
- ⚡ 默认值更新为 4096 上下文甜点配置（n=2, m=8, 摘要=180, FCC=300）
- 📊 基于实测成本数据优化 m 值推荐

### v1.3.0

- ✨ 压缩期间锁定输入框与发送按钮
- ✨ 新增「停止压缩」按钮，支持中断
- 🐛 修复连续对话永不触发的问题（改为立即执行）

### v1.2.0

- ✨ n+m 分段生长策略正确实现（主触发：窗口溢出）
- ✨ 80% Token 阈值改为兜底
- 🎨 全新毛玻璃 UI

### v1.1.0

- 🐛 修复摘要被最大回复长度截断（显式传 responseLength）
- 🐛 修复多次调用 API 报错（Promise 锁 + 调用上限）
- 🐛 修复顶到窗口没反应（三重触发）

### v1.0.0

- 🎉 首次发布
- n+m 分段生长策略
- FCC 冻结压缩典籍
- Feynman 质量自检
- 缓存命中优化

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。

- 报告 Bug：请附上浏览器控制台日志（F12 → Console）
- 功能建议：请说明使用场景和预期效果
- 代码贡献：请保持代码风格一致

---

## 👤 作者

**cloudfox-open**

- GitHub: [@cloudfox-open](https://github.com/cloudfox-open)
- 项目主页: [TokenSavingPlugin](https://github.com/cloudfox-open/TokenSavingPlugin)

---

## 📄 许可证

[MIT License](LICENSE)

```
Copyright (c) 2024 cloudfox-open

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

<div align="center">

**⭐ 如果这个项目帮到了你，欢迎给一个 Star ⭐**

Made with ❤️ by [cloudfox-open](https://github.com/cloudfox-open)

</div>