import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createComfySetupUI } from '../src/comfy-setup-ui.js';
import { readComfyCapabilities, inspectComfyCapabilities } from '../src/comfy-presets.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const emptyModels = () => ({ checkpoints: [], unets: [], clips: [], vaes: [], loras: [] });
const installed = () => ({
    checkpoints: ['installed.safetensors'], unets: ['qwen.safetensors'],
    clips: ['text.safetensors'], vaes: ['vae.safetensors'], loras: ['style/example.safetensors'],
});

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function jqueryAdapter() {
    const controls = new Map();
    const events = [];
    const document = { defaultView: { CustomEvent: class {
        constructor(type, options) { this.type = type; Object.assign(this, options); }
    } } };
    const $ = html => {
        const id = html.match(/id="([^"]+)"/)?.[1];
        const control = {
            html, attrs: {}, properties: {}, handlers: new Map(), children: [], value: '', content: '', visible: true,
            0: { ownerDocument: document, dispatchEvent: event => { events.push(event); return true; } },
            append(...values) { this.children.push(...values); for (const value of values) if (value && typeof value === 'object') value.parent = this; return this; },
            empty() { this.children = []; this.value = ''; return this; },
            text(value) { if (!arguments.length) return this.content; this.content = String(value); return this; },
            val(value) { if (!arguments.length) return this.value; this.value = value; return this; },
            attr(key, value) { if (arguments.length === 1) return this.attrs[key]; this.attrs[key] = value; return this; },
            prop(key, value) { if (arguments.length === 1) return this.properties[key]; this.properties[key] = value; return this; },
            toggle(value) { this.visible = !!value; return this; },
            remove() { this.removed = true; return this; },
            on(names, callback) { for (const name of names.split(' ')) this.handlers.set(name, callback); return this; },
            fire(name) { return this.handlers.get(name)?.call(this); },
        };
        if (id) controls.set(id, control);
        return control;
    };
    return { $, controls, events };
}

function fixture({ initial = {}, read, inspect } = {}) {
    const adapter = jqueryAdapter();
    const settings = {
        backend: 'comfyui', backendUrl: 'http://comfy.test', comfyPreset: 'custom', comfySamplingProfile: 'standard',
        comfyWorkflow: '{"original":"custom workflow"}', comfyPositiveNodeId: '91',
        comfyNegativeNodeId: '92', comfyImageNodeId: '93', stylePreset: 'reference',
        comfyCheckpoint: '', comfyUnet: '', comfyClip: '', comfyVae: '',
        comfySteps: '', comfyCfg: '', comfySeed: '', comfyDenoise: '', ...initial,
    };
    const state = { calls: [], saves: 0, changes: [] };
    const api = createComfySetupUI({
        $: adapter.$, settings, getSettings: () => settings,
        saveSettings: () => { state.saves++; }, onChange: event => state.changes.push(event),
        readCapabilities: async (s, options) => {
            state.calls.push({ settings: s, ...options });
            return read ? read(s, options) : { models: installed() };
        },
        inspectCapabilities: inspect || (info => ({ ready: true, missingNodes: [], missingModels: [], models: info.models || emptyModels() })),
    });
    const control = id => adapter.controls.get(`rpig-${id}`);
    const choose = (key, value) => { control(key).val(value); return control(key).fire('change'); };
    return { api, settings, state, control, choose, events: adapter.events };
}

test('initial mounting and preset changes never probe the server or replace custom workflow data', () => {
    const f = fixture();
    const original = Object.fromEntries(['comfyWorkflow', 'comfyPositiveNodeId', 'comfyNegativeNodeId', 'comfyImageNodeId'].map(key => [key, f.settings[key]]));
    for (const preset of ['sd-text', 'sd-img2img', 'qwen-edit', 'custom']) f.choose('comfy-preset', preset);
    assert.equal(f.state.calls.length, 0);
    assert.equal(f.state.saves, 4);
    for (const [key, value] of Object.entries(original)) assert.equal(f.settings[key], value);
    assert.equal(f.settings.stylePreset, 'reference');
    assert.equal(f.api.presetId, 'custom');
});

test('text-only mode explicitly explains that references are ignored and leaves image settings intact', () => {
    const f = fixture({ initial: { comfyPreset: 'sd-text', useCharacterImage: true } });
    assert.match(f.control('comfy-description').text(), /仅使用文字与 LoRA.*忽略参考图/);
    assert.match(f.control('comfy-style-notice').text(), /自行切换.*跟随角色卡画风/);
    assert.equal(f.settings.stylePreset, 'reference');
    assert.equal(f.settings.useCharacterImage, true);
    assert.equal(f.state.saves, 0);
});

test('preset defaults are displayed as placeholders without overwriting empty or saved sampling settings', () => {
    const f = fixture({ initial: { comfyPreset: 'sd-img2img', comfySteps: 31, comfySeed: 0 } });
    assert.equal(f.control('comfySteps').val(), 31);
    assert.equal(f.control('comfySeed').val(), 0);
    assert.equal(f.control('comfyCfg').val(), '');
    assert.equal(f.control('comfyCfg').attr('placeholder'), 7);
    f.choose('comfy-preset', 'qwen-edit');
    assert.equal(f.control('comfySteps').val(), 31);
    assert.equal(f.control('comfyCfg').attr('placeholder'), 4);
    assert.equal(f.control('comfyDenoise').attr('placeholder'), 1);
    assert.equal(f.settings.comfyCfg, '');
    assert.equal(f.control('comfy-qwen-notice').visible, true);
});

for (const preset of ['sd-text', 'sd-img2img']) {
    test(`LCM controls for ${preset} show model-specific defaults without requesting or changing model/image settings`, () => {
        const f = fixture({ initial: { comfyPreset: preset, comfyCheckpoint: 'chosen.safetensors', useCharacterImage: true } });
        assert.equal(f.control('comfy-sampling-profile').parent.visible, true);
        assert.equal(f.control('comfySteps').attr('placeholder'), 28);
        assert.equal(f.control('comfyCfg').attr('placeholder'), 7);
        assert.match(f.control('comfy-sampling-profile').parent.children.at(-1).text(), /匹配.*LCM 权重.*不会自动加速普通 SD/);
        f.choose('comfy-sampling-profile', 'lcm');
        assert.equal(f.settings.comfySamplingProfile, 'lcm');
        assert.equal(f.control('comfySteps').attr('placeholder'), 8);
        assert.equal(f.control('comfyCfg').attr('placeholder'), 2);
        assert.equal(f.control('comfySteps').val(), ''); assert.equal(f.control('comfyCfg').val(), '');
        assert.equal(f.settings.comfyCheckpoint, 'chosen.safetensors');
        assert.equal(f.settings.comfyWorkflow, '{"original":"custom workflow"}');
        assert.equal(f.settings.stylePreset, 'reference'); assert.equal(f.settings.useCharacterImage, true);
        assert.equal(f.state.calls.length, 0);
        f.choose('comfy-sampling-profile', 'standard');
        assert.equal(f.control('comfySteps').attr('placeholder'), 28);
        assert.equal(f.control('comfyCfg').attr('placeholder'), 7);
        assert.equal(f.state.saves, 2);
    });
}

test('changing sampling profile preserves explicit steps, CFG, seed and denoise values', () => {
    const f = fixture({ initial: { comfyPreset: 'sd-img2img', comfySteps: 31, comfyCfg: 6.5, comfySeed: 0, comfyDenoise: .42 } });
    f.choose('comfy-sampling-profile', 'lcm');
    for (const [field, value] of Object.entries({ comfySteps: 31, comfyCfg: 6.5, comfySeed: 0, comfyDenoise: .42 })) {
        assert.equal(f.settings[field], value); assert.equal(f.control(field).val(), value);
    }
});

for (const preset of ['custom', 'qwen-edit']) {
    test(`LCM profile is inactive for ${preset} and does not change that workflow's defaults`, () => {
        const f = fixture({ initial: { comfyPreset: preset, comfySamplingProfile: 'lcm' } });
        assert.equal(f.control('comfy-sampling-profile').parent.visible, false);
        f.choose('comfy-sampling-profile', 'standard');
        assert.equal(f.settings.comfySamplingProfile, 'lcm'); assert.equal(f.state.saves, 0);
        if (preset === 'qwen-edit') {
            assert.equal(f.control('comfySteps').attr('placeholder'), 20);
            assert.equal(f.control('comfyCfg').attr('placeholder'), 4);
        }
    });
}

test('a malformed stored profile stays recoverable through the SD selector without silent migration', () => {
    const f = fixture({ initial: { comfyPreset: 'sd-text', comfySamplingProfile: 'legacy-unknown' } });
    assert.equal(f.control('comfy-sampling-profile').parent.visible, true);
    assert.equal(f.settings.comfySamplingProfile, 'legacy-unknown'); assert.equal(f.state.saves, 0);
    f.choose('comfy-sampling-profile', 'standard');
    assert.equal(f.settings.comfySamplingProfile, 'standard'); assert.equal(f.state.saves, 1);
});

test('successful detection supplies safe model lists but does not auto-select or overwrite missing saved models', async () => {
    const f = fixture({ initial: { comfyPreset: 'sd-text', comfyCheckpoint: 'old.safetensors' } });
    assert.equal(await f.control('comfy-check').fire('click'), true);
    assert.equal(f.state.calls.length, 1);
    assert.ok(f.state.calls[0].signal instanceof AbortSignal);
    assert.equal(f.settings.comfyCheckpoint, 'old.safetensors');
    assert.equal(f.control('comfyCheckpoint').val(), 'old.safetensors');
    assert.ok(f.control('comfyCheckpoint').children.some(option => option.text().includes('服务器未找到')));
    assert.deepEqual(f.api.models, installed());
    assert.equal(f.state.saves, 0);
    f.choose('comfyCheckpoint', 'installed.safetensors');
    assert.equal(f.settings.comfyCheckpoint, 'installed.safetensors');
    assert.equal(f.state.saves, 1);
});

test('missing nodes and model categories remain a not-ready state instead of a generic connected success', async () => {
    const f = fixture({ initial: { comfyPreset: 'qwen-edit' }, inspect: () => ({
        ready: false, missingNodes: ['TextEncodeQwenImageEditPlus.prompt'],
        missingModels: ['UNetLoader.unet_name'], models: emptyModels(),
    }) });
    await f.control('comfy-check').fire('click');
    const status = f.control('comfy-status').text();
    assert.match(status, /已连接.*尚未就绪/);
    assert.match(status, /TextEncodeQwenImageEditPlus.prompt/);
    assert.match(status, /UNetLoader.unet_name/);
    assert.doesNotMatch(status, /已就绪/);
    assert.equal(f.control('comfyUnet').children[0].text(), '服务器没有此类模型');
});

test('the production read and inspect functions populate selectors through a read-only server request', async t => {
    const calls = [];
    const info = {
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['installed.safetensors']] } } },
        UNETLoader: { input: { required: { unet_name: [['qwen.safetensors']] } } },
        CLIPLoader: { input: { required: { clip_name: [['text.safetensors']] } } },
        VAELoader: { input: { required: { vae_name: [['vae.safetensors']] } } },
        LoraLoader: { input: { required: { lora_name: [['style/example.safetensors']] } } },
        privateServerField: 'must-not-be-published',
    };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify(info), { headers: { 'Content-Type': 'application/json' } });
    });
    const f = fixture({ read: readComfyCapabilities, inspect: inspectComfyCapabilities });
    await f.control('comfy-check').fire('click');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://comfy.test/object_info');
    assert.equal(calls[0].options.method || 'GET', 'GET');
    assert.equal(calls[0].options.body, undefined);
    assert.deepEqual(f.api.models, installed());
    assert.match(f.control('comfy-status').text(), /自定义工作流仍按.*JSON 校验/);
    assert.doesNotMatch(JSON.stringify(f.events[0].detail), /must-not-be-published/);
});

test('model events carry only public endpoint and model names, never credentials or server raw payload', async () => {
    const f = fixture({ initial: {
        backendUrl: 'http://user:password@comfy.test/sub/?token=private-token#secret', backendKey: 'private-backend-key',
    }, read: async () => ({ models: installed(), secret: 'raw-server-secret' }) });
    await f.control('comfy-check').fire('click');
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].type, 'rpig:comfy-models');
    assert.equal(f.events[0].bubbles, true);
    assert.equal(f.events[0].detail.url, 'http://comfy.test/sub');
    assert.deepEqual(f.events[0].detail.models, installed());
    assert.doesNotMatch(JSON.stringify(f.events[0].detail), /password|private-token|private-backend-key|raw-server-secret/);
});

for (const [label, mutation] of [
    ['server address', f => { f.settings.backendUrl = 'http://new.test'; }],
    ['backend', f => { f.settings.backend = 'openai'; }],
    ['preset', f => { f.choose('comfy-preset', 'sd-img2img'); }],
    ['sampling profile', f => { f.choose('comfy-sampling-profile', 'lcm'); }],
]) {
    test(`changing ${label} discards and aborts an in-flight model read`, async () => {
        const pending = deferred();
        const f = fixture({ initial: { comfyPreset: 'sd-text' }, read: () => pending.promise });
        const checking = f.control('comfy-check').fire('click');
        assert.equal(f.control('comfy-check').prop('disabled'), true);
        mutation(f); f.api.refresh();
        assert.equal(f.state.calls[0].signal.aborted, true);
        pending.resolve({ models: installed() });
        assert.equal(await checking, false);
        assert.deepEqual(f.api.models, emptyModels());
        assert.equal(f.events.length, 0);
        assert.equal(f.control('comfy-check').prop('disabled'), false);
    });
}

test('a hidden SD profile change does not invalidate an active Qwen model read', async () => {
    const pending = deferred();
    const f = fixture({ initial: { comfyPreset: 'qwen-edit', comfySamplingProfile: 'lcm' }, read: () => pending.promise });
    const checking = f.control('comfy-check').fire('click');
    f.settings.comfySamplingProfile = 'standard'; f.api.refresh();
    assert.equal(f.state.calls[0].signal.aborted, false);
    pending.resolve({ models: installed() });
    assert.equal(await checking, true); assert.equal(f.events.length, 1);
});

test('a newer check wins even if an earlier aborted read returns later', async () => {
    const first = deferred(), second = deferred(); let calls = 0;
    const f = fixture({ initial: { comfyPreset: 'sd-text' }, read: () => ++calls === 1 ? first.promise : second.promise });
    const oldRead = f.control('comfy-check').fire('click');
    const newRead = f.control('comfy-check').fire('click');
    assert.equal(f.state.calls[0].signal.aborted, true);
    second.resolve({ models: { ...emptyModels(), checkpoints: ['new.safetensors'] } });
    await newRead;
    first.resolve({ models: installed() });
    assert.equal(await oldRead, false);
    assert.deepEqual(f.api.models.checkpoints, ['new.safetensors']);
    assert.equal(f.events.length, 1);
});

test('detecting a changed setting without an explicit refresh still discards a late read', async () => {
    const pending = deferred();
    const f = fixture({ read: () => pending.promise });
    const checking = f.control('comfy-check').fire('click');
    f.settings.backendUrl = 'http://changed.test';
    pending.resolve({ models: installed() });
    assert.equal(await checking, false);
    assert.equal(f.events.length, 0);
    assert.doesNotMatch(f.control('comfy-status').text(), /正在检测/);
    assert.equal(f.control('comfy-check').prop('disabled'), false);
});

test('read failures render text, redact configured keys, and recover the button', async () => {
    const f = fixture({ initial: { backendKey: 'private-backend-key' }, read: async () => {
        throw new Error('<img src=x> private-backend-key token=whatever');
    } });
    assert.equal(await f.control('comfy-check').fire('click'), false);
    assert.match(f.control('comfy-status').text(), /检测未完成/);
    assert.doesNotMatch(f.control('comfy-status').text(), /private-backend-key/);
    assert.equal(f.control('comfy-status').children.length, 0, 'Errors use text rather than an HTML insertion');
    assert.equal(f.control('comfy-check').prop('disabled'), false);
});

test('destroy aborts reading and prevents a late event or UI update', async () => {
    const pending = deferred();
    const f = fixture({ read: () => pending.promise });
    const checking = f.control('comfy-check').fire('click');
    f.api.destroy();
    assert.equal(f.state.calls[0].signal.aborted, true);
    assert.equal(f.api.element.removed, true);
    pending.resolve({ models: installed() });
    assert.equal(await checking, false);
    assert.equal(f.events.length, 0);
});

test('blank sampling fields restore preset defaults while a zero seed is retained', () => {
    const f = fixture({ initial: { comfyPreset: 'sd-img2img' } });
    f.control('comfySeed').val('0').fire('change');
    assert.equal(f.settings.comfySeed, 0);
    f.control('comfyCfg').val('5.5').fire('change');
    assert.equal(f.settings.comfyCfg, 5.5);
    f.control('comfyCfg').val('').fire('input');
    assert.equal(f.settings.comfyCfg, '');
    assert.equal(f.state.saves, 3);
});

test('settings integration keeps custom defaults and mounts all three node IDs only for custom mode', () => {
    assert.match(source, /comfyPreset:\s*'custom'/);
    assert.match(source, /comfySamplingProfile:\s*'standard'/);
    assert.match(source, /const customComfy = cur === BACKENDS\.COMFYUI && comfySetup\.presetId === 'custom'/);
    assert.match(source, /advancedDrawer\.append\([^\n]*comfyPosRow, comfyNegRow, comfyImgRow/);
    assert.match(source, /card1\.body\.append\(comfySetup\.element\)/);
});
