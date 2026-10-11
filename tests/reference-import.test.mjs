import test from 'node:test';
import assert from 'node:assert/strict';
import { readReferenceImport, exportReferenceArchive, parseReferenceArchive } from '../src/reference-transfer.js';
const convert = async blob => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64');
function file(bytes,name,type='') { const b=new Blob([bytes],{type});b.name=name;return b; }
test('ordinary PNG imports its bytes and label even with missing Android MIME',async()=>{
    const [ref]=await readReferenceImport(file(png,'正面.png'),convert);
    assert.equal(ref.label,'正面');assert.equal(ref.dataUrl,`data:image/png;base64,${png.toString('base64')}`);assert.equal(ref.url,undefined);
});
test('actual JPEG bytes take precedence over wrong provider MIME',async()=>{
    const [ref]=await readReferenceImport(file(new Uint8Array([255,216,255,224]),'photo.jpg','application/octet-stream'),convert);
    assert.ok(ref.dataUrl.startsWith('data:image/jpeg;base64,'));
});
test('JSON reference archives remain importable',async()=>{
    const dataUrl=`data:image/png;base64,${png.toString('base64')}`;
    const refs=await readReferenceImport(file(JSON.stringify({format:'rpig-references',version:1,views:[{label:'saved',dataUrl}]}),'refs.json'),convert);
    assert.deepEqual(refs,[{label:'saved',dataUrl,isPrimaryIdentity:false,viewType:'single',enabled:true}]);
});
test('renaming text to jpg does not import text as an image',async()=>{
    await assert.rejects(readReferenceImport(file('not an image','photo.jpg','image/jpeg'),convert),{code:'REFERENCE_IMPORT_INVALID'});
});
test('empty and oversized files fail before conversion',async()=>{
    await assert.rejects(readReferenceImport(file('','empty.png'),convert));
    await assert.rejects(readReferenceImport({size:31*1024*1024},convert));
});

test('portable export preserves duplicate image views and their primary/purpose/enabled metadata',async()=>{
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const views = [
        {label:'disabled support',dataUrl,isPrimaryIdentity:false,enabled:false,viewType:'face_crop'},
        {label:'primary',dataUrl,isPrimaryIdentity:true,enabled:true,viewType:'full_body'},
    ];
    assert.deepEqual(parseReferenceArchive(await exportReferenceArchive(views)),views);
});

test('portable export refuses reference overflow instead of silently removing duplicates',async()=>{
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    await assert.rejects(exportReferenceArchive(Array.from({length:51},()=>({dataUrl}))),{code:'REFERENCE_ARCHIVE_INVALID'});
});

test('legacy design sheet labels retain their purpose when exported and imported',async()=>{
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const views = parseReferenceArchive(await exportReferenceArchive([
        {label:'📐 图生图三视图',dataUrl},
        {label:'主图脸部特写',dataUrl},
        {label:'🧍 图生图全身立绘',dataUrl},
    ]));
    assert.deepEqual(views.map(view=>view.viewType),['three_views','face_crop','full_body']);
    assert.equal(parseReferenceArchive(JSON.stringify({format:'rpig-references',version:1,views:[{label:'三视图',dataUrl}]}))[0].viewType,'three_views');
});
