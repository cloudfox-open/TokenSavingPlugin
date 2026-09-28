/**
 * TokenSavingPlugin v1.5.0 - 缓存命中优化 + i18n
 *
 * v1.5.0 新增：
 *   - 中英文语言切换（点击顶部工具栏 🌐 按钮）
 *   - 静态 UI 通过 data-i18n 属性 + 字典翻译
 *   - 动态状态/toast 通过 t() 函数翻译
 *   - AI 压缩/自检/折叠的提示词随语言切换
 *
 * v1.4.2 修复：
 *   - 自检 FAIL 不再回退整个压缩，改为「警告不阻断」
 *   - 自检判定标准与压缩标准对齐
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getMaxPromptTokens, printMessages } from '../../../../script.js';
import { hideChatMessageRange } from '../../../chats.js';

const EXT_NAME = 'tokensaving';
const EXT_KEY = 'tokensaving_fcc';
const MAX_API_CALLS = 5;
const POLL_INTERVAL = 30000;

// ==================== I18N 字典 ====================
const I18N = {
    zh: {
        // 标题与工具栏
        title: '💾 TokenSaving',
        theme_switch_soft: '切换到 新拟态 Soft UI',
        theme_switch_dark: '切换到 暗黑哥特',
        lang_btn_label: 'EN',

        // 状态
        status_ready: '就绪',
        status_growing: '🌱 生长阶段（{rounds}/{max} 轮, {percent}%）',
        status_overflow: '🗜️ 窗口溢出（{rounds}/{max} 轮），压缩中...',
        status_threshold: '🚨 Token 达阈值（{percent}%），压缩中...',
        status_manual: '⚡ 手动压缩中...',
        status_too_few: '消息太少（{rounds} 轮 ≤ n={n}）',
        status_compressing: 'AI 压缩 {count} 条旧消息...',
        status_selfcheck: '质量自检中... (API {current}/{max})',
        status_folding: 'FCC 超出预算，折叠重组中... (API {current}/{max})',
        status_complete: '✅ 压缩完成，保留最近 {rounds} 轮原文 (API {api}次)',
        status_complete_warn: '⚠️ 完成（自检有提示）保留 {rounds} 轮 (API {api}次)',
        status_failed: '❌ 压缩失败，已回退 ({msg})',
        status_aborted: '⏹ 已中止，原文已恢复',
        status_aborting: '⏹ 正在中止，等待当前步骤完成...',
        status_preset_current_custom: '当前：自定义配置',
        status_preset_current: '当前：{label}（n={n}, m={m}, 摘要={summary}, FCC={fcc}）',

        // Toast
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

        // 预设
        preset_title: '智能预设',
        preset_hint: '根据当前模型上下文长度自动选择最优参数（基于实测成本数据）。',
        preset_auto: '自动（推荐）',
        preset_auto_desc: '按上下文自动选择',
        preset_eco: '省成本',
        preset_eco_desc: '更少触发，单价最低',
        preset_fast: '省内存',
        preset_fast_desc: '压缩更勤，上下文更小',
        preset_quality: '高质量',
        preset_quality_desc: '更长摘要，保留更多',

        // 卡片
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
        fcc_budget_label: 'FCC 总预算 (tok)',
        fcc_budget_desc: 'FCC 超过此值时自动折叠重组',
        selfcheck_label: 'Feynman 质量自检',
        selfcheck_desc: '压缩后检测遗漏，失败自动回退不隐藏消息。长篇剧情、角色扮演、前情动辄影响后续几十轮的走向推荐开启',

        // 按钮
        btn_manual: '立即压缩',
        btn_stop: '停止压缩',
        btn_clear: '清除 FCC',

        // 面板
        fcc_panel_title: 'FCC 摘要内容',
        footer_hint: '💡 实测最优：4096 n=2, m=8 · 8192 n=2, m=28 · 32k+ n=3, m=40',

        // 标签
        metric_rounds: '轮数',
        metric_context: '上下文',
        metric_fcc: 'FCC',

        // 压缩提示词
        prompt_compress: `你是信息压缩引擎，不是故事作者。从聊天记录中提取关键信息，按指定 JSON 格式输出。
{block_note}
## 禁止
- 禁止续写/推测/编造/复制原文
- 禁止输出 JSON 之外的任何内容

## 角色参考（辅助理解）
{ref_context}

## 待压缩聊天记录（第 {block_index}/{block_count} 块）
{block_text}

## ⚠️ 严格限制
1. 只从原文提取信息。
2. **总字数必须控制在 {max_chars} 个汉字以内！超长将被截断。**
3. 省略寒暄和日常互动，只保留：改变关系的事件、承诺/约定、情感转折点。

## 输出格式（JSON）
{
  "events": "关键事件1→事件2→事件3",
  "relationship": "关系变化描述",
  "emotion": "情感轨迹变化"
}`,
        prompt_block_note: '⚠️ 这是第 {i}/{n} 块，只压缩本块。',

        prompt_selfcheck: `你是质量检查员。对比原文和压缩摘要，判断是否遗漏了【影响长期剧情走向】的关键信息。

## 判定标准（务必严格遵守）
**只把以下几类视为"关键信息遗漏"：**
- 影响主线/长期关系的重大事件（分离、告白、决裂、身份揭晓）
- 会改变后续行为逻辑的承诺或誓言（例如"答应带她离开""约定再也不见"）
- 关系到世界观的新设定（新角色、新能力、新规则）

**以下一律不算遗漏，忽略即可：**
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
        title: 'TokenSaving',
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
        status_folding: 'FCC over budget, folding... (API {current}/{max})',
        status_complete: '✅ Compression complete, kept latest {rounds} rounds (API {api})',
        status_complete_warn: '⚠️ Complete (self-check warning), kept {rounds} rounds (API {api})',
        status_failed: '❌ Compression failed, rolled back ({msg})',
        status_aborted: '⏹ Aborted, messages restored',
        status_aborting: '⏹ Aborting, waiting for current step...',
        status_preset_current_custom: 'Current: Custom config',
        status_preset_current: 'Current: {label} (n={n}, m={m}, summary={summary}, FCC={fcc})',

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

        preset_title: 'Smart Presets',
        preset_hint: 'Auto-selects optimal parameters based on your model context length (based on measured cost data).',
        preset_auto: 'Auto (recommended)',
        preset_auto_desc: 'Auto-select by context',
        preset_eco: 'Cost-saving',
        preset_eco_desc: 'Fewer triggers, lowest unit cost',
        preset_fast: 'Memory-saving',
        preset_fast_desc: 'Compress more often, smaller context',
        preset_quality: 'High quality',
        preset_quality_desc: 'Longer summaries, more retained',

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
        fcc_budget_label: 'FCC total budget (tok)',
        fcc_budget_desc: 'Auto-fold when FCC exceeds this budget',
        selfcheck_label: 'Feynman quality self-check',
        selfcheck_desc: 'Detects omissions after compression; auto-rollback if failed. Recommended for long-form roleplay where backstory affects dozens of rounds',

        btn_manual: 'Compress Now',
        btn_stop: 'Stop',
        btn_clear: 'Clear FCC',

        fcc_panel_title: 'FCC Summary Content',
        footer_hint: '💡 Tested optimal: 4096 n=2, m=8 · 8192 n=2, m=28 · 32k+ n=3, m=40',

        metric_rounds: 'Rounds',
        metric_context: 'Context',
        metric_fcc: 'FCC',

        prompt_compress: `You are an information compression engine, not a story author. Extract key information from the chat log and output in the specified JSON format.
{block_note}
## Forbidden
- No continuation / speculation / fabrication / verbatim copying
- No output other than JSON

## Character Reference (contextual aid)
{ref_context}

## Chat Log to Compress (block {block_index}/{block_count})
{block_text}

## ⚠️ Strict Limits
1. Extract from original text only.
2. **Total length must be within {max_chars} characters! Excess will be truncated.**
3. Omit greetings and small talk. Keep only: events that change relationships, promises/agreements, emotional turning points.

## Output Format (JSON)
{
  "events": "event1→event2→event3",
  "relationship": "relationship change description",
  "emotion": "emotional trajectory"
}`,
        prompt_block_note: '⚠️ This is block {i}/{n}, compress only this block.',

        prompt_selfcheck: `You are a quality inspector. Compare the original text and the compressed summary; determine if any 【long-term plot-affecting】 key information was omitted.

## Criteria (strictly follow)
**Only these count as "key information omission":**
- Major events affecting the main plot/long-term relationship (separation, confession, break-up, identity reveal)
- Promises or vows that change future behavior logic (e.g., "promised to take her away", "agreed to never meet again")
- New world-building settings (new characters, new abilities, new rules)

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

    // 语言按钮文字：中文界面显示 "EN"，英文界面显示 "中文"
    const btnLabel = dict.lang_btn_label || (lang === 'zh' ? 'EN' : '中文');
    $('#tokensaving_lang_text').text(btnLabel);

    // 刷新动态文本
    const settings = extension_settings[EXT_NAME];
    if (settings) updatePresetCurrentLabel(settings);
}

function updatePresetCurrentLabel(settings) {
    if (settings.activePreset && settings.activePreset !== 'custom') {
        const preset = PRESETS[settings.activePreset];
        if (preset) {
            $('#tokensaving_preset_current').text(t('status_preset_current', {
                label: preset.label,
                n: preset.n, m: preset.m,
                summary: preset.maxSummaryTokens, fcc: preset.fccBudget,
            }));
            return;
        }
    }
    $('#tokensaving_preset_current').text(t('status_preset_current_custom'));
}

// ==================== 预设表 ====================
const PRESETS = {
    '4096_auto':    { n: 2, m: 8,  maxSummaryTokens: 180, fccBudget: 300, label: '4096 Auto' },
    '4096_eco':     { n: 2, m: 12, maxSummaryTokens: 180, fccBudget: 300, label: '4096 Eco' },
    '4096_fast':    { n: 2, m: 5,  maxSummaryTokens: 150, fccBudget: 250, label: '4096 Fast' },
    '4096_quality': { n: 3, m: 10, maxSummaryTokens: 250, fccBudget: 400, label: '4096 Quality' },
    '8192_auto':    { n: 2, m: 28, maxSummaryTokens: 200, fccBudget: 300, label: '8192 Auto' },
    '8192_eco':     { n: 2, m: 32, maxSummaryTokens: 200, fccBudget: 300, label: '8192 Eco' },
    '8192_fast':    { n: 2, m: 16, maxSummaryTokens: 180, fccBudget: 250, label: '8192 Fast' },
    '8192_quality': { n: 3, m: 30, maxSummaryTokens: 280, fccBudget: 500, label: '8192 Quality' },
    '16384_auto':    { n: 3, m: 30, maxSummaryTokens: 250, fccBudget: 400, label: '16k Auto' },
    '16384_eco':     { n: 3, m: 40, maxSummaryTokens: 250, fccBudget: 400, label: '16k Eco' },
    '16384_fast':    { n: 2, m: 20, maxSummaryTokens: 200, fccBudget: 300, label: '16k Fast' },
    '16384_quality': { n: 3, m: 36, maxSummaryTokens: 300, fccBudget: 600, label: '16k Quality' },
    '32768_auto':    { n: 3, m: 40, maxSummaryTokens: 300, fccBudget: 600, label: '32k Auto' },
    '32768_eco':     { n: 3, m: 50, maxSummaryTokens: 300, fccBudget: 600, label: '32k Eco' },
    '32768_fast':    { n: 3, m: 30, maxSummaryTokens: 250, fccBudget: 400, label: '32k Fast' },
    '32768_quality': { n: 4, m: 48, maxSummaryTokens: 350, fccBudget: 800, label: '32k Quality' },
};

// ==================== 默认设置 ====================
const defaultSettings = {
    enabled: true,
    thresholdPercent: 80,
    n: 2,
    m: 8,
    selfCheck: true,
    maxSummaryTokens: 180,
    fccBudget: 300,
    activePreset: '4096_auto',
    lang: 'zh',
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
    if (!settings.activePreset) settings.activePreset = 'custom';
    if (!settings.lang) settings.lang = 'zh';

    try {
        const settingsHtml = await $.get(`scripts/extensions/third-party/TokenSavingPlugin/settings.html`);
        $('#extensions_settings').append(settingsHtml);
    } catch (err) {
        console.error('TokenSaving: 无法加载 settings.html', err);
        return;
    }

    applyLanguageToUI();
    bindUIEvents(settings);

    const ctx = SillyTavern.getContext();

    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
        currentFCC = loadFCC();
        if (currentFCC && settings.enabled) {
            injectFCC(currentFCC);
            restoreHiddenMessages();
        }
        updateUIState(settings);
    });

    ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, () => {
        triggerCompression(settings, 'ai_replied');
    });

    ctx.eventSource.on(ctx.eventTypes.GENERATION_AFTER_COMMANDS, (type, _, dryRun) => {
        if (type === 'quiet' || dryRun) return;
        triggerCompression(settings, 'after_cmd');
    });

    pollTimer = setInterval(() => {
        if (settings.enabled && compressionState === 'idle') {
            triggerCompression(settings, 'poll');
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

    console.log('TokenSaving: 初始化完成, lang =', settings.lang);
}

// ==================== 上下文检测 ====================
function detectContextTier() {
    let ctxSize = 4096;
    try {
        if (typeof getMaxPromptTokens === 'function') {
            ctxSize = getMaxPromptTokens() || 4096;
        }
    } catch { /* ignore */ }

    if (ctxSize <= 5120) return { tier: 4096, size: ctxSize };
    if (ctxSize <= 12288) return { tier: 8192, size: ctxSize };
    if (ctxSize <= 24576) return { tier: 16384, size: ctxSize };
    return { tier: 32768, size: ctxSize };
}

function getPresetKeyFromUI(presetType) {
    const { tier } = detectContextTier();
    return `${tier}_${presetType}`;
}

function applyPreset(settings, presetKey) {
    const preset = PRESETS[presetKey];
    if (!preset) return;

    settings.n = preset.n;
    settings.m = preset.m;
    settings.maxSummaryTokens = preset.maxSummaryTokens;
    settings.fccBudget = preset.fccBudget;
    settings.activePreset = presetKey;
    saveSettingsDebounced();

    updateUIState(settings);
    try { toastr.success(t('toast_preset_applied', { label: preset.label }), 'TokenSaving'); } catch (e) {}
    console.log('TokenSaving: 应用预设', presetKey, preset);
}

// ==================== 触发入口 ====================
function triggerCompression(settings, reason) {
    if (!settings.enabled) return;
    if (compressionState !== 'idle') return;
    runCompression(settings, reason).catch(err => {
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
        settings.activePreset = 'custom';
        updatePresetCurrentLabel(settings);
        $('.ts-preset-btn').removeClass('is-active');
        saveSettingsDebounced();
    };

    $('#tokensaving_threshold').on('input', function () {
        settings.thresholdPercent = parseInt($(this).val()) || 80;
        markCustom(); updateMetrics(settings);
    });
    $('#tokensaving_n').on('input', function () {
        settings.n = parseInt($(this).val()) || 2;
        markCustom(); updateMetrics(settings);
    });
    $('#tokensaving_m').on('input', function () {
        settings.m = parseInt($(this).val()) || 8;
        markCustom(); updateMetrics(settings);
    });
    $('#tokensaving_max_summary_tokens').on('input', function () {
        settings.maxSummaryTokens = parseInt($(this).val()) || 180;
        markCustom();
    });
    $('#tokensaving_fcc_budget').on('input', function () {
        settings.fccBudget = parseInt($(this).val()) || 300;
        markCustom();
    });
    $('#tokensaving_selfcheck').on('change', function () {
        settings.selfCheck = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    // 语言切换按钮
    $('#tokensaving_lang_btn').on('click', function () {
        settings.lang = (settings.lang === 'en') ? 'zh' : 'en';
        saveSettingsDebounced();
        applyLanguageToUI();
        updateUIState(settings);
        try { toastr.info(`Language: ${settings.lang === 'en' ? 'English' : '中文'}`, 'TokenSaving'); } catch (e) {}
    });

    $('.ts-preset-btn').on('click', function () {
        const type = $(this).attr('data-preset');
        const key = getPresetKeyFromUI(type);
        applyPreset(settings, key);
    });

    $('#tokensaving_manual_btn').on('click', () => {
        if (compressionState !== 'idle') {
            try { toastr.info(t('toast_already_running'), 'TokenSaving'); } catch (e) {}
            return;
        }
        triggerCompression(settings, 'manual');
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
    const n = Math.max(1, settings.n);
    const m = Math.max(1, settings.m);

    const overWindow = totalRounds > n + m;
    const overThreshold = usagePercent >= settings.thresholdPercent;

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

    await hideChatMessageRange(startIdx, endIdx, false);

    const apiCounter = { count: 0 };
    const bumpApi = () => {
        if (abortRequested) throw new Error(getLang() === 'en' ? 'Aborted by user' : '用户已中止压缩');
        apiCounter.count++;
        if (apiCounter.count > MAX_API_CALLS) {
            throw new Error(`API calls exceed limit (${MAX_API_CALLS})`);
        }
    };
    const checkAbort = () => {
        if (abortRequested) throw new Error(getLang() === 'en' ? 'Aborted by user' : '用户已中止压缩');
    };

    try {
        const charData = getCurrentCharacterData();
        const refContext = getReferenceContext(charData);

        updateStatus(`状态: ${t('status_compressing', { count: toCompress.length })}`);
        const summary = await compressToSummary(compressText, refContext, settings, apiCounter, bumpApi, checkAbort);

        checkAbort();
        if (!summary || !summary.trim()) {
            throw new Error(getLang() === 'en' ? 'AI returned empty summary' : 'AI 未返回有效的压缩结果');
        }

        let selfCheckWarning = '';
        if (settings.selfCheck) {
            updateStatus(`状态: ${t('status_selfcheck', { current: apiCounter.count, max: MAX_API_CALLS })}`);
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

        if (estimateTokens(newFCCRaw) > settings.fccBudget) {
            updateStatus(`状态: ${t('status_folding', { current: apiCounter.count, max: MAX_API_CALLS })}`);
            const folded = await foldFCC(currentFCC.content.raw, summary, settings, refContext, bumpApi, checkAbort);
            newFCCRaw = folded || `${historyTag} ${summary}`;
        }

        if (estimateTokens(newFCCRaw) > settings.fccBudget) {
            newFCCRaw = truncateToTokens(newFCCRaw, settings.fccBudget);
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
        compressionState = 'idle';
        abortRequested = false;
        $('#tokensaving_stop_btn').hide();
        unlockInput();
    }
}

// ==================== 压缩：分块 + JSON 指令 ====================
async function compressToSummary(text, refContext, settings, apiCounter, bumpApi, checkAbort) {
    const ctx = SillyTavern.getContext();
    const BLOCK_TOKENS = 800;
    const blocks = splitIntoTokenBlocks(text, BLOCK_TOKENS);
    const summaries = [];
    const lang = getLang();

    const maxSummaryTokens = settings.maxSummaryTokens || 180;
    // 中文以 1.5 字符/字 估算；英文以 4 字符/字 估算
    const maxChars = lang === 'en' ? Math.floor(maxSummaryTokens * 4) : Math.floor(maxSummaryTokens * 1.5);
    const responseLength = Math.max(maxSummaryTokens * 4, 600);

    for (let i = 0; i < blocks.length; i++) {
        checkAbort();
        const blockText = blocks[i];
        const blockNote = blocks.length > 1
            ? '\n' + t('prompt_block_note', { i: i + 1, n: blocks.length })
            : '';

        const prompt = t('prompt_compress', {
            block_note: blockNote,
            ref_context: String(refContext || (lang === 'en' ? 'None' : '无')).substring(0, 500),
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
            if (abortRequested) throw err;
            console.warn(`TokenSaving: block ${i + 1} failed, skipping`, err.message || err);
            continue;
        }

        const parsed = parseSummaryJson(result || '');

        if (parsed.events) {
            const tagEvents = lang === 'en' ? '[Events]' : '[事件]';
            const tagRel = lang === 'en' ? '[Relationship]' : '[关系]';
            const tagEmo = lang === 'en' ? '[Emotion]' : '[情感]';
            const noChange = lang === 'en' ? 'no change' : '无变化';
            const stable = lang === 'en' ? 'stable' : '平稳';

            let summaryText = `${tagEvents} ${parsed.events} ${tagRel} ${parsed.relationship || noChange} ${tagEmo} ${parsed.emotion || stable}`;
            if (estimateTokens(summaryText) > maxSummaryTokens) {
                summaryText = truncateToTokens(summaryText, maxSummaryTokens);
            }
            summaries.push(summaryText);
        }
    }

    return summaries.join('\n');
}

function parseSummaryJson(text) {
    const result = { events: '', relationship: '', emotion: '' };
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

    if (!result.events && cleaned.length > 0 && cleaned.length < 800) {
        result.events = cleaned.replace(/^[\[{]+|[\]}]+$/g, '').trim().substring(0, 200);
    }
    return result;
}

// ==================== Feynman 自检（警告不阻断） ====================
async function feynmanSelfCheck(summary, originalText, refContext, bumpApi, checkAbort) {
    try {
        checkAbort();
        const ctx = SillyTavern.getContext();
        const lang = getLang();

        const prompt = t('prompt_selfcheck', {
            ref_context: String(refContext || (lang === 'en' ? 'None' : '无')).substring(0, 400),
            original: originalText.substring(0, 800),
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
        console.warn('TokenSaving: 自检失败，默认通过', err.message || err);
        return { passed: true, gaps: '' };
    }
}

// ==================== FCC 折叠 ====================
async function foldFCC(oldFCC, newSummary, settings, refContext, bumpApi, checkAbort) {
    try {
        checkAbort();
        const ctx = SillyTavern.getContext();
        const lang = getLang();
        const budget = settings.fccBudget || 300;
        const maxChars = lang === 'en' ? Math.floor(budget * 4) : Math.floor(budget * 1.5);

        const prompt = t('prompt_fold', {
            ref_context: String(refContext || (lang === 'en' ? 'None' : '无')).substring(0, 300),
            old_fcc: oldFCC,
            new_summary: newSummary,
            max_chars: maxChars,
        });

        bumpApi();
        const result = await withTimeout(
            ctx.generateQuietPrompt({ quietPrompt: prompt, responseLength: Math.max(budget * 3, 600) }),
            90000,
            'fold',
        );
        let folded = (result || '').trim();
        if (!folded) return null;

        if (estimateTokens(folded) > budget) {
            folded = truncateToTokens(folded, budget);
        }
        return folded;
    } catch (err) {
        if (abortRequested) throw err;
        console.warn('TokenSaving: FCC 折叠失败', err.message || err);
        return null;
    }
}

// ==================== 清除 FCC ====================
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

// ==================== 参考上下文 ====================
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

// ==================== Token 工具 ====================
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

// ==================== FCC 存储 ====================
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

// ==================== FCC 注入 ====================
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

// ==================== 消息隐藏/恢复 ====================
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

// ==================== UI：状态更新 ====================
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
    // 去掉 "状态: " / "Status: " 前缀
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

// ==================== UI：指标 + 窗口可视化 ====================
function updateMetrics(settings) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const visibleMsgs = chat.filter(m => m.mes && !m.is_system);
        const rounds = Math.floor(visibleMsgs.length / 2);
        const n = Math.max(1, settings.n || 2);
        const m = Math.max(1, settings.m || 8);
        const windowMax = n + m;

        const $rounds = $('#tokensaving_rounds');
        if ($rounds.length) {
            $rounds.text(`${rounds} / ${windowMax}`);
            $rounds.css('color', rounds > windowMax ? 'var(--ts-danger, #ef4444)' : '');
        }

        const fullText = visibleMsgs.map(x => x.mes).join('\n');
        let maxTokens = 4096;
        try {
            if (typeof getMaxPromptTokens === 'function') maxTokens = getMaxPromptTokens() || 4096;
        } catch { /* ignore */ }

        const approxTokens = estimateTokens(fullText);
        const usagePercent = Math.min(100, (approxTokens / maxTokens) * 100);

        $('#tokensaving_ctx').text(`${usagePercent.toFixed(0)}%`);

        const $bar = $('#tokensaving_progress_bar');
        $bar.css('width', `${usagePercent}%`);
        $bar.removeClass('is-warn is-error');
        if (usagePercent >= (settings.thresholdPercent || 80)) $bar.addClass('is-error');
        else if (usagePercent >= (settings.thresholdPercent || 80) - 20) $bar.addClass('is-warn');

        const fccTok = currentFCC?.content?.raw ? estimateTokens(currentFCC.content.raw) : 0;
        $('#tokensaving_fcctok').text(`${fccTok} tok`);

        const { size } = detectContextTier();
        $('#tokensaving_detected_ctx').text(`${size} tok`);

        renderWindowVisual(n, m, rounds);
    } catch (err) {
        console.warn('TokenSaving: updateMetrics 失败', err);
    }
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

// ==================== UI：整体状态 ====================
function updateUIState(settings) {
    $('#tokensaving_enabled').prop('checked', settings.enabled);
    $('#tokensaving_threshold').val(settings.thresholdPercent);
    $('#tokensaving_n').val(settings.n);
    $('#tokensaving_m').val(settings.m);
    $('#tokensaving_max_summary_tokens').val(settings.maxSummaryTokens);
    $('#tokensaving_fcc_budget').val(settings.fccBudget);
    $('#tokensaving_selfcheck').prop('checked', settings.selfCheck);

    $('.ts-preset-btn').removeClass('is-active');
    if (settings.activePreset && settings.activePreset !== 'custom') {
        const preset = PRESETS[settings.activePreset];
        if (preset) {
            const parts = settings.activePreset.split('_');
            const type = parts[parts.length - 1];
            $(`.ts-preset-btn[data-preset="${type}"]`).addClass('is-active');
        }
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
