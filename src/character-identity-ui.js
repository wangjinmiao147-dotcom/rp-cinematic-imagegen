import { getCharacterLoraKey } from './character-lora.js';

function own(value, key) {
    if (!value || typeof value !== 'object') return undefined;
    try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' ? value : ''; }
function safeName(value) { return value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value); }

export function createCharacterIdentityUI({ $, getSettings, getCharacterIdentifier, getSelectedCharacter, saveSettings }) {
    if (typeof $ !== 'function') throw new TypeError('Character identity controls require the host UI adapter');
    const element = $('<div class="rpig-character-identity"></div>');
    const title = $('<div class="rpig-sheet-header"></div>').text('角色真实姓名与别名');
    const cardTitle = $('<div data-rpig-identity="card-title" class="rpig-char-summary-name"></div>');
    const notice = $('<div class="rpig-notice"></div>').text('卡片标题只用于区分角色卡。真实姓名可留空，由 AI 依据当前正文判断；填写后作为身份线索。参考图与 LoRA 始终绑定头像标识，修改姓名不会改变绑定。');
    const name = $('<input type="text" data-rpig-identity="name" maxlength="100" placeholder="可留空，例如正文中的真实姓名">');
    const aliases = $('<textarea data-rpig-identity="aliases" rows="2" placeholder="可选，多个别名用逗号分隔"></textarea>');
    const save = $('<button type="button" class="menu_button" data-rpig-identity="save"></button>').text('保存姓名与别名');
    const status = $('<div data-rpig-identity="status" role="status"></div>');
    function row(label, control) { return $('<label class="rpig-row"></label>').append($('<span></span>').text(label)).append(control); }
    element.append(title, cardTitle, notice, row('真实姓名（最多 100 字符）', name), row('别名（最多 20 个）', aliases), save, status);
    let boundId = null, destroyed = false;

    function persist() {
        if (destroyed || !boundId) return;
        const capturedId = boundId;
        const canonicalName = text(name.val()).trim();
        const rawAliases = text(aliases.val());
        if (!safeName(canonicalName) || rawAliases.length > 4000) {
            status.text('姓名须为最多 100 字符的单行文本；别名输入过长，请缩减后保存。');
            return;
        }
        const collected = [], seen = new Set(canonicalName ? [canonicalName.toLowerCase()] : []);
        for (const value of rawAliases.split(/[,，;；\r\n]+/)) {
            const alias = value.trim();
            if (!alias) continue;
            if (!safeName(alias)) { status.text('每个别名须为最多 100 字符的单行文本。'); return; }
            const marker = alias.toLowerCase();
            if (seen.has(marker)) continue;
            seen.add(marker);
            collected.push(alias);
        }
        if (collected.length > 20) { status.text('最多保存 20 个不同别名，请缩减后再保存。'); return; }
        try {
            const settings = getSettings();
            if (!object(settings)) throw new Error('当前设置不可用，请重新打开设置。');
            const existing = own(settings, 'characterIdentityOverrides');
            settings.characterIdentityOverrides = { ...(object(existing) ? existing : {}),
                [capturedId]: { name: canonicalName, aliases: collected } };
            saveSettings?.();
            status.text(canonicalName ? '已保存当前角色的真实姓名与别名。' : '已保存；真实姓名将由 AI 依据正文判断。');
        } catch (error) { status.text(error?.message || '保存失败，请重新打开设置后重试。'); }
    }

    function refresh() {
        if (destroyed) return;
        const character = getSelectedCharacter?.();
        const stableId = getCharacterLoraKey(character, getCharacterIdentifier);
        boundId = stableId === 'user' || character?.rpigActor === true ? null : stableId;
        const rawTitle = text(own(character, 'cardTitle')) || text(own(character, 'name')) || '角色';
        cardTitle.text(character === 'user' ? 'User 使用酒馆当前用户名，无需在此另设角色姓名。' : `卡片标题：${rawTitle}`);
        const stored = boundId ? own(own(getSettings(), 'characterIdentityOverrides'), boundId) : undefined;
        name.val(text(own(stored, 'name')).slice(0, 100));
        const savedAliases = own(stored, 'aliases');
        aliases.val(Array.isArray(savedAliases) ? savedAliases.filter(value => typeof value === 'string').slice(0, 20).map(value => value.slice(0, 100)).join(', ') : '');
        for (const control of [name, aliases, save]) control.prop('disabled', !boundId);
        status.text(character?.rpigActor ? '卡内人物的姓名与别名请在上方人物列表修改。' : !stableId ? '请先选择有稳定头像标识的角色。' : '');
    }

    name.on('change', persist);
    aliases.on('change', persist);
    save.on('click', persist);
    refresh();
    return { element, refresh, destroy() {
        if (destroyed) return;
        destroyed = true;
        boundId = null;
        for (const control of [name, aliases, save]) control.off();
        element.remove();
    } };
}
