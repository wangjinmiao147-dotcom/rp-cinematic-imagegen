import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CHARACTER_LORA, getCharacterLoraKey, readCharacterLora, saveCharacterLora, selectCharacterLoras } from '../src/character-lora.js';

const actor = identityId => ({ identityId, identityName: 'Same displayed name' });
const comfy = { backend: 'comfyui', preset: 'sd-text' };
function fixture(record = {}) {
    const settings = { backend: 'comfyui', comfyPreset: 'sd-text', characterLoras: {} };
    saveCharacterLora(settings, 'character:a.png', { ...DEFAULT_CHARACTER_LORA, name: 'people/actor-a.safetensors', enabled: true, ...record });
    return settings;
}

test('new and missing character bindings are disabled and read as independent default values', () => {
    const settings = {};
    const first = readCharacterLora(settings, 'character:a.png');
    assert.deepEqual(first, { ...DEFAULT_CHARACTER_LORA });
    first.name = 'changed';
    assert.equal(readCharacterLora(settings, 'character:a.png').name, '');
    assert.deepEqual(settings, {});
});

test('stable avatar identities isolate same-name cards, renamed cards and User', () => {
    const getId = value => value.avatar || value.name;
    const a = { name: 'Same', avatar: 'a.png' }, b = { name: 'Same', avatar: 'b.png' };
    assert.equal(getCharacterLoraKey(a, getId), 'character:a.png');
    assert.equal(getCharacterLoraKey(b, getId), 'character:b.png');
    assert.equal(getCharacterLoraKey({ ...a, name: 'Renamed' }, getId), 'character:a.png');
    assert.equal(getCharacterLoraKey({ name: 'Same' }, getId), null);
    assert.equal(getCharacterLoraKey('user', getId), 'user');
    assert.equal(getCharacterLoraKey({ name: 'User', avatar: 'user' }, getId), 'character:user');
});

test('saving a captured identity preserves unrelated bindings and never shares returned records', () => {
    const settings = fixture();
    saveCharacterLora(settings, 'character:b.png', { name: 'b.safetensors' });
    const saved = saveCharacterLora(settings, 'character:a.png', { name: 'updated-a.safetensors', strengthModel: 0 });
    saved.name = 'external-mutation';
    assert.equal(settings.characterLoras['character:a.png'].name, 'updated-a.safetensors');
    assert.equal(settings.characterLoras['character:b.png'].name, 'b.safetensors');
    assert.equal(settings.characterLoras['character:a.png'].strengthModel, 0);
    assert.throws(() => saveCharacterLora(settings, '__proto__', {}), { code: 'CHARACTER_LORA_IDENTITY_INVALID' });
});

test('a single visible enabled identity loads its LoRA and trigger words without mutating inputs', () => {
    const settings = fixture({ triggerWords: 'actor_token, adult', strengthModel: 0, strengthClip: 2 });
    const actors = [actor('character:a.png')];
    const original = JSON.stringify({ settings, actors });
    const result = selectCharacterLoras(settings, actors, comfy);
    assert.equal(result.loras.length, 1);
    assert.equal(result.loras[0].identityId, 'character:a.png');
    assert.equal(result.loras[0].name, 'people/actor-a.safetensors');
    assert.equal(result.loras[0].strengthModel, 0);
    assert.equal(result.loras[0].strengthClip, 2);
    assert.equal(result.loras[0].triggerWords, 'actor_token, adult');
    assert.deepEqual(result.warnings, []);
    result.loras[0].name = 'external-change';
    assert.equal(JSON.stringify({ settings, actors }), original);
});

test('duplicate references for one visible actor do not count as separate people', () => {
    const result = selectCharacterLoras(fixture(), [actor('character:a.png'), actor('character:a.png')], comfy);
    assert.equal(result.loras.length, 1);
});

test('two visible people skip every character LoRA, including when only one is bound', () => {
    const settings = fixture();
    const result = selectCharacterLoras(settings, [actor('character:a.png'), actor('character:b.png')], comfy);
    assert.deepEqual(result.loras, []);
    assert.match(result.warnings.join(' '), /多位人物.*跳过/);
    saveCharacterLora(settings, 'character:b.png', { enabled: true, name: 'b.safetensors' });
    assert.deepEqual(selectCharacterLoras(settings, [actor('character:a.png'), actor('character:b.png')], comfy).loras, []);
});

test('an unmatched visible person or User also prevents a whole-frame actor LoRA', () => {
    const settings = fixture();
    for (const other of [actor('user'), { identityName: 'Unmatched visible person' }, { identityId: null }]) {
        const result = selectCharacterLoras(settings, [actor('character:a.png'), other], comfy);
        assert.deepEqual(result.loras, []);
        assert.match(result.warnings.join(' '), /多位人物/);
    }
});

test('explicitly absent actors cannot suppress a valid single-person binding', () => {
    const result = selectCharacterLoras(fixture(), [actor('character:a.png'), { ...actor('user'), visible: false }], comfy);
    assert.equal(result.loras.length, 1);
});

test('disabled and unrelated identities add no LoRA and do not warn on unsupported backends', () => {
    const settings = fixture({ enabled: false });
    assert.deepEqual(selectCharacterLoras(settings, [actor('character:a.png')], { backend: 'openai' }), { loras: [], warnings: [] });
    assert.deepEqual(selectCharacterLoras(fixture(), [actor('character:b.png')], comfy), { loras: [], warnings: [] });
    assert.deepEqual(selectCharacterLoras(fixture(), [], comfy), { loras: [], warnings: [] });
});

test('unsupported backends and custom workflows warn without blocking ordinary generation', () => {
    for (const options of [{ backend: 'openai', preset: 'sd-text' }, { backend: 'sd', preset: 'sd-img2img' },
        { backend: 'comfyui', preset: 'custom' }, { backend: 'comfyui', preset: null }]) {
        const result = selectCharacterLoras(fixture(), [actor('character:a.png')], options);
        assert.deepEqual(result.loras, []);
        assert.match(result.warnings.join(' '), /仅支持 ComfyUI 内置工作流/);
    }
});

test('SD and Qwen LoRA families cannot cross their underlying workflow types', () => {
    const actors = [actor('character:a.png')];
    const sdToQwen = selectCharacterLoras(fixture(), actors, { backend: 'comfyui', preset: 'qwen-edit' });
    assert.deepEqual(sdToQwen.loras, []);
    assert.match(sdToQwen.warnings.join(' '), /类别不一致/);
    const qwen = fixture({ family: 'qwen' });
    assert.equal(selectCharacterLoras(qwen, actors, { backend: 'comfyui', preset: 'qwen-edit' }).loras.length, 1);
    assert.deepEqual(selectCharacterLoras(qwen, actors, comfy).loras, []);
    assert.equal(selectCharacterLoras(fixture(), actors, { backend: 'comfyui', preset: 'sd-img2img' }).loras.length, 1);
});

test('enabled bindings with no filename report a clear configuration error', () => {
    const settings = { characterLoras: { 'character:a.png': { ...DEFAULT_CHARACTER_LORA, enabled: true } } };
    const result = selectCharacterLoras(settings, [actor('character:a.png')], comfy);
    assert.deepEqual(result.loras, []);
    assert.match(result.warnings.join(' '), /未填写模型文件名/);
    assert.throws(() => saveCharacterLora({}, 'user', { enabled: true }), { code: 'CHARACTER_LORA_NAME_REQUIRED' });
});

test('nonfinite, out-of-range and string strengths are rejected instead of silently loading defaults', () => {
    for (const value of [-1, 2.01, NaN, Infinity, '0.8', null]) {
        assert.throws(() => saveCharacterLora({}, 'user', { name: 'a.safetensors', strengthModel: value }), { code: 'CHARACTER_LORA_STRENGTH_INVALID' });
        const settings = fixture();
        settings.characterLoras['character:a.png'].strengthModel = value;
        const result = selectCharacterLoras(settings, [actor('character:a.png')], comfy);
        assert.deepEqual(result.loras, []);
        assert.match(result.warnings.join(' '), /强度/);
    }
});

test('model names must remain bounded relative files, while ordinary trigger text is literal', () => {
    for (const name of ['../a.safetensors', 'x/../a.safetensors', '/a.safetensors', 'C:\\models\\a.safetensors',
        'https://host/a.safetensors', 'a\u0000.safetensors', 'x'.repeat(241)]) {
        assert.throws(() => saveCharacterLora({}, 'user', { name }), { code: 'CHARACTER_LORA_INVALID' });
    }
    const settings = {};
    const triggerWords = '<img src=x onerror=alert(1)>, literal token';
    const saved = saveCharacterLora(settings, 'user', { name: 'folder\\a.safetensors', triggerWords });
    assert.equal(saved.triggerWords, triggerWords);
    assert.throws(() => saveCharacterLora(settings, 'user', { triggerWords: 'x'.repeat(201) }), { code: 'CHARACTER_LORA_TRIGGER_INVALID' });
});

test('inherited binding data cannot opt a character into loading', () => {
    const settings = { characterLoras: Object.create({ 'character:a.png': { ...DEFAULT_CHARACTER_LORA, name: 'a.safetensors', enabled: true } }) };
    assert.equal(readCharacterLora(settings, 'character:a.png').enabled, false);
    assert.deepEqual(selectCharacterLoras(settings, [actor('character:a.png')], comfy), { loras: [], warnings: [] });
});
