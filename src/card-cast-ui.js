import { getCardActors, saveCardActor } from './card-cast.js';

export function createCardCastUI({ $, getSettings, getSelectedCharacter, saveSettings, onSelect }) {
    const element = $('<div class="rpig-card-cast"></div>');
    const header = $('<div class="rpig-sheet-header"></div>').text('一张卡内的独立人物');
    const notice = $('<div class="rpig-notice"></div>').text('世界卡或多人故事卡可在这里添加各个人物，再为每个人上传自己的参考图。人物名单只是候选资料，AI仍按当前剧情判断谁入镜。');
    const select = $('<select data-rpig-cast="member"></select>');
    const name = $('<input type="text" data-rpig-cast="name" maxlength="100" placeholder="人物真实姓名">');
    const aliases = $('<input type="text" data-rpig-cast="aliases" maxlength="2000" placeholder="别名用逗号分隔">');
    const anchor = $('<textarea data-rpig-cast="anchor" maxlength="1200" rows="3" placeholder="脸、发型、衣服和配色等能区分此人的外貌"></textarea>');
    const save = $('<button type="button" class="menu_button" data-rpig-cast="save"></button>').text('保存人物并打开其参考图');
    const status = $('<div role="status" data-rpig-cast="status"></div>');
    const row = (label, control) => $('<label class="rpig-row"></label>').append($('<span></span>').text(label), control);
    element.append(header, notice, row('卡内人物', select), row('姓名', name), row('别名', aliases), row('外貌', anchor), save, status);
    let boundCard = null, destroyed = false;
    function fill() {
        const actor = getCardActors(boundCard, getSettings()).find(actor => actor.rpigActorId === select.val());
        name.val(actor?.name || ''); aliases.val(actor?.aliases.join(', ') || ''); anchor.val(actor?.description || '');
    }
    function refresh() {
        if (destroyed) return;
        const current = getSelectedCharacter?.();
        boundCard = current && current !== 'user' ? { ...current } : null;
        select.empty().append($('<option value="">新增人物</option>'));
        for (const actor of getCardActors(boundCard, getSettings())) select.append($('<option></option>').val(actor.rpigActorId).text(actor.name));
        select.val(current?.rpigActorId || ''); fill();
        for (const control of [select, name, aliases, anchor, save]) control.prop('disabled', !boundCard?.avatar);
        status.text(boundCard ? `所属卡片：${boundCard.rpigParentTitle || boundCard.cardTitle || boundCard.name}` : '请先选择角色卡。');
    }
    select.on('change', fill);
    save.on('click', () => {
        if (destroyed || !boundCard) return;
        try {
            const actor = saveCardActor(getSettings(), boundCard, { name: name.val(),
                aliases: String(aliases.val() || '').split(/[,，;；]+/), anchor: anchor.val() }, { id: select.val() || undefined });
            saveSettings?.(); onSelect?.(actor); refresh(); status.text(`已保存「${actor.name}」，请在下方上传此人的主身份图。`);
        } catch (error) { status.text(error.message); }
    });
    refresh();
    return { element, refresh, destroy() { if (destroyed) return; destroyed = true; boundCard = null;
        select.off(); save.off(); element.remove(); } };
}
