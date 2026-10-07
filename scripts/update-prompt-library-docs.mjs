import { writeFile } from 'node:fs/promises';
import { CHARACTER_DESIGN_PROFILES } from '../src/character-design-library.js';
import { SCENE_PROMPT_REFERENCES, VIEWPOINT_PROMPT_REFERENCES, PROMPT_TERM_REFERENCES } from '../src/scene-prompt-library.js';

const lines = [
    '# 角色与场景提示词参考库', '',
    '这份库按当前剧情和参考设计帮助AI选择写法，不按地点名或物种名自动套套餐。目标是还原剧情、角色身份、体型与正常结构，细节程度跟随参考画风。', '',
    '运行规则位于 `src/character-design-library.js` 与 `src/scene-prompt-library.js`，已由 `src/prompts.js` 接入实际三段分析。`index.js` 将现有候选角色资料传给关系和编辑阶段，候选资料不证明身体入镜或当前动作。完整场景目录只提供给编辑阶段，前两段仅收到各自职责提示，不增加第四次文字请求。', '',
    '维护时修改两个模块的数据，运行 `npm run docs:prompts` 更新本页，再运行 `npm test` 与 `npm run check`。本页由脚本生成，避免运行规则与文档维护成两份不同内容。角色库的详细判断示例见 [角色视觉判断库](character-design-library.md)。', '',
    '## 使用顺序', '',
    '1. 从最新正文锁定一个已发生瞬间，保留该时点的否定、数量与结果。',
    '2. 核对谁实际入镜、动作接触属于谁，以及每个人的当前身体形态。',
    '3. 结合明确角色设计判断特征，再判断本镜头可见范围；未知项省略。',
    '4. 只使用相关场景方法编写简洁英文变化指令，身份和画风交给实际参考图。',
    '5. 图片输出后单独检查结构和剧情一致性。接口成功、格式通过或规则已传入都不等于成图合格。', '',
    '这些参考不新增JSON字段、错误码或生图拦截，不增加人物和未说明的动作、道具或光源。明确镜头要求控制展示范围，角色扮演的尝试不覆盖正文实际结果。', '',
    `## 角色判断目录（${CHARACTER_DESIGN_PROFILES.length}类）`, '',
    '| id | 类别 | 编辑阶段参考 |', '| --- | --- | --- |',
    ...CHARACTER_DESIGN_PROFILES.map(item=>`| ${item.id} | ${item.label} | ${item.editor} |`), '',
    `## 场景写法目录（${SCENE_PROMPT_REFERENCES.length}类）`, '',
    '| id | 场景任务 | 适用条件 | 需要核对 |', '| --- | --- | --- | --- |',
    ...SCENE_PROMPT_REFERENCES.map(item=>`| ${item.id} | ${item.label} | ${item.when} | ${item.guidance} |`), '',
    '## 人物视角与可见结构', '',
    '观察方向、身体朝向、头部朝向、视线和画幅分别判断。只移动镜头不意味着人物转身或回头；后方观察保持背部、骨盆臀部与大腿的连续比例，侧面遵循近远缩短与遮挡。原参考的正脸不强迫每张图露脸，参考眼型规则也不强迫严格侧脸出现两只眼睛。', '',
    '| 视角任务 | 需要保留 |', '| --- | --- |',
    ...VIEWPOINT_PROMPT_REFERENCES.map(item=>`| ${item.label} | ${item.guidance} |`), '',
    '当前UI的剧情剧照／表情特写是景别偏好，没有新增方向按钮。视角通过针对本张图的自然语言要求指定，例如“只改变观察位置，画她的严格左侧面，保持动作和视线”或“从正后方看，不让角色回头”。这些要求进入关系与编辑阶段，不需要增加JSON字段。', '',
    '## 英文写法示例', '',
    '以下句子用于理解写法，不会整批加入模型输入。`[A]`、`[B]`是演示占位符；实际输出沿用入镜表的规范姓名。例子中的长凳、钥匙、鱼尾、镜子、灯和人物只在当前输入确有依据时使用，不能为了照搬例子制造这些内容。', '',
    ...SCENE_PROMPT_REFERENCES.flatMap(item=>[`### ${item.label}`, '', `适用：${item.when}。${item.guidance}`, '', `> ${item.example}`, '']),
    '## 易错词核对', '', '| 中文 | 英文参考 | 边界 |', '| --- | --- | --- |',
    ...PROMPT_TERM_REFERENCES.map(item=>`| ${item.source} | ${item.english} | ${item.caution} |`), '',
    '普通人类手为一拇指四手指，足为一大趾四小趾；总数不要求全部露出。非人身体按已确认结构处理。闭嘴不展示舌头，存在的耳尾翼不必为了证明存在而强行露出。绘画简化可以减少纹理，不能变成多肢体、指趾复制或错接关节。', '',
];
if (process.argv.includes('--stdout')) process.stdout.write(lines.join('\n'));
else {
    await writeFile(new URL('../docs/prompt-decision-library.md', import.meta.url),lines.join('\n'),'utf8');
    console.log(`Updated prompt library documentation: ${CHARACTER_DESIGN_PROFILES.length} character profiles, ${SCENE_PROMPT_REFERENCES.length} scene references.`);
}
