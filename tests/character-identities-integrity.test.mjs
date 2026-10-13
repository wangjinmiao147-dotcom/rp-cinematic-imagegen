import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCharacterIdentity, resolveCastReferencePlan } from '../src/character-identities.js';
import { selectCharacterLoras } from '../src/character-lora.js';
import { buildReferencePlan } from '../src/reference-plan.js';

const card = (avatar, title = 'World Story Card') => ({ name: title, avatar, data: { name: title } });
const override = (name, aliases = []) => ({ name, aliases });
const settingsFor = identities => ({ characterIdentityOverrides: Object.fromEntries(
    Object.entries(identities).map(([avatar, value]) => [`character:${avatar}`, value]),
) });

test('explicit names retain the resource title without automatically registering it as an alias', () => {
    const raw = { ...card('alice.png'), aliases: ['Ally'] };
    const effective = effectiveCharacterIdentity(raw, settingsFor({ 'alice.png': override('Alice', ['Alicia']) }));
    assert.equal(effective.name, 'Alice');
    assert.equal(effective.cardTitle, 'World Story Card');
    assert.deepEqual(effective.aliases, ['Ally', 'Alicia']);
    assert.equal(effective.data.name, 'World Story Card');
    assert.equal(raw.name, 'World Story Card');
    assert.deepEqual(raw.aliases, ['Ally']);
});

test('same-title cards resolve each real name before focal title aliases', () => {
    const settings = settingsFor({ 'alice.png': override('Alice'), 'bob.png': override('Bob') });
    const alice = effectiveCharacterIdentity(card('alice.png'), settings);
    const bob = effectiveCharacterIdentity(card('bob.png'), settings);
    const plan = resolveCastReferencePlan(['Alice', 'Bob'], { characters: [alice, bob], focalCharacter: bob,
        messageName: 'World Story Card', aliases: { 'World Story Card': 'Alice' } });
    assert.deepEqual(plan.map(match => match.character?.avatar), ['alice.png', 'bob.png']);
    assert.deepEqual(plan.map(match => match.actorName), ['Alice', 'Bob']);
});

test('a declared real name wins even when AI aliases try to rename it or a different card uses it as an alias', () => {
    const settings = settingsFor({ 'alice.png': override('Alice'), 'bob.png': override('Bob', ['Alice']) });
    const alice = effectiveCharacterIdentity(card('alice.png'), settings);
    const bob = effectiveCharacterIdentity(card('bob.png'), settings);
    const [match] = resolveCastReferencePlan(['ＡＬＩＣＥ'], { characters: [alice, bob], focalCharacter: bob,
        aliases: { 'ＡＬＩＣＥ': 'Bob' } });
    assert.equal(match.character, alice);
});

test('explicit cards cannot acquire another real identity through an old title or data name', () => {
    const raw = { ...card('bob.png'), data: { name: 'Stale Internal Title' } };
    const bob = effectiveCharacterIdentity(raw, settingsFor({ 'bob.png': override('Bob') }));
    const plan = resolveCastReferencePlan(['Alice', 'Stale Internal Title'], { characters: [bob], focalCharacter: bob,
        messageName: 'World Story Card', aliases: { 'World Story Card': 'Alice', 'Stale Internal Title': 'Alice' } });
    assert.ok(plan.every(match => match.kind === 'unmatched'));
});

test('explicit per-card aliases and actor-side AI aliases still identify the intended person', () => {
    const alice = effectiveCharacterIdentity(card('alice.png'), settingsFor({ 'alice.png': override('Alice', ['Ally']) }));
    const plan = resolveCastReferencePlan(['Ally', 'Alicia'], { characters: [alice], aliases: { Alicia: 'Alice' } });
    assert.ok(plan.every(match => match.character === alice));
});

test('a unique unconfirmed title can be connected to a real actor by an explicit AI alias', () => {
    const story = effectiveCharacterIdentity(card('story.png'), {});
    const [match] = resolveCastReferencePlan(['Alice'], { characters: [{ raw: story }], focalCharacter: story,
        aliases: { 'World Story Card': 'Alice' }, messageName: 'World Story Card' });
    assert.equal(match.character, story);
    assert.equal(match.actorName, 'Alice');
    assert.equal(match.matchedBy, 'unique-card-title');
});

test('multiple unconfirmed cards sharing a title remain ambiguous despite focal and message context', () => {
    const first = effectiveCharacterIdentity(card('first.png'), {});
    const second = effectiveCharacterIdentity(card('second.png'), {});
    for (const [actor, aliases] of [['Alice', { 'World Story Card': 'Alice' }], ['World Story Card', {}]]) {
        const [match] = resolveCastReferencePlan([actor], { characters: [first, second], focalCharacter: second,
            aliases, messageName: 'World Story Card' });
        assert.equal(match.kind, 'unmatched');
        assert.equal(match.character, undefined);
        assert.equal(match.matchedBy, 'ambiguous-card-title');
    }
});

test('unique literal resource titles remain a fallback without replacing declared identity', () => {
    const alice = effectiveCharacterIdentity(card('alice.png'), settingsFor({ 'alice.png': override('Alice') }));
    const [match] = resolveCastReferencePlan(['World Story Card'], { characters: [alice] });
    assert.equal(match.character, alice);
    assert.equal(match.character.name, 'Alice');
    assert.equal(match.matchedBy, 'unique-card-title');
});

test('unconfirmed imported names preserve unique and focal suffix matching while rejecting arbitrary prefixes', () => {
    const first = effectiveCharacterIdentity(card('first.png', 'Example (1)'), {});
    const second = effectiveCharacterIdentity(card('second.png', 'Example_copy_2'), {});
    assert.equal(resolveCastReferencePlan(['Example'], { characters: [first] })[0].character, first);
    const [current, partial] = resolveCastReferencePlan(['Example', 'Exam'], { characters: [first, second], focalCharacter: second });
    assert.equal(current.character, second);
    assert.equal(current.matchedBy, 'current-import-name-variant');
    assert.equal(partial.kind, 'unmatched');
    assert.equal(resolveCastReferencePlan(['Example'], { characters: [first, second] })[0].kind, 'unmatched');
});

test('explicit real names and aliases never lose meaningful digits through import suffix inference', () => {
    const settings = settingsFor({ 'first.png': override('Guard1', ['Alice1']), 'second.png': override('Guard2') });
    const first = effectiveCharacterIdentity(card('first.png'), settings);
    const second = effectiveCharacterIdentity(card('second.png'), settings);
    const plan = resolveCastReferencePlan(['Guard', 'Alice', 'Guard1', 'Alice1'], { characters: [first, second], focalCharacter: second });
    assert.equal(plan[0].kind, 'unmatched');
    assert.equal(plan[1].kind, 'unmatched');
    assert.equal(plan[2].character, first);
    assert.equal(plan[3].character, first);
});

test('legacy raw cards retain original data aliases and message-name focal matching', () => {
    const legacy = { name: 'Display', avatar: 'legacy.png', data: { name: 'Canonical', extensions: { rpig_aliases: ['Nickname'] } } };
    const plan = resolveCastReferencePlan(['Canonical', 'Nickname', 'Message Name'], { characters: [legacy],
        focalCharacter: legacy, messageName: 'Message Name' });
    assert.ok(plan.every(match => match.character === legacy));
});

test('blank AI aliases cannot connect unrelated titles to a blank identity', () => {
    const story = effectiveCharacterIdentity(card('story.png'), {});
    const plan = resolveCastReferencePlan(['Alice', ''], { characters: [story], aliases: { Alice: '', 'World Story Card': '' } });
    assert.ok(plan.every(match => match.kind === 'unmatched'));
});

test('real-name resolution drives the same primary reference and LoRA avatar key', () => {
    const settings = { ...settingsFor({ 'alice.png': override('Alice'), 'bob.png': override('Bob') }),
        characterLoras: { 'character:alice.png': { enabled: true, name: 'alice.safetensors', family: 'sd',
            strengthModel: 0.8, strengthClip: 0.8, triggerWords: 'alice' },
        'character:bob.png': { enabled: true, name: 'bob.safetensors', family: 'sd',
            strengthModel: 0.8, strengthClip: 0.8, triggerWords: 'bob' } } };
    const alice = effectiveCharacterIdentity(card('alice.png'), settings);
    const bob = effectiveCharacterIdentity(card('bob.png'), settings);
    const [match] = resolveCastReferencePlan(['Alice'], { characters: [alice, bob], focalCharacter: bob,
        aliases: { 'World Story Card': 'Alice' } });
    const identity = { identityId: `character:${match.character.avatar}`, identityName: match.actorName };
    const references = buildReferencePlan([{ ...identity, kind: 'identity-primary', url: '/alice-reference.png' }], { maxReferences: 1 });
    const loras = selectCharacterLoras(settings, [identity], { backend: 'comfyui', preset: 'sd-img2img' });
    assert.equal(references.refs[0].identityId, 'character:alice.png');
    assert.equal(loras.loras[0].name, 'alice.safetensors');
    assert.equal(loras.loras[0].identityId, references.refs[0].identityId);
});
