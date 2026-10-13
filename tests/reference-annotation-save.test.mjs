import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { saveAnnotatedReference } from '../src/reference-annotation-save.js';
import { getCharacterRefs, updateCharacterRefs } from '../src/gallery.js';

const png = 'data:image/png;base64,YWJj';
const original = () => ({ refId: 'source-one', url: '/original-group.png', label: 'Original group', isPrimaryIdentity: true });
const result = (patch = {}) => ({ dataUrl: png, targetId: 'actor', label: 'One person', viewType: 'single', isPrimaryIdentity: true,
    annotation: { version: 1, sourceRefId: 'source-one', bounds: { x: .1, y: .2, width: .5, height: .6 }, sourceWidth: 100, sourceHeight: 100 }, ...patch });
const clone = value => structuredClone(value);
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

function fixture() {
    const source = original(), character = { name: 'Actor', avatar: 'actor.png' };
    const store = new Map([['actor.png', [clone(source), { refId: 'other-one', dataUrl: png, label: 'Other', isPrimaryIdentity: false }]],
        ['user', [{ refId: 'user-one', dataUrl: png, label: 'User main', isPrimaryIdentity: true }]]]);
    const queues = new Map(); let sequence = 0;
    const state = { reads: [], writes: [], beforeRead: null, beforeWrite: null };
    const get = async key => { state.reads.push(key); await state.beforeRead?.(key); return clone(store.get(key) || []); };
    const update = (key, change) => {
        state.writes.push(key);
        const pending = (queues.get(key) || Promise.resolve()).then(async () => {
            await state.beforeWrite?.(key);
            const next = change(clone(store.get(key) || []));
            assert.equal(typeof next?.then, 'undefined', 'The production transaction callback must stay synchronous');
            const written = next.map(view => ({ ...view, refId: view.refId || `added-${++sequence}` }));
            store.set(key, clone(written)); return clone(written);
        });
        queues.set(key, pending.catch(() => {})); return pending;
    };
    const targets = [{ id: 'actor', character }, { id: 'player', character: 'user' }];
    const options = { sourceCharacter: character, sourceView: source, targets, getCharacterRefs: get, updateCharacterRefs: update };
    return { source, character, targets, options, store, state,
        save: (value = result(), overrides = {}) => saveAnnotatedReference(value, { ...options, ...overrides }) };
}

test('a new primary crop is appended atomically while retaining the original image and unrelated fields', async () => {
    const f = fixture();
    const saved = await f.save({ ...result(), url: 'https://private.test/', backendKey: 'secret', refId: 'other-one',
        annotation: { ...result().annotation, apiKey: 'private', bounds: { ...result().annotation.bounds, secret: 'no' } } });
    const stored = f.store.get('actor.png');
    assert.equal(stored.length, 3); assert.equal(stored[0].url, '/original-group.png'); assert.equal(stored[0].refId, 'source-one');
    assert.equal(stored[0].isPrimaryIdentity, false); assert.equal(stored[1].isPrimaryIdentity, false);
    assert.equal(stored[2].isPrimaryIdentity, true); assert.equal(stored[2].enabled, true);
    assert.deepEqual(saved.targetCharacter, f.character); assert.deepEqual(saved.ref, stored[2]);
    assert.deepEqual(Object.keys(saved.ref.annotation).sort(), ['bounds', 'sourceHeight', 'sourceRefId', 'sourceWidth', 'version']);
    assert.equal(saved.ref.url, undefined); assert.equal(saved.ref.backendKey, undefined); assert.notEqual(saved.ref.refId, 'other-one');
    assert.doesNotMatch(JSON.stringify(saved.ref), /private|secret/);
});

test('saving into User keeps the source card intact and non-primary crops preserve the existing User main', async () => {
    const f = fixture(), before = clone(f.store.get('actor.png'));
    const saved = await f.save(result({ targetId: 'player', isPrimaryIdentity: false, viewType: 'face_crop' }));
    assert.equal(saved.targetCharacter, 'user'); assert.equal(saved.ref.viewType, 'face_crop');
    assert.deepEqual(f.store.get('actor.png'), before);
    assert.equal(f.store.get('user')[0].isPrimaryIdentity, true); assert.equal(f.store.get('user')[1].isPrimaryIdentity, false);
});

test('concurrent crops merge the latest target list and finish with one explicitly selected primary', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.save(result({ label: 'Crop A' })), f.save(result({ label: 'Crop B' }))]);
    const stored = f.store.get('actor.png');
    assert.deepEqual(stored.map(view => view.label), ['Original group', 'Other', 'Crop A', 'Crop B']);
    assert.equal(stored.filter(view => view.isPrimaryIdentity).length, 1);
    assert.equal(stored.at(-1).isPrimaryIdentity, true); assert.notEqual(a.ref.refId, b.ref.refId);
});

test('a source removed before reading cannot create a crop in any target', async () => {
    const f = fixture(); f.store.set('actor.png', []);
    await assert.rejects(f.save(result({ targetId: 'player' })), { code: 'REFERENCE_ANNOTATION_SOURCE_CHANGED' });
    assert.equal(f.state.writes.length, 0); assert.equal(f.store.get('user').length, 1);
});

test('source deletion between reading and the same-owner transaction is rechecked atomically', async () => {
    const f = fixture(); f.state.beforeWrite = () => { f.store.set('actor.png', f.store.get('actor.png').filter(view => view.refId !== 'source-one')); };
    await assert.rejects(f.save(), { code: 'REFERENCE_ANNOTATION_SOURCE_CHANGED' });
    assert.deepEqual(f.store.get('actor.png').map(view => view.refId), ['other-one']);
});

test('legacy source snapshots can match URL plus label and record the current stable reference ID', async () => {
    const f = fixture(); delete f.source.refId;
    const saved = await f.save(result({ annotation: { ...result().annotation, sourceRefId: undefined } }));
    assert.equal(saved.ref.annotation.sourceRefId, 'source-one'); assert.equal(f.store.get('actor.png')[0].url, '/original-group.png');
});

test('a legacy URL with a different label is not treated as the original source', async () => {
    const f = fixture(); delete f.source.refId; f.source.label = 'Changed source';
    await assert.rejects(f.save(), { code: 'REFERENCE_ANNOTATION_SOURCE_CHANGED' }); assert.equal(f.state.writes.length, 0);
});

test('a data-only source can be verified without fetching or saving media URLs', async t => {
    const f = fixture(); delete f.source.refId; delete f.source.url; f.source.dataUrl = png; f.source.label = 'Data source';
    f.store.set('actor.png', [{ ...f.source, refId: 'data-source' }]);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Reference annotation save must not send network requests'); });
    const saved = await f.save(result({ annotation: { ...result().annotation, sourceRefId: undefined } }));
    assert.equal(saved.ref.annotation.sourceRefId, 'data-source'); assert.equal(f.store.get('actor.png')[0].dataUrl, png);
});

test('unknown and ambiguous target selectors reject before reading any gallery', async () => {
    const f = fixture();
    await assert.rejects(f.save(result({ targetId: 'not-captured' })), { code: 'REFERENCE_ANNOTATION_INVALID' });
    f.targets.push({ id: 'actor', character: 'user' });
    await assert.rejects(f.save(), { code: 'REFERENCE_ANNOTATION_INVALID' }); assert.equal(f.state.reads.length, 0);
});

test('card, candidate and live target mutations during reading cannot redirect or change the captured crop', async () => {
    const f = fixture(), pending = deferred(), value = result();
    f.state.beforeRead = () => pending.promise;
    const saving = f.save(value);
    f.character.avatar = 'other.png'; f.targets[0].character = 'user';
    value.targetId = 'player'; value.label = 'Wrong live label'; value.dataUrl = 'data:image/png;base64,ZGVm';
    value.annotation.bounds.x = .5; value.viewType = 'face_crop';
    pending.resolve();
    const saved = await saving;
    assert.equal(saved.targetCharacter.avatar, 'actor.png'); assert.equal(saved.ref.label, 'One person');
    assert.equal(saved.ref.dataUrl, png); assert.equal(saved.ref.annotation.bounds.x, .1); assert.equal(saved.ref.viewType, 'single');
    assert.deepEqual(f.state.writes, ['actor.png']); assert.equal(f.store.get('user').length, 1);
});

test('an already aborted operation performs no reads or writes', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await assert.rejects(f.save(result(), { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.state.reads.length, 0); assert.equal(f.state.writes.length, 0);
});

test('abort during source reading is checked before the target transaction begins', async () => {
    const f = fixture(), controller = new AbortController(); f.state.beforeRead = () => controller.abort();
    await assert.rejects(f.save(result(), { signal: controller.signal }), { name: 'AbortError' }); assert.equal(f.state.writes.length, 0);
});

test('chat invalidation while queued is rejected inside the target transaction', async () => {
    const f = fixture(); let current = true;
    const before = clone(f.store.get('actor.png')); f.state.beforeWrite = () => { current = false; };
    await assert.rejects(f.save(result(), { isCurrent: () => current }), { name: 'AbortError' });
    assert.deepEqual(f.store.get('actor.png'), before);
});

test('abort while waiting for a target transaction preserves both existing images and primary flags', async () => {
    const f = fixture(), controller = new AbortController(), before = clone(f.store.get('actor.png'));
    f.state.beforeWrite = () => controller.abort();
    await assert.rejects(f.save(result(), { signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(f.store.get('actor.png'), before);
});

test('the target capacity is checked against the latest transaction list before changing primary flags', async () => {
    const f = fixture(), before = clone(f.store.get('actor.png'));
    await assert.rejects(f.save(result(), { maxRefs: 2 }), { code: 'REFERENCE_ANNOTATION_LIMIT' });
    assert.deepEqual(f.store.get('actor.png'), before);
    f.state.beforeWrite = () => { f.store.get('user').push({ refId: 'concurrent', dataUrl: png, label: 'Concurrent' }); };
    await assert.rejects(f.save(result({ targetId: 'player' }), { maxRefs: 2 }), { code: 'REFERENCE_ANNOTATION_LIMIT' });
    assert.equal(f.store.get('user').length, 2); assert.equal(f.store.get('user')[0].isPrimaryIdentity, true);
});

test('storage failures propagate without writing a stale fallback list', async () => {
    const f = fixture(), failure = new Error('storage unavailable');
    f.state.beforeWrite = () => { throw failure; };
    await assert.rejects(f.save(), error => error === failure);
    assert.equal(f.store.get('actor.png').length, 2); assert.equal(f.state.writes.length, 1);
});

test('malformed crops, unknown image kinds and mismatched source provenance reject before storage', async () => {
    const f = fixture();
    for (const value of [result({ dataUrl: 'https://private.test/remote.png' }), result({ viewType: 'three_views' }),
        result({ isPrimaryIdentity: 'true' }), result({ targetId: undefined }),
        result({ annotation: { ...result().annotation, sourceRefId: 'different-source' } }),
        result({ annotation: { ...result().annotation, bounds: { x: .9, y: .1, width: .5, height: .2 } } }),
        result({ annotation: { ...result().annotation, bounds: { x: .1, y: .1, width: .001, height: .001 } } }),
    ]) await assert.rejects(f.save(value));
    assert.equal(f.state.reads.length, 0);
});

test('the real IndexedDB adapter assigns a new crop ID and keeps source and User storage independent', async t => {
    const previous = globalThis.indexedDB; globalThis.indexedDB = new IDBFactory();
    t.after(() => { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; });
    t.mock.method(console, 'error', () => {});
    t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network'); });
    await updateCharacterRefs('actor.png', () => [original()]);
    await updateCharacterRefs('user', () => [{ dataUrl: png, label: 'Existing User', isPrimaryIdentity: true }]);
    const source = (await getCharacterRefs('actor.png'))[0];
    const saved = await saveAnnotatedReference(result({ targetId: 'player' }), {
        sourceCharacter: 'actor.png', sourceView: source, targets: [{ id: 'player', character: 'user' }], getCharacterRefs, updateCharacterRefs,
    });
    assert.ok(saved.ref.refId); assert.notEqual(saved.ref.refId, source.refId);
    assert.equal((await getCharacterRefs('actor.png')).length, 1);
    const users = await getCharacterRefs('user'); assert.equal(users.length, 2);
    assert.equal(users[0].isPrimaryIdentity, false); assert.equal(users[1].isPrimaryIdentity, true);
    assert.deepEqual(saved.ref, users[1]);
});

test('the real IndexedDB transaction merges concurrent same-owner crops instead of dropping one', async t => {
    const previous = globalThis.indexedDB; globalThis.indexedDB = new IDBFactory();
    t.after(() => { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; });
    t.mock.method(console, 'error', () => {});
    await updateCharacterRefs('actor.png', () => [original()]);
    const source = (await getCharacterRefs('actor.png'))[0];
    const options = { sourceCharacter: 'actor.png', sourceView: source, targets: [{ id: 'actor', character: 'actor.png' }], getCharacterRefs, updateCharacterRefs };
    await Promise.all([saveAnnotatedReference(result({ label: 'Real A' }), options), saveAnnotatedReference(result({ label: 'Real B' }), options)]);
    const refs = await getCharacterRefs('actor.png');
    assert.equal(refs.length, 3); assert.equal(refs.filter(ref => ref.isPrimaryIdentity).length, 1);
    assert.deepEqual(refs.map(ref => ref.label).sort(), ['Original group', 'Real A', 'Real B']);
});
