// Change only the final response protocol. All original story and task rules
// remain available to the model; actor names are copied by code, never translated.
import {createRequire} from 'node:module';
const {pinyin}=createRequire(import.meta.url)('pinyin-pro');
export function restoreCanonicalNames(text,names){
  const readings=new Map();
  for(const name of names){
    if(!/^[\u3400-\u9fff]{2,}$/u.test(name))continue;
    const syllables=pinyin(name,{toneType:'none',type:'array',mode:'surname'});
    const key=syllables.join('').toLowerCase();
    const entry=readings.get(key)||{names:[],syllables};entry.names.push(name);readings.set(key,entry);
  }
  let result=text;
  for(const {names:matches,syllables} of readings.values()){
    const pattern=new RegExp('(?<![a-z])'+syllables.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[\\s_-]*')+'(?![a-z])','gi');
    if(matches.length>1){if(pattern.test(result))throw Error('角色拼音重名，不能自动猜测身份');continue;}
    result=result.replace(pattern,matches[0]);
  }
  return result;
}
export function sceneAdapter(input){
  const system=input.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
  if(!system.includes('你是插画流水线中的“图像编辑指令编写器”。'))return null;
  const user=input.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');
  const marker='【已核对的人物关系】';
  const start=user.indexOf(marker);
  if(start<0)throw Error('本地编辑阶段缺少已核对的演员表');
  const tail=user.slice(start+marker.length).trimStart();
  if(!tail.startsWith('{'))throw Error('本地编辑阶段的演员表格式无法读取');
  let depth=0,quoted=false,escaped=false,end=-1;
  for(let i=0;i<tail.length;i++){
    const ch=tail[i];
    if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
    if(ch==='"')quoted=true;
    else if(ch==='{')depth++;
    else if(ch==='}'&&--depth===0){end=i+1;break;}
  }
  if(end<0)throw Error('本地编辑阶段的演员表不完整');
  const cast=JSON.parse(tail.slice(0,end));
  const people=cast.visible_characters;
  if(!Array.isArray(people)||!people.length||people.some(p=>typeof p.canonical_name!=='string'||!p.canonical_name.trim()))throw Error('本地编辑阶段的入镜人物无效');
  const names=people.map(p=>p.canonical_name);
  if(new Set(names).size!==names.length)throw Error('本地编辑阶段的入镜人物重复');
  const story=user.match(/【完整最新剧情正文[^】]*】\s*\n([\s\S]*?)\n\n【(?:有原文依据的场景状态|剧情事实)】/)?.[1]||'';
  const instruction=user.match(/【上一条用户消息[^】]*】\s*\n([\s\S]*?)\n\n【完整最新剧情正文/)?.[1]||'';
  const exclusionEvidence=[...new Set((story+'\n'+instruction).split(/[。！？!?;；\n]/u).map(s=>s.trim()).filter(s=>s&&/(?:没有|并未|未曾|尚未|不要|不画|不补|不添加|不能|不得|不转|不回|只(?:画|显示|露|将)|没有再|not |no |only |without )/i.test(s)))];
  const actorSchema={type:'object',properties:{action:{type:'string'},appearance:{type:'string'},visibility:{type:'string'}},required:['action','appearance','visibility'],additionalProperties:false};
  const schema={type:'object',properties:{
    subjects:{type:'object',properties:Object.fromEntries(names.map(name=>[name,actorSchema])),required:names,additionalProperties:false},
    scene_instruction:{type:'string'},camera_view:{type:'string',enum:['unspecified','front','front_three_quarter','rear','rear_three_quarter','left_profile','right_profile','profile','overhead']},
    framing:{type:'string',enum:['default','full_body','face_shoulders','close_up','partial']},thought_bubble_instruction:{type:'string'},exclude:{type:'array',...(exclusionEvidence.length?{items:{type:'object',properties:{instruction:{type:'string'},evidence:{type:'string',enum:exclusionEvidence}},required:['instruction','evidence'],additionalProperties:false}}:{maxItems:0,items:{type:'object'}})},
  },required:['subjects','scene_instruction','camera_view','framing','thought_bubble_instruction','exclude'],additionalProperties:false};
  const protocol=`【本地编辑阶段的结构化输出协议：仅替代上文的JSON字段格式，所有剧情和镜头规则继续有效】
只返回 subjects、scene_instruction、camera_view、framing、thought_bubble_instruction、exclude 六个字段。
subjects 的键严格为 ${JSON.stringify(names)}，每个人分别填写 action、appearance、visibility 三个英文字符串。action 只写该人自己的简短动作，从动词开始。appearance 单独写该人当前已明确的衣装、裸露状态或当前形态，例如 wearing the stated outfit，不能漏掉正文和已核验持续状态的衣装；未知时才为空。visibility 写该人已限定的可见范围和必要身体/头向，没有限定则为空。程序将逐字添加对应的中文规范姓名，不另译姓名。不要把另一个人的肢体或持物放入本人的字段，不再用另一段 preserve 重述人物道具。
每人分别保留其左右手、持物数量、物品当前位置、可见范围、头与身体方向和明确否定。明确未持物不能写持物。指向不等于接触或拿起。已确认镜面时在同一人物的动作中写本体和本人倒影的对应手臂、手掌接触及头向，不能只写同步倒影。
scene_instruction 只写有依据的环境和不被人物持有的场景物品，不能重复或转移人物手里的物品；没有就为空。camera_view 只选择本张明确要求的观察方向：unspecified、front、front_three_quarter、rear、rear_three_quarter、left_profile、right_profile、profile、overhead。正后方使用 rear，不改变头或躯干方向。framing 只选择本张明确要求的裁切：default、full_body、face_shoulders、close_up、partial；没有直接裁切要求时选择 default，不把方向当裁切，不因另一参与者只露手而裁掉主角。
镜头及裁切由程序转换成固定英文，不在其他字段写 head/feet beyond the frame 等裁切措辞。thought_bubble_instruction 继续遵守上文的有证据心理反应规则，无符合依据的反应时为空。
exclude 是对象数组，每项只有 instruction 和 evidence；instruction 是明确禁项的英文翻译，evidence 逐字复制支持该禁项的原文否定片段，不能从正面持有或服装事实推导禁止。可用原文否定片段仅有 ${JSON.stringify(exclusionEvidence)}；没有则填 []。排除项不得删除正面事实中的衣装、持物数量、动作或已确认镜面，不能编造“第二把钥匙不得出现”等没有原文依据的禁项。`;
  return {names,schema,protocol,exclusionEvidence,portrait:system.includes('本次用户选择面部表情特写')};
}
export function normalizeSceneOutput(content,adapter){
  if(!adapter)return content;
  const value=JSON.parse(content);
  const actors=value.subjects;
  if(!actors||typeof actors!=='object'||Object.keys(actors).length!==adapter.names.length||Object.keys(actors).some(n=>!adapter.names.includes(n))||adapter.names.some(n=>!actors[n]||typeof actors[n].action!=='string'||!actors[n].action.trim()||typeof actors[n].appearance!=='string'||typeof actors[n].visibility!=='string'))throw Error('本地编辑稿的姓名与动作映射不完整');
  for(const field of ['scene_instruction','thought_bubble_instruction'])if(typeof value[field]!=='string')throw Error('本地编辑稿字段类型不完整');
  if(!Array.isArray(value.exclude)||value.exclude.some(x=>!x||typeof x.instruction!=='string'||!x.instruction.trim()||typeof x.evidence!=='string'||!adapter.exclusionEvidence.includes(x.evidence)))throw Error('本地编辑稿排除项缺少原文否定依据');
  const sentences=adapter.names.map(n=>`${n} ${['action','appearance','visibility'].map(k=>actors[n][k].trim().replace(/[.\s]+$/,'')).filter(Boolean).join('; ')}.`);
  if(value.scene_instruction.trim())sentences.push(value.scene_instruction.trim());
  const views={unspecified:'',front:'View the scene from the front.',front_three_quarter:'Use a front three-quarter view.',rear:'View from directly behind, preserving the established head and body directions.',rear_three_quarter:'Use a rear three-quarter view, preserving the established head and body directions.',left_profile:'View the left profile without changing the established pose.',right_profile:'View the right profile without changing the established pose.',profile:'Use a side profile without changing the established pose.',overhead:'Use the requested overhead view without changing the pose.'};
  if(!Object.hasOwn(views,value.camera_view))throw Error('本地编辑稿观察方向无效');
  if(views[value.camera_view])sentences.push(views[value.camera_view]);
  const frames={full_body:'Use head-to-toe framing for the main figures whose visible scope is unrestricted. Fit their entire physical silhouettes inside the image, with clear background above the highest hair or ornament and floor below the feet. Keep any explicitly partial participant limited to that visible part.',face_shoulders:'Use face-and-shoulders framing for the main subject, preserving necessary story interactions and explicit partial visibility.',close_up:'Use the expressly requested close-up without changing the established pose or revealing hidden body parts.',partial:'Honor the expressly requested partial crop and each participant\'s verified visible scope.'};
  const framing=value.framing==='default'?(adapter.portrait?'face_shoulders':'full_body'):value.framing;
  if(!Object.hasOwn(frames,framing))throw Error('本地编辑稿裁切类型无效');
  sentences.push(frames[framing]);
  return JSON.stringify({edit_instruction:restoreCanonicalNames(sentences.join(' '),adapter.names),preserve:'',exclude:value.exclude.map(x=>restoreCanonicalNames(x.instruction,adapter.names)),thought_bubble_instruction:restoreCanonicalNames(value.thought_bubble_instruction,adapter.names)});
}
