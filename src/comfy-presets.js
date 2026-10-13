import { normalizeBackendUrl, combineAbortSignals, timeoutSignal, throwIfAborted, RpigError, requestFailure, upstreamErrorMessage } from './utils.js';
import { qwenSize } from './qwen.js';
import { configuredLocalImageSize } from './render-size.js';

const PRESETS = {
    custom: { id: 'custom', label: '自定义工作流', minRefs: 0, maxRefs: 1, supportsReference: false, modelFamily: 'sd', promptFormat: 'tags' },
    'sd-text': { id: 'sd-text', label: 'SD 基础文生图', minRefs: 0, maxRefs: 0, supportsReference: false, modelFamily: 'sd', promptFormat: 'tags' },
    'sd-img2img': { id: 'sd-img2img', label: 'SD 单图图生图', minRefs: 1, maxRefs: 1, supportsReference: true, modelFamily: 'sd', promptFormat: 'tags' },
    'sd-cast': { id: 'sd-cast', label: 'SD 多人参考排布（实验）', minRefs: 2, maxRefs: 4, supportsReference: true, modelFamily: 'sd', promptFormat: 'natural' },
    'qwen-edit': { id: 'qwen-edit', label: 'Qwen 原生多图编辑', minRefs: 1, maxRefs: 3, supportsReference: true, modelFamily: 'qwen', promptFormat: 'natural' },
};
// These match the ordinary backend SIZE_MAP; this module owns no backend imports.
const SD_SIZES = { '16:9': [1344, 768], '2.39:1': [1536, 640], '1:1': [1024, 1024], '9:16': [768, 1344] };
const LCM_SIZES = { '16:9': [768, 448], '2.39:1': [768, 320], '1:1': [512, 512], '9:16': [448, 768] };

export function getComfyPreset(settingsOrId = {}) {
    const id = (typeof settingsOrId === 'string' ? settingsOrId : settingsOrId?.comfyPreset) || 'custom';
    if (!Object.hasOwn(PRESETS, id)) throw new RpigError('COMFY_PRESET_INVALID', '未知 ComfyUI 预置，请重新选择');
    const preset = { ...PRESETS[id] };
    // String lookup is static preset metadata; only SD settings select a sampling profile.
    if (typeof settingsOrId !== 'string' && ['sd-text', 'sd-img2img', 'sd-cast'].includes(id)) {
        const value = settingsOrId?.comfySamplingProfile;
        const samplingProfile = value == null || value === '' ? 'standard' : value;
        if (!['standard', 'lcm'].includes(samplingProfile)) {
            throw new RpigError('COMFY_CONTROL_INVALID', '未知 SD 采样方式，请选择标准或 LCM');
        }
        Object.assign(preset, { samplingProfile, defaultSteps: samplingProfile === 'lcm' ? 8 : 28,
            defaultCfg: samplingProfile === 'lcm' ? 2 : 7 });
    }
    return preset;
}

export async function readComfyCapabilities(settings, { signal } = {}) {
    throwIfAborted(signal);
    if (!String(settings?.backendUrl || '').trim()) throw new RpigError('COMFY_URL_REQUIRED', '请填写 ComfyUI 服务地址');
    const url = `${normalizeBackendUrl(settings.backendUrl)}/object_info`;
    const keys = [settings.backendKey].filter(Boolean);
    try {
        const response = await fetch(url, { signal: combineAbortSignals(signal, timeoutSignal(15000)) });
        if (!response.ok) throw new RpigError('COMFY_CAPABILITY_HTTP',
            `ComfyUI 节点检测 HTTP ${response.status}: ${upstreamErrorMessage(await response.text(), keys)}`);
        const info = await response.json();
        throwIfAborted(signal);
        if (!info || typeof info !== 'object' || Array.isArray(info)) throw new RpigError('COMFY_CAPABILITY_INVALID', 'ComfyUI 没有返回有效节点信息');
        return info;
    } catch (error) { throw requestFailure(error, url, 'ComfyUI 节点检测失败', keys); }
}

function inputs(info, node) {
    const schema = info?.[node]?.input;
    return { ...schema?.required, ...schema?.optional };
}

function choices(info, node, field) {
    const spec = inputs(info, node)[field];
    const values = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options || spec?.options;
    return Array.isArray(values) ? [...new Set(values.filter(value => typeof value === 'string'))] : [];
}

const COMMON_NODES = {
    KSampler: ['model', 'positive', 'negative', 'latent_image', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
    VAEDecode: ['samples', 'vae'], SaveImage: ['images', 'filename_prefix'],
};
const IMAGE_NODES = { LoadImage: ['image'], ImageScale: ['image', 'upscale_method', 'width', 'height', 'crop'], VAEEncode: ['pixels', 'vae'] };

function requiredNodes(preset, hasLora) {
    if (preset.id === 'custom') return {};
    const nodes = { ...COMMON_NODES };
    if (preset.modelFamily === 'qwen') Object.assign(nodes, IMAGE_NODES, {
        UNETLoader: ['unet_name', 'weight_dtype'], CLIPLoader: ['clip_name', 'type'], VAELoader: ['vae_name'],
        TextEncodeQwenImageEditPlus: ['clip', 'prompt', 'vae', 'image1', 'image2', 'image3'],
        ModelSamplingAuraFlow: ['model', 'shift'], CFGNorm: ['model', 'strength'],
        ...(hasLora ? { LoraLoaderModelOnly: ['model', 'lora_name', 'strength_model'] } : {}),
    });
    else Object.assign(nodes, {
        CheckpointLoaderSimple: ['ckpt_name'], CLIPTextEncode: ['clip', 'text'],
        ...(['sd-img2img', 'sd-cast'].includes(preset.id) ? IMAGE_NODES : { EmptyLatentImage: ['width', 'height', 'batch_size'] }),
        ...(preset.id === 'sd-cast' ? { EmptyImage: ['width','height','batch_size','color'],
            ImageCompositeMasked: ['destination','source','x','y','resize_source'],
            ConditioningSetArea: ['conditioning','width','height','x','y','strength'],
            ConditioningCombine: ['conditioning_1','conditioning_2'] } : {}),
        ...(hasLora ? { LoraLoader: ['model', 'clip', 'lora_name', 'strength_model', 'strength_clip'] } : {}),
        ...(preset.samplingProfile === 'lcm' ? { ModelSamplingDiscrete: ['model', 'sampling', 'zsnr'] } : {}),
    });
    return nodes;
}

function inputType(node, field) {
    if (field === 'image') return node === 'LoadImage' ? 'COMBO' : 'IMAGE';
    if (/^(?:image[123]|pixels|images|destination|source)$/.test(field)) return 'IMAGE';
    if (/^(?:positive|negative|conditioning|conditioning_[12])$/.test(field)) return 'CONDITIONING';
    if (/^(?:samples|latent_image)$/.test(field)) return 'LATENT';
    if (/^(?:model|clip|vae)$/.test(field)) return field.toUpperCase();
    if (/^(?:width|height|batch_size|seed|steps|color|x|y)$/.test(field)) return 'INT';
    if (/^(?:cfg|denoise|shift|strength|strength_model|strength_clip)$/.test(field)) return 'FLOAT';
    if (/^(?:text|prompt|filename_prefix)$/.test(field)) return 'STRING';
    if (field === 'zsnr' || field === 'resize_source') return 'BOOLEAN';
    return 'COMBO';
}

function normalizedLoras(loras = []) {
    if (!Array.isArray(loras) || loras.length > 1) throw new RpigError('COMFY_LORA_LIMIT', '当前预置一次只支持一个明确选中的角色 LoRA，已停止，未截断配置');
    return loras.map(lora => {
        if (!lora || typeof lora.name !== 'string' || !lora.name.trim()) throw new RpigError('COMFY_LORA_INVALID', '角色 LoRA 文件名无效');
        if (Array.isArray(lora.triggerWords) && lora.triggerWords.some(value => typeof value !== 'string')) {
            throw new RpigError('COMFY_LORA_INVALID', '角色 LoRA 触发词格式无效');
        }
        const trigger = Array.isArray(lora.triggerWords) ? lora.triggerWords.join(', ') : lora.triggerWords;
        if (trigger != null && typeof trigger !== 'string') throw new RpigError('COMFY_LORA_INVALID', '角色 LoRA 触发词格式无效');
        return { name: lora.name.trim(), triggerWords: (trigger || '').trim(),
            strengthModel: numeric(lora.strengthModel, 1, -100, 100, 'LoRA 模型权重'),
            strengthClip: numeric(lora.strengthClip, 1, -100, 100, 'LoRA 文本权重') };
    });
}

export function inspectComfyCapabilities(info, settings, { loras = [] } = {}) {
    const preset = getComfyPreset(settings);
    const selectedLoras = normalizedLoras(loras);
    const missingNodes = [], missingModels = [];
    const models = {
        checkpoints: choices(info, 'CheckpointLoaderSimple', 'ckpt_name'),
        unets: choices(info, 'UNETLoader', 'unet_name'), clips: choices(info, 'CLIPLoader', 'clip_name'),
        vaes: choices(info, 'VAELoader', 'vae_name'),
        loras: [...new Set([...choices(info, 'LoraLoader', 'lora_name'), ...choices(info, 'LoraLoaderModelOnly', 'lora_name')])],
    };
    for (const [node, fields] of Object.entries(requiredNodes(preset, selectedLoras.length > 0))) {
        if (!info?.[node] || typeof info[node] !== 'object') { missingNodes.push(node); continue; }
        const available = inputs(info, node);
        for (const field of fields) {
            if (!Object.hasOwn(available, field)) { missingNodes.push(`${node}.${field}`); continue; }
            const spec = available[field];
            const type = Array.isArray(spec?.[0]) ? 'COMBO' : spec?.[0];
            if (type !== inputType(node, field)) missingNodes.push(`${node}.${field}: 类型不兼容`);
        }
    }
    const requireChoice = (node, field, value) => {
        if (!choices(info, node, field).includes(value)) missingNodes.push(`${node}.${field}=${value}`);
    };
    const requireModel = (field, values) => {
        const name = typeof settings?.[field] === 'string' ? settings[field].trim() : '';
        if (!name || !values.includes(name)) missingModels.push(`${field}: ${name || '未选择'}`);
    };
    if (preset.id !== 'custom') {
        requireChoice('KSampler', 'sampler_name', preset.samplingProfile === 'lcm' ? 'lcm' : 'euler');
        requireChoice('KSampler', 'scheduler', preset.modelFamily === 'qwen' ? 'simple' : 'normal');
        if (preset.samplingProfile === 'lcm') requireChoice('ModelSamplingDiscrete', 'sampling', 'lcm');
        if (preset.minRefs > 0) {
            requireChoice('ImageScale', 'upscale_method', 'lanczos');
            requireChoice('ImageScale', 'crop', 'disabled');
        }
        if (preset.modelFamily === 'qwen') {
            requireChoice('UNETLoader', 'weight_dtype', 'default'); requireChoice('CLIPLoader', 'type', 'qwen_image');
            requireModel('comfyUnet', models.unets); requireModel('comfyClip', models.clips); requireModel('comfyVae', models.vaes);
        } else requireModel('comfyCheckpoint', models.checkpoints);
        const loader = preset.modelFamily === 'qwen' ? 'LoraLoaderModelOnly' : 'LoraLoader';
        for (const lora of selectedLoras) if (!choices(info, loader, 'lora_name').includes(lora.name)) missingModels.push(`LoRA: ${lora.name}`);
    } else if (selectedLoras.length) missingNodes.push('custom: 不能自动绑定角色 LoRA');
    return { ready: !missingNodes.length && !missingModels.length, missingNodes, missingModels, models };
}

function numeric(value, fallback, min, max, label, integer = false) {
    if (value == null || (typeof value === 'string' && !value.trim())) return fallback;
    const number = Number(value);
    if (!['number', 'string'].includes(typeof value) || !Number.isFinite(number)
        || number < min || number > max || (integer && !Number.isInteger(number))) {
        throw new RpigError('COMFY_CONTROL_INVALID', `${label}必须为 ${min}–${max} 范围内的${integer ? '整数' : '数值'}`);
    }
    return number;
}

function modelName(settings, field) {
    const name = typeof settings[field] === 'string' ? settings[field].trim() : '';
    if (!name) throw new RpigError('COMFY_MODEL_REQUIRED', '请先选择预置所需的模型文件：' + field);
    return name;
}

function seed(value) {
    const configured = numeric(value, -1, -1, Number.MAX_SAFE_INTEGER, '种子', true);
    if (configured >= 0) return configured;
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
        const parts = globalThis.crypto.getRandomValues(new Uint32Array(2));
        return (parts[0] & 0x1fffff) * 0x100000000 + parts[1];
    }
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

export function comfyRenderParameters(settings = {}) {
    const preset = getComfyPreset(settings);
    if (preset.id === 'custom') return null;
    const qwen = preset.modelFamily === 'qwen';
    const sizes = preset.samplingProfile === 'lcm' ? LCM_SIZES : SD_SIZES;
    const size = configuredLocalImageSize(settings) || (qwen
        ? qwenSize({ ...settings, qwenResolution: '512x288' }, settings.imageSize || '16:9')
        : sizes[settings.imageSize] || sizes['16:9']);
    return { size: [...size], steps: numeric(settings.comfySteps, qwen ? 20 : preset.defaultSteps, 1, 10000, '采样步数', true) };
}

export function buildComfyPresetWorkflow(settings, { prompt, avoid = '', uploadedImages = [], loras = [], referencePrompts = [] } = {}) {
    const preset = getComfyPreset(settings);
    if (preset.id === 'custom') throw new RpigError('COMFY_PRESET_CUSTOM', '自定义工作流使用原有适配，不能作为预置生成');
    if (!Array.isArray(uploadedImages) || uploadedImages.length < preset.minRefs || uploadedImages.length > preset.maxRefs) {
        throw new RpigError('COMFY_REFERENCE_LIMIT', `此预置需要 ${preset.minRefs}–${preset.maxRefs} 张参考图，已停止，未丢弃参考图`);
    }
    if (uploadedImages.some(name => typeof name !== 'string' || !name.trim())) throw new RpigError('COMFY_REFERENCE_UPLOAD_EMPTY', '参考图缺少已上传文件名');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new RpigError('COMFY_PROMPT_REQUIRED', '预置缺少有效提示词');
    const selectedLoras = normalizedLoras(loras);
    if (preset.id === 'sd-cast' && selectedLoras.length) throw new RpigError('COMFY_LORA_UNSUPPORTED', '多人参考排布未启用多人 LoRA，请保持角色 LoRA 关闭。');
    if (preset.id === 'sd-cast' && (!Array.isArray(referencePrompts) || referencePrompts.length !== uploadedImages.length
        || referencePrompts.some(text => typeof text !== 'string' || text.length > 1200))) {
        throw new RpigError('COMFY_CONTROL_INVALID', '多人参考图须逐张提供对应人物的外貌描述。');
    }
    const qwen = preset.modelFamily === 'qwen';
    const lcm = preset.samplingProfile === 'lcm';
    const render = comfyRenderParameters(settings);
    const [width, height] = render.size;
    const positivePrompt = [preset.id === 'sd-cast' ? `${uploadedImages.length} people, one continuous scene, ${prompt.trim()}` : prompt.trim(),
        ...selectedLoras.map(lora => lora.triggerWords).filter(Boolean)].join('\n');
    const workflow = {};
    const put = (id, class_type, inputs) => { workflow[id] = { class_type, inputs }; return [String(id), 0]; };
    let model, clip, vae;
    if (qwen) {
        model = put('1', 'UNETLoader', { unet_name: modelName(settings, 'comfyUnet'), weight_dtype: 'default' });
        clip = put('2', 'CLIPLoader', { clip_name: modelName(settings, 'comfyClip'), type: 'qwen_image' });
        vae = put('3', 'VAELoader', { vae_name: modelName(settings, 'comfyVae') });
    } else {
        model = put('1', 'CheckpointLoaderSimple', { ckpt_name: modelName(settings, 'comfyCheckpoint') });
        clip = ['1', 1]; vae = ['1', 2];
    }
    if (selectedLoras.length) {
        const lora = selectedLoras[0];
        model = put('4', qwen ? 'LoraLoaderModelOnly' : 'LoraLoader', { model, lora_name: lora.name,
            strength_model: lora.strengthModel, ...(!qwen ? { clip, strength_clip: lora.strengthClip } : {}) });
        if (!qwen) clip = ['4', 1];
    }
    if (qwen) {
        model = put('5', 'ModelSamplingAuraFlow', { model, shift: 3 });
        model = put('6', 'CFGNorm', { model, strength: 1 });
    } else if (lcm) model = put('5', 'ModelSamplingDiscrete', { model, sampling: 'lcm', zsnr: false });
    const imageLinks = uploadedImages.map((image, index) => put(String(20 + index), 'LoadImage', { image }));
    let latent;
    if (preset.id === 'sd-cast') {
        // A core-node contact sheet preserves every supplied identity; local
        // conditioning follows the same left-to-right order. This remains an
        // img2img experiment, with no identity adapter or per-person LoRA.
        const cellWidth = Math.floor(width / imageLinks.length / 8) * 8;
        const figureHeight = Math.floor(Math.min(height * .9, cellWidth * 4 / 3) / 8) * 8;
        const figureWidth = Math.floor(figureHeight * 3 / 4 / 8) * 8;
        let canvas = put('30', 'EmptyImage', { width, height, batch_size: 1, color: 0xffffff });
        imageLinks.forEach((link, index) => {
            const figure = put(String(31 + index * 2), 'ImageScale', { image: link,
                upscale_method: 'lanczos', width: figureWidth, height: figureHeight, crop: 'disabled' });
            canvas = put(String(32 + index * 2), 'ImageCompositeMasked', { destination: canvas, source: figure,
                x: index * cellWidth + Math.floor((cellWidth - figureWidth) / 2), y: height - figureHeight - 8, resize_source: false });
        });
        latent = put('11', 'VAEEncode', { pixels: canvas, vae });
    } else if (imageLinks.length) {
        const image = put('10', 'ImageScale', { image: imageLinks[0], upscale_method: 'lanczos', width, height, crop: 'disabled' });
        latent = put('11', 'VAEEncode', { pixels: image, vae });
    } else latent = put('10', 'EmptyLatentImage', { width, height, batch_size: 1 });
    const textNode = qwen ? 'TextEncodeQwenImageEditPlus' : 'CLIPTextEncode';
    const referenceInputs = qwen ? { vae, ...Object.fromEntries(imageLinks.map((link, index) => [`image${index + 1}`, link])) } : {};
    let positive = put('7', textNode, { clip, [qwen ? 'prompt' : 'text']: positivePrompt, ...referenceInputs });
    if (preset.id === 'sd-cast') {
        const cellWidth = Math.floor(width / imageLinks.length / 8) * 8;
        referencePrompts.forEach((description, index) => {
            const encoded = put(String(50 + index * 3), 'CLIPTextEncode', { clip,
                text: description.trim() || 'one adult person matching the reference in this region' });
            const region = put(String(51 + index * 3), 'ConditioningSetArea', { conditioning: encoded,
                width: index === imageLinks.length - 1 ? width - index * cellWidth : cellWidth,
                height, x: index * cellWidth, y: 0, strength: 1 });
            positive = put(String(52 + index * 3), 'ConditioningCombine', { conditioning_1: positive, conditioning_2: region });
        });
    }
    const negative = put('8', textNode, { clip, [qwen ? 'prompt' : 'text']: typeof avoid === 'string' ? avoid : '', ...referenceInputs });
    const samples = put('12', 'KSampler', { model, positive, negative, latent_image: latent,
        seed: seed(settings.comfySeed), steps: render.steps,
        cfg: numeric(settings.comfyCfg, qwen ? 4 : preset.defaultCfg, 0, 100, 'CFG'), sampler_name: lcm ? 'lcm' : 'euler', scheduler: qwen ? 'simple' : 'normal',
        denoise: preset.id === 'sd-text' ? 1 : numeric(settings.comfyDenoise, qwen ? 1 : 0.6, 0, 1, '降噪强度') });
    const images = put('13', 'VAEDecode', { samples, vae });
    put('14', 'SaveImage', { images, filename_prefix: 'RPIG/' + preset.id });
    return { workflow, outputNodeId: '14' };
}
