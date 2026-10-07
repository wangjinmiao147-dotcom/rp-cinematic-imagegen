import { extractJson, RpigError } from './utils.js';
import { storyTextForIllustration } from './story-text.js';
import { SCENE_FIELDS } from './scene-state.js';
import { normalizeAnalysisResult } from './analysis-normalization.js';

const isObject = x => x && typeof x === 'object' && !Array.isArray(x);
const nonempty = x => typeof x === 'string' && !!x.trim();
const stringArray = x => Array.isArray(x) && x.every(nonempty);
const nullableBoolean = x => x === null || typeof x === 'boolean';
function invalid(message, code = 'ANALYSIS_INVALID_SCHEMA') { throw new RpigError(code, `${message}，已停止生图`); }
function requireShape(condition, message) { if (!condition) invalid(message); }
const stageFields = {
    1: ['moment','moment_evidence','scene_state','actions','explicit_changes','thoughts','uncertainties',
        'narrative_end_state','persistent_continues','persistent_updates','continuity_state','continuity_updates','narrative_end_updates'],
    2: ['visible_characters','mentioned_only_characters','aliases','spatial_relations','action_ownership','conflicts','psychological_reactions'],
    3: ['edit_instruction','preserve','exclude','thought_bubble_instruction'],
};
function quote(raw, text) {
    requireShape(nonempty(raw), '原文证据缺失');
    const offset = text.indexOf(raw);
    if (offset < 0) invalid('证据不在对应正文中', 'ANALYSIS_INVALID_EVIDENCE');
    return offset;
}
function evidenceSourceIndex(fact, sources) {
    // A missing bookkeeping index can be recovered from a unique literal
    // quote in the supplied history. Do not invent a source or override a
    // supplied index whose evidence does not match.
    if (fact.source_message_index == null) {
        const matches = [...sources].filter(([, text]) => text.includes(fact.evidence));
        if (matches.length === 1) fact.source_message_index = matches[0][0];
    }
    return fact.source_message_index;
}
function sceneShape(state, text, sources = null, persistent = false) {
    requireShape(isObject(state), '场景状态必须是对象');
    requireShape(nullableBoolean(state.scene_continues), 'scene_continues 类型错误');
    if (persistent) requireShape(nullableBoolean(state.persistent_continues), 'persistent_continues 类型错误');
    for (const key of SCENE_FIELDS) {
        const f = state[key];
        if (f === null) continue;
        requireShape(isObject(f) && nonempty(f.value) && nonempty(f.evidence), `${key} 事实格式错误`);
        if (sources) {
            const sourceIndex = evidenceSourceIndex(f, sources);
            requireShape(Number.isInteger(sourceIndex) && sources.has(sourceIndex), '间隔事实来源消息错误');
            quote(f.evidence, sources.get(f.source_message_index));
        } else quote(f.evidence, text);
    }
}
function updateShape(updates, text, sources = null) {
    requireShape(Array.isArray(updates), '持续状态更新必须是数组');
    const seen = new Set();
    for (const u of updates) {
        requireShape(isObject(u) && nonempty(u.character) && ['clothing', 'props'].includes(u.category)
            && nonempty(u.key) && nonempty(u.value) && nonempty(u.evidence), '持续状态记录格式错误');
        const id = `${u.character.trim().toLowerCase()}|${u.category}|${u.key.trim().toLowerCase()}`;
        requireShape(!seen.has(id), '同一人物的同一持续状态出现冲突更新'); seen.add(id);
        if (sources) {
            const sourceIndex = evidenceSourceIndex(u, sources);
            requireShape(Number.isInteger(sourceIndex) && sources.has(sourceIndex), '持续状态来源消息错误');
            quote(u.evidence, sources.get(u.source_message_index));
        } else quote(u.evidence, text);
    }
}
function validateFacts(value, options) {
    const text = storyTextForIllustration(options.latestStory);
    const offset = quote(value.moment_evidence, text);
    if (text.indexOf(value.moment_evidence, offset + 1) >= 0) invalid('选定瞬间的原文片段重复，请提供可唯一定位的完整片段', 'ANALYSIS_AMBIGUOUS_MOMENT');
    // Quote location proves provenance, not event time. Narration may describe
    // a simultaneous state after the short moment anchor.
    sceneShape(value.scene_state, text);
    sceneShape(value.narrative_end_state, text, null, true);
    requireShape(nullableBoolean(value.persistent_continues), '人物持续状态连续性类型错误');
    requireShape(isObject(value.explicit_changes) && ['clothing', 'environment', 'props'].every(k => stringArray(value.explicit_changes[k])), '明确变化字段格式错误');
    requireShape(stringArray(value.uncertainties) && Array.isArray(value.thoughts), '不确定性或心理字段格式错误');
    for (const a of value.actions) {
        requireShape(isObject(a) && nonempty(a.character) && nonempty(a.action)
            && ['expression', 'gaze', 'contact'].every(k => a[k] === null || nonempty(a[k])), '人物动作字段格式错误');
    }
    for (const t of value.thoughts) {
        requireShape(isObject(t) && nonempty(t.character) && nonempty(t.content), '心理事实格式错误');
        quote(t.evidence, text);
    }
    updateShape(value.persistent_updates, text);
    updateShape(value.narrative_end_updates, text);
    const messages = options.previousState?._intervening_messages || [];
    const sources = new Map(messages.map(m => [m.source_message_index, m.text]));
    if (messages.length) sceneShape(value.continuity_state, text, sources, true);
    else requireShape(value.continuity_state === null, '没有间隔正文时 continuity_state 应为 null');
    updateShape(value.continuity_updates, text, sources);
}
function validateCast(value, options) {
    const strict = options.latestStory !== undefined;
    const text = strict ? storyTextForIllustration(options.latestStory) : '';
    if (strict && options.momentEvidence) quote(options.momentEvidence, text);
    if (strict) requireShape(isObject(value.aliases) && Object.entries(value.aliases).every(([a, b]) => nonempty(a) && nonempty(b))
        && ['mentioned_only_characters', 'spatial_relations', 'action_ownership', 'conflicts'].every(k => stringArray(value[k])), '人物关系字段格式错误');
    const canonical = name => {
        let result = name.trim(), visited = new Set();
        while (value.aliases?.[result]) {
            requireShape(!visited.has(result), '人物别名循环'); visited.add(result); result = value.aliases[result].trim();
        }
        return result.toLowerCase();
    };
    const names = new Set();
    const actionActors = new Set((options.sceneFacts?.actions || []).filter(a => nonempty(a?.character)).map(a => canonical(a.character)));
    for (const person of value.visible_characters) {
        if (!strict && nonempty(person)) { names.add(person.trim().toLowerCase()); continue; }
        requireShape(isObject(person) && nonempty(person.canonical_name) && nonempty(person.presence_evidence)
            && (person.visible_scope === null || nonempty(person.visible_scope)), '入镜人物缺少有效姓名、证据或范围');
        const id = canonical(person.canonical_name);
        requireShape(!names.has(id), '同一人物重复入镜'); names.add(id);
        if (strict) quote(person.presence_evidence, text);
        // A rejected offer describes the cause of another person's reaction.
        // It does not, by itself, establish the offerer's current body in frame.
        if (strict && Array.isArray(options.sceneFacts?.actions) && !actionActors.has(id)
            && /(?:拒绝|没有接|没接|未接|未接受|refus|did not accept)/i.test(person.presence_evidence)
            && /(?:递出|递来|递给|交给|送来|送给|offered|handed)/i.test(person.presence_evidence)) {
            const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const aliases = [person.canonical_name, ...Object.keys(value.aliases || {}).filter(a => canonical(a) === id)];
            const independentBody = aliases.some(a => {
                const body = new RegExp(`${escape(a)}(?:的)?(?:(?:左|右|双|两只|一只|伸出的|伸出的一只|抬起的|露出的)){0,2}(?:身体|身影|手掌|手臂|胳膊|手腕|手|脚|腿)|${escape(a)}(?:正在|仍然|此时|这时|正|仍|也)?(?:站|坐|蹲|跪|走|跑|伸手|握住|抓住|抱住|扶住|转身)|${escape(a)}(?:就|正|仍然|仍|此时|这时)?在[^，。！？；;\\n]{0,12}(?:身旁|身边|旁边|面前|身后)|\\b${escape(a)}\\s+(?:is\\s+|was\\s+)?(?:standing|sitting|kneeling|holding|gripping|reaching)`, 'gi');
                return [...person.presence_evidence.matchAll(body)].some(match => {
                    const before = person.presence_evidence.slice(0, match.index);
                    const after = person.presence_evidence.slice(match.index + match[0].length);
                    // An explicitly negated touch/appearance is not positive body evidence.
                    const negatedContact = /(?:没有|并未|未曾|从未|没|未|不曾|不)(?:触碰|碰到|碰|接触|握住|抓住|扶住|抱住|看见|看到|露出|伸出)(?:到)?(?:过)?\s*$/.test(before);
                    const excludedBody = /^(?:仍然|仍|也|此时|这时|却|其实|根本|完全)?(?:没有|并未|未曾|从未|没|未|不曾|不)(?:出现|入镜|入画|露出|伸出|被画出)/.test(after);
                    return !negatedContact && !excludedBody;
                });
            });
            if (!independentBody) invalid('被拒绝的递物前因不能证明递物者身体入镜', 'ANALYSIS_CAST_CONTEXT_ONLY');
        }
    }
    for (const name of value.mentioned_only_characters || []) {
        if (nonempty(name) && names.has(canonical(name))) invalid('同一人物同时被列入入镜与排除名单', 'ANALYSIS_CAST_CONFLICT');
    }
}

// Provider errors/refusals are control-flow failures, never image instructions.
// Do not rewrite or retry blocked content to get around an upstream rejection.
export function assertUsableInstruction(text, stage = '图片指令') {
    if (typeof text !== 'string' || !text.trim()) {
        throw new RpigError('ANALYSIS_EMPTY', `${stage}为空，已停止生图`);
    }
    const failure = /the prompt could not be submitted|generative ai prohibited use|policies\.google\.com\/terms\/generative-ai|(?:i (?:cannot|can't|am unable to)|i'm unable to) (?:help|assist|comply|generate|fulfill)|(?:request|prompt) (?:was |has been )?(?:blocked|rejected)|(?:无法|不能)(?:协助|帮助|满足|生成|提供)(?:此|这|该)|违反.{0,12}(?:使用政策|安全政策|内容政策)|quota exceeded|resource_exhausted|rate limit exceeded|invalid api key/i;
    if (failure.test(text)) {
        throw new RpigError('ANALYSIS_REJECTED', `${stage}返回了拒绝、错误或限流消息，未获得有效剧情指令，已停止生图；原始返回已记录`);
    }
}

/**
 * Issue F: Check if a stage-1 moment is actually a "no extractable frame" sentinel,
 * not a real drawable moment.
 */
function isNoFrameSentinel(moment) {
    if (!moment || typeof moment !== 'string') return true;
    const trimmed = moment.trim();
    return /^无可提取|^没有可提取|^当前没有|^无法提取|^No extractable/i.test(trimmed);
}

/**
 * Issue F: Check for unresolved core conflicts in stage-2 results that should
 * block image generation.
 */
function hasUnresolvedCoreConflicts(conflicts) {
    if (!Array.isArray(conflicts)) return false;
    return conflicts.some(c => {
        if (typeof c !== 'string') return false;
        c = c.trim();
        // Ordinary unknown lighting, handedness or expressions are not core conflicts.
        if (/^(?:已纠正|resolved|corrected|fixed)[：:]/i.test(c)) return false;
        return /核心冲突|身份不明|无法确定.*(?:动作归属|动作属于谁|是谁)|动作.*(?:矛盾|互斥)|同一肢体.*冲突|moment.*无法|core conflict|identity (?:unknown|unclear)|cannot determine (?:who|.*ownership)|(?:mutually exclusive|contradictory) actions|same (?:hand|limb).{0,50}conflict/i.test(c);
    });
}

export function parseAnalysisResponse(raw, stage, options = {}) {
    let value = extractJson(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.error || value.refusal) {
        assertUsableInstruction(String(raw || ''), `第 ${stage} 步`);
        throw new RpigError('ANALYSIS_INVALID_JSON', `第 ${stage} 步没有返回有效的结构化结果，已停止生图；不会把原始返回当作指令`);
    }
    value = normalizeAnalysisResult(value, stage, options);
    let valid = false;

    if (stage === 1) {
        valid = typeof value.moment === 'string' && !!value.moment.trim() && Array.isArray(value.actions);

        // Issue F: Detect "no extractable frame" sentinel as an invalid result.
        // The old code accepted this non-empty string as valid, but it should stop.
        if (valid && isNoFrameSentinel(value.moment)) {
            throw new RpigError('ANALYSIS_NO_FRAME', '第 1 步识别无可提取的当前画面事实，已停止生图');
        }

        // Issue F: Validate that at least one action has a character and action,
        // or that there are valid thoughts to potentially display.
        if (valid) {
            const hasValidAction = value.actions.some(a =>
                a && typeof a === 'object' && typeof a.character === 'string' && a.character.trim()
                && typeof a.action === 'string' && a.action.trim()
            );
            const hasValidThought = Array.isArray(value.thoughts) && value.thoughts.some(t =>
                t && typeof t === 'object' && typeof t.character === 'string' && t.character.trim()
                && typeof t.content === 'string' && t.content.trim()
            );
            if (!hasValidAction && !hasValidThought) {
                throw new RpigError('ANALYSIS_NO_SUBJECT', '第 1 步没有可画的主体或心理反应，已停止生图');
            }
        }
    }

    if (stage === 2) {
        valid = Array.isArray(value.visible_characters);
        if (valid) validateCast(value, options);

        // Issue F: Block empty cast list - can't generate an image with no one in it.
        if (valid && value.visible_characters.length === 0) {
            // Check if conflicts explain why it's empty (valid reason to stop)
            const reason = Array.isArray(value.conflicts) && value.conflicts.length > 0
                ? value.conflicts.join('; ')
                : '演员表为空且无说明';
            throw new RpigError('ANALYSIS_EMPTY_CAST', `第 2 步演员表为空，已停止生图：${reason}`);
        }

        // Issue F: Block unresolved core conflicts.
        if (valid && hasUnresolvedCoreConflicts(value.conflicts)) {
            const unresolvedItems = value.conflicts
                .filter(c => typeof c === 'string' && /^未解决[：:]/.test(c))
                .join('; ');
            throw new RpigError('ANALYSIS_UNRESOLVED_CONFLICT',
                `第 2 步存在未解决的核心冲突，已停止生图：${unresolvedItems || '详见 conflicts'}`);
        }
    }

    if (stage === 3) {
        valid = typeof value.edit_instruction === 'string' && !!value.edit_instruction.trim()
            && (value.preserve == null || typeof value.preserve === 'string')
            && (value.exclude == null || (Array.isArray(value.exclude) && value.exclude.every(x => typeof x === 'string')));
    }

    if (!valid) throw new RpigError('ANALYSIS_INVALID_SCHEMA', `第 ${stage} 步结果缺少必要字段或字段类型错误，已停止生图`);
    if (options.latestStory !== undefined) requireShape(Object.keys(value).every(k => stageFields[stage]?.includes(k)), '结构化结果含未约定字段');
    if (stage === 1 && options.latestStory !== undefined) validateFacts(value, options);
    if (stage === 3 && options.latestStory !== undefined) requireShape(typeof value.preserve === 'string' && stringArray(value.exclude), '编辑指令必须包含 preserve 和 exclude');
    if (stage === 1) assertUsableInstruction(value.moment, '剧情事实');
    if (stage === 3) assertUsableInstruction(value.edit_instruction, '英文编辑指令');
    if (stage === 3 && Array.isArray(options.expectedCharacterNames)) {
        const missing = [...new Set(options.expectedCharacterNames.filter(name => typeof name === 'string' && name.trim()))]
            .filter(name => !value.edit_instruction.includes(name));
        if (missing.length) throw new RpigError('ANALYSIS_IDENTITY_MISMATCH', '第 3 步没有保留已核对的规范人物姓名，已停止生图：' + missing.join('、'));
    }
    return value;
}
