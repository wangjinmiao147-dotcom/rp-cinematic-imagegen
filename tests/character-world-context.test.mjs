import test from 'node:test';
import assert from 'node:assert/strict';
import {getCurrentWorldAgeContext} from '../src/character-world-context.js';
// Entirely fictional fixture: a stale age and a current age in a linked book.
const character={name:'林岚1',data:{extensions:{world:'林岚'},character_book:{entries:[{comment:'林岚',content:'外表年龄: 22岁'}]}}};
test('current linked world age overrides reliance on a stale embedded copy',async()=>{
    let loaded;
    const result=await getCurrentWorldAgeContext(character,async name=>{loaded=name;return {entries:{7:{comment:'林岚',disable:false,content:'name: 林岚\n外表年龄: 23岁\n备注: 保留22岁时的习惯。'}}};});
    assert.equal(loaded,'林岚');assert.match(result,/23岁/);assert.doesNotMatch(result,/22岁/);
});
test('unrelated or disabled entries cannot supply this actor age',async()=>{
    const result=await getCurrentWorldAgeContext(character,async()=>({entries:[{comment:'其他人',content:'年龄: 22岁'},{comment:'林岚',disable:true,content:'年龄: 22岁'}]}));assert.equal(result,'');
});
test('conflicting explicit age fields remain visible rather than being silently rewritten',async()=>{
    const result=await getCurrentWorldAgeContext(character,async()=>({entries:[{comment:'林岚',content:'外表年龄: 23岁\n实际年龄: 22岁'}]}));assert.match(result,/外表年龄: 23岁/);assert.match(result,/实际年龄: 22岁/);
});
test('missing books or absent age fields do not invent an age',async()=>{
    assert.equal(await getCurrentWorldAgeContext(character,async()=>null),'');
    assert.equal(await getCurrentWorldAgeContext(character,async()=>({entries:[{comment:'林岚',content:'容貌年轻，成年。'}]})),'');
    assert.equal(await getCurrentWorldAgeContext(character,async()=>{throw Error('unavailable');}), '');
});
test('cancellation stops before reading a world book',async()=>{
    let calls=0;const signal=AbortSignal.abort();await assert.rejects(getCurrentWorldAgeContext(character,async()=>{calls++;},{signal}));assert.equal(calls,0);
});
