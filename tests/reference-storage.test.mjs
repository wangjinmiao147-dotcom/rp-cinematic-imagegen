import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBDatabase, IDBObjectStore } from 'fake-indexeddb';
import { getCharacterRefs, saveCharacterRefs } from '../src/gallery.js';

function setup(t) {
    const previous=globalThis.indexedDB;globalThis.indexedDB=new IDBFactory();
    t.after(()=>{if(previous===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=previous;});
    t.mock.method(console,'error',()=>{});
}

test('successful reference write and read; browser database isolation is explicit', async t => {
    setup(t);
    const refs=[{url:'/images/front.png',label:'front'}];
    await saveCharacterRefs('avatar.png',refs);
    assert.deepEqual(await getCharacterRefs('avatar.png'),refs);
    globalThis.indexedDB=new IDBFactory();
    assert.deepEqual(await getCharacterRefs('avatar.png'),[]);
});

test('IndexedDB unavailable and SecurityError reject instead of returning empty refs', async t => {
    setup(t);globalThis.indexedDB=undefined;
    await assert.rejects(getCharacterRefs('avatar.png'),{code:'REFERENCE_STORAGE_READ_FAILED'});
    await assert.rejects(saveCharacterRefs('avatar.png',[]),{code:'REFERENCE_STORAGE_WRITE_FAILED'});
    globalThis.indexedDB={open(){throw new DOMException('storage denied','SecurityError');}};
    await assert.rejects(getCharacterRefs('avatar.png'),e=>e.code==='REFERENCE_STORAGE_READ_FAILED'&&/SecurityError/.test(e.message));
});

test('write transaction abort rejects rather than hanging or using undefined reject', async t => {
    setup(t);
    const original=IDBDatabase.prototype.transaction;
    t.mock.method(IDBDatabase.prototype,'transaction',function(...args){const tx=original.apply(this,args);if(args[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;});
    await assert.rejects(saveCharacterRefs('avatar.png',[{url:'/front.png'}]),{code:'REFERENCE_STORAGE_WRITE_FAILED'});
});

test('read transaction abort is not treated as missing references', async t => {
    setup(t);await saveCharacterRefs('avatar.png',[{url:'/front.png'}]);
    const original=IDBDatabase.prototype.transaction;
    t.mock.method(IDBDatabase.prototype,'transaction',function(...args){const tx=original.apply(this,args);queueMicrotask(()=>tx.abort());return tx;});
    await assert.rejects(getCharacterRefs('avatar.png'),{code:'REFERENCE_STORAGE_READ_FAILED'});
});

test('object store read exception preserves its cause', async t => {
    setup(t);await saveCharacterRefs('avatar.png',[]);
    t.mock.method(IDBObjectStore.prototype,'get',()=>{throw new DOMException('bad transaction','InvalidStateError');});
    await assert.rejects(getCharacterRefs('avatar.png'),e=>e.code==='REFERENCE_STORAGE_READ_FAILED'&&/InvalidStateError/.test(e.message));
});
