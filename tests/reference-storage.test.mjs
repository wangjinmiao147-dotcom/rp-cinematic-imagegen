import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBDatabase, IDBObjectStore } from 'fake-indexeddb';
import { getCharacterRefs, saveCharacterRefs, updateCharacterRefs, getStoredGallery, saveToGallery,
    removeFromGallery, openGalleryDB, deleteImageCompletely, getPreviousGeneratedImage, persistMediaUrl } from '../src/gallery.js';

function setup(t) {
    const previous=globalThis.indexedDB;globalThis.indexedDB=new IDBFactory();
    t.after(()=>{if(previous===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=previous;});
    t.mock.method(console,'error',()=>{});
}

const withoutRefIds = views => views.map(({ refId, ...view }) => view);

test('successful reference write and read; browser database isolation is explicit', async t => {
    setup(t);
    const refs=[{url:'/images/front.png',label:'front'}];
    await saveCharacterRefs('avatar.png',refs);
    const stored = await getCharacterRefs('avatar.png');
    assert.deepEqual(withoutRefIds(stored),refs);
    assert.ok(stored[0].refId);
    assert.deepEqual(await getCharacterRefs('avatar.png'),stored);
    globalThis.indexedDB=new IDBFactory();
    assert.deepEqual(await getCharacterRefs('avatar.png'),[]);
});

test('User reference images use an isolated storage key', async t => {
    setup(t);
    const userRefs=[{dataUrl:'data:image/png;base64,dXNlcg==',label:'User front'}];
    await saveCharacterRefs('user',userRefs);
    assert.deepEqual(withoutRefIds(await getCharacterRefs('user')),userRefs);
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

test('concurrent gallery inserts and removals preserve unrelated images', async t => {
    setup(t);
    await Promise.all([saveToGallery('actor.png', {url:'/a.png'}), saveToGallery('actor.png', {url:'/b.png'})]);
    assert.deepEqual((await getStoredGallery('actor.png')).map(i=>i.url).sort(), ['/a.png','/b.png']);
    await Promise.all([removeFromGallery('actor.png','/a.png'), saveToGallery('actor.png',{url:'/c.png'})]);
    assert.deepEqual((await getStoredGallery('actor.png')).map(i=>i.url).sort(), ['/b.png','/c.png']);
});

test('concurrent reference updates preserve both additions', async t => {
    setup(t);
    await Promise.all([
        updateCharacterRefs('actor.png', views => [...views, {url:'/a.png'}]),
        updateCharacterRefs('actor.png', views => [...views, {url:'/b.png'}]),
    ]);
    assert.deepEqual((await getCharacterRefs('actor.png')).map(i=>i.url).sort(), ['/a.png','/b.png']);
});

test('reference overflow rejects without truncating or replacing saved references', async t => {
    setup(t);
    const refs = Array.from({length:50}, (_,i)=>({url:`/${i}.png`}));
    await saveCharacterRefs('actor.png', refs);
    await assert.rejects(updateCharacterRefs('actor.png', views => [...views, {url:'/overflow.png'}]), {code:'REFERENCE_STORAGE_WRITE_FAILED'});
    assert.deepEqual(withoutRefIds(await getCharacterRefs('actor.png')), refs);
});

test('async reference updater aborts instead of claiming an unsaved update', async t => {
    setup(t); await saveCharacterRefs('actor.png', [{url:'/original.png'}]);
    await assert.rejects(updateCharacterRefs('actor.png', async () => []), {code:'REFERENCE_STORAGE_WRITE_FAILED'});
    assert.deepEqual(withoutRefIds(await getCharacterRefs('actor.png')), [{url:'/original.png'}]);
});

test('gallery read error rejects and cannot erase existing images during an add', async t => {
    setup(t); await saveToGallery('actor.png', {url:'/original.png'});
    const originalGet = IDBObjectStore.prototype.get;
    let fail = true;
    t.mock.method(IDBObjectStore.prototype,'get',function(...args) {
        if (!fail) return originalGet.apply(this,args);
        const req = {error:new DOMException('read denied','UnknownError')};
        queueMicrotask(()=>req.onerror());
        return req;
    });
    await assert.rejects(getStoredGallery('actor.png'), {code:'GALLERY_STORAGE_READ_FAILED'});
    await assert.rejects(saveToGallery('actor.png',{url:'/new.png'}), {code:'GALLERY_STORAGE_WRITE_FAILED'});
    fail = false;
    assert.deepEqual(await getStoredGallery('actor.png'), [{url:'/original.png'}]);
});

for (const mode of ['readonly', 'readwrite']) test(`gallery ${mode} abort rejects and preserves saved images`, async t => {
    setup(t); await saveToGallery('actor.png', {url:'/original.png'});
    const original = IDBDatabase.prototype.transaction;
    let abort = true;
    t.mock.method(IDBDatabase.prototype,'transaction',function(...args) {
        const tx = original.apply(this,args);
        if (abort && args[1] === mode) queueMicrotask(()=>tx.abort());
        return tx;
    });
    await assert.rejects(mode === 'readonly' ? getStoredGallery('actor.png') : saveToGallery('actor.png',{url:'/new.png'}),
        {code:mode === 'readonly' ? 'GALLERY_STORAGE_READ_FAILED' : 'GALLERY_STORAGE_WRITE_FAILED'});
    abort = false;
    assert.deepEqual(await getStoredGallery('actor.png'), [{url:'/original.png'}]);
});

test('gallery unavailable rejects rather than reporting an empty read or successful save', async t => {
    setup(t); globalThis.indexedDB = undefined;
    await assert.rejects(getStoredGallery('actor.png'), {code:'GALLERY_STORAGE_READ_FAILED'});
    await assert.rejects(saveToGallery('actor.png',{url:'/new.png'}), {code:'GALLERY_STORAGE_WRITE_FAILED'});
    await assert.rejects(removeFromGallery('actor.png','/new.png'), {code:'GALLERY_STORAGE_WRITE_FAILED'});
});

test('reference and gallery operations close their connections, including errors', async t => {
    setup(t);
    const closed = new Set(); const originalClose = IDBDatabase.prototype.close;
    t.mock.method(IDBDatabase.prototype,'close',function() {closed.add(this); return originalClose.call(this);});
    await saveToGallery('actor.png',{url:'/new.png'});
    await getStoredGallery('actor.png');
    await saveCharacterRefs('actor.png',[]);
    await getCharacterRefs('actor.png');
    t.mock.method(IDBObjectStore.prototype,'get',()=>{throw new Error('bad read');});
    await assert.rejects(getStoredGallery('actor.png'), {code:'GALLERY_STORAGE_READ_FAILED'});
    assert.equal(closed.size, 5);
});

test('blocked gallery open rejects and a later successful connection is closed', async t => {
    setup(t); let request; let closed = false;
    globalThis.indexedDB = {open() {
        request = {result:{close(){closed=true;}}};
        queueMicrotask(()=>request.onblocked()); return request;
    }};
    await assert.rejects(openGalleryDB(), {code:'GALLERY_STORAGE_BLOCKED'});
    request.onsuccess(); assert.equal(closed, true);
});

function deletionFixture() {
    const character = {name:'Actor', avatar:'actor.png'};
    const info = {outputUrl:'/deleted.png',focusSnippet:'scene',basePrompt:'prompt',sceneState:{location:'room'}};
    const message = {is_user:false,name:'Actor',mes:'scene',extra:{image:'/deleted.png',media:[{url:'/deleted.png'},{url:'/keep.png'}],image_swipes:['/deleted.png'],rpigInfo:info}};
    const context = {chatId:'old',characterId:0,chat:[message],saveChat:async()=>{}};
    return {character,message,context};
}

test('complete deletion clears continuity URL while retaining unrelated media and scene metadata', async t => {
    setup(t); const {character,message,context} = deletionFixture();
    await saveToGallery(character,{url:'/deleted.png'});
    await saveCharacterRefs(character,[{url:'/deleted.png'},{url:'/keep.png'}]);
    const result = await deleteImageCompletely(character,'/deleted.png',()=>context);
    assert.deepEqual(result.affectedMessageIndexes,[0]); assert.equal(result.chatModified,true);
    assert.equal(result.context,context); assert.equal(result.chatSkipped,false);
    assert.equal(message.extra.rpigInfo.outputUrl,undefined);
    assert.deepEqual(message.extra.rpigInfo.sceneState,{location:'room'});
    assert.equal(message.extra.rpigInfo.basePrompt,'prompt');
    assert.deepEqual(message.extra.media,[{url:'/keep.png'}]);
    assert.equal(getPreviousGeneratedImage(context.chat,0,character)?.url,'/keep.png');
    assert.deepEqual(withoutRefIds(await getCharacterRefs(character)),[{url:'/keep.png'}]);
    assert.deepEqual(await getStoredGallery(character),[]);
    await deleteImageCompletely(character,'/keep.png',()=>context);
    assert.equal(getPreviousGeneratedImage(context.chat,0,character),null);
});

test('deleting a different image keeps the recorded final output intact', async t => {
    setup(t); const {character,message,context} = deletionFixture();
    await deleteImageCompletely(character,'/keep.png',()=>context);
    assert.equal(message.extra.rpigInfo.outputUrl,'/deleted.png');
});

test('switching chat during database deletion never edits or saves the newly selected chat', async t => {
    setup(t); const {character,message,context} = deletionFixture();
    const next = deletionFixture().context; next.chatId = 'new';
    let current = context; let saves = 0;
    next.saveChat = async()=>{saves++;}; context.saveChat = async()=>{saves++;};
    const original = IDBObjectStore.prototype.get;
    t.mock.method(IDBObjectStore.prototype,'get',function(...args) {
        const request = original.apply(this,args);
        queueMicrotask(()=>{current=next;}); return request;
    });
    const result = await deleteImageCompletely(character,'/deleted.png',()=>current);
    assert.equal(result.chatSkipped,true); assert.equal(result.chatModified,false);
    assert.deepEqual(result.affectedMessageIndexes,[]); assert.equal(saves,0);
    assert.equal(message.extra.image,'/deleted.png'); assert.equal(next.chat[0].extra.image,'/deleted.png');
});

test('switching chat id in place is detected even when the chat array stays the same', async t => {
    setup(t); const {character,message,context} = deletionFixture();
    const original = IDBObjectStore.prototype.get;
    t.mock.method(IDBObjectStore.prototype,'get',function(...args) {
        const request = original.apply(this,args);
        queueMicrotask(()=>{context.chatId='new';}); return request;
    });
    const result = await deleteImageCompletely(character,'/deleted.png',()=>context);
    assert.equal(result.chatSkipped,true); assert.equal(message.extra.image,'/deleted.png');
});

test('failed chat deletion persistence restores its fields and retains concurrent changes', async t => {
    setup(t); t.mock.method(console,'warn',()=>{});
    const {character,message,context} = deletionFixture();
    const originalMedia = message.extra.media; const originalInfo = message.extra.rpigInfo;
    context.saveChat = async()=>{
        message.extra.image = '/concurrent.png';
        throw new Error('chat save failed');
    };
    await assert.rejects(deleteImageCompletely(character,'/deleted.png',()=>context), /chat save failed/);
    assert.equal(message.extra.media,originalMedia); assert.equal(message.extra.rpigInfo,originalInfo);
    assert.equal(message.extra.image,'/concurrent.png');
});

test('chat without a persistence API is left unchanged by deletion', async t => {
    setup(t); t.mock.method(console,'warn',()=>{});
    const {character,message,context} = deletionFixture(); delete context.saveChat;
    await assert.rejects(deleteImageCompletely(character,'/deleted.png',()=>context), {code:'GALLERY_CHAT_SAVE_FAILED'});
    assert.equal(message.extra.image,'/deleted.png');
});

test('media persistence forwards cancellation and never saves a cancelled download', async t => {
    const controller = new AbortController(); let saves = 0;
    await assert.rejects(persistMediaUrl('https://cdn.test/image.png','actor',{
        signal:controller.signal,
        fetchToDataUrl:async(_url, options)=>{
            assert.equal(options.signal,controller.signal); controller.abort();
            return 'data:image/png;base64,YWJj';
        },
        saveBase64AsFile:()=>{saves++;},
    }), {name:'AbortError'});
    assert.equal(saves,0);
});

test('cancel during media file save preserves AbortError rather than wrapping it', async () => {
    const controller = new AbortController();
    await assert.rejects(persistMediaUrl('data:image/png;base64,YWJj','actor',{
        signal:controller.signal,
        saveBase64AsFile:async()=>{controller.abort(); return '/saved.png';},
    }), {name:'AbortError'});
});
