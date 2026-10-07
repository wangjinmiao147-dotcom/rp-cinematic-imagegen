import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage, generateLocalDetailEdit } from '../src/backends.js';
import { qwenDetailEditPrompt } from '../src/qwen.js';
import { createAbortError } from '../src/utils.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6YkAAAAASUVORK5CYII=';
const instruction = 'Refine only the already visible normal adult nipple and areola, keeping their natural size, location and existing occlusion.';
const settings = Object.freeze({ backend: 'gemini', backendUrl: 'http://127.0.0.1:8055', backendModel: 'qwen-image-2.1',
    stylePreset: 'reference', imageSize: '9:16', qwenResolution: '1024x576', qwenIdentityDetailBoost: true,
    qwenSteps: 12, qwenCfg: 6, qwenSeed: 1376622220, qwenCacheType: 'q8_0' });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const capabilities = () => json({ bridge: 'rpig-qwen', protocol: 2, reference_order: true, explicit_dimensions: true });
const imageResponse = () => json({ candidates: [{ content: { parts: [{ inlineData: {
    mimeType: 'image/png', data: png.split(',')[1],
} }] } }], rpig: { job_id: 'detail-test-job', engine_seconds: 39, seed: 1376622220 } });

function mockSuccess(t) {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
        return url.endsWith('/rpig-capabilities') ? capabilities() : imageResponse();
    });
    return calls;
}

test('region edit sends only the selected crop, private 256 output and fixed local controls', async t => {
    const calls = mockSuccess(t), diagnostic = {};
    const before = { ...settings };
    const result = await generateLocalDetailEdit(settings, instruction, png, { diagnostics: diagnostic, requestId: 'detail-request' });
    const generations = calls.filter(c => c.url.includes(':generateContent'));
    assert.equal(generations.length, 1);
    const body = generations[0].body, parts = body.contents[0].parts;
    assert.deepEqual([body.width, body.height], [256, 256]);
    assert.equal(body.steps, 20);
    assert.equal(body.cfg_scale, 1);
    assert.equal(body.negative_prompt, '');
    assert.equal(body.seed, settings.qwenSeed);
    assert.equal(body.request_id, 'detail-request');
    assert.equal(parts.filter(p => p.inlineData).length, 1);
    assert.equal(parts.find(p => p.inlineData).inlineData.data, png.split(',')[1]);
    assert.ok(parts.find(p => p.text).text.includes(instruction));
    assert.doesNotMatch(parts.find(p => p.text).text, /PRIMARY IDENTITY|new story illustration|REFERENCE MAPPING|VISIBLE CAST/);
    assert.deepEqual(settings, before);
    assert.equal(result.dataUrl, png);
    assert.equal(result.usedRefs, true);
    assert.equal(result.usedAvoid, '');
    assert.deepEqual(result.patchSize, [256, 256]);
    assert.equal(diagnostic.mode, 'local-detail-edit');
    assert.equal(diagnostic.references[0].role, 'edit-target');
    assert.equal(diagnostic.references[0].source, 'selected-region');
    assert.equal(diagnostic.referenceCount, 1);
    assert.equal(diagnostic.identityDetailBoost, false);
    assert.deepEqual(diagnostic.requestedSize, [256, 256]);
    assert.equal(diagnostic.engine.job_id, 'detail-test-job');
    assert.equal(diagnostic.status, 'success');
    assert.ok(diagnostic.finishedAt);
});

test('an explicit private patch size does not alter the saved story resolution', async t => {
    const calls = mockSuccess(t);
    await generateLocalDetailEdit(settings, 'Repair the selected material texture.', png, { patchSize: [384, 288] });
    const body = calls.find(c => c.body?.contents).body;
    assert.deepEqual([body.width, body.height], [384, 288]);
    assert.equal(settings.qwenResolution, '1024x576');
    assert.equal(settings.imageSize, '9:16');
    assert.equal(settings.qwenIdentityDetailBoost, true);
});

test('invalid patch sizes and missing crops fail before any model request', async t => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('unexpected fetch'); });
    for (const patchSize of [[255, 256], [256, 513], [300, 256], ['256', 256], [256], null, 256]) {
        await assert.rejects(generateLocalDetailEdit(settings, instruction, png, { patchSize }), { code: 'DETAIL_PATCH_SIZE_INVALID' });
    }
    await assert.rejects(generateLocalDetailEdit(settings, instruction, '/user/images/source.png'), { code: 'DETAIL_PATCH_REQUIRED' });
    assert.equal(requests, 0);
});

test('the dedicated crop entry is local-only and checks cancellation before starting', async t => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('unexpected fetch'); });
    await assert.rejects(generateLocalDetailEdit({ ...settings, backendUrl: 'https://image.test' }, instruction, png),
        { code: 'DETAIL_LOCAL_BACKEND_REQUIRED' });
    const controller = new AbortController();
    controller.abort(createAbortError());
    await assert.rejects(generateLocalDetailEdit(settings, instruction, png, { signal: controller.signal }),
        error => error.name === 'AbortError');
    assert.equal(requests, 0);
});

test('cancelling a crop edit cancels its own bridge job without another image attempt', async t => {
    const controller = new AbortController(), diagnostic = {}, cancellations = [];
    let renderStarted, renderCount = 0;
    const started = new Promise(resolve => { renderStarted = resolve; });
    t.mock.method(globalThis, 'fetch', (url, options) => {
        if (url.endsWith('/rpig-capabilities')) return Promise.resolve(capabilities());
        if (url.endsWith('/rpig-cancel')) {
            cancellations.push(JSON.parse(options.body).request_id);
            return Promise.resolve(json({ cancelled: true }));
        }
        renderCount++;
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            renderStarted();
        });
    });
    const pending = generateLocalDetailEdit(settings, instruction, png,
        { requestId: 'cancelled-detail', signal: controller.signal, diagnostics: diagnostic });
    await started;
    controller.abort(createAbortError());
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(renderCount, 1);
    assert.ok(cancellations.length > 0);
    assert.ok(cancellations.every(id => id === 'cancelled-detail'));
    assert.equal(diagnostic.status, 'cancelled');
    assert.ok(diagnostic.finishedAt);
});

test('crop backend failures remain separate and do not retry with identity or full-frame references', async t => {
    const diagnostic = {}, generations = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (url.endsWith('/rpig-capabilities')) return capabilities();
        generations.push(JSON.parse(options.body));
        return json({ error: 'patch job failed' }, 500);
    });
    await assert.rejects(generateLocalDetailEdit(settings, instruction, png, { diagnostics: diagnostic }),
        error => error.code === 'QWEN_IMAGE_HTTP' && /patch job failed/.test(error.message));
    assert.equal(generations.length, 1);
    assert.equal(generations[0].contents[0].parts.filter(p => p.inlineData).length, 1);
    assert.equal(diagnostic.status, 'failed');
    assert.equal(diagnostic.errorCode, 'QWEN_IMAGE_HTTP');
    assert.ok(diagnostic.finishedAt);
});

test('normal story generation retains its own dimensions and sampling controls', async t => {
    const calls = mockSuccess(t);
    const ordinarySettings = { ...settings, imageSize: '16:9', qwenResolution: '512x288', qwenCfg: 2 };
    await generateImage(ordinarySettings, 'Show the character touching the door.', '',
        [{ dataUrl: png, kind: 'identity-primary', role: 'identity-primary', identityName: 'Character' }]);
    const body = calls.find(c => c.body?.contents).body;
    assert.deepEqual([body.width, body.height], [512, 288]);
    assert.equal(body.steps, 12);
    assert.equal(body.cfg_scale, 2);
});

test('the crop prompt keeps the existing illustration context without forcing a body subject', () => {
    const prompt = qwenDetailEditPrompt('Repair only the chipped edge of the cup.');
    assert.match(prompt, /chipped edge of the cup/);
    assert.match(prompt, /existing occlusion, illumination and colors/);
    assert.match(prompt, /original drawing medium, linework and shading/);
    assert.doesNotMatch(prompt, /nipple|areola|nude|new story illustration/i);
});
