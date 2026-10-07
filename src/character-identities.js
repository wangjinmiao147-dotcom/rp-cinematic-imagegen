const clean = x => typeof x === 'string' ? x.normalize('NFKC').trim() : '';
const comparable = x => clean(x).toLowerCase();
const rawCharacter = c => c?.raw || c;
const identifier = c => c?.avatar || c?.name || '';

function namesFor(c) {
    const aliases = [c?.aliases, c?.data?.extensions?.rpig_aliases, c?.extensions?.rpig_aliases]
        .flatMap(v => Array.isArray(v) ? v : []);
    return [...new Set([c?.name, c?.data?.name, ...aliases].map(clean).filter(Boolean))];
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
    if (focalCharacter && !cards.some(c => identifier(c) === identifier(focalCharacter))) cards.push(focalCharacter);
    const canonical = name => {
        let current=clean(name); const seen=new Set();
        while (typeof aliases?.[current] === 'string' && !seen.has(current)) {
            seen.add(current); current=clean(aliases[current]);
        }
        return current;
    };
    const matches = (actor, c) => namesFor(c).some(n => comparable(canonical(n)) === comparable(actor));
    return (Array.isArray(visibleNames) ? visibleNames : []).map(actorName => {
        const actor=canonical(actorName), actorKey=comparable(actor);
        if (actorKey && actorKey === comparable(userName)) return {actorName,kind:'user',matchedBy:'user-identity'};
        if (focalCharacter && (matches(actor,focalCharacter) || actorKey === comparable(messageName))) {
            return {actorName,kind:'character',character:focalCharacter,matchedBy:'current-card-identity'};
        }
        const exact=cards.filter(c => matches(actor,c));
        if (exact.length===1) return {actorName,kind:'character',character:exact[0],matchedBy:'card-name-or-alias'};
        if (exact.length>1) return {actorName,kind:'unmatched',matchedBy:'ambiguous-card-name'};
        // Copy/import suffixes are contextual aliases, never an arbitrary prefix match.
        const variants=cards.filter(c=>namesFor(c).some(n=>comparable(importedBase(n))===actorKey && comparable(n)!==actorKey));
        if (variants.length===1) return {actorName,kind:'character',character:variants[0],matchedBy:'unique-import-name-variant'};
        if (variants.length>1) {
            const current=variants.find(c=>focalCharacter && identifier(c)===identifier(focalCharacter));
            if (current) return {actorName,kind:'character',character:current,matchedBy:'current-import-name-variant'};
        }
        return {actorName,kind:'unmatched',matchedBy:variants.length>1 ? 'ambiguous-import-name' : 'no-card-match'};
    });
}
