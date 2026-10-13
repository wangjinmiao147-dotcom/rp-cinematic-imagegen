import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateComfyUIImage, generateGeminiImage, generateImage, hydrateReferenceImages } from '../src/backends.js';
import { timeoutSignal } from '../src/utils.js';
import { assembleUnifiedPrompt } from '../src/prompts.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const workflow = () => ({
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'old positive' }, _meta: { title: 'Positive prompt' } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'old negative' }, _meta: { title: 'Negative prompt' } },
    10: { class_type: 'LoadImage', inputs: { image: 'old-person.png' } },
});
const comfySettings = value => ({ backendUrl: 'http://comfy.test', comfyWorkflow: JSON.stringify(value || workflow()) });

test('native Gemini sends aspect ratio in imageConfig, as the image API expects', async t => {
    let body;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        body=JSON.parse(options.body);
        return json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'YWJj'}}]}}]});
    });
    await generateGeminiImage({backend:'gemini',backendUrl:'https://gemini.test/v1beta',backendModel:'gemini-3.1-flash-image'},'scene','16:9',[]);
    assert.equal(body.generationConfig.imageConfig.aspectRatio,'16:9');
    assert.equal(body.generationConfig.responseFormat,undefined);
});
function acceleratePolling(t, advance = () => {}) {
    t.mock.method(globalThis, 'setTimeout', callback => {
        advance();
        queueMicrotask(callback);
        return 1;
    });
}

test('LAN HTTP without SubtleCrypto can still send reference bytes to the image backend', async t => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    t.after(() => descriptor ? Object.defineProperty(globalThis, 'crypto', descriptor) : delete globalThis.crypto);
    let sent;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        sent = options.body;
        return json({ data: [{ b64_json: 'YWJj' }] });
    });
    const diagnostics = {};
    const result = await generateImage({ backend: 'openai', backendUrl: 'https://image.test/v1', backendModel: 'image', stylePreset: 'reference' },
        'The character stands by a window.', '', [{ dataUrl: png, kind: 'identity-primary' }], { diagnostics });
    assert.equal(result.usedRefs, true);
    assert.equal(Buffer.from(await sent.get('image').arrayBuffer()).toString('base64'), png.split(',')[1]);
    assert.equal(diagnostics.references[0].hash, null);
});

test('reference diagnostics retain SHA-256 whenever SubtleCrypto is available', async () => {
    const refs = await hydrateReferenceImages([{ dataUrl: png }]);
    assert.equal(refs[0].hash, createHash('sha256').update(Buffer.from(png.split(',')[1], 'base64')).digest('hex'));
});

test('a duplicate supporting record cannot erase the explicit primary identity role', async () => {
    const refs = await hydrateReferenceImages([
        { dataUrl: png, kind: 'identity-secondary', identityId: 'character:test' },
        { dataUrl: png, kind: 'identity-primary', identityId: 'character:test', isExplicitPrimary: true },
    ]);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].kind, 'identity-primary');
    assert.equal(refs[0].isExplicitPrimary, true);
});

test('cancellation during diagnostic hashing prevents a late hydrated result', async t => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const controller = new AbortController();
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async () => {
        controller.abort();
        return new Uint8Array(32).buffer;
    } } } });
    t.after(() => descriptor ? Object.defineProperty(globalThis, 'crypto', descriptor) : delete globalThis.crypto);
    await assert.rejects(hydrateReferenceImages([{ dataUrl: png }], undefined, 5, controller.signal), { name: 'AbortError' });
});

test('Gemini accepts a model resource name without duplicating its models prefix', async t => {
    let endpoint;
    t.mock.method(globalThis, 'fetch', async url => {
        endpoint = url;
        return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }] } }] });
    });
    await generateGeminiImage({ backendUrl: 'https://gemini.test/v1beta', backendModel: 'models/gemini-2.5-flash-image' }, 'scene', '16:9', []);
    assert.equal(endpoint, 'https://gemini.test/v1beta/models/gemini-2.5-flash-image:generateContent');
});

test('Gemini cannot report success for an empty inline image payload', async t => {
    t.mock.method(globalThis, 'fetch', async () => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png' } }] } }] }));
    await assert.rejects(generateGeminiImage({ backendUrl: 'https://gemini.test/v1beta' }, 'scene', '16:9', []), { code: 'GEMINI_IMAGE_INVALID' });
});

for (const mode of ['HTTP failure', 'network failure', 'empty upload filename']) {
    test(`ComfyUI ${mode} cannot submit a workflow using its old reference image`, async t => {
        const calls = [];
        t.mock.method(globalThis, 'fetch', async url => {
            calls.push(url);
            if (mode === 'network failure') throw new TypeError('Failed to fetch');
            return mode === 'HTTP failure' ? json({ error: { message: 'disk full' } }, 500) : json({});
        });
        await assert.rejects(generateComfyUIImage(comfySettings(), 'scene', '', [{ dataUrl: png }]));
        assert.deepEqual(calls, ['http://comfy.test/upload/image']);
    });
}

test('ComfyUI refuses a supplied reference when the workflow has no image input', async t => {
    const value = workflow(); delete value[10];
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected network'); });
    await assert.rejects(generateComfyUIImage(comfySettings(value), 'scene', '', [{ dataUrl: png }]), { code: 'COMFY_REFERENCE_NODE_INVALID' });
    assert.equal(calls, 0);
});

test('ComfyUI detects a positive/negative node conflict before contacting the server', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected network'); });
    await assert.rejects(generateComfyUIImage({ ...comfySettings(), comfyPositiveNodeId: '6', comfyNegativeNodeId: '6' }, 'scene', 'bad', []), { code: 'COMFY_PROMPT_NODE_CONFLICT' });
    assert.equal(calls, 0);
});

test('ComfyUI discovers the negative node with an explicit positive ID and clears stale text', async t => {
    let submitted;
    acceleratePolling(t);
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (url.endsWith('/prompt')) { submitted = JSON.parse(options.body).prompt; return json({ prompt_id: 'job' }); }
        return json({ job: { status: { completed: true, status_str: 'success' }, outputs: {} } });
    });
    await assert.rejects(generateComfyUIImage({ ...comfySettings(), comfyPositiveNodeId: '6' }, 'new scene', '', []), { code: 'COMFY_IMAGE_EMPTY' });
    assert.equal(submitted[6].inputs.text, 'new scene');
    assert.equal(submitted[7].inputs.text, '');
});

test('ComfyUI execution errors are surfaced on the first history result with keys scrubbed', async t => {
    let historyCalls = 0;
    acceleratePolling(t);
    t.mock.method(globalThis, 'fetch', async url => {
        if (url.endsWith('/prompt')) return json({ prompt_id: 'job' });
        historyCalls++;
        return json({ job: { status: { completed: false, status_str: 'error', messages: [['execution_error', { exception_message: 'missing model unit-secret' }]] }, outputs: {} } });
    });
    await assert.rejects(generateComfyUIImage({ ...comfySettings(), backendKey: 'unit-secret' }, 'scene', '', []), error => error.code === 'COMFY_EXECUTION_FAILED' && /missing model/.test(error.message) && !error.message.includes('unit-secret'));
    assert.equal(historyCalls, 1);
});

test('ComfyUI uses elapsed time for its poll deadline, including slow history fetches', async t => {
    let now = 0; let historyCalls = 0;
    t.mock.method(Date, 'now', () => now);
    acceleratePolling(t, () => { now += 2500; });
    t.mock.method(globalThis, 'fetch', async url => {
        if (url.endsWith('/prompt')) return json({ prompt_id: 'job' });
        historyCalls++; now += 140000;
        return json({});
    });
    await assert.rejects(generateComfyUIImage(comfySettings(), 'scene', '', []), /300s/);
    assert.equal(historyCalls, 3);
});

test('ComfyUI recovers from a native history timeout without treating the active job as cancelled', async t => {
    const timed = timeoutSignal(1);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(timed.reason.name, 'TimeoutError');
    const controller = new AbortController();
    let submissions = 0, historyCalls = 0;
    acceleratePolling(t);
    t.mock.method(globalThis, 'fetch', async url => {
        if (url.endsWith('/prompt')) { submissions++; return json({ prompt_id: 'job' }); }
        if (url.includes('/history/')) {
            historyCalls++;
            if (historyCalls === 1) throw timed.reason;
            return json({ job: { status: { completed: true, status_str: 'success' },
                outputs: { 9: { images: [{ filename: 'result.png', type: 'output' }] } } } });
        }
        return new Response(Buffer.from(png.split(',')[1], 'base64'), { headers: { 'Content-Type': 'image/png' } });
    });
    const result = await generateComfyUIImage(comfySettings(), 'scene', '', [], { signal: controller.signal });
    assert.equal(result.dataUrl, png);
    assert.equal(result.model, 'ComfyUI');
    assert.equal(submissions, 1, 'Polling recovery must reuse the submitted job');
    assert.equal(historyCalls, 2);
    assert.equal(controller.signal.aborted, false);
});

function sourceGuard(state) {
    return () => {
        if (!state.current) throw new DOMException('Source message changed', 'AbortError');
    };
}

test('editing the source during actual URL reference hydration prevents the paid image request', async t => {
    const state = { current: true }; let paidCalls = 0;
    t.mock.method(globalThis, 'fetch', async () => { paidCalls++; return json({ data: [{ b64_json: 'YWJj' }] }); });
    await assert.rejects(generateImage({ backend: 'openai', backendUrl: 'https://image.test/v1', backendModel: 'image' },
        'A scene.', '', [{ url: 'https://reference.test/image.png', kind: 'identity-primary' }], {
            assertSourceValid: sourceGuard(state),
            fetchToDataUrl: async () => { state.current = false; return png; },
        }), { name: 'AbortError' });
    assert.equal(paidCalls, 0);
});

test('editing the source during protocol discovery prevents the paid Chat image request', async t => {
    const state = { current: true }; const calls = [];
    t.mock.method(globalThis, 'fetch', async url => {
        calls.push(url);
        if (url.endsWith('/models')) {
            state.current = false;
            return json({ data: [{ id: 'gemini-3.1-flash-image', supported_endpoint_types: ['openai'] }] });
        }
        return json({ choices: [{ message: { images: [{ image_url: { url: png } }] } }] });
    });
    await assert.rejects(generateImage({ backend: 'openai', backendUrl: 'https://relay.test/v1', backendModel: 'gemini-3.1-flash-image' },
        'A scene.', '', [], { assertSourceValid: sourceGuard(state) }), { name: 'AbortError' });
    assert.deepEqual(calls, ['https://relay.test/v1/models']);
});

test('editing the source during bridge capabilities discovery prevents local inference', async t => {
    const state = { current: true }; const calls = [];
    t.mock.method(globalThis, 'fetch', async url => {
        calls.push(url);
        if (url.endsWith('/rpig-capabilities')) {
            state.current = false;
            return json({ bridge: 'rpig-qwen', protocol: 2, reference_order: true, explicit_dimensions: true });
        }
        return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }] } }] });
    });
    await assert.rejects(generateGeminiImage({ backendUrl: 'http://127.0.0.1:8055', backendModel: 'qwen-image' },
        'A scene.', '16:9', [], { assertSourceValid: sourceGuard(state) }), { name: 'AbortError' });
    assert.deepEqual(calls, ['http://127.0.0.1:8055/rpig-capabilities']);
});

test('editing the source during ComfyUI upload cannot submit the workflow', async t => {
    const state = { current: true }; const calls = [];
    t.mock.method(globalThis, 'fetch', async url => {
        calls.push(url);
        if (url.endsWith('/upload/image')) { state.current = false; return json({ name: 'uploaded.png' }); }
        return json({});
    });
    await assert.rejects(generateComfyUIImage(comfySettings(), 'A scene.', '', [{ dataUrl: png }],
        { assertSourceValid: sourceGuard(state) }), { name: 'AbortError' });
    assert.deepEqual(calls, ['http://comfy.test/upload/image']);
});

test('editing the source while ComfyUI waits stops polling even without aborting the shared signal', async t => {
    const state = { current: true }; const calls = [];
    acceleratePolling(t, () => { state.current = false; });
    t.mock.method(globalThis, 'fetch', async url => {
        calls.push(url);
        return url.endsWith('/prompt') ? json({ prompt_id: 'job' }) : json({ job: { status: { completed: true }, outputs: {} } });
    });
    await assert.rejects(generateComfyUIImage(comfySettings(), 'A scene.', '', [],
        { assertSourceValid: sourceGuard(state) }), { name: 'AbortError' });
    assert.deepEqual(calls, ['http://comfy.test/prompt']);
});

function bridgeFixture(t) {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
        if (url.endsWith('/rpig-capabilities')) return json({ bridge: 'rpig-qwen', protocol: 2, reference_order: true, explicit_dimensions: true });
        requests.push(JSON.parse(options.body));
        return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }] } }] });
    });
    const settings = { backend: 'gemini', backendUrl: 'http://127.0.0.1:8055/v1', backendModel: 'qwen-image',
        stylePreset: 'reference', imageSize: '16:9', qwenResolution: '512x288', qwenReferencePolicy: 'story' };
    return { settings, requests, images: () => requests[0].contents[0].parts.filter(part => part.inlineData) };
}

function distinctReference(index, name, kind = 'identity-primary') {
    return { dataUrl: `data:image/png;base64,${Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.from([index])]).toString('base64')}`,
        identityName: name, identityId: `character:${name}`, kind, role: kind, viewType: kind === 'identity-primary' ? 'primary' : 'full_body' };
}

test('an explicit reference plan bypasses the local Qwen second selection and preserves earlier omission diagnostics', async t => {
    const f = bridgeFixture(t), selected = [distinctReference(1, 'A'), distinctReference(2, 'A', 'identity-supporting')];
    const omitted = [{ identityName: 'A', label: 'unused costume', reason: 'selected by planner' }];
    const diagnostics = { referenceSelection: { policy: 'cast-budget', supplied: 3, omitted } };
    await generateImage(f.settings, 'Show A reading by the window.', '', selected,
        { diagnostics, referencePlan: { refs: selected, omitted: [], maxReferences: 3 } });
    assert.equal(f.images().length, 2);
    assert.equal(f.images()[1].inlineData.data, selected[1].dataUrl.split(',')[1]);
    assert.strictEqual(diagnostics.referenceSelection.omitted, omitted);
    assert.equal(diagnostics.referenceSelection.policy, 'cast-budget');
    assert.equal(diagnostics.referenceSelection.supplied, 3);
    assert.equal(diagnostics.referenceSelection.sent, 2);
});

test('an invalid over-budget local reference plan stops before any network request', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected request'); });
    await assert.rejects(generateImage({ backend: 'gemini', backendUrl: 'http://127.0.0.1:8055', stylePreset: 'reference' },
        'Show A beside B.', '', [distinctReference(1, 'A'), distinctReference(2, 'B')], { referencePlan: { maxReferences: 1 } }), { code: 'REFERENCE_LIMIT' });
    assert.equal(calls, 0);
});

for (const maxReferences of [1, 2]) {
    test(`mirror geometry honors a ${maxReferences}-slot reference plan without replacing the primary`, async t => {
        const f = bridgeFixture(t), selected = [distinctReference(1, 'A')], warnings = [], diagnostics = {};
        const prompt = assembleUnifiedPrompt({ editInstruction: 'Show A alone standing facing a vertical wall mirror. Observe her from behind and slightly to her left; her body and head remain directed toward the mirror. Her raised right palm touches the mirror at shoulder height and her left arm hangs at her side.' }) + '\nVISIBLE CAST (1): A.';
        await generateImage(f.settings, prompt, '', selected, { diagnostics, onWarning: message => warnings.push(message),
            referencePlan: { refs: selected, maxReferences } });
        assert.equal(f.images().length, maxReferences);
        assert.equal(f.images()[0].inlineData.data, selected[0].dataUrl.split(',')[1]);
        assert.equal(diagnostics.references.some(ref => ref.role === 'mirror-layout'), maxReferences === 2);
        assert.equal(warnings.length, maxReferences === 1 ? 1 : 0);
        if (warnings.length) assert.match(warnings[0], /保留人物主身份图/);
    });
}

for (const existing of [2, 3]) {
    test(`pose geometry stays within the planned three slots with ${existing} selected references`, async t => {
        const f = bridgeFixture(t), selected = [distinctReference(1, 'A'), distinctReference(2, 'B')], warnings = [], diagnostics = {};
        if (existing === 3) selected.push(distinctReference(3, 'A', 'identity-supporting'));
        const prompt = assembleUnifiedPrompt({ editInstruction: 'Show A leaning her back against a washbasin. Her hands rest near her abdomen. B bends the upper body forward and offers a towel with the right hand. Observe from a front three-quarter view.' }) + '\nVISIBLE CAST (2): A, B.';
        await generateImage({ ...f.settings, qwenSceneDetail: true }, prompt, '', selected, { diagnostics,
            resizeSceneImage: async data => data, onWarning: message => warnings.push(message), referencePlan: { refs: selected, maxReferences: 3 } });
        assert.equal(f.images().length, 3);
        assert.equal(f.images()[0].inlineData.data, selected[0].dataUrl.split(',')[1]);
        assert.equal(f.images()[1].inlineData.data, selected[1].dataUrl.split(',')[1]);
        assert.equal(diagnostics.references.some(ref => ref.role === 'scene-layout'), existing === 2);
        if (existing === 3) assert.equal(f.images()[2].inlineData.data, selected[2].dataUrl.split(',')[1]);
        assert.equal(warnings.length, existing === 3 ? 1 : 0);
    });
}
