import { getChatSessionKey } from './auto.js';
import { storyFingerprint } from './scene-state.js';

export function captureChatSource(context) {
    return { chat: context?.chat, sessionKey: getChatSessionKey(context), groupId: context?.groupId };
}

export function isChatSourceCurrent(source, context) {
    return !!source && context?.chat === source.chat
        && context?.groupId === source.groupId
        && getChatSessionKey(context) === source.sessionKey;
}

function historySignature(chat, messageIndex) {
    return JSON.stringify(chat.slice(0, messageIndex).map(message => [
        message?.is_user, message?.is_system, message?.name, message?.swipe_id,
        storyFingerprint(message?.mes),
    ]));
}

// Capture at enqueue time, so an index shifted by deletion cannot target another message.
export function captureMessageSource(context, messageIndex) {
    const chat = context?.chat;
    if (!Array.isArray(chat) || !Number.isInteger(messageIndex) || messageIndex < 0) return null;
    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) return null;
    return { ...captureChatSource(context), messageIndex, message, mes: message.mes,
        name: message.name, originalAvatar: message.original_avatar,
        swipeId: message.swipe_id ?? null, sendDate: message.send_date || '',
        sourceHistory: historySignature(chat, messageIndex) };
}

export function isMessageSourceCurrent(source, context) {
    if (!isChatSourceCurrent(source, context)) return false;
    const message = context.chat?.[source.messageIndex];
    return message === source.message && message?.mes === source.mes
        && !message.is_user && !message.is_system
        && message.name === source.name && message.original_avatar === source.originalAvatar
        && (message?.swipe_id ?? null) === source.swipeId
        && (message?.send_date || '') === source.sendDate
        && historySignature(context.chat, source.messageIndex) === source.sourceHistory;
}

export function snapshotGenerationSettings(settings = {}) {
    return { ...settings, characterAnchors: { ...settings.characterAnchors } };
}
