import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { effectiveCharacterIdentity } from '../src/character-identities.js';
import { getCardActors, saveCardActor } from '../src/card-cast.js';
import { stripHtml } from '../src/utils.js';
import { normalizeCastCharacters } from '../src/cast.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const production = source.slice(source.indexOf('function buildParticipantContext('), source.indexOf('async function getCharacterAvatarInfo('));
const build = new Function('effectiveCharacterIdentity', 'getCardActors', 'stripHtml', 'getCharacterVisualAnchor', production + '; return buildParticipantContext;')(
    effectiveCharacterIdentity, getCardActors, stripHtml, () => '');

test('a four-person story card supplies independent canonical candidates without declaring them all visible', () => {
    const card={name:'测试版',avatar:'four.png'}, settings={};
    for(const name of ['灵羽','洛衡','绯月','白烬']) saveCardActor(settings,card,{name,anchor:`${name}专属外貌`});
    const text=build({name1:'玩家',characters:[card]},[{name:'测试版',mes:'绯月独自在庭院里。'}],0,effectiveCharacterIdentity(card,settings),{},settings);
    for(const name of ['灵羽','洛衡','绯月','白烬']) assert.match(text,new RegExp(`canonical_name=${name}`));
    assert.doesNotMatch(text,/canonical_name=测试版/);assert.match(text,/presence=unknown/);
    assert.equal((text.match(/卡内独立人物/g)||[]).length,4);
});

test('production participant prompts distinguish story titles from canonical people without modifying cards', () => {
    const card = { name: '北城故事合集', avatar: 'stories.png', description: '林岚是此卡的主角，周禾也可能在场。' };
    const context = { name1: '玩家', characters: [card] };
    const chat = [{ name: card.name, mes: '林岚在门边等候。' }];
    const focal = effectiveCharacterIdentity(card, {});
    const text = build(context, chat, 0, focal, {}, {});
    assert.match(text, /card_title=北城故事合集/);
    assert.doesNotMatch(text, /canonical_name=北城故事合集/);
    assert.match(text, /设定=林岚是此卡的主角/);
    assert.match(text, /不能把标题强塞给一个人物/);
    assert.equal(card.hasExplicitIdentity, undefined);
    assert.deepEqual(normalizeCastCharacters([{ canonical_name: '林岚' }], { context, chat, messageIndex: 0,
        focalCharacter: focal, focalIdentityIsConfirmed: false, fallbackToFocal: false }), ['林岚']);
});

test('configured true names retain avatar-bound card context in production prompts', () => {
    const card = { name: '北城故事合集', avatar: 'stories.png' };
    const settings = { characterIdentityOverrides: { 'character:stories.png': { name: '林岚', aliases: ['小岚'] } } };
    const focal = effectiveCharacterIdentity(card, settings);
    const text = build({ characters: [card] }, [{ name: card.name, mes: '小岚在门边等候。' }], 0, focal, {}, settings);
    assert.match(text, /identity=character:stories\.png；canonical_name=林岚/);
    assert.match(text, /aliases=小岚/);
    assert.equal(card.name, '北城故事合集');
});
