import test from 'node:test';
import assert from 'node:assert/strict';
import {expandQuotedEvidence} from '../src/analysis-normalization.js';
import {parseAnalysisResponse} from '../src/analysis-validation.js';

test('a verified sparse quote restores every intervening source sentence',()=>{
 const source='紫发法师独自站在庭院中央。同伴口误叫她绯越，指的是绯月。绯月抬起右手观察一枚发光符文。其他人离开。';
 const quote='紫发法师独自站在庭院中央。……绯月抬起右手观察一枚发光符文。';
 assert.equal(expandQuotedEvidence(quote,source),source.slice(0,source.indexOf('其他人')));
});
test('unknown, reversed, repeated and partial-word fragments are never accepted',()=>{
 const source='洛衡没有接书。灵羽站在门边。绯月握住法杖。';
 for(const raw of ['洛衡已经接书。……绯月握住法杖。','绯月握住法杖。……洛衡没有接书。','洛衡……接书。','灵羽……站在门边。','洛衡没有接书。……不存在的话。']) assert.equal(expandQuotedEvidence(raw,source),raw);
 const repeat='灵羽站在门边。洛衡没有接书。灵羽站在门边。';
 assert.equal(expandQuotedEvidence('灵羽站在门边。……洛衡没有接书。',repeat),'灵羽站在门边。……洛衡没有接书。');
});
test('a literal ellipsis in the story is preserved, with no rewriting',()=>{
 const source='灵羽说：“好吧……我去看看。”'; assert.equal(expandQuotedEvidence('好吧……我去看看。',source),'好吧……我去看看。');
});
test('ellipsis expansion still passes the original strict evidence validator',()=>{
 const source='绯月站在庭院中央。洛衡已经离开。绯月抬起右手。';
 const raw={moment:'绯月独自在庭院抬手',moment_evidence:'绯月站在庭院中央。……绯月抬起右手。',
 scene_state:{},actions:[{character:'绯月',action:'抬起右手',expression:null,gaze:null,contact:null}],explicit_changes:{clothing:[],environment:[],props:[]},thoughts:[],uncertainties:[],
 narrative_end_state:{},persistent_continues:null,persistent_updates:[],continuity_state:null,continuity_updates:[],narrative_end_updates:[]};
 const result=parseAnalysisResponse(JSON.stringify(raw),1,{latestStory:source});assert.equal(result.moment_evidence,source);
 raw.moment_evidence='绯月站在庭院中央。……绯月开始奔跑。';
 assert.throws(()=>parseAnalysisResponse(JSON.stringify(raw),1,{latestStory:source}),{code:'ANALYSIS_INVALID_EVIDENCE'});
});
