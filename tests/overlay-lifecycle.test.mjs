import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOverlayLifecycle, captureOverlayContext } from '../src/overlay-lifecycle.js';
import { RpigError } from '../src/utils.js';

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

test('replacing an overlay releases its resources once and keeps the replacement active', () => {
    const lifecycle = createOverlayLifecycle();
    let releases = 0;
    const first = lifecycle.begin('gallery');
    first.setCleanup(() => releases++);
    const next = lifecycle.begin('gallery');
    first.close();
    assert.equal(releases, 1);
    assert.equal(first.isCurrent(), false);
    assert.equal(next.isCurrent(), true);
});

test('chat cleanup closes both mounted overlays and pending asynchronous requests', () => {
    const lifecycle = createOverlayLifecycle();
    let releases = 0;
    const gallery = lifecycle.begin('gallery');
    const lightbox = lifecycle.begin('lightbox');
    lightbox.setCleanup(() => releases++);
    lifecycle.closeAll();
    lifecycle.closeAll();
    gallery.setCleanup(() => releases++);
    assert.equal(releases, 2);
    assert.equal(gallery.isCurrent(), false);
    assert.equal(lightbox.isCurrent(), false);
    assert.equal(lifecycle.has('lightbox'), false);
});

test('overlay context accepts new host wrappers but rejects chat and identity changes', () => {
    const context = { chat: [], chatId: 'one', characterId: 1, groupId: 'group-one' };
    let selected = 'one';
    const snapshot = captureOverlayContext(context, undefined, () => selected);
    assert.equal(snapshot.isCurrent({ ...context }), true);
    for (const replacement of [
        { ...context, chat: [] }, { ...context, chatId: 'two' },
        { ...context, characterId: 2 }, { ...context, groupId: 'group-two' },
    ]) assert.equal(snapshot.isCurrent(replacement), false);
    selected = 'two';
    assert.equal(snapshot.isCurrent(context), false);
});

test('message lightbox identity rejects text edits, swipes and message replacement', () => {
    const message = { mes: 'first', swipe_id: 0, send_date: new Date(1000) };
    const context = { chat: [message], chatId: 'one' };
    const snapshot = captureOverlayContext(context, 0, () => 'one');
    assert.equal(snapshot.isCurrent(context), true);
    message.mes = 'second'; assert.equal(snapshot.isCurrent(context), false); message.mes = 'first';
    message.swipe_id = 1; assert.equal(snapshot.isCurrent(context), false); message.swipe_id = 0;
    message.send_date.setTime(2000); assert.equal(snapshot.isCurrent(context), false); message.send_date.setTime(1000);
    context.chat[0] = { ...message }; assert.equal(snapshot.isCurrent(context), false);
});

// Exercise the actual browser orchestration with host/UI adapters, including
// pending gallery opens and deletion completion. No source-text assertions.
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const gallerySource = source.slice(source.indexOf('async function openGallery('), source.indexOf('\nlet rpigGenerating'));
const refineSource = source.slice(source.indexOf('async function refineExistingIllustration('), source.indexOf('\nasync function openGallery('));
const lightboxSource = source.slice(source.indexOf('function openLightbox('), source.indexOf('\nasync function refineExistingIllustration('));
const compile = (code, name, deps) => new Function('deps', `with (deps) { ${code}; return ${name}; }`)(deps);

function galleryFixture() {
    const message = { extra: { media: [{ url: '/image.png' }] } };
    const context = { chat: [message], chatId: 'one', characterId: 1 };
    const state = { context, reads: [], elements: [], rendered: [], notices: [], deleted: 0 };
    const document = {};
    class Query {
        constructor(key) { this.key = key; this[0] = {}; this.length = 1; this.children = new Map(); this.events = new Map(); this.props = {}; }
        find(key) { if (!this.children.has(key)) this.children.set(key, new Query(key)); return this.children.get(key); }
        on(key, fn) { this.events.set(key, fn); return this; }
        off(key) { this.events.delete(key); return this; }
        attr() { return this; }
        text() { return this; }
        append() { return this; }
        prop(key, value) { if (arguments.length === 1) return this.props[key]; this.props[key] = value; return this; }
        remove() { this.removed = true; return this; }
        fadeOut(_delay, fn) { fn.call(this); return this; }
    }
    const documentQuery = new Query('document');
    const body = new Query('body');
    const $ = value => {
        if (value instanceof Query) return value;
        if (value === document) return documentQuery;
        if (value === 'body') return body;
        const result = new Query(value); state.elements.push(result); return result;
    };
    const dependencies = {
        $, document, window: {}, createOverlayLifecycle, captureOverlayContext, RpigError,
        rpigOverlays: createOverlayLifecycle(), getContext: () => state.context,
        getCurrentCharacter: () => ({ name: 'Test', avatar: 'test.png' }),
        getAllImagesForCharacter: () => { const pending = deferred(); state.reads.push(pending); return pending.promise; },
        fitViewportOverlay: () => () => {}, escapeHtml: value => String(value),
        toastr: Object.fromEntries(['error', 'success'].map(kind => [kind, text => state.notices.push({ kind, text })])),
        deleteImageCompletely: async () => { state.deleted++; message.extra.media = []; return { context, affectedMessageIndexes: [0], chatModified: true, chatSkipped: false }; },
        updateMessageBlock: (index, message) => state.rendered.push(['update', index, message]),
        ensureFallbackMediaRender: (index, message) => state.rendered.push(['fallback', index, message]),
        openLightbox: () => {}, getSettings: () => ({}), isLocalQwen: () => false,
    };
    return { state, context, message, dependencies, documentQuery, openGallery: compile(gallerySource, 'openGallery', dependencies) };
}

test('replacing actual lightboxes removes old DOM and releases viewport and keyboard bindings', () => {
    const f = galleryFixture();
    let releases = 0;
    f.dependencies.fitViewportOverlay = () => () => releases++;
    const openLightbox = compile(lightboxSource, 'openLightbox', f.dependencies);
    openLightbox('/first.png', '', { messageIndex: 0 });
    openLightbox('/second.png', '', { messageIndex: 0 });
    const overlays = f.state.elements.filter(element => element.key === '<div class="rpig-lightbox"></div>');
    assert.equal(overlays.length, 2);
    assert.equal(overlays[0].removed, true);
    assert.equal(releases, 1);
    f.dependencies.rpigOverlays.closeAll();
    assert.equal(overlays[1].removed, true);
    assert.equal(releases, 2);
    assert.equal(f.documentQuery.events.has('keydown.rpigLightbox'), false);
});

test('gallery data arriving after a chat switch cannot mount an old overlay', async () => {
    const f = galleryFixture();
    const open = f.openGallery();
    f.state.context = { chat: [], chatId: 'two', characterId: 2 };
    f.state.reads[0].resolve([{ url: '/old.png' }]);
    await open;
    assert.equal(f.state.elements.length, 0);
    assert.equal(f.dependencies.rpigOverlays.has('gallery'), false);
});

test('an older gallery request cannot mount over a newer request in the same chat', async () => {
    const f = galleryFixture();
    const first = f.openGallery();
    const next = f.openGallery();
    f.state.reads[0].resolve([{ url: '/old.png' }]);
    await first;
    assert.equal(f.state.elements.length, 0);
    f.state.reads[1].resolve([]);
    await next;
    assert.ok(f.state.elements.some(element => element.key.includes('rpig-gallery-overlay')));
});

test('successful gallery deletion refreshes the affected chat message immediately', async () => {
    const f = galleryFixture();
    const open = f.openGallery();
    f.state.reads[0].resolve([{ url: '/image.png' }]);
    await open;
    const card = f.state.elements.find(element => element.key.includes('class="rpig-gallery-card"'));
    await card.find('.rpig-del').events.get('click')({ stopPropagation() {} });
    assert.equal(f.state.deleted, 1);
    assert.deepEqual(f.state.rendered, [['update', 0, f.message], ['fallback', 0, f.message]]);
    assert.equal(card.removed, true);
});

test('a stale gallery delete button cannot begin deleting a new chat image', async () => {
    const f = galleryFixture();
    const open = f.openGallery();
    f.state.reads[0].resolve([{ url: '/image.png' }]);
    await open;
    const card = f.state.elements.find(element => element.key.includes('class="rpig-gallery-card"'));
    f.state.context = { chat: [], chatId: 'two', characterId: 2 };
    await card.find('.rpig-del').events.get('click')({ stopPropagation() {} });
    assert.equal(f.state.deleted, 0);
    assert.equal(f.state.rendered.length, 0);
});

test('refinement rejects an old lightbox identity before capturing a source from the new chat', async () => {
    const context = { chat: [{ mes: 'old', swipe_id: 0 }], chatId: 'one' };
    const contextSnapshot = captureOverlayContext(context, 0, () => 'one');
    const current = { chat: [{ mes: 'new', swipe_id: 0 }], chatId: 'two' };
    let captures = 0;
    const refine = compile(refineSource, 'refineExistingIllustration', {
        getContext: () => current, RpigError,
        captureLocalDetailSource: () => { captures++; },
    });
    await assert.rejects(refine('/old.png', { messageIndex: 0, contextSnapshot }), { code: 'LOCAL_DETAIL_SOURCE_CHANGED' });
    assert.equal(captures, 0);
});
