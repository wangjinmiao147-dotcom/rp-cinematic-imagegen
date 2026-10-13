import test from 'node:test';
import assert from 'node:assert/strict';
import { getCardActors, saveCardActor } from '../src/card-cast.js';
import { effectiveCharacterIdentity, resolveCastReferencePlan } from '../src/character-identities.js';
import { snapshotGenerationSettings } from '../src/task-context.js';

const card={name:'测试版',avatar:'测试版.png'};
function fixture(){const settings={};for(const name of ['灵羽','洛衡','绯月','白烬']) saveCardActor(settings,card,{name,aliases:[`${name}别名`],anchor:`${name}的专属外貌`});return settings;}
test('one card has four distinct stable people, independent of its title',()=>{
 const settings=fixture(), parent=effectiveCharacterIdentity(card,settings), actors=getCardActors(parent,settings);
 assert.equal(parent.rpigCastMemberCount,4);assert.equal(actors.length,4);assert.equal(new Set(actors.map(a=>a.avatar)).size,4);
 const plan=resolveCastReferencePlan(['绯月','灵羽','白烬','洛衡'],{characters:[parent,...actors],focalCharacter:parent});
 assert.deepEqual(plan.map(p=>p.character?.name),['绯月','灵羽','白烬','洛衡']);
 assert.ok(plan.every(p=>p.kind==='character'&&p.character.rpigActor));
 assert.equal(resolveCastReferencePlan(['测试版'],{characters:[parent,...actors],focalCharacter:parent})[0].kind,'unmatched');
 assert.equal(resolveCastReferencePlan(['不存在的人'],{characters:[parent,...actors],focalCharacter:parent,aliases:{测试版:'不存在的人'}})[0].kind,'unmatched');
});
test('actor aliases select the same person and a rename preserves the image library key',()=>{
 const settings=fixture(), actor=getCardActors(card,settings)[0];
 const renamed=saveCardActor(settings,card,{name:'灵羽新名',aliases:['青羽'],anchor:'更新后的白裙'}, {id:actor.rpigActorId});
 assert.equal(renamed.avatar,actor.avatar);assert.equal(getCardActors(card,settings).length,4);
 const plan=resolveCastReferencePlan(['青羽'],{characters:getCardActors(card,settings),focalCharacter:card});
 assert.equal(plan[0].character.avatar,actor.avatar);
});
test('same names in separate story cards prefer the current card and otherwise stay ambiguous',()=>{
 const settings=fixture(), other={name:'另一张世界卡',avatar:'world2.png'};saveCardActor(settings,other,{name:'灵羽',anchor:'另一人物'});
 const actors=[...getCardActors(card,settings),...getCardActors(other,settings)];
 assert.equal(resolveCastReferencePlan(['灵羽'],{characters:actors,focalCharacter:card})[0].character.rpigParentAvatar,card.avatar);
 assert.equal(resolveCastReferencePlan(['灵羽'],{characters:actors})[0].kind,'unmatched');
});
test('same-card aliases cannot collide with another named person',()=>{
 const settings=fixture(); assert.throws(()=>saveCardActor(settings,card,{name:'第五人',aliases:['绯月'],anchor:''}),{code:'CARD_ACTOR_INVALID'});
 assert.equal(getCardActors(card,settings).length,4);
});
test('task snapshots cannot be altered by a later roster edit',()=>{
 const settings=fixture(), snapshot=snapshotGenerationSettings(settings),key=`character:${card.avatar}`;
 settings.characterCast[key][0].name='changed';settings.characterCast[key][0].aliases.push('late alias');
 assert.equal(snapshot.characterCast[key][0].name,'灵羽');assert.equal(snapshot.characterCast[key][0].aliases.length,1);
});
test('malformed saved actor records are excluded without falling back to a card avatar',()=>{
 const settings={characterCast:{'character:测试版.png':[{id:'bad/id',name:'假的'}, {id:'valid000',name:'坏\n名'}, {id:'valid001',name:'正常',anchor:'独立外貌'}]}};
 const actors=getCardActors(card,settings);assert.equal(actors.length,1);assert.equal(actors[0].name,'正常');assert.notEqual(actors[0].avatar,card.avatar);
});
test('a nested actor uses its parent roster when edited, never creates a second roster',()=>{
 const settings=fixture(), actor=getCardActors(card,settings)[0];saveCardActor(settings,actor,{name:actor.name,aliases:['新别名'],anchor:'白裙'}, {id:actor.rpigActorId});
 assert.deepEqual(Object.keys(settings.characterCast),['character:测试版.png']);
 assert.equal(getCardActors(card,settings)[0].aliases[0],'新别名');
});
