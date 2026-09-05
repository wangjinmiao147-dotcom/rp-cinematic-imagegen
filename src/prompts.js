// ============================================================
// RP 电影配图 - 提示词与预设模块
// ============================================================

import { detectGenderTag, stripHtml, mergeNegativePrompts } from './utils.js';

export const DEFAULT_SD_NEGATIVE = 'poorly drawn hands, malformed hands, deformed hands, mutated hands, extra hands, missing hands, fused hands, extra fingers, six fingers, missing fingers, fused fingers, webbed fingers, twisted fingers, broken fingers, duplicate fingers, extra digits, fewer digits, bad wrists, disconnected hands, extra arms, missing arms, fused arms, extra limbs, floating limbs, malformed feet, extra feet, missing feet, extra toes, missing toes, fused toes, malformed toes, extra legs, missing legs, disconnected ankles, duplicated person, cloned character, reflected person, identity duplication, (worst quality, low quality, normal quality:1.4), lowres, bad anatomy, bad hands, text, error, cropped, jpeg artifacts, signature, watermark, username, blurry, artist name, bad proportions, duplicate, passport photo, mugshot, stiff pose';

// 画风预设指令
export const STYLE_PRESETS = {
    character: `【画风原则】严格跟随角色原图与人设的真实画风。二次元动漫角色卡采用 anime style / 2D illustration / cel shading；写实真人卡采用 photorealistic / cinematic lighting。风格必须前后统一。`,
    anime: `【画风原则】强制二次元动画风格。final_prompt 必须指明：2D anime illustration, cel shading, clean lineart, vibrant colors。严禁出现 photorealistic、real photo 等写实词。`,
    realistic: `【画风原则】电影写实风格。final_prompt 使用 photorealistic, cinematic lighting, 35mm film, shallow depth of field, natural skin texture 等写实质感词；严禁出现 anime、cel shading 等二次元词。`,
};

// 双镜头模式指令
export const SHOT_MODE_INSTRUCTIONS = {
    snapshot: `【镜头模式 · 🎬 剧情剧照抓拍（Cinematic Snapshot）】
- 核心焦点：以【最新焦点回合】中发生的人物与环境交互、动态动作抓拍、故事事件的关键瞬间为主。
- 提示词要素：[真实环境与动机光源] + [具体动作/交互姿态] + [摄影机机位(如 over-the-shoulder shot / low-angle dramatic view / medium shot)] + [电影画面质感与构图]。
- 手脚可以根据剧情与构图自然出镜；人物触碰、握持、行走等动作应被真实还原，不能为了规避解剖而裁掉互动。
- 【严禁】：呆板的正脸立绘、证件照感或无互动的单调站姿。让画面像电影大片中被截取下的一帧抓拍。`,
    portrait: `【镜头模式 · 👤 角色微表情特写（Character Portrait）】
- 核心焦点：角色的面部神态、眼神交互、微妙情绪流露与微表情细节。
- 提示词要素：[特写 close-up 或胸像/肩部以上 medium close-up, upper body shot] + [眼神微光与细腻神态] + [柔和动机光影] + [背景轻度景深虚化 shallow depth of field]。
- 若剧情包含触摸、握持或手势，可以让手自然进入画面；构图由剧情与人物关系决定。
- 重点捕捉角色的情绪流动与内心世界，拒绝僵硬大头贴。`,
};

// 提示词输出格式指令
export const FORMAT_INSTRUCTIONS = {
    natural: `【提示词输出格式 · 英文自然语言长句】
- final_prompt 必须输出地道流畅、画面感极强的英文自然语言描述长句。
- 结构：[画风与艺术媒介] + [角色核心外貌] + [具体动作与神态] + [环境场景与光影] + [机位视角与构图氛围]。`,
    tags: `【提示词输出格式 · Danbooru Tag 标签流】
- final_prompt 必须输出英文逗号分隔的 Danbooru/Booru 标签流（Tag List）。
- 示例：1girl, solo, holding sword, standing in rain, dramatic lighting, dynamic angle, masterpiece
- 结构：[画风质量] -> [角色特征] -> [构图机位] -> [动作表情] -> [环境光影]。`,
};

// 导演级剧照 System Prompt
export const DIRECTOR_SYSTEM_PROMPT = `你是顶级电影导演兼 AI 绘画提示词专家。你的任务：根据【最新焦点回合】剧情与前序背景，构思一张画面极具表现力、能够精准还原当前最新故事瞬间的专业提示词。

【核心原则】
1. 【绝对优先最新焦点回合】：前序历史对话仅用于补充人物关系与地点背景；画面动作、姿态、事件必须以【最新焦点回合（Latest AI Message）】为绝对最高准则！严禁沿用上一轮已经结束的动作、姿态或构图；若最新回合与历史发生冲突或转折，以最新回合为准；final_prompt 必须至少包含最新回合中的一个具体动作/环境变化/情绪事实。
2. 【忠于当前角色】：从角色设定中提取真实外貌（发色/瞳色/特征）；若未指定外貌，保持与故事世界观和谐统一，绝不随意乱套无关特征。
3. 【跨镜头造型连续性】：若提供【上一张剧情图的造型锚点】，且最新回合没有明确换装、脱衣、衣物损坏、时间大幅跳跃或外形改变，final_prompt 必须逐项延续上一镜头的服装款式、主辅颜色、材质、层次、鞋袜、饰品、发型与持续携带的道具。只继承人物造型，不得照搬上一镜头的动作、姿势、机位、环境或光线。若剧情明确改变造型，以最新回合为准并写出变化。
4. 【场景事实锁定】：必须从最新焦点回合与必要的前序背景提取场景事实，并输出 scene_anchor（一句简洁英文：地点/室内外、时间或天气、主光源、关键环境物）。scene_anchor 中的场景事实必须进入 final_prompt；不得用上一张参考图的房间、背景、时间、天气或光线补全缺失信息。若剧情未明确某一项，可以省略，不要凭空编造。
5. 【电影级视听语言】：明确指定摄影机机位（如 over the shoulder shot, low angle, medium close-up）、动机光源（如 moonlight through window, golden sunset, candle light）与景深，但不得与 scene_anchor 冲突。
6. 【手脚与肢体解剖质量规则】：手脚允许自然出镜并参与剧情动作。每只可见的手只能有五根结构清楚、比例自然的手指，手腕与前臂正确连接；每只可见的脚只能有五根结构清楚、比例自然的脚趾，脚踝与小腿正确连接。人物只能拥有正常数量的双手、双脚、手臂和腿，不得出现多指、少指、多趾、少趾、多手、多脚、融合或断裂肢体。

${'${shotInstruction}'}

${'${formatInstruction}'}

${'${stylePreset}'}

【avoid 负面词】
- 必须包含手脚解剖约束：malformed hands, extra hands, missing hands, extra fingers, missing fingers, fused fingers, malformed feet, extra feet, missing feet, extra toes, missing toes, fused toes, disconnected wrists, disconnected ankles, bad anatomy, extra limbs 等。

【输出格式】只输出一个 JSON 对象：
{
  "scene_changed": true,
  "reason": "一句话中文理由（必须指出最新回合的核心动作或事件）",
  "style": "判定的画风",
  "shot": "景别与机位简述",
  "scene_anchor": "英文场景事实，如 moonlit villa corridor at midnight, warm wall lantern, open guest-room doorway",
  "final_prompt": "地道专业的英文提示词",
  "avoid": "英文负面词，逗号分隔"
}

scene_changed 必须是布尔值：场景/时间/环境发生变化为 true；仅人物情绪或轻微动作连续则为 false。`;

/**
 * 提取角色视觉特征锚点
 * @param {object} character 
 * @param {object} [customAnchors] 
 * @returns {string}
 */
export function getCharacterVisualAnchor(character, customAnchors = {}) {
    if (!character) return '';
    const key = character.avatar || character.name || 'default';
    if (customAnchors && customAnchors[key]) {
        return customAnchors[key].trim();
    }
    const desc = character.data?.description || character.description || '';
    const personality = character.data?.personality || character.personality || '';
    const text = `${character.name || ''}\n${desc}\n${personality}`;
    if (!text.trim()) return '';

    const anchors = [];
    if (/银发|白发|silver hair|white hair/i.test(text)) anchors.push('silver hair');
    else if (/黑发|black hair/i.test(text)) anchors.push('black hair');
    else if (/金发|blonde hair|yellow hair/i.test(text)) anchors.push('blonde hair');
    else if (/红发|red hair/i.test(text)) anchors.push('red hair');
    else if (/蓝发|blue hair/i.test(text)) anchors.push('blue hair');
    else if (/粉发|pink hair/i.test(text)) anchors.push('pink hair');

    if (/紫眸|紫眼|紫瞳|purple eyes|violet eyes/i.test(text)) anchors.push('purple eyes');
    else if (/红眸|红眼|红瞳|red eyes/i.test(text)) anchors.push('red eyes');
    else if (/蓝眸|蓝眼|蓝瞳|blue eyes/i.test(text)) anchors.push('blue eyes');
    else if (/金眸|金瞳|golden eyes/i.test(text)) anchors.push('golden eyes');

    return anchors.join(', ');
}

/**
 * 构造前序历史对话上下文（严格排除当前目标消息，避免内容重复）
 * @param {Array} chat 
 * @param {number} targetIndex 
 * @param {number} windowSize 
 * @returns {string}
 */
export function buildDialogueContext(chat, targetIndex, windowSize = 12) {
    if (!Array.isArray(chat) || targetIndex <= 0 || targetIndex >= chat.length) {
        return '';
    }
    // 严格截取目标消息之前的轮次（不包含 targetIndex 自身）
    const start = Math.max(0, targetIndex - windowSize);
    const end = targetIndex - 1;
    const lines = [];

    for (let i = start; i <= end; i++) {
        const msg = chat[i];
        if (!msg) continue;
        const speaker = msg.is_user ? (msg.name || 'User') : (msg.name || 'AI');
        const text = stripHtml(msg.mes || '').slice(0, 400);
        if (text) {
            lines.push(`[${speaker}]: ${text}`);
        }
    }
    return lines.join('\n');
}

/**
 * 组装导演提示词请求
 */
export function buildDirectorPrompt({
    character,
    currentMessageText,
    dialogueHistory = '',
    shotMode = 'snapshot',
    promptFormat = 'natural',
    stylePreset = 'character',
    customAnchors = {},
    continuityContext = '',
    hideHandsFeet = false,
}) {
    const shotInst = SHOT_MODE_INSTRUCTIONS[shotMode] || SHOT_MODE_INSTRUCTIONS.snapshot;
    const formatInst = FORMAT_INSTRUCTIONS[promptFormat] || FORMAT_INSTRUCTIONS.natural;
    const styleInst = STYLE_PRESETS[stylePreset] || STYLE_PRESETS.character;

    const system = DIRECTOR_SYSTEM_PROMPT
        .replace('${shotInstruction}', shotInst)
        .replace('${formatInstruction}', formatInst)
        .replace('${stylePreset}', styleInst);

    const charName = character ? (character.name || 'character') : 'character';
    const anchor = getCharacterVisualAnchor(character, customAnchors);
    const charDesc = character ? (character.data?.description || character.description || '').slice(0, 400) : '';

    let userText = `【当前互动角色】：${charName}`;
    if (charDesc) userText += `\n【角色设定简介】：${charDesc}`;
    if (anchor) userText += `\n【角色核心外貌】：${anchor}`;
    if (continuityContext) {
        userText += `\n\n【上一张剧情图的造型锚点（仅继承服装/发型/配饰/随身道具，不继承动作与构图）】：\n${stripHtml(continuityContext).slice(0, 1600)}`;
    }
    userText += `\n\n【手脚解剖硬约束】：手脚允许根据剧情自然出镜。每只可见手必须恰好五指且手腕连接正确；每只可见脚必须恰好五趾且脚踝连接正确；不得出现多指、少指、多趾、少趾、多手、多脚或断裂肢体。`;
    if (dialogueHistory) userText += `\n\n【前序历史背景（仅供参考背景，不得沿用已结束动作）】：\n${dialogueHistory}`;
    userText += `\n\n【唯一画面焦点 · 最新 AI 回复（画面动作/事件/构图绝对以此为准）】：\n${stripHtml(currentMessageText || '').slice(0, 1800)}`;

    return { system, userText };
}

export const OMNISCIENT_SYSTEM_PROMPT = `你是电影场面调度师，使用“上帝视角”核对同一瞬间所有在场人物。你的工作是补全焦点镜头可能遗漏的人物关系，而不是创造第二张图或分屏画面。

【硬规则】
1. 最新 AI 回复的事实优先；历史只用于确认人物关系、持续造型和地点。
2. 【候选人物资料】只是用于身份消歧，不等于全部入镜。你必须根据最新焦点回合建立“当前可见演员表”：用户主人公、当前确实在场的角色、群像成员和身体明确处于镜头内的 NPC。只被提及、回忆、打电话、在照片/镜子/屏幕中出现或已经离场的人不得加入。
3. 合并同一人物的别名。AI、Assistant、Bot、当前消息说话人名称和当前角色卡名称可能指同一个角色；User、you、用户、玩家、主人公和用户名称可能指同一个人。别名不得被计算成额外人物。
4. “所有人的视角”表示理解每个人看见什么、在回应谁，再将这些关系转成可见的眼神、身体朝向和空间关系；最终仍是一台摄影机拍摄的一个连续瞬间，禁止分屏、拼贴、多画格和同时出现多个摄像机视角。
5. 内心想法只能转成可见表情或姿态，不得把文字、字幕、对话气泡、幻象或旁白画进图片。
6. 根据最终可见演员表选择构图：一人使用单人镜头，两人使用 balanced two-shot，三人及以上使用 clear group ensemble shot。演员表有几人，画面就必须恰好出现几人，每人只出现一次，不得增加路人、群众、倒影人物或复制身体。
7. 手脚允许自然出镜；每只可见手五指、每只可见脚五趾，手腕脚踝连接正确，人物肢体数量正常。
8. visible_characters 必须使用消歧后的规范姓名或明确身份，每个真实人物只列一次。ensemble_prompt 必须逐一写出其中每个人的外貌、位置、视线、动作和关系。

只输出一个 JSON 对象：
{
  "visible_characters": ["消歧后的规范姓名或身份；一人一项，不含别名重复"],
  "ensemble_prompt": "严格按照 visible_characters 的人数和名单，呈现全部当前可见人物、空间位置、视线和互动关系的英文画面提示词片段",
  "scene_anchor": "英文场景事实：地点、时间/天气、主光源、关键环境物",
  "avoid": "英文负面词，包含 unlisted person, duplicate person, cloned character, reflected person, identity swap, split screen, collage, text；不得否定演员表中已确认的人物或群像"
}`;

export function buildOmniscientPrompt({
    currentMessageText,
    dialogueHistory = '',
    participantContext = '',
    directorDraft = '',
    sceneAnchor = '',
    shotMode = 'snapshot',
    stylePreset = 'character',
    hideHandsFeet = false,
} = {}) {
    let userText = `【最新焦点回合】：\n${stripHtml(currentMessageText || '').slice(0, 2200)}`;
    if (participantContext) userText += `\n\n【候选人物资料，仅用于判断和消歧；不要自动全部入镜】：\n${participantContext.slice(0, 6000)}`;
    if (dialogueHistory) userText += `\n\n【前序背景，仅用于关系与连续性】：\n${dialogueHistory.slice(0, 4000)}`;
    if (directorDraft) userText += `\n\n【焦点镜头初稿，供核错补漏】：\n${stripHtml(directorDraft).slice(0, 2200)}`;
    if (sceneAnchor) userText += `\n\n【已提取场景锚点】：${stripHtml(sceneAnchor).slice(0, 700)}`;
    userText += `\n\n【镜头模式】：${shotMode}\n【画风设置】：${stylePreset}`;
    userText += '\n【演员表硬约束】：先合并同一人物的所有别名，再列出当前身体确实在场的人物。普通单聊通常是用户主人公与当前角色两人；群聊、群像或最新剧情明确出现 NPC 时允许更多人。最终画面人数必须与 visible_characters 完全相等。手脚允许自然出镜，每只可见手恰好五指，每只可见脚恰好五趾。';
    return { system: OMNISCIENT_SYSTEM_PROMPT, userText };
}

export const FINALIZER_SYSTEM_PROMPT = `你是最终生图提示词总编。你会收到焦点镜头初稿、上帝视角人物关系稿、最新剧情、人物资料、场景锚点和连续性约束。请消除冲突、去重并合成为一条可直接发送给生图模型的最终英文提示词。

【优先级】最新剧情明确事实 > 人物身份与视觉资料 > 场景锚点 > 上帝视角空间关系 > 焦点镜头构图建议 > 上一张图的造型连续性。上一张图只提供人物身份和未改变的服装发型，绝不能覆盖当前动作、地点、时间、光线或摄影机位置。

【成稿规则】
- 只描绘一个时间点、一处场景、一台摄影机和一个统一构图。
- 若提供【最终锁定的可见演员表】，人数与名单是最高优先级硬约束。画面只能出现名单中的人物，并且必须全部出现、每人一次；不得把 AI/角色名或 User/主人公等别名画成额外人物。两人使用 balanced two-shot，三人及以上使用 clear group ensemble shot。
- 把所有人物的主观反应转为同一画面内可见的表情、视线与身体关系；禁止分屏、拼贴、多画格、文字、字幕、对话框和水印。
- 保留真实动机光源、景别、机位、景深和电影质感，但不要堆砌相互冲突的风格词或镜头词。
- 手脚可以自然出镜并执行剧情动作。明确要求每只可见手五指、每只可见脚五趾、手腕脚踝自然连接、肢体数量正常。
- 输出 100–220 个英文单词的一整段自然语言。只能输出这一个英文段落；不要 JSON、标题、标签、解释、项目符号、Markdown 或换行。`;

export function buildFinalizerPrompt({
    directorDraft = '',
    omniscientDraft = '',
    currentMessageText = '',
    participantContext = '',
    visibleCharacters = [],
    sceneAnchor = '',
    continuityContext = '',
    shotMode = 'snapshot',
    stylePreset = 'character',
    hideHandsFeet = false,
} = {}) {
    let userText = `【最新剧情事实】：\n${stripHtml(currentMessageText || '').slice(0, 2200)}`;
    userText += `\n\n【焦点镜头初稿】：\n${stripHtml(directorDraft || '').slice(0, 2600)}`;
    if (omniscientDraft) userText += `\n\n【上帝视角人物关系稿】：\n${stripHtml(omniscientDraft).slice(0, 3200)}`;
    if (participantContext) userText += `\n\n【人物身份与视觉资料】：\n${participantContext.slice(0, 6000)}`;
    if (Array.isArray(visibleCharacters) && visibleCharacters.length) {
        userText += `\n\n【最终锁定的可见演员表 · 恰好 ${visibleCharacters.length} 人】：\n${visibleCharacters.map((name, index) => `${index + 1}. ${name}`).join('\n')}`;
    }
    if (sceneAnchor) userText += `\n\n【场景锚点】：${stripHtml(sceneAnchor).slice(0, 700)}`;
    if (continuityContext) userText += `\n\n【上一镜头造型连续性，仅继承未改变的脸、发型、服装和配饰】：\n${stripHtml(continuityContext).slice(0, 1600)}`;
    userText += `\n\n【镜头模式】：${shotMode}\n【画风】：${stylePreset}`;
    if (Array.isArray(visibleCharacters) && visibleCharacters.length) {
        const shotRule = visibleCharacters.length === 1
            ? 'single-character medium shot'
            : visibleCharacters.length === 2
                ? 'balanced two-shot'
                : 'clear group ensemble shot';
        userText += `\n【人数硬约束】：使用 ${shotRule}；只能出现上述 ${visibleCharacters.length} 人，必须全部入镜且每人只出现一次。不得增加名单外人物、路人、群众、倒影人物、画像人物或角色分身。`;
    }
    userText += '\n【手脚解剖】：允许手脚自然出镜和互动；每只可见手恰好五指，每只可见脚恰好五趾，手腕脚踝自然连接，手、脚、手臂和腿的数量正常。';
    return { system: FINALIZER_SYSTEM_PROMPT, userText };
}

export function collapsePromptToSingleParagraph(value) {
    return stripHtml(String(value || ''))
        .replace(/```(?:json|text|markdown)?/gi, ' ')
        .replace(/```/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function normalizeFinalPromptOutput(raw) {
    const parsed = (() => {
        try {
            const match = String(raw || '').match(/\{[\s\S]*\}/);
            return match ? JSON.parse(match[0]) : null;
        } catch {
            return null;
        }
    })();
    let value = parsed?.final_prompt || parsed?.prompt || raw || '';
    value = collapsePromptToSingleParagraph(value)
        .replace(/^(?:final[_ ]prompt|prompt)\s*:\s*/i, '')
        .replace(/^['"]|['"]$/g, '')
        .trim();
    return value;
}

/**
 * 将第一张视觉参考的用途明确写入最终生图提示词。
 * 这能避免模型把上一镜头的姿势和背景一起复制，只保留角色造型连续性。
 */
export function appendVisualContinuityDirective(prompt, promptFormat = 'natural') {
    const base = (prompt || '').trim();
    if (!base) return '';
    if (promptFormat === 'tags') {
        return `${base}, preserve unchanged wardrobe and accessories from continuity reference, new pose, new composition, do not copy reference face drift, background, pose, or lighting`;
    }
    return `Use the continuity reference only for clothing, accessories, hairstyle state, and carried props that remain unchanged in the current story. Do not treat it as a new identity source and do not inherit any facial deviation, pose, camera angle, background, or lighting from it.\n\n${base}`;
}

/**
 * 角色卡原图是每轮重新校准身份的不可变锚点，避免连续生成造成脸部漂移。
 */
export function appendVisualIdentityDirective(prompt, promptFormat = 'natural') {
    const base = (prompt || '').trim();
    if (!base) return '';
    if (promptFormat === 'tags') {
        return `same exact person as primary identity reference, immutable facial identity, same face silhouette, same facial proportions, same eye shape and spacing, same nose and mouth, same age and skin tone, same hairline and signature hair ornaments, no face redesign, no identity averaging, ${base}`;
    }
    return `Reference image 1 is the immutable primary identity source. Depict the exact same individual, preserving the face silhouette, skull and facial proportions, eye shape and spacing, iris color, nose, mouth, age, skin tone, hairline, hairstyle, and signature hair ornaments. Do not beautify, age, redesign, merge, average, or reinterpret the face. Camera distance, expression, pose, scene, and wardrobe may change as required by the current story without changing identity.\n\n${base}`;
}

/**
 * 将最新对话提炼的场景事实追加到最终图片提示词，覆盖参考图的旧背景。
 */
export function appendSceneLockDirective(prompt, sceneAnchor, promptFormat = 'natural') {
    const base = (prompt || '').trim();
    const anchor = stripHtml(sceneAnchor || '').replace(/\s+/g, ' ').trim();
    if (!base || !anchor) return base;
    if (promptFormat === 'tags') {
        return `${base}, ${anchor}, scene setting is mandatory, different background from reference image`;
    }
    return `${base}\n\nScene setting (mandatory): ${anchor}. This location, time, lighting, and visible environment override the background of the reference image.`;
}

/**
 * 统一组装剧情画面的最终提示词。
 * 角色连续性只影响人物造型；场景锁定始终覆盖参考图的背景。
 */
export function buildSceneAwareImagePrompt({
    basePrompt,
    sceneAnchor = '',
    hasIdentityReference = false,
    hasContinuityReference = false,
    promptFormat = 'natural',
} = {}) {
    let prompt = (basePrompt || '').trim();
    if (!prompt) return '';
    if (hasContinuityReference) {
        prompt = appendVisualContinuityDirective(prompt, promptFormat);
    }
    if (hasIdentityReference) {
        // 最后追加使其位于整段最前，确保身份规则拥有最高文本优先级。
        prompt = appendVisualIdentityDirective(prompt, promptFormat);
    }
    return appendSceneLockDirective(prompt, sceneAnchor, promptFormat);
}

/**
 * 组装形象工作台（三视图 / 全身立绘）提示词
 */
export function buildCharacterSheetPrompt({
    character,
    type = 'three_views',
    isTags = false,
    customPrompt = '',
}) {
    const charName = character ? (character.name || 'character') : 'character';
    const charDesc = character ? `${character.data?.description || ''} ${character.description || ''}` : '';
    const genderTag = detectGenderTag(charDesc);

    let prompt = '';
    const avoid = mergeNegativePrompts(
        DEFAULT_SD_NEGATIVE,
        'dark background, complex background, text, watermark, deformed body'
    );

    const handRuleTags = 'natural relaxed hands at sides, five fingers per hand, correct wrists, separate fingers';
    const handRuleNatural = 'natural relaxed hands resting at sides with five well-defined fingers each, correct wrist and arm anatomy, no extra digits';

    if (type === 'three_views') {
        if (isTags) {
            prompt = `${genderTag}, character sheet, 3 views turnaround, front view, side view, back view, full body, head to toe, standing pose, ${handRuleTags}, matching face and hair of input reference image, clean simple white background, high quality, masterpiece`;
        } else {
            prompt = `Character design turnaround sheet of ${charName}, 3 views: front view, side view, back view, full body from head to toe, standing pose, ${handRuleNatural}, exactly matching the face, hair and style of the input reference image, clean neutral white background, high quality concept art, 8k resolution, masterpiece`;
        }
    } else {
        if (isTags) {
            prompt = `${genderTag}, full body portrait, standing, head to toe view, ${handRuleTags}, matching face and hair of input reference image, clean simple white background, masterpiece, highest quality`;
        } else {
            prompt = `Full body standing portrait of ${charName}, complete head to toe view, ${handRuleNatural}, perfectly matching the face, hair and appearance of the input reference image, clean neutral background, detailed concept art, masterpiece`;
        }
    }

    if (customPrompt && customPrompt.trim()) {
        prompt += `, ${customPrompt.trim()}`;
    }

    return { prompt, avoid };
}

/**
 * 根据不同图片后端特性，准备合并后的主提示词与负面提示词
 * @param {object} settings 
 * @param {string} prompt 
 * @param {string} avoid 
 * @returns {{ prompt: string, avoid: string }}
 */
export function preparePromptForBackend(settings, prompt, avoid, options = {}) {
    const s = settings || {};
    const basePrompt = collapsePromptToSingleParagraph(prompt);
    const anatomyAvoid = 'extra hands, missing hands, malformed hands, extra fingers, missing fingers, fused fingers, duplicate fingers, disconnected wrists, extra feet, missing feet, malformed feet, extra toes, missing toes, fused toes, disconnected ankles, extra arms, missing arms, extra legs, missing legs, extra limbs, duplicated person, cloned character, reflected person';
    const mergedAvoid = mergeNegativePrompts(DEFAULT_SD_NEGATIVE, s.sdNegative, avoid, anatomyAvoid);

    if (s.backend === 'openai' || s.backend === 'gemini') {
        const anatomyRule = 'Hands and feet may be naturally visible and may perform the story action. Every visible hand has exactly five well-formed fingers with natural joints and a correctly connected wrist; every visible foot has exactly five well-formed toes with a correctly connected ankle. Keep a normal number of hands, feet, arms, and legs, with no extra, missing, fused, duplicated, or disconnected digits or limbs.';
        const finalPrompt = collapsePromptToSingleParagraph(`${basePrompt} ${anatomyRule}`);
        return { prompt: finalPrompt, avoid: mergedAvoid };
    }

    if (s.backend === 'tavern-sd') {
        const finalPrompt = `${basePrompt}, anatomically correct hands, five fingers per hand, correct wrists, anatomically correct feet, five toes per foot, correct ankles, natural limbs`;
        return { prompt: finalPrompt, avoid: mergedAvoid };
    }

    return {
        prompt: `${basePrompt}, anatomically correct hands, five fingers per hand, correct wrists, anatomically correct feet, five toes per foot, correct ankles, natural limbs`,
        avoid: mergedAvoid,
    };
}

