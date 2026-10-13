import { getCharacterIdentifier, MAX_REFS_PER_CHAR } from './gallery.js';
import { normalizeReferenceAnnotation } from './reference-plan.js';
import { clampCropBounds } from './reference-annotation.js';
import { createAbortError, dataUrlToBlob, throwIfAborted, RpigError } from './utils.js';

const invalid = message => new RpigError('REFERENCE_ANNOTATION_INVALID', message);
const sourceMissing = () => new RpigError('REFERENCE_ANNOTATION_SOURCE_CHANGED', '原参考图已被移除，请刷新图库后重新标注');
const MAX_CROP_DATA_LENGTH = 32 * 1024 * 1024;

function guard(signal, isCurrent) {
    throwIfAborted(signal);
    if (isCurrent && !isCurrent()) throw createAbortError('参考图或会话已更改，已停止另存');
}

function findSource(views, source) {
    if (!Array.isArray(views)) throw sourceMissing();
    if (typeof source.refId === 'string' && source.refId) return views.find(view => view.refId === source.refId);
    const url = source.url || source.dataUrl;
    if (typeof url !== 'string' || !url) throw sourceMissing();
    return views.find(view => (view.url || view.dataUrl) === url && (view.label || '') === (source.label || ''));
}

/**
 * Append one crop without writing a stale gallery snapshot. Cross-owner source
 * presence is checked before the target transaction; same-owner presence is
 * checked again inside that transaction. The host storage API owns commit.
 */
export async function saveAnnotatedReference(result, {
    sourceCharacter, sourceView, targets, getCharacterRefs, updateCharacterRefs,
    signal, isCurrent, maxRefs = MAX_REFS_PER_CHAR,
} = {}) {
    guard(signal, isCurrent);
    if (!result || typeof result !== 'object' || !sourceView || typeof sourceView !== 'object'
        || typeof getCharacterRefs !== 'function' || typeof updateCharacterRefs !== 'function') {
        throw invalid('标注保存参数无效，请重新打开标注');
    }
    if (!((typeof result.targetId === 'string' && result.targetId.trim())
        || (typeof result.targetId === 'number' && Number.isFinite(result.targetId)))) throw invalid('目标人物标识无效');
    // Capture all identity selectors before the first await. Live dropdowns or
    // mutated card objects must never redirect an already started operation.
    const capturedTargets = (Array.isArray(targets) ? targets : []).map(target => ({
        id: target?.id,
        character: target?.character && typeof target.character === 'object' ? { ...target.character } : target?.character,
    }));
    const matches = capturedTargets.filter(target => target.id === result.targetId);
    if (matches.length !== 1) throw invalid('目标人物不属于本次打开时的角色列表');
    const targetCharacter = matches[0].character;
    const targetKey = getCharacterIdentifier(targetCharacter), sourceKey = getCharacterIdentifier(sourceCharacter);
    if (targetKey === 'default' || sourceKey === 'default') throw invalid('原图或目标人物身份无效');
    const capturedSource = { refId: sourceView.refId, url: sourceView.url, dataUrl: sourceView.dataUrl, label: sourceView.label };
    if (!Number.isInteger(maxRefs) || maxRefs < 1) throw invalid('参考图数量上限无效');
    const limit = Math.min(maxRefs, MAX_REFS_PER_CHAR);
    const annotation = normalizeReferenceAnnotation(result.annotation);
    if (!annotation) throw invalid('标注范围无效，请重新框选');
    annotation.bounds = clampCropBounds(annotation.bounds, annotation.sourceWidth, annotation.sourceHeight);
    if (annotation.sourceRefId && capturedSource.refId && annotation.sourceRefId !== capturedSource.refId) {
        throw invalid('标注原图身份不一致，请重新打开标注');
    }
    const dataUrl = result.dataUrl;
    if (typeof dataUrl !== 'string' || dataUrl.length > MAX_CROP_DATA_LENGTH
        || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) throw invalid('裁切图片数据无效或过大');
    try { if (!dataUrlToBlob(dataUrl).size) throw new Error('empty'); }
    catch { throw invalid('裁切图片数据无效'); }
    if (!['single', 'full_body', 'face_crop'].includes(result.viewType) || typeof result.isPrimaryIdentity !== 'boolean') {
        throw invalid('参考图类型或主图设置无效');
    }
    const candidate = {
        dataUrl, label: (typeof result.label === 'string' ? result.label.trim() : '').slice(0, 160) || '标注参考图',
        viewType: result.viewType, isPrimaryIdentity: result.isPrimaryIdentity, enabled: true, annotation,
    };
    guard(signal, isCurrent);
    const sources = await getCharacterRefs(sourceKey);
    guard(signal, isCurrent);
    const actualSource = findSource(sources, capturedSource);
    if (!actualSource) throw sourceMissing();
    if (typeof actualSource.refId === 'string' && /^[\w.-]{1,256}$/.test(actualSource.refId)) annotation.sourceRefId = actualSource.refId;
    guard(signal, isCurrent);
    const written = await updateCharacterRefs(targetKey, current => {
        guard(signal, isCurrent);
        if (!Array.isArray(current)) throw invalid('目标参考图库格式无效');
        if (sourceKey === targetKey && !findSource(current, capturedSource)) throw sourceMissing();
        if (current.length >= limit) throw new RpigError('REFERENCE_ANNOTATION_LIMIT', `另存后会超过 ${limit} 张参考图上限，请先整理目标图库`);
        const previous = candidate.isPrimaryIdentity ? current.map(view => ({ ...view, isPrimaryIdentity: false })) : current;
        guard(signal, isCurrent);
        return [...previous, candidate];
    });
    guard(signal, isCurrent);
    const ref = Array.isArray(written) ? written.at(-1) : null;
    if (!ref || ref.dataUrl !== candidate.dataUrl) throw new RpigError('REFERENCE_ANNOTATION_SAVE_FAILED', '裁切参考图未返回保存结果，请刷新目标图库确认');
    return { targetCharacter, ref };
}
