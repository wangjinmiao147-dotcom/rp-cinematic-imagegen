import { storyTextForIllustration } from './story-text.js';
import { RpigError } from './utils.js';
import { normalizePsychologicalReactions } from './visual-constraints.js';

const object = x => x && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' ? x.trim() : '';
const unknown = x => !text(x) || /^(?:null|none|unknown|n\/a|未知|未说明|未提及|不明)$/i.test(text(x));
const list = x => x == null ? [] : Array.isArray(x) ? x : [x];
const fields = {
    1: ['moment','moment_evidence','scene_state','actions','explicit_changes','thoughts','uncertainties',
        'narrative_end_state','persistent_continues','persistent_updates','continuity_state','continuity_updates','narrative_end_updates'],
    2: ['visible_characters','mentioned_only_characters','aliases','spatial_relations','action_ownership','conflicts','psychological_reactions'],
    3: ['edit_instruction','preserve','exclude','thought_bubble_instruction'],
};
const labels = {
    character:'人物', actor:'执行者', owner:'所属人物', subject:'主体', with:'接触对象', target:'对象', object:'物体',
    part:'部位', body_part:'身体部位', bodyPart:'身体部位', hand:'手', side:'侧别', direction:'方向',
    position:'位置', relation:'关系', action:'动作', expression:'表情', gaze:'视线', contact:'接触',
    source:'来源', from:'从', to:'到', count:'数量', quantity:'数量', state:'状态', status:'状态',
    resolved:'已解决', severity:'严重程度', issue:'问题', message:'问题', reason:'原因', detail:'细节', details:'细节',
    element:'元素', canonical_name:'人物', name:'名称', visible_scope:'入镜范围', scope:'范围',
    pupil:'瞳孔', pupils:'瞳孔', iris:'虹膜', eye_shape:'眼型', eyeShape:'眼型', change:'变化',
};

// Repair representation only. Never manufacture a gesture, actor, quote or source.
export function normalizeAnalysisResult(raw, stage, options = {}) {
    const notes = [];
    const invalidUpdates = new Set();
    const note = (path, operation) => notes.push({path, operation});
    const source = storyTextForIllustration(options.latestStory || '');
    const describe = (value, path, depth = 0) => {
        if (value == null || (typeof value === 'string' && unknown(value))) return null;
        if (typeof value === 'string') return value.trim();
        if (depth > 3) { note(path, '无法展开的可选描述留空'); return null; }
        if (Array.isArray(value)) {
            const parts = value.map((v,i) => describe(v, `${path}.${i}`, depth+1)).filter(Boolean);
            note(path, '描述数组合并为文字'); return parts.length ? parts.join('；') : null;
        }
        if (object(value)) {
            if (value.error || value.refusal) throw new RpigError('ANALYSIS_REJECTED', `${path} 返回了拒绝或错误消息，未获得有效剧情指令`);
            const wrapper=['value','text','description','content','instruction'].find(key=>typeof value[key]==='string'&&!unknown(value[key]));
            const d=wrapper ? describe(value[wrapper], path, depth+1) : null;
            const scope=d ? describe(value.scope, `${path}.scope`, depth+1) : null;
            const base=d && scope ? `${d} (${scope})` : d;
            const parts = Object.entries(value).filter(([key]) => labels[key] && !(base && key==='scope')).map(([key,v]) => {
                const d = typeof v === 'number' && ['count','quantity'].includes(key) ? String(v)
                    : typeof v === 'boolean' && key === 'resolved' ? String(v) : describe(v, `${path}.${key}`, depth+1);
                return d ? `${labels[key]}：${d}` : null;
            }).filter(Boolean);
            if (base) parts.unshift(base);
            note(path, parts.length ? '保留包装文字与结构化字段标签' : '无可读描述的可选对象留空');
            return parts.length ? parts.join('；') : null;
        }
        note(path, '无文字含义的可选值留空'); return null;
    };
    const strings = (value, path) => list(value).map((v,i) => describe(v, `${path}.${i}`)).filter(Boolean);
    const bool = (value, path) => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string' && /^(?:true|false)$/i.test(value.trim())) {
            note(path, '布尔字符串转为布尔值'); return value.trim().toLowerCase() === 'true';
        }
        if (value != null && !unknown(value)) note(path, '不明确的连续性留空');
        return null;
    };
    const alternateFields={
        2:{visible_names:'visible_characters',excluded_characters:'mentioned_only_characters',spatialRelations:'spatial_relations',actionOwnership:'action_ownership'},
        3:{editInstruction:'edit_instruction'},
    }[stage] || {};
    const input={...raw};
    for (const [alternate,standard] of Object.entries(alternateFields)) if (input[standard]==null && input[alternate]!=null) {
        input[standard]=input[alternate]; note(alternate, `兼容字段名称为 ${standard}`);
    }
    const value = Object.fromEntries((fields[stage] || []).filter(k => k in input).map(k => [k, input[k]]));
    for (const k of Object.keys(raw)) if (!fields[stage]?.includes(k) && !(k in alternateFields)) note(k, '忽略协议外字段');
    const historical = new Map((options.previousState?._intervening_messages || []).map(m => [m.source_message_index, m.text]));
    const verified = (f, path, history = false) => {
        if (f == null || (typeof f === 'string' && unknown(f))) return null;
        if (!object(f) || !text(f.value) || !text(f.evidence)) { note(path, '缺少值或原文依据的可选事实留空'); return null; }
        const result = {...f, value:f.value.trim()};
        let origin = source;
        if (history) {
            if (typeof result.source_message_index === 'string' && /^\d+$/.test(result.source_message_index)) {
                result.source_message_index = Number(result.source_message_index); note(path, '来源编号转为整数');
            }
            if (result.source_message_index == null) {
                const matches = [...historical].filter(([,s]) => s.includes(f.evidence));
                if (matches.length === 1) { result.source_message_index = matches[0][0]; note(path, '由唯一引文匹配恢复历史来源编号'); }
            }
            origin = historical.get(result.source_message_index);
        }
        if (options.latestStory !== undefined && (!origin || !origin.includes(f.evidence))) {
            note(path, '原文来源未核实的可选事实留空'); return null;
        }
        return result;
    };
    const claimed = f => f != null && !(typeof f === 'string' && unknown(f))
        && (!object(f) || Object.values(f).some(v=>v!=null && (typeof v!=='string'||!unknown(v))));
    const scene = (s, path, persistent = false, history = false) => {
        const result={...Object.fromEntries(['location','time_of_day','weather','lighting'].map(k => [k,verified(s?.[k], `${path}.${k}`, history)])),
            scene_continues:bool(s?.scene_continues, `${path}.scene_continues`),
            ...(persistent ? {persistent_continues:bool(s?.persistent_continues, `${path}.persistent_continues`)} : {})};
        // A rejected claimed change is unknown, not proof that the old scene still holds.
        if (['location','time_of_day','weather','lighting'].some(k=>claimed(s?.[k]) && result[k]===null)) {
            result.scene_continues=null; note(path, '可选场景事实未核实，本轮环境继承留空');
        }
        return result;
    };
    const updates = (items, path, history = false) => {
        const result = list(items).map((u,i) => {
            const p = `${path}.${i}`;
            if (!object(u) || !text(u.character) || !['clothing','props'].includes(u.category) || !text(u.key)) {
                if (claimed(u)) invalidUpdates.add(path);
                note(p, '缺少身份或状态键的可选更新略过'); return null;
            }
            const f = verified(u, p, history);
            if (!f) invalidUpdates.add(path);
            return f ? {...f, character:u.character.trim(), key:u.key.trim()} : null;
        }).filter(Boolean);
        const grouped = new Map();
        for (const u of result) {
            const id = `${u.character.toLowerCase()}|${u.category}|${u.key.toLowerCase()}`;
            if (!grouped.has(id)) grouped.set(id, []); grouped.get(id).push(u);
        }
        return [...grouped.values()].flatMap(group => {
            if (group.every(u => u.value === group[0].value)) return [group[0]];
            invalidUpdates.add(path); note(path, '互相冲突的同键可选更新略过，保留未知'); return [];
        });
    };
    if (stage === 1) {
        value.moment = describe(value.moment, 'moment') || '';
        value.actions = list(value.actions).map((a,i) => {
            if (!object(a)) { note(`actions.${i}`, '无有效人物的占位记录略过'); return null; }
            const character = text(a.character || a.actor || a.name || a.character_name);
            const action = describe(a.action ?? a.description, `actions.${i}.action`);
            if (!character || !action) { note(`actions.${i}`, '缺少人物或动作的占位记录略过'); return null; }
            return {character, action, ...Object.fromEntries(['expression','gaze','contact'].map(k => [k,describe(a[k], `actions.${i}.${k}`)]))};
        }).filter(Boolean);
        value.scene_state = scene(value.scene_state, 'scene_state');
        value.narrative_end_state = scene(value.narrative_end_state, 'narrative_end_state', true);
        value.persistent_continues = bool(value.persistent_continues, 'persistent_continues');
        value.explicit_changes = Object.fromEntries(['clothing','environment','props'].map(k => [k,strings(value.explicit_changes?.[k], `explicit_changes.${k}`)]));
        value.thoughts = list(value.thoughts).map((t,i) => {
            if (!object(t) || !text(t.character) || !text(t.content)) { note(`thoughts.${i}`, '无有效心理内容的占位记录略过'); return null; }
            if (options.latestStory !== undefined && (!text(t.evidence) || !source.includes(t.evidence))) {
                note(`thoughts.${i}`, '缺少原文依据的心理内容略过'); return null;
            }
            const emotion = text(t.emotion), emotionEvidence = text(t.emotion_evidence);
            const emotional = emotion && !/^(?:null|none|neutral|无|未知|中性)$/i.test(emotion)
                && emotionEvidence && text(t.evidence).includes(emotionEvidence)
                && (options.latestStory === undefined || source.includes(emotionEvidence));
            if ((emotion || emotionEvidence) && !emotional) note(`thoughts.${i}.emotion`, '缺少独立内心情绪依据，仅保留想法，不添加气泡');
            return {character:t.character.trim(), content:t.content.trim(), evidence:t.evidence,
                emotion:emotional ? emotion : null, emotion_evidence:emotional ? emotionEvidence : null};
        }).filter(Boolean);
        value.persistent_updates = updates(value.persistent_updates, 'persistent_updates');
        value.narrative_end_updates = updates(value.narrative_end_updates, 'narrative_end_updates');
        value.continuity_state = historical.size ? scene(value.continuity_state, 'continuity_state', true, true) : null;
        value.continuity_updates = updates(value.continuity_updates, 'continuity_updates', true);
        for (const [path, state] of [['persistent_updates',value], ['narrative_end_updates',value.narrative_end_state], ['continuity_updates',value.continuity_state]]) {
            if (invalidUpdates.has(path) && state) { state.persistent_continues=null; note(path, '可选持续状态未核实，本轮持续继承留空'); }
        }
        value.uncertainties = strings(value.uncertainties, 'uncertainties');
    }
    if (stage === 2) {
        const aliasEntries=Array.isArray(value.aliases)
            ? value.aliases.filter(object).map(a=>[a.alias || a.from, a.canonical_name || a.to || a.name])
            : object(value.aliases) ? Object.entries(value.aliases) : [];
        value.aliases = Object.fromEntries(aliasEntries.filter(([a,b]) => text(a) && text(b) && a.trim() !== b.trim()).map(([a,b]) => [a.trim(),b.trim()]));
        const canonical = name => {
            let n = text(name); const seen = new Set();
            while (value.aliases[n] && !seen.has(n)) { seen.add(n); n=value.aliases[n]; }
            return n;
        };
        const actionNames = new Set((options.sceneFacts?.actions || []).map(a => canonical(a.character).toLowerCase()));
        const excluded = [];
        const seen = new Set();
        const people = new Map();
        value.visible_characters = list(value.visible_characters).map((p,i) => {
            const name = canonical(typeof p === 'string' ? p : p?.canonical_name || p?.name || p?.character);
            if (!name) { note(`visible_characters.${i}`, '无姓名的占位演员略过'); return null; }
            const id=name.toLowerCase();
            if (seen.has(id)) {
                const scope=describe(p?.visible_scope, `visible_characters.${i}.visible_scope`), prior=people.get(id);
                if (scope && !prior.visible_scope) prior.visible_scope=scope;
                note(`visible_characters.${i}`, '合并同一身份的重复演员并保留明确入镜范围'); return null;
            }
            let evidence=text(p?.presence_evidence || p?.evidence);
            if (options.latestStory !== undefined && (!evidence || !source.includes(evidence))) {
                const anchor=options.momentEvidence;
                const spellings=[name,...Object.keys(value.aliases).filter(a=>canonical(a).toLowerCase()===id)];
                if (actionNames.has(id) && text(anchor) && source.includes(anchor) && spellings.some(n=>anchor.includes(n))) {
                    evidence=anchor; note(`visible_characters.${i}`, '使用既有动作身份和选帧引文补齐演员格式');
                } else {
                    excluded.push(name); note(`visible_characters.${i}`, '缺少可核实的身体依据，列为不入镜人物'); return null;
                }
            }
            seen.add(id);
            const person={canonical_name:name, presence_evidence:evidence || null, visible_scope:describe(p?.visible_scope, `visible_characters.${i}.visible_scope`)};
            people.set(id,person); return person;
        }).filter(Boolean);
        const nameOf = p => canonical(typeof p === 'string' ? p : p?.canonical_name || p?.name || p?.character);
        value.mentioned_only_characters = [...new Set([...list(value.mentioned_only_characters).map(nameOf),...excluded].filter(n=>n&&!seen.has(n.toLowerCase())))];
        for (const k of ['spatial_relations','action_ownership']) value[k]=strings(value[k], k);
        value.psychological_reactions = normalizePsychologicalReactions(value.psychological_reactions, value, options, note);
        if (!value.psychological_reactions.length) value.spatial_relations = value.spatial_relations.filter(s=> !/思考泡|Q版|thought[- ]bubble|chibi/i.test(s));
        value.conflicts=list(value.conflicts).map((c,i)=>{
            const d=describe(c, `conflicts.${i}`);
            if (!d) return null;
            let resolved=c?.resolved;
            if (object(c) && typeof resolved!=='boolean' && typeof c.status==='string') {
                if (/^(?:resolved|fixed|corrected|已解决|已纠正)$/i.test(c.status.trim())) resolved=true;
                else if (/^(?:unresolved|pending|未解决)$/i.test(c.status.trim())) resolved=false;
            }
            return typeof resolved==='boolean' ? `${resolved ? '已纠正' : '未解决'}：${d}` : d;
        }).filter(Boolean);
    }
    if (stage === 3) {
        value.edit_instruction = describe(value.edit_instruction, 'edit_instruction') || '';
        if (value.thought_bubble_instruction !== undefined) value.thought_bubble_instruction = describe(value.thought_bubble_instruction, 'thought_bubble_instruction') || '';
        value.preserve = strings(value.preserve, 'preserve').join('; ');
        value.exclude = list(value.exclude).map((e,i)=> {
            if (e?.error || e?.refusal) throw new RpigError('ANALYSIS_REJECTED', `exclude.${i} 返回了拒绝或错误消息`);
            const base=object(e) ? text(e.element || e.value || e.text || e.name || e.canonical_name) : '';
            const scope=object(e) ? describe(e.scope ?? e.visible_scope, `exclude.${i}.scope`) : '';
            return base ? `${base}${scope ? ` (${scope})` : ''}` : describe(e, `exclude.${i}`);
        }).filter(Boolean);
    }
    const uncertaintyNotes = notes.filter(n=>/略过|留空|未核实|缺少/.test(n.operation)).map(n=>`${n.path}：${n.operation}`);
    if (stage === 1) value.uncertainties.push(...uncertaintyNotes);
    if (stage === 2) value.conflicts.push(...uncertaintyNotes.map(n=>`已纠正：${n}`));
    if (notes.length) options.onNormalization?.(notes);
    return value;
}
