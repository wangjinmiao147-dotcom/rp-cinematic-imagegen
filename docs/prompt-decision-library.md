# 角色与场景提示词参考库

这份库按当前剧情和参考设计帮助AI选择写法，不按地点名或物种名自动套套餐。目标是还原剧情、角色身份、体型与正常结构，细节程度跟随参考画风。

运行规则位于 `src/character-design-library.js` 与 `src/scene-prompt-library.js`，已由 `src/prompts.js` 接入实际三段分析。`index.js` 将现有候选角色资料传给关系和编辑阶段，候选资料不证明身体入镜或当前动作。完整场景目录只提供给编辑阶段，前两段仅收到各自职责提示，不增加第四次文字请求。

维护时修改两个模块的数据，运行 `npm run docs:prompts` 更新本页，再运行 `npm test` 与 `npm run check`。本页由脚本生成，避免运行规则与文档维护成两份不同内容。角色库的详细判断示例见 [角色视觉判断库](character-design-library.md)。

## 使用顺序

1. 从最新正文锁定一个已发生瞬间，保留该时点的否定、数量与结果。
2. 核对谁实际入镜、动作接触属于谁，以及每个人的当前身体形态。
3. 结合明确角色设计判断特征，再判断本镜头可见范围；未知项省略。
4. 只使用相关场景方法编写简洁英文变化指令，身份和画风交给实际参考图。
5. 图片输出后单独检查结构和剧情一致性。接口成功、格式通过或规则已传入都不等于成图合格。

这些参考不新增JSON字段、错误码或生图拦截，不增加人物和未说明的动作、道具或光源。明确镜头要求控制展示范围，角色扮演的尝试不覆盖正文实际结果。

## 角色判断目录（8类）

| id | 类别 | 编辑阶段参考 |
| --- | --- | --- |
| human | 人类 | 按已确认的人类身体自然表达动作；原设明确的缺失、假肢或特殊结构仍保留。普通结构规则不授权额外肢体，也不要求全身或全部指趾可见。 |
| transformed_yokai | 化形妖怪 | 依当前人形执行动作，不凭妖怪本体添加兽首、尾鳞或额外肢体；也不因human form一词删除已确认耳、尾、翼。只表达本轮明确改变或保留的相应部位。 |
| animal_hybrid | 兽娘等混合形 | 已有参考或剧情确认的猫耳、犬尾、狐尾等设计按当前可见状态保留，不从物种名补兽首、爪、毛皮、尾巴或多尾。人类形手部与非人类部位分别处理。 |
| serpent_humanoid | 蛇类人形 | 当前人形闭口时不画蛇舌，闭口不等于设计中没有舌头；竖瞳仅在原设或实际参考明确时保留，不自行改虹膜或眼型，不自动添加蛇尾、鳞片或蛇首。 |
| nonhuman_topology | 人外下半身与额外肢体 | 按已确认当前形态表达蛇尾盘绕、人鱼尾摆动、马身承重等实际任务，不为套人类站姿强画两条人腿。额外手臂、翼等仅保留有依据的连接与数量；变为人腿须本轮明确发生。 |
| animal_form | 当前动物形态 | 依当前已确认动物形态描述趴卧、奔跑、飞行或游动，保留参考物种设计和数量，不自动成人形、兽娘或增加人类手脚。 |
| artificial_body | 机械、仿生与人偶 | 依已确认设计保留人工身体的材质与结构；仿生人不自动显露机械骨架，人偶不自动带提线或关节缝，不为机械身份统一改成金属画风。 |
| supernatural_identity | 亡魂、精灵等超自然身份 | 外观由已确认参考设计与当前形态决定，不由物种年岁改变面貌或身体。亡魂不默认虚影、透明、发光，精灵不默认尖耳或翅膀；只有剧情明确的本轮状态才表达相应效果。 |

## 场景写法目录（49类）

| id | 场景任务 | 适用条件 | 需要核对 |
| --- | --- | --- | --- |
| single_moment | 连续事件与精彩瞬间 | 正文包含先后动作或换场 | 锁定一个已发生时点；随后收起、离开、换装的结果不能提前混入。 |
| single_actor | 单人与画外对象 | 独处、对画外人说话或被注视 | 锁定入镜名单；对话对象、旁观者和被提及的人不自动出现。 |
| ensemble | 多人同场 | 两人或更多人明确入镜 | 每人一个身体，沿用各自身份；相对位置与接触写清，不把参考图数量当人数。 |
| partial_body | 局部入镜与遮挡 | 仅手、仅腿、背影或被物体遮挡 | 只画已指定范围；结构存在不要求全数可见，不补头部或移走遮挡来展示身体。 |
| seated_reclining | 坐姿与卧姿 | 坐凳、坐地、倚靠或躺卧 | 保持躯干骨盆方向、已明确支撑面与承重点；坐着不自动造椅子，腿脚自然连接，不为露手露脚改姿态。 |
| locomotion | 行走与转身 | 迈步、奔跑、回头或转身 | 只保留选帧时步态与朝向；离开不等于回头，运动方向不自动决定视线。 |
| hand_task | 持物与手部任务 | 持杯、开门、书写或敲门 | 一只手的任务与接触相容；未指定手数或左右就不补猜，不同时保留已解除的双手姿势。 |
| physical_contact | 人物接触 | 握手、扶持、拥抱或并肩接触 | 明确身体归属及双方接触部位；未说明左右不指定，靠近或尝试不写成已接触。 |
| handoff_refusal | 递物、拒收与数量 | 物品交接、拒绝、收起或留桌 | 按真实结果表达数量、归属与位置；角色扮演中的递出尝试不覆盖随后拒绝或只收一件。 |
| wardrobe_state | 换装与当前衣着 | 换衣、脱穿、赤脚或摘掉饰物 | 当前已核验状态优先于旧参考衣装；保留准确款式颜色与范围，未知不猜。 |
| bathing_wetness | 洗浴与湿润状态 | 洗浴、淋雨或明确湿衣湿发 | 地点本身不证明裸露；按已确认衣着和湿润范围还原，不凭湿润增加透明、贴身程度或新遮盖。 |
| time_light | 昼夜与默认照明 | 明确时间或照明未指定 | 夜晚不等于全暗或月光；未指定照明由统一模板保持可读，不补光源或戏剧性阴影。 |
| physical_lights | 物理光源与局部阴影 | 灯、火、窗光或明确黑暗 | 只用原文光源和适用范围；局部阴影不扩成整房欠曝，明确无光仍如实保留。 |
| weather | 雨雪风与天气变化 | 天气、风吹或天气停止 | 区分室内外与天气范围；下雨不证明室内湿透，雨停不抹掉仍有效水滴湿衣，不额外加雾或粒子。 |
| current_transformation | 已发生的身体变形 | 化形或当前身体结构改变 | 当前形态优先，未发生的变化不提前画；人形不自动加本体特征，也不删已确认耳尾翼。 |
| nonhuman_action | 尾翼鳍蹄与额外肢体 | 当前非人形态执行动作 | 按当前结构表达盘绕、飞行、游动或承重，不强套人腿人足；每个部位归属同一主体。 |
| inner_reaction | 心理思考泡 | 内心活动有明确情绪依据 | 只给有依据的内心情绪配同角色无字Q版表情；信息性判断不补情绪，主脸不被覆盖。 |
| reflection | 镜面与倒影 | 当前输入明确镜子、反射面或倒影 | 浴室等地点不证明存在镜子或倒影。倒影属于同一时点、同一人物，姿态、持物与服装保持一致，按镜面范围和观察位置投影；镜中手仍对应同一人的同一解剖侧，不交换持物手或动作归属，不机械水平翻转整图。关键动作同时写清实体与镜中对应的肩肘腕掌，抬臂不能配垂臂；贴镜掌在同一接触点相遇，另一只手也保持原任务与遮挡。不要求展示落在镜面范围外、被镜框挡住或不在反射视野中的部位，也不借倒影加回已排除人物。默认完整构图先容纳镜外实体最高头饰与脚下留白，不能仅把倒影画完整。 |
| glass_surface | 玻璃材质与镜面分开 | 玻璃门、淋浴隔断、窗玻璃或磨砂玻璃 | 玻璃不自动等于镜子，浴室不自动新增人物倒影。保持原文确认的磨砂、透明度、凝露与表面高光；没有明确反射人物时，不复制人物脸、身体、手或人形轮廓到玻璃上。原文明写玻璃后有演员时，按实际名单和位置呈现，不把演员误删。真正镜中人物的五官按镜中观察方向投影，仍使用同一身份与当前姿态，不把正面头像贴进镜子。 |
| environment_change | 环境变化的生效时点 | 开门、关灯、烟散或水位改变 | 只保留选帧时结果；开门不等于已穿门，旧阴影和后续灯光不与当前动作无条件叠加。 |
| depicted_media | 照片、屏幕与画中人 | 出现载体或明确画中内容 | 载体存在不证明显示什么；明确人像属于载体，不成为实体演员，也不添加已排除人物。 |
| spatial_boundary | 空间边界与角色方向 | 门内外、前后、高低或视线受阻 | 保留已明确空间关系；角色左右、画面左右和观察方向分开，不为了露脸改朝向。 |
| magic_effect | 魔法与超自然效果 | 明确施法、发光、透明或幻象 | 只表达当前已生效效果、主体与范围；身份名不证明透明或自发光，幻象不自动是真实演员。 |
| dream_memory | 梦境、回忆与想象 | 叙事明确进入另一层场景 | 只画当前锁定叙事层，不能与现实、未来选项和附加小剧场拼在一起。 |
| reference_scope | 头肩像与多图参考 | 主图局部、辅助视图或上一张图 | 主图管身份与画风；头肩图不证明隐藏身体，辅助图不加演员，上一张只延续有效衣装道具。 |
| height_perspective | 体型、身高与透视 | 体型明确或多人高低差 | 保持已确认比例和空间透视；衣服体积不等于身体体积，不用畸形拉伸来显高。 |
| mount_vehicle | 骑乘与载具 | 骑乘、车内或驾驶动作 | 区分人物、坐骑、载具及接触任务；手脚连接各自主体，不把座椅车门当身体部位。 |
| gaze_expression | 视线与部位精确翻译 | 表情、瞳孔或注视变化 | 瞳孔、虹膜、眼型分开；说话不等于注视，闭嘴不伸舌，不为表现心理新增主脸表情。 |
| spoken_conversation | 普通对话与沉默 | 说话、倾听、停顿或沉默 | 台词不自动产生手势、视线或心理气泡；只画有依据的表情口部状态，不加字幕和对白框。 |
| combat_action | 战斗与武器动作 | 明确格挡、挥击、瞄准或闪避 | 只画一个动作阶段；武器属于明确持有人，手臂接触相容，不追加连招、伤口或攻击结果。 |
| injury_damage | 伤势与破损状态 | 明确受伤、包扎或衣物破损 | 只保留当前已生效部位与程度；衣服破损不证明受伤，旧伤不自动加血迹或严重程度。 |
| daily_operation | 进食、书写与日常操作 | 操作具体物品的进行阶段 | 保持物件、持有人、操作阶段和接触点；举杯不等于饮用，翻页不等于书写，未注明不加字。 |
| terrain_airborne | 攀爬、跳跃与承重变化 | 斜坡、台阶、攀爬或短暂腾空 | 脚手按当前地形接触或离地；跳跃不补翅膀，攀爬不新增把手，腾空不同时画成站地。 |
| scale_relationship | 体量差与缩放 | 明确巨型、微型或双方大小差 | 保留已确认大小与空间比例；体量变化不等于年龄变化，不拉长局部肢体代替整体尺度。 |
| foreground_occlusion | 前景遮挡与透明隔面 | 栏杆、玻璃、门框或前景物遮挡 | 先确认隔面与遮挡确实存在，再按原位置遮住对应部位；不把反射、透明或遮挡误作缺肢。 |
| garment_fit | 衣服体积与身体比例 | 宽松衣服、衣褶或多层衣装 | 保留当前服装款式与覆盖范围；宽松体积不扩成身体体积，不添装饰、透视衣物或换材质。 |
| framing_request | 明确视角与画幅 | 剧情画面或用户直接指定全身、侧背面、特写与局部范围 | 剧情画面默认采用完整容纳主体头到脚与当前动作的构图，避免无依据截断头顶、工作手或脚部；明确特写、仅手等可见范围和既定自然遮挡优先，不为凑全身补出受限身体或移走遮挡。参考头像、头肩图的裁切不决定输出裁切；镜头指示控制视角范围，角色台词不算镜头要求，不为露脸强改背面或全身要求。 |
| front_view | 正面观察 | 明确从人物正面观察 | 正面是观察方向，不自动看镜头、抬头或摊开手脚；五官与身体仍按原姿势和遮挡呈现。 |
| rear_view | 背面观察 | 明确从人物背后观察 | 保持背部、骨盆臀部与大腿连接的背面轮廓；正后方且头部背对时只显示后脑与实际可见后侧，不改成后三分之四。无回头事实不扭头，不补正面五官或借镜子露脸。 |
| strict_profile | 严格侧面观察 | 明确严格侧面或人物某一侧 | 指定哪侧就保持哪侧；侧脸不强露远侧眼，远侧肢体自然遮挡，不改成正面或三分之四。 |
| front_three_quarter | 前方斜侧面 | 明确前方三分之四观察 | 区分近侧与远侧的自然缩短，不把肩胯五官拉成正面镜像；相机角度不改变人物动作。 |
| rear_three_quarter | 后方斜侧面 | 明确后方三分之四观察 | 保留后方观察基底和侧面缩短；只能出现头部原朝向实际可见的脸部，不自动回眸。 |
| high_angle | 俯视观察 | 明确镜头高于主体向下看 | 俯视由相机高度决定，不自动让人物低头、蹲下或抬眼看镜头；身体比例按透视自然缩短。 |
| low_angle | 仰视观察 | 明确镜头低于主体向上看 | 仰视不自动让人物仰头、张腿或改变衣着覆盖；保持实际姿态和近远缩短，不夸张放大局部。 |
| overhead_view | 垂直顶视 | 明确从主体正上方观察 | 顶视不等同于一般俯视；按地面接触和垂直投影显示，不补被头发身体遮住的五官或肢体。 |
| over_shoulder | 过肩观察 | 明确已有入镜人物的过肩构图 | 肩膀归属须在入镜名单且有范围依据；画外观众不能为过肩机位新增身体或变成额外演员。 |
| camera_pose_separation | 机位与人物朝向分开 | 镜头移动但剧情姿态未变化 | 观察方向、身体朝向、头部朝向和视线分别处理；镜头绕后不证明人物转身，侧面机位不改左右手任务。 |
| foreshortened_limbs | 肢体近远缩短 | 四肢朝向观察者或重叠明显 | 缩短属于投影而非缺肢；保持关节连续和各自归属，不复制手脚，不强迫每个指趾都露出。 |
| negative_scope | 否定与排除范围 | 未回头、无字或某元素明确不出现 | 排除项限定对应主体部位；保留必需物品，不把禁止第二把钥匙写成禁止所有钥匙。 |

## 人物视角与可见结构

观察方向、身体朝向、头部朝向、视线和画幅分别判断。只移动镜头不意味着人物转身或回头；后方观察保持背部、骨盆臀部与大腿的连续比例，侧面遵循近远缩短与遮挡。原参考的正脸不强迫每张图露脸，参考眼型规则也不强迫严格侧脸出现两只眼睛。

| 视角任务 | 需要保留 |
| --- | --- |
| 正面观察 | 正面是观察方向，不自动看镜头、抬头或摊开手脚；五官与身体仍按原姿势和遮挡呈现。 |
| 背面观察 | 保持背部、骨盆臀部与大腿连接的背面轮廓；正后方且头部背对时只显示后脑与实际可见后侧，不改成后三分之四。无回头事实不扭头，不补正面五官或借镜子露脸。 |
| 严格侧面观察 | 指定哪侧就保持哪侧；侧脸不强露远侧眼，远侧肢体自然遮挡，不改成正面或三分之四。 |
| 前方斜侧面 | 区分近侧与远侧的自然缩短，不把肩胯五官拉成正面镜像；相机角度不改变人物动作。 |
| 后方斜侧面 | 保留后方观察基底和侧面缩短；只能出现头部原朝向实际可见的脸部，不自动回眸。 |
| 俯视观察 | 俯视由相机高度决定，不自动让人物低头、蹲下或抬眼看镜头；身体比例按透视自然缩短。 |
| 仰视观察 | 仰视不自动让人物仰头、张腿或改变衣着覆盖；保持实际姿态和近远缩短，不夸张放大局部。 |
| 垂直顶视 | 顶视不等同于一般俯视；按地面接触和垂直投影显示，不补被头发身体遮住的五官或肢体。 |
| 过肩观察 | 肩膀归属须在入镜名单且有范围依据；画外观众不能为过肩机位新增身体或变成额外演员。 |
| 机位与人物朝向分开 | 观察方向、身体朝向、头部朝向和视线分别处理；镜头绕后不证明人物转身，侧面机位不改左右手任务。 |
| 肢体近远缩短 | 缩短属于投影而非缺肢；保持关节连续和各自归属，不复制手脚，不强迫每个指趾都露出。 |

当前UI的剧情剧照／表情特写是景别偏好，没有新增方向按钮。视角通过针对本张图的自然语言要求指定，例如“只改变观察位置，画她的严格左侧面，保持动作和视线”或“从正后方看，不让角色回头”。这些要求进入关系与编辑阶段，不需要增加JSON字段。

## 英文写法示例

以下句子用于理解写法，不会整批加入模型输入。`[A]`、`[B]`是演示占位符；实际输出沿用入镜表的规范姓名。例子中的长凳、钥匙、鱼尾、镜子、灯和人物只在当前输入确有依据时使用，不能为了照搬例子制造这些内容。

### 连续事件与精彩瞬间

适用：正文包含先后动作或换场。锁定一个已发生时点；随后收起、离开、换装的结果不能提前混入。

> Show [A] at the instant she accepts the single key; it has not yet been put away.

### 单人与画外对象

适用：独处、对画外人说话或被注视。锁定入镜名单；对话对象、旁观者和被提及的人不自动出现。

> Show only [A], looking toward the off-camera listener without adding the listener to the frame.

### 多人同场

适用：两人或更多人明确入镜。每人一个身体，沿用各自身份；相对位置与接触写清，不把参考图数量当人数。

> Show [A] beside [B] at the same table, each with one body and their own reference identity.

### 局部入镜与遮挡

适用：仅手、仅腿、背影或被物体遮挡。只画已指定范围；结构存在不要求全数可见，不补头部或移走遮挡来展示身体。

> Only [B]’s hand enters from the doorway, holding the cup; [B]’s face and torso remain outside the frame.

### 坐姿与卧姿

适用：坐凳、坐地、倚靠或躺卧。保持躯干骨盆方向、已明确支撑面与承重点；坐着不自动造椅子，腿脚自然连接，不为露手露脚改姿态。

> Show [A] seated upright on the bench, with both feet resting on the floor and her hand supporting her on the seat.

### 行走与转身

适用：迈步、奔跑、回头或转身。只保留选帧时步态与朝向；离开不等于回头，运动方向不自动决定视线。

> Show [A] stepping through the doorway with her body turned away, without looking back.

### 持物与手部任务

适用：持杯、开门、书写或敲门。一只手的任务与接触相容；未指定手数或左右就不补猜，不同时保留已解除的双手姿势。

> Show [A] holding the folded paper and looking at it; do not assign an unspecified hand or gaze direction.

### 人物接触

适用：握手、扶持、拥抱或并肩接触。明确身体归属及双方接触部位；未说明左右不指定，靠近或尝试不写成已接触。

> Show [A]’s hand resting on [B]’s shoulder while [B] maintains the stated seated posture.

### 递物、拒收与数量

适用：物品交接、拒绝、收起或留桌。按真实结果表达数量、归属与位置；角色扮演中的递出尝试不覆盖随后拒绝或只收一件。

> Show [A] holding the one accepted key while the other key remains on the table.

### 换装与当前衣着

适用：换衣、脱穿、赤脚或摘掉饰物。当前已核验状态优先于旧参考衣装；保留准确款式颜色与范围，未知不猜。

> Show [A] wearing the newly changed burgundy robe, barefoot, with the former hair ornament removed.

### 洗浴与湿润状态

适用：洗浴、淋雨或明确湿衣湿发。地点本身不证明裸露；按已确认衣着和湿润范围还原，不凭湿润增加透明、贴身程度或新遮盖。

> Show [A] with the explicitly wet hair and sleeves, retaining her confirmed current clothing state.

### 昼夜与默认照明

适用：明确时间或照明未指定。夜晚不等于全暗或月光；未指定照明由统一模板保持可读，不补光源或戏剧性阴影。

> Show [A] beside the window at night, without inventing moonlight or an unmentioned lamp.

### 物理光源与局部阴影

适用：灯、火、窗光或明确黑暗。只用原文光源和适用范围；局部阴影不扩成整房欠曝，明确无光仍如实保留。

> Show [A] beside the stated lit desk lamp; keep the shelf’s shadow confined to the shelf area.

### 雨雪风与天气变化

适用：天气、风吹或天气停止。区分室内外与天气范围；下雨不证明室内湿透，雨停不抹掉仍有效水滴湿衣，不额外加雾或粒子。

> Show [A] outside in the stated rain, with her coat hem moving in the described wind.

### 已发生的身体变形

适用：化形或当前身体结构改变。当前形态优先，未发生的变化不提前画；人形不自动加本体特征，也不删已确认耳尾翼。

> Show [A] in her completed human form, retaining only the explicitly confirmed animal features.

### 尾翼鳍蹄与额外肢体

适用：当前非人形态执行动作。按当前结构表达盘绕、飞行、游动或承重，不强套人腿人足；每个部位归属同一主体。

> Show [A] with her confirmed fish tail moving beneath the water, without adding human legs.

### 心理思考泡

适用：内心活动有明确情绪依据。只给有依据的内心情绪配同角色无字Q版表情；信息性判断不补情绪，主脸不被覆盖。

> Add a small text-free thought bubble containing [A]’s recognizable chibi expression of the stated inner worry; keep her main expression unchanged.

### 镜面与倒影

适用：当前输入明确镜子、反射面或倒影。浴室等地点不证明存在镜子或倒影。倒影属于同一时点、同一人物，姿态、持物与服装保持一致，按镜面范围和观察位置投影；镜中手仍对应同一人的同一解剖侧，不交换持物手或动作归属，不机械水平翻转整图。关键动作同时写清实体与镜中对应的肩肘腕掌，抬臂不能配垂臂；贴镜掌在同一接触点相遇，另一只手也保持原任务与遮挡。不要求展示落在镜面范围外、被镜框挡住或不在反射视野中的部位，也不借倒影加回已排除人物。默认完整构图先容纳镜外实体最高头饰与脚下留白，不能仅把倒影画完整。

> Project [A]’s current pose and clothing within the mirror’s bounds. Both views keep each anatomical arm’s stated bend and task; a touching palm and its reflection meet at one contact point, with each wrist connected to its own body. Preserve occlusion and the requested physical crop.

### 玻璃材质与镜面分开

适用：玻璃门、淋浴隔断、窗玻璃或磨砂玻璃。玻璃不自动等于镜子，浴室不自动新增人物倒影。保持原文确认的磨砂、透明度、凝露与表面高光；没有明确反射人物时，不复制人物脸、身体、手或人形轮廓到玻璃上。原文明写玻璃后有演员时，按实际名单和位置呈现，不把演员误删。真正镜中人物的五官按镜中观察方向投影，仍使用同一身份与当前姿态，不把正面头像贴进镜子。

> Keep the frosted-glass door’s diffuse texture and surface highlights, with no unrequested human image on the pane.

### 环境变化的生效时点

适用：开门、关灯、烟散或水位改变。只保留选帧时结果；开门不等于已穿门，旧阴影和后续灯光不与当前动作无条件叠加。

> Show the door already open at this moment while [A] remains beside it, not yet through the doorway.

### 照片、屏幕与画中人

适用：出现载体或明确画中内容。载体存在不证明显示什么；明确人像属于载体，不成为实体演员，也不添加已排除人物。

> Show the explicitly described portrait within its frame, without turning its subject into another physical person in the room.

### 空间边界与角色方向

适用：门内外、前后、高低或视线受阻。保留已明确空间关系；角色左右、画面左右和观察方向分开，不为了露脸改朝向。

> Show [A] inside the doorway and [B] outside it, retaining their stated body directions.

### 魔法与超自然效果

适用：明确施法、发光、透明或幻象。只表达当前已生效效果、主体与范围；身份名不证明透明或自发光，幻象不自动是真实演员。

> Show the explicitly described glow around [A]’s raised hand, without extending it to the entire room.

### 梦境、回忆与想象

适用：叙事明确进入另一层场景。只画当前锁定叙事层，不能与现实、未来选项和附加小剧场拼在一起。

> Show the selected memory scene alone, without including the present-day room in the same composition.

### 头肩像与多图参考

适用：主图局部、辅助视图或上一张图。主图管身份与画风；头肩图不证明隐藏身体，辅助图不加演员，上一张只延续有效衣装道具。

> Use [A]’s primary reference for identity and drawing style, with the compatible supporting view supplying only the current coat design.

### 体型、身高与透视

适用：体型明确或多人高低差。保持已确认比例和空间透视；衣服体积不等于身体体积，不用畸形拉伸来显高。

> Retain [A]’s confirmed tall, slender build while keeping her seated proportions natural in this view.

### 骑乘与载具

适用：骑乘、车内或驾驶动作。区分人物、坐骑、载具及接触任务；手脚连接各自主体，不把座椅车门当身体部位。

> Show [A] seated in the vehicle with her stated hand on the steering wheel, attached to her own arm.

### 视线与部位精确翻译

适用：表情、瞳孔或注视变化。瞳孔、虹膜、眼型分开；说话不等于注视，闭嘴不伸舌，不为表现心理新增主脸表情。

> Show [A] looking at the letter with her lips closed, retaining her established eye shape.

### 普通对话与沉默

适用：说话、倾听、停顿或沉默。台词不自动产生手势、视线或心理气泡；只画有依据的表情口部状态，不加字幕和对白框。

> Show [A] listening with the stated neutral expression, keeping her established posture without adding a gesture or dialogue text.

### 战斗与武器动作

适用：明确格挡、挥击、瞄准或闪避。只画一个动作阶段；武器属于明确持有人，手臂接触相容，不追加连招、伤口或攻击结果。

> Show [A] at the instant of blocking with the shield, retaining the stated hand contact without adding the later counterattack.

### 伤势与破损状态

适用：明确受伤、包扎或衣物破损。只保留当前已生效部位与程度；衣服破损不证明受伤，旧伤不自动加血迹或严重程度。

> Show the stated bandage on [A]’s left forearm and the current torn sleeve, without adding another wound.

### 进食、书写与日常操作

适用：操作具体物品的进行阶段。保持物件、持有人、操作阶段和接触点；举杯不等于饮用，翻页不等于书写，未注明不加字。

> Show [A] turning the stated page with her hand while the pen remains on the table.

### 攀爬、跳跃与承重变化

适用：斜坡、台阶、攀爬或短暂腾空。脚手按当前地形接触或离地；跳跃不补翅膀，攀爬不新增把手，腾空不同时画成站地。

> Show [A] midway through the stated jump with both feet off the ground, without adding wings or a second pose.

### 体量差与缩放

适用：明确巨型、微型或双方大小差。保留已确认大小与空间比例；体量变化不等于年龄变化，不拉长局部肢体代替整体尺度。

> Show the explicitly miniature [A] standing beside the cup, retaining her reference body proportions at the stated scale.

### 前景遮挡与透明隔面

适用：栏杆、玻璃、门框或前景物遮挡。先确认隔面与遮挡确实存在，再按原位置遮住对应部位；不把反射、透明或遮挡误作缺肢。

> Show [A] behind the stated railing, keeping the obscured lower legs hidden rather than shortening them.

### 衣服体积与身体比例

适用：宽松衣服、衣褶或多层衣装。保留当前服装款式与覆盖范围；宽松体积不扩成身体体积，不添装饰、透视衣物或换材质。

> Retain the stated loose robe and its existing folds while keeping [A]’s confirmed slender body proportions.

### 明确视角与画幅

适用：剧情画面或用户直接指定全身、侧背面、特写与局部范围。剧情画面默认采用完整容纳主体头到脚与当前动作的构图，避免无依据截断头顶、工作手或脚部；明确特写、仅手等可见范围和既定自然遮挡优先，不为凑全身补出受限身体或移走遮挡。参考头像、头肩图的裁切不决定输出裁切；镜头指示控制视角范围，角色台词不算镜头要求，不为露脸强改背面或全身要求。

> Frame [A]’s complete figure and current action from head to toe by default; honor an explicit close-up or partial-body scope and retain natural occlusion, independently of the reference portrait’s crop.

### 正面观察

适用：明确从人物正面观察。正面是观察方向，不自动看镜头、抬头或摊开手脚；五官与身体仍按原姿势和遮挡呈现。

> Show [A] from the front, preserving her stated head angle, gaze and current pose.

### 背面观察

适用：明确从人物背后观察。保持背部、骨盆臀部与大腿连接的背面轮廓；正后方且头部背对时只显示后脑与实际可见后侧，不改成后三分之四。无回头事实不扭头，不补正面五官或借镜子露脸。

> Show [A] directly from behind, retaining her current pose and natural back-to-pelvis-to-thigh proportions. When her head faces away, show the back of her head and keep her face outside the view; retain the direct rear camera position.

### 严格侧面观察

适用：明确严格侧面或人物某一侧。指定哪侧就保持哪侧；侧脸不强露远侧眼，远侧肢体自然遮挡，不改成正面或三分之四。

> Show [A] in a strict view from her left side, retaining her stated head direction and the natural occlusion of the far-side limbs.

### 前方斜侧面

适用：明确前方三分之四观察。区分近侧与远侧的自然缩短，不把肩胯五官拉成正面镜像；相机角度不改变人物动作。

> Show [A] from the front at a three-quarter angle, preserving the near-to-far perspective and her existing pose.

### 后方斜侧面

适用：明确后方三分之四观察。保留后方观察基底和侧面缩短；只能出现头部原朝向实际可见的脸部，不自动回眸。

> Show [A] from a rear three-quarter angle, retaining her unchanged head direction and the natural overlap of her shoulders, pelvis and legs.

### 俯视观察

适用：明确镜头高于主体向下看。俯视由相机高度决定，不自动让人物低头、蹲下或抬眼看镜头；身体比例按透视自然缩短。

> View [A] from above at the requested high angle while keeping her stated posture and gaze unchanged.

### 仰视观察

适用：明确镜头低于主体向上看。仰视不自动让人物仰头、张腿或改变衣着覆盖；保持实际姿态和近远缩短，不夸张放大局部。

> View [A] from below at the requested low angle, preserving her pose, clothing state and natural proportions.

### 垂直顶视

适用：明确从主体正上方观察。顶视不等同于一般俯视；按地面接触和垂直投影显示，不补被头发身体遮住的五官或肢体。

> Show [A] directly from overhead, preserving her stated ground contacts and the body parts naturally hidden from this view.

### 过肩观察

适用：明确已有入镜人物的过肩构图。肩膀归属须在入镜名单且有范围依据；画外观众不能为过肩机位新增身体或变成额外演员。

> Show the interaction over [A]’s already visible shoulder, keeping [B] in the stated position without adding another observer.

### 机位与人物朝向分开

适用：镜头移动但剧情姿态未变化。观察方向、身体朝向、头部朝向和视线分别处理；镜头绕后不证明人物转身，侧面机位不改左右手任务。

> Move the viewpoint to [A]’s rear while keeping her body direction, head angle, gaze and hand contacts unchanged.

### 肢体近远缩短

适用：四肢朝向观察者或重叠明显。缩短属于投影而非缺肢；保持关节连续和各自归属，不复制手脚，不强迫每个指趾都露出。

> Retain the foreshortened near arm and naturally hidden far hand, keeping each limb attached to its own shoulder.

### 否定与排除范围

适用：未回头、无字或某元素明确不出现。排除项限定对应主体部位；保留必需物品，不把禁止第二把钥匙写成禁止所有钥匙。

> Show one unmarked sheet in [A]’s hand, with no second sheet and no writing on the paper.

## 易错词核对

| 中文 | 英文参考 | 边界 |
| --- | --- | --- |
| 瞳孔 | pupil | 不替换为iris或eye shape |
| 虹膜 | iris | 不替换为pupil或整眼大小 |
| 眼型 | eye shape | 不由瞳孔变化重设眼型 |
| 酒红色 | burgundy / wine-red | 不简化为red |
| 嘴唇闭合 | lips closed | 不等同于未说话；保持实际口部状态 |
| 画外 | off-camera | 不借远景、倒影或屏幕把已排除人物加回来 |
| 仅手入镜 | only the hand is visible | 不补脸或全身 |
| 背面 | rear view | 观察方向不证明人物回头或转身 |
| 严格侧面 | strict profile view | 不替换为three-quarter view；身体与头部方向分别处理 |
| 前方斜侧面 | front three-quarter view | 区分前侧与后侧，近远侧不强制对称 |
| 后方斜侧面 | rear three-quarter view | 不擅自回眸，不补原朝向不可见的正脸 |
| 俯视 | high-angle view | 不自动低头、蹲下或改变视线 |
| 仰视 | low-angle view | 不自动仰头、改变姿态或衣着覆盖 |

普通人类手为一拇指四手指，足为一大趾四小趾；总数不要求全部露出。非人身体按已确认结构处理。闭嘴不展示舌头，存在的耳尾翼不必为了证明存在而强行露出。绘画简化可以减少纹理，不能变成多肢体、指趾复制或错接关节。
