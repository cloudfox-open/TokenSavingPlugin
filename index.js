/**
 * TokenSavingPlugin v1.4 - 缓存命中优化
 *
 * v1.4 新增：
 *   - 智能预设：按上下文长度自动推荐 n/m/摘要/FCC 预算（基于实测成本数据）
 *   - 默认值更新为 4096 上下文甜点配置：n=2, m=8, 摘要=180, FCC=300
 *
 * 实测数据参考（DeepSeek）：
 *   4096 / m=3   → 0.00107 元/次
 *   4096 / m=12  → 0.00085 元/次
 *   8192 / m=28  → 0.00048 元/次（甜点）
 *   8192 / m=60  → 0.00055 元/次（过大反而贵）
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getMaxPromptTokens, printMessages } from '../../../../script.js';
import { hideChatMessageRange } from '../../../chats.js';

const EXT_NAME = 'tokensaving';
const EXT_KEY = 'tokensaving_fcc';
const MAX_API_CALLS = 5;
const POLL_INTERVAL = 30000;

// ==================== 预设表（基于实测成本数据）====================
// m 值取 context * 0.32% 附近（8192 * 0.34 ≈ 28 是甜点）
const PRESETS = {
    // 4096 场景
    '4096_auto':    { n: 2, m: 8,  maxSummaryTokens: 180, fccBudget: 300, label: '4096 自动' },
    '4096_eco':     { n: 2, m: 12, maxSummaryTokens: 180, fccBudget: 300, label: '4096 省成本' },
    '4096_fast':    { n: 2, m: 5,  maxSummaryTokens: 150, fccBudget: 250, label: '4096 省内存' },
    '4096_quality': { n: 3, m: 10, maxSummaryTokens: 250, fccBudget: 400, label: '4096 高质量' },
    // 8192 场景
    '8192_auto':    { n: 2, m: 28, maxSummaryTokens: 200, fccBudget: 300, label: '8192 自动' },
    '8192_eco':     { n: 2, m: 32, maxSummaryTokens: 200, fccBudget: 300, label: '8192 省成本' },
    '8192_fast':    { n: 2, m: 16, maxSummaryTokens: 180, fccBudget: 250, label: '8192 省内存' },
    '8192_quality': { n: 3, m: 30, maxSummaryTokens: 280, fccBudget: 500, label: '8192 高质量' },
    // 16384 场景
    '16384_auto':    { n: 3, m: 30, maxSummaryTokens: 250, fccBudget: 400, label: '16k 自动' },
    '16384_eco':     { n: 3, m: 40, maxSummaryTokens: 250, fccBudget: 400, label: '16k 省成本' },
    '16384_fast':    { n: 2, m: 20, maxSummaryTokens: 200, fccBudget: 300, label: '16k 省内存' },
    '16384_quality': { n: 3, m: 36, maxSummaryTokens: 300, fccBudget: 600, label: '16k 高质量' },
    // 32k+ 场景
    '32768_auto':    { n: 3, m: 40, maxSummaryTokens: 300, fccBudget: 600, label: '32k 自动' },
    '32768_eco':     { n: 3, m: 50, maxSummaryTokens: 300, fccBudget: 600, label: '32k 省成本' },
    '32768_fast':    { n: 3, m: 30, maxSummaryTokens: 250, fccBudget: 400, label: '32k 省内存' },
    '32768_quality': { n: 4, m: 48, maxSummaryTokens: 350, fccBudget: 800, label: '32k 高质量' },
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

    // 兼容旧配置：如果用户之前没有 activePreset，标记为自定义
    if (!settings.activePreset) settings.activePreset = 'custom';

    try {
        const settingsHtml = await $.get(`scripts/extensions/third-party/TokenSavingPlugin/settings.html`);
        $('#extensions_settings').append(settingsHtml);
    } catch (err) {
        console.error('TokenSaving: 无法加载 settings.html', err);
        return;
    }

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

    ctx.eventSource.on(ctx.eventTypes.MESSAGE_SENDING, (data) => {
        if (compressionState !== 'idle') {
            try { toastr.warning('压缩进行中，请稍候再发送', 'TokenSaving'); } catch (e) {}
            return false;
        }
        return true;
    });

    $(document).on('click.tokensaving', '#send_but', function (e) {
        if (compressionState !== 'idle') {
            e.preventDefault();
            e.stopImmediatePropagation();
            try { toastr.warning('压缩进行中，请稍候再发送', 'TokenSaving'); } catch (err) {}
            return false;
        }
    });

    currentFCC = loadFCC();
    if (currentFCC && settings.enabled) injectFCC(currentFCC);
    updateUIState(settings);

    console.log('TokenSaving: 初始化完成');
}

// ==================== 上下文检测 + 预设应用 ====================
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
    if (!preset) {
        // 兜底：按 presetType 重新检测
        return;
    }

    settings.n = preset.n;
    settings.m = preset.m;
    settings.maxSummaryTokens = preset.maxSummaryTokens;
    settings.fccBudget = preset.fccBudget;
    settings.activePreset = presetKey;
    saveSettingsDebounced();

    updateUIState(settings);

    try {
        toastr.success(`已应用「${preset.label}」预设：n=${preset.n}, m=${preset.m}, 摘要=${preset.maxSummaryTokens}, FCC=${preset.fccBudget}`, 'TokenSaving');
    } catch (e) {}
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

    // 数值输入 → 标记为"自定义"
    const markCustom = () => {
        settings.activePreset = 'custom';
        $('#tokensaving_preset_current').text('当前：自定义配置');
        $('.ts-preset-btn').removeClass('is-active');
        saveSettingsDebounced();
    };

    $('#tokensaving_threshold').on('input', function () {
        settings.thresholdPercent = parseInt($(this).val()) || 80;
        markCustom();
        updateMetrics(settings);
    });

    $('#tokensaving_n').on('input', function () {
        settings.n = parseInt($(this).val()) || 2;
        markCustom();
        updateMetrics(settings);
    });

    $('#tokensaving_m').on('input', function () {
        settings.m = parseInt($(this).val()) || 8;
        markCustom();
        updateMetrics(settings);
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

    // 预设按钮
    $('.ts-preset-btn').on('click', function () {
        const type = $(this).attr('data-preset');
        const key = getPresetKeyFromUI(type);
        applyPreset(settings, key);
    });

    $('#tokensaving_manual_btn').on('click', () => {
        if (compressionState !== 'idle') {
            try { toastr.info('已有压缩任务正在运行', 'TokenSaving'); } catch (e) {}
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
    updateStatus('状态: ⏹ 正在中止，等待当前步骤完成...');
    try { toastr.info('已请求中止，等待当前步骤完成...', 'TokenSaving'); } catch (e) {}
}

// ==================== 输入锁定/解锁 ====================
function lockInput(reason) {
    if (inputWasLocked) return;
    try {
        $('#send_textarea').prop('disabled', true).attr('placeholder', reason || 'TokenSaving 处理中...');
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
        updateStatus(`状态: 🌱 生长阶段（${totalRounds}/${n + m} 轮, ${usagePercent.toFixed(1)}%）`);
        updateMetrics(settings);
        return;
    }

    if (totalRounds <= n) {
        if (manual) updateStatus(`状态: 消息太少（${totalRounds} 轮 ≤ n=${n}）`);
        updateMetrics(settings);
        return;
    }

    compressionState = 'running';
    abortRequested = false;
    lockInput('TokenSaving 压缩中，请稍候...');
    $('#tokensaving_stop_btn').show();

    if (overWindow) {
        updateStatus(`状态: 🗜️ 窗口溢出（${totalRounds}/${n + m} 轮），压缩中...`);
    } else if (manual) {
        updateStatus(`状态: ⚡ 手动压缩中...`);
    } else {
        updateStatus(`状态: 🚨 Token 达阈值（${usagePercent.toFixed(1)}%），压缩中...`);
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
        .map(mx => `${mx.is_user ? '用户' : (mx.name || '角色')}: ${mx.mes.trim()}`)
        .join('\n');

    const startIdx = chat.indexOf(toCompress[0]);
    const endIdx = chat.indexOf(toCompress[toCompress.length - 1]);

    await hideChatMessageRange(startIdx, endIdx, false);

    const apiCounter = { count: 0 };
    const bumpApi = () => {
        if (abortRequested) throw new Error('用户已中止压缩');
        apiCounter.count++;
        if (apiCounter.count > MAX_API_CALLS) {
            throw new Error(`API 调用次数超过上限（${MAX_API_CALLS}次），中止`);
        }
    };
    const checkAbort = () => {
        if (abortRequested) throw new Error('用户已中止压缩');
    };

    try {
        const charData = getCurrentCharacterData();
        const refContext = getReferenceContext(charData);

        updateStatus(`状态: AI 压缩 ${toCompress.length} 条旧消息...`);
        const summary = await compressToSummary(compressText, refContext, settings, apiCounter, bumpApi, checkAbort);

        checkAbort();

        if (!summary || !summary.trim()) {
            throw new Error('AI 未返回有效的压缩结果');
        }

        if (settings.selfCheck) {
            updateStatus(`状态: 质量自检中... (API ${apiCounter.count}/${MAX_API_CALLS})`);
            const checkResult = await feynmanSelfCheck(summary, compressText, refContext, bumpApi, checkAbort);
            if (!checkResult.passed) {
                throw new Error(`自检发现遗漏: ${checkResult.gaps || '未知'}`);
            }
        }

        checkAbort();

        if (!currentFCC) {
            currentFCC = { content: { raw: '' }, hidden_message_indices: [] };
        }
        if (!currentFCC.hidden_message_indices) currentFCC.hidden_message_indices = [];

        let newFCCRaw = currentFCC.content.raw
            ? currentFCC.content.raw + `\n[历史摘要] ${summary}`
            : `[历史摘要] ${summary}`;

        if (estimateTokens(newFCCRaw) > settings.fccBudget) {
            updateStatus(`状态: FCC 超出预算，折叠重组中... (API ${apiCounter.count}/${MAX_API_CALLS})`);
            const folded = await foldFCC(currentFCC.content.raw, summary, settings, refContext, bumpApi, checkAbort);
            newFCCRaw = folded || `[历史摘要] ${summary}`;
        }

        if (estimateTokens(newFCCRaw) > settings.fccBudget) {
            newFCCRaw = truncateToTokens(newFCCRaw, settings.fccBudget);
        }

        currentFCC.content.raw = newFCCRaw;

        await hideMessages(chat, startIdx, endIdx, currentFCC);
        saveFCC(currentFCC);
        injectFCC(currentFCC);

        const newVisibleCount = Math.floor((visibleMsgs.length - toCompress.length) / 2);
        updateStatus(`状态: ✅ 压缩完成，保留最近 ${newVisibleCount} 轮原文 (API ${apiCounter.count}次)`);
        updateUIState(settings);
        try { toastr.success(`压缩完成，保留最近 ${newVisibleCount} 轮原文`, 'TokenSaving'); } catch (e) {}
        console.log('TokenSaving: 压缩完成', {
            compressed: toCompress.length,
            retainedRounds: newVisibleCount,
            fccTokens: estimateTokens(newFCCRaw),
            apiCalls: apiCounter.count,
        });
    } catch (err) {
        const isAbort = abortRequested || /中止/.test(err.message || '');
        console.warn('TokenSaving: 压缩失败/中止，回退', err);
        try {
            await hideChatMessageRange(startIdx, endIdx, true);
        } catch (e) { /* ignore */ }

        if (isAbort) {
            updateStatus(`状态: ⏹ 已中止，原文已恢复`);
            try { toastr.info('压缩已中止，原文已恢复', 'TokenSaving'); } catch (e) {}
        } else {
            updateStatus(`状态: ❌ 压缩失败，已回退 (${err.message})`);
            try { toastr.error(`压缩失败: ${err.message}`, 'TokenSaving'); } catch (e) {}
        }
        updateUIState(settings);
    } finally {
        compressionState = 'idle';
        abortRequested = false;
        $('#tokensaving_stop_btn').hide();
        unlockInput();
    }
}

// ==================== 压缩：分块 + JSON Schema ====================
async function compressToSummary(text, refContext, settings, apiCounter, bumpApi, checkAbort) {
    const ctx = SillyTavern.getContext();
    const BLOCK_TOKENS = 800;
    const blocks = splitIntoTokenBlocks(text, BLOCK_TOKENS);
    const summaries = [];

    const maxSummaryTokens = settings.maxSummaryTokens || 180;
    const maxChars = Math.floor(maxSummaryTokens * 1.5);
    const responseLength = Math.max(maxSummaryTokens * 4, 600);

    const jsonSchema = {
        name: 'history_summary',
        strict: true,
        schema: {
            type: 'object',
            properties: {
                events: { type: 'string', description: '关键事件，用→连接' },
                relationship: { type: 'string', description: '关系变化' },
                emotion: { type: 'string', description: '情感轨迹' },
            },
            required: ['events', 'relationship', 'emotion'],
            additionalProperties: false,
        },
    };

    for (let i = 0; i < blocks.length; i++) {
        checkAbort();
        const blockText = blocks[i];
        const blockNote = blocks.length > 1
            ? `\n⚠️ 这是第 ${i + 1}/${blocks.length} 块，只压缩本块。`
            : '';

        const prompt = `你是信息压缩引擎，不是故事作者。从聊天记录中提取关键信息，按指定 JSON 格式输出。
${blockNote}
## 禁止
- 禁止续写/推测/编造/复制原文
- 禁止输出 JSON 之外的任何内容

## 角色参考（辅助理解）
${String(refContext || '无').substring(0, 500)}

## 待压缩聊天记录（第 ${i + 1}/${blocks.length} 块）
${blockText}

## ⚠️ 严格限制
1. 只从原文提取信息。
2. **总字数必须控制在 ${maxChars} 个汉字以内！超长将被截断。**
3. 省略寒暄和日常互动，只保留：改变关系的事件、承诺/约定、情感转折点。

## 输出格式（JSON）
{
  "events": "关键事件1→事件2→事件3",
  "relationship": "关系变化描述",
  "emotion": "情感轨迹变化"
}`;

        let result;
        try {
            bumpApi();
            result = await withTimeout(
                ctx.generateQuietPrompt({ quietPrompt: prompt, responseLength, jsonSchema }),
                90000,
                `压缩分块 ${i + 1}/${blocks.length}`,
            );
        } catch (err) {
            if (abortRequested) throw err;
            console.warn(`TokenSaving: 分块 ${i + 1} jsonSchema 失败，降级重试`, err.message || err);
            try {
                bumpApi();
                result = await withTimeout(
                    ctx.generateQuietPrompt({ quietPrompt: prompt, responseLength }),
                    90000,
                    `压缩分块 ${i + 1}/${blocks.length}(降级)`,
                );
            } catch (err2) {
                if (abortRequested) throw err2;
                console.warn(`TokenSaving: 分块 ${i + 1} 降级也失败，跳过`, err2.message || err2);
                continue;
            }
        }

        const parsed = parseSummaryJson(result || '');

        if (parsed.events) {
            let summaryText = `[事件] ${parsed.events} [关系] ${parsed.relationship || '无变化'} [情感] ${parsed.emotion || '平稳'}`;
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

    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        const jsonStr = raw.slice(firstBrace, lastBrace + 1)
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
        const match = raw.match(re);
        return match ? match[1].replace(/\\n/g, ' ').trim() : '';
    };
    result.events = grab('events');
    result.relationship = grab('relationship');
    result.emotion = grab('emotion');

    if (!result.events && raw.length > 0 && raw.length < 800) {
        result.events = raw.replace(/^[\[{]+|[\]}]+$/g, '').trim().substring(0, 200);
    }
    return result;
}

// ==================== Feynman 自检 ====================
async function feynmanSelfCheck(summary, originalText, refContext, bumpApi, checkAbort) {
    try {
        checkAbort();
        const ctx = SillyTavern.getContext();
        const prompt = `你是质量检查员。对比原文和压缩摘要，检查是否遗漏了对后续剧情有影响的关键信息（如承诺、约定、新设定、关键转折）。

## 参考设定
${String(refContext || '无').substring(0, 400)}

## 聊天原文（截取）
${originalText.substring(0, 800)}

## 压缩摘要
${summary}

如果没有关键信息遗漏，请严格回复 "PASS"。
如果有遗漏，请严格以 "FAIL: " 开头，后接遗漏的具体内容（一句话）。`;

        bumpApi();
        const result = await withTimeout(
            ctx.generateQuietPrompt({ quietPrompt: prompt, responseLength: 200 }),
            60000,
            '自检请求',
        );
        const checkText = (result || '').trim();

        if (!checkText) return { passed: true, gaps: '' };
        if (checkText.startsWith('PASS') || checkText.includes('无遗漏') || checkText.includes('没有遗漏')) {
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
        const budget = settings.fccBudget || 300;
        const prompt = `你是历史记录合并引擎。请将【已有摘要】和【新增摘要】合并为一段更精简的摘要。
禁止编造，只融合已有信息。

## 角色参考
${String(refContext || '无').substring(0, 300)}

## 已有摘要
${oldFCC}

## 新增摘要
[历史摘要] ${newSummary}

## 输出要求
1. 直接输出合并后的精简摘要，无前缀。
2. 总长度必须控制在 ${Math.floor(budget * 1.5)} 个汉字以内。
3. 保持 [事件]/[关系]/[情感] 的结构。`;

        bumpApi();
        const result = await withTimeout(
            ctx.generateQuietPrompt({ quietPrompt: prompt, responseLength: Math.max(budget * 3, 600) }),
            90000,
            '折叠请求',
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
        try { toastr.info('FCC 已清除，所有被压缩的消息已恢复', 'TokenSaving'); } catch (e) {}
    } catch (err) {
        console.error('TokenSaving: 清除失败', err);
        try { toastr.error('清除失败: ' + err.message, 'TokenSaving'); } catch (e) {}
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
    const data = charData.data;
    const parts = [];
    if (data.description?.trim()) parts.push(`【描述】${data.description.trim().substring(0, 300)}`);
    if (data.personality?.trim()) parts.push(`【性格】${data.personality.trim().substring(0, 200)}`);
    if (data.scenario?.trim()) parts.push(`【场景】${data.scenario.trim().substring(0, 200)}`);
    return parts.join('\n');
}

// ==================== Token 工具 ====================
async function countTokens(text) {
    try {
        const ctx = SillyTavern.getContext();
        return await withTimeout(ctx.getTokenCountAsync(text), 10000, 'Token 计数');
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
                timer = setTimeout(
                    () => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s）`)),
                    ms,
                );
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
    if (!key) {
        console.warn('TokenSaving: 无法保存，角色标识缺失');
        return;
    }
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
        if (s.includes('✅') || s.includes('完成')) return 'success';
        if (s.includes('❌') || s.includes('失败') || s.includes('⏹')) return 'error';
        if (s.includes('🗜️') || s.includes('🚨') || s.includes('压缩') || s.includes('自检') || s.includes('AI 压缩')) return 'busy';
        if (s.includes('🌱')) return 'growing';
        return 'idle';
    };

    const s = inferState(text);
    const clean = String(text || '').replace(/^状态[:：]\s*/, '');

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

        // 检测上下文并更新 badge
        const { tier, size } = detectContextTier();
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
    // 窗口太大时不要渲染所有格子（超过 40 个就只显示前 12 + 后 8）
    const MAX_CELLS = 40;
    let html = '';

    if (total <= MAX_CELLS) {
        for (let i = 1; i <= total; i++) {
            html += renderCell(i, n, rounds);
        }
    } else {
        // 前缀 + 省略 + 后缀
        const headCount = 12;
        for (let i = 1; i <= headCount; i++) html += renderCell(i, n, rounds);
        html += `<div class="ts-cell" style="width:auto;padding:0 6px;opacity:0.5">⋯</div>`;
        const tailStart = Math.max(headCount + 1, total - 8);
        for (let i = tailStart; i <= total; i++) html += renderCell(i, n, rounds);
    }

    if (rounds > total) {
        html += `<div class="ts-cell ts-cell-overflow" title="已溢出 ${rounds - total} 轮">+${rounds - total}</div>`;
    }

    $vis.html(html);
    $('#tokensaving_window_badge').text(`n=${n} · m=${m}`);
}

function renderCell(i, n, rounds) {
    const isRetain = i <= n;
    const filled = i <= rounds;
    const isCurrent = i === rounds;

    const classes = ['ts-cell'];
    classes.push(isRetain ? 'ts-cell-retain' : 'ts-cell-compress');
    if (filled) classes.push('ts-cell-filled');
    if (isCurrent) classes.push('ts-cell-current');

    return `<div class="${classes.join(' ')}" title="第 ${i} 轮${isRetain ? '（保留区）' : '（压缩区）'}">${i}</div>`;
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

    // 高亮当前预设按钮
    $('.ts-preset-btn').removeClass('is-active');
    if (settings.activePreset && settings.activePreset !== 'custom') {
        const preset = PRESETS[settings.activePreset];
        if (preset) {
            // 找到对应按钮（把 key 拆成 tier_type）
            const parts = settings.activePreset.split('_');
            const type = parts[parts.length - 1];
            $(`.ts-preset-btn[data-preset="${type}"]`).addClass('is-active');
            $('#tokensaving_preset_current').text(`当前：${preset.label}（n=${preset.n}, m=${preset.m}, 摘要=${preset.maxSummaryTokens}, FCC=${preset.fccBudget}）`);
        }
    } else {
        $('#tokensaving_preset_current').text('当前：自定义配置');
    }

    if (currentFCC?.content?.raw) {
        const $panel = $('#tokensaving_fcc_panel');
        $panel.show();
        $('#tokensaving_fcc_content').text(currentFCC.content.raw);
        const tok = estimateTokens(currentFCC.content.raw);
        const hidden = currentFCC.hidden_message_indices?.length || 0;
        $('#tokensaving_fcc_meta').text(`${tok} tok · 覆盖 ${hidden} 条`);
    } else {
        $('#tokensaving_fcc_panel').hide();
    }

    updateMetrics(settings);
}
