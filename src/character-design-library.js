/**
 * Semantic reference for the three analysis stages, not a character classifier
 * or a generation validator. Keep visual policy here; documentation links to
 * these definitions instead of maintaining a second prompt template.
 */
function freezeTree(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freezeTree(child);
        Object.freeze(value);
    }
    return value;
}

export const CHARACTER_DESIGN_STAGE_ROLES = freezeTree({
    fact: {
        label: '事实提取',
        instruction: '只提取所选瞬间已生效的动作、身体状态与明确变化，沿用现有动作/状态及证据字段；设计资料只辅助理解身体，不成为当前事件或原文证据。保持原JSON协议，不新增物种、traits、current_form等字段，不把身体变化硬塞进服装或道具更新。',
    },
    relation: {
        label: '关系核验',
        instruction: '核对所选瞬间的身体归属、肢体任务、接触及可见范围，按已确认当前形态判断动作是否相容；不重新设计外貌、不把本体身份当成新增演员或显露部位。沿用现有关系JSON协议。',
    },
    editor: {
        label: '编辑指令',
        instruction: '只描述当前动作、必要形态变化与容易被旧参考覆盖的明确保持项。未改变的身份外观交给参考图和统一模板；不要重述身份、物种档案或整套身份模板，不为套用本库增加指令长度。',
    },
});

export const CHARACTER_DESIGN_COMMON_RULES = freezeTree([
    {
        id: 'semantic_reference',
        fact: '本库供AI结合完整语义判断，不按物种词关键词自动分类，不要求输出分类标签。',
        relation: '结合完整剧情语义及已确认设计核验，不按物种词关键词自动分类；下列条目不是必须套用的外观套餐。',
        editor: '结合完整剧情语义及已确认设计判断相关条目，不按物种词关键词自动分类，也不把分类名称翻译成一整套外观套餐。',
    },
    {
        id: 'current_form_priority',
        fact: '当前已生效形态优先于旧身体状态；物种身份、本体与当前身体分别理解，不提前带入未来变形。',
        relation: '当前已生效形态优先于旧参考的身体拓扑；分别核对物种身份、本体、当前身体，尚未发生的变形不能解决当前动作冲突。',
        editor: '当前已生效形态优先于旧参考的身体拓扑；明确变形只改变其实际涉及的部位。当前形态未变时保留已确认设计，不因身份名或未来变形重新造身体。',
    },
    {
        id: 'grounded_design',
        fact: '具体设计、左右、部位与数量须有剧情或实际提供的参考依据；未见参考图不声称看见。',
        relation: '具体设计、左右、尾巴等部位与数量须有剧情或实际提供的参考依据；未提供参考图时只用输入明确说明的设计，不猜图中隐藏结构。',
        editor: '具体设计、左右、尾巴等部位与数量须有剧情或实际提供的参考依据；没有看到参考图时不猜其细节。只有明确变化才重述相关设计，不自动生成traits清单。',
    },
    {
        id: 'visible_scope',
        fact: '闭口、遮挡、裁切和仅局部入镜按当前事实保留；看不到不等于结构不存在。',
        relation: '区分结构存在与当前可见：闭口、遮挡、裁切、仅局部入镜限制展示范围，隐藏部位不能成为无主肢体，也不为证明数量补出身体。',
        editor: '保持当前闭口、遮挡、裁切和局部入镜；存在的结构不必全部露出。不要移开衣物、改姿势、伸出舌头或补出画外身体来展示设计，画面左右也不替代角色左右。',
    },
    {
        id: 'human_limbs_only',
        fact: '普通人类手脚规则仅用于已确认的人类形肢体，隐藏手指脚趾不补出。',
        relation: '普通人类手脚规则仅用于已确认的人类形肢体；有依据的爪、鳍、蹄、尾或额外肢体按其真实连接与任务核验，不强套两手两腿。',
        editor: '普通人类手脚规则仅用于已确认的人类形肢体：一拇指四手指；每足共五趾（一大趾四小趾），不复制或融合指趾。总数不等于本镜头必须全数可见，不展开隐藏手脚或手指；非人类爪、鳍、蹄、尾及额外肢体保留原设计。',
    },
    {
        id: 'reference_simplification',
        fact: '画风和简化程度不是剧情事实，不为补视觉细节创造身体变化。',
        relation: '判断正常连接、数量与动作归属，保留参考画风允许的简化；不要把简化笔触当作剧情中的器官缺失或新增。',
        editor: '还原当前剧情、体型与正常结构，细节程度交给参考图画风；不为了本库追求真人效果、写实纹理或极细解剖，也不把简化画法当作身体变化。',
    },
    {
        id: 'design_not_stereotype',
        fact: '角色性别与体型只用明确设定，不从衣服、发长、物种名或物种年岁推断。',
        relation: '角色性别、体型及身体设计各自依明确资料；衣服体积不等于身体体积，不按刻板印象重设比例。',
        editor: '正常身体结构与性别特征沿用明确角色设计，保持参考画风中的简化；不根据服装、发长或物种名另造性别、胸围、肌肉或体型。',
    },
    {
        id: 'unknown_not_gate',
        fact: '未说明的traits、unknown或null不补猜，不视为身体冲突，不新增生成阻断。',
        relation: '未说明的traits、unknown或null不补猜、不逐项登记为冲突，不新增生成阻断；只核验影响当前动作归属与接触的实质矛盾。',
        editor: '未说明的traits、unknown或null不补猜、不转成外观或排除标签，不新增生成阻断；省略未确认修饰，继续表达已知动作与必要变化。',
    },
]);

export const CHARACTER_DESIGN_PROFILES = freezeTree([
    {
        id: 'human', label: '人类',
        fact: '只提取已明确的身体动作、表情与变化，不由人类身份补写未提及的外观。',
        relation: '已确认的人类肢体自然连接，持物与接触任务相容；明确的缺失、假肢或特殊结构优先，遮挡不算缺失。',
        editor: '按已确认的人类身体自然表达动作；原设明确的缺失、假肢或特殊结构仍保留。普通结构规则不授权额外肢体，也不要求全身或全部指趾可见。',
    },
    {
        id: 'transformed_yokai', label: '化形妖怪',
        fact: '区分本体与当前人形；“化作人形”不自动删除已确认耳、尾、翼，仅提取已明确的形态变化。',
        relation: '本体结构不能自动移植到当前人形；化形后的已确认耳、尾、翼仍属同一身体，除非当前变化明确将其收起或消除。',
        editor: '依当前人形执行动作，不凭妖怪本体添加兽首、尾鳞或额外肢体；也不因human form一词删除已确认耳、尾、翼。只表达本轮明确改变或保留的相应部位。',
    },
    {
        id: 'animal_hybrid', label: '兽娘等混合形',
        fact: '猫、狗、狐狸等身份不等于兽耳兽尾套餐；只记录有依据的部位或变化。',
        relation: '猫、狗、狐狸等混合形的耳、尾、爪、足型及数量各自需要依据；不能由猫耳推断猫尾，也不能将已确认尾巴当成另一演员或腿。',
        editor: '已有参考或剧情确认的猫耳、犬尾、狐尾等设计按当前可见状态保留，不从物种名补兽首、爪、毛皮、尾巴或多尾。人类形手部与非人类部位分别处理。',
    },
    {
        id: 'serpent_humanoid', label: '蛇类人形',
        fact: '闭口时蛇舌不可见；竖瞳需原设或实际参考确认，不由蛇类身份推断蛇尾、鳞片。',
        relation: '蛇类身份不证明当前身体为蛇尾形；闭口时不能核验成伸舌动作。竖瞳需原设或实际参考确认，尾、鳞片也须独立依据。',
        editor: '当前人形闭口时不画蛇舌，闭口不等于设计中没有舌头；竖瞳仅在原设或实际参考明确时保留，不自行改虹膜或眼型，不自动添加蛇尾、鳞片或蛇首。',
    },
    {
        id: 'nonhuman_topology', label: '人外下半身与额外肢体',
        fact: '只提取已明确的当前蛇尾、人鱼尾、马身或额外肢体状态；未发生的化成人腿不算当前事实。',
        relation: '已确认当前蛇尾、人鱼尾、马身决定下半身拓扑，不强画人腿；尾、鳍、蹄与额外肢体的连接、数量、接触及归属按当前形态核验。',
        editor: '按已确认当前形态表达蛇尾盘绕、人鱼尾摆动、马身承重等实际任务，不为套人类站姿强画两条人腿。额外手臂、翼等仅保留有依据的连接与数量；变为人腿须本轮明确发生。',
    },
    {
        id: 'animal_form', label: '当前动物形态',
        fact: '本轮明确为动物本体时按实际形态提取动作，不因角色能说话或具有人格就当成人形。',
        relation: '四足、鸟类、鱼类等身体按当前已确认连接与任务核验，不把前足当人手或为鱼尾加脚；动物身份也不自动证明当前入镜。',
        editor: '依当前已确认动物形态描述趴卧、奔跑、飞行或游动，保留参考物种设计和数量，不自动成人形、兽娘或增加人类手脚。',
    },
    {
        id: 'artificial_body', label: '机械、仿生与人偶',
        fact: '人工身份不证明金属材质或裸露关节，只提取已明确身体状态与变化。',
        relation: '机械、仿生或人偶身体依当前结构核验接触与关节任务；有依据的机械构件不误作多余肢体，也不擅自增加零件。',
        editor: '依已确认设计保留人工身体的材质与结构；仿生人不自动显露机械骨架，人偶不自动带提线或关节缝，不为机械身份统一改成金属画风。',
    },
    {
        id: 'supernatural_identity', label: '亡魂、精灵等超自然身份',
        fact: '物种年岁与超自然身份不定义当前身体；虚影、透明或发光仅提取剧情明确的当前结果。',
        relation: '亡魂、精灵等身份及物种年岁不决定实体、虚影或身体结构；接触是否成立按当前已确认形态判断，不默认穿透物体或额外光源。',
        editor: '外观由已确认参考设计与当前形态决定，不由物种年岁改变面貌或身体。亡魂不默认虚影、透明、发光，精灵不默认尖耳或翅膀；只有剧情明确的本轮状态才表达相应效果。',
    },
]);

/** All profiles remain available for AI semantic reasoning; no trait detection. */
export function buildCharacterDesignGuidance(stage = 'editor') {
    const requested = stage === 'facts' ? 'fact' : stage;
    const selected = ['fact', 'relation', 'editor'].includes(requested) ? requested : 'editor';
    const role = CHARACTER_DESIGN_STAGE_ROLES[selected];
    return [
        `角色视觉判断参考（${role.label}）：${role.instruction}`,
        ...CHARACTER_DESIGN_COMMON_RULES.map(rule => rule[selected]),
        ...CHARACTER_DESIGN_PROFILES.map(profile => `${profile.label}：${profile[selected]}`),
    ].join('\n');
}
