import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { effectiveCharacterIdentity } from '../src/character-identities.js';
import { getCardActors } from '../src/card-cast.js';

// Exercise the production host/card selectors, including their shared resolver.
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const selectors = source.slice(source.indexOf('function getAllCharacters('), source.indexOf('function getFinalizerLlmSettings('));
const card = (avatar, title = 'World Story Card') => ({ name: title, avatar, data: { name: title, description: avatar } });
const assistant = (name, avatar) => ({ is_user: false, name, ...(avatar ? { original_avatar: avatar } : {}), mes: 'scene' });
const identitySettings = () => ({ selectedTargetCharacter: 'auto', characterIdentityOverrides: {
    'character:alice.png': { name: 'Alice', aliases: [] },
    'character:bob.png': { name: 'Bob', aliases: [] },
} });
function fixture({ cards = [card('alice.png'), card('bob.png')], chat = [], settings = identitySettings(), characterId } = {}) {
    const context = { characters: cards, chat, groupId: 'group', ...(characterId === undefined ? {} : { characterId }) };
    const helpers = new Function('effectiveCharacterIdentity', 'getCardActors', 'getContext', 'getSettings', selectors
        + ';return {getAllCharacters,getCurrentCharacter,getCharacterForMessage};')(
        effectiveCharacterIdentity, getCardActors, () => context, () => settings,
    );
    return { ...helpers, cards, settings, context };
}

test('the latest original_avatar identifies its own same-title card before any earlier title match', () => {
    const message = assistant('World Story Card', 'bob.png');
    const f = fixture({ chat: [message] });
    assert.equal(f.getCurrentCharacter().avatar, 'bob.png');
    assert.equal(f.getCharacterForMessage(message).avatar, 'bob.png');
});

test('a removed original_avatar is never reinterpreted as another card title or real name', () => {
    const message = assistant('Removed Bob', 'bob.png');
    for (const title of ['bob.png', 'Other Title']) {
        const settings = { ...identitySettings(), characterIdentityOverrides: {
            'character:alice.png': { name: title === 'bob.png' ? 'Alice' : 'bob.png', aliases: [] },
        } };
        const f = fixture({ cards: [card('alice.png', title), card('carol.png', 'Carol')], settings, chat: [message] });
        assert.equal(f.getCurrentCharacter(), null);
        assert.equal(f.getCharacterForMessage(message), null);
    }
});

test('a declared real name wins over another card resource title in current and message selectors', () => {
    const message = assistant('Alice');
    const f = fixture({ cards: [card('bob.png', 'Alice'), card('alice.png')], chat: [message] });
    assert.equal(f.getCurrentCharacter().avatar, 'alice.png');
    assert.equal(f.getCharacterForMessage(message).avatar, 'alice.png');
});

test('same-title ambiguity cannot select the first card or resurrect an earlier message owner', () => {
    const message = assistant('World Story Card');
    const f = fixture({ chat: [assistant('Bob', 'bob.png'), message] });
    assert.equal(f.getCurrentCharacter(), null);
    assert.equal(f.getCharacterForMessage(message), null);
});

test('an ambiguous selected legacy title does not redirect settings bindings to the active or first card', () => {
    const settings = { ...identitySettings(), selectedTargetCharacter: 'World Story Card' };
    const f = fixture({ settings, chat: [assistant('Bob', 'bob.png')] });
    assert.equal(f.getCurrentCharacter(), null);
});

test('a selected avatar wins over a different card whose resource title is the same string', () => {
    const settings = { ...identitySettings(), selectedTargetCharacter: 'bob.png' };
    const f = fixture({ cards: [card('alice.png', 'bob.png'), card('bob.png')], settings });
    assert.equal(f.getCurrentCharacter().avatar, 'bob.png');
});

test('a selected declared name wins over a different card title', () => {
    const settings = { ...identitySettings(), selectedTargetCharacter: 'Alice' };
    const f = fixture({ cards: [card('bob.png', 'Alice'), card('alice.png')], settings });
    assert.equal(f.getCurrentCharacter().avatar, 'alice.png');
});

test('a unique legacy resource title remains usable without declaring it to be a real person', () => {
    const settings = { selectedTargetCharacter: 'Single World Card', characterIdentityOverrides: {} };
    const message = assistant('Single World Card');
    const f = fixture({ cards: [card('story.png', 'Single World Card')], settings, chat: [message] });
    assert.equal(f.getCurrentCharacter().avatar, 'story.png');
    assert.equal(f.getCurrentCharacter().hasExplicitIdentity, false);
    assert.equal(f.getCharacterForMessage(message).avatar, 'story.png');
});

test('an empty context defaults only when exactly one card is available', () => {
    const single = fixture({ cards: [card('alice.png')] });
    assert.equal(single.getCurrentCharacter().avatar, 'alice.png');
    assert.equal(fixture().getCurrentCharacter(), null);
    assert.equal(fixture({ cards: [] }).getCurrentCharacter(), null);
});

test('a host characterId selects the intended resource while user messages never claim that identity', () => {
    const f = fixture({ characterId: 1 });
    assert.equal(f.getCurrentCharacter().avatar, 'bob.png');
    assert.equal(f.getCurrentCharacter().name, 'Bob');
    assert.equal(f.getCharacterForMessage({ is_user: true, name: 'Bob', original_avatar: 'bob.png' }), null);
});

test('applying effective identities never mutates the host cards, titles, aliases, or data', () => {
    const cards = [card('alice.png'), card('bob.png')];
    cards[0].aliases = ['Ally'];
    const before = structuredClone(cards);
    for (const item of cards) { Object.freeze(item.data); Object.freeze(item.aliases || []); Object.freeze(item); }
    Object.freeze(cards);
    const f = fixture({ cards, characterId: 0 });
    assert.equal(f.getAllCharacters()[0].cardTitle, 'World Story Card');
    assert.equal(f.getCurrentCharacter().name, 'Alice');
    assert.equal(f.getCharacterForMessage(assistant('Bob', 'bob.png')).name, 'Bob');
    assert.deepEqual(cards, before);
});

test('a supplied settings snapshot controls all identity selectors despite later live edits', () => {
    const f = fixture({ characterId: 0 });
    const snapshot = structuredClone(f.settings);
    f.settings.characterIdentityOverrides['character:alice.png'].name = 'Later Name';
    assert.equal(f.getCurrentCharacter(snapshot).name, 'Alice');
    assert.equal(f.getAllCharacters(snapshot)[0].name, 'Alice');
    assert.equal(f.getCharacterForMessage(assistant('Alice', 'alice.png'), snapshot).name, 'Alice');
});
