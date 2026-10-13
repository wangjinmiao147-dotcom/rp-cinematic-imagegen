import { getCardActors } from './card-cast.js';

const clean = x => typeof x === 'string' ? x.normalize('NFKC').trim() : '';
const comparable = x => clean(x).toLowerCase();
const rawCharacter = c => c?.raw || c;
const identifier = c => c?.avatar || c?.name || '';

// A card filename identifies saved resources; its display title need not be a person's name.
export function effectiveCharacterIdentity(character, settings = {}) {
    const card = rawCharacter(character);
    if (!card || typeof card !== 'object') return card;
    if (card.rpigActor === true) return { ...card, aliases: [...(card.aliases || [])] };
    const cardTitle = clean(card.cardTitle || card.name);
    const key = typeof card.avatar === 'string' && card.avatar.trim() ? `character:${card.avatar}` : null;
    const overrides = settings.characterIdentityOverrides;
    const stored = key && overrides && typeof overrides === 'object'
        ? Object.getOwnPropertyDescriptor(overrides, key)?.value : null;
    const configuredName = typeof stored?.name === 'string' && stored.name.length <= 100
        && !/[\u0000-\u001f\u007f]/.test(stored.name) ? clean(stored.name) : '';
    const configuredAliases = Array.isArray(stored?.aliases) ? stored.aliases.slice(0, 20)
        .filter(alias => typeof alias === 'string' && alias.length <= 100 && !/[\u0000-\u001f\u007f]/.test(alias)) : [];
    const aliases = [...new Set([...(Array.isArray(card.aliases) ? card.aliases : []), ...configuredAliases]
        .map(clean).filter(Boolean))];
    const actorCount = getCardActors(card, settings).length;
    return { ...card, name: configuredName || cardTitle, cardTitle, aliases, hasExplicitIdentity: !!configuredName,
        ...(actorCount ? { rpigCastMemberCount: actorCount } : {}) };
}

function aliasesFor(c) {
    return [c?.aliases, c?.data?.extensions?.rpig_aliases, c?.extensions?.rpig_aliases]
        .flatMap(v => Array.isArray(v) ? v : []);
}

function realNamesFor(c) {
    // Once a real identity is configured, the original data.name remains a resource title.
    if (c?.hasExplicitIdentity === true) return [clean(c.name)].filter(Boolean);
    if (c?.hasExplicitIdentity === false) return [];
    return [...new Set([c?.name, c?.data?.name].map(clean).filter(Boolean))];
}

function namesFor(c) {
    return [...new Set([...realNamesFor(c), ...aliasesFor(c)].map(clean).filter(Boolean))];
}

function titleFor(c) {
    return clean(c?.cardTitle || c?.name);
}

function importedBase(name) {
    const original = clean(name);
    const base = original.replace(/\s*\(\d+\)$/, '')
        .replace(/(?:[\s_-]+(?:copy|副本))(?:[\s_-]*\d+)?$/i, '')
        .replace(/(?<=[\p{L}])\d+$/u, '').trim();
    return base.length >= 2 ? base : original;
}

/** Resolve actors to actual card objects; keep story names as image labels. */
export function resolveCastReferencePlan(visibleNames, {
    characters = [], focalCharacter = null, userName = '', aliases = {}, messageName = '',
} = {}) {
    const cards = [...characters.map(rawCharacter).filter(Boolean)];
    const focal = rawCharacter(focalCharacter);
    if (focal && !cards.some(c => identifier(c) === identifier(focal))) cards.push(focal);
    const canonical = name => {
        let current=clean(name); const seen=new Set();
        while (typeof aliases?.[current] === 'string' && !seen.has(current)) {
            const next = clean(aliases[current]);
            if (!next) break;
            seen.add(current); current=next;
        }
        return current;
    };
    const identityMatch = (actorName, matches) => {
        if (matches.length === 1) return {actorName,kind:'character',character:matches[0],matchedBy:'card-name-or-alias'};
        if (matches.length > 1) {
            const current = matches.find(c => focal && identifier(c) === identifier(focal));
            if (current) return {actorName,kind:'character',character:current,matchedBy:'current-card-identity'};
            const scoped = matches.filter(c => focal && c.rpigActor === true
                && c.rpigParentAvatar === (focal.rpigParentAvatar || focal.avatar));
            if (scoped.length === 1) return {actorName,kind:'character',character:scoped[0],matchedBy:'current-card-person'};
            return {actorName,kind:'unmatched',matchedBy:'ambiguous-card-name'};
        }
        return null;
    };
    return (Array.isArray(visibleNames) ? visibleNames : []).map(actorName => {
        const rawKey = comparable(actorName), actorKey = comparable(canonical(actorName));
        if (!rawKey) return {actorName,kind:'unmatched',matchedBy:'no-card-match'};
        // Declared names and aliases take priority over an AI alias for a card title.
        for (const key of [...new Set([rawKey, actorKey])]) {
            if (key === comparable(userName)) return {actorName,kind:'user',matchedBy:'user-identity'};
            const named = identityMatch(actorName, cards.filter(c => realNamesFor(c).some(n => comparable(n) === key)));
            if (named) return named;
            const aliased = identityMatch(actorName, cards.filter(c => aliasesFor(c).some(n => comparable(n) === key)));
            if (aliased) return aliased;
        }

        const inferred = identityMatch(actorName, cards.filter(c => c.hasExplicitIdentity !== true
            && namesFor(c).some(n => comparable(canonical(n)) === actorKey)));
        if (inferred) return inferred;
        // Copy/import suffixes are contextual aliases, never an arbitrary prefix match.
        const variants=cards.filter(c=>c.hasExplicitIdentity !== true
            && [...namesFor(c), ...(c.hasExplicitIdentity === false ? [titleFor(c)] : [])]
            .some(n=>comparable(importedBase(n))===actorKey && comparable(n)!==actorKey));
        if (variants.length===1) return {actorName,kind:'character',character:variants[0],matchedBy:'unique-import-name-variant'};
        if (variants.length>1) {
            const current=variants.find(c=>focal && identifier(c)===identifier(focal));
            if (current) return {actorName,kind:'character',character:current,matchedBy:'current-import-name-variant'};
            return {actorName,kind:'unmatched',matchedBy:'ambiguous-import-name'};
        }

        // A title can identify a unique saved resource, but never rename an explicit person.
        const titles = cards.filter(c => {
            if (c.rpigActor || c.rpigCastMemberCount) return false;
            const title = titleFor(c), titleKey = comparable(title);
            if (!titleKey) return false;
            if (c.hasExplicitIdentity === true) return rawKey === titleKey && actorKey === rawKey;
            return titleKey === rawKey || comparable(canonical(title)) === actorKey;
        });
        if (titles.length === 1) return {actorName,kind:'character',character:titles[0],matchedBy:'unique-card-title'};
        if (titles.length > 1) return {actorName,kind:'unmatched',matchedBy:'ambiguous-card-title'};
        // Preserve legacy message aliases for raw cards, without treating unconfirmed story titles as people.
        if (focal && focal.hasExplicitIdentity === undefined && rawKey === comparable(messageName)) {
            return {actorName,kind:'character',character:focal,matchedBy:'current-card-identity'};
        }
        return {actorName,kind:'unmatched',matchedBy:'no-card-match'};
    });
}
