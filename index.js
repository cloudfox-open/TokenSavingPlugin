/**
 * TokenSavingPlugin v1.0.3 - 去自检 · 单块优先压缩
 *
 * v1.0.3 改动：
 *   - 彻底移除 Feynman 质量自检：删除开关、自检 Prompt、自检函数与相关文案。
 *     每次压缩固定少 1 次 API 调用（原先 selfCheck=true 时必调）。
 *   - 单块优先：块大小不再以用户设定值为硬上限，而是取「设定值」与
 *     「当前可达上下文空间」中的较大者（硬上限 49152，避免退化出第二次冷启动）。
 *   - 修复压缩上下文放宽从未生效的问题（自锁）：压缩上下文申请量改由
 *     「待压内容实际大小」驱动，而非由块大小反推。
 *   - 自适应 m：按最近消息平均量自动分配，并扣除前缀（世界书 + 角色卡 + 系统提示词）
 *     与 SillyTavern 的「最大回复长度」，避免「前缀 + 历史」超出上下文窗口。
 *   - 滑动窗口增量不再按档位写死；压缩器的角色参考纳入角色卡 system_prompt。
 *
 * 继承 v1.0.2：
 *   - API 熔断：识别 402/401/403/余额/密钥/权限，立即中止整轮 + 熔断 5 分钟
 *   - 手动点「立即压缩」可绕过熔断（用户充值后立即可用）
 *   - 压缩发送上限默认 64000
 *   - 压缩时临时放宽 SillyTavern 上下文（解决 8k 设置 + 大模型冲突）
 *
 * 继承 v1.0.1：
 *   - 动态缩减块大小兜底、FCC = 单次摘要 × 2.5、仅保留「自动」预设
 *   - 面板「上下文 %」异步真实 token 计数
 *   - API 上限按内容量自动增长（硬上限 30）
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getMaxPromptTokens, printMessages } from '../../../../script.js';
import { hideChatMessageRange } from '../../../chats.js';

const EXT_NAME = 'tokensaving';
const EXT_KEY = 'tokensaving_fcc';
const POLL_INTERVAL = 30000;

const HARD_API_CAP = 30;

const COMPRESS_FIXED_OVERHEAD = 1400;
const COMPRESS_SAFETY_MARGIN = 300;
const COMPRESS_MIN_BLOCK = 256;

// 单块优先：单次压缩请求允许携带的最大 token 数。
// 远高于各档预设值，使「可见轮数刚超过 n+m」这一常见情形只需 1 次 API 调用。
// 提到 49152：16k 档单次待压内容约 38k tok，32768 会导致退化成 2 块，
// 多出一次全额冷启动（指令+参考上下文 ~1000 tok 全部未命中）并增加超时风险。
const SINGLE_CALL_BLOCK_MAX = 49152;

const CONTEXT_ERROR_RE = /必要的提示词|提示词超过|超出上下文|超过上下文|上下文(大小|限制|长度|窗口)|necessary prompt|prompt[s]?\s*(exceed|too)|exceed[s]?\s*(the\s*)?(context|prompt)|context\s*(size|length|limit|window)|too\s*(long|large)\s*(for|to)/i;

// ★ 致命 API 错误（余额不足 / 密钥无效 / 无权限）
const FATAL_API_ERROR_RE = /402|payment\s*required|insufficient|quota|credit|balance|billing|unauthoriz|401|invalid\s*api|forbidden|403|欠费|余额|额度|无权|认证|密钥/i;

// ★ 熔断状态
let apiCircuitBreakerUntil = 0;
const CIRCUIT_BREAKER_COOLDOWN = 5 * 60 * 1000;   // 5 分钟

// ==================== I18N 字典 ====================
const I18N = {
    zh: {
        title: 'TokenSaving',
        lang_btn_label: 'EN',

        status_ready: '就绪',
        status_growing: '🌱 生长阶段（{rounds}/{max} 轮, {percent}%）',
        status_overflow: '🗜️ 窗口溢出（{rounds}/{max} 轮），压缩中...',
        status_manual: '⚡ 手动压缩中...',
        status_too_few: '消息太少（{rounds} 轮 ≤ n={n}）',
        status_compressing: 'AI 压缩 {count} 条旧消息...',
        status_folding: 'FCC 超出上限，折叠重组中... (API {current}/{max})',
        status_complete: '✅ 压缩完成，保留最近 {rounds} 轮原文 (API {api}次)',
        status_failed: '❌ 压缩失败，已回退 ({msg})',
        status_aborted: '⏹ 已中止，原文已恢复',
        status_aborting: '⏹ 正在中止，等待当前步骤完成...',
        status_preset_current_custom: '当前：自定义（n={n}, m={m}, 摘要={summary}, FCC={fcc}, 分块={block}）',
        status_preset_current: '当前：{label}（n={n}, m={m}, 摘要={summary}, FCC={fcc}, 分块={block}）',

        toast_input_warning: '压缩进行中，请稍候再发送',
        toast_already_running: '已有压缩任务正在运行',
        toast_preset_applied: '已应用「{label}」预设',
        toast_complete: '压缩完成，保留最近 {rounds} 轮原文',
        toast_failed: '压缩失败: {msg}',
        toast_abort_requested: '已请求中止，等待当前步骤完成...',
        toast_abort_done: '压缩已中止，原文已恢复',
        toast_cleared: 'FCC 已清除，所有被压缩的消息已恢复',
        toast_clear_failed: '清除失败: {msg}',
        toast_context_expanded: '压缩期间临时放宽上下文 {from} → {to}',
        toast_circuit_breaker: '⚠️ API 报错，已暂停自动压缩 5 分钟。请检查账户余额 / 密钥后，手动点击「立即压缩」恢复。',

        err_context_exceeded: '提示词超出模型上下文限制。建议：\n1) 增大「压缩发送上限」（当前未设置）\n2) 减小「分块大小」（当前 {block} tok）\n3) 或换用更大上下文的模型',
        err_fatal_api: 'API 调用失败（可能余额不足 / 密钥无效 / 无权限）：{msg}',

        preset_title: '智能预设',
        preset_hint: '根据当前模型上下文长度自动选择最优参数（n=5，滑动窗口增量按上下文翻倍）。修改任一参数会标记为「自定义」。',
        preset_auto: '自动（推荐）',
        preset_auto_desc: '均衡成本与质量（唯一预设）',

        enable_auto: '启用自动压缩',
        enable_auto_desc: '达到触发条件时自动压缩旧对话并注入 FCC',
        window_title: '窗口策略',
        window_n_label: '保留最近原文轮数',
        window_n_desc: '始终保留最近 n 轮对话原文（不压缩）',
        window_m_label: '滑动窗口增量',
        window_m_desc: '可见轮数超过 n+m 时触发压缩，压缩后回到 n 轮',
        window_m_auto: '自动计算中…',
        window_m_auto_idle: '自动：待有聊天消息后按平均消息量计算',
        window_m_auto_detail: '自动：最近 {recent} 条平均 {avg} tok/条，已扣前缀 {prefix} tok，按窗口填满上下文 {fill}% 计算',
        window_m_manual: '自定义：m 由你手动指定（删除预设后不再自动计算）',
        toast_window_custom: '已切换为自定义配置：m 交回手动控制',
        legend_retain: '保留区 (1~n)',
        legend_compress: '压缩区 (n+1~n+m)',
        fill_percent_label: '窗口填充目标 (%)',
        fill_percent_desc: '自动计算 m 时，把「可用上下文 − 前缀」这段聊天窗口填到该比例即触发压缩。默认 88%（实测 90% 会刚好挤出上下文）。改动后转为「自定义配置」，点「自动」预设可恢复默认值。',
        threshold_title: '预算与摘要',
        summary_label: '单次摘要上限 (tok)',
        summary_desc: '防止单次摘要过大导致上下文爆炸',
        fcc_budget_label: 'FCC 摘要上限 (tok)',
        fcc_budget_desc: '所有历史摘要合计的最大长度。超出时自动折叠精简，避免占用过多上下文。默认 = 单次摘要上限 × 2.5',
        block_tokens_label: '分块大小 (tok)',
        block_tokens_desc: '单次压缩请求携带的文本块大小，也作为优先一次压完的下限参考。实际会按压缩时可用的上下文空间自动放大（上限 49152），以便整段历史尽量 1 次调用压完',
        max_api_calls_label: '最大 API 调用次数',
        max_api_calls_desc: '单次压缩最多调用几次 AI。内容过大时会自动提升（硬上限 30 次）',
        compress_context_label: '压缩发送上限 (tok)',
        compress_context_desc: '压缩时临时把 SillyTavern 的上下文上限放宽到该值，压缩完恢复。0 = 跟随 SillyTavern 设置。API 支持大上下文时建议填 64000 或 128000（如 DeepSeek），避免压缩报错。',
        prefix_tokens_label: '前缀占用 (tok)',
        prefix_tokens_desc: '世界书 + 角色设定 + 系统提示词等恒定内容占用的上下文，由插件在每次生成时自动测量（不可手动修改）。计算自适应 m 时会先扣掉它，否则「前缀 + 历史」会超出上下文窗口。',
        prefix_status_auto: '自动测量：{value} tok（{source}）',
        prefix_source_measured: '运行时实测',
        prefix_source_blocks: '提示词管理器（Token Counter）加总',
        prefix_source_estimate: '按角色卡/提示词估算',
        prefix_source_none: '暂无数据，发送一条消息后自动测量',

        btn_manual: '立即压缩',
        btn_stop: '停止压缩',
        btn_clear: '清除 FCC',

        fcc_panel_title: 'FCC 摘要内容',
        footer_hint: '💡 实测最优：n=5；m 已改为按最近消息平均量自动计算，目标把可见窗口填满上下文的 85%',
        metric_rounds: '轮数',
        metric_context: '上下文',
        metric_fcc: 'FCC',
        metric_block: '分块',
        metric_api: '预计调用',
        metric_block_title: '实际生效的单块大小（压缩时按可用上下文自动放大，上限 49152）',
        metric_api_title: '按当前窗口估算的本次压缩 API 调用次数（含分块压缩与可能的一次 FCC 折叠）',

        prompt_compress: `你是信息压缩引擎，不是故事作者。从聊天记录中提取关键信息，按指定 JSON 格式输出。
{block_note}
## 禁止
- 禁止续写/推测/编造/复制原文
- 禁止输出 JSON 之外的任何内容

{prior_context}## 待压缩聊天记录（第 {block_index}/{block_count} 块）
{block_text}

## ⚠️ 严格限制
1. 只从原文提取信息，绝不编造。
2. **总字数必须控制在 {max_chars} 个汉字以内！超长将被截断。**
3. **保留优先级（高 → 低）：**
   - 【最高】关系转折：告白、决裂、承诺/誓言、身份或能力揭示
   - 【高】伏笔与悬念：提及但未展开的线索、计划、"以后再说"类信息
   - 【中】角色状态变化：位置、认知、目标、装备的改变
   - 【中】关键事件与行动决策
4. **可省略：** 寒暄客套、重复日常、纯环境描写、语气词、玩笑打趣。

## 输出格式（JSON）
{
  "events": "关键事件1→事件2→事件3",
  "relationship": "关系变化描述",
  "emotion": "情感轨迹变化",
  "hooks": "伏笔/承诺/未展开的线索；若无则写'无'"
}`,
        prompt_block_note: '⚠️ 这是第 {i}/{n} 块，只压缩本块。',

        prompt_fold: `你是历史记录合并引擎。请将【已有摘要】和【新增摘要】合并为一段更精简的摘要。
禁止编造，只融合已有信息。

## 已有摘要
{old_fcc}

## 新增摘要
[历史摘要] {new_summary}

## 输出要求
1. 直接输出合并后的精简摘要，无前缀。
2. 总长度必须控制在 {max_chars} 个汉字以内。
3. 保持 [事件]/[关系]/[情感] 的结构。`,
    },

    en: {
        title: 'TokenSaving',
        lang_btn_label: '中文',

        status_ready: 'Ready',
        status_growing: '🌱 Growing ({rounds}/{max} rounds, {percent}%)',
        status_overflow: '🗜️ Window overflow ({rounds}/{max}), compressing...',
        status_manual: '⚡ Manual compression...',
        status_too_few: 'Too few messages ({rounds} rounds ≤ n={n})',
        status_compressing: 'AI compressing {count} old messages...',
        status_folding: 'FCC over cap, folding... (API {current}/{max})',
        status_complete: '✅ Compression complete, kept latest {rounds} rounds (API {api})',
        status_failed: '❌ Compression failed, rolled back ({msg})',
        status_aborted: '⏹ Aborted, messages restored',
        status_aborting: '⏹ Aborting, waiting for current step...',
        status_preset_current_custom: 'Current: Custom (n={n}, m={m}, summary={summary}, FCC={fcc}, block={block})',
        status_preset_current: 'Current: {label} (n={n}, m={m}, summary={summary}, FCC={fcc}, block={block})',

        toast_input_warning: 'Compression in progress, please wait',
        toast_already_running: 'A compression task is already running',
        toast_preset_applied: 'Preset "{label}" applied',
        toast_complete: 'Compression complete, kept latest {rounds} rounds',
        toast_failed: 'Compression failed: {msg}',
        toast_abort_requested: 'Abort requested, waiting for current step...',
        toast_abort_done: 'Compression aborted, messages restored',
        toast_cleared: 'FCC cleared, all compressed messages restored',
        toast_clear_failed: 'Clear failed: {msg}',
        toast_context_expanded: 'Temporarily expanded context {from} → {to} for compression',
        toast_circuit_breaker: '⚠️ API error, auto-compression paused for 5 min. Check account/key, then click "Compress Now" to resume.',

        err_context_exceeded: 'Prompt exceeds model context limit. Suggestions:\n1) Increase "Compress context cap" (currently unset)\n2) Reduce "Block size" (currently {block} tok)\n3) Or use a model with larger context',
        err_fatal_api: 'API call failed (possible insufficient balance / invalid key / forbidden): {msg}',

        preset_title: 'Smart Preset',
        preset_hint: 'Auto-selects optimal parameters based on your model context length (n=5, m doubles per tier). Editing any parameter marks it as Custom.',
        preset_auto: 'Auto (recommended)',
        preset_auto_desc: 'Balanced cost & quality (only preset)',

        enable_auto: 'Enable auto compression',
        enable_auto_desc: 'Auto compress old conversations and inject FCC when triggered',
        window_title: 'Window Strategy',
        window_n_label: 'Retain recent rounds',
        window_n_desc: 'Always keep the latest n rounds of raw chat (uncompressed)',
        window_m_label: 'Sliding window increment',
        window_m_desc: 'Trigger compression when visible rounds exceed n+m; shrink back to n',
        window_m_auto: 'Auto-calculating…',
        window_m_auto_idle: 'Auto: computed from average message size once chat has messages',
        window_m_auto_detail: 'Auto: last {recent} msgs avg {avg} tok each; prefix {prefix} tok deducted; sized to fill {fill}% of context',
        window_m_manual: 'Custom: m is set manually (no longer auto-computed)',
        toast_window_custom: 'Switched to Custom config: m is now under manual control',
        legend_retain: 'Retain (1~n)',
        legend_compress: 'Compress (n+1~n+m)',
        fill_percent_label: 'Window fill target (%)',
        fill_percent_desc: 'When auto-computing m, the chat window (available context − prefix) is filled up to this ratio before compression triggers. Default 88% (90% was observed to just overflow the context). Editing switches to "Custom"; the Auto preset restores the default.',
        threshold_title: 'Budget & Summary',
        summary_label: 'Max summary tokens (tok)',
        summary_desc: 'Prevents a single summary from bloating the context',
        fcc_budget_label: 'FCC summary cap (tok)',
        fcc_budget_desc: 'Maximum combined length of all history summaries. Auto-folded when exceeded, to limit context usage. Default = 2.5 × max summary tokens',
        block_tokens_label: 'Block size (tok)',
        block_tokens_desc: 'Text block size per compression request; also the lower bound for single-pass preference. Auto-raised per available context (cap 49152) so the whole history compresses in as few calls as possible',
        max_api_calls_label: 'Max API calls',
        max_api_calls_desc: 'Maximum AI calls per compression. Auto-raised if content is large (hard cap 30)',
        compress_context_label: 'Compress context cap (tok)',
        compress_context_desc: 'Temporarily raises SillyTavern\'s context limit during compression, restores after. 0 = follow SillyTavern setting. For APIs with large context (e.g. DeepSeek), set to 64000 or 128000 to avoid compression errors.',
        prefix_tokens_label: 'Prefix usage (tok)',
        prefix_tokens_desc: 'Context consumed by constant content: world info + character definition + system prompt. Measured automatically on every generation (not editable). It is subtracted before computing the adaptive m, otherwise "prefix + history" would exceed the context window.',
        prefix_status_auto: 'Auto-measured: {value} tok ({source})',
        prefix_source_measured: 'runtime measured',
        prefix_source_blocks: 'summed from prompt manager (Token Counter)',
        prefix_source_estimate: 'estimated from card/prompt',
        prefix_source_none: 'no data yet — send one message to measure',

        btn_manual: 'Compress Now',
        btn_stop: 'Stop',
        btn_clear: 'Clear FCC',

        fcc_panel_title: 'FCC Summary Content',
        footer_hint: '💡 Tested optimal: n=5; m is now auto-computed from recent average message size to fill 85% of the context',

        metric_rounds: 'Rounds',
        metric_context: 'Context',
        metric_fcc: 'FCC',
        metric_block: 'Block',
        metric_api: 'Est. calls',
        metric_block_title: 'Effective block size (auto-raised by available context during compression, cap 49152)',
        metric_api_title: 'Estimated API calls for the next compression (chunked compression + possible single FCC fold)',

        prompt_compress: `You are an information compression engine, not a story author. Extract key information from the chat log and output in the specified JSON format.
{block_note}
## Forbidden
- No continuation / speculation / fabrication / verbatim copying
- No output other than JSON

{prior_context}## Chat Log to Compress (block {block_index}/{block_count})
{block_text}

## ⚠️ Strict Limits
1. Extract from original text only; never fabricate.
2. **Total length must be within {max_chars} characters! Excess will be truncated.**
3. **Retention priority (high → low):**
   - [Highest] Relationship turning points: confession, break-up, promises/vows, identity or ability reveals
   - [High] Foreshadowing & suspense: mentioned-but-unexplored threads, plans, "we'll deal with it later" items
   - [Medium] Character state changes: location, knowledge, goals, equipment
   - [Medium] Key events & action decisions
4. **Can omit:** greetings, repeated daily routines, pure scenery, interjections, jokes.

## Output Format (JSON)
{
  "events": "event1→event2→event3",
  "relationship": "relationship change description",
  "emotion": "emotional trajectory",
  "hooks": "foreshadowing / promises / unexplored threads; write 'none' if absent"
}`,
        prompt_block_note: '⚠️ This is block {i}/{n}, compress only this block.',

        prompt_fold: `You are a history merging engine. Merge the 【existing summary】 and 【new summary】 into a more concise summary.
No fabrication, only merge existing information.

## Existing Summary
{old_fcc}

## New Summary
[History Summary] {new_summary}

## Output Requirements
1. Output the merged concise summary directly, no prefix.
2. Total length must be within {max_chars} characters.
3. Keep the [Events]/[Relationship]/[Emotion] structure.`,
    },
};

function getLang() {
    const settings = extension_settings[EXT_NAME];
    return (settings?.lang === 'en') ? 'en' : 'zh';
}

function t(key, params) {
    const lang = getLang();
    let str = I18N[lang]?.[key] ?? I18N.zh[key] ?? key;
    if (typeof str === 'string' && params) {
        str = str.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? params[k] : `{${k}}`));
    }
    return str;
}

function applyLanguageToUI() {
    const lang = getLang();
    const dict = I18N[lang] || I18N.zh;

    $('.tokensaving-settings [data-i18n]').each(function () {
        const key = $(this).attr('data-i18n');
        const val = dict[key];
        if (val !== undefined) $(this).text(val);
    });

    const btnLabel = dict.lang_btn_label || (lang === 'zh' ? 'EN' : '中文');
    $('#tokensaving_lang_text').text(btnLabel);

    const settings = extension_settings[EXT_NAME];
    if (settings) {
        updatePresetCurrentLabel(settings);
        updateMetrics(settings);
    }
}

// ==================== 上下文档位 → 分块大小映射 ====================
// 各上下文档位对应的「分块大小下限参考」，必须与 PRESETS 里的 blockTokens 保持一致。
function tierToBlockTokens(tier) {
    switch (tier) {
        case 4096:   return 1024;
        case 8192:   return 4096;
        case 16384:  return 8192;
        case 100000: return 16384;
        default:     return 1024;
    }
}

// ==================== 预设表 ====================
// DEFAULT_FILL_PERCENT：窗口填充目标，各档默认一致（88%）。
// 实测 90% 会刚好挤出上下文，故留 12% 余量。用户可在面板调整，调整后转为「自定义」。
const DEFAULT_FILL_PERCENT = 88;

const PRESETS = {
    '4096_auto': {
        n: 5, m: 20,
        fillPercent: DEFAULT_FILL_PERCENT,
        maxSummaryTokens: 210,
        fccBudget: 525,
        blockTokens: 1024,
        maxApiCalls: 4,
    },
    '8192_auto': {
        n: 5, m: 40,
        fillPercent: DEFAULT_FILL_PERCENT,
        maxSummaryTokens: 256,
        fccBudget: 640,
        blockTokens: 4096,
        maxApiCalls: 3,
    },
    '16384_auto': {
        n: 5, m: 80,
        fillPercent: DEFAULT_FILL_PERCENT,
        maxSummaryTokens: 300,
        fccBudget: 750,
        blockTokens: 8192,
        maxApiCalls: 3,
    },
    '100000_auto': {
        n: 5, m: 160,
        fillPercent: DEFAULT_FILL_PERCENT,
        maxSummaryTokens: 400,
        fccBudget: 1000,
        blockTokens: 16384,
        maxApiCalls: 4,
    },
};

const PRESET_TIER_LABEL = {
    4096: '4k',
    8192: '8k',
    16384: '16k',
    100000: '100k',
};

// ==================== 默认设置 ====================
const defaultSettings = {
    enabled: true,
    n: 5,
    m: 14,
    fillPercent: DEFAULT_FILL_PERCENT,
    maxSummaryTokens: 210,
    fccBudget: 525,
    activePreset: '4096_auto',
    lang: 'zh',
    blockTokens: 1024,
    maxApiCalls: 5,
    compressContext: 64000,
    // 前缀（世界书 + 角色设定 + 系统提示词等）占用的 token 数。
    // 0 = 自动（优先用运行时实测值，其次按系统提示词/角色卡估算）。
    prefixTokens: 0,
};

// ==================== 全局状态 ====================
let currentFCC = null;
let compressionState = 'idle';
let abortRequested = false;
let pollTimer = null;
let inputWasLocked = false;

// ==================== 初始化 ====================
export async function init() {
    if (window.__tokensaving_initialized) return;
    window.__tokensaving_initialized = true;

    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { ...defaultSettings, charData: {} };
    }
    const settings = extension_settings[EXT_NAME];
    if (!settings.charData) settings.charData = {};
    if (!settings.lang) settings.lang = 'zh';
    if (settings.maxApiCalls === undefined) settings.maxApiCalls = 5;
    if (settings.compressContext === undefined) settings.compressContext = 64000;
    if (settings.prefixTokens === undefined) settings.prefixTokens = 0;
    if (settings.fillPercent === undefined) settings.fillPercent = DEFAULT_FILL_PERCENT;

    // 前缀已改为「只由插件自动测量」，手动值彻底停用：
    // 历史版本可能残留的手动值一律清除，避免继续覆盖自动结果。
    if (Number(settings.prefixTokens) !== 0) {
        console.log(`TokenSaving: 前缀手动值 ${settings.prefixTokens} 已停用（现为自动测量），清零`);
        settings.prefixTokens = 0;
    }

    if (settings.blockTokens === undefined || settings.blockTokens === 0) {
        const { tier } = detectContextTier();
        settings.blockTokens = tierToBlockTokens(tier);
        console.log(`TokenSaving: blockTokens 迁移为 ${settings.blockTokens}（档位 ${tier}）`);
    }

    if (typeof settings.activePreset === 'string' && settings.activePreset.endsWith('_quality')) {
        const oldKey = settings.activePreset;
        const tierPart = oldKey.split('_')[0];
        settings.activePreset = `${tierPart}_auto`;
        console.log(`TokenSaving: 迁移旧预设 ${oldKey} → ${settings.activePreset}`);
    }

    if (!settings.activePreset) {
        const { tier } = detectContextTier();
        settings.activePreset = `${tier}_auto`;
    }

    try {
        const settingsHtml = await $.get(`scripts/extensions/third-party/TokenSavingPlugin/settings.html`);
        $('#extensions_settings').append(settingsHtml);
    } catch (err) {
        console.error('TokenSaving: 无法加载 settings.html', err);
        return;
    }

    syncPresetWithContext(settings, true);
    saveSettingsDebounced();

    applyLanguageToUI();
    bindUIEvents(settings);

    const ctx = SillyTavern.getContext();

    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
        currentFCC = loadFCC();
        if (currentFCC && settings.enabled) {
            injectFCC(currentFCC);
            restoreHiddenMessages();
        }
        syncPresetWithContext(settings, true);
        updateUIState(settings);
    });

    ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, () => {
        updateMetrics(settings);            // 每条 AI 回复都刷新面板（不依赖压缩任务是否触发）
        triggerCompression(settings, 'ai_replied', false);
    });

    ctx.eventSource.on(ctx.eventTypes.GENERATION_AFTER_COMMANDS, (type, _, dryRun) => {
        if (type === 'quiet' || dryRun) return;
        syncPresetWithContext(settings, true);
        updateMetrics(settings);
        triggerCompression(settings, 'after_cmd', false);
    });

    pollTimer = setInterval(() => {
        updateMetrics(settings);            // 定时刷新，保证窗口可视化随聊天持续更新
        if (settings.enabled && compressionState === 'idle') {
            triggerCompression(settings, 'poll', false);
        }
    }, POLL_INTERVAL);

    ctx.eventSource.on(ctx.eventTypes.MESSAGE_SENDING, () => {
        updateMetrics(settings);            // 用户发出消息时也刷新
        if (compressionState !== 'idle') {
            try { toastr.warning(t('toast_input_warning'), 'TokenSaving'); } catch (e) {}
            return false;
        }
        return true;
    });

    $(document).on('click.tokensaving', '#send_but', function (e) {
        if (compressionState !== 'idle') {
            e.preventDefault();
            e.stopImmediatePropagation();
            try { toastr.warning(t('toast_input_warning'), 'TokenSaving'); } catch (err) {}
            return false;
        }
    });

    // ★ 测量真实前缀 token：在请求组装完成后拿到「模板总 token」，
    //   减去可见历史即得前缀（系统提示词 + 角色设定 + 世界书等）。
    //   事件名按不同版本做多重探测，拿不到就自动退回估算/手动校准。
    bindPrefixMeasurementEvents(ctx, settings);

    currentFCC = loadFCC();
    if (currentFCC && settings.enabled) injectFCC(currentFCC);
    refreshPrefixEstimate();
    updateUIState(settings);

    // 自动打印一次前缀诊断，便于定位「前缀读不到」的问题（无需手动开诊断模式）
    setTimeout(() => { dumpPrefixDiagnostics().catch(() => {}); }, 1500);

    console.log('TokenSaving: 初始化完成, lang =', settings.lang, 'preset =', settings.activePreset);
}

// ==================== 上下文检测 ====================
function detectContextTier() {
    let ctxSize = 4096;
    try {
        if (typeof getMaxPromptTokens === 'function') {
            ctxSize = getMaxPromptTokens() || 4096;
        }
    } catch { /* ignore */ }

    if (ctxSize <= 6144)  return { tier: 4096,   size: ctxSize };
    if (ctxSize <= 12288) return { tier: 8192,   size: ctxSize };
    if (ctxSize <= 24576) return { tier: 16384,  size: ctxSize };
    return { tier: 100000, size: ctxSize };
}

// ==================== 分块大小 ====================
function getBlockTokens(settings) {
    const v = Number(settings?.blockTokens);
    if (Number.isFinite(v) && v > 0) return v;
    const { tier } = detectContextTier();
    return tierToBlockTokens(tier);
}

function getAvailableContextTokens() {
    let maxCtx = 4096;
    try {
        if (typeof getMaxPromptTokens === 'function') {
            maxCtx = getMaxPromptTokens() || 4096;
        }
    } catch { /* ignore */ }
    return maxCtx;
}

// 当前上下文下，单次压缩请求可用于承载「待压缩文本」的 token 空间。
function calcAvailableCompressTokens(responseLength) {
    const maxCtx = getAvailableContextTokens();
    const outputReserve = Math.max(Number(responseLength) || 600, 600);
    return maxCtx
        - COMPRESS_FIXED_OVERHEAD
        - outputReserve
        - COMPRESS_SAFETY_MARGIN;
}

function calcEffectiveBlockTokens(settings, responseLength) {
    const desired = getBlockTokens(settings);
    const maxCtx = getAvailableContextTokens();
    const available = calcAvailableCompressTokens(responseLength);

    if (available < COMPRESS_MIN_BLOCK) {
        return { blockTokens: COMPRESS_MIN_BLOCK, limited: true, insufficient: true, maxCtx, available };
    }

    // 单块优先：尽量把整段历史塞进 1 次请求，因此取「用户设定值」与「可达空间」的较大者。
    const effectiveMax = Math.min(available, SINGLE_CALL_BLOCK_MAX);

    if (effectiveMax > desired) {
        return { blockTokens: effectiveMax, limited: false, singlePass: true, maxCtx, available };
    }

    return { blockTokens: desired, limited: false, singlePass: false, maxCtx, available };
}

// 当前配置下「实际会生效」的单块大小。
// 依据「压缩发送上限」（0 = 跟随 SillyTavern 设置）推算，与压缩时的运行时逻辑保持一致，
// 供预设写入与面板展示复用，避免「设定值」与「实际值」两套数字并存。
function computeEffectiveBlockTokens(settings, responseLength) {
    const desired = getBlockTokens(settings);
    const maxSummaryTokens = Math.max(50, Number(settings?.maxSummaryTokens) || 210);
    const responseLen = Math.max(Number(responseLength) || maxSummaryTokens * 4, 600);
    const cap = Math.max(0, Number(settings?.compressContext) || 0);
    const baseCtx = cap > 0 ? cap : getAvailableContextTokens();
    const available = Math.max(
        COMPRESS_MIN_BLOCK,
        baseCtx - COMPRESS_FIXED_OVERHEAD - responseLen - COMPRESS_SAFETY_MARGIN
    );
    return Math.min(SINGLE_CALL_BLOCK_MAX, Math.max(desired, available));
}

// ==================== 临时放宽 SillyTavern 上下文 ====================
function findContextSettingsObject() {
    try {
        const ctx = SillyTavern.getContext();
        const candidates = [
            ctx?.chatCompletionSettings,
            ctx?.oai_settings,
            window?.oai_settings,
            window?.chatCompletionSettings,
        ];
        for (const obj of candidates) {
            if (obj && typeof obj.openai_max_context === 'number') {
                return obj;
            }
        }
    } catch (err) {
        console.warn('TokenSaving: 查找上下文设置对象失败', err);
    }
    return null;
}

function tryExpandContext(targetTokens) {
    const obj = findContextSettingsObject();
    if (!obj) return () => {};

    const original = obj.openai_max_context;
    if (!Number.isFinite(targetTokens) || targetTokens <= original) {
        return () => {};
    }

    obj.openai_max_context = targetTokens;
    console.log(`TokenSaving: 临时扩大上下文 ${original} → ${targetTokens}`);
    try {
        toastr.info(
            t('toast_context_expanded', { from: original, to: targetTokens }),
            'TokenSaving',
            { timeOut: 4000 }
        );
    } catch (e) {}

    return () => {
        obj.openai_max_context = original;
        console.log(`TokenSaving: 恢复上下文 → ${original}`);
    };
}

// ==================== 熔断机制 ====================
function isFatalApiError(msg) {
    return FATAL_API_ERROR_RE.test(String(msg || ''));
}

function tripCircuitBreaker(reason) {
    apiCircuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN;
    console.warn(`TokenSaving: 触发熔断，暂停 ${CIRCUIT_BREAKER_COOLDOWN / 1000}s（原因：${reason}）`);
    try {
        toastr.error(t('toast_circuit_breaker'), 'TokenSaving', { timeOut: 12000 });
    } catch (e) {}
}

function resetCircuitBreaker() {
    if (apiCircuitBreakerUntil > 0) {
        console.log('TokenSaving: 手动重置熔断');
    }
    apiCircuitBreakerUntil = 0;
}

// ==================== 预设解析 / 应用 / 同步 ====================

function isAutoPreset(settings) {
    const active = settings?.activePreset;
    if (!active || active === 'custom') return false;
    return String(active).endsWith('_auto');
}

function resolveActivePresetKey(settings) {
    if (!isAutoPreset(settings)) return null;
    const { tier } = detectContextTier();
    const key = `${tier}_auto`;
    return PRESETS[key] ? key : null;
}

function presetDisplayLabel(presetKey) {
    const tierStr = String(presetKey).split('_')[0];
    return PRESET_TIER_LABEL[Number(tierStr)] || tierStr;
}

function applyPreset(settings, presetKey, silent = false) {
    const preset = PRESETS[presetKey];
    if (!preset) return false;

    settings.n = preset.n;
    settings.m = preset.m;
    settings.fillPercent = preset.fillPercent ?? DEFAULT_FILL_PERCENT;
    settings.maxSummaryTokens = preset.maxSummaryTokens;
    settings.fccBudget = preset.fccBudget;
    // 分块大小不再写「提示值」，直接写入当前配置下实际会生效的值，
    // 使输入框、面板、运行逻辑三者始终是同一个数字。
    settings.blockTokens = computeEffectiveBlockTokens({ ...settings, blockTokens: preset.blockTokens });
    settings.maxApiCalls = preset.maxApiCalls;
    settings.compressContext = 64000;
    settings.activePreset = presetKey;

    saveSettingsDebounced();
    updateUIState(settings);

    if (!silent) {
        try { toastr.success(t('toast_preset_applied', { label: presetDisplayLabel(presetKey) }), 'TokenSaving'); } catch (e) {}
    }
    console.log('TokenSaving: 应用预设', presetKey, preset);
    return true;
}

function syncPresetWithContext(settings, silent = true) {
    if (!isAutoPreset(settings)) return false;

    const { tier } = detectContextTier();
    const targetKey = `${tier}_auto`;
    if (!PRESETS[targetKey]) return false;

    if (settings.activePreset === targetKey) return false;

    console.log(`TokenSaving: 上下文档位变化 ${settings.activePreset} → ${targetKey}，同步预设`);
    return applyPreset(settings, targetKey, silent);
}

function updatePresetCurrentLabel(settings) {
    const $el = $('#tokensaving_preset_current');
    if (!$el.length) return;

    // 只用来判断「当前是否处于自动预设模式」，参数一律显示实际生效值，
    // 不再读取预设表里的静态快照 —— 否则 m / 摘要 / FCC 被自动计算或手动改过之后，
    // 这里会与输入框显示的值互相矛盾。
    const key = resolveActivePresetKey(settings);

    if (key) {
        $el.text(t('status_preset_current', {
            label: presetDisplayLabel(key),
            n: Number(settings.n) || 5,
            m: Number(settings.m) || 0,
            summary: Number(settings.maxSummaryTokens) || 0,
            fcc: Number(settings.fccBudget) || 0,
            block: getBlockTokens(settings),
        }));
    } else {
        $el.text(t('status_preset_current_custom', {
            n: Number(settings.n) || 5,
            m: Number(settings.m) || 0,
            summary: Number(settings.maxSummaryTokens) || 0,
            fcc: Number(settings.fccBudget) || 0,
            block: getBlockTokens(settings),
        }));
    }
}

// ==================== 触发入口 ====================
function triggerCompression(settings, reason, manual = false) {
    if (!settings.enabled && !manual) return;
    if (compressionState !== 'idle') return;

    // 熔断期内，自动触发直接跳过
    if (!manual && Date.now() < apiCircuitBreakerUntil) {
        const remain = Math.ceil((apiCircuitBreakerUntil - Date.now()) / 1000);
        console.log(`TokenSaving: 熔断中，跳过触发（剩余 ${remain}s）`);
        return;
    }
    // 手动点击时重置熔断（用户可能已充值）
    if (manual) resetCircuitBreaker();

    runCompression(settings, reason, manual).catch(err => {
        console.error('TokenSaving: 压缩任务异常', err);
    });
}

// ==================== UI 事件 ====================
function bindUIEvents(settings) {
    $('#tokensaving_enabled').on('change', function () {
        settings.enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        if (!settings.enabled && currentFCC) removeFCC();
        else if (settings.enabled && currentFCC) injectFCC(currentFCC);
    });

    const markCustom = () => {
        if (settings.activePreset !== 'custom') {
            settings.activePreset = 'custom';
        }
        updatePresetCurrentLabel(settings);
        $('.ts-preset-btn').removeClass('is-active');
        saveSettingsDebounced();
    };

    $('#tokensaving_fill_percent').on('input', function () {
        let v = parseInt($(this).val());
        if (!Number.isFinite(v)) v = DEFAULT_FILL_PERCENT;
        settings.fillPercent = Math.max(50, Math.min(100, v));
        markCustom();
        updateMetrics(settings);
    });
    $('#tokensaving_n').on('input', function () {
        settings.n = parseInt($(this).val()) || 5;
        markCustom(); updateMetrics(settings);
    });
    $('#tokensaving_m').on('input', function () {
        if (settings.activePreset !== 'custom') {
            // m 在预设模式下自动计算，手动改动即转为自定义配置
            settings.activePreset = 'custom';
            $(this).prop('readonly', false);
            $('.ts-preset-btn').removeClass('is-active');
            if (window.toastr) { try { toastr.info(t('toast_window_custom'), 'TokenSaving'); } catch (e) {} }
            updatePresetCurrentLabel(settings);
            saveSettingsDebounced();
        }
        settings.m = Math.max(1, parseInt($(this).val()) || 20);
        updatePresetCurrentLabel(settings);
        updateMetrics(settings);
    });
    $('#tokensaving_max_summary_tokens').on('input', function () {
        settings.maxSummaryTokens = parseInt($(this).val()) || 210;
        markCustom();
        updateMetrics(settings);
    });
    $('#tokensaving_fcc_budget').on('input', function () {
        settings.fccBudget = parseInt($(this).val()) || 525;
        markCustom();
        updateMetrics(settings);
    });
    $('#tokensaving_block_tokens').on('input', function () {
        let v = parseInt($(this).val());
        if (!Number.isFinite(v) || v <= 0) {
            const { tier } = detectContextTier();
            v = tierToBlockTokens(tier);
        }
        settings.blockTokens = Math.max(256, v);
        markCustom();
    });
    $('#tokensaving_max_api_calls').on('input', function () {
        settings.maxApiCalls = Math.max(1, parseInt($(this).val()) || 5);
        markCustom();
    });
    $('#tokensaving_compress_context').on('input', function () {
        let v = parseInt($(this).val());
        if (!Number.isFinite(v) || v < 0) v = 0;
        settings.compressContext = v;
        // 分块大小随「压缩发送上限」联动：预设模式下自动跟随，自定义模式下只刷新面板显示
        if (isAutoPreset(settings)) {
            settings.blockTokens = computeEffectiveBlockTokens(settings);
            $('#tokensaving_block_tokens').val(settings.blockTokens);
        }
        updateMetrics(settings);
        saveSettingsDebounced();
    });

    $('#tokensaving_lang_btn').on('click', function () {
        settings.lang = (settings.lang === 'en') ? 'zh' : 'en';
        saveSettingsDebounced();
        applyLanguageToUI();
        updateUIState(settings);
        try { toastr.info(`Language: ${settings.lang === 'en' ? 'English' : '中文'}`, 'TokenSaving'); } catch (e) {}
    });

    $('.ts-preset-btn').on('click', function () {
        const { tier } = detectContextTier();
        const key = `${tier}_auto`;
        applyPreset(settings, key, false);
    });

    $('#tokensaving_manual_btn').on('click', () => {
        if (compressionState !== 'idle') {
            try { toastr.info(t('toast_already_running'), 'TokenSaving'); } catch (e) {}
            return;
        }
        triggerCompression(settings, 'manual', true);
    });
    $('#tokensaving_stop_btn').on('click', () => abortCompression());
    $('#tokensaving_clear_btn').on('click', () => clearFCC(settings));

    // 点击窗口徽标切换诊断模式：把自适应 m 的计算依据显示在面板并输出到控制台
    $(document).on('click.tokensaving_diag', '#tokensaving_window_badge', () => {
        diagMode = !diagMode;
        try {
            toastr.info(
                diagMode
                    ? (getLang() === 'en' ? 'Diagnostics ON — calculation basis shown below the m field' : '诊断模式已开启 —— 计算依据显示在 m 输入框下方')
                    : (getLang() === 'en' ? 'Diagnostics OFF' : '诊断模式已关闭'),
                'TokenSaving',
            );
        } catch (e) {}
        console.log(`[TokenSaving 诊断] diagMode = ${diagMode}`);
        if (diagMode) dumpPrefixDiagnostics();
        updateMetrics(settings);
    });
}

// ==================== 中止压缩 ====================
function abortCompression() {
    if (compressionState !== 'running') return;
    abortRequested = true;
    compressionState = 'aborting';
    updateStatus(`状态: ${t('status_aborting')}`);
    try { toastr.info(t('toast_abort_requested'), 'TokenSaving'); } catch (e) {}
}

// ==================== 输入锁定/解锁 ====================
function lockInput(reason) {
    if (inputWasLocked) return;
    try {
        $('#send_textarea').prop('disabled', true).attr('placeholder', reason || 'TokenSaving...');
        $('#send_but').prop('disabled', true);
        $('#send_form').css('opacity', '0.6');
        inputWasLocked = true;
    } catch (err) {
        console.warn('TokenSaving: 锁定输入失败', err);
    }
}

function unlockInput() {
    if (!inputWasLocked) return;
    try {
        $('#send_textarea').prop('disabled', false).attr('placeholder', '');
        $('#send_but').prop('disabled', false);
        $('#send_form').css('opacity', '1');
        inputWasLocked = false;
    } catch (err) {
        console.warn('TokenSaving: 解锁输入失败', err);
    }
}

// ==================== 核心：压缩执行 ====================
async function runCompression(settings, reason, manual = false) {
    if (compressionState !== 'idle') return;

    const ctx = SillyTavern.getContext();
    const chat = ctx.chat;
    if (!chat || chat.length === 0) return;

    const visibleMsgs = chat.filter(m => m.mes && !m.is_system);
    if (visibleMsgs.length === 0) return;

    const fullText = visibleMsgs.map(m => m.mes).join('\n');
    const currentTokens = await countTokens(fullText);
    const maxTokens = (typeof getMaxPromptTokens === 'function' ? getMaxPromptTokens() : 4096) || 4096;
    const usagePercent = (currentTokens / maxTokens) * 100;

    const totalRounds = Math.floor(visibleMsgs.length / 2);
    const n = Math.max(1, Number(settings.n) || 5);

    // m 由「最近消息平均量」自动分配，目标是把窗口预算填到 settings.fillPercent，
    // 而非固定轮数：剧情变长时 m 自动变小，变短时自动变大。
    // 注：不再有独立的「Token 兜底阈值」——自适应 m 已按 Token 量分配窗口，
    //     再加一个百分比兜底会与之冲突（可能提前触发或永远轮不到）。
    const adaptive = computeAdaptiveM(settings, visibleMsgs);
    const m = adaptive.m;
    settings.m = m;

    const overWindow = totalRounds > n + m;

    if (!manual && !overWindow) {
        updateStatus(`状态: ${t('status_growing', { rounds: totalRounds, max: n + m, percent: usagePercent.toFixed(1) })}`);
        updateMetrics(settings);
        return;
    }

    if (totalRounds <= n) {
        if (manual) updateStatus(`状态: ${t('status_too_few', { rounds: totalRounds, n })}`);
        updateMetrics(settings);
        return;
    }

    compressionState = 'running';
    abortRequested = false;
    lockInput('TokenSaving...');
    $('#tokensaving_stop_btn').show();

    if (overWindow) {
        updateStatus(`状态: ${t('status_overflow', { rounds: totalRounds, max: n + m })}`);
    } else {
        // 走到这里只有「手动点立即压缩」
        updateStatus(`状态: ${t('status_manual')}`);
    }

    const retainCount = n * 2;
    const compressCount = visibleMsgs.length - retainCount;
    const toCompress = visibleMsgs.slice(0, compressCount);

    if (toCompress.length === 0) {
        compressionState = 'idle';
        $('#tokensaving_stop_btn').hide();
        unlockInput();
        updateMetrics(settings);
        return;
    }

    const compressText = toCompress
        .map(mx => `${mx.is_user ? (getLang() === 'en' ? 'User' : '用户') : (mx.name || (getLang() === 'en' ? 'Character' : '角色'))}: ${mx.mes.trim()}`)
        .join('\n');

    const startIdx = chat.indexOf(toCompress[0]);
    const endIdx = chat.indexOf(toCompress[toCompress.length - 1]);

    const responseLengthHint = Math.max((Number(settings.maxSummaryTokens) || 210) * 4, 600);
    const blockInfo = calcEffectiveBlockTokens(settings, responseLengthHint);

    if (blockInfo.insufficient) {
        const msg = t('err_context_exceeded', { block: getBlockTokens(settings) });
        console.warn(`TokenSaving: 可用上下文过小。maxCtx=${blockInfo.maxCtx}, available=${blockInfo.available}`);
        updateStatus(`状态: ${t('status_failed', { msg: '上下文过小' })}`);
        try { toastr.error(msg.replace(/\n/g, '<br>'), 'TokenSaving', { timeOut: 10000 }); } catch (e) {}
        compressionState = 'idle';
        abortRequested = false;
        $('#tokensaving_stop_btn').hide();
        unlockInput();
        updateMetrics(settings);
        return;
    }

    if (blockInfo.limited) {
        console.log(`TokenSaving: 分块大小自适应 ${getBlockTokens(settings)} → ${blockInfo.blockTokens}（可用 ${blockInfo.available} tok）`);
    }

    const compressTokens = estimateTokens(compressText);

    const userMaxApiCalls = Math.max(1, Number(settings.maxApiCalls) || 5);

    // 压缩期间临时放宽 SillyTavern 上下文。
    // 申请量必须由「待压内容的实际大小」驱动，而不是由块大小反推 ——
    // 否则块大小越小于内容，申请的上下文就越小，有效块大小永远上不去（自锁）。
    const userCap = Math.max(0, Number(settings.compressContext) || 0);
    const compressResponseLen = getCompressResponseLength(settings);
    const neededContext = Math.max(blockInfo.blockTokens, compressTokens)
        + COMPRESS_FIXED_OVERHEAD
        + compressResponseLen
        + COMPRESS_SAFETY_MARGIN;
    const targetContext = Math.max(userCap, neededContext);
    const restoreContext = tryExpandContext(targetContext);

    // 上下文放宽后重算块大小：取「用户设定值」与「放宽后的可达空间」中的较大者
    // （硬上限 SINGLE_CALL_BLOCK_MAX）。这样即便上下文放宽失败，
    // 也保证单块不小于用户设定值；放宽成功时则尽量一次压完整段历史。
    let blockTokens = Math.min(
        SINGLE_CALL_BLOCK_MAX,
        Math.max(blockInfo.blockTokens, calcEffectiveBlockTokens(settings, responseLengthHint).blockTokens)
    );

    // 自检已移除，只剩「分块压缩」+ 可能的「FCC 折叠」：预留 1 次调用。
    const reserveCalls = 1;
    let finalBlocks = Math.max(1, Math.ceil(compressTokens / blockTokens));

    // 极端情况：块数超过硬上限时，用放宽后的可用空间再试一次
    if (finalBlocks > HARD_API_CAP && blockTokens < SINGLE_CALL_BLOCK_MAX) {
        const widened = Math.min(SINGLE_CALL_BLOCK_MAX, calcAvailableCompressTokens(responseLengthHint));
        if (widened > blockTokens) {
            blockTokens = widened;
            finalBlocks = Math.max(1, Math.ceil(compressTokens / blockTokens));
        }
    }

    // 放宽上下文后仍超出硬上限，才算真的过大
    if (finalBlocks > HARD_API_CAP) {
        console.warn(`TokenSaving: 内容过大 ${finalBlocks} 块 > 硬上限 ${HARD_API_CAP}，中止`);
        updateStatus(`状态: ${t('status_failed', { msg: `内容过大（${finalBlocks} 块）` })}`);
        try {
            toastr.error(
                getLang() === 'en'
                    ? `Content too large: ${finalBlocks} blocks exceeds cap ${HARD_API_CAP}. Reduce retention (n), raise "Compress context cap", or lower m.`
                    : `内容过大：约 ${finalBlocks} 块超过硬上限 ${HARD_API_CAP}。请减少保留轮数 n、提高「压缩发送上限」，或调小 m。`,
                'TokenSaving',
                { timeOut: 8000 }
            );
        } catch (e) {}
        restoreContext();
        compressionState = 'idle';
        abortRequested = false;
        $('#tokensaving_stop_btn').hide();
        unlockInput();
        updateMetrics(settings);
        return;
    }

    const effectiveMaxApiCalls = Math.min(HARD_API_CAP, Math.max(userMaxApiCalls, finalBlocks + reserveCalls));

    if (effectiveMaxApiCalls > userMaxApiCalls) {
        console.log(`TokenSaving: 自动提升 API 上限 ${userMaxApiCalls} → ${effectiveMaxApiCalls}（约 ${finalBlocks} 块）`);
        try {
            toastr.info(
                getLang() === 'en'
                    ? `Large task: API limit raised to ${effectiveMaxApiCalls} (≈${finalBlocks} blocks)`
                    : `大任务：API 上限自动提升至 ${effectiveMaxApiCalls}（约 ${finalBlocks} 块）`,
                'TokenSaving',
                { timeOut: 6000 }
            );
        } catch (e) {}
    }

    // 压缩前先隐藏待压消息：压缩请求只发送「指令 + 待压文本」，
    // 隐藏是为了让这些消息不再出现在主对话的后续请求里。
    await hideChatMessageRange(startIdx, endIdx, false);

    const apiCounter = { count: 0 };
    const bumpApi = () => {
        if (abortRequested) throw new Error(getLang() === 'en' ? 'Aborted by user' : '用户已中止压缩');
        apiCounter.count++;
        if (apiCounter.count > effectiveMaxApiCalls) {
            throw new Error(`API calls exceed limit (${effectiveMaxApiCalls})`);
        }
    };
    const checkAbort = () => {
        if (abortRequested) throw new Error(getLang() === 'en' ? 'Aborted by user' : '用户已中止压缩');
    };

    try {
        updateStatus(`状态: ${t('status_compressing', { count: toCompress.length })}`);
        // 压缩请求只发送「压缩指令 + 待压文本」：不注入角色卡 / 世界书 / 主对话历史。
        // 额外的设定内容会让模型进入角色扮演而不是执行摘要，反而破坏摘要质量。
        const summary = await compressToSummary(
            compressText, settings,
            apiCounter, bumpApi, checkAbort,
            blockTokens
        );

        checkAbort();
        if (!summary || !summary.trim()) {
            throw new Error(getLang() === 'en' ? 'AI returned empty summary' : 'AI 未返回有效的压缩结果');
        }

        checkAbort();

        if (!currentFCC) {
            currentFCC = { content: { raw: '' }, hidden_message_indices: [] };
        }
        if (!currentFCC.hidden_message_indices) currentFCC.hidden_message_indices = [];

        const historyTag = getLang() === 'en' ? '[History Summary]' : '[历史摘要]';
        let newFCCRaw = currentFCC.content.raw
            ? currentFCC.content.raw + `\n${historyTag} ${summary}`
            : `${historyTag} ${summary}`;

        const fccBudget = Math.max(50, Number(settings.fccBudget) || 525);
        if (estimateTokens(newFCCRaw) > fccBudget) {
            updateStatus(`状态: ${t('status_folding', { current: apiCounter.count, max: effectiveMaxApiCalls })}`);
            const folded = await foldFCC(currentFCC.content.raw, summary, fccBudget, bumpApi, checkAbort);
            newFCCRaw = folded || `${historyTag} ${summary}`;
        }

        if (estimateTokens(newFCCRaw) > fccBudget) {
            newFCCRaw = truncateToTokens(newFCCRaw, fccBudget);
        }

        currentFCC.content.raw = newFCCRaw;

        await hideMessages(chat, startIdx, endIdx, currentFCC);
        saveFCC(currentFCC);
        injectFCC(currentFCC);

        const newVisibleCount = Math.floor((visibleMsgs.length - toCompress.length) / 2);
        updateStatus(`状态: ${t('status_complete', { rounds: newVisibleCount, api: apiCounter.count })}`);
        try { toastr.success(t('toast_complete', { rounds: newVisibleCount }), 'TokenSaving'); } catch (e) {}
        updateUIState(settings);
    } catch (err) {
        const isAbort = abortRequested || /abort|中止/i.test(err.message || '');
        console.warn('TokenSaving: 压缩失败/中止，回退', err);
        try { await hideChatMessageRange(startIdx, endIdx, true); } catch (e) { /* ignore */ }

        if (isAbort) {
            updateStatus(`状态: ${t('status_aborted')}`);
            try { toastr.info(t('toast_abort_done'), 'TokenSaving'); } catch (e) {}
        } else {
            updateStatus(`状态: ${t('status_failed', { msg: err.message })}`);
            try { toastr.error(t('toast_failed', { msg: err.message }), 'TokenSaving'); } catch (e) {}
        }
        updateUIState(settings);
    } finally {
        restoreContext();
        compressionState = 'idle';
        abortRequested = false;
        $('#tokensaving_stop_btn').hide();
        unlockInput();
    }
}

// ==================== 压缩：分块 + 前序传递 + JSON 指令 ====================
// 只发送「压缩指令 + 待压文本」；ref_context 固定为“无”，
// 不注入角色卡 / 世界书 / 角色设定（注入会让模型转入角色扮演而破坏摘要质量）。
async function compressToSummary(text, settings, apiCounter, bumpApi, checkAbort, effectiveBlockTokens) {
    const ctx = SillyTavern.getContext();
    const BLOCK_TOKENS = Math.max(COMPRESS_MIN_BLOCK, Number(effectiveBlockTokens) || getBlockTokens(settings));
    const blocks = splitIntoTokenBlocks(text, BLOCK_TOKENS);
    const summaries = [];
    const lang = getLang();

    const maxSummaryTokens = Math.max(50, Number(settings.maxSummaryTokens) || 210);
    const maxChars = lang === 'en' ? Math.floor(maxSummaryTokens * 4) : Math.floor(maxSummaryTokens * 1.5);
    const responseLength = Math.max(maxSummaryTokens * 4, 600);

    let priorContext = '';

    for (let i = 0; i < blocks.length; i++) {
        checkAbort();
        const blockText = blocks[i];
        const blockNote = blocks.length > 1
            ? '\n' + t('prompt_block_note', { i: i + 1, n: blocks.length })
            : '';

        const priorSection = (priorContext && blocks.length > 1)
            ? (lang === 'en'
                ? `\n## Prior summary (context only — DO NOT repeat in output)\n${priorContext}\n`
                : `\n## 前序摘要（仅供理解上下文，不要重复输出）\n${priorContext}\n`)
            : '';

        const prompt = t('prompt_compress', {
            block_note: blockNote,
            prior_context: priorSection,
            block_index: i + 1,
            block_count: blocks.length,
            block_text: blockText,
            max_chars: maxChars,
        });

        let result;
        try {
            result = await generateCompression(prompt, settings, bumpApi);
        } catch (err) {
            const msg = String(err?.message || err);
            if (abortRequested) throw err;
            if (/exceed limit/i.test(msg)) throw err;
            if (CONTEXT_ERROR_RE.test(msg)) {
                console.warn(`TokenSaving: block ${i + 1}/${blocks.length} 上下文超限`, msg);
                throw new Error(t('err_context_exceeded', { block: BLOCK_TOKENS }));
            }
            // 致命 API 错误 → 熔断 + 立即中止整轮
            if (isFatalApiError(msg)) {
                console.warn(`TokenSaving: block ${i + 1} 致命 API 错误，中止`, msg);
                tripCircuitBreaker(msg.slice(0, 120));
                throw new Error(t('err_fatal_api', { msg: msg.slice(0, 200) }));
            }
            console.warn(`TokenSaving: block ${i + 1} failed, skipping`, msg);
            continue;
        }

        const parsed = parseSummaryJson(result || '');

        if (parsed.events) {
            const tagEvents = lang === 'en' ? '[Events]' : '[事件]';
            const tagRel = lang === 'en' ? '[Relationship]' : '[关系]';
            const tagEmo = lang === 'en' ? '[Emotion]' : '[情感]';
            const tagHooks = lang === 'en' ? '[Hooks]' : '[伏笔]';
            const noChange = lang === 'en' ? 'no change' : '无变化';
            const stable = lang === 'en' ? 'stable' : '平稳';

            let summaryText = `${tagEvents} ${parsed.events} ${tagRel} ${parsed.relationship || noChange} ${tagEmo} ${parsed.emotion || stable}`;

            const hooksVal = (parsed.hooks || '').trim();
            if (hooksVal && hooksVal !== '无' && hooksVal.toLowerCase() !== 'none') {
                summaryText += ` ${tagHooks} ${hooksVal}`;
            }

            if (estimateTokens(summaryText) > maxSummaryTokens) {
                summaryText = truncateToTokens(summaryText, maxSummaryTokens);
            }
            summaries.push(summaryText);

            priorContext = summaries.slice(-2).join('\n').substring(0, 300);
        }
    }

    return summaries.join('\n');
}

function parseSummaryJson(text) {
    const result = { events: '', relationship: '', emotion: '', hooks: '' };
    const raw = String(text || '').trim();
    if (!raw) return result;

    let cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        const jsonStr = cleaned.slice(firstBrace, lastBrace + 1)
            .replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/\r/g, '\\n');
        try {
            const obj = JSON.parse(jsonStr);
            if (obj && typeof obj === 'object') {
                result.events = String(obj.events || '').trim();
                result.relationship = String(obj.relationship || '').trim();
                result.emotion = String(obj.emotion || '').trim();
                result.hooks = String(obj.hooks || '').trim();
                if (result.events) return result;
            }
        } catch { /* 继续容错 */ }
    }

    const grab = (field) => {
        const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, 'i');
        const match = cleaned.match(re);
        return match ? match[1].replace(/\\n/g, ' ').trim() : '';
    };
    result.events = grab('events');
    result.relationship = grab('relationship');
    result.emotion = grab('emotion');
    result.hooks = grab('hooks');

    if (!result.events && cleaned.length > 0 && cleaned.length < 800) {
        result.events = cleaned.replace(/^[\[{]+|[\]}]+$/g, '').trim().substring(0, 200);
    }
    return result;
}

async function foldFCC(oldFCC, newSummary, budget, bumpApi, checkAbort) {
    try {
        checkAbort();
        const ctx = SillyTavern.getContext();
        const lang = getLang();

        const safeBudget = Math.max(50, Number(budget) || 525);
        const maxChars = lang === 'en' ? Math.floor(safeBudget * 4) : Math.floor(safeBudget * 1.5);

        const prompt = t('prompt_fold', {
            old_fcc: oldFCC,
            new_summary: newSummary,
            max_chars: maxChars,
        });

        bumpApi();
        const result = await withTimeout(
            ctx.generateQuietPrompt({ quietPrompt: prompt, responseLength: Math.max(safeBudget * 3, 600) }),
            90000,
            'fold',
        );
        let folded = (result || '').trim();
        if (!folded) return null;

        if (estimateTokens(folded) > safeBudget) {
            folded = truncateToTokens(folded, safeBudget);
        }
        return folded;
    } catch (err) {
        if (abortRequested) throw err;
        if (/exceed limit/i.test(err.message || '')) throw err;
        if (isFatalApiError(err.message)) {
            tripCircuitBreaker(String(err.message || '').slice(0, 120));
            throw err;
        }
        console.warn('TokenSaving: FCC 折叠失败', err.message || err);
        return null;
    }
}

async function clearFCC(settings) {
    try {
        await unhideCoveredMessages();
        removeFCC();
        currentFCC = null;

        const key = getCharacterKey();
        if (key && settings.charData) {
            delete settings.charData[key];
            saveSettingsDebounced();
        }

        updateUIState(settings);
        try { toastr.info(t('toast_cleared'), 'TokenSaving'); } catch (e) {}
    } catch (err) {
        console.error('TokenSaving: 清除失败', err);
        try { toastr.error(t('toast_clear_failed', { msg: err.message }), 'TokenSaving'); } catch (e) {}
    }
}

function getCurrentCharacterData() {
    try {
        const ctx = SillyTavern.getContext();
        const charId = ctx?.characterId;
        if (charId !== undefined && charId !== null && ctx?.characters?.[charId]) {
            return ctx.characters[charId];
        }
        // 兜底：characterId 取不到时（实测中会出现 undefined），
        // 退用角色列表里的第一个——大多数场景下即当前角色。
        const list = ctx?.characters;
        if (Array.isArray(list) && list.length) return list[0];
    } catch (e) { /* ignore */ }
    return null;
}

// 压缩统一走【独立 quiet 请求】：只发送「压缩指令 + 待压内容」，
// 不携带主对话的系统提示词 / 世界书 / 角色卡 / 历史。
//
// ⚠️ 这一点是刻意的，不要为了复用缓存而改成"主对话前缀 + 追加指令"：
// 那样会把整套 RP 设定一起送进压缩请求，模型会进入角色扮演、
// 把压缩指令当作剧情的一部分回应，产出的"摘要"与聊天历史完全无关
// （实测曾产出"十七朵玫瑰的花语"这类通用知识），摘要质量彻底失效。
async function generateCompression(instruction, settings, bumpApi) {
    const ctx = SillyTavern.getContext();
    bumpApi();
    return withTimeout(
        ctx.generateQuietPrompt({
            quietPrompt: instruction,
            responseLength: getCompressResponseLength(settings),
        }),
        90000,
        'compress quiet',
    );
}

async function countTokens(text) {
    try {
        const ctx = SillyTavern.getContext();
        return await withTimeout(ctx.getTokenCountAsync(text), 10000, 'Token count');
    } catch (err) {
        return estimateTokens(text);
    }
}

function estimateTokens(text) {
    return Math.max(1, Math.ceil(String(text || '').length / 1.5));
}

function splitIntoTokenBlocks(text, maxTokens) {
    const lines = String(text || '').split('\n');
    const blocks = [];
    let current = [];
    let currentTokens = 0;

    for (const line of lines) {
        const lineTokens = estimateTokens(line);
        if (current.length && currentTokens + lineTokens > maxTokens) {
            blocks.push(current.join('\n'));
            current = [line];
            currentTokens = lineTokens;
        } else {
            current.push(line);
            currentTokens += lineTokens;
        }
    }
    if (current.length) blocks.push(current.join('\n'));
    return blocks.filter(b => b.trim());
}

function truncateToTokens(text, maxTokens) {
    const blocks = splitIntoTokenBlocks(text, maxTokens);
    return blocks.length ? blocks[0] : '';
}

async function withTimeout(promise, ms, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function getCharacterKey() {
    const ctx = SillyTavern.getContext();
    const charId = ctx.characterId;
    if (charId !== undefined && charId !== null) {
        return ctx.characters[charId]?.avatar || null;
    }
    return null;
}

function loadFCC() {
    const settings = extension_settings[EXT_NAME];
    if (!settings?.charData) return null;
    const key = getCharacterKey();
    if (!key) return null;
    return settings.charData[key]?.fcc || null;
}

function saveFCC(fcc) {
    const settings = extension_settings[EXT_NAME];
    if (!settings.charData) settings.charData = {};
    const key = getCharacterKey();
    if (!key) return;
    settings.charData[key] = { fcc };
    saveSettingsDebounced();
}

function injectFCC(fcc) {
    try {
        if (!fcc?.content?.raw) return;
        const ctx = SillyTavern.getContext();
        ctx.setExtensionPrompt(EXT_KEY, fcc.content.raw, 1, 9999, false, 0);
    } catch (err) {
        console.error('TokenSaving: FCC 注入失败', err);
    }
}

function removeFCC() {
    try {
        const ctx = SillyTavern.getContext();
        ctx.setExtensionPrompt(EXT_KEY, '', 1, 9999, false, 0);
    } catch (err) {
        console.error('TokenSaving: FCC 移除失败', err);
    }
}

async function hideMessages(chat, start, end, fcc) {
    try {
        await hideChatMessageRange(start, end, false);
        for (let i = start; i <= end; i++) {
            if (chat[i]) {
                chat[i].tokensaving_hidden = true;
                if (!fcc.hidden_message_indices.includes(i)) {
                    fcc.hidden_message_indices.push(i);
                }
            }
        }
    } catch (err) {
        console.warn('TokenSaving: 隐藏消息失败', err);
    }
}

async function restoreHiddenMessages() {
    const indices = currentFCC?.hidden_message_indices;
    if (!indices?.length) return;
    try {
        await hideChatMessageRange(indices[0], indices[indices.length - 1], false);
    } catch (err) {
        console.warn('TokenSaving: 恢复隐藏标记失败', err);
    }
}

async function unhideCoveredMessages() {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        if (!chat.length) return;

        const hiddenIndices = new Set(currentFCC?.hidden_message_indices || []);
        const toRestore = [];
        for (let i = 0; i < chat.length; i++) {
            const mx = chat[i];
            if (!mx) continue;
            if (mx.tokensaving_hidden || (mx.is_system && (hiddenIndices.has(i) || mx.mes?.trim()))) {
                toRestore.push(i);
                delete mx.tokensaving_hidden;
            }
        }
        if (toRestore.length === 0) return;

        await hideChatMessageRange(toRestore[0], toRestore[toRestore.length - 1], true);
        try { await printMessages(); } catch (e) { /* ignore */ }
    } catch (err) {
        console.warn('TokenSaving: 恢复消息失败', err);
    }
}

function updateStatus(text, state) {
    const inferState = (s) => {
        if (state) return state;
        if (!s) return 'idle';
        if (s.includes('✅') || /complete/i.test(s)) return 'success';
        if (s.includes('❌') || s.includes('⏹') || /failed|aborted/i.test(s)) return 'error';
        if (s.includes('🗜️') || s.includes('🚨') || s.includes('⚠️') || /compress|self-?check|folding/i.test(s)) return 'busy';
        if (s.includes('🌱') || /growing/i.test(s)) return 'growing';
        return 'idle';
    };

    const s = inferState(text);
    const clean = String(text || '').replace(/^(状态|Status)[:：]\s*/, '');

    $('#tokensaving_status').text(clean);

    const $dot = $('#tokensaving_status_dot');
    $dot.removeClass('is-idle is-growing is-busy is-success is-error').addClass(`is-${s}`);

    const $card = $('#tokensaving_status_card');
    $card.removeClass('is-busy is-success is-error');
    if (s === 'busy') $card.addClass('is-busy');
    else if (s === 'success') $card.addClass('is-success');
    else if (s === 'error') $card.addClass('is-error');
}


// 对外保持同步签名（调用点很多），内部走异步实现并吞掉异常
function updateMetrics(settings) {
    renderMetrics(settings).catch(err => {
        console.warn('TokenSaving: updateMetrics 失败', err);
    });
}

async function renderMetrics(settings) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const visibleMsgs = chat.filter(m => m.mes && !m.isSystem && !m.is_system);
        const rounds = Math.floor(visibleMsgs.length / 2);
        const n = Math.max(1, Number(settings.n) || 5);
        // 用自适应 m 作为窗口分母，保证面板显示与真实触发判定一致
        const adaptiveM = computeAdaptiveM(settings, visibleMsgs).m;
        const windowMax = n + adaptiveM;

        const $rounds = $('#tokensaving_rounds');
        if ($rounds.length) {
            $rounds.text(`${rounds} / ${windowMax}`);
            $rounds.css('color', rounds > windowMax ? 'var(--ts-danger, #ef4444)' : '');
        }

        let maxTokens = 4096;
        try {
            if (typeof getMaxPromptTokens === 'function') maxTokens = getMaxPromptTokens() || 4096;
        } catch { /* ignore */ }

        const fullText = visibleMsgs.map(x => x.mes).join('\n');

        const approxPercent = Math.min(100, (estimateTokens(fullText) / maxTokens) * 100);
        applyContextPercent(approxPercent, settings);

        scheduleRealTokenCount(visibleMsgs, maxTokens, settings);

        const fccTok = currentFCC?.content?.raw ? estimateTokens(currentFCC.content.raw) : 0;
        $('#tokensaving_fcctok').text(`${fccTok} tok`);

        const { size } = detectContextTier();
        $('#tokensaving_detected_ctx').text(`${size} tok`);

        renderWindowVisual(n, adaptiveM, rounds, visibleMsgs.length);

        // 先算前缀构成（含异步 token 统计），再刷新诊断行，保证明细是同一轮的
        await updatePrefixStatus(settings);
        updateAutoWindowParams(settings, visibleMsgs);
        updateCompressionEstimate(settings, visibleMsgs);
    } catch (err) {
        console.warn('TokenSaving: updateMetrics 失败', err);
    }
}

// ==================== 自适应 m（按最近消息量自动分配） ====================
// 思路：可见窗口填到「可用上下文 − 前缀」的 settings.fillPercent 时触发压缩。
// 平均单条消息量取自最近 RECENT_AVG_ROUNDS 轮消息（1 轮 = 用户 1 条 + AI 1 条），
// 因此剧情变长/变短时会自动跟上。
//   m = floor(目标窗口 tok / 平均每轮 tok) − n
const RECENT_AVG_ROUNDS = 30;                        // 参与均值统计的最近轮数
const RECENT_AVG_WINDOW = RECENT_AVG_ROUNDS * 2;     // 折算成消息条数（= 60 条）
// 当前生效的填充目标（0~1）。用户可在面板调整，默认 88%，随「自动」预设写入。
function getFillTarget(settings) {
    const pct = Number(settings?.fillPercent);
    const v = Number.isFinite(pct) && pct > 0 ? pct : DEFAULT_FILL_PERCENT;
    return Math.max(0.1, Math.min(1, v / 100));
}

// 诊断模式：点击窗口徽标切换。开启后面板会显示自适应 m 的完整计算依据。
let diagMode = false;

// ==================== 前缀 token 统计 ====================
// 世界书 + 角色设定 + 系统提示词等「每轮请求都带着、但不属于聊天历史」的内容，
// 会实打实占用上下文。若算窗口预算时不扣掉它们，算出的 m 会让
// 「前缀 + 历史」超出上下文窗口（旧版就是这个问题）。
//
// 获取优先级：
//   ① 运行时实测（生成事件里做「前缀/历史」分离，见 measurePrefixFromPayload）
//   ② 提示词管理器静态块加总 / 多来源估算（computePrefixTokens）
//   ③ 用户手动指定（最高优先级，非 0 时覆盖以上）
//
// ★ 结构转储：不再猜字段名。直接列出运行时实际提供了哪些字段、哪个字段里有长文本。
function dumpContextStructure() {
    const out = { '—— 上下文对象字段 ——': Object.keys(SillyTavern.getContext() || {}).sort().join(', ') };
    try {
        const ctx = SillyTavern.getContext();
        // 生成相关 API 探测
        const genFns = Object.keys(ctx || {}).filter(k => /^generate|^Generate|Raw|Quiet/.test(k));
        out['可用生成接口'] = genFns.length ? genFns.join(', ') : '（未发现）';
        out['generateQuietPrompt 可用'] = typeof ctx?.generateQuietPrompt === 'function' ? '是' : '否';
        // 主对话最终消息数组是否可见（决定能否「重放主对话 + 追加指令」）
        out['可见的请求相关字段'] = Object.keys(ctx || {})
            .filter(k => /prompt|message|chat|history/i.test(k)).sort().join(', ');
        out['ctx.chat 条数'] = Array.isArray(ctx?.chat) ? ctx.chat.length : '非数组';

        const charId = ctx?.characterId;
        const char = ctx?.characters?.[charId];
        out['characterId'] = String(charId);
        out['characters 数量'] = Array.isArray(ctx?.characters) ? ctx.characters.length : '非数组';
        if (char) {
            out['char 顶层字段'] = Object.keys(char).sort().join(', ');
            out['char.data 字段'] = char.data ? Object.keys(char.data).sort().join(', ') : '无 data';
            // 逐个字段量长度，找出真正的长文本在哪
            const lens = {};
            for (const [k, v] of Object.entries(char.data || {})) {
                if (typeof v === 'string' && v.trim()) lens[`data.${k}`] = v.length;
            }
            for (const [k, v] of Object.entries(char)) {
                if (typeof v === 'string' && v.trim() && v.length > 20) lens[k] = v.length;
            }
            out['char 各字段字符数'] = lens;
        } else {
            out['char'] = '取不到 ctx.characters[characterId]';
        }
        // 字段名按运行时实测为准：ctx 上真正的键是 powerUserSettings（不是 powerUser/power_user）
        const pu = ctx?.powerUserSettings || ctx?.powerUser || ctx?.power_user;
        out['powerUserSettings 存在'] = !!ctx?.powerUserSettings;
        out['powerUser（旧名）存在'] = !!(ctx?.powerUser || ctx?.power_user);
        if (pu) {
            out['powerUser 含文本的字段'] = Object.entries(pu)
                .filter(([, v]) => typeof v === 'string' && v.trim())
                .map(([k, v]) => `${k}(${v.length})`)
                .join(', ') || '（无）';
            out['powerUser 顶层字段'] = Object.keys(pu).sort().join(', ');
            out['promptManager 路径'] = pu.promptManager ? 'powerUserSettings.promptManager'
                : pu.prompt_manager ? 'powerUserSettings.prompt_manager' : '都不存在';
            const pm = pu.promptManager || pu.prompt_manager;
            if (pm) {
                out['promptManager 顶层字段'] = Object.keys(pm).sort().join(', ');
                const blocks = pm.blocks || {};
                const names = Object.keys(blocks);
                out['blocks 数量'] = names.length;
                out['blocks 里的 token_count 样例'] = names.slice(0, 15)
                    .map(n => `${n}=${blocks[n]?.token_count ?? '无'}`).join(', ');
            }
        }
        // 世界书：优先用官方接口读取（字段名探测已证实不可靠）
        try {
            if (typeof ctx?.getWorldInfoPrompt === 'function') {
                out['getWorldInfoPrompt 可用'] = '是（可精确取得世界书注入内容）';
            }
            if (typeof ctx?.getCharacterCardFields === 'function') {
                out['getCharacterCardFields 可用'] = '是（可精确取得角色卡各字段）';
            }
        } catch (e) { /* ignore */ }
        for (const [label, v] of [
            ['ctx.worldInfo', ctx?.worldInfo], ['ctx.world_info', ctx?.world_info],
            ['ctx.chatMetadata?.world_info', ctx?.chatMetadata?.world_info],
            ['ctx.chat_metadata?.world_info', ctx?.chat_metadata?.world_info],
        ]) {
            if (v === undefined) continue;
            const n = Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : '标量');
            out[`世界书 ${label}`] = `存在，条目数=${n}`;
        }
    } catch (err) {
        out['__转储错误__'] = String(err);
    }
    return out;
}

// 把「所有可能承载前缀文本」的来源逐个找出来。返回 { 标签: 文本 }，
// 便于诊断时一眼看出到底哪一份数据被读到了、长度多少。
function collectPrefixSources() {
    const out = {};
    const put = (label, val) => {
        if (typeof val === 'string' && val.trim()) out[label] = val;
    };
    try {
        const ctx = SillyTavern.getContext();
        const pu = ctx?.powerUserSettings || ctx?.powerUser || ctx?.power_user;

        put('powerUserSettings.system_prompt', pu?.system_prompt);
        put('ctx.systemPrompt', ctx?.systemPrompt);

        // 角色卡：SillyTavern 在 ctx 上暴露的字段名随版本变化，全部尝试
        const charId = ctx?.characterId;
        put('characters[id].description', ctx?.characters?.[charId]?.description);
        put('characters[id].data.description', ctx?.characters?.[charId]?.data?.description);
        put('characters[id].data.personality', ctx?.characters?.[charId]?.data?.personality);
        put('characters[id].data.scenario', ctx?.characters?.[charId]?.data?.scenario);
        put('characters[id].data.system_prompt', ctx?.characters?.[charId]?.data?.system_prompt);
        put('characters[id].data.post_history_instructions', ctx?.characters?.[charId]?.data?.post_history_instructions);
        put('characters[id].data.first_mes', ctx?.characters?.[charId]?.data?.first_mes);
        put('characters[id].data.mes_example', ctx?.characters?.[charId]?.data?.mes_example);
        put('name2', ctx?.name2);

        // 世界书：逐个候选字段
        const wiCands = [
            ['ctx.worldInfo', ctx?.worldInfo],
            ['ctx.world_info', ctx?.world_info],
            ['ctx.chatMetadata.world_info', ctx?.chatMetadata?.world_info],
            ['ctx.chat_metadata.world_info', ctx?.chat_metadata?.world_info],
        ];
        for (const [label, c] of wiCands) {
            if (!c || typeof c !== 'object') continue;
            const list = Array.isArray(c) ? c : Object.values(c);
            const text = list
                .map(e => (typeof e === 'string' ? e : (e?.content ?? e?.entry ?? e?.value)))
                .filter(s => typeof s === 'string' && s)
                .join('\n');
            put(`${label}（${list.length} 条）`, text);
        }
    } catch (err) {
        out['__错误__'] = String(err);
    }
    return out;
}

// 一次性把关键诊断打成「单行可复制文本」，便于用户直接复制反馈。
// 之所以打成字符串而不是对象：控制台里的对象需要逐层展开，无法一键复制。
async function dumpPrefixDiagnostics() {
    const structure = dumpContextStructure();
    const sources = collectPrefixSources();

    const lines = [];
    lines.push('===== TokenSaving 诊断（请整段复制反馈）=====');
    lines.push('--- 关键 ---');
    lines.push(`可用生成接口: ${structure['可用生成接口']}`);
    lines.push(`generateQuietPrompt 可用: ${structure['generateQuietPrompt 可用']}`);
    lines.push(`可见的请求相关字段: ${structure['可见的请求相关字段']}`);
    lines.push(`完整上下文对象字段: ${structure['—— 上下文对象字段 ——']}`);
    lines.push('--- 角色卡 ---');
    lines.push(`characterId: ${structure['characterId']}`);
    lines.push(`char 顶层字段: ${structure['char 顶层字段']}`);
    lines.push(`char.data 字段: ${structure['char.data 字段']}`);
    lines.push(`char 各字段字符数: ${JSON.stringify(structure['char 各字段字符数'])}`);
    lines.push('--- 提示词管理器 ---');
    lines.push(`powerUserSettings 存在: ${structure['powerUserSettings 存在']}`);
    lines.push(`含文本的字段: ${structure['powerUser 含文本的字段']}`);
    lines.push(`powerUser 顶层字段: ${structure['powerUser 顶层字段']}`);
    lines.push(`promptManager 路径: ${structure['promptManager 路径']}`);
    lines.push(`promptManager 顶层字段: ${structure['promptManager 顶层字段']}`);
    lines.push(`blocks 数量: ${structure['blocks 数量']}`);
    lines.push(`blocks token_count 样例: ${structure['blocks 里的 token_count 样例']}`);
    lines.push('--- 世界书 ---');
    for (const [k, v] of Object.entries(structure)) {
        if (k.startsWith('世界书')) lines.push(`${k}: ${v}`);
    }
    lines.push('--- 前缀来源与取值 ---');
    for (const [label, text] of Object.entries(sources)) {
        const t = await tokenCountSafe(text);
        lines.push(`${label}: ${text.length} 字符 ≈ ${Math.round(t)} tok`);
    }
    lines.push(`读到的来源数量: ${Object.keys(sources).length}`);
    lines.push(`提示词管理器加总: ${sumPromptBlockTokens()} tok`);
    lines.push(`当前采用的前缀: ${JSON.stringify(resolvePrefixTokens(0))}`);
    try {
        const rows = await buildPrefixBreakdown();
        if (rows.length) {
            lines.push('--- 前缀构成（逐段）---');
            for (const r of rows) {
                lines.push(`  #${r.index} [${r.role}] ${r.label}: ${r.chars} 字符 ≈ ${r.tok} tok`);
            }
            lines.push(`  合计 ≈ ${rows.reduce((n, r) => n + r.tok, 0)} tok（${rows.length} 段）`);
            lines.push(`  其中被排除的聊天历史: ${prefixState.segments.length ? '已从消息数组中剔除' : '无'}`);
        } else {
            lines.push('--- 前缀构成：暂无（尚未捕获到实测 messages）---');
        }
    } catch (e) {
        lines.push(`前缀构成读取失败: ${String(e)}`);
    }
    lines.push(`上下文: ${getAvailableContextTokens()} tok`);
    lines.push(`输出预留: ${getOutputReserveLengthSafe()} tok`);
    lines.push('===== 诊断结束 =====');

    // 整段一次性输出，方便直接框选复制
    console.log(lines.join('\n'));
    return structure;
}

// 读取输出预留（不抛错版本，供诊断使用）
function getOutputReserveLengthSafe() {
    try {
        return getOutputReserveTokens(extension_settings[EXT_NAME]);
    } catch (e) {
        return '读取失败: ' + String(e);
    }
}

// ① 提示词管理器：把「聊天历史之外」的静态块 token 加总。
//    这正是 SillyTavern 的 Token Counter 面板所显示的数据
//    （Main Prompt / World Info (before) / 角色设定 …），比任何反推都准。
const HISTORY_BLOCK_RE = /history|chat[-_ ]?history|dialogue|conversation|messages|chat[-_ ]?messages|chat[-_ ]?skeleton/i;

function sumPromptBlockTokens() {
    try {
        const ctx = SillyTavern.getContext();
        const pu = ctx?.powerUserSettings || ctx?.powerUser || ctx?.power_user;
        const pm = pu?.promptManager || pu?.prompt_manager;
        if (!pm) return 0;

        const blocks = pm.blocks || pm.promptManager?.blocks || {};
        const order = pm.promptOrder || pm.prompt_order;

        // 收集本角色生效的块标识符列表
        let ids = [];
        if (Array.isArray(order)) {
            const entry = order.find(o => {
                if (!o) return false;
                const list = o.order || o.prompts;
                return Array.isArray(list);
            });
            const list = entry?.order || entry?.prompts || [];
            ids = list.map(o => o?.identifier).filter(Boolean);
        }
        // order 不可用时退回「当前启用且启用了 system_prompt 的块」
        if (!ids.length) {
            ids = Object.values(blocks)
                .filter(b => b && b.system_prompt && b.enabled !== false)
                .map(b => b.identifier)
                .filter(Boolean);
        }

        let total = 0;
        const parts = [];
        for (const id of ids) {
            if (HISTORY_BLOCK_RE.test(String(id))) continue;
            const b = blocks[id];
            if (!b || b.enabled === false) continue;
            const t = Number(b.token_count) || 0;
            if (t > 0) { total += t; parts.push(`${id}:${t}`); }
        }

        if (diagMode && total > 0) {
            console.log('[TokenSaving 诊断] 提示词管理器静态块加总', { 合计: total, 明细: parts.join(', ') });
        }
        return total;
    } catch (err) {
        if (diagMode) console.warn('TokenSaving: 读取提示词管理器失败', err);
        return 0;
    }
}

// ② 估算兜底：多来源取最大 + 世界书条目
//    角色卡的 description / data.description 等字段是「同一份内容的多个等价路径」，
//    因此逐字段相加会重复计数，改为取最大；系统提示词与世界书则各自独立相加。
function estimatePrefixTokens() {
    try {
        const sources = collectPrefixSources();
        let charMax = 0;   // 角色卡各字段取最大（同一内容的等价路径）
        let otherSum = 0;  // 系统提示词等取相加

        for (const [label, text] of Object.entries(sources)) {
            if (label === '__错误__') continue;
            const tok = String(text).length / 1.5;
            if (label.startsWith('characters[')) charMax = Math.max(charMax, tok);
            else if (label.startsWith('ctx.worldInfo') || label.startsWith('ctx.world_info')
                || label.startsWith('ctx.chatMetadata') || label.startsWith('ctx.chat_metadata')) {
                otherSum += tok;   // 世界书条目按需注入，计入
            } else {
                otherSum += tok;   // powerUser.system_prompt / ctx.systemPrompt 等
            }
        }
        return Math.round(charMax + otherSum);
    } catch (err) {
        console.warn('TokenSaving: 前缀估算失败', err);
        return 0;
    }
}

// 前缀状态（必须在 computePrefixTokens 之前声明，避免 TDZ）
const prefixState = {
    measured: 0,        // 由生成事件测得的「prompt 骨架」token（不含聊天历史）
    measuredAt: 0,
    measuredHistory: 0,
    estimate: 0,
    segments: [],       // 前缀的各段原文 [{role, text}]，用于在面板/诊断里展示构成
    breakdownText: '',  // 已格式化好的构成说明（由 updatePrefixStatus 异步刷新后缓存）
    breakdownCompact: '', // 单行紧凑版，供诊断行使用
};

// 统一入口：优先「提示词管理器加总」，其次「估算」
function computePrefixTokens() {
    const blockSum = sumPromptBlockTokens();
    if (blockSum > 0) return { value: blockSum, source: 'blocks' };

    const est = estimatePrefixTokens();
    prefixState.estimate = est;
    return { value: Math.max(0, Math.round(est)), source: est > 0 ? 'estimate' : 'none' };
}

function refreshPrefixEstimate() {
    const blockSum = sumPromptBlockTokens();
    const est = blockSum > 0 ? blockSum : estimatePrefixTokens();
    prefixState.estimate = est;
    if (diagMode) {
        let keys = [];
        try {
            const ctx = SillyTavern.getContext();
            keys = Object.keys(ctx || {}).filter(k => /world|char|prompt|persona|power/i.test(k)).sort();
        } catch (e) { /* ignore */ }
        console.log('[TokenSaving 诊断] 前缀来源', {
            '提示词管理器加总 tok': blockSum,
            '估算兜底 tok': estimatePrefixTokens(),
            '采用值': est,
            '手动值（已停用）': extension_settings[EXT_NAME]?.prefixTokens,
            '事件测得前缀 tok': prefixState.measured,
            '上下文对象里可能的字段': keys,
            '提示词管理器探测': (() => {
                try {
                    const ctx2 = SillyTavern.getContext();
                    const out = {};
                    for (const path of ['powerUserSettings.promptManager', 'powerUserSettings.prompt_manager', 'powerUser.promptManager', 'power_user.promptManager', 'power_user.prompt_manager', 'promptManager']) {
                        const seg = path.split('.');
                        let v = ctx2;
                        for (const s of seg) v = v?.[s];
                        out[path] = v
                            ? `存在，块数=${Object.keys(v.blocks || {}).length}`
                            : '不存在';
                    }
                    return out;
                } catch (e) { return { error: String(e) }; }
            })(),
        });
    }
    return est;
}

// 从事件 payload 中取出「本次实际发送的消息数组或完整 prompt 文本」
function extractPromptPayload(data) {
    if (!data || data.dryRun) return null;
    if (typeof data.prompt === 'string' && data.prompt) return { prompt: data.prompt };
    for (const key of ['chat', 'messages', 'prompt']) {
        const v = data[key];
        if (Array.isArray(v) && v.length) return { messages: v };
    }
    // 有些实现把请求体整体放在 data 上
    if (Array.isArray(data?.request?.messages)) return { messages: data.request.messages };
    return null;
}

// 统计「本对话实际发送的聊天消息」token（用请求里的 role+content 精确重建）。
// 自定义提示词模板会给 assistant 消息加角色名前缀，因此这里按请求侧的结构重建，
// 只取 user/assistant 条目，可以完整覆盖 ctx.chat 里的全部可见消息。
async function countVisibleMessageTokens() {
    try {
        const ctx = SillyTavern.getContext();
        const visible = (ctx?.chat || []).filter(m => m?.mes && !m.isSystem && !m.is_system);
        if (!visible.length) return 0;
        const text = visible
            .map(m => `${m.is_user ? 'user' : 'assistant'}: ${String(m.mes).trim()}`)
            .join('\n');
        return Math.round(await tokenCountSafe(text));
    } catch (e) {
        return Math.round(sumMessageChars(
            (SillyTavern.getContext()?.chat || []).filter(m => m?.mes && !m.isSystem && !m.is_system)
        ) / 1.5);
    }
}

// ★ 前缀测量：前缀 = 本次发送的模板总量 − 聊天消息占用量。
//   「聊天消息占用量」用请求侧结构精确重建后再过真实分词器，
//   比按 1.5 字/tok 估算准得多，因此差出来的就是纯前缀：
//     Main Prompt + 角色卡/世界书 + 其他插件注入 + [Start a new Chat]
//   本插件自己注入的 FCC 摘要也在其中（它属于需要扣除的上下文开销）。
async function measurePrefixFromPayload(data) {
    try {
        const payload = extractPromptPayload(data);
        if (!payload) return;

        const ctx = SillyTavern.getContext();
        const visible = (ctx?.chat || []).filter(m => m?.mes && !m.isSystem && !m.is_system);
        const est = prefixState.estimate || estimatePrefixTokens();

        let prefixTokens = 0;
        let method = '';
        const prefixSegments = [];

        if (payload.messages) {
            // 首选：逐条排除聊天消息，剩下即前缀（能区分出各段来源）
            const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
            const chatNorm = new Set(visible.map(m => norm(m.mes)).filter(Boolean));
            const isHistory = (text) => {
                const t = norm(text);
                if (!t || t === ' ') return true;
                if (chatNorm.has(t)) return true;
                // 容错：长消息可能被角色名前缀或裁剪影响，用前 80 字符比对
                if (t.length > 80) {
                    for (const c of chatNorm) {
                        if (c.length > 80 && c.startsWith(t.slice(0, 80))) return true;
                    }
                }
                return false;
            };

            const parts = [];
            for (const m of payload.messages) {
                const content = typeof m?.content === 'string'
                    ? m.content
                    : Array.isArray(m?.content)
                        ? m.content.map(c => c?.text || '').join('')
                        : '';
                if (!content || isHistory(content)) continue;
                parts.push(content);
                prefixSegments.push({ role: m?.role || 'system', text: content });
            }
            if (parts.length) {
                prefixTokens = await tokenCountSafe(parts.join('\n'));
                method = '分离法';
            }
        }

        if (!method) {
            // 兜底：模板总量 − 聊天消息占用量
            const totalTokens = await tokenCountSafe(payload.prompt || '');
            const histTokens = await countVisibleMessageTokens();
            if (totalTokens > 0 && histTokens > 0) {
                prefixTokens = Math.max(0, totalTokens - histTokens);
                method = '模板−消息';
            }
        }

        if (!method) return;

        // 可靠性判定：前缀必须 > 50 tok；若已有估算值，不应低于其 50%
        if (!(prefixTokens > 50) || (est > 0 && prefixTokens < est * 0.5)) {
            if (diagMode) {
                console.log('[TokenSaving 诊断] 前缀测量结果不可靠，已忽略', {
                    '测量 tok': Math.round(prefixTokens),
                    '方法': method,
                    '参考估算 tok': Math.round(est),
                    '可见消息条数': visible.length,
                });
            }
            return;
        }

        prefixState.measured = Math.round(prefixTokens);
        prefixState.measuredAt = Date.now();
        prefixState.measuredHistory = Math.round(sumMessageChars(visible) / 1.5);
        prefixState.segments = prefixSegments;

        if (diagMode) {
            console.log('[TokenSaving 诊断] ★ 前缀测量成功', {
                '前缀 tok': prefixState.measured,
                '方法': method,
                '可见消息条数': visible.length,
                '参考估算 tok': Math.round(est),
                '上下文 tok': getAvailableContextTokens(),
                '算出的窗口预算': Math.max(
                    COMPRESS_MIN_BLOCK,
                    getAvailableContextTokens()
                    - Math.max(Math.max(Number(extension_settings[EXT_NAME]?.maxSummaryTokens) || 210, 50) * 4, 600)
                    - prefixState.measured
                ),
            });
        }
    } catch (err) {
        if (diagMode) console.warn('TokenSaving: 前缀测量失败', err);
    }
}

// 用 SillyTavern 的真实分词器计数（失败则退回字符估算）
async function tokenCountSafe(text) {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx?.getTokenCountAsync === 'function') {
            const t = await ctx.getTokenCountAsync(text);
            if (Number.isFinite(t) && t > 0) return t;
        }
    } catch (e) { /* 退回估算 */ }
    return estimateTokens(text);
}


// 解析当前应当使用的「前缀 token」值。
// 完全不接受手动指定：只使用「运行时实测」或「提示词管理器加总 / 估算」，
// 避免人工填错导致 m 计算失准。
function resolvePrefixTokens(measuredHistoryTokens) {
    // ① 生成事件实测值（通过可靠性判定后才会被写入）
    const m = Number(prefixState.measured);
    if (m > 0 && (Date.now() - prefixState.measuredAt) < 30 * 60 * 1000) {
        return { value: m, source: 'measured' };
    }

    // ② 提示词管理器加总 / 估算
    return computePrefixTokens();
}

// 刷新「前缀占用」的显示：把自动值写进只读输入框，并在下方标注来源
async function updatePrefixStatus(settings) {
    const $status = $('#tokensaving_prefix_status');
    const $input = $('#tokensaving_prefix_tokens');
    if (!$status.length && !$input.length) return;

    const msgs = (() => {
        try {
            const ctx = SillyTavern.getContext();
            return (ctx?.chat || []).filter(m => m?.mes && !m.isSystem && !m.is_system);
        } catch (e) { return []; }
    })();
    const histTok = Math.round(sumMessageChars(msgs) / 1.5);
    const info = resolvePrefixTokens(histTok);

    // 只读输入框始终展示当前自动值
    if ($input.length) $input.val(info.value > 0 ? Math.round(info.value) : 0);

    // 前缀明细：逐段 token 构成（实测路径才有 segments）
    let breakdown = '';
    let compactBreakdown = '';
    if (info.source === 'measured') {
        try {
            const rows = await buildPrefixBreakdown();
            if (rows.length) {
                breakdown = rows
                    .map(r => `#${r.index} ${r.label}：${r.chars} 字符 ≈ ${r.tok} tok`)
                    .join('\n');
                const total = rows.reduce((n, r) => n + r.tok, 0);
                breakdown += `\n合计 ≈ ${total} tok（${rows.length} 段）`;
                compactBreakdown = rows
                    .map(r => `${r.label} ${r.tok}`)
                    .join(' + ') + ` = ${total}`;
            }
        } catch (e) { /* 明细失败不影响主显示 */ }
    }
    // 缓存供诊断行同步读取
    prefixState.breakdownText = breakdown;
    prefixState.breakdownCompact = compactBreakdown;

    if (!$status.length) return;

    if (!info.value) {
        $status.text(t('prefix_status_auto', {
            value: 0,
            source: t('prefix_source_none'),
        }));
        return;
    }
    const baseText = t('prefix_status_auto', {
        value: Math.round(info.value),
        source: info.source === 'measured' ? t('prefix_source_measured')
            : info.source === 'blocks' ? t('prefix_source_blocks')
                : t('prefix_source_estimate'),
    });
    $status.text(baseText);
    // 完整构成放进 tooltip，鼠标悬停即可看到逐段明细
    if (breakdown) {
        $status.attr('title', breakdown);
        $input.attr('title', breakdown);
    }
}

function sumMessageChars(msgs) {
    let chars = 0;
    for (const m of (Array.isArray(msgs) ? msgs : [])) chars += String(m?.mes || '').length;
    return chars;
}

// 挂载前缀测量事件。SillyTavern 各版本事件名不同，逐个探测；
// 拿到 payload 后统一交给 measurePrefixFromPayload 做「前缀 / 历史」分离。
function bindPrefixMeasurementEvents(ctx, settings) {
    const types = ctx?.eventTypes || {};
    const names = [
        'CHAT_COMPLETION_PROMPT_READY',      // 拿到最终发送的 messages 数组，最理想
        'GENERATE_AFTER_COMBINE_PROMPTS',
        'CHAT_COMPLETION_SETTINGS_READY',
    ];

    let bound = 0;
    for (const name of names) {
        const et = types[name];
        if (!et) continue;
        try {
            ctx.eventSource.on(et, async (payload) => {
                try {
                    await measurePrefixFromPayload(payload);
                    // 前缀会直接决定 m，测完顺手刷新面板
                    updateMetrics(settings);
                } catch (err) {
                    if (diagMode) console.warn(`TokenSaving: 前缀测量失败（${name}）`, err);
                }
            });
            bound++;
            console.log(`TokenSaving: 已挂载前缀测量事件 ${name}`);
        } catch (err) {
            console.warn(`TokenSaving: 挂载 ${name} 失败`, err);
        }
    }

    if (!bound) {
        console.warn('TokenSaving: 未找到可用的前缀测量事件，将使用估算 / 手动校准值');
        try {
            console.log('TokenSaving: 可用事件名列表', Object.keys(types).sort().join(', '));
        } catch (e) { /* ignore */ }
    }
    return bound;
}

// 平均单条消息的 token 量（取最近 RECENT_AVG_WINDOW 条）
function avgTokensPerMessage(visibleMsgs) {
    const msgs = Array.isArray(visibleMsgs) ? visibleMsgs : [];
    if (!msgs.length) return 0;
    const recent = msgs.slice(-RECENT_AVG_WINDOW);
    const chars = sumMessageChars(recent);
    if (chars <= 0) return 0;
    return chars / recent.length / 1.5;   // 与 estimateTokens 一致：1 汉字 ≈ 1.5 token
}

// 读取 SillyTavern 真实的「最大回复长度」。
// 这才是窗口预算里应该预留的输出空间；此前用「单次摘要上限 × 4」推算，
// 与实际设置（本站为 768）不符，会低估可用窗口。
function getResponseLengthSetting() {
    const paths = [
        (ctx) => ctx?.chatCompletionSettings,
        (ctx) => ctx?.oai_settings,
        (ctx) => window?.oai_settings,
    ];
    for (const get of paths) {
        try {
            const obj = get(SillyTavern.getContext());
            if (!obj) continue;
            for (const key of ['openai_max_tokens', 'max_tokens', 'response_length']) {
                const v = Number(obj[key]);
                if (Number.isFinite(v) && v > 0) return Math.round(v);
            }
        } catch (e) { /* 继续尝试下一条路径 */ }
    }
    return 0;   // 读不到时由调用方决定回退值
}

// 窗口预算里应当预留的输出 token：
// 优先用 SillyTavern 的实际设置；读不到才退回「单次摘要上限 × 4」。
function getOutputReserveTokens(settings) {
    const real = getResponseLengthSetting();
    if (real > 0) return real;
    const maxSummaryTokens = Math.max(50, Number(settings?.maxSummaryTokens) || 210);
    return Math.max(maxSummaryTokens * 4, 600);
}

// 压缩请求自身的回复长度（压缩输出的是 JSON 摘要，与主聊天的最大回复长度无关）
function getCompressResponseLength(settings) {
    const maxSummaryTokens = Math.max(50, Number(settings?.maxSummaryTokens) || 210);
    return Math.max(maxSummaryTokens * 4, 600);
}

// ==================== 前缀构成解析（用于面板/诊断展示） ====================
// 前缀是黑箱数值没有意义，这里把每一段识别出来并逐段统计 token。
// 识别依据是「同一段文本在多轮请求里基本稳定」，因此可在各轮测量之间复用标签。
let lastPrefixLabels = [];

const PREFIX_LABEL_RULES = [
    [/^\s*Write\s|next reply in a fictional chat/i, '主提示词 (Main Prompt)'],
    [/^\s*\[Summary:/i, '其他插件/摘要 (Summary)'],
    [/历史摘要|\[History Summary\]/i, '本插件 FCC 摘要'],
    [/SYSTEM PROMPT|核心引擎|世界观/i, '角色卡·系统提示词'],
    [/世界书|World Info|落樱湖|洛十三/i, '世界书 (World Info)'],
    [/Start a new Chat|开始新的聊天/i, '新聊天标记'],
    [/^\s*\[人格|Persona|玩家/i, '人格描述 (Persona)'],
];

const PREFIX_STOP_RE = /^(History Summary|历史摘要|Chat History)$/i;

function labelForSegment(text) {
    const s = String(text || '');
    for (const [re, label] of PREFIX_LABEL_RULES) {
        if (re.test(s)) return label;
    }
    if (PREFIX_STOP_RE.test(s.trim())) return null;
    return '其他系统内容';
}

// 逐段统计 token（异步，仅在诊断模式或需要明细时调用）
async function buildPrefixBreakdown() {
    const segs = Array.isArray(prefixState.segments) ? prefixState.segments : [];
    if (!segs.length) return [];

    // 先解析标签，再与上一轮做位置/长度匹配以保持标签稳定
    const labels = segs.map(s => labelForSegment(s.text));
    const rows = [];
    for (let i = 0; i < segs.length; i++) {
        const text = String(segs[i].text || '');
        let tok = 0;
        try {
            tok = Math.round(await tokenCountSafe(text));
        } catch (e) {
            tok = Math.round(text.length / 1.5);
        }
        let label = labels[i];
        // 上一轮同位置同长度 → 沿用旧标签，避免相同长度内容被重新分类
        const prev = lastPrefixLabels[i];
        if (prev && prev.chars === text.length && prev.role === segs[i].role) {
            label = prev.label;
        }
        rows.push({ index: i + 1, role: segs[i].role, chars: text.length, tok, label });
    }
    lastPrefixLabels = rows;
    return rows;
}

// 把明细压成一行短文本，用于面板显示（过长则截断到前 3 段 + 其余合计）
function formatPrefixBreakdown(rows) {
    if (!rows || !rows.length) return '';
    const shown = rows.slice(0, 3);
    const restTok = rows.slice(3).reduce((n, r) => n + r.tok, 0);
    const parts = shown.map(r => `${r.label} ${r.tok}`);
    if (rows.length > 3) parts.push(`其他 ${restTok}`);
    return parts.join(' + ');
}

function computeAdaptiveM(settings, visibleMsgs) {
    const n = Math.max(1, Number(settings?.n) || 5);
    const avgTok = avgTokensPerMessage(visibleMsgs);
    // 仅用于在诊断行里展示（ST 已从可用上下文中扣过，不参与窗口预算）
    const responseLength = getOutputReserveTokens(settings);

    // 窗口预算 = 可用上下文 − 前缀（世界书 + 角色卡 + 系统提示词）
    //
    // ⚠️ 不要再减「输出预留」：getMaxPromptTokens() 返回的是 SillyTavern 已经扣掉
    //    预留输出后的净可用值（本站 8192 − 768 = 7424）。再减一次会重复扣除、低估窗口。
    const baseCtx = getAvailableContextTokens();
    const historyTokensNow = Math.round(sumMessageChars(visibleMsgs) / 1.5);
    const prefixInfo = resolvePrefixTokens(historyTokensNow);
    const prefixTokens = Math.max(0, Number(prefixInfo.value) || 0);
    const windowBudget = Math.max(
        COMPRESS_MIN_BLOCK,
        baseCtx - prefixTokens
    );

    if (avgTok <= 0) {
        // 还没有可用消息：回落到预设值，保证首次触发行为稳定
        return {
            m: Math.max(1, Number(settings?.m) || 20),
            avgTok: 0, avgRoundTokens: 0, budget: windowBudget,
            targetTokens: windowBudget * getFillTarget(settings),
            fillTarget: getFillTarget(settings),
            baseCtx, responseLength, prefixTokens, prefixSource: prefixInfo.source,
            msgCount: Array.isArray(visibleMsgs) ? visibleMsgs.length : 0,
            fallback: true,
        };
    }

    const avgRoundTokens = avgTok * 2;
    const fillTarget = getFillTarget(settings);
    const targetTokens = windowBudget * fillTarget;
    let m = Math.floor(targetTokens / avgRoundTokens) - n;
    m = Math.max(1, Math.min(500, m));

    if (diagMode) {
        console.log('[TokenSaving 诊断] 自适应 m 计算依据', {
            'ST 上下文 getMaxPromptTokens()': baseCtx,
            '输出预留 responseLength': responseLength,
            '前缀 tok': prefixTokens,
            '前缀来源': prefixInfo.source,
            '窗口预算 windowBudget': windowBudget,
            '填充目标 85%': Math.round(targetTokens),
            '可见消息条数': Array.isArray(visibleMsgs) ? visibleMsgs.length : 0,
            '参与均值条数': Math.min(RECENT_AVG_WINDOW, Array.isArray(visibleMsgs) ? visibleMsgs.length : 0),
            '平均单条 tok': Math.round(avgTok * 10) / 10,
            '平均每轮 tok': Math.round(avgRoundTokens * 10) / 10,
            '当前历史 tok（估）': historyTokensNow,
            '算出 m': m,
            'n': n,
            '窗口上限 n+m': n + m,
            '触发时总计 tok（估）': Math.round((n + m) * avgRoundTokens + prefixTokens + responseLength),
            'activePreset': settings?.activePreset,
            'compressContext': settings?.compressContext,
            'blockTokens': settings?.blockTokens,
        });
    }

    return {
        m, avgTok, avgRoundTokens, budget: windowBudget, targetTokens, fillTarget,
        baseCtx, responseLength, prefixTokens, prefixSource: prefixInfo.source,
        msgCount: Array.isArray(visibleMsgs) ? visibleMsgs.length : 0,
        fallback: false,
    };
}

// 把自适应 m 同步到界面（输入框只读展示 + 依据说明）
function updateAutoWindowParams(settings, visibleMsgs) {
    const $m = $('#tokensaving_m');
    if (!$m.length) return;

    if (settings.activePreset === 'custom') {
        // 用户切到自定义后，m 交回手动控制
        $m.prop('readonly', false);
        const $auto = $('#tokensaving_m_auto');
        if ($auto.length) $auto.text(t('window_m_manual'));
        return;
    }

    const r = computeAdaptiveM(settings, visibleMsgs);
    $m.prop('readonly', true).val(r.m);
    settings.m = r.m;
    // m 刚被改写，立即刷新「当前配置」标签，保证它与输入框显示同一个值
    updatePresetCurrentLabel(settings);

    const $auto = $('#tokensaving_m_auto');
    if ($auto.length) {
        if (diagMode) {
            // 诊断模式：把计算依据全部摊开，便于定位「m 为何是这个值」
            const compact = prefixState.breakdownCompact;
            const fillPct = Math.round((r.fillTarget ?? getFillTarget(settings)) * 100);
            const nVal = Math.max(1, Number(settings.n) || 5);
            // 把换算过程与「均值取自哪些消息」都摊开，避免单位与样本范围产生歧义
            const avgPerMsg = Math.round(r.avgTok * 10) / 10;
            const avgPerRound = Math.round(r.avgRoundTokens * 10) / 10;
            const target = Math.round(r.targetTokens);
            const roundsFit = avgPerRound > 0 ? Math.floor(target / avgPerRound) : 0;
            const msgsFit = avgPerMsg > 0 ? Math.floor(target / avgPerMsg) : 0;
            const avgSampleMsgs = Math.min(RECENT_AVG_WINDOW, r.msgCount);
            const avgSampleRounds = Math.floor(avgSampleMsgs / 2);
            $auto.text(
                `🔍 可用上下文 ${r.baseCtx}（ST 已扣输出预留 ${r.responseLength}）`
                + ` − 前缀 ${r.prefixTokens}（${r.prefixSource}）`
                + ` = 窗口预算 ${r.budget}`
                + `\n📊 可见历史 ${r.msgCount} 条 / ${Math.floor(r.msgCount / 2)} 轮`
                + ` · 均值取自最近 ${avgSampleRounds} 轮（${avgSampleMsgs} 条）`
                + `：${avgPerMsg} tok/条 × 2 = ${avgPerRound} tok/轮`
                + `\n🎯 目标 ${target} tok = 窗口预算 ${r.budget} × ${fillPct}%`
                + ` ÷ ${avgPerRound} tok/轮 = ${roundsFit} 轮（= ${msgsFit} 条消息）`
                + ` − n ${nVal} → m=${r.m}，窗口上限 ${nVal + r.m} 轮`
                + (compact ? `\n📐 前缀构成：${compact}` : '\n📐 前缀构成：暂无（先正常发一条消息以捕获实测数据）')
            );
        } else {
            $auto.text(r.fallback || r.avgTok <= 0
                ? t('window_m_auto_idle')
                : t('window_m_auto_detail', {
                    avg: Math.round(r.avgTok),
                    fill: Math.round((r.fillTarget ?? getFillTarget(settings)) * 100),
                    recent: Math.min(RECENT_AVG_WINDOW, (Array.isArray(visibleMsgs) ? visibleMsgs.length : 0)),
                    prefix: r.prefixTokens,
                }));
        }
    }
    // 窗口徽标由 renderWindowVisual 统一维护（含已占用轮数），此处不再覆盖
}

// ==================== 压缩估算（面板可观测性） ====================
// 显示「实际会生效的单块大小」与「本次压缩预计的 API 调用次数」，
// 避免用户看到输入框里的「分块大小」设定值而误判实际行为。
function updateCompressionEstimate(settings, visibleMsgs) {
    const $block = $('#tokensaving_effblock');
    const $calls = $('#tokensaving_estcalls');
    if (!$block.length && !$calls.length) return;

    const msgs = Array.isArray(visibleMsgs) ? visibleMsgs : [];
    const n = Math.max(1, Number(settings.n) || 5);
    const retainCount = n * 2;
    const toCompress = msgs.length > retainCount ? msgs.slice(0, msgs.length - retainCount) : [];

    // 与实际压缩流程一致的估算：每条消息的发言者前缀按 4 字符计
    let chars = 0;
    for (const mx of toCompress) {
        chars += 4 + String(mx?.mes || '').trim().length + 1;
    }
    const pendingTokens = chars > 0 ? estimateTokens('x'.repeat(chars)) : 0;

    // 与自适应 m 使用同一个输出预留口径（SillyTavern 的「最大回复长度」）
    const responseLength = getOutputReserveTokens(settings);
    const effectiveBlock = computeEffectiveBlockTokens(settings, responseLength);

    const blocks = pendingTokens > 0 ? Math.max(1, Math.ceil(pendingTokens / effectiveBlock)) : 0;
    const estCalls = blocks > 0 ? Math.min(HARD_API_CAP, blocks + 1) : 0;   // +1 预留可能的 FCC 折叠

    const fmtTok = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`);

    if ($block.length) {
        $block.text(`${fmtTok(effectiveBlock)} tok`);
        $block.attr('title', `${t('metric_block_title')}\n当前生效 ${effectiveBlock} tok（待压 ${pendingTokens} tok）`);
    }
    if ($calls.length) {
        $calls.text(pendingTokens > 0 ? `${estCalls} 次` : '—');
        $calls.attr('title', `${t('metric_api_title')}\n待压 ${pendingTokens} tok ÷ 单块 ${effectiveBlock} tok = ${blocks} 块，+1 预留折叠`);
    }
}

// 进度条按「窗口占用 ÷ 窗口预算」着色：达填充目标（settings.fillPercent）变红（即该压缩了）
function applyContextPercent(percent, settings) {
    $('#tokensaving_ctx').text(`${percent.toFixed(0)}%`);

    const $bar = $('#tokensaving_progress_bar');
    $bar.css('width', `${percent}%`);
    $bar.removeClass('is-warn is-error');

    const fillPercent = Math.round(getFillTarget(settings) * 100);
    if (percent >= fillPercent) $bar.addClass('is-error');
    else if (percent >= fillPercent - 20) $bar.addClass('is-warn');
}

const realTokenState = {
    lastKey: '',
    lastTokens: 0,
    lastRunTs: 0,
    inFlight: false,
};
const REAL_TOKEN_TTL = 5000;
const REAL_TOKEN_MIN_INTERVAL = 800;

function buildChatKey(visibleMsgs) {
    if (!visibleMsgs.length) return '0';
    const last = visibleMsgs[visibleMsgs.length - 1]?.mes || '';
    const totalLen = visibleMsgs.reduce((s, x) => s + (x.mes?.length || 0), 0);
    return `${visibleMsgs.length}|${totalLen}|${last.slice(-32)}`;
}

function scheduleRealTokenCount(visibleMsgs, maxTokens, settings) {
    if (!visibleMsgs.length) return;

    const key = buildChatKey(visibleMsgs);
    const now = Date.now();

    if (key === realTokenState.lastKey && (now - realTokenState.lastRunTs) < REAL_TOKEN_TTL) {
        const pct = Math.min(100, (realTokenState.lastTokens / maxTokens) * 100);
        applyContextPercent(pct, settings);
        return;
    }

    if (realTokenState.inFlight) return;
    if ((now - realTokenState.lastRunTs) < REAL_TOKEN_MIN_INTERVAL) return;

    realTokenState.inFlight = true;
    realTokenState.lastRunTs = now;

    const fullText = visibleMsgs.map(x => x.mes).join('\n');

    countTokens(fullText).then(tokens => {
        realTokenState.inFlight = false;
        if (!Number.isFinite(tokens) || tokens <= 0) return;

        realTokenState.lastKey = key;
        realTokenState.lastTokens = tokens;

        const ctxNow = SillyTavern.getContext();
        const visNow = (ctxNow.chat || []).filter(x => x.mes && !x.is_system);
        if (buildChatKey(visNow) !== key) return;

        let maxNow = 4096;
        try {
            if (typeof getMaxPromptTokens === 'function') maxNow = getMaxPromptTokens() || 4096;
        } catch { /* ignore */ }

        const pct = Math.min(100, (tokens / maxNow) * 100);
        applyContextPercent(pct, settings);
    }).catch(err => {
        realTokenState.inFlight = false;
        console.warn('TokenSaving: 真实 token 计数失败', err?.message || err);
    });
}

// 分区摘要式窗口可视化：
//   保留区 1~n            —— 始终保留的原文轮次
//   压缩区 n+1~n+m        —— 触发压缩时会被压掉的轮次（含已占用与尚未填充的空位）
//   溢出 rounds-windowMax —— 已超出窗口容量、急需压缩的轮次
// 每个区只渲染「首格 + 省略号 + 末格」，避免格子过多把一行铺满。
function renderWindowVisual(n, m, rounds, totalMsgs) {
    const $vis = $('#tokensaving_visual');
    if (!$vis.length) return;

    const windowMax = n + m;
    const lang = getLang();
    const roundCount = Math.max(0, Number(rounds) || 0);

    const cellHtml = (i, kind) => {
        // kind: 'retain' | 'compress' | 'empty'
        const classes = ['ts-cell'];
        if (kind === 'retain') classes.push('ts-cell-retain', 'ts-cell-filled');
        else if (kind === 'compress') classes.push('ts-cell-compress', 'ts-cell-filled');
        else classes.push('ts-cell-empty');
        if (i === roundCount) classes.push('ts-cell-current');
        const isRetain = i <= n;
        let title;
        if (kind === 'empty') {
            title = lang === 'en'
                ? `Round ${i} — empty slot (still filling up)`
                : `第 ${i} 轮 —— 空位（尚未填充）`;
        } else if (kind === 'overflow') {
            title = lang === 'en'
                ? `Round ${i} — beyond the window, awaiting compression`
                : `第 ${i} 轮 —— 已超出窗口，等待压缩`;
        } else {
            title = lang === 'en'
                ? `Round ${i}${isRetain ? ' (retain)' : ' (compress zone)'}`
                : `第 ${i} 轮${isRetain ? '（保留区）' : '（压缩区）'}`;
        }
        return `<div class="${classes.join(' ')}" title="${title}">${i}</div>`;
    };

    const ellipsisHtml = (hidden, note) => {
        // 只省略 1 格时不显示数字，避免出现「⋯1」这种别扭的写法
        const label = hidden > 1 ? `⋯${hidden}` : '⋯';
        const title = lang === 'en'
            ? `${hidden} round(s) omitted${note ? ` (${note})` : ''}`
            : `省略 ${hidden} 轮${note ? `（${note}）` : ''}`;
        return `<div class="ts-cell ts-cell-gap" title="${title}">${label}</div>`;
    };

    const overflowHtml = (label, title) =>
        `<div class="ts-cell ts-cell-overflow" title="${title}">${label}</div>`;

    // 渲染「首格 ⋯ 末格」形式的一段连续轮次。
    // 注意：压缩区内「尚未填充」的轮次要按空位渲染，不能整段涂成黄色。
    const renderRange = (from, to, kind) => {
        let out = '';
        if (to < from) return out;
        const kindAt = (i) => (kind === 'compress' && i > roundCount) ? 'empty' : kind;
        if (to - from < 2) {
            for (let i = from; i <= to; i++) out += cellHtml(i, kindAt(i));
            return out;
        }
        out += cellHtml(from, kindAt(from));
        out += ellipsisHtml(to - from - 1, lang === 'en' ? `rounds ${from + 1}–${to - 1}` : `第 ${from + 1}–${to - 1} 轮`);
        out += cellHtml(to, kindAt(to));
        return out;
    };

    let html = '';

    // ① 保留区：1 ~ min(n, rounds)
    const retainTo = Math.min(n, roundCount);
    if (retainTo > 0) html += renderRange(1, retainTo, 'retain');

    // ② 压缩区：n+1 ~ n+m（区分已占用 / 空位）
    const compressFirst = n + 1;
    const occupiedTo = Math.min(windowMax, roundCount);
    const overflowFrom = windowMax + 1;

    if (occupiedTo >= compressFirst) {
        html += renderRange(compressFirst, occupiedTo, 'compress');
    }
    if (roundCount < windowMax) {
        const emptyFirst = Math.max(compressFirst, roundCount + 1);
        html += renderRange(emptyFirst, windowMax, 'empty');
    }

    // ③ 溢出区：windowMax+1 ~ rounds
    if (roundCount > windowMax) {
        html += renderRange(overflowFrom, roundCount, 'overflow');
    }

    $vis.html(html);

    const over = Math.max(0, roundCount - windowMax);
    const parts = [
        `n=${n}`,
        `m=${m}`,
        (lang === 'en' ? `${roundCount}/${windowMax} rounds` : `已占用 ${roundCount}/${windowMax} 轮`),
    ];
    if (Number.isFinite(totalMsgs) && totalMsgs > 0) {
        parts.push(lang === 'en' ? `${totalMsgs} msgs` : `消息 ${totalMsgs} 条`);
    }
    if (over > 0) parts.push(lang === 'en' ? `over by ${over}` : `溢出 ${over}`);
    parts.push('🔍');
    $('#tokensaving_window_badge').text(parts.join(' · ')).css('cursor', 'pointer')
        .attr('title', lang === 'en'
            ? 'Click to toggle diagnostics (shows how m is computed)'
            : '点击切换诊断模式（显示 m 的计算依据）');
}

function updateUIState(settings) {
    $('#tokensaving_enabled').prop('checked', !!settings.enabled);
    $('#tokensaving_n').val(settings.n);
    $('#tokensaving_m').val(settings.m);
    $('#tokensaving_fill_percent').val(settings.fillPercent ?? DEFAULT_FILL_PERCENT);
    $('#tokensaving_max_summary_tokens').val(settings.maxSummaryTokens);
    $('#tokensaving_fcc_budget').val(settings.fccBudget);

    let blockVal = Number(settings.blockTokens);
    if (!Number.isFinite(blockVal) || blockVal <= 0) {
        blockVal = computeEffectiveBlockTokens(settings);
    }
    $('#tokensaving_block_tokens').val(blockVal);

    $('#tokensaving_max_api_calls').val(settings.maxApiCalls ?? 5);
    $('#tokensaving_compress_context').val(settings.compressContext ?? 64000);
    // 「前缀占用」由 updatePrefixStatus 写入自动测量值，这里不覆盖

    $('.ts-preset-btn').removeClass('is-active');
    if (resolveActivePresetKey(settings)) {
        $('.ts-preset-btn').addClass('is-active');
    }
    updatePresetCurrentLabel(settings);

    if (currentFCC?.content?.raw) {
        const $panel = $('#tokensaving_fcc_panel');
        $panel.show();
        $('#tokensaving_fcc_content').text(currentFCC.content.raw);
        const tok = estimateTokens(currentFCC.content.raw);
        const hidden = currentFCC.hidden_message_indices?.length || 0;
        $('#tokensaving_fcc_meta').text(`${tok} tok · ${hidden}`);
    } else {
        $('#tokensaving_fcc_panel').hide();
    }

    updateMetrics(settings);
}
