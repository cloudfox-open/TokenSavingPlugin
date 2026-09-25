<div align="center">

# 💾 TokenSaving

**为 SillyTavern 打造的 n+m 分段生长策略上下文压缩插件**
*极致缓存命中优化 · 自动滑动窗口 · 智能预设*

[![Version](https://img.shields.io/badge/version-1.4.0-blue?style=for-the-badge)](https://github.com/cloudfox-open/TokenSavingPlugin/releases)
[![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)](LICENSE)
[![SillyTavern](https://img.shields.io/badge/SillyTavern-1.12.0%2B-purple?style=for-the-badge)](https://github.com/SillyTavern/SillyTavern)
[![Author](https://img.shields.io/badge/author-cloudfox--open-orange?style=for-the-badge)](https://github.com/cloudfox-open)

![主面板预览](assets/preview-main.png)

</div>

---

## 📖 项目简介

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
| 缓存命中差 | FCC 只追加不修改，构成稳定前缀 |

---

## ✨ 核心特性

- 🪟 **n+m 分段生长策略**：窗口在 `n` 到 `n+m` 之间循环，稳定可控。
- 🧊 **冻结压缩典籍（FCC）**：摘要只追加不修改，完美命中 API 缓存。
- 🎛️ **智能预设**：根据上下文长度自动选择最优参数（基于实测成本数据）。
- 🛡️ **三重防爆**：Prompt 层字数限制 + 代码层硬截断 + 架构层预算折叠。
- 🔍 **Feynman 质量自检**：压缩后自动检测遗漏，失败自动回退，不丢原文。
- ⛔ **压缩期间锁定输入**：防止用户误发消息，提供「停止压缩」按钮。
- 🎨 **现代化毛玻璃 UI**：磨砂白玻璃 + 香槟金点缀，暗色 / 亮色自适应。

---

## 📦 安装

### 方式一：Git 安装（推荐）

在 SillyTavern 扩展面板粘贴此仓库链接：

```text
https://github.com/cloudfox-open/TokenSavingPlugin
