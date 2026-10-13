import { RpigError } from './utils.js';
import { isLocalQwen } from './qwen.js';
import { getComfyPreset } from './comfy-presets.js';

const role = ref => ref?.role || ref?.kind;
const owner = ref => ref?.identityId || ref?.identityName || '';

export function referenceBudgetFor(settings = {}) {
    if (settings.backend === 'comfyui') {
        const preset = getComfyPreset(settings);
        return { maxReferences: preset.id === 'custom' ? 1 : preset.maxRefs,
            mode: preset.id === 'sd-text' ? 'text' : 'reference',
            ...(preset.id === 'sd-cast' ? { primaryOnly: true } : {}) };
    }
    if (settings.backend === 'sd' || settings.backend === 'tavern-sd') return { maxReferences: 1, mode: 'reference' };
    if (isLocalQwen(settings)) {
        const limit = Number(settings.qwenReferenceLimit);
        return { maxReferences: Number.isInteger(limit) && limit >= 1 && limit <= 8 ? limit : 3, mode: 'reference' };
    }
    return { maxReferences: null, mode: 'reference' };
}

// The AI chooses the verified cast in stage 2. This planner never invents,
// merges or drops one of those identities to fit the image backend.
export function buildReferencePlan(refs = [], { maxReferences = null, mode = 'reference', shotMode = 'snapshot', policy = 'auto', primaryOnly = false } = {}) {
    if (!Array.isArray(refs)) throw new RpigError('REFERENCE_PLAN_INVALID', '参考图列表格式无效');
    if (mode === 'text') {
        return { refs: [], omitted: refs.map(ref => ({ ref, reason: '当前选择为纯文字 / LoRA 生图' })), assignments: [], maxReferences: 0 };
    }
    const limit = maxReferences === null ? Infinity : maxReferences;
    if (!(limit === Infinity || (Number.isInteger(limit) && limit >= 1))) {
        throw new RpigError('REFERENCE_PLAN_INVALID', '参考图容量配置无效');
    }
    if (refs.some(ref => !ref || typeof ref !== 'object')) throw new RpigError('REFERENCE_PLAN_INVALID', '参考图记录无效');
    const assignments = selected => selected.map((ref, index) => ({ referenceIndex: index + 1,
        identityId: ref.identityId || null, identityName: ref.identityName || null, role: role(ref) || 'reference',
        label: ref.label || '', refId: ref.refId || null, annotation: ref.annotation || null }));
    if ((limit === Infinity || policy === 'all') && !primaryOnly) {
        if (refs.length > limit) throw new RpigError('REFERENCE_BUDGET_EXCEEDED', `已选择发送全部参考图（${refs.length} 张），当前容量为 ${limit} 张。请切换自动选图或减少辅助视图。`);
        return { refs: [...refs], omitted: [], assignments: assignments(refs), maxReferences };
    }
    const primaryOwners = new Set();
    const primary = [], extras = [];
    for (const ref of refs) {
        if (!ref || typeof ref !== 'object') throw new RpigError('REFERENCE_PLAN_INVALID', '参考图记录无效');
        const identity = owner(ref);
        if (role(ref) === 'identity-primary' && identity && !primaryOwners.has(identity)) {
            primaryOwners.add(identity);
            primary.push(ref);
        } else extras.push(ref);
    }
    if (primary.length > limit) throw new RpigError('REFERENCE_BUDGET_EXCEEDED',
        `本张图需要 ${primary.length} 个独立人物的主身份图，当前后端最多接收 ${limit} 张参考图。请使用容量更高的后端或明确选择较少人物的镜头；没有自动少画人。`);
    if (primaryOnly) return { refs: primary, omitted: extras.map(ref => ({ref,
        reason:'多人排布只使用每位人物的一张主图，辅助视图不会变成额外身体'})),
        assignments: assignments(primary), maxReferences };
    // Metadata helps choose auxiliaries; a second view can never displace another person's primary.
    const score = ref => role(ref) === 'continuity' ? 2
        : /face_crop|脸部特写|face detail/i.test(ref.viewType || ref.label || '') ? (shotMode === 'portrait' ? 3 : 1)
        : /full_body|全身|three_views|三视/i.test(ref.viewType || ref.label || '') ? 1 : 0;
    const ordered = extras.map((ref, index) => ({ ref, index })).sort((a, b) => score(b.ref) - score(a.ref) || a.index - b.index);
    const selected = [...primary];
    const omitted = [];
    const auxiliaryOwners = new Set();
    for (const { ref } of ordered) {
        const identity = owner(ref);
        // A duplicate primary or extra costume view of the same actor has lower priority.
        const duplicatePrimary = role(ref) === 'identity-primary' && primaryOwners.has(identity);
        const repeatedAuxiliary = identity && auxiliaryOwners.has(identity);
        if (selected.length >= limit || duplicatePrimary || repeatedAuxiliary) {
            omitted.push({ ref, reason: duplicatePrimary ? '同一人物已有主身份图' : '保留入镜人物主图后，辅助图未占用本次有限槽位' });
            continue;
        }
        selected.push(ref);
        if (identity) auxiliaryOwners.add(identity);
    }
    return { refs: selected, omitted, maxReferences, assignments: assignments(selected) };
}

export function normalizeReferenceAnnotation(value) {
    if (!value || typeof value !== 'object' || value.version !== 1) return undefined;
    const bounds = value.bounds;
    if (!bounds || ['x', 'y', 'width', 'height'].some(key => typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key]))) return undefined;
    if (bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0 || bounds.x + bounds.width > 1.000001 || bounds.y + bounds.height > 1.000001) return undefined;
    if (![value.sourceWidth, value.sourceHeight].every(size => Number.isInteger(size) && size > 0 && size <= 40000)) return undefined;
    return { version: 1, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        sourceWidth: value.sourceWidth, sourceHeight: value.sourceHeight,
        ...(typeof value.sourceRefId === 'string' && /^[\w.-]{1,256}$/.test(value.sourceRefId) ? { sourceRefId: value.sourceRefId } : {}) };
}

export function referenceCastGuidance(budget) {
    const limit = budget?.maxReferences;
    if (budget?.mode === 'text' || !Number.isInteger(limit) || limit < 1) return '';
    return `\n\n【本次图片后端参考图容量】最多 ${limit} 张，每个独立入镜身份至少需要一张主图。先根据所选瞬间判断真实主体和直接互动者；未明确要求全员或固定人数时，可选择表达同一事件的合理焦点镜头，不为群聊成员或仅被提及者补身体。不能为凑容量隐去明确要求入镜的人、关键互动肢体或真实动作主体；正文或镜头要求明确全员时保留完整名单，容量不足交由程序明确提示。别名、译名、照片和倒影不增加独立身份数量。`;
}
