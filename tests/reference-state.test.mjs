import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { getCharacterRefs, saveCharacterRefs, updateCharacterRefs, openRefsDB } from '../src/gallery.js';
import { IDBDatabase } from 'fake-indexeddb';
import { mergeReferenceViews, modifyReferenceViews } from '../src/reference-state.js';

test('concurrent UI import and property edit preserve both changes', async t => {
    const character = { avatar: 'ui-concurrent.png' };
    const reference = { url: '/original.png', label: 'Identity', isPrimaryIdentity: true };
    await saveCharacterRefs(character, [reference]);
    await Promise.all([
        updateCharacterRefs(character, views => mergeReferenceViews(views, [{ url: '/imported.png', isPrimaryIdentity: true }])),
        updateCharacterRefs(character, views => modifyReferenceViews(views, reference, 'viewType', 'face_crop')),
    ]);
    const views = await getCharacterRefs(character);
    assert.equal(views.length, 2);
    assert.equal(views[0].viewType, 'face_crop');
    assert.equal(views[0].isPrimaryIdentity, true);
    assert.equal(views[1].isPrimaryIdentity, false);
});

test('two stale UI delete buttons remove their own records rather than shifted indexes', async t => {
    const character = { avatar: 'ui-delete.png' };
    const views = ['a', 'b', 'c'].map(label => ({ url: `/${label}.png`, label }));
    await saveCharacterRefs(character, views);
    await updateCharacterRefs(character, current => modifyReferenceViews(current, views[0], 'remove'));
    await updateCharacterRefs(character, current => modifyReferenceViews(current, views[1], 'remove'));
    assert.deepEqual((await getCharacterRefs(character)).map(v => v.label), ['c']);
});

test('a stale button cannot resurrect a removed reference', () => {
    const target = { url: '/removed.png' };
    assert.throws(() => modifyReferenceViews([], target, 'primary'), /已被移除/);
});

test('an imported batch has at most one primary and cannot exceed the limit', () => {
    const imported = [{ url: '/a.png', isPrimaryIdentity: true }, { url: '/b.png', isPrimaryIdentity: true }];
    const views = mergeReferenceViews([], imported);
    assert.deepEqual(views.map(v => v.isPrimaryIdentity), [true, false]);
    assert.throws(() => mergeReferenceViews(views, imported, 3), /超过/);
    assert.equal(imported[1].isPrimaryIdentity, true, 'Import metadata is not mutated');
});

test('selecting a disabled reference as primary enables it without discarding other metadata', () => {
    const target = { url: '/identity.png', label: 'Identity', enabled: false, viewType: 'full_body' };
    const views = modifyReferenceViews([target], target, 'primary');
    assert.equal(views[0].enabled, true);
    assert.equal(views[0].viewType, 'full_body');
    assert.equal(views[0].isPrimaryIdentity, true);
    assert.equal(target.enabled, false);
});

async function writeLegacyRefs(characterId, views) {
    const db = await openRefsDB();
    try {
        await new Promise((resolve,reject)=>{
            const tx = db.transaction('refs','readwrite');
            tx.objectStore('refs').put({characterId,views});
            tx.oncomplete = resolve;
            tx.onerror = tx.onabort = () => reject(tx.error || new Error('legacy write aborted'));
        });
    } finally { db.close(); }
}

test('legacy reference migration assigns stable distinct ids without changing image metadata', async () => {
    const key = 'legacy-duplicate.png';
    const legacy = [
        {url:'/same.png',label:'same',viewType:'single',enabled:false},
        {url:'/same.png',label:'same',viewType:'three_views',isPrimaryIdentity:true},
    ];
    await writeLegacyRefs(key,legacy);
    const [first,second] = await Promise.all([getCharacterRefs(key),getCharacterRefs(key)]);
    assert.equal(new Set(first.map(view=>view.refId)).size,2);
    assert.deepEqual(first,second);
    assert.deepEqual(first.map(({refId,...view})=>view),legacy);
    assert.deepEqual(await getCharacterRefs(key),first);
});

test('migration re-reads atomically and keeps a concurrent import', async () => {
    const key = 'legacy-concurrent.png';
    await writeLegacyRefs(key,[{url:'/old.png'}]);
    const [migrated] = await Promise.all([
        getCharacterRefs(key),
        updateCharacterRefs(key,views=>mergeReferenceViews(views,[{url:'/imported.png'}])),
    ]);
    assert.deepEqual(migrated.map(view=>view.url),['/old.png','/imported.png']);
    assert.equal(new Set(migrated.map(view=>view.refId)).size,2);
    assert.deepEqual(await getCharacterRefs(key),migrated);
});

test('same image and label records use their ids for primary changes and deletion', async () => {
    const key = 'ui-identical-sources.png';
    await saveCharacterRefs(key,[
        {url:'/same.png',label:'same',viewType:'single'},
        {url:'/same.png',label:'same',viewType:'three_views',enabled:false},
    ]);
    const original = await getCharacterRefs(key);
    assert.notEqual(original[0].refId,original[1].refId);
    const primary = await updateCharacterRefs(key,views=>modifyReferenceViews(views,original[1],'primary'));
    assert.equal(primary[0].isPrimaryIdentity,false);
    assert.equal(primary[1].isPrimaryIdentity,true);
    assert.equal(primary[1].enabled,true);
    const edited = await updateCharacterRefs(key,views=>modifyReferenceViews(views,original[1],'viewType','face_crop'));
    assert.equal(edited[0].viewType,'single'); assert.equal(edited[1].viewType,'face_crop');
    await updateCharacterRefs(key,views=>modifyReferenceViews(views,original[1],'remove'));
    assert.deepEqual(await getCharacterRefs(key),[edited[0]]);
    await assert.rejects(updateCharacterRefs(key,views=>modifyReferenceViews(views,original[1],'remove')), /已被移除/);
    assert.deepEqual(await getCharacterRefs(key),[edited[0]]);
});

test('new records and duplicate provided ids are normalized without changing existing ids', async () => {
    const key = 'ui-duplicate-ids.png';
    await saveCharacterRefs(key,[{url:'/a.png',refId:'keep-id'}]);
    const result = await updateCharacterRefs(key,views=>[...views,{url:'/b.png',refId:'keep-id'},{url:'/c.png'}]);
    assert.equal(result[0].refId,'keep-id');
    assert.equal(new Set(result.map(view=>view.refId)).size,3);
    assert.ok(result.every(view=>view.refId));
    assert.deepEqual(await getCharacterRefs(key),result);
});

test('reference ids also work without crypto.randomUUID', async t => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis,'crypto');
    Object.defineProperty(globalThis,'crypto',{value:undefined,configurable:true});
    t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else delete globalThis.crypto;});
    const key = 'ui-legacy-webview.png';
    await saveCharacterRefs(key,[{url:'/a.png'},{url:'/b.png'}]);
    const result = await getCharacterRefs(key);
    assert.equal(new Set(result.map(view=>view.refId)).size,2);
    assert.ok(result.every(view=>typeof view.refId==='string' && view.refId));
    assert.deepEqual(await getCharacterRefs(key),result);
});

test('migration write abort remains a reference read failure rather than an empty library', async t => {
    const key = 'legacy-abort.png'; await writeLegacyRefs(key,[{url:'/old.png'}]);
    t.mock.method(console,'error',()=>{});
    const original = IDBDatabase.prototype.transaction;
    let abort = true;
    t.mock.method(IDBDatabase.prototype,'transaction',function(...args) {
        const tx = original.apply(this,args);
        if(abort && args[1]==='readwrite')queueMicrotask(()=>tx.abort());
        return tx;
    });
    await assert.rejects(getCharacterRefs(key), error=>error.code==='REFERENCE_STORAGE_READ_FAILED'
        && error.details.reason==='REFERENCE_STORAGE_WRITE_FAILED');
    abort = false;
    const result = await getCharacterRefs(key);
    assert.equal(result[0].url,'/old.png'); assert.ok(result[0].refId);
});
