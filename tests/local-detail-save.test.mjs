import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLocalDetailSource, saveLocalDetailCandidate } from '../src/local-detail-save.js';

const png = 'data:image/png;base64,YWJj';
const baseURI = 'http://127.0.0.1:8000/chat';
const sourceUrl = '/user/images/演员/original.png';

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture({ legacy = false } = {}) {
    const original = { url: sourceUrl, title: 'RP 配图' };
    const rpigInfo = { outputUrl: sourceUrl, sceneState: { location: { value: '浴室' } }, prompt: 'original prompt' };
    const message = { mes: '当前剧情', swipe_id: 0, send_date: '2026-10-04', extra: { rpigInfo, ...(legacy ? { image: sourceUrl, image_swipes: [sourceUrl] } : { media: [original] }) } };
    const context = { chatId: 'chat-one', characterId: 2, chat: [message] };
    const holder = { context };
    const character = { name: '演员', avatar: 'actor.png' };
    const snapshot = captureLocalDetailSource({ context, messageIndex: 0, sourceUrl, character, baseURI });
    const calls = { persist: [], update: [], gallery: [], render: [] };
    const deps = {
        getContext: () => holder.context,
        persistMediaUrl: async (...args) => { calls.persist.push(args); return '/user/images/演员/detail.png'; },
        updateMessage: async (...args) => { calls.update.push(args); },
        saveToGallery: async (...args) => { calls.gallery.push(args); },
        renderMessage: async (...args) => { calls.render.push(args); },
    };
    const candidate = { dataUrl: png, sourceUrl, region: { x: 230, y: 175, width: 18, height: 25 }, preset: 'anatomy', instruction: 'Refine ordinary visible structure.', generationResult: { model: 'qwen', apiKey: 'must-not-copy' } };
    return { original, rpigInfo, message, context, holder, character, snapshot, candidate, calls, deps };
}

test('saving adds one candidate without changing the original, rpigInfo or scene state', async () => {
    const f = fixture();
    const before = structuredClone(f.message);
    const result = await saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps);
    assert.equal(result.saved, true);
    assert.equal(result.galleryOnly, false);
    assert.equal(result.staleAfterSave, false);
    assert.equal(f.snapshot.sessionKey, '2_chat-one');
    assert.strictEqual(f.message.extra.media[0], f.original);
    assert.deepEqual(f.message.extra.media[0], before.extra.media[0]);
    assert.strictEqual(f.message.extra.rpigInfo, f.rpigInfo);
    assert.deepEqual(f.message.extra.rpigInfo, before.extra.rpigInfo);
    assert.equal(f.message.extra.media.length, 2);
    assert.equal(f.message.extra.media_display, 'list');
    assert.equal(f.message.extra.media[1].detailEdit.sourceUrl, sourceUrl);
    assert.deepEqual(f.message.extra.media[1].detailEdit.region, f.candidate.region);
    assert.equal(JSON.stringify(f.message).includes('must-not-copy'), false);
    assert.deepEqual(f.calls.update[0], [0, f.message, f.context]);
    assert.equal(f.calls.gallery[0][0].avatar, 'actor.png');
    assert.equal(f.calls.render.length, 1);
    assert.deepEqual(f.candidate.region, { x: 230, y: 175, width: 18, height: 25 });
});

test('canonical URL matching accepts a displayed absolute source and legacy media without migration', async () => {
    const f = fixture({ legacy: true });
    const snapshot = captureLocalDetailSource({ context: f.context, messageIndex: 0, sourceUrl: new URL(sourceUrl, baseURI).href, character: f.character, baseURI });
    assert.equal(snapshot.isCurrent(f.deps.getContext), true);
    await saveLocalDetailCandidate(snapshot, { ...f.candidate, sourceUrl: snapshot.sourceUrl }, f.deps);
    assert.equal(f.message.extra.image, sourceUrl);
    assert.deepEqual(f.message.extra.image_swipes, [sourceUrl]);
    assert.strictEqual(f.message.extra.rpigInfo, f.rpigInfo);
    assert.equal(f.message.extra.media.length, 1);
    assert.equal(f.message.extra.media_display, 'list');
});

for (const [name, change] of [
    ['session switch', f => { f.holder.context = { ...f.context, chatId: 'other-chat' }; }],
    ['replacement chat array with the same session id', f => { f.holder.context = { ...f.context, chat: [...f.context.chat] }; }],
    ['replacement message', f => { f.context.chat[0] = structuredClone(f.message); }],
    ['changed swipe', f => { f.message.swipe_id = 1; }],
    ['changed story', f => { f.message.mes = '改写后的剧情'; }],
    ['changed send date', f => { f.message.send_date = '2026-10-05'; }],
    ['removed source', f => { f.message.extra.media = []; delete f.message.extra.rpigInfo.outputUrl; }],
]) {
    test(`${name} prevents attaching a candidate to the wrong source`, async () => {
        const f = fixture(); change(f);
        assert.equal(f.snapshot.isCurrent(f.deps.getContext), false);
        await assert.rejects(saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps), { code: 'LOCAL_DETAIL_SOURCE_CHANGED' });
        assert.equal(f.calls.persist.length, 0);
        assert.equal(f.calls.update.length, 0);
        assert.equal(f.calls.gallery.length, 0);
    });
}

test('removing a displayed source cannot resurrect it through stale rpigInfo metadata', async () => {
    const f = fixture(); f.message.extra.media = [];
    assert.equal(f.message.extra.rpigInfo.outputUrl, sourceUrl);
    await assert.rejects(saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps), { code: 'LOCAL_DETAIL_SOURCE_CHANGED' });
    assert.equal(f.calls.persist.length, 0);
});

test('a switch while file persistence is pending prevents append and chat save', async () => {
    const f = fixture(); const file = deferred(); const started = deferred();
    f.deps.persistMediaUrl = async () => { started.resolve(); return file.promise; };
    const saving = saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps);
    await started.promise;
    f.holder.context = { chatId: 'other-chat', characterId: 3, chat: [] };
    file.resolve('/user/images/演员/detail.png');
    await assert.rejects(saving, { code: 'LOCAL_DETAIL_SOURCE_CHANGED' });
    assert.equal(f.message.extra.media.length, 1);
    assert.equal(f.calls.update.length, 0);
    assert.equal(f.calls.gallery.length, 0);
});

test('file failure keeps the candidate available and does not attach a temporary preview', async () => {
    const f = fixture(); const failure = new Error('disk unavailable');
    f.deps.persistMediaUrl = async () => { throw failure; };
    await assert.rejects(saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps), error => error === failure);
    assert.equal(f.candidate.dataUrl, png);
    assert.deepEqual(f.message.extra.media, [f.original]);
    assert.equal(f.calls.update.length, 0);
});

for (const url of [png, 'blob:http://127.0.0.1:8000/temp', 'https://cdn.test/temporary.png', 'javascript:alert(1)', '']) {
    test(`a nonpersistent storage result is never saved: ${url.split(':')[0] || 'empty'}`, async () => {
        const f = fixture(); f.deps.persistMediaUrl = async () => url;
        await assert.rejects(saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps), { code: 'LOCAL_DETAIL_FILE_SAVE_FAILED' });
        assert.equal(f.message.extra.media.length, 1);
        assert.equal(f.calls.update.length, 0);
        assert.equal(f.calls.gallery.length, 0);
    });
}

test('blob preview is converted before persistence and only the durable file is attached', async () => {
    const f = fixture(); const requested = [];
    f.deps.fetchToDataUrl = async (...args) => { requested.push(args); return png; };
    await saveLocalDetailCandidate(f.snapshot, { ...f.candidate, dataUrl: 'blob:http://127.0.0.1:8000/preview' }, f.deps);
    assert.equal(requested[0][0], 'blob:http://127.0.0.1:8000/preview');
    assert.equal(f.calls.persist[0][0], png);
    assert.equal(f.message.extra.media[1].url, '/user/images/演员/detail.png');
});

test('real persistence dependency receives the four-argument SillyTavern file API', async () => {
    const f = fixture(); delete f.deps.persistMediaUrl;
    const writes = [];
    f.deps.saveBase64AsFile = async (...args) => { writes.push(args); return '/user/images/演员/detail.png'; };
    await saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].length, 4);
    assert.equal(writes[0][0], 'YWJj');
    assert.equal(writes[0][1], '演员');
    assert.match(writes[0][2], /^rpig_\d+$/);
    assert.equal(writes[0][3], 'png');
});

test('chat failure rolls back only its item; retry reuses the file and appends once', async () => {
    const f = fixture(); const failure = new Error('chat save rejected');
    const concurrent = { url: '/concurrent.png', title: 'other image' }; let attempts = 0;
    f.deps.updateMessage = async () => { if (++attempts === 1) { f.message.extra.media.push(concurrent); throw failure; } };
    await assert.rejects(saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps), error => error === failure);
    assert.deepEqual(f.message.extra.media, [f.original, concurrent]);
    assert.strictEqual(f.message.extra.rpigInfo, f.rpigInfo);
    assert.equal(f.calls.gallery.length, 0);
    const saved = await saveLocalDetailCandidate(f.snapshot, { ...f.candidate }, f.deps);
    assert.equal(saved.saved, true);
    assert.equal(f.calls.persist.length, 1);
    assert.equal(f.message.extra.media.filter(item => item.detailEdit).length, 1);
    await saveLocalDetailCandidate(f.snapshot, { ...f.candidate }, f.deps);
    assert.equal(attempts, 2);
    assert.equal(f.message.extra.media.filter(item => item.detailEdit).length, 1);
});

test('rollback restores absent media on a legacy message without touching its fields', async () => {
    const f = fixture({ legacy: true }); const before = structuredClone(f.message.extra);
    f.deps.updateMessage = async () => { throw new Error('save failed'); };
    await assert.rejects(saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps), /save failed/);
    assert.deepEqual(f.message.extra, before);
    assert.equal(Object.hasOwn(f.message.extra, 'media'), false);
});

test('chat failure restores the prior media display when nobody else changed it', async () => {
    const f = fixture(); f.message.extra.media_display = 'grid';
    f.deps.updateMessage = async () => {
        assert.equal(f.message.extra.media_display, 'list');
        throw new Error('save failed');
    };
    await assert.rejects(saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps), /save failed/);
    assert.equal(f.message.extra.media_display, 'grid');
    assert.deepEqual(f.message.extra.media, [f.original]);
});

test('chat failure does not overwrite a concurrent display selection or new media', async () => {
    for (const kind of ['display', 'media']) {
        const f = fixture(); f.message.extra.media_display = 'grid';
        f.deps.updateMessage = async () => {
            if (kind === 'display') f.message.extra.media_display = 'single';
            else f.message.extra.media.push({ url: '/new-image.png' });
            throw new Error('save failed');
        };
        await assert.rejects(saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps), /save failed/);
        assert.equal(f.message.extra.media_display, kind === 'display' ? 'single' : 'list');
        assert.equal(f.message.extra.media.filter(item => item.detailEdit).length, 0);
    }
});

test('detail metadata stores useful sanitized generation diagnostics without settings or inline images', async () => {
    const f = fixture(); const privateKey = 'private-key-test';
    f.deps.diagnosticKeys = [privateKey];
    f.candidate.generationResult = {
        requestId: 'detail-123', backendKey: privateKey,
        diagnostics: { requestId: 'detail-123', hash: 'sha256:abc', engine_seconds: 39,
            dataUrl: png, backendKey: privateKey, request: `Authorization: Bearer ${privateKey}`, preview: png },
    };
    await saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps);
    const metadata = f.message.extra.media[1].detailEdit;
    assert.equal(metadata.requestId, 'detail-123');
    assert.equal(metadata.diagnostics.hash, 'sha256:abc');
    assert.equal(metadata.diagnostics.engine_seconds, 39);
    assert.equal(Object.hasOwn(metadata.diagnostics, 'dataUrl'), false);
    assert.equal(Object.hasOwn(metadata.diagnostics, 'backendKey'), false);
    assert.equal(JSON.stringify(metadata).includes(privateKey), false);
    assert.equal(JSON.stringify(metadata).includes('data:image'), false);
    assert.equal(Object.hasOwn(metadata, 'diagnosticKeys'), false);
});

test('concurrent duplicate saves commit one image, file and gallery entry', async () => {
    const f = fixture(); const commit = deferred(); const started = deferred(); let updates = 0;
    f.deps.updateMessage = async () => { updates++; started.resolve(); await commit.promise; };
    const first = saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps);
    const second = saveLocalDetailCandidate(f.snapshot, { ...f.candidate }, f.deps);
    await started.promise; commit.resolve();
    const results = await Promise.all([first, second]);
    assert.ok(results.every(result => result.saved));
    assert.equal(updates, 1);
    assert.equal(f.calls.persist.length, 1);
    assert.equal(f.calls.gallery.length, 1);
    assert.equal(f.message.extra.media.length, 2);
});

test('gallery-only saves never guess or mutate a chat message', async () => {
    const f = fixture();
    const snapshot = captureLocalDetailSource({ context: f.context, sourceUrl, character: f.character, baseURI });
    f.holder.context = { chatId: 'unrelated-chat', characterId: 99, chat: [] };
    const saved = await saveLocalDetailCandidate(snapshot, f.candidate, f.deps);
    assert.equal(saved.galleryOnly, true);
    assert.equal(saved.messageIndex, null);
    assert.equal(f.message.extra.media.length, 1);
    assert.equal(f.calls.update.length, 0);
    assert.equal(f.calls.render.length, 0);
    assert.equal(f.calls.gallery[0][0].avatar, 'actor.png');
});

test('gallery failure is a warning after a successful chat commit', async () => {
    const f = fixture(); f.deps.saveToGallery = async () => { throw new Error('IndexedDB unavailable'); };
    const saved = await saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps);
    assert.equal(saved.saved, true);
    assert.match(saved.galleryWarning, /IndexedDB unavailable/);
    assert.equal(f.calls.update.length, 1);
    assert.equal(f.message.extra.media.length, 2);
    assert.equal(f.calls.render.length, 1);
});

test('gallery-only requires successful gallery persistence and can retry without another file', async () => {
    const f = fixture(); const snapshot = captureLocalDetailSource({ sourceUrl, character: f.character, baseURI });
    f.deps.saveToGallery = async () => { throw new Error('gallery failure'); };
    await assert.rejects(saveLocalDetailCandidate(snapshot, f.candidate, f.deps), /gallery failure/);
    assert.equal(f.message.extra.media.length, 1);
    f.deps.saveToGallery = async () => {};
    assert.equal((await saveLocalDetailCandidate(snapshot, f.candidate, f.deps)).saved, true);
    assert.equal(f.calls.persist.length, 1);
    assert.equal(f.calls.update.length, 0);
});

test('gallery-only cannot claim a gallery save with an unknown character', async () => {
    const f = fixture(); const snapshot = captureLocalDetailSource({ sourceUrl, baseURI });
    await assert.rejects(saveLocalDetailCandidate(snapshot, f.candidate, f.deps), { code: 'LOCAL_DETAIL_GALLERY_SAVE_FAILED' });
    assert.equal(f.calls.gallery.length, 0);
});

test('cancel before or during file persistence prevents commit and retains the preview', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await assert.rejects(saveLocalDetailCandidate(f.snapshot, { ...f.candidate, signal: controller.signal }, f.deps), { name: 'AbortError' });
    assert.equal(f.calls.persist.length, 0);
    const fresh = new AbortController(); const file = deferred(); const started = deferred();
    f.deps.persistMediaUrl = async () => { started.resolve(); return file.promise; };
    const saving = saveLocalDetailCandidate(f.snapshot, { ...f.candidate, signal: fresh.signal }, f.deps);
    await started.promise; fresh.abort(); file.resolve('/user/images/演员/detail.png');
    await assert.rejects(saving, { name: 'AbortError' });
    assert.equal(f.calls.update.length, 0);
    assert.equal(f.calls.gallery.length, 0);
    assert.equal(f.message.extra.media.length, 1);
    assert.equal(f.candidate.dataUrl, png);
});

test('cancel during chat commit does not misreport a durable success as unsaved', async () => {
    const f = fixture(); const controller = new AbortController(); const commit = deferred(); const started = deferred();
    f.deps.updateMessage = async () => { started.resolve(); await commit.promise; };
    const saving = saveLocalDetailCandidate(f.snapshot, { ...f.candidate, signal: controller.signal }, f.deps);
    await started.promise; controller.abort(); commit.resolve();
    const saved = await saving;
    assert.equal(saved.saved, true);
    assert.equal(f.message.extra.media.length, 2);
    assert.equal(f.calls.gallery.length, 1);
});

test('successful old-session commit reports a later switch without rendering in the new session', async () => {
    const f = fixture(); const commit = deferred(); const started = deferred();
    f.deps.updateMessage = async () => { started.resolve(); await commit.promise; };
    const saving = saveLocalDetailCandidate(f.snapshot, f.candidate, f.deps);
    await started.promise;
    f.holder.context = { chatId: 'other-chat', characterId: 3, chat: [] }; commit.resolve();
    const saved = await saving;
    assert.equal(saved.saved, true);
    assert.equal(saved.staleAfterSave, true);
    assert.equal(f.message.extra.media.length, 2);
    assert.equal(f.holder.context.chat.length, 0);
    assert.equal(f.calls.render.length, 0);
    assert.equal(f.calls.gallery[0][0].avatar, 'actor.png');
});
