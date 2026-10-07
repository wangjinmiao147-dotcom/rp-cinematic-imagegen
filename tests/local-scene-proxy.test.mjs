import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {makeNativeRequest,makeOpenAIResult,resourceFailure} from '../tools/local-scene-llm/local-scene-llm.mjs';
import {sceneAdapter,normalizeSceneOutput,restoreCanonicalNames} from '../tools/local-scene-llm/scene-output-adapter.mjs';
import {buildStoryFactsPrompt,buildRelationCheckerPrompt} from '../src/prompts.js';
const config=JSON.parse(fs.readFileSync(new URL('../tools/local-scene-llm/local-scene-config.example.json',import.meta.url)));
const input={model:config.model,messages:[{role:'system',content:'完整原有规则'},{role:'user',content:'夏禾左手指着钥匙；周禾右手握两把。'}],response_format:{type:'json_object'}};
test('the proxy preserves full Unicode story and instructions, releases the GPU and requests complete JSON',()=>{
  const body=makeNativeRequest(input,config);
  assert.ok(body.messages[0].content.startsWith(input.messages[0].content+'\n\n'));assert.match(body.messages[0].content,/规范姓名逐字保留中文/);
  assert.equal(body.messages[1].role,input.messages[1].role);assert.ok(body.messages[1].content.startsWith(input.messages[1].content+'\n\n'));
  assert.match(body.messages[1].content,/指向不证明触碰/);assert.match(body.messages[1].content,/只有其余描述译为英文/);assert.match(body.messages[1].content,/已有的局部入镜限制仍优先/);
  assert.equal(body.keep_alive,0);assert.equal(body.stream,false);assert.equal(body.format,'json');
  assert.equal(body.options.num_ctx,16384);assert.equal(body.options.num_batch,config.numBatch);assert.equal(body.think,config.think);
});
test('a request cannot silently substitute an untested larger model',()=>{
  assert.throws(()=>makeNativeRequest({...input,model:'27b'},config),/已配置/);
});
test('thinking text is not used as the final scene analysis',()=>{
  const final='{"edit_instruction":"夏禾 points at the key."}';
  const result=makeOpenAIResult({message:{content:final,thinking:'internal reasoning'},done_reason:'stop',prompt_eval_count:10,eval_count:20},config.model,'test');
  assert.equal(result.choices[0].message.content,final);assert.equal(result.usage.total_tokens,30);assert.equal(JSON.stringify(result).includes('internal reasoning'),false);
});
test('partial results and missing final content cannot be sent to the image generator',()=>{
  assert.throws(()=>makeOpenAIResult({message:{content:'{}'},done_reason:'length'},config.model,'test'),/不完整/);
  assert.throws(()=>makeOpenAIResult({message:{thinking:'only thought'},done_reason:'stop'},config.model,'test'),/完整/);
});
test('actual thermal, VRAM and system RAM limits stop analysis',()=>{
  const normal={temperatureC:65,usedMiB:3500,systemFreeGiB:4};assert.equal(resourceFailure(normal,config),'');
  assert.equal(resourceFailure({...normal,temperatureC:config.abortTemperatureC-1},config),'');
  assert.match(resourceFailure({...normal,temperatureC:config.abortTemperatureC},config),/温度/);
  assert.match(resourceFailure({...normal,usedMiB:config.maxGpuUsedMiB},config),/显存/);
  assert.match(resourceFailure({...normal,systemFreeGiB:1},config),/内存/);
});
test('structured final output keeps verified actor names and scopes, without an independent prop-preservation rewrite',()=>{
  const cast={visible_characters:[{canonical_name:'夏禾',visible_scope:null},{canonical_name:'周禾',visible_scope:'right hand and forearm only'}]};
  const user='【完整最新剧情正文】\n原剧情不能删除。\n【已核对的人物关系】\n'+JSON.stringify(cast)+'\n\n【本次明确要求变化的内容】\n无';
  const task={...input,messages:[{role:'system',content:'你是插画流水线中的“图像编辑指令编写器”。保留所有原有规则。'},{role:'user',content:user}]};
  const adapter=sceneAdapter(task),native=makeNativeRequest(task,config);
  assert.deepEqual(adapter.names,['夏禾','周禾']);
  assert.ok(native.messages[0].content.startsWith(task.messages[0].content));assert.ok(native.messages[1].content.startsWith(user));
  assert.deepEqual(native.format.properties.subjects.required,adapter.names);
  const output={subjects:{'夏禾':{action:'points with her left hand at one key on the table',appearance:'wearing a white top and a red skirt',visibility:''},'周禾':{action:'holds two keys in his right hand',appearance:'',visibility:'showing only that hand and forearm'}},scene_instruction:'',camera_view:'front',framing:'default',thought_bubble_instruction:'',exclude:[]};
  const result=JSON.parse(normalizeSceneOutput(JSON.stringify(output),adapter));
  assert.match(result.edit_instruction,/夏禾 points/);assert.match(result.edit_instruction,/周禾 holds two keys/);assert.match(result.edit_instruction,/white top and a red skirt/);assert.match(result.edit_instruction,/inside the image/);assert.equal(result.preserve,'');
  delete output.subjects['周禾'];output.subjects.Aki='wrong name';
  assert.throws(()=>normalizeSceneOutput(JSON.stringify(output),adapter),/姓名与动作/);
});
test('a malformed actor section fails instead of guessing a cast',()=>{
  assert.throws(()=>sceneAdapter({messages:[{role:'system',content:'你是插画流水线中的“图像编辑指令编写器”。'},{role:'user',content:'【已核对的人物关系】\n{'}]}),/不完整/);
});
test('other analysis stages mentioning the editor are passed through normally',()=>{
  assert.equal(sceneAdapter({messages:[{role:'system',content:'你是剧情事实提取器，之后交给图像编辑指令编写器。'},{role:'user',content:'最新正文。'}]}),null);
});
test('only unambiguous transliterations of the actual cast are restored, without guessing unrelated identities',()=>{
  assert.equal(restoreCanonicalNames('Zhou He stands beside Xia He and LinLan.',['周禾','夏禾','林岚']),'周禾 stands beside 夏禾 and 林岚.');
  assert.equal(restoreCanonicalNames('LinLan is mentioned off-camera.',['夏禾']),'LinLan is mentioned off-camera.');
  assert.throws(()=>restoreCanonicalNames('Wu Ling stands there.',['吴灵','吴玲']),/拼音重名/);
});
test('the actual production fact and relation prompts do not select the final-output adapter',()=>{
  for(const prompt of [buildStoryFactsPrompt({latestStory:'当前人物站在门边。'}),buildRelationCheckerPrompt({latestStory:'当前人物站在门边。',sceneFacts:{}})]){
    assert.equal(sceneAdapter({messages:[{role:'system',content:prompt.system},{role:'user',content:prompt.userText}]}),null);
  }
});
