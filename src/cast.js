function cleanCastName(value) {
    return String(value || '')
        .replace(/^[-*\d.\s]+/, '')
        .replace(/[\[\]"']/g, '')
        .trim();
}

function isExplicitlyAbsent(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.visible === false || item.present === false || item.in_scene === false) return true;
    const status = String(item.status || item.presence || '').toLowerCase();
    return /^(?:absent|offscreen|off-camera|not present|left|离场|不在场|未入镜)$/.test(status);
}

/**
 * Normalize an LLM cast list without silently adding the user or every group member.
 * An empty/invalid visible list falls back to the current message character only.
 */
export function normalizeCastCharacters(rawCharacters, {
    context = {},
    chat = [],
    messageIndex = -1,
    focalCharacter = null,
    fallbackToFocal = true,
} = {}) {
    const recent = Array.isArray(chat) ? chat.slice(Math.max(0, messageIndex - 12), messageIndex + 1) : [];
    const userName = String(context?.name1 || [...recent].reverse().find(message => message?.is_user)?.name || 'User protagonist').trim();
    const focalName = String(focalCharacter?.name || chat?.[messageIndex]?.name || context?.name2 || 'Current role character').trim();
    const currentMessageName = String(chat?.[messageIndex]?.name || '').trim();
    const userAliases = new Set(['user', 'you', '用户', '玩家', '主人公', '主角', 'protagonist', 'user protagonist', 'player character', userName.toLowerCase()]);
    const focalAliases = new Set(['ai', 'assistant', 'bot', '角色', '当前角色', '当前回复角色', 'current character', 'current role character', focalName.toLowerCase(), currentMessageName.toLowerCase()].filter(Boolean));
    const values = Array.isArray(rawCharacters) ? rawCharacters : [];
    const normalized = [];
    const seen = new Set();

    const add = (name) => {
        const clean = cleanCastName(name);
        if (!clean) return;
        const lower = clean.toLowerCase();
        const comparable = clean
            .replace(/^(?:the\s+)?(?:user protagonist|player character|current role character|current character|用户主人公|当前回复角色|当前角色)\s*[:：=\-]?\s*/i, '')
            .replace(/\s*\((?:ai|assistant|bot|user|you|current role|current character|用户|玩家|主人公|当前角色)\)\s*$/i, '')
            .trim();
        const comparableLower = comparable.toLowerCase();
        const canonical = userAliases.has(lower) || userAliases.has(comparableLower)
            ? userName
            : focalAliases.has(lower) || focalAliases.has(comparableLower)
                ? focalName
                : comparable || clean;
        const key = canonical.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            normalized.push(canonical);
        }
    };

    for (const item of values) {
        if (isExplicitlyAbsent(item)) continue;
        add(typeof item === 'string'
            ? item
            : (item?.canonical_name || item?.name || item?.character || item?.role || ''));
        if (normalized.length >= 12) break;
    }

    if (!normalized.length && fallbackToFocal) add(focalName || userName);
    return normalized;
}
