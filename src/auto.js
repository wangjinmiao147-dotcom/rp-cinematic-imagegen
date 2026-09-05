// ============================================================
// RP 电影配图 - 自动检测模块
// ============================================================

import { extractJson, scrubSensitiveText } from './utils.js';
import { buildDirectorPrompt, buildDialogueContext } from './prompts.js';

// 记录各会话最后检测的消息下标（按会话隔离）
const lastDetectedIndexByChat = new Map();
// 记录各会话的正在检测状态（按会话隔离）
const autoDetectBusyByChat = new Map();

/**
 * 非正常新回复或易重复的消息类型黑名单
 */
export const DENIED_MESSAGE_TYPES = new Set([
    'first_message',
    'greeting',
    'swipe',
    'swiped',
    'continue',
    'append',
    'extension',
    'quiet',
    'command',
    'slash_command',
    'system',
    'placeholder',
    'impersonate',
    'edit',
    'regenerate',
]);

/**
 * 判定消息渲染类型是否允许触发自动检测
 * @param {string} [type] 
 * @returns {boolean}
 */
export function isAutoGeneratableMessageType(type) {
    if (!type || type === 'normal') return true;
    const lower = String(type).trim().toLowerCase();
    if (DENIED_MESSAGE_TYPES.has(lower)) {
        return false;
    }
    return true;
}

/**
 * 获取当前会话唯一键
 */
export function getChatSessionKey(context) {
    if (!context) return 'default_chat';
    const chatId = context.chatId || (typeof window !== 'undefined' && window.selected_chat) || '';
    const charId = context.characterId !== undefined ? context.characterId : 'default';
    return `${charId}_${chatId}`;
}

/**
 * 重置指定会话或全部会话的检测状态
 */
export function resetAutoDetectState(chatKey) {
    if (chatKey) {
        lastDetectedIndexByChat.delete(chatKey);
        autoDetectBusyByChat.delete(chatKey);
    } else {
        lastDetectedIndexByChat.clear();
        autoDetectBusyByChat.clear();
    }
}

/**
 * 判定是否满足自动检测触发条件
 */
export function shouldTriggerAutoDetect(messageIndex, message, settings, context, messageType) {
    const s = settings || {};
    if (!s.autoMode) return false;
    if (!message || message.is_user) return false;
    if (typeof messageIndex !== 'number' || messageIndex < 0) return false;

    // 过滤非正常回复与易重复事件类型（开场白/滑动/续写/指令等）
    if (!isAutoGeneratableMessageType(messageType)) {
        return false;
    }

    const chatKey = getChatSessionKey(context);
    if (autoDetectBusyByChat.get(chatKey)) {
        return false;
    }

    const lastIndex = lastDetectedIndexByChat.has(chatKey) ? lastDetectedIndexByChat.get(chatKey) : -999;
    const cooldown = Math.max(1, parseInt(s.autoCooldown, 10) || 3);

    if (messageIndex - lastIndex < cooldown) {
        return false;
    }
    return true;
}

/**
 * 执行自动检测与出图流程（带严格的异步跨会话失效检查）
 */
export async function executeAutoDetection({
    messageIndex,
    message,
    messageType,
    character,
    settings,
    getContextFn,
    callLLMFn,
    generateForMessageFn,
    continuityContext = '',
    onStatusChange,
    onNotify,
}) {
    const initialContext = typeof getContextFn === 'function' ? getContextFn() : null;
    if (!shouldTriggerAutoDetect(messageIndex, message, settings, initialContext, messageType)) {
        return;
    }

    const initialChat = initialContext?.chat;
    const initialSessionKey = getChatSessionKey(initialContext);
    const initialMessage = initialChat?.[messageIndex];
    const initialMes = initialMessage?.mes;
    const initialSwipeId = initialMessage?.swipe_id !== undefined ? initialMessage.swipe_id : null;

    const isContextStillValid = () => {
        const cur = typeof getContextFn === 'function' ? getContextFn() : null;
        if (!cur) return false;
        if (getChatSessionKey(cur) !== initialSessionKey) return false;
        if (cur.chat !== initialChat) return false;
        const curMsg = cur.chat?.[messageIndex];
        if (curMsg !== initialMessage) return false;
        if (curMsg?.mes !== initialMes) return false;
        if ((curMsg?.swipe_id !== undefined ? curMsg.swipe_id : null) !== initialSwipeId) return false;
        return true;
    };

    autoDetectBusyByChat.set(initialSessionKey, true);
    lastDetectedIndexByChat.set(initialSessionKey, messageIndex);

    try {
        const windowSize = Math.max(2, parseInt(settings.autoWindow, 10) || 12);
        const dialogueHistory = buildDialogueContext(initialChat, messageIndex, windowSize);

        const { system, userText } = buildDirectorPrompt({
            character,
            currentMessageText: initialMes || '',
            dialogueHistory,
            shotMode: settings.shotMode || 'snapshot',
            promptFormat: settings.promptFormat || 'auto',
            stylePreset: settings.stylePreset || 'character',
            customAnchors: settings.characterAnchors || {},
            continuityContext,
            hideHandsFeet: settings.hideHandsFeet !== false,
        });

        if (typeof onStatusChange === 'function') {
            onStatusChange('working', '🤖 正在分析对话剧情与场景事件…');
        }

        const rawLLM = await callLLMFn(system, userText, settings, getContextFn);

        // LLM 返回后立即验证会话是否发生切换
        if (!isContextStillValid()) {
            if (typeof onNotify === 'function') {
                onNotify('info', '会话已切换，已中止自动配图生成');
            }
            if (typeof onStatusChange === 'function') {
                onStatusChange('idle', '');
            }
            return;
        }

        const parsed = extractJson(rawLLM);

        if (!parsed) {
            if (typeof onStatusChange === 'function') {
                onStatusChange('idle', '');
            }
            return;
        }

        // 场景未切换：不调用图片后端，节省资源与费用
        if (parsed.scene_changed === false) {
            if (typeof onNotify === 'function') {
                onNotify('info', `🤖 [自动检测] 场景延续 (${parsed.reason || '无重大变动'})，暂不出图`);
            }
            if (typeof onStatusChange === 'function') {
                onStatusChange('done', '自动检测完成：场景平稳延续');
            }
            return;
        }

        // 场景发生变化：再次确认会话有效性后触发图片生成
        const prompt = (parsed.final_prompt || '').trim();
        const avoid = (parsed.avoid || '').trim();
        const sceneAnchor = (parsed.scene_anchor || '').trim();

        if (prompt && typeof generateForMessageFn === 'function') {
            if (!isContextStillValid()) {
                if (typeof onNotify === 'function') {
                    onNotify('info', '会话已切换，已中止自动配图生成');
                }
                return;
            }
            if (typeof onNotify === 'function') {
                onNotify('success', `🎬 [自动检测] 捕捉到新场景：${parsed.reason || '重要剧情事件'}，开始生成配图…`);
            }
            await generateForMessageFn(messageIndex, prompt, settings.shotMode, avoid, {
                sceneAnchor,
                sceneChanged: parsed.scene_changed === true,
            });
        }
    } catch (err) {
        const msg = scrubSensitiveText(err.message || String(err));
        console.error('[RP 电影配图] 自动检测异常:', msg);
        if (typeof onStatusChange === 'function') {
            onStatusChange('error', `自动检测失败: ${msg}`);
        }
    } finally {
        autoDetectBusyByChat.delete(initialSessionKey);
    }
}
