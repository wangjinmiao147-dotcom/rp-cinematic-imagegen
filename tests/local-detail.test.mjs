import test from 'node:test';
import assert from 'node:assert/strict';
import { blendLocalDetailPixels, buildLocalDetailInstruction, createLocalDetailPlan, localDetailPoint, normalizeLocalDetailRegion, openLocalDetailEditor } from '../src/local-detail.js';

test('pointer selection maps displayed coordinates to original dimensions and clamps outside drags', () => {
    assert.deepEqual(localDetailPoint(110, 70, { left: 10, top: 20, width: 200, height: 100 }, 512, 256), { x: 256, y: 128 });
    assert.deepEqual(localDetailPoint(-50, 900, { left: 10, top: 20, width: 200, height: 100 }, 512, 256), { x: 0, y: 256 });
    assert.deepEqual(normalizeLocalDetailRegion({ x: 80.8, y: 90.3 }, { x: -10, y: 60.2 }, 100, 100), { x: 0, y: 60, width: 81, height: 31 });
    assert.throws(() => normalizeLocalDetailRegion({ x: 2, y: 2 }, { x: 8, y: 7 }, 512, 288), error => error.code === 'LOCAL_DETAIL_REGION_SMALL');
});

test('square context stays inside a large source and keeps the original ROI mapping', () => {
    const plan = createLocalDetailPlan(512, 288, { x: 470, y: 250, width: 42, height: 38 });
    assert.deepEqual(plan.square, { x: 448, y: 224, size: 64 });
    assert.deepEqual(plan.padding, { left: 0, top: 0, right: 0, bottom: 0 });
    assert.equal(plan.targetSize, 256);
    assert.deepEqual(plan.regionInPatch, { x: 88, y: 104, width: 168, height: 152 });
});

test('a thin image needs padding without stretching or losing any selected pixel', () => {
    const plan = createLocalDetailPlan(20, 100, { x: 1, y: 30, width: 18, height: 20 });
    assert.deepEqual(plan.square, { x: -22, y: 8, size: 64 });
    assert.deepEqual(plan.sourceRect, { x: 0, y: 8, width: 20, height: 64 });
    assert.deepEqual(plan.padding, { left: 22, top: 0, right: 22, bottom: 0 });
    assert.equal(plan.regionInPatch.width / plan.regionInPatch.height, 18 / 20);
});

function solid(width, height, value) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set(value, i);
    return pixels;
}

test('compositing preserves all RGBA bytes outside the ROI and never mutates the source', () => {
    const width = 24, height = 18;
    const source = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => (i * 37 + 13) % 256);
    const before = new Uint8ClampedArray(source);
    const region = { x: 4, y: 3, width: 14, height: 12 };
    const plan = createLocalDetailPlan(width, height, region, { minContext: 16, feather: 2 });
    const patch = solid(256, 256, [211, 151, 71, 255]);
    const output = blendLocalDetailPixels(source, patch, width, height, plan);
    let changedInside = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const inside = x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
        if (!inside) assert.deepEqual(output.slice(offset, offset + 4), before.slice(offset, offset + 4));
        else if (output[offset] !== before[offset]) changedInside++;
    }
    assert.deepEqual(source, before);
    assert.ok(changedInside > 0);
    const center = (8 * width + 10) * 4;
    assert.deepEqual(Array.from(output.slice(center, center + 4)), [211, 151, 71, 255]);
    const boundary = (3 * width + 4) * 4;
    assert.deepEqual(output.slice(boundary, boundary + 4), source.slice(boundary, boundary + 4));
});

test('restored crop samples the matching original position, including context padding', () => {
    const plan = createLocalDetailPlan(8, 8, { x: 2, y: 2, width: 4, height: 4 }, { minContext: 8, contextScale: 1, targetSize: 8, feather: 0 });
    const patch = solid(8, 8, [0, 0, 0, 255]);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) patch[(y * 8 + x) * 4] = x * 10 + y;
    const output = blendLocalDetailPixels(solid(8, 8, [9, 9, 9, 111]), patch, 8, 8, plan);
    assert.equal(output[(3 * 8 + 4) * 4], 43);
    assert.deepEqual(Array.from(output.slice(0, 4)), [9, 9, 9, 111]);
});

test('instruction defaults to a local refinement and limits user supplements', () => {
    assert.equal(buildLocalDetailInstruction('unknown'), buildLocalDetailInstruction('general'));
    assert.match(buildLocalDetailInstruction('hands'), /one thumb and four fingers/);
    assert.match(buildLocalDetailInstruction('chest'), /normal adult chest/);
    const prompt = buildLocalDetailInstruction('general', 'x'.repeat(1000));
    assert.ok(prompt.endsWith('x'.repeat(240)));
    assert.ok(!prompt.endsWith('x'.repeat(241)));
    assert.match(prompt, /Preserve the current pose/);
});

// A minimal native DOM/canvas fixture exercises editor lifecycle without a
// browser, network or model request. Pixel geometry is tested separately above.
function editorFixture() {
    const doc = { activeElement: null, listeners: new Map(), addEventListener(type, callback) { this.listeners.set(type, callback); }, removeEventListener(type) { this.listeners.delete(type); } };
    class Element {
        constructor(tag) { this.tagName = tag; this.style = {}; this.listeners = new Map(); this.children = []; this.hidden = false; this.disabled = false; this.value = ''; }
        set innerHTML(_html) {
            this.parts = new Map();
            for (const name of ['close', 'canvas', 'selection', 'preset', 'note', 'status', 'generate', 'save', 'compare', 'cancel']) {
                const tag = name === 'canvas' ? 'canvas' : name === 'preset' ? 'select' : name === 'note' ? 'textarea' : ['selection', 'status'].includes(name) ? 'div' : 'button';
                this.parts.set(name, new Element(tag));
            }
        }
        querySelector(selector) { return this.parts.get(selector.replace('.rpig-local-detail-', '')); }
        querySelectorAll() { return [...this.parts.values()].filter(element => ['button', 'select', 'textarea'].includes(element.tagName)); }
        append(child) { this.children.push(child); }
        focus() { doc.activeElement = this; }
        remove() { this.removed = true; }
        addEventListener(type, callback) { this.listeners.set(type, callback); }
        async emit(type, properties = {}) {
            const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...properties };
            await this.listeners.get(type)?.(event);
        }
        getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 240 }; }
        setPointerCapture() {}
        releasePointerCapture() {}
        getContext() {
            if (!this.context) {
                const canvas = this;
                this.context = {
                    pixels: null,
                    drawImage(image) { this.pixels = solid(canvas.width, canvas.height, image.pixel); },
                    createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
                    putImageData(imageData) { this.pixels = new Uint8ClampedArray(imageData.data); },
                    getImageData() { return { data: new Uint8ClampedArray(this.pixels) }; },
                };
            }
            return this.context;
        }
        toDataURL() { return 'data:image/png;base64,context'; }
    }
    class TestImage {
        set src(url) {
            const candidate = url.endsWith('candidate');
            this.naturalWidth = candidate ? 256 : 32;
            this.naturalHeight = candidate ? 256 : 24;
            this.pixel = candidate ? [200, 180, 160, 255] : [20, 40, 60, 255];
            queueMicrotask(() => this.onload?.());
        }
    }
    doc.createElement = tag => new Element(tag);
    doc.body = new Element('body');
    doc.defaultView = { Image: TestImage };
    const options = { sourceUrl: 'data:image/png;base64,source', document: doc, fitViewportOverlay: () => () => {} };
    const overlay = () => doc.body.children[doc.body.children.length - 1];
    const select = async () => {
        const canvas = overlay().querySelector('.rpig-local-detail-canvas');
        await canvas.emit('pointerdown', { pointerId: 1, button: 0, clientX: 40, clientY: 40 });
        await canvas.emit('pointermove', { pointerId: 1, clientX: 240, clientY: 200 });
        await canvas.emit('pointerup', { pointerId: 1, clientX: 240, clientY: 200 });
    };
    return { options, overlay, select };
}
const nextTick = () => new Promise(resolve => setImmediate(resolve));

test('cancel during generation forwards abort and never invokes save', async () => {
    const fixture = editorFixture();
    let generateSignal, saves = 0;
    const finished = openLocalDetailEditor({ ...fixture.options, onGenerate: ({ signal }) => { generateSignal = signal; return new Promise(() => {}); }, onSave: () => { saves++; } });
    await nextTick();
    await fixture.select();
    const overlay = fixture.overlay();
    const generation = overlay.querySelector('.rpig-local-detail-generate').emit('click');
    await nextTick();
    assert.equal(generateSignal.aborted, false);
    await overlay.querySelector('.rpig-local-detail-cancel').emit('click');
    assert.deepEqual(await finished, { cancelled: true });
    await generation;
    assert.equal(generateSignal.aborted, true);
    assert.equal(saves, 0);
    assert.equal(overlay.removed, true);
});

test('failure leaves the original editable; a successful retry only saves after the save button', async () => {
    const fixture = editorFixture();
    let attempts = 0, saves = 0, savedPayload;
    const finished = openLocalDetailEditor({ ...fixture.options,
        onGenerate: () => { if (++attempts === 1) throw new Error('精修暂时失败'); return { dataUrl: 'data:image/png;base64,candidate' }; },
        onSave: payload => { saves++; savedPayload = payload; return { url: '/saved/candidate.png' }; },
    });
    await nextTick();
    await fixture.select();
    const overlay = fixture.overlay(), find = name => overlay.querySelector(`.rpig-local-detail-${name}`);
    await find('generate').emit('click');
    assert.match(find('status').textContent, /精修暂时失败/);
    assert.equal(find('generate').disabled, false);
    assert.equal(find('save').disabled, true);
    assert.deepEqual(Array.from(find('canvas').getContext('2d').pixels.slice(0, 4)), [20, 40, 60, 255]);
    await find('generate').emit('click');
    assert.equal(find('save').disabled, false);
    assert.equal(saves, 0);
    await find('compare').emit('click');
    const sourceCenter = (12 * 32 + 14) * 4;
    assert.deepEqual(Array.from(find('canvas').getContext('2d').pixels.slice(sourceCenter, sourceCenter + 4)), [20, 40, 60, 255]);
    await overlay.emit('click', { target: find('note') });
    assert.equal(overlay.removed, undefined);
    await find('save').emit('click');
    assert.equal((await finished).saved, true);
    assert.equal(saves, 1);
    assert.equal(savedPayload.sourceUrl, fixture.options.sourceUrl);
    assert.deepEqual(savedPayload.region, { x: 4, y: 4, width: 20, height: 16 });
    assert.equal(savedPayload.plan.targetSize, 256);
});

test('external session close waits for an in-flight save and reports its committed result', async () => {
    const fixture = editorFixture(), external = new AbortController();
    let saveSignal, resolveSave, finishedEarly = false;
    const finished = openLocalDetailEditor({ ...fixture.options, signal: external.signal,
        onGenerate: () => ({ dataUrl: 'data:image/png;base64,candidate' }),
        onSave: ({ signal }) => { saveSignal = signal; return new Promise(resolve => { resolveSave = resolve; }); },
    });
    finished.then(() => { finishedEarly = true; });
    await nextTick(); await fixture.select();
    const overlay = fixture.overlay();
    await overlay.querySelector('.rpig-local-detail-generate').emit('click');
    const saving = overlay.querySelector('.rpig-local-detail-save').emit('click');
    await nextTick(); external.abort();
    await nextTick();
    assert.equal(finishedEarly, false);
    assert.equal(saveSignal.aborted, false);
    assert.equal(overlay.removed, undefined);
    resolveSave({ url: '/saved/after-session-close.png' });
    const result = await finished;
    await saving;
    assert.equal(result.saved, true);
    assert.equal(result.staleAfterSave, true);
    assert.equal(result.result.url, '/saved/after-session-close.png');
    assert.equal(saveSignal.aborted, false);
    assert.equal(overlay.removed, true);
});

test('external close during a failing save cancels only after the transaction settles', async () => {
    const fixture = editorFixture(), external = new AbortController();
    let saveSignal, rejectSave;
    const finished = openLocalDetailEditor({ ...fixture.options, signal: external.signal,
        onGenerate: () => ({ dataUrl: 'data:image/png;base64,candidate' }),
        onSave: ({ signal }) => { saveSignal = signal; return new Promise((_resolve, reject) => { rejectSave = reject; }); },
    });
    await nextTick(); await fixture.select();
    const overlay = fixture.overlay();
    await overlay.querySelector('.rpig-local-detail-generate').emit('click');
    const saving = overlay.querySelector('.rpig-local-detail-save').emit('click');
    await nextTick(); external.abort(); await nextTick();
    assert.equal(saveSignal.aborted, false);
    assert.equal(overlay.removed, undefined);
    rejectSave(new Error('保存失败'));
    assert.deepEqual(await finished, { cancelled: true });
    await saving;
    assert.equal(saveSignal.aborted, true);
    assert.equal(overlay.removed, true);
});

test('failed save keeps the candidate available for an explicit retry', async () => {
    const fixture = editorFixture();
    let saves = 0;
    const finished = openLocalDetailEditor({ ...fixture.options,
        onGenerate: () => ({ dataUrl: 'data:image/png;base64,candidate' }),
        onSave: () => { if (++saves === 1) throw new Error('保存失败'); return { url: '/saved/retry.png' }; },
    });
    await nextTick(); await fixture.select();
    const overlay = fixture.overlay(), find = name => overlay.querySelector(`.rpig-local-detail-${name}`);
    await find('generate').emit('click');
    await find('save').emit('click');
    assert.match(find('status').textContent, /保存失败/);
    assert.equal(find('save').disabled, false);
    assert.equal(overlay.removed, undefined);
    await find('save').emit('click');
    assert.equal((await finished).saved, true);
    assert.equal(saves, 2);
});
