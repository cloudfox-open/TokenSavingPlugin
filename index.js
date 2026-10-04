/**
 * TokenSavingPlugin v1.9.2 - API 熔断机制
 *
 * v1.9.2 改动：
 *   - 识别致命 API 错误（402/401/403/余额/密钥/权限），立即中止整轮压缩
 *   - 熔断 5 分钟：期间自动触发全部跳过，避免反复报错
 *   - 手动点「立即压缩」可绕过熔断（用户充值后立即可用）
 *   - 弹窗明确提示「请检查余额/密钥」
 *
 * 继承 v1.9.1：
 *   - 压缩发送上限默认 64000
 *
 * 继承 v1.9.0：
 *   - 压缩时临时放宽 SillyTavern 上下文（解决 8k 设置 + 大模型冲突）
 *
 * 继承 v1.8.x：
 *   - 动态缩减块大小兜底、FCC = 单次摘要 × 2.5、仅保留「自动」预设
 *
 * 继承 v1.7.x：
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

const CONTEXT_ERROR_RE = /必要的提示词|提示词超过|超出上下文|超过上下文|上下文(大小|限制|长度|窗口)|necessary prompt|prompt[s]?\s*(exceed|too)|exceed[s]?\s*(the\s*)?(context|prompt)|context\s*(size|length|limit|window)|too\s*(long|large)\s*(for|to)/i;

// ★ 致命 API 错误（余额不足 / 密钥无效 / 无权限）
const FATAL_API_ERROR_RE = /402|payment\s*required|insufficient|quota|credit|balance|billing|unauthoriz|401|invalid\s*api|forbidden|403|欠费|余额|额度|无权|认证|密钥/i;

// ★ 熔断状态
let apiCircuitBreakerUntil = 0;
const CIRCUIT_BREAKER_COOLDOWN = 5 * 60 * 1000;   // 5 分钟

// ==================== I18N 字典 ====================
const I18N = {
    zh: {
        title: '💾 TokenSaving',
        theme_switch_soft: '切换到 新拟态 Soft UI',
        theme_switch_dark: '切换到 暗黑哥特',
        lang_btn_label: 'EN',

        status_ready: '就绪',
        status_growing: '🌱 生长阶段（{rounds}/{max} 轮, {percent}%）',
        status_overflow: '🗜️ 窗口溢出（{rounds}/{max} 轮），压缩中...',
        status_threshold: '🚨 Token 达阈值（{percent}%），压缩中...',
        status_manual: '⚡ 手动压缩中...',
        status_too_few: '消息太少（{rounds} 轮 ≤ n={n}）',
        status_compressing: 'AI 压缩 {count} 条旧消息...',
        status_selfcheck: '质量自检中... (API {current}/{max})',
        status_folding: 'FCC 超出上限，折叠重组中... (API {current}/{max})',
        status_complete: '✅ 压缩完成，保留最近 {rounds} 轮原文 (API {api}次)',
        status_complete_warn: '⚠️ 完成（自检有提示）保留 {rounds} 轮 (API {api}次)',
        status_failed: '❌ 压缩失败，已回退 ({msg})',
        status_aborted: '⏹ 已中止，原文已恢复',
        status_aborting: '⏹ 正在中止，等待当前步骤完成...',
        status_preset_current_custom: '当前：自定义配置',
        status_preset_current: '当前：{label}（n={n}, m={m}, 摘要={summary}, FCC={fcc}）',
        status_circuit_breaker: '⚠️ API 熔断中（剩余 {sec}s）',

        toast_input_warning: '压缩进行中，请稍候再发送',
        toast_already_running: '已有压缩任务正在运行',
        toast_preset_applied: '已应用「{label}」预设',
        toast_complete: '压缩完成，保留最近 {rounds} 轮原文',
        toast_complete_warn: '压缩完成，但自检提示可能遗漏：{warn}',
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
        legend_retain: '保留区 (1~n)',
        legend_compress: '压缩区 (n+1~n+m)',
        threshold_title: '阈值与预算',
        threshold_label: 'Token 兜底阈值 (%)',
        threshold_desc: '仅当窗口未溢出但 Token 逼近上限时兜底触发',
        summary_label: '单次摘要上限 (tok)',
        summary_desc: '防止单次摘要过大导致上下文爆炸',
        fcc_budget_label: 'FCC 摘要上限 (tok)',
        fcc_budget_desc: '所有历史摘要合计的最大长度。超出时自动折叠精简，避免占用过多上下文。默认 = 单次摘要上限 × 2.5',
        selfcheck_label: 'Feynman 质量自检',
        selfcheck_desc: '压缩后检测遗漏，失败仅警告不阻断（保留原文）。长篇剧情、角色扮演推荐开启',
        block_tokens_label: '分块大小 (tok)',
        block_tokens_desc: '单次压缩的文本块大小。应用预设时会按上下文档位自动填入（4k→1024 / 8k→2048 / 16k→3072 / 100k→6144）',
        max_api_calls_label: '最大 API 调用次数',
        max_api_calls_desc: '单次压缩最多调用几次 AI。内容过大时会自动提升（硬上限 30 次）',
        compress_context_label: '压缩发送上限 (tok)',
        compress_context_desc: '压缩时临时把 SillyTavern 的上下文上限放宽到该值，压缩完恢复。0 = 跟随 SillyTavern 设置。API 支持大上下文时建议填 64000 或 128000（如 DeepSeek），避免压缩报错。',

        btn_manual: '立即压缩',
        btn_stop: '停止压缩',
        btn_clear: '清除 FCC',

        fcc_panel_title: 'FCC 摘要内容',
        footer_hint: '💡 实测最优：n=5，滑动窗口增量 4096→14 / 8192→28 / 16k→56 / 100k→112',

        metric_rounds: '轮数',
        metric_context: '上下文',
        metric_fcc: 'FCC',

        prompt_compress: `你是信息压缩引擎，不是故事作者。从聊天记录中提取关键信息，按指定 JSON 格式输出。
{block_note}
## 禁止
- 禁止续写/推测/编造/复制原文
- 禁止输出 JSON 之外的任何内容

## 角色参考（辅助理解，不代表事实）
{ref_context}
{prior_context}
## 待压缩聊天记录（第 {block_index}/{block_count} 块）
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

        prompt_selfcheck: `你是质量检查员。对比原文和压缩摘要，判断是否遗漏了【影响长期剧情走向】的关键信息。

## 判定标准（务必严格遵守）
**以下视为"关键信息遗漏"：**
- 影响主线/长期关系的重大事件（分离、告白、决裂、身份揭晓）
- 会改变后续行为逻辑的承诺或誓言（例如"答应带她离开""约定再也不见"）
- 关系到世界观的新设定（新角色、新能力、新规则）
- 原文提到但未展开的线索、计划、约定、"以后再说"类伏笔

**以下不算遗漏，忽略即可：**
- 日常寒暄、吃饭、打招呼、作息安排
- 一次性的临时约定（今天/这周末/中午前的安排）
- 场景/道具细节（剪花、插瓶、送礼物等修饰性描写）
- 情绪化的语气词、玩笑、打趣

## 参考设定
{ref_context}

## 聊天原文（截取）
{original}

## 压缩摘要
{summary}

如果无关键遗漏，严格回复 "PASS"（只回复这两个字）。
如果有关键遗漏，严格以 "FAIL: " 开头，后接一句话说明。`,

        prompt_fold: `你是历史记录合并引擎。请将【已有摘要】和【新增摘要】合并为一段更精简的摘要。
禁止编造，只融合已有信息。

## 角色参考
{ref_context}

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
        title: '💾 TokenSaving',
        theme_switch_soft: 'Switch to Neumorphism Soft UI',
        theme_switch_dark: 'Switch to Dark Gothic',
        lang_btn_label: '中文',

        status_ready: 'Ready',
        status_growing: '🌱 Growing ({rounds}/{max} rounds, {percent}%)',
        status_overflow: '🗜️ Window overflow ({rounds}/{max}), compressing...',
        status_threshold: '🚨 Token threshold hit ({percent}%), compressing...',
        status_manual: '⚡ Manual compression...',
        status_too_few: 'Too few messages ({rounds} rounds ≤ n={n})',
        status_compressing: 'AI compressing {count} old messages...',
        status_selfcheck: 'Quality self-check... (API {current}/{max})',
        status_folding: 'FCC over cap, folding... (API {current}/{max})',
        status_complete: '✅ Compression complete, kept latest {rounds} rounds (API {api})',
        status_complete_warn: '⚠️ Complete (self-check warning), kept {rounds} rounds (API {api})',
        status_failed: '❌ Compression failed, rolled back ({msg})',
        status_aborted: '⏹ Aborted, messages restored',
        status_aborting: '⏹ Aborting, waiting for current step...',
        status_preset_current_custom: 'Current: Custom config',
        status_preset_current: 'Current: {label} (n={n}, m={m}, summary={summary}, FCC={fcc})',
        status_circuit_breaker: '⚠️ API circuit breaker (remaining {sec}s)',

        toast_input_warning: 'Compression in progress, please wait',
        toast_already_running: 'A compression task is already running',
        toast_preset_applied: 'Preset "{label}" applied',
        toast_complete: 'Compression complete, kept latest {rounds} rounds',
        toast_complete_warn: 'Compression complete, but self-check warning: {warn}',
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
        legend_retain: 'Retain (1~n)',
        legend_compress: 'Compress (n+1~n+m)',
        threshold_title: 'Threshold & Budget',
        threshold_label: 'Token fallback threshold (%)',
        threshold_desc: 'Only triggers when window is not full but tokens are near the limit',
        summary_label: 'Max summary tokens (tok)',
        summary_desc: 'Prevents a single summary from bloating the context',
        fcc_budget_label: 'FCC summary cap (tok)',
        fcc_budget_desc: 'Maximum combined length of all history summaries. Auto-folded when exceeded, to limit context usage. Default = 2.5 × max summary tokens',
        selfcheck_label: 'Feynman quality self-check',
        selfcheck_desc: 'Detects omissions after compression; warnings only, never blocks. Recommended for long-form roleplay',
        block_tokens_label: 'Block size (tok)',
        block_tokens_desc: 'Text block size per compression. Auto-filled per context tier when a preset is applied (4k→1024 / 8k→2048 / 16k→3072 / 100k→6144)',
        max_api_calls_label: 'Max API calls',
        max_api_calls_desc: 'Maximum AI calls per compression. Auto-raised if content is large (hard cap 30)',
        compress_context_label: 'Compress context cap (tok)',
        compress_context_desc: 'Temporarily raises SillyTavern\'s context limit during compression, restores after. 0 = follow SillyTavern setting. For APIs with large context (e.g. DeepSeek), set to 64000 or 128000 to avoid compression errors.',

        btn_manual: 'Compress Now',
        btn_stop: 'Stop',
        btn_clear: 'Clear FCC',

        fcc_panel_title: 'FCC Summary Content',
        footer_hint: '💡 Tested optimal: n=5, m = 14 (4096) / 28 (8192) / 56 (16k) / 112 (100k)',

        metric_rounds: 'Rounds',
        metric_context: 'Context',
        metric_fcc: 'FCC',

        prompt_compress: `You are an information compression engine, not a story author. Extract key information from the chat log and output in the specified JSON format.
{block_note}
## Forbidden
- No continuation / speculation / fabrication / verbatim copying
- No output other than JSON

## Character Reference (contextual aid, not fact)
{ref_context}
{prior_context}
## Chat Log to Compress (block {block_index}/{block_count})
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

        prompt_selfcheck: `You are a quality inspector. Compare the original text and the compressed summary; determine if any 【long-term plot-affecting】 key information was omitted.

## Criteria (strictly follow)
**These count as "key information omission":**
- Major events affecting the main plot/long-term relationship (separation, confession, break-up, identity reveal)
- Promises or vows that change future behavior logic (e.g., "promised to take her away", "agreed to never meet again")
- New world-building settings (new characters, new abilities, new rules)
- Threads mentioned but not yet developed, plans, agreements, "deal with it later" foreshadowing

**The following do NOT count as omissions, ignore them:**
- Daily greetings, meals, hellos, schedules
- One-off temporary arrangements (today/this weekend/before noon)
- Scene/prop details (trimming flowers, vases, gifts, decorative descriptions)
- Emotional interjections, jokes, banter

## Reference Settings
{ref_context}

## Original Chat (excerpt)
{original}

## Compressed Summary
{summary}

If no key omission, reply strictly with "PASS" (these two words only).
If there is a key omission, start strictly with "FAIL: " followed by a one-sentence explanation.`,

        prompt_fold: `You are a history merging engine. Merge the 【existing summary】 and 【new summary】 into a more concise summary.
No fabrication, only merge existing information.

## Character Reference
{ref_context}

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
    if (settings) updatePresetCurrentLabel(settings);
}

// ==================== 上下文档位 → 分块大小映射 ====================
function tierToBlockTokens(tier) {
    switch (tier) {
        case 4096:   return 1024;
        case 8192:   return 2048;
        case 16384:  return 3072;
        case 100000: return 6144;
        default:     return 1024;
    }
}

// ==================== 预设表 ====================
const PRESETS = {
    '4096_auto': {
        n: 5, m: 14,
        thresholdPercent: 80,
        maxSummaryTokens: 210,
        fccBudget: 525,
        blockTokens: 1024,
        maxApiCalls: 4,
    },
    '8192_auto': {
        n: 5, m: 28,
        thresholdPercent: 80,
        maxSummaryTokens: 256,
        fccBudget: 640,
        blockTokens: 2048,
        maxApiCalls: 5,
    },
    '16384_auto': {
        n: 5, m: 56,
        thresholdPercent: 80,
        maxSummaryTokens: 300,
        fccBudget: 750,
        blockTokens: 3072,
        maxApiCalls: 6,
    },
    '100000_auto': {
        n: 5, m: 112,
        thresholdPercent: 80,
        maxSummaryTokens: 400,
        fccBudget: 1000,
        blockTokens: 6144,
        maxApiCalls: 8,
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
    thresholdPercent: 80,
    n: 5,
    m: 14,
    selfCheck: true,
    maxSummaryTokens: 210,
    fccBudget: 525,
    activePreset: '4096_auto',
    lang: 'zh',
    blockTokens: 1024,
    maxApiCalls: 5,
    compressContext: 64000,
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
    if (settings.thresholdPercent === undefined) settings.thresholdPercent = 80;
    if (settings.compressContext === undefined) settings.compressContext = 64000;

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
        triggerCompression(settings, 'ai_replied', false);
    });

    ctx.eventSource.on(ctx.eventTypes.GENERATION_AFTER_COMMANDS, (type, _, dryRun) => {
        if (type === 'quiet' || dryRun) return;
        syncPresetWithContext(settings, true);
        triggerCompression(settings, 'after_cmd', false);
    });

    pollTimer = setInterval(() => {
        if (settings.enabled && compressionState === 'idle') {
            triggerCompression(settings, 'poll', false);
        }
    }, POLL_INTERVAL);

    ctx.eventSource.on(ctx.eventTypes.MESSAGE_SENDING, () => {
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

    currentFCC = loadFCC();
    if (currentFCC && settings.enabled) injectFCC(currentFCC);
    updateUIState(settings);

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

function calcEffectiveBlockTokens(settings, responseLength) {
    const desired = getBlockTokens(settings);
    const maxCtx = getAvailableContextTokens();

    const outputReserve = Math.max(Number(responseLength) || 600, 600);
    const available = maxCtx
        - COMPRESS_FIXED_OVERHEAD
        - outputReserve
        - COMPRESS_SAFETY_MARGIN;

    if (available < COMPRESS_MIN_BLOCK) {
        return { blockTokens: COMPRESS_MIN_BLOCK, limited: true, insufficient: true, maxCtx, available };
    }

    if (available < desired) {
        return { blockTokens: available, limited: true, insufficient: false, maxCtx, available };
    }

    return { blockTokens: desired, limited: false, insufficient: false, maxCtx, available };
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
    settings.thresholdPercent = preset.thresholdPercent;
    settings.maxSummaryTokens = preset.maxSummaryTokens;
    settings.fccBudget = preset.fccBudget;
    settings.blockTokens = preset.blockTokens;
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

    const key = resolveActivePresetKey(settings);
    if (key) {
        const preset = PRESETS[key];
        $el.text(t('status_preset_current', {
            label: presetDisplayLabel(key),
            n: preset.n,
            m: preset.m,
            summary: preset.maxSummaryTokens,
            fcc: preset.fccBudget,
        }));
    } else {
        $el.text(t('status_preset_current_custom'));
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

    $('#tokensaving_threshold').on('input', function () {
        settings.thresholdPercent = parseInt($(this).val()) || 80;
        markCustom(); updateMetrics(settings);
    });
    $('#tokensaving_n').on('input', function () {
        settings.n = parseInt($(this).val()) || 5;
        markCustom(); updateMetrics(settings);
    });
    $('#tokensaving_m').on('input', function () {
        settings.m = parseInt($(this).val()) || 14;
        markCustom(); updateMetrics(settings);
    });
    $('#tokensaving_max_summary_tokens').on('input', function () {
        settings.maxSummaryTokens = parseInt($(this).val()) || 210;
        markCustom();
    });
    $('#tokensaving_fcc_budget').on('input', function () {
        settings.fccBudget = parseInt($(this).val()) || 525;
        markCustom();
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
        saveSettingsDebounced();
    });
    $('#tokensaving_selfcheck').on('change', function () {
        settings.selfCheck = !!$(this).prop('checked');
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
    const m = Math.max(1, Number(settings.m) || 14);
    const thresholdPercent = Math.max(1, Math.min(100, Number(settings.thresholdPercent) || 80));

    const overWindow = totalRounds > n + m;
    const overThreshold = usagePercent >= thresholdPercent;

    if (!manual && !overWindow && !overThreshold) {
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
    } else if (manual) {
        updateStatus(`状态: ${t('status_manual')}`);
    } else {
        updateStatus(`状态: ${t('status_threshold', { percent: usagePercent.toFixed(1) })}`);
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
    const estimatedBlocks = Math.max(1, Math.ceil(compressTokens / blockInfo.blockTokens));

    if (estimatedBlocks > HARD_API_CAP) {
        console.warn(`TokenSaving: 内容过大 ${estimatedBlocks} 块 > 硬上限 ${HARD_API_CAP}，中止`);
        updateStatus(`状态: ${t('status_failed', { msg: `内容过大（${estimatedBlocks} 块）` })}`);
        try {
            toastr.error(
                getLang() === 'en'
                    ? `Content too large: ${estimatedBlocks} blocks exceeds cap ${HARD_API_CAP}. Reduce retention (n) or increase block size.`
                    : `内容过大：约 ${estimatedBlocks} 块超过硬上限 ${HARD_API_CAP}。请减少保留轮数 n 或增大分块大小。`,
                'TokenSaving',
                { timeOut: 8000 }
            );
        } catch (e) {}
        compressionState = 'idle';
        abortRequested = false;
        $('#tokensaving_stop_btn').hide();
        unlockInput();
        updateMetrics(settings);
        return;
    }

    const userMaxApiCalls = Math.max(1, Number(settings.maxApiCalls) || 5);
    const reserveCalls = (settings.selfCheck ? 1 : 0) + 1;
    const neededCalls = estimatedBlocks + reserveCalls;
    const effectiveMaxApiCalls = Math.min(HARD_API_CAP, Math.max(userMaxApiCalls, neededCalls));

    if (effectiveMaxApiCalls > userMaxApiCalls) {
        console.log(`TokenSaving: 自动提升 API 上限 ${userMaxApiCalls} → ${effectiveMaxApiCalls}（约 ${estimatedBlocks} 块）`);
        try {
            toastr.info(
                getLang() === 'en'
                    ? `Large task: API limit raised to ${effectiveMaxApiCalls} (≈${estimatedBlocks} blocks)`
                    : `大任务：API 上限自动提升至 ${effectiveMaxApiCalls}（约 ${estimatedBlocks} 块）`,
                'TokenSaving',
                { timeOut: 6000 }
            );
        } catch (e) {}
    }

    // 压缩期间临时放宽 SillyTavern 上下文
    const userCap = Math.max(0, Number(settings.compressContext) || 0);
    const neededContext = blockInfo.blockTokens
        + COMPRESS_FIXED_OVERHEAD
        + responseLengthHint
        + COMPRESS_SAFETY_MARGIN;
    const targetContext = Math.max(userCap, neededContext);
    const restoreContext = tryExpandContext(targetContext);

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
        const charData = getCurrentCharacterData();
        const refContext = getReferenceContext(charData);

        updateStatus(`状态: ${t('status_compressing', { count: toCompress.length })}`);
        const summary = await compressToSummary(
            compressText, refContext, settings,
            apiCounter, bumpApi, checkAbort,
            blockInfo.blockTokens
        );

        checkAbort();
        if (!summary || !summary.trim()) {
            throw new Error(getLang() === 'en' ? 'AI returned empty summary' : 'AI 未返回有效的压缩结果');
        }

        let selfCheckWarning = '';
        if (settings.selfCheck) {
            updateStatus(`状态: ${t('status_selfcheck', { current: apiCounter.count, max: effectiveMaxApiCalls })}`);
            const checkResult = await feynmanSelfCheck(summary, compressText, refContext, bumpApi, checkAbort);
            if (!checkResult.passed) {
                selfCheckWarning = checkResult.gaps || '';
                console.warn('TokenSaving: 自检提示（不阻断）', selfCheckWarning);
            }
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
            const folded = await foldFCC(currentFCC.content.raw, summary, fccBudget, refContext, bumpApi, checkAbort);
            newFCCRaw = folded || `${historyTag} ${summary}`;
        }

        if (estimateTokens(newFCCRaw) > fccBudget) {
            newFCCRaw = truncateToTokens(newFCCRaw, fccBudget);
        }

        if (selfCheckWarning) {
            const warnTag = getLang() === 'en' ? '[⚠️ Self-check hint]' : '[⚠️ 自检提示]';
            newFCCRaw += `\n${warnTag} ${selfCheckWarning}`;
        }
        currentFCC.content.raw = newFCCRaw;

        await hideMessages(chat, startIdx, endIdx, currentFCC);
        saveFCC(currentFCC);
        injectFCC(currentFCC);

        const newVisibleCount = Math.floor((visibleMsgs.length - toCompress.length) / 2);
        if (selfCheckWarning) {
            updateStatus(`状态: ${t('status_complete_warn', { rounds: newVisibleCount, api: apiCounter.count })}`);
            try { toastr.warning(t('toast_complete_warn', { warn: selfCheckWarning }), 'TokenSaving'); } catch (e) {}
        } else {
            updateStatus(`状态: ${t('status_complete', { rounds: newVisibleCount, api: apiCounter.count })}`);
            try { toastr.success(t('toast_complete', { rounds: newVisibleCount }), 'TokenSaving'); } catch (e) {}
        }
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
async function compressToSummary(text, refContext, settings, apiCounter, bumpApi, checkAbort, effectiveBlockTokens) {
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
            ref_context: String(refContext || (lang === 'en' ? 'None' : '无')).substring(0, 350),
            prior_context: priorSection,
            block_index: i + 1,
            block_count: blocks.length,
            block_text: blockText,
            max_chars: maxChars,
        });

        let result;
        try {
            bumpApi();
            result = await withTimeout(
                ctx.generateQuietPrompt({ quietPrompt: prompt, responseLength }),
                90000,
                `compress block ${i + 1}/${blocks.length}`,
            );
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

function sampleOriginalForSelfCheck(text, limit = 2400) {
    const s = String(text || '');
    if (s.length <= limit) return s;
    const half = Math.floor(limit / 2);
    return s.substring(0, half)
        + '\n...(中间省略)...\n'
        + s.substring(s.length - half);
}

async function feynmanSelfCheck(summary, originalText, refContext, bumpApi, checkAbort) {
    try {
        checkAbort();
        const ctx = SillyTavern.getContext();
        const lang = getLang();

        const maxCtx = getAvailableContextTokens();
        const selfCheckReserved = 600 + 400 + 500 + 200 + 300;
        const originalLimit = Math.max(400, Math.min(2400, maxCtx - selfCheckReserved));

        const prompt = t('prompt_selfcheck', {
            ref_context: String(refContext || (lang === 'en' ? 'None' : '无')).substring(0, 300),
            original: sampleOriginalForSelfCheck(originalText, originalLimit),
            summary: summary,
        });

        bumpApi();
        const result = await withTimeout(
            ctx.generateQuietPrompt({ quietPrompt: prompt, responseLength: 200 }),
            60000,
            'selfcheck',
        );
        const checkText = (result || '').trim();

        if (!checkText) return { passed: true, gaps: '' };
        if (checkText.startsWith('PASS') || checkText.includes('无遗漏') || checkText.includes('没有遗漏') || checkText.includes('No omission')) {
            return { passed: true, gaps: '' };
        }
        return { passed: false, gaps: checkText.replace(/^FAIL[:：]\s*/, '').trim() };
    } catch (err) {
        if (abortRequested) throw err;
        if (/exceed limit/i.test(err.message || '')) throw err;
        if (isFatalApiError(err.message)) {
            tripCircuitBreaker(String(err.message || '').slice(0, 120));
            throw err;
        }
        console.warn('TokenSaving: 自检失败，默认通过', err.message || err);
        return { passed: true, gaps: '' };
    }
}

async function foldFCC(oldFCC, newSummary, budget, refContext, bumpApi, checkAbort) {
    try {
        checkAbort();
        const ctx = SillyTavern.getContext();
        const lang = getLang();

        const safeBudget = Math.max(50, Number(budget) || 525);
        const maxChars = lang === 'en' ? Math.floor(safeBudget * 4) : Math.floor(safeBudget * 1.5);

        const prompt = t('prompt_fold', {
            ref_context: String(refContext || (lang === 'en' ? 'None' : '无')).substring(0, 300),
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
    const ctx = SillyTavern.getContext();
    const charId = ctx.characterId;
    if (charId !== undefined && charId !== null) {
        return ctx.characters[charId] || null;
    }
    return null;
}

function getReferenceContext(charData) {
    if (!charData || !charData.data) return '';
    const lang = getLang();
    const data = charData.data;
    const parts = [];
    const labels = lang === 'en'
        ? { desc: 'Description', pers: 'Personality', scen: 'Scenario' }
        : { desc: '描述', pers: '性格', scen: '场景' };
    if (data.description?.trim()) parts.push(`【${labels.desc}】${data.description.trim().substring(0, 300)}`);
    if (data.personality?.trim()) parts.push(`【${labels.pers}】${data.personality.trim().substring(0, 200)}`);
    if (data.scenario?.trim()) parts.push(`【${labels.scen}】${data.scenario.trim().substring(0, 200)}`);
    return parts.join('\n');
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

function updateMeta() {}

function updateMetrics(settings) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const visibleMsgs = chat.filter(m => m.mes && !m.isSystem && !m.is_system);
        const rounds = Math.floor(visibleMsgs.length / 2);
        const n = Math.max(1, Number(settings.n) || 5);
        const m = Math.max(1, Number(settings.m) || 14);
        const windowMax = n + m;

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

        renderWindowVisual(n, m, rounds);
    } catch (err) {
        console.warn('TokenSaving: updateMetrics 失败', err);
    }
}

function applyContextPercent(percent, settings) {
    $('#tokensaving_ctx').text(`${percent.toFixed(0)}%`);

    const thresholdPercent = Math.max(1, Math.min(100, Number(settings.thresholdPercent) || 80));
    const $bar = $('#tokensaving_progress_bar');
    $bar.css('width', `${percent}%`);
    $bar.removeClass('is-warn is-error');
    if (percent >= thresholdPercent) $bar.addClass('is-error');
    else if (percent >= thresholdPercent - 20) $bar.addClass('is-warn');
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

function renderWindowVisual(n, m, rounds) {
    const $vis = $('#tokensaving_visual');
    if (!$vis.length) return;

    const total = n + m;
    const MAX_CELLS = 40;
    const lang = getLang();
    let html = '';

    const renderCell = (i) => {
        const isRetain = i <= n;
        const filled = i <= rounds;
        const isCurrent = i === rounds;
        const classes = ['ts-cell'];
        classes.push(isRetain ? 'ts-cell-retain' : 'ts-cell-compress');
        if (filled) classes.push('ts-cell-filled');
        if (isCurrent) classes.push('ts-cell-current');
        const title = lang === 'en'
            ? `Round ${i}${isRetain ? ' (retain)' : ' (compress)'}`
            : `第 ${i} 轮${isRetain ? '（保留区）' : '（压缩区）'}`;
        return `<div class="${classes.join(' ')}" title="${title}">${i}</div>`;
    };

    if (total <= MAX_CELLS) {
        for (let i = 1; i <= total; i++) html += renderCell(i);
    } else {
        const headCount = 12;
        for (let i = 1; i <= headCount; i++) html += renderCell(i);
        html += `<div class="ts-cell" style="width:auto;padding:0 6px;opacity:0.5">⋯</div>`;
        const tailStart = Math.max(headCount + 1, total - 8);
        for (let i = tailStart; i <= total; i++) html += renderCell(i);
    }

    if (rounds > total) {
        const overflowTitle = lang === 'en' ? `Overflow by ${rounds - total} rounds` : `已溢出 ${rounds - total} 轮`;
        html += `<div class="ts-cell ts-cell-overflow" title="${overflowTitle}">+${rounds - total}</div>`;
    }

    $vis.html(html);
    $('#tokensaving_window_badge').text(`n=${n} · m=${m}`);
}

function updateUIState(settings) {
    $('#tokensaving_enabled').prop('checked', !!settings.enabled);
    $('#tokensaving_threshold').val(settings.thresholdPercent);
    $('#tokensaving_n').val(settings.n);
    $('#tokensaving_m').val(settings.m);
    $('#tokensaving_max_summary_tokens').val(settings.maxSummaryTokens);
    $('#tokensaving_fcc_budget').val(settings.fccBudget);

    let blockVal = Number(settings.blockTokens);
    if (!Number.isFinite(blockVal) || blockVal <= 0) {
        const { tier } = detectContextTier();
        blockVal = tierToBlockTokens(tier);
    }
    $('#tokensaving_block_tokens').val(blockVal);

    $('#tokensaving_max_api_calls').val(settings.maxApiCalls ?? 5);
    $('#tokensaving_selfcheck').prop('checked', !!settings.selfCheck);
    $('#tokensaving_compress_context').val(settings.compressContext ?? 64000);

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