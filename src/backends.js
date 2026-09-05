// ============================================================
// RP 电影配图 - 图片后端模块
// ============================================================

import {
    normalizeBackendUrl,
    scrubSensitiveText,
    dataUrlToBlob,
    fetchToDataUrl,
    sleep,
} from './utils.js';
import { DEFAULT_SD_NEGATIVE, preparePromptForBackend } from './prompts.js';

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

/**
 * 统一将持久化参考图（url）在内存中水合为 dataUrl 供后端 API 使用
 * @param {Array} refs 
 * @param {Function} [fetchFn] 
 * @param {number} [maxRefs] 
 * @returns {Promise<Array>}
 */
export async function hydrateReferenceImages(refs, fetchFn = fetchToDataUrl, maxRefs = 5) {
    if (!Array.isArray(refs) || refs.length === 0) return [];
    const hydrated = [];
    const seen = new Set();

    for (const ref of refs) {
        if (!ref) continue;
        if (hydrated.length >= maxRefs) break;

        let dataUrl = ref.dataUrl;
        if (!dataUrl && ref.url) {
            try {
                if (typeof fetchFn === 'function') {
                    dataUrl = await fetchFn(ref.url);
                }
            } catch (err) {
                console.warn('[RP 电影配图] 参考图水合转换失败:', ref.url, err);
            }
        }

        if (dataUrl && typeof dataUrl === 'string' && !seen.has(dataUrl)) {
            seen.add(dataUrl);
            hydrated.push({
                ...ref,
                dataUrl: dataUrl,
            });
        }
    }
    return hydrated;
}

/**
 * 统一后端入口
 */
export async function generateImage(settings, prompt, avoid, refs, options = {}) {
    const s = settings || {};
    const size = SIZE_MAP[s.imageSize] || SIZE_MAP['16:9'];
    const onWarning = options.onWarning || (() => {});
    const fetchFn = options.fetchToDataUrl || fetchToDataUrl;

    const hydratedRefs = await hydrateReferenceImages(refs, fetchFn);
    const prepared = preparePromptForBackend(s, prompt, avoid, options);

    let result;
    switch (s.backend) {
        case BACKENDS.GEMINI:
            result = await generateGeminiImage(s, prepared.prompt, size.gemini, hydratedRefs, options);
            break;
        case BACKENDS.SD:
            result = await generateSDImage(s, prepared.prompt, prepared.avoid, size.sd, hydratedRefs, options);
            break;
        case BACKENDS.COMFYUI:
            result = await generateComfyUIImage(s, prepared.prompt, prepared.avoid, hydratedRefs, options);
            break;
        case BACKENDS.TAVERN_SD:
            result = await generateTavernSD(prepared.prompt, options.slashCommandParser);
            break;
        case BACKENDS.OPENAI:
        default:
            result = await generateOpenAIImage(s, prepared.prompt, size.openai, hydratedRefs, { ...options, onWarning });
            break;
    }

    return {
        ...result,
        usedPrompt: prepared.prompt,
        usedAvoid: prepared.avoid,
    };
}

/**
 * OpenAI 兼容图像生成后端
 */
export async function generateOpenAIImage(settings, prompt, size, refs, options = {}) {
    const base = normalizeBackendUrl(settings.backendUrl);
    const model = (settings.backendModel || 'gpt-image-1').trim();
    const key = (settings.backendKey || '').trim();
    const onWarning = options.onWarning || (() => {});

    const headers = {};
    if (key) {
        headers['Authorization'] = `Bearer ${key}`;
    }

    const hasRefs = Array.isArray(refs) && refs.length > 0 && refs[0].dataUrl;

    // 1. 如果有参考图，先尝试 multipart/form-data 的 /images/edits
    if (hasRefs) {
        const editCandidates = refs.slice(0, 2).filter(ref => ref?.dataUrl);
        const shouldUseHighFidelity = options.continuityReference === true && options.sceneChanged !== true;

        for (let refIndex = 0; refIndex < editCandidates.length; refIndex++) {
            const currentRef = editCandidates[refIndex];
            try {
                const blob = dataUrlToBlob(currentRef.dataUrl);
                const extension = blob.type === 'image/jpeg'
                    ? 'jpg'
                    : blob.type === 'image/webp'
                        ? 'webp'
                        : 'png';
                const buildEditForm = (highFidelity) => {
                const formData = new FormData();
                formData.append('image', blob, `reference.${extension}`);
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
                    signal: AbortSignal.timeout(300000),
                });

                // 连续性模式优先请求高输入保真；第三方不识别该字段时自动重试标准 edits。
                let res = await requestEdit(shouldUseHighFidelity);
                if (!res.ok && shouldUseHighFidelity && (res.status === 400 || res.status === 422)) {
                    onWarning('兼容接口不接受高保真参数，正在使用标准图生图模式重试');
                    res = await requestEdit(false);
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
                    onWarning(refIndex + 1 < editCandidates.length
                        ? '上游未返回图片，正在改用下一张参考图重试'
                        : '上游未返回图片，正在降级为文本生图');
                    continue;
                }

                const errStatus = res.status;
                const errBody = await res.text().catch(() => '');
                if (errStatus === 401 || errStatus === 403 || errStatus === 429) {
                    throw new Error(`OpenAI Edits HTTP ${errStatus}: ${scrubSensitiveText(errBody, [key]).slice(0, 200)}`);
                }
                if (errStatus === 404 || errStatus === 405) {
                    onWarning('后端不支持 /images/edits 参考图接口，已自动降级为纯文本提示词生成');
                    break;
                }
                if (refIndex + 1 < editCandidates.length) {
                    onWarning(`参考图 ${refIndex + 1} 生图失败（HTTP ${errStatus}），正在使用下一张参考图重试`);
                    continue;
                }
                onWarning(`参考图生图失败（HTTP ${errStatus}），已自动降级为纯文本提示词生成`);
            } catch (editErr) {
                if (editErr.message && /OpenAI Edits HTTP (?:401|403|429)/.test(editErr.message)) {
                    throw editErr;
                }
                if (refIndex + 1 < editCandidates.length) {
                    onWarning('参考图转换或请求失败，正在使用下一张参考图重试');
                    continue;
                }
                onWarning('参考图转换或请求失败，已降级为纯文本提示词生成');
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
            signal: AbortSignal.timeout(300000),
        });
    } catch (netErr) {
        throw new Error(`网络连接失败：${scrubSensitiveText(netErr.message, [key])}`);
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`图片 API HTTP ${res.status}: ${scrubSensitiveText(errText, [key]).slice(0, 300)}`);
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
    const base = normalizeBackendUrl(settings.backendUrl, 'https://generativelanguage.googleapis.com/v1');
    const model = (settings.backendModel || 'gemini-2.5-flash-image').trim();
    const key = (settings.backendKey || '').trim();

    const parts = [];
    if (Array.isArray(refs) && refs.length > 0) {
        // 多张同一角色参考图容易被 Gemini 误解成多个主体。
        // 固定前两张的职责：第一张只锁身份，第二张只提供上一镜头连续性。
        for (const [index, ref] of refs.slice(0, 2).entries()) {
            if (ref && ref.dataUrl) {
                const mime = ref.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/)?.[1] || 'image/png';
                const base64Data = ref.dataUrl.split(',')[1];
                if (base64Data) {
                    const roleInstruction = ref.kind === 'identity-primary'
                        ? 'This is the immutable PRIMARY IDENTITY reference. Reproduce the exact same person and face: preserve face silhouette, facial proportions, eye shape and spacing, iris color, nose, mouth, age, skin tone, hairline, hairstyle, and signature ornaments. Do not redesign, beautify, merge, average, or reinterpret this identity.'
                        : ref.kind === 'continuity'
                            ? 'This is a CONTINUITY reference only. Use it for unchanged clothing, accessories, hairstyle state, and carried props. The primary identity reference overrides this image for every facial feature; ignore any facial drift already present here. Do not copy its pose, framing, background, or lighting.'
                            : 'This is a secondary visual reference. Use it only to clarify the same character and never average it with or override the primary identity reference.';
                    parts.push({
                        text: `Reference image ${index + 1} (${ref.label || 'character reference'}): ${roleInstruction} It does not represent an additional person and must not increase or duplicate the cast.`,
                    });
                    parts.push({
                        inline_data: {
                            mime_type: mime,
                            data: base64Data,
                        },
                    });
                }
            }
        }
        parts.push({
            text: 'REFERENCE PRIORITY: reference image 1 controls identity and facial likeness; reference image 2 controls only unchanged continuity details. If they conflict, reference image 1 always wins for the face. Multiple references may depict the same character and never add people. Generate only the exact visible cast and headcount in the main prompt, with each listed character appearing once.',
        });
    }
    parts.push({
        text: `MAIN GENERATION INSTRUCTION: ${prompt}\n\nIdentity consistency is mandatory at every camera distance and after every wardrobe, pose, expression, lighting, or location change. A distant or full-body shot must keep the same recognizable face and facial proportions as the primary identity reference.`,
    });

    const headers = { 'Content-Type': 'application/json' };
    if (key) {
        headers['x-goog-api-key'] = key;
    }

    const requestBody = {
        contents: [{ parts: parts }],
        generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            responseFormat: {
                image: {
                    aspectRatio: aspectRatio || '16:9',
                },
            },
        },
    };

    const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;

    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(300000),
        });
    } catch (netErr) {
        throw new Error(`Gemini 连接失败：${scrubSensitiveText(netErr.message, [key])}`);
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Gemini 图片 HTTP ${res.status}: ${scrubSensitiveText(errText, [key]).slice(0, 300)}`);
    }

    const data = await res.json();
    const candidateParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = candidateParts.find(p => p.inlineData || p.inline_data);

    if (!imagePart) {
        const textPart = candidateParts.find(p => p.text);
        if (textPart && textPart.text) {
            throw new Error(`Gemini 未生成图片，返回文本：${textPart.text.slice(0, 150)}`);
        }
        throw new Error('Gemini 未返回图片数据');
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
            signal: AbortSignal.timeout(300000),
        });
    } else {
        res = await fetch(`${base}/sdapi/v1/txt2img`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(common),
            signal: AbortSignal.timeout(300000),
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
                    signal: AbortSignal.timeout(30000),
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data?.name) uploadedNames.push(data.name);
                }
            } catch { /* ignore single ref upload fail */ }
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
        signal: AbortSignal.timeout(30000),
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
        await sleep(2500);
        let hres;
        try {
            hres = await fetch(`${base}/history/${promptId}`, { signal: AbortSignal.timeout(10000) });
        } catch { continue; }
        if (!hres.ok) continue;

        const hist = await hres.json();
        const entry = hist[promptId];
        if (!entry || !entry.outputs) continue;

        for (const nodeId in entry.outputs) {
            const out = entry.outputs[nodeId];
            if (out.images && out.images.length) {
                const img = out.images[0];
                const imgUrl = `${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`;
                return { dataUrl: await fetchToDataUrl(imgUrl), model: 'ComfyUI', usedRefs: appliedReference };
            }
        }
    }
    throw new Error('ComfyUI 生成超时（300s）');
}

/**
 * SillyTavern 内置 SD 命令
 */
export async function generateTavernSD(prompt, slashCommandParser) {
    const parser = slashCommandParser || (typeof window !== 'undefined' ? window.SlashCommandParser : null);
    if (!parser?.commands?.['sd']) {
        throw new Error('酒馆未启用内置 sd 命令，请先在 酒馆扩展→图像生成 中配置好生图 API');
    }
    const result = await parser.commands['sd'].callback({ quiet: 'true' }, prompt);
    if (typeof result !== 'string' || !result.trim()) {
        throw new Error('酒馆 sd 命令未返回图片');
    }
    return { imageUrl: result.trim(), model: 'Tavern SD', usedRefs: false };
}
