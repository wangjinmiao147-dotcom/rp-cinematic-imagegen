import { RpigError } from './utils.js';

const own = (object, key) => object && typeof object === 'object' ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
const clean = value => typeof value === 'string' ? value.normalize('NFKC').trim() : '';
const validText = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const parentAvatar = card => clean(card?.rpigParentAvatar || card?.avatar);
const memberId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value);

export function cardActorAvatar(avatar, id) {
    return `rpig-actor:${encodeURIComponent(avatar)}:${id}`;
}

/** Named people belong to one card, with stable resource IDs independent of their names. */
export function getCardActors(card, settings = {}) {
    const avatar = parentAvatar(card);
    if (!avatar || card?.isUser) return [];
    const records = own(own(settings, 'characterCast'), `character:${avatar}`);
    if (!Array.isArray(records)) return [];
    const seen = new Set();
    return records.slice(0, 24).flatMap(record => {
        const id = own(record, 'id'), name = own(record, 'name');
        if (!memberId(id) || !validText(name, 100) || !clean(name) || seen.has(id)) return [];
        seen.add(id);
        const aliases = (Array.isArray(own(record, 'aliases')) ? record.aliases : []).slice(0, 20)
            .filter(value => validText(value, 100)).map(clean).filter(Boolean);
        const anchor = validText(own(record, 'anchor') || '', 1200) ? clean(record.anchor) : '';
        const title = clean(card?.rpigParentTitle || card?.cardTitle || card?.name);
        return [{ name: clean(name), aliases: [...new Set(aliases)], avatar: cardActorAvatar(avatar, id),
            cardTitle: title, hasExplicitIdentity: true, rpigActor: true,
            rpigParentAvatar: avatar, rpigParentTitle: title, rpigActorId: id,
            description: anchor, data: { name: clean(name), description: anchor }, }];
    });
}

export function saveCardActor(settings, card, value, { id = value?.id } = {}) {
    const avatar = parentAvatar(card);
    if (!avatar || card === 'user' || card?.isUser || !settings || typeof settings !== 'object') {
        throw new RpigError('CARD_ACTOR_INVALID', '请先选择角色卡，再添加卡内人物。');
    }
    const name = clean(value?.name), anchor = clean(value?.anchor || '');
    const aliases = [...new Set((Array.isArray(value?.aliases) ? value.aliases : []).map(clean).filter(Boolean))];
    if (!name || !validText(name, 100) || !validText(anchor, 1200)
        || aliases.length > 20 || aliases.some(alias => !validText(alias, 100))) {
        throw new RpigError('CARD_ACTOR_INVALID', '姓名最多100字，别名最多20个，外貌描述最多1200字；请使用单行文本。');
    }
    const key = `character:${avatar}`;
    const actors = getCardActors(card, settings);
    if (id !== undefined && (!memberId(id) || !actors.some(actor => actor.rpigActorId === id))) {
        throw new RpigError('CARD_ACTOR_INVALID', '原人物已不存在，请刷新人物列表。');
    }
    const names = new Set([name, ...aliases].map(value => value.toLowerCase()));
    if (actors.some(actor => actor.rpigActorId !== id && [actor.name, ...actor.aliases]
        .some(value => names.has(value.toLowerCase())))) {
        throw new RpigError('CARD_ACTOR_INVALID', '同一张卡里的人物姓名或别名重复，请改用能区分人物的名字。');
    }
    if (!id && actors.length >= 24) throw new RpigError('CARD_ACTOR_INVALID', '一张卡最多保存24个独立人物。');
    let stableId = id;
    if (!stableId) {
        do { stableId = globalThis.crypto?.randomUUID?.() || `actor_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`; }
        while (actors.some(actor => actor.rpigActorId === stableId));
    }
    const records = actors.map(actor => ({ id: actor.rpigActorId, name: actor.name,
        aliases: [...actor.aliases], anchor: actor.description }));
    const record = { id: stableId, name, aliases, anchor };
    const index = records.findIndex(actor => actor.id === stableId);
    if (index < 0) records.push(record); else records[index] = record;
    settings.characterCast = { ...(own(settings, 'characterCast') || {}), [key]: records };
    return getCardActors(card, settings).find(actor => actor.rpigActorId === stableId);
}
