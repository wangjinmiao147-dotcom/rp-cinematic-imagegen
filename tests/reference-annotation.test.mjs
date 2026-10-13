import test from 'node:test';
import assert from 'node:assert/strict';
import { clampCropBounds, normalizeCropRect, referenceAnnotationPoint, cropReferenceImage, openReferenceAnnotation } from '../src/reference-annotation.js';

const png = 'data:image/png;base64,YWJj';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture({ width = 8, height = 6, pointer = true, imageFailure = false, holdDecode = false } = {}) {
    const images = [], canvases = [], drawCalls = [], pendingImages = [];
    class Events {
        constructor() { this.listeners = new Map(); }
        addEventListener(type, callback) {
            if (!this.listeners.has(type)) this.listeners.set(type, new Set());
            this.listeners.get(type).add(callback);
        }
        removeEventListener(type, callback) {
            const values = this.listeners.get(type); values?.delete(callback);
            if (!values?.size) this.listeners.delete(type);
        }
        async emit(type, properties = {}) {
            const event = { type, target: this, preventDefault() {}, ...properties };
            for (const callback of [...(this.listeners.get(type) || [])]) await callback(event);
        }
    }
    const doc = new Events();
    class Element extends Events {
        constructor(tag) {
            super(); this.tagName = tag; this.style = {}; this.children = []; this.hidden = false;
            this.disabled = false; this.value = ''; this.textContent = ''; this.isConnected = true;
            this.rect = { left: 10, top: 20, width: 200, height: 150 };
            if (tag === 'canvas') canvases.push(this);
        }
        set innerHTML(html) {
            this.html = html; this.parts = new Map();
            for (const [name, tag] of Object.entries({ close: 'button', source: 'p', canvas: 'canvas', selection: 'div', badge: 'span',
                target: 'select', label: 'input', type: 'select', primary: 'input', status: 'div', cancel: 'button', reset: 'button', save: 'button' })) {
                this.parts.set(name, new Element(tag));
            }
        }
        querySelector(selector) { return this.parts?.get(selector.replace('.rpig-reference-annotation-', '')); }
        querySelectorAll() { return [...(this.parts?.values() || [])].filter(part => ['button', 'select', 'input'].includes(part.tagName)); }
        append(...items) { for (const item of items) { this.children.push(item); item.parentElement = this; } }
        remove() { this.removed = true; this.isConnected = false; }
        focus() { doc.activeElement = this; }
        getBoundingClientRect() { return this.rect; }
        setPointerCapture() {}
        releasePointerCapture() {}
        getContext() {
            if (!this.context) {
                const canvas = this;
                this.context = {
                    drawImage(image, ...args) {
                        drawCalls.push({ canvas, image, args });
                        const [sx, sy, sw, sh, , , dw, dh] = args.length === 8 ? args : [0, 0, image.naturalWidth, image.naturalHeight, ...args];
                        if (canvas.width * canvas.height < 10000 && image.pixels) {
                            canvas.pixels = [];
                            for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
                                const sourceX = sx + Math.floor(x / dw * sw), sourceY = sy + Math.floor(y / dh * sh);
                                canvas.pixels.push(image.pixels[sourceY * image.naturalWidth + sourceX]);
                            }
                        }
                        doc.onDraw?.({ canvas, image, args });
                    },
                    fillText() { throw new Error('Annotation text must never enter a canvas'); },
                };
            }
            return this.context;
        }
        toDataURL() {
            return 'data:image/png;base64,' + Buffer.from(JSON.stringify({ width: this.width, height: this.height, pixels: this.pixels })).toString('base64');
        }
    }
    class ImageType {
        constructor() {
            images.push(this); this.naturalWidth = width; this.naturalHeight = height;
            if (width * height < 10000) this.pixels = Array.from({ length: width * height }, (_, index) => index);
        }
        set src(value) {
            this._src = value;
            if (!value) return;
            const complete = () => imageFailure ? this.onerror?.() : this.onload?.();
            if (holdDecode) pendingImages.push(complete); else queueMicrotask(complete);
        }
        get src() { return this._src; }
    }
    doc.createElement = tag => new Element(tag);
    doc.body = new Element('body');
    doc.activeElement = new Element('button');
    doc.defaultView = { Image: ImageType, ...(pointer ? { PointerEvent: class {} } : {}) };
    const options = { document: doc, ImageType, fitViewportOverlay: () => () => {} };
    const overlay = () => doc.body.children.at(-1);
    const find = name => overlay().querySelector(`.rpig-reference-annotation-${name}`);
    const select = async (start = { clientX: 60, clientY: 70 }, end = { clientX: 160, clientY: 120 }, pointerType = 'mouse') => {
        await find('canvas').emit('pointerdown', { pointerId: 7, button: 0, pointerType, ...start });
        await doc.emit('pointermove', { pointerId: 7, pointerType, ...end });
        await doc.emit('pointerup', { pointerId: 7, pointerType, ...end });
    };
    const targets = [{ id: 'current', name: 'Current <img src=x>' }, { id: 'user', name: 'Player' }];
    const open = overrides => openReferenceAnnotation({ dataUrl: png, label: 'Group <script>name</script>', sourceRefId: 'source-one',
        targets, initialTargetId: 'current', onSave: async () => {}, ...options, ...overrides });
    return { doc, options, images, canvases, drawCalls, pendingImages, overlay, find, select, open };
}

test('crop bounds reverse drag direction, clip edges, and remain in normalized source coordinates', () => {
    assert.deepEqual(normalizeCropRect({ x: 80, y: 60 }, { x: 20, y: 10 }, 100, 100), { x: .2, y: .1, width: .6, height: .5 });
    assert.deepEqual(normalizeCropRect({ x: -30, y: 10 }, { x: 200, y: 80 }, 100, 100), { x: 0, y: .1, width: 1, height: .7 });
    assert.deepEqual(clampCropBounds({ x: -.2, y: .2, width: .6, height: 1 }, 100, 100), { x: 0, y: .2, width: .4, height: .8 });
    assert.throws(() => normalizeCropRect({ x: 1, y: 1 }, { x: 2, y: 10 }, 100, 100), { code: 'REFERENCE_CROP_TOO_SMALL' });
    assert.throws(() => clampCropBounds({ x: NaN, y: 0, width: 1, height: 1 }, 100, 100), { code: 'REFERENCE_CROP_INVALID' });
});

test('pointer coordinates use the current display rectangle even after viewport resizing', () => {
    assert.deepEqual(referenceAnnotationPoint(110, 95, { left: 10, top: 20, width: 200, height: 150 }, 800, 600), { x: 400, y: 300 });
    assert.deepEqual(referenceAnnotationPoint(210, 170, { left: 10, top: 20, width: 400, height: 300 }, 800, 600), { x: 400, y: 300 });
    assert.deepEqual(referenceAnnotationPoint(-100, 999, { left: 10, top: 20, width: 200, height: 150 }, 800, 600), { x: 0, y: 600 });
});

test('crop output contains only original selected pixels and never annotation labels', async () => {
    const f = fixture({ width: 4, height: 4 });
    const result = await cropReferenceImage(png, { x: .25, y: .25, width: .5, height: .5 }, f.options);
    const encoded = JSON.parse(Buffer.from(result.dataUrl.split(',')[1], 'base64').toString());
    assert.deepEqual(encoded, { width: 2, height: 2, pixels: [5, 6, 9, 10] });
    assert.ok(f.drawCalls[0].image instanceof f.options.ImageType);
    assert.deepEqual(f.drawCalls[0].args, [1, 1, 2, 2, 0, 0, 2, 2]);
    assert.deepEqual(f.images[0].pixels, Array.from({ length: 16 }, (_, index) => index));
    assert.equal(f.images[0].src, png);
});

test('large crops preserve aspect ratio and cap the longest output edge at 2048', async () => {
    const f = fixture({ width: 6000, height: 3000 });
    const result = await cropReferenceImage(png, { x: 0, y: 0, width: 1, height: 1 }, f.options);
    assert.equal(result.width, 2048); assert.equal(result.height, 1024);
    assert.deepEqual(f.drawCalls[0].args, [0, 0, 6000, 3000, 0, 0, 2048, 1024]);
});

test('non-image data, external URLs and oversized source images cannot allocate a crop canvas', async () => {
    const f = fixture({ width: 10000, height: 5000 });
    for (const source of ['https://private.test/image.png', 'data:image/svg+xml;base64,YWJj', 'data:image/png;base64,']) {
        await assert.rejects(cropReferenceImage(source, { x: 0, y: 0, width: 1, height: 1 }, f.options), { code: 'REFERENCE_IMAGE_INVALID' });
    }
    await assert.rejects(cropReferenceImage(png, { x: 0, y: 0, width: 1, height: 1 }, f.options), { code: 'REFERENCE_IMAGE_TOO_LARGE' });
    assert.equal(f.canvases.length, 0);
    const wide = fixture({ width: 50000, height: 2 });
    await assert.rejects(cropReferenceImage(png, { x: 0, y: 0, width: 1, height: 1 }, wide.options), { code: 'REFERENCE_IMAGE_TOO_LARGE' });
    assert.equal(wide.canvases.length, 0, 'Source limits must agree with persisted annotation dimensions');
});

test('aborting an image decode clears its callbacks and never draws an output', async () => {
    const f = fixture({ holdDecode: true }), controller = new AbortController();
    const pending = cropReferenceImage(png, { x: 0, y: 0, width: 1, height: 1 }, { ...f.options, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(f.images[0].onload, null); assert.equal(f.images[0].onerror, null);
    assert.equal(f.images[0].src, ''); assert.equal(f.drawCalls.length, 0);
});

test('a stale source detected after drawing is not encoded or returned', async () => {
    const f = fixture(); let current = true;
    f.doc.onDraw = () => { current = false; };
    await assert.rejects(cropReferenceImage(png, { x: 0, y: 0, width: 1, height: 1 }, { ...f.options, isCurrent: () => current }), { name: 'AbortError' });
});

test('editor safely labels its preview and saves the cropped original with complete ownership metadata', async () => {
    const f = fixture(); let saved, saveContext;
    const finished = f.open({ initialTargetId: 'user', onSave: async (result, context) => { saved = result; saveContext = context; } });
    await tick();
    assert.equal(f.find('target').value, 'user'); assert.equal(f.find('primary').checked, true);
    assert.equal(f.find('source').textContent, 'Group <script>name</script>');
    assert.equal(f.find('target').children[0].textContent, 'Current <img src=x>');
    assert.doesNotMatch(f.overlay().html, /Group <script>|Current <img/);
    await f.select();
    assert.equal(f.find('badge').textContent, '1 · Player');
    f.find('label').value = 'Player face'; f.find('type').value = 'face_crop'; f.find('primary').checked = false;
    await f.find('save').emit('click');
    assert.deepEqual(await finished, saved);
    assert.equal(saved.targetId, 'user'); assert.equal(saved.viewType, 'face_crop'); assert.equal(saved.isPrimaryIdentity, false);
    assert.deepEqual(saved.annotation, { version: 1, sourceRefId: 'source-one', bounds: { x: .25, y: 1 / 3, width: .5, height: 1 / 3 }, sourceWidth: 8, sourceHeight: 6 });
    assert.equal(saved.label, 'Player face'); assert.ok(saveContext.signal instanceof AbortSignal);
    const cropCall = f.drawCalls.find(call => call.args.length === 8);
    assert.equal(cropCall.image, f.images[0]); assert.notEqual(cropCall.image, f.find('canvas'));
    assert.equal(f.overlay().removed, true); assert.equal(f.doc.listeners.size, 0);
});

test('a failed save keeps the crop preview usable and waits for a successful retry', async () => {
    const f = fixture(); let attempts = 0;
    const finished = f.open({ onSave: async () => { if (++attempts === 1) throw new Error('private upstream credential'); } });
    await tick(); await f.select();
    await f.find('save').emit('click');
    assert.equal(f.overlay().removed, undefined); assert.equal(f.find('save').disabled, false);
    assert.equal(f.find('selection').hidden, false);
    assert.match(f.find('status').textContent, /请重试.*选区仍保留/);
    assert.doesNotMatch(f.find('status').textContent, /private upstream credential/);
    await f.find('save').emit('click');
    assert.equal((await finished).targetId, 'current'); assert.equal(attempts, 2);
});

test('mouse and touch pointers retain normalized selection after the display is resized', async () => {
    const f = fixture(); let saved;
    const finished = f.open({ onSave: async result => { saved = result; } });
    await tick(); await f.select(undefined, undefined, 'touch');
    f.find('canvas').rect = { left: 30, top: 10, width: 400, height: 300 };
    assert.equal(f.find('selection').style.left, '25%');
    await f.find('save').emit('click'); await finished;
    assert.equal(saved.annotation.bounds.x, .25); assert.equal(saved.annotation.bounds.width, .5);
});

test('older browsers use mouse and touch fallbacks without a pointer-events dependency', async () => {
    for (const method of ['mouse', 'touch']) {
        const f = fixture({ pointer: false }); const finished = f.open(); await tick();
        if (method === 'mouse') {
            await f.find('canvas').emit('mousedown', { button: 0, clientX: 60, clientY: 70 });
            await f.doc.emit('mousemove', { clientX: 160, clientY: 120 });
            await f.doc.emit('mouseup', { clientX: 160, clientY: 120 });
        } else {
            const touch = (clientX, clientY) => ({ identifier: 4, clientX, clientY });
            await f.find('canvas').emit('touchstart', { changedTouches: [touch(60, 70)] });
            await f.doc.emit('touchmove', { changedTouches: [touch(160, 120)] });
            await f.doc.emit('touchend', { changedTouches: [touch(160, 120)] });
        }
        assert.equal(f.find('save').disabled, false);
        await f.find('cancel').emit('click'); assert.deepEqual(await finished, { cancelled: true });
        assert.equal(f.doc.listeners.size, 0);
    }
});

test('a too-small selection stays disabled and cannot call persistence', async () => {
    const f = fixture(); let saves = 0; const finished = f.open({ onSave: () => { saves++; } });
    await tick(); await f.select({ clientX: 60, clientY: 70 }, { clientX: 61, clientY: 71 });
    assert.equal(f.find('save').disabled, true); await f.find('save').emit('click'); assert.equal(saves, 0);
    await f.find('cancel').emit('click'); await finished;
});

test('external abort during decoding destroys the modal and releases all listeners', async () => {
    const f = fixture({ holdDecode: true }), controller = new AbortController();
    const finished = f.open({ signal: controller.signal }); await tick(); controller.abort();
    assert.deepEqual(await finished, { cancelled: true }); assert.equal(f.overlay().removed, true);
    assert.equal(f.doc.listeners.size, 0); assert.equal(f.images[0].onload, null);
    for (const complete of f.pendingImages) complete();
    assert.equal(f.drawCalls.length, 0);
});

test('chat invalidation before save cancels the modal instead of saving into another character', async () => {
    const f = fixture(); let current = true, saves = 0;
    const finished = f.open({ isCurrent: () => current, onSave: () => { saves++; } });
    await tick(); await f.select(); current = false;
    await f.find('save').emit('click');
    assert.deepEqual(await finished, { cancelled: true }); assert.equal(saves, 0);
});

test('chat invalidation across image decoding closes the modal before displaying source pixels', async () => {
    const f = fixture({ holdDecode: true }); let current = true;
    const finished = f.open({ isCurrent: () => current }); await tick();
    current = false;
    for (const complete of f.pendingImages) complete();
    assert.deepEqual(await finished, { cancelled: true });
    assert.equal(f.drawCalls.length, 0); assert.equal(f.doc.listeners.size, 0);
});

test('chat invalidation across cropping prevents the persistence callback', async () => {
    const f = fixture(); let current = true, saves = 0;
    const finished = f.open({ isCurrent: () => current, onSave: () => { saves++; } });
    await tick(); await f.select();
    f.doc.onDraw = ({ args }) => { if (args.length === 8) current = false; };
    await f.find('save').emit('click');
    assert.deepEqual(await finished, { cancelled: true }); assert.equal(saves, 0);
});

test('closing while persistence is pending aborts its cooperative guard and resolves cancellation', async () => {
    const f = fixture(), pending = deferred(); let saveContext, committed = false;
    const finished = f.open({ onSave: async (_result, context) => {
        saveContext = context; await pending.promise;
        if (!context.signal.aborted && context.isCurrent()) committed = true;
    } });
    await tick(); await f.select(); const saving = f.find('save').emit('click'); await tick();
    assert.equal(f.find('save').disabled, true);
    await f.doc.emit('keydown', { key: 'Escape' });
    assert.deepEqual(await finished, { cancelled: true }); assert.equal(saveContext.signal.aborted, true);
    pending.resolve(); await saving; assert.equal(committed, false);
});

test('image decode failures remain inline, do not expose raw private input, and keep cancellation available', async () => {
    const f = fixture({ imageFailure: true }); const finished = f.open(); await tick();
    assert.match(f.find('status').textContent, /图片无法读取/); assert.doesNotMatch(f.find('status').textContent, /YWJj/);
    assert.equal(f.find('save').disabled, true);
    await f.find('close').emit('click'); assert.deepEqual(await finished, { cancelled: true });
});
