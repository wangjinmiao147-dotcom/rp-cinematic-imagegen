import { storyTextForIllustration } from './story-text.js';
export const SCENE_STATE_VERSION = 3;
export const SCENE_FIELDS = ['location', 'time_of_day', 'weather', 'lighting'];
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const clean = x => storyTextForIllustration(String(x || ''));
const emptyScene = () => Object.fromEntries(SCENE_FIELDS.map(k => [k, null]));
// A change token, not a security hash; quotes alone do not detect edited context.
export function storyFingerprint(text) {
    const s = clean(text); let a = 2166136261, b = 5381;
    for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ s.charCodeAt(i); }
    return `${s.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}
export function isConfirmedSceneFact(f) {
    return object(f) && f.confirmed === true && typeof f.value === 'string' && !!f.value.trim()
        && typeof f.evidence === 'string' && !!f.evidence.trim() && Number.isInteger(f.source_message_index);
}
function verifyFact(raw, index, text) {
    if (!object(raw) || typeof raw.value !== 'string' || !raw.value.trim() || typeof raw.evidence !== 'string' || !raw.evidence.trim()) return null;
    const s = clean(text), offset = s.indexOf(raw.evidence);
    if (offset < 0) return null;
    return { value: raw.value.trim(), evidence: raw.evidence, source_message_index: index,
        source_fingerprint: storyFingerprint(s), evidence_start: offset, confirmed: true };
}
function historicalFact(f, chat, before) {
    if (!isConfirmedSceneFact(f) || f.source_message_index < 0 || f.source_message_index > before) return null;
    const m = chat[f.source_message_index];
    if (!m || m.is_user || m.is_system || !f.source_fingerprint || f.source_fingerprint !== storyFingerprint(m.mes)) return null;
    return clean(m.mes).includes(f.evidence) ? { ...f } : null;
}
function verifiedPersistent(states, chat, before) {
    return (Array.isArray(states) ? states : []).filter(p => object(p) && typeof p.character === 'string' && p.character.trim())
        .map(p => ({ character: p.character,
            clothing: (Array.isArray(p.clothing) ? p.clothing : []).map(f => historicalFact(f, chat, before)).filter(Boolean),
            props: (Array.isArray(p.props) ? p.props : []).map(f => historicalFact(f, chat, before)).filter(Boolean) }))
        .filter(p => p.clothing.length || p.props.length);
}
export function getPreviousSceneState(chat, beforeIndex) {
    if (!Array.isArray(chat)) return null;
    let found = -1, saved = null;
    for (let i = beforeIndex - 1; i >= 0; i--) {
        const state = chat[i]?.extra?.rpigInfo?.sceneState;
        if (state && (state.version === 2 || state.version === SCENE_STATE_VERSION)) { found = i; saved = state; break; }
    }
    const checked = { ...emptyScene(), version: SCENE_STATE_VERSION, persistent_states: [],
        narrative_end_state: emptyScene(), narrative_end_persistent_states: [] };
    let start = Math.max(0, beforeIndex - 12);
    if (saved) {
        const valid = saved.version === SCENE_STATE_VERSION && saved.source_message_index === found
            && saved.source_fingerprint === storyFingerprint(chat[found]?.mes);
        start = valid ? found + 1 : found; // Re-review legacy/edited endings rather than inheriting image-frame state.
        if (valid) {
            for (const k of SCENE_FIELDS) {
                checked[k] = historicalFact(saved[k], chat, found);
                checked.narrative_end_state[k] = historicalFact(saved.narrative_end_state?.[k], chat, found);
            }
            checked.persistent_states = verifiedPersistent(saved.persistent_states, chat, found);
            checked.narrative_end_persistent_states = verifiedPersistent(saved.narrative_end_persistent_states, chat, found);
        }
    }
    checked._intervening_messages = [];
    for (let i = start; i < beforeIndex; i++) {
        const m = chat[i], text = clean(m?.mes);
        if (text && !m?.is_user && !m?.is_system) checked._intervening_messages.push({ source_message_index: i, text });
    }
    checked._hasInterveningMessages = checked._intervening_messages.length > 0;
    checked._interveningText = checked._intervening_messages.map(m => m.text).join('\n\n');
    return checked;
}
export function getEffectivePreviousState(previous) {
    if (!previous || previous._effective_previous === true) return previous;
    const end = previous.version === SCENE_STATE_VERSION ? previous.narrative_end_state : null;
    return { ...previous, ...Object.fromEntries(SCENE_FIELDS.map(k => [k, isConfirmedSceneFact(end?.[k]) ? end[k] : null])),
        persistent_states: previous.version === SCENE_STATE_VERSION && Array.isArray(previous.narrative_end_persistent_states)
            ? previous.narrative_end_persistent_states : [], _effective_previous: true };
}
function mergePersistent(previous, updates, sources, carry) {
    const people = new Map();
    if (carry) for (const p of Array.isArray(previous) ? previous : []) {
        if (p?.character) people.set(p.character.toLowerCase(), { character: p.character,
            clothing: (Array.isArray(p.clothing) ? p.clothing : []).map(f => ({ ...f })), props: (Array.isArray(p.props) ? p.props : []).map(f => ({ ...f })) });
    }
    for (const u of Array.isArray(updates) ? updates : []) {
        if (!object(u) || !['clothing', 'props'].includes(u.category) || typeof u.character !== 'string' || !u.character.trim()
            || typeof u.key !== 'string' || !u.key.trim()) continue;
        const source = sources.get(u.source_message_index), fact = source ? verifyFact(u, u.source_message_index, source.text) : null;
        if (!fact) continue;
        const id = u.character.trim().toLowerCase(), key = u.key.trim();
        const p = people.get(id) || { character: u.character.trim(), clothing: [], props: [] };
        if (u.category === 'clothing' && key.toLowerCase() === 'outfit') {
            p.clothing = p.clothing.filter(f => !f.key?.toLowerCase().startsWith('condition:outfit:')
                || (updates || []).some(next => next !== u && next.character?.trim().toLowerCase() === id
                    && next.category === 'clothing' && next.key?.trim().toLowerCase() === f.key.toLowerCase()));
        }
        const slot = p[u.category].findIndex(f => f.key?.toLowerCase() === key.toLowerCase());
        if (slot < 0) p[u.category].push({ ...fact, key }); else p[u.category][slot] = { ...fact, key };
        people.set(id, p);
    }
    return [...people.values()].filter(p => p.clothing.length || p.props.length);
}
const currentUpdates = (updates, index) => (Array.isArray(updates) ? updates : []).map(u => ({ ...u, source_message_index: index }));
function continuityBase(facts, previous) {
    const base = getEffectivePreviousState(previous);
    if (!base?._hasInterveningMessages) return base;
    const review = facts.continuity_state, sources = new Map(base._intervening_messages.map(m => [m.source_message_index, m]));
    const result = { ...base };
    for (const k of SCENE_FIELDS) {
        const raw = review?.[k], source = sources.get(raw?.source_message_index);
        result[k] = source ? verifyFact(raw, raw.source_message_index, source.text) : null;
        if (raw == null && review?.scene_continues === true) result[k] = base[k];
    }
    result.persistent_states = mergePersistent(base.persistent_states, facts.continuity_updates, sources, review?.persistent_continues === true);
    return result;
}
export function buildVersionedSceneState(facts, previous, messageIndex, rawStory, actions, explicitChanges) {
    const parsed = facts?.scene_state || facts || {}, story = clean(rawStory), base = continuityBase(facts || {}, previous);
    const evidence = typeof facts?.moment_evidence === 'string' ? facts.moment_evidence : '', offset = evidence ? story.indexOf(evidence) : -1;
    const continuous = parsed.scene_continues === true && !!base;
    const result = { ...emptyScene(), version: SCENE_STATE_VERSION, source_message_index: messageIndex,
        source_fingerprint: storyFingerprint(story), scene_continues: continuous,
        moment: facts?.moment || null, moment_evidence: evidence || null, moment_start: offset >= 0 ? offset : null };
    for (const k of SCENE_FIELDS) {
        result[k] = verifyFact(parsed[k], messageIndex, story)
            || (continuous && parsed[k] == null && isConfirmedSceneFact(base?.[k]) ? base[k] : null);
    }
    const sources = new Map([[messageIndex, { text: story }]]);
    result.persistent_states = mergePersistent(base?.persistent_states, currentUpdates(facts?.persistent_updates, messageIndex), sources,
        facts?.persistent_continues === true);
    result.character_states = (Array.isArray(actions) ? actions : (facts?.actions || [])).filter(a => a?.character).map(a => ({
        character: a.character, action: a.action || null, expression: a.expression || null, gaze: a.gaze || null,
        contact: a.contact || null, source_message_index: messageIndex }));
    const end = object(facts?.narrative_end_state) ? facts.narrative_end_state : {};
    result.narrative_end_state = emptyScene();
    for (const k of SCENE_FIELDS) {
        result.narrative_end_state[k] = verifyFact(end[k], messageIndex, story)
            || (end.scene_continues === true && end[k] == null ? result[k] : null);
    }
    result.narrative_end_persistent_states = mergePersistent(result.persistent_states, currentUpdates(facts?.narrative_end_updates, messageIndex),
        sources, end.persistent_continues === true);
    return result;
}
// Endings and history must never become editable facts for the selected frame.
export function getIllustrationFacts(facts, state = facts?.scene_state) {
    const result = { ...facts };
    for (const k of ['narrative_end_state', 'narrative_end_updates', 'continuity_state', 'continuity_updates', 'persistent_updates', 'persistent_continues']) delete result[k];
    if (state) result.scene_state = { ...Object.fromEntries(SCENE_FIELDS.map(k => [k, state[k] || null])),
        scene_continues: state.scene_continues ?? null, persistent_states: state.persistent_states || [] };
    return result;
}
export function getCharacterPersistentInfo(state, name) {
    if (!state || typeof name !== 'string') return null;
    const p = state.persistent_states?.find(p => p.character?.toLowerCase() === name.toLowerCase());
    return p ? { ...p, clothing_changes: (p.clothing || []).map(f => f.value), prop_changes: (p.props || []).map(f => f.value) } : null;
}

export function canUseContinuityReference(reference, chat, currentState) {
    const index = reference?.messageIndex, message = chat?.[index], saved = message?.extra?.rpigInfo?.sceneState;
    if (!reference?.url || !Number.isInteger(index) || !saved || saved.version !== SCENE_STATE_VERSION || saved.source_message_index !== index
        || saved.source_fingerprint !== storyFingerprint(message.mes)) return false;
    if (!Array.isArray(saved.persistent_states) || saved.persistent_states.some(p => !object(p)
        || typeof p.character !== 'string' || !Array.isArray(p.clothing) || !Array.isArray(p.props))) return false;
    const savedPeople = saved.persistent_states;
    const facts = savedPeople.flatMap(p => [...p.clothing, ...p.props]);
    if (!facts.length || facts.some(f => !historicalFact(f, chat, index))) return false;
    return (Array.isArray(currentState?.persistent_states) ? currentState.persistent_states : []).some(p => p
        && savedPeople.some(s => s.character === p.character) && ((p.clothing || []).length || (p.props || []).length));
}
