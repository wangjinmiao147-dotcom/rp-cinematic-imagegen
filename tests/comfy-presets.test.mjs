import test from 'node:test';
import assert from 'node:assert/strict';
import { getComfyPreset, readComfyCapabilities, inspectComfyCapabilities, buildComfyPresetWorkflow } from '../src/comfy-presets.js';
import { generateImage, SIZE_MAP } from '../src/backends.js';

const baseUrl = 'http://comfy.test';
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=', 'base64');
const png = `data:image/png;base64,${pngBytes.toString('base64')}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const imageResponse = () => new Response(pngBytes, { headers: { 'Content-Type': 'image/png' } });
const enums = (...values) => [values];
const scalar = type => [type];
const node = (required, optional = {}, output = []) => ({ input: { required, optional }, output });
const checkpoint = 'sd-model.safetensors';
const unet = 'qwen-edit.safetensors';
const clip = 'qwen-clip.safetensors';
const vae = 'qwen-vae.safetensors';
const loraName = 'identity.safetensors';
const lora = () => ({ name: loraName, strengthModel: 0.7, strengthClip: 0.4, triggerWords: 'identity_trigger' });

// The upstream API advertises accepted input names and enum values, not just
// node names. Keep those parts realistic so preflight can detect incompatible
// ComfyUI installations without submitting a model job.
function capabilities() {
    return {
        CheckpointLoaderSimple: node({ ckpt_name: enums(checkpoint) }, {}, ['MODEL', 'CLIP', 'VAE']),
        CLIPTextEncode: node({ text: scalar('STRING'), clip: scalar('CLIP') }, {}, ['CONDITIONING']),
        EmptyLatentImage: node({ width: scalar('INT'), height: scalar('INT'), batch_size: scalar('INT') }, {}, ['LATENT']),
        KSampler: node({ model: scalar('MODEL'), seed: scalar('INT'), steps: scalar('INT'), cfg: scalar('FLOAT'),
            sampler_name: enums('euler', 'lcm', 'dpmpp_2m'), scheduler: enums('simple', 'normal'), positive: scalar('CONDITIONING'),
            negative: scalar('CONDITIONING'), latent_image: scalar('LATENT'), denoise: scalar('FLOAT') }, {}, ['LATENT']),
        VAEDecode: node({ samples: scalar('LATENT'), vae: scalar('VAE') }, {}, ['IMAGE']),
        SaveImage: node({ images: scalar('IMAGE'), filename_prefix: scalar('STRING') }),
        LoadImage: node({ image: enums('one.png', 'two.png', 'three.png') }, {}, ['IMAGE', 'MASK']),
        ImageScale: node({ image: scalar('IMAGE'), upscale_method: enums('lanczos', 'bicubic', 'nearest-exact'),
            width: scalar('INT'), height: scalar('INT'), crop: enums('disabled', 'center') }, {}, ['IMAGE']),
        VAEEncode: node({ pixels: scalar('IMAGE'), vae: scalar('VAE') }, {}, ['LATENT']),
        UNETLoader: node({ unet_name: enums(unet), weight_dtype: enums('default', 'fp8_e4m3fn', 'fp8_e5m2') }, {}, ['MODEL']),
        CLIPLoader: node({ clip_name: enums(clip), type: enums('qwen_image', 'stable_diffusion') }, { device: enums('default', 'cpu') }, ['CLIP']),
        VAELoader: node({ vae_name: enums(vae) }, {}, ['VAE']),
        TextEncodeQwenImageEditPlus: node({ clip: scalar('CLIP'), prompt: scalar('STRING'), vae: scalar('VAE') },
            { image1: scalar('IMAGE'), image2: scalar('IMAGE'), image3: scalar('IMAGE') }, ['CONDITIONING']),
        ModelSamplingAuraFlow: node({ model: scalar('MODEL'), shift: scalar('FLOAT') }, {}, ['MODEL']),
        ModelSamplingDiscrete: node({ model: scalar('MODEL'), sampling: enums('eps', 'v_prediction', 'lcm'), zsnr: scalar('BOOLEAN') }, {}, ['MODEL']),
        CFGNorm: node({ model: scalar('MODEL'), strength: scalar('FLOAT') }, {}, ['MODEL']),
        LoraLoader: node({ model: scalar('MODEL'), clip: scalar('CLIP'), lora_name: enums(loraName),
            strength_model: scalar('FLOAT'), strength_clip: scalar('FLOAT') }, {}, ['MODEL', 'CLIP']),
        LoraLoaderModelOnly: node({ model: scalar('MODEL'), lora_name: enums(loraName), strength_model: scalar('FLOAT') }, {}, ['MODEL']),
    };
}

function settings(preset, extra = {}) {
    return { backend: 'comfyui', backendUrl: baseUrl, comfyPreset: preset, imageSize: '16:9',
        comfyCheckpoint: checkpoint, comfyUnet: unet, comfyClip: clip, comfyVae: vae, ...extra };
}

function nodesOf(workflow, classType) {
    return Object.entries(workflow).filter(([, value]) => value.class_type === classType)
        .map(([id, value]) => ({ id, ...value }));
}

function only(workflow, classType) {
    const nodes = nodesOf(workflow, classType);
    assert.equal(nodes.length, 1, `Expected one ${classType}`);
    return nodes[0];
}

function sourceNode(workflow, input, classType, outputSlot = 0) {
    assert.ok(Array.isArray(input) && input.length === 2, 'A typed node input must be connected');
    assert.equal(input[1], outputSlot);
    const source = workflow[input[0]];
    assert.ok(source, 'The connected node must exist');
    assert.equal(source.class_type, classType);
    return { id: String(input[0]), ...source };
}

function assertOutputChain({ workflow, outputNodeId }) {
    const output = workflow[outputNodeId];
    assert.equal(output?.class_type, 'SaveImage');
    const decode = sourceNode(workflow, output.inputs.images, 'VAEDecode');
    sourceNode(workflow, decode.inputs.samples, 'KSampler');
    return decode;
}

function refs(count) {
    return Array.from({ length: count }, (_, index) => ({
        dataUrl: `data:image/png;base64,${Buffer.concat([pngBytes, Buffer.from([index])]).toString('base64')}`,
        kind: index === 0 ? 'identity-primary' : 'identity-secondary', identityId: 'character:test', label: `View ${index + 1}`,
    }));
}

function fastPolling(t) {
    t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); return 1; });
}

function mockServer(t, { info = capabilities(), failUpload = 0, afterCapabilities, afterUpload, missingOutput = false } = {}) {
    const calls = [];
    let uploadCount = 0, submitted;
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url).endsWith('/object_info')) {
            afterCapabilities?.();
            return json(info);
        }
        if (String(url).endsWith('/upload/image')) {
            uploadCount++;
            afterUpload?.(uploadCount);
            return uploadCount === failUpload ? json({ error: 'disk full' }, 500)
                : json({ name: `view-${uploadCount}.png`, subfolder: 'rpig-input' });
        }
        if (String(url).endsWith('/prompt')) {
            submitted = JSON.parse(options.body).prompt;
            return json({ prompt_id: 'job' });
        }
        if (String(url).endsWith('/history/job')) {
            const outputId = only(submitted, 'SaveImage').id;
            const previewId = /^\d+$/.test(outputId) && Number(outputId) > 0 ? String(Number(outputId) - 1) : '0';
            return json({ job: { status: { completed: true, status_str: 'success' }, outputs: {
                [previewId]: { images: [{ filename: 'preview.png', type: 'temp' }] },
                ...(missingOutput ? {} : { [outputId]: { images: [{ filename: 'final.png', subfolder: 'results', type: 'output' }] } }),
            } } });
        }
        if (new URL(String(url)).pathname === '/view') return imageResponse();
        throw new Error(`Unexpected request: ${url}`);
    });
    return { calls, get workflow() { return submitted; }, get uploads() { return uploadCount; } };
}

test('preset metadata exposes the supported reference range and model prompt format', () => {
    for (const [id, minRefs, maxRefs, supportsReference, modelFamily, promptFormat] of [
        ['sd-text', 0, 0, false, 'sd', 'tags'], ['sd-img2img', 1, 1, true, 'sd', 'tags'],
        ['qwen-edit', 1, 3, true, 'qwen', 'natural'],
    ]) {
        const preset = getComfyPreset(id);
        assert.deepEqual([preset.id, preset.minRefs, preset.maxRefs, preset.supportsReference, preset.modelFamily, preset.promptFormat],
            [id, minRefs, maxRefs, supportsReference, modelFamily, promptFormat]);
        assert.ok(typeof preset.label === 'string' && preset.label.trim());
        assert.equal(getComfyPreset({ comfyPreset: id }).id, id);
    }
    assert.equal(getComfyPreset({}).id, 'custom', 'Existing pasted workflows keep their default path');
    assert.equal(getComfyPreset('custom').maxRefs, 1);
    assert.equal(getComfyPreset('custom').supportsReference, false);
    assert.throws(() => getComfyPreset('unknown-preset'));
});

test('SD settings expose selected sampling defaults without changing static string metadata', () => {
    for (const id of ['sd-text', 'sd-img2img']) {
        assert.equal('samplingProfile' in getComfyPreset(id), false);
        for (const [profile, steps, cfg] of [['standard', 28, 7], ['lcm', 8, 2]]) {
            const selected = getComfyPreset(settings(id, { comfySamplingProfile: profile }));
            assert.deepEqual([selected.samplingProfile, selected.defaultSteps, selected.defaultCfg], [profile, steps, cfg]);
        }
        assert.equal(getComfyPreset(settings(id)).samplingProfile, 'standard');
        assert.equal(getComfyPreset(settings(id, { comfySamplingProfile: '' })).samplingProfile, 'standard');
    }
});

test('Qwen and custom presets ignore stale SD sampling profile settings', () => {
    for (const profile of ['lcm', 'obsolete-profile', false]) for (const id of ['qwen-edit', 'custom']) {
        const configured = settings(id, { comfySamplingProfile: profile });
        assert.deepEqual(getComfyPreset(configured), getComfyPreset(id));
        const info = capabilities(); delete info.ModelSamplingDiscrete;
        info.KSampler.input.required.sampler_name = enums('euler');
        assert.equal(inspectComfyCapabilities(info, configured).ready, true);
    }
    const plain = settings('qwen-edit', { comfySeed: 31 });
    const edited = { ...plain, comfySamplingProfile: 'lcm' };
    assert.deepEqual(buildComfyPresetWorkflow(edited, { prompt: 'one person', uploadedImages: ['reference.png'] }),
        buildComfyPresetWorkflow(plain, { prompt: 'one person', uploadedImages: ['reference.png'] }));
});

test('unknown SD sampling profiles cannot silently use standard defaults', () => {
    for (const value of ['unknown', 'LCM', false, 0, {}]) for (const id of ['sd-text', 'sd-img2img']) {
        const invalid = settings(id, { comfySamplingProfile: value });
        assert.throws(() => getComfyPreset(invalid), { code: 'COMFY_CONTROL_INVALID' });
        assert.throws(() => inspectComfyCapabilities(capabilities(), invalid), { code: 'COMFY_CONTROL_INVALID' });
        assert.throws(() => buildComfyPresetWorkflow(invalid, { prompt: 'scene', uploadedImages: id === 'sd-img2img' ? ['one.png'] : [] }),
            { code: 'COMFY_CONTROL_INVALID' });
    }
});

for (const id of ['sd-text', 'sd-img2img']) test(`${id} LCM patches model sampling and uses small ratio sizes`, () => {
    for (const [ratio, expected] of [['1:1', [512, 512]], ['16:9', [768, 448]], ['9:16', [448, 768]], ['2.39:1', [768, 320]]]) {
        const built = buildComfyPresetWorkflow(settings(id, { comfySamplingProfile: 'lcm', imageSize: ratio,
            comfySteps: ' ', comfyCfg: '', comfySeed: 31 }),
        { prompt: 'scene', avoid: 'extra people', uploadedImages: id === 'sd-img2img' ? ['rpig-input/person.png'] : [] });
        const { workflow } = built;
        const sampler = only(workflow, 'KSampler');
        const patch = sourceNode(workflow, sampler.inputs.model, 'ModelSamplingDiscrete');
        sourceNode(workflow, patch.inputs.model, 'CheckpointLoaderSimple');
        assert.deepEqual([patch.inputs.sampling, patch.inputs.zsnr], ['lcm', false]);
        assert.deepEqual([sampler.inputs.sampler_name, sampler.inputs.scheduler, sampler.inputs.steps, sampler.inputs.cfg], ['lcm', 'normal', 8, 2]);
        const dimensions = only(workflow, id === 'sd-text' ? 'EmptyLatentImage' : 'ImageScale').inputs;
        assert.deepEqual([dimensions.width, dimensions.height], expected);
        assert.equal(sampler.inputs.denoise, id === 'sd-text' ? 1 : 0.6);
        assertOutputChain(built);
    }
});

test('LCM preserves explicit controls and LoRA model and CLIP bindings', () => {
    const built = buildComfyPresetWorkflow(settings('sd-img2img', { comfySamplingProfile: 'lcm', comfySteps: '15',
        comfyCfg: 2.5, comfySeed: 0, comfyDenoise: 0.8 }), { prompt: 'one person', uploadedImages: ['one.png'], loras: [lora()] });
    const { workflow } = built;
    const sampler = only(workflow, 'KSampler');
    const patch = sourceNode(workflow, sampler.inputs.model, 'ModelSamplingDiscrete');
    const adapter = sourceNode(workflow, patch.inputs.model, 'LoraLoader');
    sourceNode(workflow, adapter.inputs.model, 'CheckpointLoaderSimple');
    for (const branch of ['positive', 'negative']) {
        const text = sourceNode(workflow, sampler.inputs[branch], 'CLIPTextEncode');
        assert.equal(sourceNode(workflow, text.inputs.clip, 'LoraLoader', 1).id, adapter.id);
    }
    assert.deepEqual([sampler.inputs.steps, sampler.inputs.cfg, sampler.inputs.seed, sampler.inputs.denoise], [15, 2.5, 0, 0.8]);
    assert.match(sourceNode(workflow, sampler.inputs.positive, 'CLIPTextEncode').inputs.text, /identity_trigger/);
    assert.doesNotMatch(sourceNode(workflow, sampler.inputs.negative, 'CLIPTextEncode').inputs.text, /identity_trigger/);
});

test('standard SD profile keeps its original model sampling, dimensions and defaults', () => {
    const built = buildComfyPresetWorkflow(settings('sd-text', { comfySamplingProfile: 'standard', imageSize: '1:1' }), { prompt: 'one person' });
    const sampler = only(built.workflow, 'KSampler');
    sourceNode(built.workflow, sampler.inputs.model, 'CheckpointLoaderSimple');
    assert.equal(nodesOf(built.workflow, 'ModelSamplingDiscrete').length, 0);
    assert.deepEqual([sampler.inputs.steps, sampler.inputs.cfg, sampler.inputs.sampler_name, sampler.inputs.scheduler], [28, 7, 'euler', 'normal']);
    const latent = only(built.workflow, 'EmptyLatentImage');
    assert.deepEqual([latent.inputs.width, latent.inputs.height], [1024, 1024]);
    const noLcmNode = capabilities(); delete noLcmNode.ModelSamplingDiscrete;
    noLcmNode.KSampler.input.required.sampler_name = enums('euler');
    assert.equal(inspectComfyCapabilities(noLcmNode, settings('sd-text')).ready, true);
});

for (const [description, mutate] of [
    ['missing model patch node', info => { delete info.ModelSamplingDiscrete; }],
    ['missing sampling input', info => { delete info.ModelSamplingDiscrete.input.required.sampling; }],
    ['missing zsnr input', info => { delete info.ModelSamplingDiscrete.input.required.zsnr; }],
    ['wrong model input type', info => { info.ModelSamplingDiscrete.input.required.model = scalar('CLIP'); }],
    ['wrong zsnr input type', info => { info.ModelSamplingDiscrete.input.required.zsnr = scalar('FLOAT'); }],
    ['unsupported model sampling enum', info => { info.ModelSamplingDiscrete.input.required.sampling = enums('eps'); }],
    ['unsupported LCM sampler enum', info => { info.KSampler.input.required.sampler_name = enums('euler'); }],
    ['unsupported normal scheduler enum', info => { info.KSampler.input.required.scheduler = enums('simple'); }],
]) test(`LCM preflight rejects ${description}`, () => {
    const info = capabilities(); mutate(info);
    const result = inspectComfyCapabilities(info, settings('sd-img2img', { comfySamplingProfile: 'lcm' }));
    assert.equal(result.ready, false);
    assert.ok(result.missingNodes.length > 0);
});

for (const id of ['sd-text', 'sd-img2img']) test(`actual ${id} LCM request submits its selected sampling profile`, async t => {
    fastPolling(t);
    const server = mockServer(t);
    const result = await generateImage(settings(id, { comfySamplingProfile: 'lcm', imageSize: '1:1' }), 'one person', '',
        id === 'sd-img2img' ? refs(1) : []);
    assert.equal(result.dataUrl, png);
    assert.equal(server.uploads, id === 'sd-img2img' ? 1 : 0);
    assert.equal(server.calls.filter(call => call.url.endsWith('/prompt')).length, 1);
    const sampler = only(server.workflow, 'KSampler');
    assert.deepEqual([sampler.inputs.sampler_name, sampler.inputs.scheduler, sampler.inputs.steps, sampler.inputs.cfg], ['lcm', 'normal', 8, 2]);
    sourceNode(server.workflow, sampler.inputs.model, 'ModelSamplingDiscrete');
});

for (const missing of ['node', 'sampler']) test(`actual missing LCM ${missing} blocks reference uploads and paid submission`, async t => {
    const info = capabilities();
    if (missing === 'node') delete info.ModelSamplingDiscrete;
    else info.KSampler.input.required.sampler_name = enums('euler');
    const server = mockServer(t, { info });
    await assert.rejects(generateImage(settings('sd-img2img', { comfySamplingProfile: 'lcm' }), 'one person', '', refs(1)));
    assert.deepEqual(server.calls.map(call => new URL(call.url).pathname), ['/object_info']);
    assert.equal(server.workflow, undefined);
});

test('actual unknown SD sampling profile is rejected before all network requests', async t => {
    const server = mockServer(t);
    await assert.rejects(generateImage(settings('sd-img2img', { comfySamplingProfile: 'broken' }), 'one person', '', refs(1)),
        { code: 'COMFY_CONTROL_INVALID' });
    assert.equal(server.calls.length, 0);
});

test('capability discovery reads raw object_info once and forwards cancellation', async t => {
    const info = capabilities();
    const controller = new AbortController();
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return json(info); });
    assert.deepEqual(await readComfyCapabilities(settings('qwen-edit', { backendUrl: `${baseUrl}/` }), { signal: controller.signal }), info);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${baseUrl}/object_info`);
    assert.ok(calls[0].options.signal);
    controller.abort();
    assert.equal(calls[0].options.signal.aborted, true);
});

test('capability discovery cannot treat an HTTP error as a ready server', async t => {
    t.mock.method(globalThis, 'fetch', async () => json({ error: 'unavailable' }, 503));
    await assert.rejects(readComfyCapabilities(settings('sd-text')));
});

test('capability discovery honors an already cancelled request without contacting the server', async t => {
    let count = 0;
    t.mock.method(globalThis, 'fetch', async () => { count++; return json(capabilities()); });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(readComfyCapabilities(settings('qwen-edit'), { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(count, 0);
});

test('preflight exposes upstream model inventories and accepts installed SD and Qwen graphs', () => {
    for (const id of ['sd-text', 'sd-img2img', 'qwen-edit']) {
        const result = inspectComfyCapabilities(capabilities(), settings(id));
        assert.equal(result.ready, true, id);
        assert.deepEqual(result.missingNodes, []);
        assert.deepEqual(result.missingModels, []);
        assert.deepEqual(result.models, { checkpoints: [checkpoint], unets: [unet], clips: [clip], vaes: [vae], loras: [loraName] });
    }
});

test('unused LoRA and image-edit nodes are not required by SD text generation', () => {
    const info = capabilities();
    for (const name of ['LoadImage', 'ImageScale', 'VAEEncode', 'LoraLoader', 'LoraLoaderModelOnly',
        'UNETLoader', 'CLIPLoader', 'VAELoader', 'TextEncodeQwenImageEditPlus', 'ModelSamplingAuraFlow', 'CFGNorm']) delete info[name];
    assert.equal(inspectComfyCapabilities(info, settings('sd-text')).ready, true);
    const withLora = inspectComfyCapabilities(info, settings('sd-text'), { loras: [lora()] });
    assert.equal(withLora.ready, false);
    assert.ok(withLora.missingNodes.length > 0);
});

test('a selected missing checkpoint cannot pass preflight using another installed model', () => {
    const result = inspectComfyCapabilities(capabilities(), settings('sd-text', { comfyCheckpoint: 'missing.safetensors' }));
    assert.equal(result.ready, false);
    assert.ok(result.missingModels.length > 0);
});

for (const [description, mutate] of [
    ['missing Qwen edit node', info => { delete info.TextEncodeQwenImageEditPlus; }],
    ['missing optional third image input', info => { delete info.TextEncodeQwenImageEditPlus.input.optional.image3; }],
    ['wrong typed image input', info => { info.TextEncodeQwenImageEditPlus.input.optional.image2 = scalar('MASK'); }],
    ['unsupported Qwen CLIP type enum', info => { info.CLIPLoader.input.required.type = enums('stable_diffusion'); }],
    ['missing sampler latent input', info => { delete info.KSampler.input.required.latent_image; }],
    ['unsupported Euler sampler enum', info => { info.KSampler.input.required.sampler_name = enums('dpmpp_2m'); }],
    ['unsupported simple scheduler enum', info => { info.KSampler.input.required.scheduler = enums('normal'); }],
    ['unsupported reference resize method', info => { info.ImageScale.input.required.upscale_method = enums('nearest-exact'); }],
    ['unsupported reference crop mode', info => { info.ImageScale.input.required.crop = enums('center'); }],
    ['missing selected UNet', info => { info.UNETLoader.input.required.unet_name = enums('other.safetensors'); }],
    ['missing selected CLIP', info => { info.CLIPLoader.input.required.clip_name = enums('other.safetensors'); }],
    ['missing selected VAE', info => { info.VAELoader.input.required.vae_name = enums('other.safetensors'); }],
]) test(`Qwen preflight rejects ${description}`, () => {
    const info = capabilities(); mutate(info);
    const result = inspectComfyCapabilities(info, settings('qwen-edit'));
    assert.equal(result.ready, false);
    assert.ok(result.missingNodes.length + result.missingModels.length > 0);
});

test('selected LoRA must be installed and have the node required by its model family', () => {
    for (const [id, loader] of [['sd-text', 'LoraLoader'], ['qwen-edit', 'LoraLoaderModelOnly']]) {
        assert.equal(inspectComfyCapabilities(capabilities(), settings(id), { loras: [lora()] }).ready, true);
        const missingNode = capabilities(); delete missingNode[loader];
        assert.equal(inspectComfyCapabilities(missingNode, settings(id), { loras: [lora()] }).ready, false);
        assert.equal(inspectComfyCapabilities(capabilities(), settings(id), { loras: [{ ...lora(), name: 'missing.safetensors' }] }).ready, false);
    }
});

test('SD text workflow connects both conditioning branches and the checkpoint VAE to the saved output', () => {
    const built = buildComfyPresetWorkflow(settings('sd-text'), { prompt: 'portrait, looking at a key', avoid: 'extra key' });
    const { workflow } = built, loader = only(workflow, 'CheckpointLoaderSimple'), sampler = only(workflow, 'KSampler');
    assert.equal(loader.inputs.ckpt_name, checkpoint);
    assert.equal(sourceNode(workflow, sampler.inputs.model, 'CheckpointLoaderSimple').id, loader.id);
    const positive = sourceNode(workflow, sampler.inputs.positive, 'CLIPTextEncode');
    const negative = sourceNode(workflow, sampler.inputs.negative, 'CLIPTextEncode');
    assert.notEqual(positive.id, negative.id);
    assert.equal(positive.inputs.text, 'portrait, looking at a key');
    assert.equal(negative.inputs.text, 'extra key');
    sourceNode(workflow, positive.inputs.clip, 'CheckpointLoaderSimple', 1);
    sourceNode(workflow, negative.inputs.clip, 'CheckpointLoaderSimple', 1);
    const latent = sourceNode(workflow, sampler.inputs.latent_image, 'EmptyLatentImage');
    assert.deepEqual([latent.inputs.width, latent.inputs.height, latent.inputs.batch_size], [1344, 768, 1]);
    const decode = assertOutputChain(built);
    sourceNode(workflow, decode.inputs.vae, 'CheckpointLoaderSimple', 2);
    assert.equal(nodesOf(workflow, 'LoadImage').length, 0);
    assert.equal(nodesOf(workflow, 'LoraLoader').length + nodesOf(workflow, 'LoraLoaderModelOnly').length, 0);
});

test('SD img2img uses the uploaded subfolder path, scaled dimensions and encoded latent', () => {
    const built = buildComfyPresetWorkflow(settings('sd-img2img', { imageSize: '9:16' }),
        { prompt: 'holding one key', avoid: '', uploadedImages: ['rpig-input/reference.png'] });
    const { workflow } = built, sampler = only(workflow, 'KSampler');
    const encode = sourceNode(workflow, sampler.inputs.latent_image, 'VAEEncode');
    const scale = sourceNode(workflow, encode.inputs.pixels, 'ImageScale');
    const load = sourceNode(workflow, scale.inputs.image, 'LoadImage');
    assert.equal(load.inputs.image, 'rpig-input/reference.png');
    assert.deepEqual([scale.inputs.width, scale.inputs.height], SIZE_MAP['9:16'].sd);
    sourceNode(workflow, encode.inputs.vae, 'CheckpointLoaderSimple', 2);
    assert.equal(sampler.inputs.denoise, 0.6);
    assert.equal(nodesOf(workflow, 'EmptyLatentImage').length, 0);
    assertOutputChain(built);
});

test('empty controls retain preset defaults; explicit sampler controls reach the graph', () => {
    for (const [id, images, steps, cfg, denoise] of [
        ['sd-text', [], 28, 7, 1], ['sd-img2img', ['reference.png'], 28, 7, 0.6], ['qwen-edit', ['reference.png'], 20, 4, 1],
    ]) {
        const empty = buildComfyPresetWorkflow(settings(id, { comfySteps: '', comfyCfg: '', comfySeed: '', comfyDenoise: '' }),
            { prompt: 'scene', avoid: '', uploadedImages: images });
        const sampler = only(empty.workflow, 'KSampler');
        assert.deepEqual([sampler.inputs.steps, sampler.inputs.cfg, sampler.inputs.denoise], [steps, cfg, denoise]);
        const explicit = buildComfyPresetWorkflow(settings(id, { comfySteps: 31, comfyCfg: 5.5, comfySeed: 1234, comfyDenoise: 0.8 }),
            { prompt: 'scene', avoid: '', uploadedImages: images });
        const controls = only(explicit.workflow, 'KSampler').inputs;
        assert.deepEqual([controls.steps, controls.cfg, controls.seed, controls.denoise], [31, 5.5, 1234, id === 'sd-text' ? 1 : 0.8]);
    }
    const zeroSeed = buildComfyPresetWorkflow(settings('sd-img2img', { comfySeed: 0, comfyDenoise: 0 }),
        { prompt: 'scene', avoid: '', uploadedImages: ['reference.png'] });
    assert.deepEqual([only(zeroSeed.workflow, 'KSampler').inputs.seed, only(zeroSeed.workflow, 'KSampler').inputs.denoise], [0, 0]);
});

for (const count of [1, 2, 3]) test(`Qwen ${count}-image graph gives both conditioning branches every original image`, () => {
    const images = Array.from({ length: count }, (_, index) => `rpig-input/view-${index + 1}.png`);
    const built = buildComfyPresetWorkflow(settings('qwen-edit', { imageSize: '9:16', qwenResolution: '1024x576' }),
        { prompt: 'Show the character touching the door.', avoid: 'extra person', uploadedImages: images });
    const { workflow } = built, sampler = only(workflow, 'KSampler');
    const positive = sourceNode(workflow, sampler.inputs.positive, 'TextEncodeQwenImageEditPlus');
    const negative = sourceNode(workflow, sampler.inputs.negative, 'TextEncodeQwenImageEditPlus');
    assert.notEqual(positive.id, negative.id);
    assert.equal(positive.inputs.prompt, 'Show the character touching the door.');
    assert.equal(negative.inputs.prompt, 'extra person');
    assert.equal(nodesOf(workflow, 'LoadImage').length, count);
    for (const branch of [positive, negative]) {
        sourceNode(workflow, branch.inputs.clip, 'CLIPLoader');
        sourceNode(workflow, branch.inputs.vae, 'VAELoader');
        for (let index = 1; index <= count; index++) {
            const load = sourceNode(workflow, branch.inputs[`image${index}`], 'LoadImage');
            assert.equal(load.inputs.image, images[index - 1], 'Conditioning must use the original image, not a resized composite');
            assert.deepEqual(branch.inputs[`image${index}`], positive.inputs[`image${index}`]);
        }
        for (let index = count + 1; index <= 3; index++) assert.equal(branch.inputs[`image${index}`], undefined);
    }
    const encode = sourceNode(workflow, sampler.inputs.latent_image, 'VAEEncode');
    const scale = sourceNode(workflow, encode.inputs.pixels, 'ImageScale');
    assert.deepEqual(scale.inputs.image, positive.inputs.image1);
    assert.deepEqual([scale.inputs.width, scale.inputs.height], [288, 512], 'Qwen preset stays on the fixed 512 tier');
    sourceNode(workflow, encode.inputs.vae, 'VAELoader');
    const norm = sourceNode(workflow, sampler.inputs.model, 'CFGNorm');
    assert.equal(norm.inputs.strength, 1);
    const sampling = sourceNode(workflow, norm.inputs.model, 'ModelSamplingAuraFlow');
    assert.equal(sampling.inputs.shift, 3);
    const model = sourceNode(workflow, sampling.inputs.model, 'UNETLoader');
    assert.equal(model.inputs.unet_name, unet);
    assert.equal(only(workflow, 'CLIPLoader').inputs.type, 'qwen_image');
    assert.equal(only(workflow, 'CLIPLoader').inputs.clip_name, clip);
    assert.equal(only(workflow, 'VAELoader').inputs.vae_name, vae);
    assert.deepEqual([sampler.inputs.sampler_name, sampler.inputs.scheduler], ['euler', 'simple']);
    assertOutputChain(built);
    assert.equal(nodesOf(workflow, 'LoraLoader').length + nodesOf(workflow, 'LoraLoaderModelOnly').length, 0);
});

test('SD LoRA transforms both model and CLIP while retaining the checkpoint VAE', () => {
    const built = buildComfyPresetWorkflow(settings('sd-text'), { prompt: 'portrait', avoid: 'extra body', loras: [lora()] });
    const { workflow } = built, adapter = only(workflow, 'LoraLoader'), sampler = only(workflow, 'KSampler');
    sourceNode(workflow, adapter.inputs.model, 'CheckpointLoaderSimple');
    sourceNode(workflow, adapter.inputs.clip, 'CheckpointLoaderSimple', 1);
    assert.deepEqual([adapter.inputs.lora_name, adapter.inputs.strength_model, adapter.inputs.strength_clip], [loraName, 0.7, 0.4]);
    assert.equal(sourceNode(workflow, sampler.inputs.model, 'LoraLoader').id, adapter.id);
    for (const branch of ['positive', 'negative']) {
        const text = sourceNode(workflow, sampler.inputs[branch], 'CLIPTextEncode');
        assert.equal(sourceNode(workflow, text.inputs.clip, 'LoraLoader', 1).id, adapter.id);
        assert.equal(text.inputs.text.includes('identity_trigger'), branch === 'positive');
    }
    const decode = assertOutputChain(built);
    sourceNode(workflow, decode.inputs.vae, 'CheckpointLoaderSimple', 2);
    assert.equal(nodesOf(workflow, 'LoraLoaderModelOnly').length, 0);
});

test('Qwen LoRA transforms the UNet only and appends triggers only to positive conditioning', () => {
    const built = buildComfyPresetWorkflow(settings('qwen-edit'), { prompt: 'Show one person.', avoid: 'extra body',
        uploadedImages: ['reference.png'], loras: [lora()] });
    const { workflow } = built, adapter = only(workflow, 'LoraLoaderModelOnly');
    sourceNode(workflow, adapter.inputs.model, 'UNETLoader');
    assert.deepEqual([adapter.inputs.lora_name, adapter.inputs.strength_model], [loraName, 0.7]);
    assert.equal(adapter.inputs.clip, undefined);
    assert.equal(adapter.inputs.strength_clip, undefined);
    const sampler = only(workflow, 'KSampler');
    const norm = sourceNode(workflow, sampler.inputs.model, 'CFGNorm');
    const sampling = sourceNode(workflow, norm.inputs.model, 'ModelSamplingAuraFlow');
    assert.equal(sourceNode(workflow, sampling.inputs.model, 'LoraLoaderModelOnly').id, adapter.id);
    for (const branch of ['positive', 'negative']) {
        const text = sourceNode(workflow, sampler.inputs[branch], 'TextEncodeQwenImageEditPlus');
        sourceNode(workflow, text.inputs.clip, 'CLIPLoader');
        assert.equal(text.inputs.prompt.includes('identity_trigger'), branch === 'positive');
    }
    assert.equal(nodesOf(workflow, 'LoraLoader').length, 0);
    assertOutputChain(built);
});

test('workflow building rejects invalid image capacity and multiple LoRAs without truncation', () => {
    for (const [id, images] of [['sd-text', ['one.png']], ['sd-img2img', []], ['sd-img2img', ['one.png', 'two.png']],
        ['qwen-edit', []], ['qwen-edit', ['one.png', 'two.png', 'three.png', 'four.png']]]) {
        assert.throws(() => buildComfyPresetWorkflow(settings(id), { prompt: 'scene', avoid: '', uploadedImages: images }));
    }
    assert.throws(() => buildComfyPresetWorkflow(settings('sd-text'), { prompt: 'scene', avoid: '', loras: [lora(), lora()] }));
});

test('new preset graphs retain no LoRA or reference slots from a previous request and never mutate their inputs', () => {
    const config = Object.freeze(settings('qwen-edit'));
    const images = Object.freeze(['one.png', 'two.png', 'three.png']);
    const selectedLoras = Object.freeze([Object.freeze(lora())]);
    const original = JSON.stringify({ config, images, selectedLoras });
    const first = buildComfyPresetWorkflow(config, { prompt: 'First scene.', avoid: 'first negative', uploadedImages: images, loras: selectedLoras });
    const firstSnapshot = JSON.stringify(first);
    const next = buildComfyPresetWorkflow(config, { prompt: 'Next scene.', avoid: '', uploadedImages: ['next.png'] });
    assert.equal(JSON.stringify({ config, images, selectedLoras }), original);
    assert.equal(JSON.stringify(first), firstSnapshot, 'The next request must not rewrite the prior graph');
    assert.notEqual(first.workflow, next.workflow);
    assert.equal(nodesOf(next.workflow, 'LoraLoaderModelOnly').length, 0);
    assert.equal(nodesOf(next.workflow, 'LoadImage').length, 1);
    const sampler = only(next.workflow, 'KSampler');
    for (const branch of ['positive', 'negative']) {
        const text = sourceNode(next.workflow, sampler.inputs[branch], 'TextEncodeQwenImageEditPlus');
        assert.equal(text.inputs.image2, undefined);
        assert.equal(text.inputs.image3, undefined);
        assert.doesNotMatch(text.inputs.prompt, /identity_trigger|First scene|first negative/);
    }
});

test('actual three-reference Qwen generation preflights, uploads every distinct image, then submits and reads only SaveImage', async t => {
    fastPolling(t);
    t.mock.method(Date, 'now', () => 1700000000000);
    const server = mockServer(t), selected = refs(3);
    const result = await generateImage(settings('qwen-edit', { stylePreset: 'reference' }),
        'Show the character holding one key.', 'extra key', selected);
    assert.equal(result.dataUrl, png);
    assert.equal(result.usedRefs, true);
    assert.deepEqual(server.calls.map(call => new URL(call.url).pathname),
        ['/object_info', '/upload/image', '/upload/image', '/upload/image', '/prompt', '/history/job', '/view']);
    const uploads = server.calls.filter(call => call.url.endsWith('/upload/image'));
    const filenames = [];
    for (const [index, call] of uploads.entries()) {
        const file = call.options.body.get('image');
        filenames.push(file.name);
        assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'), selected[index].dataUrl.split(',')[1]);
        assert.equal(call.options.body.get('overwrite'), 'false');
    }
    assert.equal(new Set(filenames).size, 3, 'Separate uploads cannot overwrite another reference');
    const sampler = only(server.workflow, 'KSampler');
    for (const branch of ['positive', 'negative']) {
        const text = sourceNode(server.workflow, sampler.inputs[branch], 'TextEncodeQwenImageEditPlus');
        for (let index = 1; index <= 3; index++) assert.equal(sourceNode(server.workflow, text.inputs[`image${index}`], 'LoadImage').inputs.image,
            `rpig-input/view-${index}.png`);
    }
    const downloaded = new URL(server.calls.at(-1).url);
    assert.equal(downloaded.searchParams.get('filename'), 'final.png');
    assert.equal(downloaded.searchParams.get('subfolder'), 'results');
    assert.equal(downloaded.searchParams.get('type'), 'output');
});

test('actual SD text generation needs no references or uploads and rechecks capabilities on every request', async t => {
    fastPolling(t);
    const server = mockServer(t);
    for (let index = 0; index < 2; index++) {
        const result = await generateImage(settings('sd-text'), 'A person standing at a door.', '', []);
        assert.equal(result.dataUrl, png);
        assert.equal(result.usedRefs, false);
    }
    assert.equal(server.calls.filter(call => call.url.endsWith('/object_info')).length, 2);
    assert.equal(server.uploads, 0);
    assert.equal(server.calls.filter(call => call.url.endsWith('/prompt')).length, 2);
});

test('native Qwen prepares natural instructions without SD tag suffixes or changing its ComfyUI transport', async t => {
    fastPolling(t);
    const server = mockServer(t);
    const chosen = Object.freeze(settings('qwen-edit', { stylePreset: 'reference' }));
    const instruction = 'Show the person calmly reading by a window.';
    await generateImage(chosen, instruction, '', refs(1));
    const sampler = only(server.workflow, 'KSampler');
    const positive = sourceNode(server.workflow, sampler.inputs.positive, 'TextEncodeQwenImageEditPlus').inputs.prompt;
    assert.ok(positive.includes(instruction));
    assert.equal(positive.includes(', anatomically correct hands, five fingers per hand'), false);
    assert.equal(server.calls[0].url, `${baseUrl}/object_info`);
    assert.equal(server.calls.some(call => /generateContent|chat\/completions/.test(call.url)), false);
    assert.equal(chosen.backend, 'comfyui');
});

test('actual generation passes a selected character LoRA through preflight and the workflow', async t => {
    fastPolling(t);
    const server = mockServer(t);
    await generateImage(settings('sd-text'), 'A person holding a key.', '', [], { characterLoras: [lora()] });
    assert.equal(only(server.workflow, 'LoraLoader').inputs.lora_name, loraName);
    const sampler = only(server.workflow, 'KSampler');
    assert.match(sourceNode(server.workflow, sampler.inputs.positive, 'CLIPTextEncode').inputs.text, /identity_trigger/);
});

test('an explicitly selected ComfyUI preset cannot be rerouted by stale local Qwen bridge settings or port 8055', async t => {
    fastPolling(t);
    const server = mockServer(t);
    const result = await generateImage(settings('qwen-edit', { backendUrl: 'http://127.0.0.1:8055',
        isLocalQwenBridge: true, backendModel: 'qwen-image-2.1', qwenSceneDetail: true,
        stylePreset: 'reference', qwenResolution: '1024x576' }), 'Show one person.', '', refs(3));
    assert.equal(result.dataUrl, png);
    assert.equal(server.calls[0].url, 'http://127.0.0.1:8055/object_info');
    assert.equal(server.uploads, 3, 'The ComfyUI preset owns its reference capacity and selection');
    assert.equal(server.calls.some(call => call.url.includes('generateContent') || call.url.endsWith('/rpig-capabilities')), false);
    const scale = only(server.workflow, 'ImageScale');
    assert.deepEqual([scale.inputs.width, scale.inputs.height], [512, 288]);
});

test('an unknown explicitly selected preset cannot silently fall back to a pasted custom workflow', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected model request'); });
    await assert.rejects(generateImage(settings('unknown-preset', { comfyWorkflow: JSON.stringify({
        p: { class_type: 'CLIPTextEncode', inputs: { text: 'old scene' } },
    }) }), 'A scene.', '', []));
    assert.equal(calls, 0);
});

for (const controls of [{ comfySteps: 0 }, { comfyCfg: 'NaN' }, { comfySeed: 1.5 }, { comfyDenoise: 1.1 }]) {
    test(`malformed ${Object.keys(controls)[0]} prevents reference uploads and model submission`, async t => {
        const server = mockServer(t);
        await assert.rejects(generateImage(settings('sd-img2img', controls), 'A scene.', '', refs(1)));
        assert.deepEqual(server.calls.map(call => new URL(call.url).pathname), Object.hasOwn(controls, 'comfySteps') ? [] : ['/object_info']);
        assert.equal(server.workflow, undefined);
    });
}

for (const [id, count] of [['sd-text', 1], ['sd-img2img', 0], ['sd-img2img', 2], ['qwen-edit', 0], ['qwen-edit', 4], ['custom', 2]]) {
    test(`actual ${id} generation rejects ${count} references before contacting the server`, async t => {
        let calls = 0;
        t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected model request'); });
        await assert.rejects(generateImage(settings(id, { comfyWorkflow: JSON.stringify({
            p: { class_type: 'CLIPTextEncode', inputs: { text: '' } }, r: { class_type: 'LoadImage', inputs: { image: 'old.png' } },
        }) }), 'A scene.', '', refs(count)));
        assert.equal(calls, 0);
    });
}

test('a selected LoRA on a custom workflow fails explicitly before any network request', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected model request'); });
    await assert.rejects(generateImage(settings('custom', { comfyWorkflow: JSON.stringify({
        p: { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    }) }), 'A scene.', '', [], { characterLoras: [lora()] }));
    assert.equal(calls, 0);
});

test('a missing capability stops actual generation before image upload or workflow submission', async t => {
    const info = capabilities(); delete info.TextEncodeQwenImageEditPlus;
    const server = mockServer(t, { info });
    await assert.rejects(generateImage(settings('qwen-edit'), 'A scene.', '', refs(2)));
    assert.deepEqual(server.calls.map(call => new URL(call.url).pathname), ['/object_info']);
});

test('failure uploading the second reference stops the sequence without submitting or silently dropping images', async t => {
    const server = mockServer(t, { failUpload: 2 });
    await assert.rejects(generateImage(settings('qwen-edit'), 'A scene.', '', refs(3)));
    assert.deepEqual(server.calls.map(call => new URL(call.url).pathname), ['/object_info', '/upload/image', '/upload/image']);
    assert.equal(server.workflow, undefined);
});

for (const boundary of ['capabilities', 'first upload', 'second upload']) test(`source invalidation after ${boundary} prevents submission`, async t => {
    let current = true;
    const server = mockServer(t, {
        afterCapabilities: () => { if (boundary === 'capabilities') current = false; },
        afterUpload: count => { if (count === (boundary === 'second upload' ? 2 : 1)) current = false; },
    });
    await assert.rejects(generateImage(settings('qwen-edit'), 'A scene.', '', refs(3), {
        assertSourceValid: () => { if (!current) throw new DOMException('Source changed', 'AbortError'); },
    }), { name: 'AbortError' });
    assert.equal(server.calls.some(call => call.url.endsWith('/prompt')), false);
    assert.equal(server.uploads, boundary === 'capabilities' ? 0 : boundary === 'second upload' ? 2 : 1);
});

test('cancelling a pending reference upload stops later uploads and the model job', async t => {
    const controller = new AbortController(), calls = [];
    let started;
    const uploadStarted = new Promise(resolve => { started = resolve; });
    t.mock.method(globalThis, 'fetch', (url, options) => {
        calls.push(String(url));
        if (String(url).endsWith('/object_info')) return Promise.resolve(json(capabilities()));
        if (String(url).endsWith('/upload/image')) return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            started();
        });
        throw new Error(`Unexpected request: ${url}`);
    });
    const pending = generateImage(settings('qwen-edit'), 'A scene.', '', refs(3), { signal: controller.signal });
    await Promise.race([uploadStarted, pending.then(() => { throw new Error('Generation finished before the cancellable upload'); })]);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(calls, [`${baseUrl}/object_info`, `${baseUrl}/upload/image`]);
});

test('a completed workflow with only a preview cannot masquerade as the selected saved output', async t => {
    fastPolling(t);
    const server = mockServer(t, { missingOutput: true });
    await assert.rejects(generateImage(settings('sd-text'), 'A scene.', '', []));
    assert.equal(server.calls.some(call => call.url.includes('/view?')), false);
});
