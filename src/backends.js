import { assertUsableInstruction } from './analysis-validation.js';
import { isLocalQwen, qwenSteps, qwenSize, qwenReferenceEditPrompt, qwenIdentityRenderSettings, qwenSceneRenderPlan, selectQwenStoryReferences, qwenDetailEditPrompt } from './qwen.js';
import { mirrorLayoutPlan, mirrorLayoutReference } from './mirror-layout.js';
import { resizeSceneOutput } from './scene-output.js';
import { supportedPosePlan, supportedPoseReference } from './pose-layout.js';
// ============================================================
// RP 电影配图 - 图片后端模块
// ============================================================

import {
    normalizeBackendUrl,
    scrubSensitiveText,
    dataUrlToBlob,
    fetchToDataUrl,
    combineAbortSignals,
    isAbortError,
    raceWithAbort,
    sleep,
    throwIfAborted,
    timeoutSignal,
    RpigError,
    requestFailure,
    upstreamErrorMessage,
} from './utils.js';
import { DEFAULT_SD_NEGATIVE, preparePromptForBackend, referenceImageEditPrompt } from './prompts.js';

export const BACKENDS = {
    OPENAI: 'openai',      // OpenAI 兼容 images API（gpt-image / 国产兼容）
    GEMINI: 'gemini',      // Google Gemini 图像模型
    SD: 'sd',              // 本地 Stable Diffusion WebUI
    COMFYUI: 'comfyui',    // 本地 ComfyUI
    TAVERN_SD: 'tavern-sd',// 酒馆内置 sd 命令
};

// 画幅比例映射
export const SIZE_MAP = {
    '16:9':   { openai: '1536x1024', gemini: '16:9',  sd: [1344, 768] },
    '2.39:1': { openai: '1536x1024', gemini: '16:9',  sd: [1536, 640] },
    '1:1':    { openai: '1024x1024', gemini: '1:1',   sd: [1024, 1024] },
    '9:16':   { openai: '1024x1536', gemini: '9:16',  sd: [768, 1344] },
};

// Only the dedicated region-edit entry point can override the ordinary Qwen
// story size. This is a request-local value, never a saved resolution preset.
const LOCAL_DETAIL_PATCH_SIZE = Symbol('local-detail-patch-size');
const LOCAL_SCENE_RENDER_PLAN = Symbol('local-scene-render-plan');
function localDetailPatchSize(value) {
    const size = value === undefined ? [256, 256] : value;
    if (!Array.isArray(size) || size.length !== 2 || size.some(n => !Number.isInteger(n) || n < 256 || n > 512 || n % 32 !== 0)) {
        throw new RpigError('DETAIL_PATCH_SIZE_INVALID', '选区编辑尺寸须为两个 256–512 之间且为 32 倍数的整数');
    }
    return [...size];
}

function isGeminiImageModel(model) { return /(?:^|\/)gemini-[\w.-]*image[\w.-]*$/i.test(model || ''); }

async function declaredGeminiProtocol(settings, options) {
    const base = normalizeBackendUrl(settings.backendUrl);
    try {
        const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${settings.backendKey || ''}` },
            signal: combineAbortSignals(options.signal, timeoutSignal(15000)) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const models = await response.json();
        const types = models?.data?.find(model => model.id === settings.backendModel)?.supported_endpoint_types || [];
        if (types.includes('gemini')) return 'gemini';
        if (types.includes('openai')) return 'chat';
    } catch (error) {
        if (isAbortError(error)) throw error;
        options.onWarning?.(`无法读取模型支持的协议，继续检查 Images 接口：${scrubSensitiveText(error.message, [settings.backendKey])}`);
    }
    return 'images';
}

export function extractChatImage(data) {
    const message = data?.choices?.[0]?.message;
    const entries = [...(Array.isArray(message?.images) ? message.images : []), ...(Array.isArray(message?.content) ? message.content : [])];
    for (const entry of entries) {
        const url = entry?.image_url?.url || (typeof entry?.image_url === 'string' ? entry.image_url : null);
        if (typeof url === 'string' && /^(data:image\/[\w.+-]+;base64,|https?:\/\/)/i.test(url)) return url;
    }
    const text = typeof message?.content === 'string' ? message.content : entries.map(p => p.text || '').join('\n');
    const embedded = text.match(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/]+={0,2}/i)?.[0];
    if (embedded) return embedded;
    return text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i)?.[1] || null;
}

export async function generateOpenAIChatImage(settings, prompt, aspectRatio, refs, options = {}) {
    const base = normalizeBackendUrl(settings.backendUrl);
    const model = settings.backendModel.trim();
    const key = (settings.backendKey || '').trim();
    const identityNames = [...new Set((refs || []).filter(ref => ref?.kind !== 'continuity' && ref?.identityName).map(ref => String(ref.identityName).trim()).filter(Boolean))];
    const content = [{ type: 'text', text: `${prompt}\nOutput an image, aspect ratio ${aspectRatio || '16:9'}. Reference 1 controls visual style and its named character identity.${identityNames.length > 1 ? ' Different identity names are different cast members; keep every named face separate and never merge or swap them.' : ''}` }];
    for (const ref of refs || []) {
        if (!ref?.dataUrl) throw new RpigError('REFERENCE_MISSING', 'Chat 图片请求缺少参考图数据，已停止');
        const subject = ref.identityName ? ` for ${ref.identityName}` : '';
        content.push({ type: 'text', text: ref.kind === 'continuity'
            ? 'This reference only guides unchanged clothing and props; it must not override an identity reference or the first image style.'
            : `Identity reference${subject}. Multiple references with this same identity name show the same person; a different identity name means a different cast member. Preserve this face and do not create an extra copy.` });
        content.push({ type: 'image_url', image_url: { url: ref.dataUrl } });
    }
    const url = `${base}/chat/completions`;
    let response;
    try {
        response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({ model, stream: false, modalities: ['text', 'image'], messages: [{ role: 'user', content }] }),
            signal: combineAbortSignals(options.signal, timeoutSignal(300000)) });
    } catch (error) { throw requestFailure(error, url, 'Chat 格式图片生成失败', [key]); }
    if (!response.ok) throw new RpigError('CHAT_IMAGE_HTTP', `Chat 图片 HTTP ${response.status}: ${upstreamErrorMessage(await response.text(), [key])}`, { status: response.status });
    const data = await response.json();
    const image = extractChatImage(data);
    if (!image) throw new RpigError('CHAT_IMAGE_EMPTY', 'Chat 图片接口没有返回图片；未把纯文本当作图片，也未丢弃参考图重试');
    return { ...(image.startsWith('data:') ? { dataUrl: image } : { imageUrl: image }), model, usedRefs: Boolean(refs?.length) };
}

/**
 * 统一将持久化参考图（url）在内存中水合为 dataUrl 供后端 API 使用
 * @param {Array} refs 
 * @param {Function} [fetchFn] 
 * @param {number} [maxRefs] 
 * @returns {Promise<Array>}
 */
async function computeDataUrlHash(dataUrl) {
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export async function hydrateReferenceImages(refs, fetchFn = fetchToDataUrl, maxRefs = 5, signal, diagnostics = null, onWarning = null) {
    if (!Array.isArray(refs) || refs.length === 0) return [];
    const hydrated = [];
    const seenDataUrlMap = new Map();

    for (const ref of refs) {
        throwIfAborted(signal);
        if (!ref) throw new RpigError('REFERENCE_MISSING', '参考图记录为空，已停止，未跳过身份资料');

        let dataUrl = ref.dataUrl;
        if (!dataUrl && ref.url) {
            try {
                if (typeof fetchFn === 'function') {
                    dataUrl = await fetchFn(ref.url, { signal });
                }
            } catch (err) {
                if (isAbortError(err)) throw err;
                console.warn("[RP] Reference fetch failed:", ref.url, err);
                // 用户明确指定的主图读取失败时，停止本次生成并提示修复，不能静默替换
                if (ref.isExplicitPrimary || (ref.role || ref.kind) === 'identity-primary') {
                    diagnostics?.referenceFailures?.push({ ref: ref.label || ref.url, reason: err.message });
                    throw new RpigError('PRIMARY_REFERENCE_READ_FAILED',
                        `用户明确指定的主身份参考图读取失败 [${ref.label || ref.url}]，已停止本次生成以避免换脸。请检查网络、图片地址或在参考图库中重新指定。`,
                        { originalError: err });
                }
                if (diagnostics && Array.isArray(diagnostics.referenceFailures)) {
                    diagnostics.referenceFailures.push({ ref: ref.label || ref.url, reason: err.message });
                }
                throw new RpigError('REFERENCE_DOWNLOAD_FAILED', `辅助参考图读取失败 [${ref.label || ref.url}]，请修复或在图库中明确移除后重试`);
            }
        }

        if (typeof dataUrl !== 'string' || !/^data:image\/[\w.+-]+;base64,\S+$/i.test(dataUrl)) {
            if (ref.isExplicitPrimary || (ref.role || ref.kind) === 'identity-primary') {
                diagnostics?.referenceFailures?.push({ ref: ref.label || ref.url, reason: 'Invalid dataUrl' });
                throw new RpigError('PRIMARY_REFERENCE_READ_FAILED',
                    `用户明确指定的主身份参考图数据无效 [${ref.label || ref.url || '未知'}]，已停止本次生成以避免换脸。`);
            }
            console.warn("[RP] Reference invalid, skipping:", ref.url || ref.label);
            if (diagnostics && Array.isArray(diagnostics.referenceFailures)) {
                diagnostics.referenceFailures.push({ ref: ref.label || ref.url, reason: 'Invalid dataUrl' });
            }
            throw new RpigError('REFERENCE_INVALID', `参考图数据无效 [${ref.label || ref.url || '未知'}]，已停止，未静默丢图`);
        }

        // 处理去重及跨身份冲突检查
        if (seenDataUrlMap.has(dataUrl)) {
            const existingRef = seenDataUrlMap.get(dataUrl);
            if (existingRef.identityId && ref.identityId && existingRef.identityId !== ref.identityId) {
                const conflictMsg = `参考图身份冲突：同一张图片被同时赋给了 [${existingRef.identityName || existingRef.identityId}] 和 [${ref.identityName || ref.identityId}]！建议在参考图库中为不同角色分别指定专属立绘。`;
                console.warn(`[RP-Diag] ${conflictMsg}`);
                if (diagnostics && Array.isArray(diagnostics.conflicts)) {
                    diagnostics.conflicts.push(conflictMsg);
                }
                if (typeof onWarning === 'function') onWarning(conflictMsg);
                throw new RpigError('REFERENCE_IDENTITY_CONFLICT', conflictMsg);
            } else {
                console.info(`[RP-Diag] 同一人物的重复参考图已去重: ${ref.label || ref.identityName}`);
            }
            // Only same-identity duplicates are safe to remove.
            continue;
        }

        if (hydrated.length >= maxRefs) {
            throw new RpigError('REFERENCE_LIMIT', `参考图超过当前允许的 ${maxRefs} 张，已停止；未截断参考图。`);
        }

        seenDataUrlMap.set(dataUrl, ref);
        hydrated.push({
            ...ref,
            dataUrl: dataUrl,
        });
    }

    // 确定最终图片顺序：主身份图优先（按 character -> user），随后是辅助图
    hydrated.sort((a, b) => {
        const aIsPrimary = a.role === 'identity-primary' || a.kind === 'identity-primary';
        const bIsPrimary = b.role === 'identity-primary' || b.kind === 'identity-primary';
        if (aIsPrimary && !bIsPrimary) return -1;
        if (!aIsPrimary && bIsPrimary) return 1;
        return 0;
    });

    // 按最终顺序生成编号和身份映射，并计算哈希
    for (const [index, ref] of hydrated.entries()) {
        ref.referenceIndex = index + 1;
        ref.hash = await computeDataUrlHash(ref.dataUrl);
    }

    // 将最终经过读取、去重与编号的参考图同步回全链路诊断
    if (diagnostics) {
        diagnostics.referenceCount = hydrated.length;
        diagnostics.references = hydrated.map(r => ({
            referenceIndex: r.referenceIndex,
            role: r.role || r.kind,
            source: r.source,
            identityId: r.identityId,
            identityName: r.identityName,
            label: r.label,
            hash: r.hash,
            dataLength: r.dataUrl ? r.dataUrl.length : 0,
        }));
    }

    return hydrated;
}
export async function generateImage(settings, prompt, avoid, refs, options = {}) {
    assertUsableInstruction(prompt);
    const s = settings || {};
    const size = SIZE_MAP[s.imageSize] || SIZE_MAP['16:9'];
    const onWarning = options.onWarning || (() => {});
    const fetchFn = options.fetchToDataUrl || fetchToDataUrl;

    throwIfAborted(options.signal);
    if (s.stylePreset === 'reference') {
        if (!refs?.length || refs.every(ref => ref.kind === 'continuity')) {
            throw new RpigError('IDENTITY_REFERENCE_REQUIRED', '参考图驱动需要该入镜人物的身份参考图；未找到原图，已停止以避免重新设计人物');
        }
        if (![BACKENDS.OPENAI, BACKENDS.GEMINI, BACKENDS.SD].includes(s.backend || BACKENDS.OPENAI)) throw new RpigError('REFERENCE_BACKEND_UNSUPPORTED', '参考图驱动模式请使用 OpenAI 兼容图片接口、Gemini 或 SD img2img；当前后端未验证图片编辑能力，已停止。');
    }
    const selectedRefs = isLocalQwen(s) ? selectQwenStoryReferences(refs, s) : refs;
    if (options.diagnostics && isLocalQwen(s)) options.diagnostics.referenceSelection = {
        policy:s.qwenReferencePolicy || 'story', supplied:refs?.length || 0, sent:selectedRefs?.length || 0,
        omitted:(refs || []).filter(r => !selectedRefs.includes(r)).map(r => ({identityName:r.identityName, label:r.label, reason:'supporting costume view omitted from story request'})),
    };
    const hydratedRefs = await hydrateReferenceImages(selectedRefs, fetchFn, selectedRefs?.length || 0, options.signal, options.diagnostics, onWarning);
    if (s.stylePreset === 'reference' && !hydratedRefs.some(ref => (ref.role || ref.kind) === 'identity-primary')) {
        throw new RpigError('IDENTITY_REFERENCE_REQUIRED', '身份主图未成功读取，已停止生图');
    }
    if (!isLocalQwen(s) && hydratedRefs.length > 1 && [BACKENDS.SD, BACKENDS.COMFYUI, BACKENDS.TAVERN_SD].includes(s.backend)) {
        throw new RpigError('MULTI_REFERENCE_UNSUPPORTED', '当前后端尚未实现同时使用多张参考图，已停止，未只取第一张。请使用支持多图的 OpenAI 兼容图片接口或 Gemini，或自行保留一张参考图。');
    }
    const prepared = preparePromptForBackend(s, prompt, avoid, options);
    const sceneRenderPlan = isLocalQwen(s) && s.stylePreset === 'reference' ? qwenSceneRenderPlan(s,hydratedRefs,s.imageSize || '16:9',prepared.prompt) : null;
    const supportedPose = sceneRenderPlan ? supportedPosePlan(prepared.prompt,hydratedRefs,s) : null;
    if(supportedPose){
        const layout=supportedPoseReference(supportedPose,...sceneRenderPlan.renderSize);
        layout.referenceIndex=hydratedRefs.length+1;layout.hash=await computeDataUrlHash(layout.dataUrl);hydratedRefs.push(layout);
        if(options.diagnostics){
            options.diagnostics.poseGeometry={kind:supportedPose.kind,identityNames:supportedPose.identityNames,hand:supportedPose.hand,
                referenceIndex:layout.referenceIndex,projectedPeople:layout.projectedPeople};
            options.diagnostics.referenceCount=hydratedRefs.length;options.diagnostics.referenceSelection.sent=hydratedRefs.length;
            options.diagnostics.referenceSelection.generated=1;
            options.diagnostics.references.push({referenceIndex:layout.referenceIndex,role:layout.role,source:layout.source,label:layout.label,hash:layout.hash});
        }
    }
    if (isLocalQwen(s) && s.stylePreset === 'reference') {
        const plan = mirrorLayoutPlan(prepared.prompt, hydratedRefs, s);
        if (plan) {
            const [width,height] = sceneRenderPlan?.renderSize || qwenSize(s);
            const layout = mirrorLayoutReference(plan,width,height);
            layout.referenceIndex = hydratedRefs.length + 1;
            layout.hash = await computeDataUrlHash(layout.dataUrl);
            hydratedRefs.push(layout);
            if (options.diagnostics) {
                options.diagnostics.mirrorGeometry = {kind:plan.kind,hand:plan.hand,cameraSide:plan.cameraSide,
                    referenceIndex:hydratedRefs.length,geometryContact:layout.geometryContact,reflectedContact:layout.reflectedContact};
                options.diagnostics.referenceCount = hydratedRefs.length;
                options.diagnostics.referenceSelection.sent = hydratedRefs.length;
                options.diagnostics.referenceSelection.generated = 1;
                options.diagnostics.references.push({referenceIndex:layout.referenceIndex,role:layout.role,
                    source:layout.source,label:layout.label,hash:layout.hash,dataLength:layout.dataUrl.length});
            }
        }
    }
    if (s.stylePreset === 'reference') prepared.prompt = isLocalQwen(s)
        ? qwenReferenceEditPrompt(prepared.prompt, hydratedRefs, {compactScene:s.qwenSceneDetail === true})
        : referenceImageEditPrompt(prepared.prompt, hydratedRefs);

    let result;
    if (isLocalQwen(s)) {
        result = await generateGeminiImage(s, prepared.prompt, size.gemini, hydratedRefs, {
            ...options, negativePrompt: options.negativePrompt ?? prepared.avoid,
            [LOCAL_SCENE_RENDER_PLAN]:sceneRenderPlan,
        });
    } else switch (s.backend) {
        case BACKENDS.GEMINI:
            result = await generateGeminiImage(s, prepared.prompt, size.gemini, hydratedRefs, {
                ...options,
                negativePrompt: options.negativePrompt ?? prepared.avoid,
            });
            break;
        case BACKENDS.SD:
            result = await generateSDImage(s, prepared.prompt, prepared.avoid, size.sd, hydratedRefs, options);
            break;
        case BACKENDS.COMFYUI:
            result = await generateComfyUIImage(s, prepared.prompt, prepared.avoid, hydratedRefs, options);
            break;
        case BACKENDS.TAVERN_SD:
            result = await generateTavernSD(prepared.prompt, options.slashCommandParser, options);
            break;
        case BACKENDS.OPENAI:
        default:
            if (isGeminiImageModel(s.backendModel)) {
                const protocol = await declaredGeminiProtocol(s, { ...options, onWarning });
                if (protocol === 'chat') {
                    result = await generateOpenAIChatImage(s, prepared.prompt, size.gemini, hydratedRefs, options);
                    break;
                }
                if (protocol === 'gemini') {
                    result = await generateGeminiImage(s, prepared.prompt, size.gemini, hydratedRefs, { ...options, openAICompatibleRelay: true });
                    break;
                }
            }
            try {
                result = await generateOpenAIImage(s, prepared.prompt, size.openai, hydratedRefs, { ...options, onWarning });
            } catch (error) {
                if (error.code !== 'GEMINI_IMAGE_PROTOCOL_MISMATCH') throw error;
                onWarning('上游明确拒绝 Gemini 模型使用 Images API，正在保留原提示词和参考图，改用 Gemini generateContent 接口');
                result = await generateGeminiImage(s, prepared.prompt, size.gemini, hydratedRefs, { ...options, openAICompatibleRelay: true });
            }
            break;
    }

    if (sceneRenderPlan) {
        result.dataUrl = await (options.resizeSceneImage || resizeSceneOutput)(result.dataUrl,sceneRenderPlan,{signal:options.signal});
        result.outputSize=[...sceneRenderPlan.outputSize];
        if (options.diagnostics) options.diagnostics.outputSize=[...sceneRenderPlan.outputSize];
    }
    return {
        ...result,
        usedPrompt: prepared.prompt,
        usedAvoid: prepared.avoid,
    };
}

/** Edit one explicitly selected crop; the caller owns source-image preservation
 * and mask compositing. This never invokes ordinary story analysis or templates. */
export async function generateLocalDetailEdit(settings, instruction, patchDataUrl, options = {}) {
    throwIfAborted(options.signal);
    if (!isLocalQwen(settings)) throw new RpigError('DETAIL_LOCAL_BACKEND_REQUIRED', '选区编辑目前仅支持本地千问桥接');
    assertUsableInstruction(instruction, '选区编辑指令');
    const patchSize = localDetailPatchSize(options.patchSize);
    if (typeof patchDataUrl !== 'string' || !/^data:image\/[\w.+-]+;base64,\S+$/i.test(patchDataUrl)) {
        throw new RpigError('DETAIL_PATCH_REQUIRED', '选区编辑需要当前已成图裁剪的图片数据');
    }
    const requestId = options.requestId || `detail_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const diagnostic = options.diagnostics || {};
    const prompt = qwenDetailEditPrompt(instruction);
    const editSettings = { ...settings, qwenIdentityDetailBoost: false, qwenSteps: 20, qwenCfg: 1,
        imageSize: `${patchSize[0]}:${patchSize[1]}` };
    Object.assign(diagnostic, { requestId, mode: 'local-detail-edit', status: 'running', stage: 'region-edit',
        startedAt: new Date().toISOString(), patchSize: [...patchSize], instruction: instruction.trim(),
        referenceFailures: [], references: [], referenceCount: 1 });
    try {
        const refs = await hydrateReferenceImages([{ dataUrl: patchDataUrl, role: 'edit-target', kind: 'edit-target',
            source: 'selected-region', label: 'Selected region of the finished illustration' }],
            options.fetchToDataUrl || fetchToDataUrl, 1, options.signal, diagnostic, options.onWarning);
        throwIfAborted(options.signal);
        const result = await generateGeminiImage(editSettings, prompt, editSettings.imageSize, refs, {
            ...options, requestId, diagnostics: diagnostic, negativePrompt: '', openAICompatibleRelay: false,
            [LOCAL_DETAIL_PATCH_SIZE]: patchSize,
        });
        throwIfAborted(options.signal);
        Object.assign(diagnostic, { status: 'success', stage: 'complete' });
        return { ...result, usedPrompt: prompt, usedAvoid: '', requestId, patchSize: [...patchSize], diagnostics: diagnostic };
    } catch (error) {
        Object.assign(diagnostic, { status: isAbortError(error) ? 'cancelled' : 'failed',
            error: scrubSensitiveText(error.message || String(error), [settings.backendKey]), errorCode: error.code || null });
        throw error;
    } finally {
        diagnostic.finishedAt = new Date().toISOString();
    }
}

/**
 * OpenAI 兼容图像生成后端
 */
export async function generateOpenAIImage(settings, prompt, size, refs, options = {}) {
    const base = normalizeBackendUrl(settings.backendUrl);
    const model = (settings.backendModel || 'gpt-image-1').trim();
    const key = (settings.backendKey || '').trim();
    const onWarning = options.onWarning || (() => {});

    const checkProtocolMismatch = (body, status) => {
        if ((status === 400 || status === 500) && /(?:^|\/)gemini-[\w.-]*image[\w.-]*$/i.test(model)
            && /only imagen models are supported/i.test(body) && /not supported model for image generation/i.test(body)) {
            throw new RpigError('GEMINI_IMAGE_PROTOCOL_MISMATCH', `Gemini 图片模型被错误送入仅支持 Imagen 的 Images API：${upstreamErrorMessage(body, [key])}`, { status });
        }
    };

    const headers = {};
    if (key) {
        headers['Authorization'] = `Bearer ${key}`;
    }

    const hasRefs = Array.isArray(refs) && refs.length > 0;

    // 1. 如果有参考图，先尝试 multipart/form-data 的 /images/edits
    if (hasRefs) {
        if (refs.some(ref => !ref?.dataUrl)) throw new RpigError('REFERENCE_MISSING', '参考图尚未读取，不能继续文生图');
        // One request with all selected references, never separate generations.
        const editCandidates = refs.slice(0, 1);
        const shouldUseHighFidelity = options.continuityReference === true && options.sceneChanged !== true;

        for (let refIndex = 0; refIndex < editCandidates.length; refIndex++) {
            const currentRef = editCandidates[refIndex];
            try {
                let blob;
                try { blob = dataUrlToBlob(currentRef.dataUrl); }
                catch (error) { throw new RpigError('REFERENCE_INVALID', `参考图数据无法转换为图片：${error.message}`); }
                const extension = blob.type === 'image/jpeg'
                    ? 'jpg'
                    : blob.type === 'image/webp'
                        ? 'webp'
                        : 'png';
                const buildEditForm = (highFidelity) => {
                const formData = new FormData();
                if (refs.length === 1) formData.append('image', blob, `reference.${extension}`);
                else refs.forEach((ref, index) => {
                    const image = dataUrlToBlob(ref.dataUrl);
                    const ext = image.type === 'image/jpeg' ? 'jpg' : image.type === 'image/webp' ? 'webp' : 'png';
                    formData.append('image[]', image, `reference-${index + 1}.${ext}`);
                });
                formData.append('prompt', prompt);
                formData.append('model', model);
                formData.append('n', '1');
                formData.append('size', size);
                if (highFidelity) formData.append('input_fidelity', 'high');
                return formData;
                };
                const requestEdit = (highFidelity) => fetch(`${base}/images/edits`, {
                    method: 'POST',
                    headers: headers,
                    body: buildEditForm(highFidelity),
                    signal: combineAbortSignals(options.signal, timeoutSignal(300000)),
                });

                // 连续性模式优先请求高输入保真；第三方不识别该字段时自动重试标准 edits。
                let res = await requestEdit(shouldUseHighFidelity);
                if (!res.ok && shouldUseHighFidelity && (res.status === 400 || res.status === 422)) {
                    const detail = await res.clone().text();
                    if (/input_fidelity/i.test(detail)) {
                        onWarning(`兼容接口拒绝 input_fidelity 参数（HTTP ${res.status}）：${scrubSensitiveText(detail, [key]).slice(0, 200)}；正在使用标准图生图模式重试`);
                        res = await requestEdit(false);
                    }
                }

                if (res.ok) {
                    const data = await res.json();
                    const item = data?.data?.[0];
                    if (item?.b64_json) {
                        return { dataUrl: `data:image/png;base64,${item.b64_json}`, model, usedRefs: true };
                    }
                    if (item?.url) {
                        return { imageUrl: item.url, model, usedRefs: true };
                    }
                    throw new RpigError('EDITS_EMPTY_RESPONSE', '参考图接口返回成功但没有图片数据；已停止，未降级为文生图');
                }

                const errStatus = res.status;
                const errBody = await res.text().catch(() => '');
                checkProtocolMismatch(errBody, errStatus);
                const unsupported = errStatus === 405 || errStatus === 501;
                throw new RpigError(unsupported ? 'EDITS_UNSUPPORTED' : errStatus === 404 ? 'EDITS_NOT_FOUND' : 'EDITS_HTTP',
                    `OpenAI Edits HTTP ${errStatus}: ${upstreamErrorMessage(errBody, [key])}。${unsupported ? '接口不接受该编辑方法。' : errStatus === 404 ? '请核对 API 根地址、路由与模型是否支持 edits；404 本身不能证明模型不支持。' : ''}已停止，未降级为文生图`, { status: errStatus });
            } catch (editErr) {
                if (isAbortError(editErr)) throw editErr;
                throw requestFailure(editErr, `${base}/images/edits`, '参考图 edits 请求失败；未降级为文生图', [key]);
            }
        }
    }

    // 2. 纯文本 / 降级生成：POST /images/generations (JSON)
    const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
    const body = {
        model: model,
        prompt: prompt,
        n: 1,
        size: size,
    };

    let res;
    try {
        res = await fetch(`${base}/images/generations`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify(body),
            signal: combineAbortSignals(options.signal, timeoutSignal(300000)),
        });
    } catch (netErr) {
        if (isAbortError(netErr)) throw netErr;
        throw requestFailure(netErr, `${base}/images/generations`, '图片生成请求失败', [key]);
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        checkProtocolMismatch(errText, res.status);
        throw new Error(`图片 API HTTP ${res.status}: ${upstreamErrorMessage(errText, [key])}`);
    }

    const data = await res.json();
    const item = data?.data?.[0];
    if (!item) {
        throw new Error('API 响应中未包含图片数据');
    }
    if (item.b64_json) {
        return { dataUrl: `data:image/png;base64,${item.b64_json}`, model, usedRefs: false };
    }
    if (item.url) {
        return { imageUrl: item.url, model, usedRefs: false };
    }
    throw new Error('API 响应中没有有效的图片数据');
}

/**
 * Google Gemini 图像生成后端（符合当前官方 Generate Content REST 规范）
 */
export async function generateGeminiImage(settings, prompt, aspectRatio, refs, options = {}) {
    let base = normalizeBackendUrl(settings.backendUrl, 'https://generativelanguage.googleapis.com/v1');
    // New API deployments expose the native Gemini route under /v1beta even
    // when the same server's OpenAI-compatible base is /v1.
    if (options.openAICompatibleRelay) base = base.replace(/\/v1$/, '/v1beta');
    const model = (settings.backendModel || 'gemini-2.5-flash-image').trim();
    const key = (settings.backendKey || '').trim();

    const parts = [];
    const isUnifiedPrompt = prompt.startsWith('Edit the supplied references') ||
                            prompt.includes('PRIMARY REFERENCE:') ||
                            prompt.includes('Preserve each character\'s identity');
    if (isUnifiedPrompt || isLocalQwen(settings)) {
        // 新链路：参考图以最终顺序送入，发送简短逐图标签与对应 inlineData，保留编号与映射
        if (Array.isArray(refs)) {
            for (const [index, ref] of refs.entries()) {
                if (ref && ref.dataUrl) {
                    const mime = ref.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/)?.[1] || 'image/png';
                    const base64Data = ref.dataUrl.split(',')[1];
                    if (base64Data) {
                        // Roles are already in REFERENCE MAPPING. The bridge sees
                        // one editing instruction, not a second parallel template.
                        parts.push({
                            inlineData: {
                                mimeType: mime,
                                data: base64Data,
                            },
                        });
                    }
                }
            }
        }
        // 插件统一模板，附带精简编号映射，明确图 1 承担指定画风参考
        const promptWithMap = isLocalQwen(settings) ? prompt : referenceImageEditPrompt(prompt, refs);
        parts.push({ text: promptWithMap });
    } else {
    const identityNames = [...new Set((refs || []).filter(ref => ref?.kind !== 'continuity' && ref?.identityName).map(ref => String(ref.identityName).trim()).filter(Boolean))];
    if (Array.isArray(refs) && refs.length > 0) {
        // 多张同一角色参考图容易被 Gemini 误解成多个主体。
        // 固定前两张的职责：第一张只锁身份，第二张只提供上一镜头连续性。
        for (const [index, ref] of refs.entries()) {
            if (ref && ref.dataUrl) {
                const mime = ref.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/)?.[1] || 'image/png';
                const base64Data = ref.dataUrl.split(',')[1];
                if (base64Data) {
                    const subject = ref.identityName ? ` for ${ref.identityName}` : '';
                    const roleInstruction = ref.kind === 'identity-primary'
                        ? `This is the immutable PRIMARY IDENTITY reference${subject}. Reproduce the exact same person and face: preserve face silhouette, facial proportions, eye shape and spacing, iris color, nose, mouth, age, skin tone, hairline, hairstyle, and signature ornaments. Do not redesign, beautify, merge, average, or reinterpret this identity.`
                        : ref.kind === 'continuity'
                            ? 'This is a CONTINUITY reference only. Use it for unchanged clothing, accessories, hairstyle state, and carried props. The primary identity reference overrides this image for every facial feature; ignore any facial drift already present here. Do not copy its pose, framing, background, or lighting.'
                            : `This is an identity reference${subject}. Other references with the same identity name show this same person. References with a different identity name show a different cast member. Preserve this person's face and never merge, average, duplicate, or swap identities.`;
                    parts.push({
                        text: `Reference image ${index + 1} (${ref.label || 'character reference'}): ${roleInstruction} It must not increase or duplicate the cast beyond the named people in the main instruction.`,
                    });
                    parts.push({
                        inlineData: {
                            mimeType: mime,
                            data: base64Data,
                        },
                    });
                }
            }
        }
        parts.push({
            text: `REFERENCE PRIORITY: reference image 1 controls visual style and its named character identity. Other references follow their labeled roles and cannot override its style.${identityNames.length > 1 ? ' Different identity names are different cast members; keep each named face separate and apply the matching reference only to that person.' : ' Multiple references may depict the same character and never add people.'} Generate only the exact visible cast and headcount in the main prompt, with each listed character appearing once.`,
        });
    }
    parts.push({
        text: `MAIN GENERATION INSTRUCTION: ${prompt}\n\nIdentity consistency is mandatory at every camera distance and after every wardrobe, pose, expression, lighting, or location change. A distant or full-body shot must keep the same recognizable face and facial proportions as the primary identity reference.`,
    });
    }

    const headers = { 'Content-Type': 'application/json' };
    if (key) {
        if (options.openAICompatibleRelay) headers.Authorization = `Bearer ${key}`;
        else headers['x-goog-api-key'] = key;
    }

    const isLocalBridge = isLocalQwen(settings);
    const backendLabel = isLocalBridge ? '本地千问' : 'Gemini';

    if (isLocalBridge) {
        let capabilities;
        try {
            const response = await fetch(`${base}/rpig-capabilities`, {
                signal: combineAbortSignals(options.signal, timeoutSignal(5000)),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            capabilities = await response.json();
        } catch (error) {
            if (isAbortError(error) && options.signal?.aborted) throw error;
            throw new RpigError('BRIDGE_VERSION_MISMATCH', '本地桥接未通过版本核验，可能启动了旧副本。已停止生图，请启动统一入口后重试');
        }
        if (capabilities?.bridge !== 'rpig-qwen' || capabilities?.protocol !== 2
            || capabilities?.reference_order !== true || capabilities?.explicit_dimensions !== true) {
            throw new RpigError('BRIDGE_VERSION_MISMATCH', '8055 上运行的不是支持多参考图与尺寸透传的修复版桥接，已停止生图');
        }
        if (options.diagnostics) options.diagnostics.bridge = capabilities;
    }
    const requestBody = {
        contents: [{ role: 'user', parts: parts }],
        generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            ...(options.openAICompatibleRelay ? { imageConfig: { aspectRatio: aspectRatio || '16:9' } } : { responseFormat: {
                image: {
                    aspectRatio: aspectRatio || '16:9',
                },
            } }),
        },
    };

    if (isLocalBridge) {
        // 本地 Qwen 桥接专有参数，区分画幅与分辨率档位，支持 16:9, 9:16, 1:1, 2.39:1, 4:3, 3:4 等
        const scenePlan = options[LOCAL_SCENE_RENDER_PLAN];
        const renderSettings = options[LOCAL_DETAIL_PATCH_SIZE] || scenePlan ? settings : qwenIdentityRenderSettings(settings, refs);
        const [targetWidth, targetHeight] = options[LOCAL_DETAIL_PATCH_SIZE] || scenePlan?.renderSize || qwenSize(renderSettings, aspectRatio);
        requestBody.width = targetWidth;
        requestBody.height = targetHeight;
        requestBody.steps = qwenSteps(renderSettings.qwenSteps);
        requestBody.cfg_scale = Number.isFinite(settings.qwenCfg) ? settings.qwenCfg : 1.0;
        requestBody.reference_profile = scenePlan?.referenceProfile || renderSettings.qwenReferenceProfile || 'balanced';
        if (options.diagnostics) options.diagnostics.identityDetailBoost = renderSettings !== settings;
        if (options.diagnostics && scenePlan) options.diagnostics.sceneRendering = {mode:'whole-scene-detail',renderSize:scenePlan.renderSize,
            outputSize:scenePlan.outputSize,steps:requestBody.steps,cfg:requestBody.cfg_scale,referenceProfile:requestBody.reference_profile,diffusionPasses:1};
        requestBody.cache_type = settings.qwenCacheType || 'q8_0';

        if (settings.qwenSeed !== undefined && settings.qwenSeed !== '' && Number(settings.qwenSeed) >= 0) {
            requestBody.seed = Number(settings.qwenSeed);
        } else {
            requestBody.seed = -1; // 显式 -1 表示随机
        }

        if (options.negativePrompt !== undefined && options.negativePrompt !== null) {
            requestBody.negative_prompt = String(options.negativePrompt).trim();
        }
        if (options.requestId) {
            requestBody.request_id = options.requestId;
        }
    }

    if (options.diagnostics) {
        options.diagnostics.sentPrompt = parts.filter(p => typeof p.text === 'string').map(p => p.text).join(' \n');
        options.diagnostics.requestedSize = isLocalBridge ? [requestBody.width, requestBody.height] : null;
        options.diagnostics.requestedAspectRatio = settings.imageSize || aspectRatio;
    }
    const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;

    const cancelLocal = () => {
        if (isLocalBridge && options.requestId) {
            fetch(`${base}/rpig-cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ request_id: options.requestId }) }).catch(() => {});
        }
    };
    options.signal?.addEventListener('abort', cancelLocal, { once: true });

    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody),
            signal: combineAbortSignals(options.signal, timeoutSignal(isLocalBridge ? 690000 : 300000)),
        });
    } catch (netErr) {
        cancelLocal();
        if (isAbortError(netErr)) throw netErr;
        throw requestFailure(netErr, url, `${backendLabel} 图片连接失败`, [key]);
    } finally {
        options.signal?.removeEventListener('abort', cancelLocal);
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new RpigError(isLocalBridge ? 'QWEN_IMAGE_HTTP' : 'GEMINI_IMAGE_HTTP', `${backendLabel} 图片 HTTP ${res.status}: ${upstreamErrorMessage(errText, [key])}`, { status: res.status });
    }

    const data = await res.json();
    if (options.diagnostics && data.rpig) options.diagnostics.engine = data.rpig;
    const candidateParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = candidateParts.find(p => p.inlineData || p.inline_data);

    if (!imagePart) {
        const textPart = candidateParts.find(p => p.text);
        if (textPart && textPart.text) {
            throw new Error(`${backendLabel} 未生成图片，返回文本：${textPart.text.slice(0, 150)}`);
        }
        throw new Error(`${backendLabel} 未返回图片数据`);
    }

    const b64 = imagePart.inlineData?.data || imagePart.inline_data?.data;
    const mime = imagePart.inlineData?.mimeType || imagePart.inline_data?.mime_type || 'image/png';
    return { dataUrl: `data:${mime};base64,${b64}`, model, usedRefs: Array.isArray(refs) && refs.length > 0 };
}

/**
 * Stable Diffusion WebUI 后端
 */
export async function generateSDImage(settings, prompt, avoid, sdSize, refs, options = {}) {
    const base = normalizeBackendUrl(settings.backendUrl);
    const [width, height] = sdSize || [1344, 768];
    const negative = avoid || settings.sdNegative || DEFAULT_SD_NEGATIVE;
    const denoising = options.denoisingStrength !== undefined ? options.denoisingStrength : 0.55;

    const common = {
        prompt: prompt,
        negative_prompt: negative,
        steps: parseInt(settings.sdSteps, 10) || 28,
        cfg_scale: parseFloat(settings.sdCfg) || 7,
        width: width,
        height: height,
        sampler_name: 'DPM++ 2M Karras',
    };

    let res;
    if (Array.isArray(refs) && refs.length > 0 && refs[0].dataUrl) {
        res = await fetch(`${base}/sdapi/v1/img2img`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...common,
                // 单次 img2img 只使用最高优先级参考图；多张 init_images 会被部分后端
                // 当成批处理输入，反而削弱上一镜头的造型连续性。
                init_images: [refs[0].dataUrl],
                denoising_strength: denoising,
            }),
            signal: combineAbortSignals(options.signal, timeoutSignal(300000)),
        });
    } else {
        res = await fetch(`${base}/sdapi/v1/txt2img`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(common),
            signal: combineAbortSignals(options.signal, timeoutSignal(300000)),
        });
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`SD HTTP ${res.status}: ${scrubSensitiveText(errText, [settings.backendKey]).slice(0, 300)}`);
    }

    const data = await res.json();
    const b64 = data?.images?.[0];
    if (!b64) throw new Error('SD WebUI 未返回图片数据');
    return {
        dataUrl: `data:image/png;base64,${b64}`,
        model: 'SD WebUI',
        usedRefs: Array.isArray(refs) && refs.length > 0 && !!refs[0]?.dataUrl,
    };
}

/**
 * ComfyUI 后端（严格节点解析与防多节点覆盖）
 */
export async function generateComfyUIImage(settings, prompt, avoid, refs, options = {}) {
    const base = normalizeBackendUrl(settings.backendUrl);
    const workflowRaw = (settings.comfyWorkflow || '').trim();
    if (!workflowRaw) {
        throw new Error('请先在高级设置中粘贴 ComfyUI workflow JSON');
    }

    let workflow;
    try {
        workflow = JSON.parse(workflowRaw);
    } catch {
        throw new Error('ComfyUI workflow JSON 格式无效，解析失败');
    }

    // 1. 上传参考图
    const uploadedNames = [];
    let appliedReference = false;
    if (Array.isArray(refs) && refs.length > 0) {
        // 当前仅绑定一个 LoadImage 节点，上传第一张最高优先级参考图即可。
        for (const ref of refs.slice(0, 1)) {
            if (!ref?.dataUrl) continue;
            try {
                const blob = dataUrlToBlob(ref.dataUrl);
                const form = new FormData();
                form.append('image', blob, `ref_${Date.now()}.png`);
                form.append('overwrite', 'true');
                const res = await fetch(`${base}/upload/image`, {
                    method: 'POST',
                    body: form,
                    signal: combineAbortSignals(options.signal, timeoutSignal(30000)),
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data?.name) uploadedNames.push(data.name);
                }
            } catch (error) {
                if (isAbortError(error)) throw error;
                /* ignore single ref upload fail */
            }
        }
    }

    // 2. 严格匹配正向/负向提示词节点
    let posNode = null;
    let negNode = null;

    if (settings.comfyPositiveNodeId) {
        if (!workflow[settings.comfyPositiveNodeId]) {
            throw new Error(`指定的正向提示词节点 ID "${settings.comfyPositiveNodeId}" 在 Workflow 中不存在`);
        }
        posNode = workflow[settings.comfyPositiveNodeId];
    }

    if (settings.comfyNegativeNodeId) {
        if (!workflow[settings.comfyNegativeNodeId]) {
            throw new Error(`指定的负向提示词节点 ID "${settings.comfyNegativeNodeId}" 在 Workflow 中不存在`);
        }
        negNode = workflow[settings.comfyNegativeNodeId];
    }

    // 如果未指定正向节点 ID，自动解析
    if (!posNode) {
        const textNodes = Object.entries(workflow).filter(([_, node]) => {
            return node && (node.class_type === 'CLIPTextEncode' || node.class_type === 'CLIPTextEncodeSDXL' || node.class_type === 'CLIPTextEncodeFlux' || (node.inputs && typeof node.inputs.text === 'string'));
        });

        if (textNodes.length === 1) {
            posNode = textNodes[0][1];
        } else if (textNodes.length > 1) {
            const posCandidates = textNodes.filter(([_, n]) => {
                const title = (n._meta?.title || '').toLowerCase();
                return (title.includes('pos') || title.includes('正向') || title.includes('prompt')) &&
                       !(title.includes('neg') || title.includes('负向') || title.includes('avoid') || title.includes('negative'));
            });

            if (posCandidates.length === 1) {
                posNode = posCandidates[0][1];
            } else {
                throw new Error('Workflow 中存在多个文本编码节点且无法唯一确定正向节点，请在扩展设置中明确指定「正向节点 ID」');
            }

            if (!negNode) {
                const negCandidates = textNodes.filter(([_, n]) => {
                    const title = (n._meta?.title || '').toLowerCase();
                    return title.includes('neg') || title.includes('负向') || title.includes('avoid') || title.includes('negative');
                });
                if (negCandidates.length === 1) {
                    negNode = negCandidates[0][1];
                }
            }
        } else {
            throw new Error('ComfyUI workflow 中未找到有效的正向提示词节点，请检查 workflow');
        }
    }

    if (!posNode || !posNode.inputs || typeof posNode.inputs.text === 'undefined') {
        throw new Error('正向提示词节点输入结构无效');
    }

    posNode.inputs.text = prompt;
    if (negNode && negNode.inputs && typeof negNode.inputs.text !== 'undefined' && avoid) {
        negNode.inputs.text = avoid;
    }

    // 3. 严格匹配 LoadImage 节点（禁止全量无条件覆盖全部 LoadImage 节点）
    if (Array.isArray(refs) && refs.length > 0) {
        let imgNode = null;
        if (settings.comfyImageNodeId) {
            if (!workflow[settings.comfyImageNodeId]) {
                throw new Error(`指定的参考图节点 ID "${settings.comfyImageNodeId}" 在 Workflow 中不存在`);
            }
            imgNode = workflow[settings.comfyImageNodeId];
        } else {
            const loadImgNodes = Object.entries(workflow).filter(([_, node]) => {
                return node && node.class_type === 'LoadImage';
            });

            if (loadImgNodes.length === 1) {
                imgNode = loadImgNodes[0][1];
            } else if (loadImgNodes.length > 1) {
                const matchingImgNodes = loadImgNodes.filter(([_, n]) => {
                    const title = (n._meta?.title || '').toLowerCase();
                    return title.includes('ref') || title.includes('参考') || title.includes('character') || title.includes('face') || title.includes('ipadapter') || title.includes('input');
                });
                if (matchingImgNodes.length === 1) {
                    imgNode = matchingImgNodes[0][1];
                } else {
                    throw new Error('Workflow 中存在多个 LoadImage 节点且无法唯一确定参考图节点，请在扩展设置中明确指定「参考图节点 ID」');
                }
            }
        }

        if (imgNode && imgNode.inputs && imgNode.inputs.image !== undefined && uploadedNames.length > 0) {
            imgNode.inputs.image = uploadedNames[0];
            appliedReference = true;
        }
    }

    // 4. 提交任务
    const res = await fetch(`${base}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow }),
        signal: combineAbortSignals(options.signal, timeoutSignal(30000)),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`ComfyUI HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const promptId = data?.prompt_id;
    if (!promptId) throw new Error('ComfyUI 未返回 prompt_id');

    // 5. 轮询历史结果
    for (let i = 0; i < 120; i++) {
        await sleep(2500, options.signal);
        let hres;
        try {
            hres = await fetch(`${base}/history/${promptId}`, {
                signal: combineAbortSignals(options.signal, timeoutSignal(10000)),
            });
        } catch (error) {
            if (isAbortError(error) && options.signal?.aborted) throw error;
            continue;
        }
        if (!hres.ok) continue;

        const hist = await hres.json();
        const entry = hist[promptId];
        if (!entry || !entry.outputs) continue;

        for (const nodeId in entry.outputs) {
            const out = entry.outputs[nodeId];
            if (out.images && out.images.length) {
                const img = out.images[0];
                const imgUrl = `${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`;
                return {
                    dataUrl: await fetchToDataUrl(imgUrl, { signal: options.signal }),
                    model: 'ComfyUI',
                    usedRefs: appliedReference,
                };
            }
        }
    }
    throw new Error('ComfyUI 生成超时（300s）');
}

/**
 * SillyTavern 内置 SD 命令
 */
export async function generateTavernSD(prompt, slashCommandParser, options = {}) {
    const parser = slashCommandParser || (typeof window !== 'undefined' ? window.SlashCommandParser : null);
    if (!parser?.commands?.['sd']) {
        throw new Error('酒馆未启用内置 sd 命令，请先在 酒馆扩展→图像生成 中配置好生图 API');
    }
    const result = await raceWithAbort(
        parser.commands['sd'].callback({ quiet: 'true' }, prompt),
        options.signal,
    );
    if (typeof result !== 'string' || !result.trim()) {
        throw new Error('酒馆 sd 命令未返回图片');
    }
    return { imageUrl: result.trim(), model: 'Tavern SD', usedRefs: false };
}
