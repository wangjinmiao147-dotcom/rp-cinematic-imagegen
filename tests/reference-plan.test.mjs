import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReferencePlan, referenceBudgetFor, referenceCastGuidance } from '../src/reference-plan.js';
import { effectiveCharacterIdentity, resolveCastReferencePlan } from '../src/character-identities.js';
import { snapshotGenerationSettings } from '../src/task-context.js';
import { isLocalQwen } from '../src/qwen.js';

const primary = name => ({ identityId: name, identityName: name, kind: 'identity-primary', url: '/' + name });
test('reference budget keeps every selected actor primary before optional views', () => {
    const refs = [{ ...primary('A'), kind: 'identity-supporting', viewType: 'face_crop' }, primary('A'), primary('B'), primary('C')];
    const plan = buildReferencePlan(refs, { maxReferences: 3, shotMode: 'portrait' });
    assert.deepEqual(plan.refs.map(ref => ref.identityName), ['A', 'B', 'C']);
    assert.equal(plan.omitted.length, 1);
    assert.deepEqual(plan.assignments.map(ref => ref.referenceIndex), [1, 2, 3]);
    assert.equal(refs.length, 4);
});
test('too many distinct actors cannot be silently truncated', () => {
    assert.throws(() => buildReferencePlan(['A', 'B', 'C', 'D'].map(primary), { maxReferences: 3 }), { code: 'REFERENCE_BUDGET_EXCEEDED' });
});
test('portrait auxiliary is selected only after all primary identities fit', () => {
    const face = { identityId: 'A', viewType: 'face_crop', kind: 'identity-supporting' };
    const body = { identityId: 'A', viewType: 'full_body', kind: 'identity-supporting' };
    assert.deepEqual(buildReferencePlan([body, primary('A'), face], { maxReferences: 2, shotMode: 'portrait' }).refs, [primary('A'), face]);
});
test('explicit text-only mode sends no references and unknown backend does not invent a cap', () => {
    assert.equal(referenceBudgetFor({ backend: 'comfyui', comfyPreset: 'sd-text' }).mode, 'text');
    assert.equal(referenceBudgetFor({ backend: 'gemini', backendUrl: 'https://cloud.test' }).maxReferences, null);
    assert.equal(buildReferencePlan([primary('A')], { mode: 'text' }).refs.length, 0);
    assert.equal(referenceBudgetFor({ backend: 'gemini', backendUrl: 'http://localhost:8055' }).maxReferences, 3);
    assert.match(referenceCastGuidance({ maxReferences: 3 }), /明确全员时保留完整名单/);
});
test('real name overrides never rename host cards or change avatar resource identity', () => {
    const raw = { name: '星空冒险合集', avatar: 'story-card.png', aliases: ['旧昵称'] };
    const settings = { characterIdentityOverrides: { 'character:story-card.png': { name: '林岚', aliases: ['小岚'] } } };
    const effective = effectiveCharacterIdentity(raw, settings);
    assert.equal(effective.name, '林岚');assert.equal(effective.cardTitle, '星空冒险合集');
    assert.equal(effective.avatar, raw.avatar);assert.equal(raw.name, '星空冒险合集');
    const plan = resolveCastReferencePlan(['小岚'], { characters: [effective], aliases: { 小岚: '林岚' } });
    assert.equal(plan[0].character.avatar, 'story-card.png');
});
test('same-name cards have separate real identities and empty overrides remain unconfirmed titles', () => {
    const settings = { characterIdentityOverrides: { 'character:a.png': { name: '甲', aliases: [] } } };
    assert.equal(effectiveCharacterIdentity({ name: '世界设定', avatar: 'a.png' }, settings).name, '甲');
    const other = effectiveCharacterIdentity({ name: '世界设定', avatar: 'b.png' }, settings);
    assert.equal(other.hasExplicitIdentity, false);assert.equal(other.cardTitle, '世界设定');
});
test('task snapshots isolate later edits to LoRA strengths and true-name aliases', () => {
    const settings = { characterLoras: { 'character:a.png': { strengthModel: 0.8 } },
        characterIdentityOverrides: { 'character:a.png': { name: '甲', aliases: ['小甲'] } } };
    const snapshot = snapshotGenerationSettings(settings);
    settings.characterLoras['character:a.png'].strengthModel = 1.5;
    settings.characterIdentityOverrides['character:a.png'].aliases.push('另一个');
    assert.equal(snapshot.characterLoras['character:a.png'].strengthModel, 0.8);
    assert.deepEqual(snapshot.characterIdentityOverrides['character:a.png'].aliases, ['小甲']);
});

test('unlimited cloud mode and explicit all-reference policy retain all supplied views', () => {
    const refs = [primary('A'), { identityId: 'A', kind: 'identity-supporting', viewType: 'face_crop' },
        { identityId: 'A', kind: 'identity-supporting', viewType: 'full_body' }];
    assert.deepEqual(buildReferencePlan(refs).refs, refs);
    assert.deepEqual(buildReferencePlan(refs, { policy: 'all', maxReferences: 3 }).refs, refs);
    assert.throws(() => buildReferencePlan(refs, { policy: 'all', maxReferences: 2 }), { code: 'REFERENCE_BUDGET_EXCEEDED' });
});

test('explicit Comfy/SD backend selection does not become a Qwen bridge because of a reused port', () => {
    for (const backend of ['comfyui', 'sd', 'tavern-sd']) {
        const settings = { backend, backendUrl: 'http://localhost:8055', isLocalQwenBridge: true, backendModel: 'qwen' };
        assert.equal(isLocalQwen(settings), false);
    }
    assert.equal(isLocalQwen({ backend: 'gemini', backendUrl: 'http://localhost:8055' }), true);
});
