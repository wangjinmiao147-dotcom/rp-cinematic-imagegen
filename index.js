// ============================================================
// RP 电影配图 (rp-cinematic-imagegen) v2.9.18
// ------------------------------------------------------------
// 核心功能：【双镜头模式 · 电影感分镜 · 图生图参考 · 全源聚合图库】
// 现代深色电影工作台重构版
// ============================================================

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
} from '../../../../script.js';
import { saveBase64AsFile } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

import {
    escapeHtml,
    stripHtml,
    extractJson,
    blobToDataUrl,
    fetchToDataUrl,
    resolvePromptFormat,
    scrubSensitiveText,
    findLatestAssistantMessageIndex,
    mergeNegativePrompts,
    createAbortError,
    isAbortError,
    throwIfAborted,
} from './src/utils.js';

import {
    DEFAULT_SD_NEGATIVE,
    STYLE_PRESETS,
    SHOT_MODE_INSTRUCTIONS,
    FORMAT_INSTRUCTIONS,
    DIRECTOR_SYSTEM_PROMPT,
    getCharacterVisualAnchor,
    buildDialogueContext,
    buildDirectorPrompt,
    buildOmniscientPrompt,
    buildFinalizerPrompt,
    normalizeFinalPromptOutput,
    collapsePromptToSingleParagraph,
    buildCharacterSheetPrompt,
    buildSceneAwareImagePrompt,
} from './src/prompts.js';

import {
    BACKENDS,
    SIZE_MAP,
    generateImage,
} from './src/backends.js';

import { callLLM } from './src/llm.js';

import {
    getCharacterIdentifier,
    isMessageForCharacter,
    getCharacterRefs,
    getPreviousGeneratedImage,
    saveCharacterRefs,
    getStoredGallery,
    saveToGallery,
    removeFromGallery,
    getAllImagesForCharacter,
    deleteImageCompletely,
    persistMediaUrl,
    MAX_UPLOAD_FILE_SIZE,
    MAX_BATCH_UPLOAD,
    MAX_REFS_PER_CHAR,
} from './src/gallery.js';

import {
    executeAutoDetection,
    resetAutoDetectState,
    getChatSessionKey,
} from './src/auto.js';

import { normalizeCastCharacters } from './src/cast.js';

// ------------------------------------------------------------
// 常量定义与默认设置
// ------------------------------------------------------------
const extensionName = 'rp-cinematic-imagegen';

const defaultSettings = {
    // 图片后端
    backend: BACKENDS.OPENAI,
    backendUrl: '',
    backendKey: '',
    backendModel: '',
    imageSize: '16:9',
    stylePreset: 'character',
    shotMode: 'snapshot',       // snapshot=🎬 剧情剧照抓拍 portrait=👤 角色微表情特写
    omniscientMode: true,       // 焦点镜头后增加全人物上帝视角分析
    promptFormat: 'auto',       // auto=智能自动 natural=英文自然语言 tags=Danbooru标签流
    sdNegative: DEFAULT_SD_NEGATIVE,
    sdSteps: 28,
    sdCfg: 7,
    comfyWorkflow: '',
    comfyPositiveNodeId: '',
    comfyNegativeNodeId: '',
    comfyImageNodeId: '',
    // 自动模式
    autoMode: false,
    autoCooldown: 3,     // 至少间隔 N 条消息才再次检测
    autoWindow: 12,      // 分析最近 N 条消息
    previewBeforeGeneration: true, // 手动生成时预览并可编辑最终提示词
    // LLM（剧情检测与配图提示词生成）
    llmSource: 'tavern', // tavern=复用酒馆当前LLM, custom=扩展内独立配置
    llmUrl: '',
    llmKey: '',
    llmModel: '',
    // 最终提示词总结 LLM（默认复用上方剧情 LLM）
    finalLlmSource: 'same',
    finalLlmUrl: '',
    finalLlmKey: '',
    finalLlmModel: '',
    // 形象与参考图
    useCharacterImage: true,
    usePreviousImage: true,
    hideHandsFeet: false,
    continuityDenoising: 0.48,
    characterAnchors: {},
    selectedTargetCharacter: 'auto',
};

function getSettings() {
    return extension_settings[extensionName];
}

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const s = extension_settings[extensionName];
    for (const key of Object.keys(defaultSettings)) {
        if (s[key] === undefined) {
            s[key] = defaultSettings[key];
        }
    }
    // 迁移已有设置：禁用手脚裁切旧约束
    s.hideHandsFeet = false;
}

function getAllCharacters() {
    const context = getContext();
    const rawList = context.characters || (typeof window !== 'undefined' && window.characters) || [];
    const list = [];
    if (Array.isArray(rawList)) {
        rawList.forEach((char, index) => {
            if (char && typeof char === 'object' && (char.name || char.avatar)) {
                list.push({
                    index: index,
                    name: char.name || `角色 #${index}`,
                    avatar: char.avatar || '',
                    raw: char,
                });
            }
        });
    }
    return list;
}

function getCurrentCharacter() {
    const s = getSettings();
    const context = getContext();
    const chars = getAllCharacters();

    if (s.selectedTargetCharacter && s.selectedTargetCharacter !== 'auto') {
        const found = chars.find(c => c.avatar === s.selectedTargetCharacter || c.name === s.selectedTargetCharacter);
        if (found) return found.raw;
    }

    const chid = context.characterId;
    if (chid !== undefined && chid !== null && chid >= 0) {
        if (context.characters && context.characters[chid]) {
            return context.characters[chid];
        }
    }

    const chat = context.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && (chat[i].original_avatar || chat[i].name)) {
            const found = chars.find(c => (chat[i].original_avatar && c.avatar === chat[i].original_avatar) || (chat[i].name && c.name === chat[i].name));
            if (found) return found.raw;
        }
    }

    if (chars.length > 0) return chars[0].raw;
    return null;
}

function getCharacterForMessage(message) {
    if (!message || message.is_user) return null;
    const chars = getAllCharacters();
    if (message.original_avatar) {
        const found = chars.find(c => c.avatar === message.original_avatar);
        if (found) return found.raw;
    }
    if (message.name) {
        const found = chars.find(c => c.name === message.name);
        if (found) return found.raw;
    }
    return getCurrentCharacter();
}

function getFinalizerLlmSettings(settings) {
    const s = settings || {};
    if (s.finalLlmSource !== 'custom') return s;
    return {
        ...s,
        llmSource: 'custom',
        llmUrl: s.finalLlmUrl || '',
        llmKey: s.finalLlmKey || '',
        llmModel: s.finalLlmModel || '',
    };
}

function buildParticipantContext(context, chat, messageIndex, focalCharacter, customAnchors = {}) {
    const start = Math.max(0, messageIndex - 12);
    const recent = Array.isArray(chat) ? chat.slice(start, messageIndex + 1) : [];
    const latestText = stripHtml(chat?.[messageIndex]?.mes || '');
    const userName = String(context?.name1 || [...recent].reverse().find(message => message?.is_user)?.name || 'User protagonist').trim();
    const focalName = String(focalCharacter?.name || chat?.[messageIndex]?.name || context?.name2 || 'Current role character').trim();
    const recentSpeakerNames = new Set(recent
        .map(message => String(message?.name || '').trim())
        .filter(name => name && !/^(ai|assistant|bot|user|system|narrator)$/i.test(name)));
    const candidates = Array.isArray(context?.characters) ? context.characters : [];
    const activeGroup = Array.isArray(context?.groups)
        ? context.groups.find(group => String(group?.id) === String(context?.groupId))
        : null;
    const groupAvatars = new Set(Array.isArray(activeGroup?.members) ? activeGroup.members : []);
    const selected = [];
    for (const character of candidates) {
        const name = String(character?.name || '').trim();
        if (!name) continue;
        const isGroupMember = groupAvatars.has(character?.avatar);
        const isRelevant = character === focalCharacter
            || name === focalName
            || recentSpeakerNames.has(name)
            || latestText.includes(name)
            || isGroupMember;
        if (isRelevant) {
            selected.push(character);
        }
        if (selected.length >= 12) break;
    }

    const lines = [
        `- identity=user；canonical_name=${userName}；role=候选用户主人公；presence=unknown；aliases=User, you, 用户, 玩家, 主人公；注意：用户身份存在不等于身体在镜头内`,
    ];
    const seen = new Set(['user']);
    for (const character of selected) {
        const name = String(character.name || '角色');
        const identityKey = String(character.avatar || name).toLowerCase();
        if (seen.has(identityKey)) continue;
        seen.add(identityKey);
        const anchor = getCharacterVisualAnchor(character, customAnchors);
        const description = stripHtml(character.data?.description || character.description || '')
            .replace(/\s+/g, ' ')
            .slice(0, 650);
        const role = character === focalCharacter || name === focalName ? '当前回复角色候选' : '候选群聊角色';
        const aliases = role === '当前回复角色候选' ? `；aliases=AI, Assistant, Bot, ${chat?.[messageIndex]?.name || ''}` : '';
        lines.push(`- identity=character:${identityKey}；canonical_name=${name}；role=${role}；presence=unknown；群成员/消息说话人身份均不证明在场${aliases}${anchor ? `；视觉锚点=${anchor}` : ''}${description ? `；设定=${description}` : ''}`);
    }
    if (!lines.some(line => line.includes(`canonical_name=${focalName}`))) {
        lines.push(`- identity=current-role；canonical_name=${focalName}；role=当前回复角色候选；presence=unknown；说话或叙述身份不自动证明身体入镜；aliases=AI, Assistant, Bot, ${chat?.[messageIndex]?.name || ''}`);
    }
    lines.push('- 其他 NPC：仅当最新焦点回合明确表明其身体处于当前镜头内时，才加入最终可见演员表；只被提及、回忆、通话或已经离场者不入镜。');
    return lines.join('\n');
}

function enforceOmniscientEnsemble(prompt, visibleCharacters, excludedCharacters = []) {
    const names = Array.isArray(visibleCharacters) ? visibleCharacters.filter(Boolean).slice(0, 12) : [];
    if (!names.length) return collapsePromptToSingleParagraph(prompt);
    const shot = names.length === 1 ? 'single-character medium shot' : names.length === 2 ? 'balanced two-shot' : 'clear group ensemble shot';
    const ensembleRule = `The visible cast is locked to exactly ${names.length} distinct ${names.length === 1 ? 'person' : 'people'}: ${names.join(', ')}. Use one unified ${shot}; show every listed person exactly once with a distinct body, face, position, gaze, and action. Do not add anyone outside this cast, including extra people, bystanders, crowds, reflected people, portraits, or duplicated bodies.`;
    const excluded = Array.isArray(excludedCharacters) ? excludedCharacters.filter(Boolean).slice(0, 12) : [];
    const exclusionRule = excluded.length
        ? `The following story participants are explicitly off-camera and must not appear in any form: ${excluded.join(', ')}.`
        : '';
    return collapsePromptToSingleParagraph(`${ensembleRule} ${exclusionRule} ${prompt}`);
}

async function getCharacterAvatarDataUrl(character) {
    if (!character || !character.avatar) return null;
    const context = getContext();
    const urls = [];
    urls.push(`/characters/${encodeURIComponent(character.avatar)}`);
    urls.push(`characters/${encodeURIComponent(character.avatar)}`);
    if (typeof context.getThumbnailUrl === 'function') {
        urls.push(context.getThumbnailUrl('avatar', character.avatar));
    }
    urls.push(`/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}`);

    for (const url of urls) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
            if (res.ok) {
                const blob = await res.blob();
                if (blob && blob.size > 100) {
                    return await blobToDataUrl(blob);
                }
            }
        } catch { /* try next */ }
    }
    return null;
}

function migrateLegacyMedia(message) {
    if (!message || !message.extra) return false;
    const media = Array.isArray(message.extra.media) ? message.extra.media : [];
    const legacy = [];
    if (typeof message.extra.image === 'string' && message.extra.image) legacy.push(message.extra.image);
    if (Array.isArray(message.extra.image_swipes)) {
        for (const u of message.extra.image_swipes) {
            if (typeof u === 'string' && u) legacy.push(u);
        }
    }
    let changed = false;
    for (const u of legacy) {
        if (!media.some(m => m.url === u)) {
            media.push({ url: u, title: '历史配图' });
            changed = true;
        }
    }
    if (changed) {
        message.extra.media = media;
        message.extra.media_display = 'list';
    }
    return changed;
}

function bindMediaLightbox(messageIndex) {
    const el = $(`.mes[mesid="${messageIndex}"]`);
    if (!el.length) return;
    el.find('img.mes_img').off('click.rpig').on('click.rpig', function () {
        openLightbox($(this).attr('src'), $(this).attr('title') || '');
    });
}

function ensureFallbackMediaRender(messageIndex, message) {
    const el = $(`.mes[mesid="${messageIndex}"]`);
    if (!el.length) return;
    const media = Array.isArray(message?.extra?.media) ? message.extra.media : [];
    if (!media.length) return;

    let wrapper = el.find('.mes_media_wrapper');
    if (!wrapper.length) {
        wrapper = $('<div class="mes_media_wrapper"></div>');
        const textEl = el.find('.mes_text');
        if (textEl.length) textEl.after(wrapper);
        else el.append(wrapper);

        for (const m of media) {
            const container = $('<div class="mes_img_container"></div>');
            const img = $('<img class="mes_img" loading="lazy">')
                .attr('src', m.url)
                .attr('title', m.title || '');
            img.on('error', function () {
                $(this).closest('.mes_img_container').addClass('rpig-img-error');
            });
            container.append(img);
            wrapper.append(container);
        }
    }

    bindMediaLightbox(messageIndex);
}

function openLightbox(src, title) {
    if (!src) return;
    const overlay = $('<div class="rpig-lightbox"></div>');
    const img = $('<img class="rpig-lightbox-img">').attr('src', src);
    const cap = $('<div class="rpig-lightbox-caption"></div>').text(title || '');
    overlay.append(img).append(cap);

    const closeHandler = () => {
        $(document).off('keydown.rpigLightbox');
        overlay.remove();
    };

    overlay.on('click', closeHandler);
    $(document).off('keydown.rpigLightbox').on('keydown.rpigLightbox', (e) => {
        if (e.key === 'Escape') closeHandler();
    });
    $('body').append(overlay);
}

async function openGallery(characterOrId) {
    const lc = getContext();
    let character = null;
    if (typeof characterOrId === 'object' && characterOrId) {
        character = characterOrId;
    } else if (typeof characterOrId === 'number' || typeof characterOrId === 'string') {
        character = lc.characters && lc.characters[characterOrId];
    }
    if (!character) character = getCurrentCharacter();

    const charName = character ? (character.name || '角色') : '当前会话';
    const allImages = await getAllImagesForCharacter(character, getContext);

    const overlay = $(`<div class="rpig-gallery-overlay">
        <div class="rpig-gallery-header">
            <b class="rpig-gallery-header-title"></b>
            <button class="menu_button" id="rpig-gallery-close">✕ 关闭</button>
        </div>
        <div id="rpig-gallery-grid" class="rpig-gallery-grid"></div>
    </div>`);

    overlay.find('.rpig-gallery-header-title').text(`📚 角色图库 · ${charName}（共 ${allImages.length} 张）`);
    const grid = overlay.find('#rpig-gallery-grid');

    if (!allImages.length) {
        grid.append($('<div class="rpig-gallery-empty">暂无图片 —— 点击消息旁的 🎬 或在面板中生成配图后，会自动呈现在此</div>'));
    } else {
        allImages.forEach((entry, index) => {
            const src = entry.url;
            const card = $(`<div class="rpig-gallery-card">
                <img loading="lazy">
                <div class="rpig-gallery-card-footer">
                    <span class="rpig-gallery-card-title"></span>
                    <span class="rpig-gallery-card-time"></span>
                </div>
                <div class="rpig-gallery-card-actions">
                    <button class="rpig-dl" title="下载原图">⬇</button>
                    <button class="rpig-del" title="彻底删除">✕</button>
                </div>
            </div>`);

            card.find('img').attr('src', src).attr('title', entry.title || '');
            card.find('.rpig-gallery-card-title').text(entry.title || '配图');
            card.find('.rpig-gallery-card-time').text(new Date(entry.time || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));

            card.find('img').on('click', () => openLightbox(src, entry.title || '配图'));
            card.find('.rpig-dl').on('click', (e) => {
                e.stopPropagation();
                const a = document.createElement('a');
                a.href = src;
                a.download = `rpig_${charName}_${index + 1}.png`;
                document.body.appendChild(a);
                a.click();
                a.remove();
            });

            card.find('.rpig-del').on('click', async (e) => {
                e.stopPropagation();
                try {
                    await deleteImageCompletely(character, src, getContext);
                    toastr.success('已从图库与聊天中彻底删除');
                    card.fadeOut(180, function () {
                        $(this).remove();
                        const remaining = grid.find('.rpig-gallery-card').length;
                        overlay.find('.rpig-gallery-header-title').text(`📚 角色图库 · ${charName}（共 ${remaining} 张）`);
                        if (remaining === 0) {
                            grid.append($('<div class="rpig-gallery-empty">暂无图片</div>'));
                        }
                    });
                } catch (delErr) {
                    toastr.error(`删除失败：${escapeHtml(delErr.message || delErr)}`);
                }
            });
            grid.append(card);
        });
    }

    const closeHandler = () => {
        $(document).off('keydown.rpigGallery');
        overlay.remove();
    };

    overlay.find('#rpig-gallery-close').on('click', closeHandler);
    overlay.on('click', (e) => { if (e.target === overlay[0]) closeHandler(); });
    $(document).off('keydown.rpigGallery').on('keydown.rpigGallery', (e) => {
        if (e.key === 'Escape') closeHandler();
    });
    $('body').append(overlay);
}

let rpigGenerating = false;
let rpigActiveTask = null;
let rpigTaskSequence = 0;
const rpigGenerationQueue = [];

function setGenStatus(phase, text) {
    const fab = $('.rpig-fab');
    const statusTextEl = $('#rpig-fab-gen-status');
    const cleanText = escapeHtml(scrubSensitiveText(text));

    if (phase === 'working') {
        fab.addClass('rpig-busy');
        if (statusTextEl.length) statusTextEl.html(`<span class="rpig-spinner"></span> ${cleanText}`).show();
    } else if (phase === 'done') {
        fab.removeClass('rpig-busy');
        if (statusTextEl.length) statusTextEl.html(`✅ ${cleanText}`).show();
        setTimeout(() => { if (!rpigGenerating) statusTextEl.fadeOut(); }, 4000);
    } else if (phase === 'error') {
        fab.removeClass('rpig-busy');
        if (statusTextEl.length) statusTextEl.html(`❌ ${cleanText}`).show();
    } else {
        fab.removeClass('rpig-busy');
        if (statusTextEl.length) statusTextEl.hide();
    }
}

function updateGenerationQueueUI() {
    const taskbar = $('#rpig-taskbar');
    const summary = $('#rpig-task-summary');
    const taskList = $('#rpig-task-list');
    const active = rpigActiveTask;
    const waiting = rpigGenerationQueue.length;
    const hasTasks = !!active || waiting > 0;

    taskbar.toggle(hasTasks);
    $('#rpig-cancel-current').prop('disabled', !active);
    $('#rpig-clear-queue').prop('disabled', waiting === 0);
    if (summary.length) {
        const activeLabel = active ? `进行中：消息 ${active.messageIndex + 1}` : '当前无运行任务';
        summary.text(`${activeLabel} · 排队 ${waiting}`);
    }
    if (taskList.length) {
        taskList.empty().toggle(waiting > 0);
        for (const [index, task] of rpigGenerationQueue.entries()) {
            const mode = task.explicitShotMode || getSettings()?.shotMode || 'snapshot';
            const label = mode === 'portrait' ? '表情特写' : '剧情剧照';
            taskList.append(
                $('<div class="rpig-queued-task">').append(
                    $('<span>').text(`${index + 1}. 消息 ${task.messageIndex + 1} · ${label}`),
                    $('<button type="button" class="rpig-cancel-queued" title="取消此排队任务">取消</button>').attr('data-task-id', task.id),
                ),
            );
        }
    }
}

function cancelCurrentGeneration() {
    if (!rpigActiveTask) return;
    rpigActiveTask.controller.abort(createAbortError('用户取消了当前生成任务'));
    updateGenerationQueueUI();
}

function clearQueuedGenerations() {
    if (rpigGenerationQueue.length === 0) return;
    const removed = rpigGenerationQueue.splice(0);
    for (const task of removed) {
        task.resolve({ cancelled: true, queued: true });
    }
    updateGenerationQueueUI();
    toastr.info(`已清空 ${removed.length} 个排队任务`);
}

function cancelQueuedGeneration(taskId) {
    const index = rpigGenerationQueue.findIndex(task => task.id === taskId);
    if (index < 0) return;
    const [task] = rpigGenerationQueue.splice(index, 1);
    task.resolve({ cancelled: true, queued: true });
    updateGenerationQueueUI();
    toastr.info(`已取消消息 ${task.messageIndex + 1} 的排队任务`);
}

function reviewFinalPrompt({ prompt, avoid, sceneAnchor, visibleCharacters, excludedCharacters, refs, shotLabel, signal }) {
    throwIfAborted(signal);
    $('.rpig-prompt-review-overlay').remove();
    $('body').removeClass('rpig-review-open');

    const overlay = $(`<div class="rpig-prompt-review-overlay">
        <div class="rpig-prompt-review-dialog" role="dialog" aria-modal="true" aria-label="最终提示词预览">
            <div class="rpig-prompt-review-header">
                <div><b>📝 最终提示词预览</b><small></small></div>
                <button type="button" class="rpig-prompt-review-close" title="取消本次任务">✕</button>
            </div>
            <div class="rpig-prompt-review-note">导演与总结分析已经完成；只有点击“确认并生成”后才会请求图片后端。</div>
            <label>最终正向提示词<textarea id="rpig-review-prompt" rows="10"></textarea></label>
            <div class="rpig-review-counter" id="rpig-review-prompt-count"></div>
            <label>负向提示词<textarea id="rpig-review-avoid" rows="4"></textarea></label>
            <div class="rpig-prompt-review-meta"></div>
            <div class="rpig-prompt-review-actions">
                <button type="button" class="menu_button rpig-review-reset">恢复 AI 原稿</button>
                <button type="button" class="menu_button rpig-review-cancel">取消任务</button>
                <button type="button" class="menu_button rpig-btn-action-primary rpig-review-confirm">确认并生成</button>
            </div>
        </div>
    </div>`);
    const promptInput = overlay.find('#rpig-review-prompt').val(prompt || '');
    const avoidInput = overlay.find('#rpig-review-avoid').val(avoid || '');
    overlay.find('.rpig-prompt-review-header small').text(shotLabel || '配图');
    const characterText = Array.isArray(visibleCharacters) && visibleCharacters.length
        ? visibleCharacters.map(item => typeof item === 'string' ? item : (item.name || item.character || '')).filter(Boolean).join('、')
        : '由最终提示词决定';
    const excludedCharacterText = Array.isArray(excludedCharacters) && excludedCharacters.length
        ? excludedCharacters.join('、')
        : '无';
    const referenceText = Array.isArray(refs) && refs.length
        ? refs.map(ref => ref.label || '参考图').join('；')
        : '无';
    overlay.find('.rpig-prompt-review-meta').append(
        $('<div>').append($('<b>').text('场景锚点：'), document.createTextNode(sceneAnchor || '未指定')),
        $('<div>').append($('<b>').text('入镜角色：'), document.createTextNode(characterText)),
        $('<div>').append($('<b>').text('明确不入镜：'), document.createTextNode(excludedCharacterText)),
        $('<div>').append($('<b>').text('参考图片：'), document.createTextNode(referenceText)),
    );

    const updateCount = () => overlay.find('#rpig-review-prompt-count').text(`${String(promptInput.val() || '').length} 字符`);
    promptInput.on('input', updateCount);
    updateCount();
    $('body').addClass('rpig-review-open').append(overlay);
    const shouldAutofocusPromptReview = typeof window.matchMedia !== 'function'
        || window.matchMedia('(min-width: 601px) and (pointer: fine)').matches;
    if (shouldAutofocusPromptReview) {
        setTimeout(() => promptInput.trigger('focus'), 0);
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            signal?.removeEventListener('abort', onAbort);
            $(document).off('keydown.rpigPromptReview');
            $('body').removeClass('rpig-review-open');
            overlay.remove();
        };
        const finish = result => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const onAbort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(signal.reason instanceof Error ? signal.reason : createAbortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        overlay.find('.rpig-review-confirm').on('click', () => {
            const editedPrompt = String(promptInput.val() || '').trim();
            if (!editedPrompt) {
                toastr.warning('最终正向提示词不能为空');
                promptInput.trigger('focus');
                return;
            }
            finish({ confirmed: true, prompt: editedPrompt, avoid: String(avoidInput.val() || '').trim() });
        });
        overlay.find('.rpig-review-reset').on('click', () => {
            promptInput.val(prompt || '');
            avoidInput.val(avoid || '');
            updateCount();
        });
        overlay.find('.rpig-review-cancel, .rpig-prompt-review-close').on('click', () => finish({ confirmed: false }));
        overlay.on('click', event => {
            if (event.target !== overlay[0]) return;
            const dialog = overlay.find('.rpig-prompt-review-dialog');
            dialog.removeClass('rpig-review-attention');
            // 强制浏览器重排，以便连续误点时动画仍会重新播放。
            void dialog[0]?.offsetWidth;
            dialog.addClass('rpig-review-attention');
            setTimeout(() => dialog.removeClass('rpig-review-attention'), 360);
        });
        $(document).off('keydown.rpigPromptReview').on('keydown.rpigPromptReview', event => {
            if (event.key === 'Escape') finish({ confirmed: false });
        });
    });
}

function generateForMessage(messageIndex, presetPrompt, explicitShotMode, presetAvoid, generationMeta = {}) {
    return new Promise(resolve => {
        const task = {
            id: ++rpigTaskSequence,
            messageIndex,
            presetPrompt,
            explicitShotMode,
            presetAvoid,
            generationMeta,
            controller: new AbortController(),
            resolve,
        };
        rpigGenerationQueue.push(task);
        updateGenerationQueueUI();
        if (rpigActiveTask) {
            toastr.info(`任务已加入队列，前方还有 ${rpigGenerationQueue.length - 1} 个任务`);
        }
        void processGenerationQueue();
    });
}

async function processGenerationQueue() {
    if (rpigActiveTask) return;
    while (rpigGenerationQueue.length > 0) {
        const task = rpigGenerationQueue.shift();
        rpigActiveTask = task;
        rpigGenerating = true;
        updateGenerationQueueUI();
        try {
            const result = await executeGenerationTask(task);
            task.resolve(result);
            if (!result?.success && !result?.error && !result?.cancelled) {
                setGenStatus('idle', '');
            }
        } catch (error) {
            task.resolve({ cancelled: isAbortError(error), error });
        } finally {
            rpigActiveTask = null;
            rpigGenerating = false;
            updateGenerationQueueUI();
        }
    }
}

async function executeGenerationTask(task) {
    const { messageIndex, presetPrompt, explicitShotMode, presetAvoid, generationMeta = {}, controller } = task;
    const signal = controller.signal;
    throwIfAborted(signal);

        const context = getContext();
        const capturedChat = context.chat;
        const capturedSessionKey = getChatSessionKey(context);

        if (!Array.isArray(capturedChat) || messageIndex < 0 || messageIndex >= capturedChat.length) {
            return;
        }

        const capturedMessage = capturedChat[messageIndex];
        if (!capturedMessage || capturedMessage.is_user) return;

        const capturedMes = capturedMessage.mes;
        const capturedSwipeId = capturedMessage.swipe_id !== undefined ? capturedMessage.swipe_id : null;
        const capturedSendDate = capturedMessage.send_date || '';

        const isSessionStillValid = () => {
            const curContext = getContext();
            if (getChatSessionKey(curContext) !== capturedSessionKey) return false;
            if (curContext.chat !== capturedChat) return false;
            const curMessage = curContext.chat[messageIndex];
            if (curMessage !== capturedMessage) return false;
            if (curMessage.mes !== capturedMes) return false;
            if ((curMessage.swipe_id !== undefined ? curMessage.swipe_id : null) !== capturedSwipeId) return false;
            if ((curMessage.send_date || '') !== capturedSendDate) return false;
            return true;
        };

        const s = getSettings();
        const character = getCharacterForMessage(capturedMessage) || getCurrentCharacter();
        const previousGenerated = s.usePreviousImage !== false
            ? getPreviousGeneratedImage(capturedChat, messageIndex, character, {
                strictCharacterMatch: context.groupId !== undefined && context.groupId !== null && context.groupId !== '',
            })
            : null;
        let prompt = presetPrompt || '';
        let directorDraft = prompt;
        let omniscientDraft = '';
        let visibleCharacters = [];
        let excludedCharacters = [];
        let finalizerApplied = false;
        let avoid = presetAvoid || '';
        let sceneAnchor = (generationMeta.sceneAnchor || '').trim();
        let sceneChanged = generationMeta.sceneChanged;
        let result;

        try {
            const shotMode = explicitShotMode || s.shotMode || 'snapshot';
            const shotLabel = shotMode === 'portrait' ? '👤 微表情特写' : '🎬 剧情剧照';
            const promptFormat = resolvePromptFormat(s);
            toastr.info(`🎬 开始构思并生成配图（${shotLabel}）…`, '', { timeOut: 3000 });

            const windowSize = Math.max(2, parseInt(s.autoWindow, 10) || 12);
            const dialogueHistory = buildDialogueContext(capturedChat, messageIndex, windowSize);
            const participantContext = buildParticipantContext(
                context,
                capturedChat,
                messageIndex,
                character,
                s.characterAnchors || {},
            );

            // 第一部分：沿用原有导演视角，锁定最新回合和焦点角色。
            if (!directorDraft) {
                setGenStatus('working', `①/⑤ 🧠 焦点镜头分析（${shotLabel}）…`);
                const { system, userText } = buildDirectorPrompt({
                    character,
                    currentMessageText: capturedMes || '',
                    dialogueHistory,
                    shotMode,
                    promptFormat,
                    stylePreset: s.stylePreset || 'character',
                    customAnchors: s.characterAnchors || {},
                    continuityContext: previousGenerated?.prompt || '',
                    hideHandsFeet: false,
                });

                if (!isSessionStillValid()) {
                    toastr.info('消息内容已被改写、滑动或会话已切换，已中止并丢弃该配图生成任务');
                    return;
                }
                const raw = await callLLM(system, userText, s, getContext, { signal });
                if (!isSessionStillValid()) {
                    toastr.info('消息内容已被改写、滑动或会话已切换，已中止并丢弃该配图生成任务');
                    return;
                }
                const json = extractJson(raw) || {};
                directorDraft = (json.final_prompt || '').trim();
                avoid = mergeNegativePrompts(avoid, (json.avoid || '').trim());
                sceneAnchor = (json.scene_anchor || sceneAnchor || '').trim();
                sceneChanged = json.scene_changed !== false;
                if (!directorDraft) throw new Error('焦点镜头 LLM 未能生成有效提示词');
            }

            // 第二部分：上帝视角核对所有在场人物及其空间、视线和互动关系。
            if (s.omniscientMode !== false) {
                setGenStatus('working', '②/⑤ 👁️ 上帝视角分析所有在场人物…');
                try {
                    const omniscientRequest = buildOmniscientPrompt({
                        currentMessageText: capturedMes || '',
                        dialogueHistory,
                        participantContext,
                        directorDraft,
                        sceneAnchor,
                        shotMode,
                        stylePreset: s.stylePreset || 'character',
                        hideHandsFeet: false,
                    });
                    const omniscientRaw = await callLLM(
                        omniscientRequest.system,
                        omniscientRequest.userText,
                        s,
                        getContext,
                        { signal },
                    );
                    if (!isSessionStillValid()) {
                        toastr.info('消息内容已被改写、滑动或会话已切换，已中止并丢弃该配图生成任务');
                        return;
                    }
                    const omniscientJson = extractJson(omniscientRaw) || {};
                    omniscientDraft = String(omniscientJson.ensemble_prompt || omniscientJson.final_prompt || '').trim();
                    const castContext = {
                        context,
                        chat: capturedChat,
                        messageIndex,
                        focalCharacter: character,
                    };
                    visibleCharacters = normalizeCastCharacters(omniscientJson.visible_characters, castContext);
                    excludedCharacters = normalizeCastCharacters(omniscientJson.excluded_characters, {
                        ...castContext,
                        fallbackToFocal: false,
                    }).filter(name => !visibleCharacters.includes(name));
                    sceneAnchor = String(omniscientJson.scene_anchor || sceneAnchor || '').trim();
                    avoid = mergeNegativePrompts(avoid, String(omniscientJson.avoid || '').trim());
                } catch (error) {
                    if (isAbortError(error)) throw error;
                    const safeMessage = scrubSensitiveText(error?.message || String(error));
                    console.warn('[RP 电影配图] 上帝视角分析失败，继续使用焦点镜头：', safeMessage);
                    toastr.warning(`上帝视角分析失败，已保留焦点镜头继续总结：${escapeHtml(safeMessage)}`);
                    visibleCharacters = normalizeCastCharacters([], {
                        context,
                        chat: capturedChat,
                        messageIndex,
                        focalCharacter: character,
                    });
                }
            } else {
                setGenStatus('working', '②/⑤ 👁️ 上帝视角已关闭，使用原有焦点镜头');
            }

            // 第三部分：总结 LLM 消除冲突，只输出一整段可直接送给生图模型的提示词。
            setGenStatus('working', '③/⑤ ✍️ 总结 LLM 正在合成最终提示词…');
            const finalizerRequest = buildFinalizerPrompt({
                directorDraft,
                omniscientDraft,
                currentMessageText: capturedMes || '',
                participantContext,
                visibleCharacters,
                excludedCharacters,
                sceneAnchor,
                continuityContext: previousGenerated?.prompt || '',
                shotMode,
                stylePreset: s.stylePreset || 'character',
                hideHandsFeet: false,
            });
            try {
                const finalizerRaw = await callLLM(
                    finalizerRequest.system,
                    finalizerRequest.userText,
                    getFinalizerLlmSettings(s),
                    getContext,
                    { signal },
                );
                if (!isSessionStillValid()) {
                    toastr.info('消息内容已被改写、滑动或会话已切换，已中止并丢弃该配图生成任务');
                    return;
                }
                prompt = normalizeFinalPromptOutput(finalizerRaw);
                if (!prompt) throw new Error('总结 LLM 返回空内容或策略拦截信息');
                finalizerApplied = true;
            } catch (error) {
                if (isAbortError(error)) throw error;
                const safeMessage = scrubSensitiveText(error?.message || String(error));
                console.warn('[RP 电影配图] 总结 LLM 失败，使用两份分析的安全合并结果：', safeMessage);
                toastr.warning(`总结 LLM 失败，已自动合并两份分析继续生成：${escapeHtml(safeMessage)}`);
                prompt = collapsePromptToSingleParagraph([directorDraft, omniscientDraft].filter(Boolean).join(' '));
            }

            if (s.omniscientMode !== false) {
                prompt = enforceOmniscientEnsemble(prompt, visibleCharacters, excludedCharacters);
            }

            const basePrompt = prompt;
            const refs = [];
            const pushUniqueRef = (ref) => {
                if (!(ref?.url || ref?.dataUrl)) return;
                if (refs.some(existing =>
                    (ref.url && existing.url === ref.url) ||
                    (ref.dataUrl && existing.dataUrl === ref.dataUrl))) return;
                refs.push(ref);
            };

            let avatarData = '';
            if (s.useCharacterImage !== false && character) {
                avatarData = await getCharacterAvatarDataUrl(character) || '';
            }
            const charRefs = character ? await getCharacterRefs(character) : [];
            if (avatarData) {
                pushUniqueRef({
                    dataUrl: avatarData,
                    label: '角色卡原图 · 第一优先级身份锚点',
                    kind: 'identity-primary',
                });
            } else if (charRefs.length) {
                const firstSavedRef = charRefs[0];
                pushUniqueRef({
                    ...firstSavedRef,
                    label: `${firstSavedRef.label || '角色参考图'} · 第一优先级身份锚点`,
                    kind: 'identity-primary',
                });
            }

            if (previousGenerated?.url) {
                pushUniqueRef({
                    url: previousGenerated.url,
                    label: '上一张剧情图 · 仅用于服装与镜头连续性',
                    kind: 'continuity',
                });
            }

            for (const r of charRefs) {
                pushUniqueRef({ ...r, kind: r.kind || 'identity-secondary' });
            }

            prompt = collapsePromptToSingleParagraph(buildSceneAwareImagePrompt({
                basePrompt: prompt,
                sceneAnchor,
                hasIdentityReference: refs.some(r => r.kind === 'identity-primary'),
                hasContinuityReference: !!previousGenerated?.url,
                promptFormat,
            }));
            const sameMessageReference = previousGenerated?.sourceType === 'same_message';

            throwIfAborted(signal);
            if (s.previewBeforeGeneration !== false && generationMeta.automatic !== true) {
                setGenStatus('working', '④/⑤ 📝 等待确认最终提示词…');
                const review = await reviewFinalPrompt({
                    prompt,
                    avoid,
                    sceneAnchor,
                    visibleCharacters,
                    excludedCharacters,
                    refs,
                    shotLabel,
                    signal,
                });
                if (!review.confirmed) {
                    setGenStatus('idle', '');
                    toastr.info('已取消本次生成，未请求图片后端');
                    return { cancelled: true, beforeBackend: true };
                }
                prompt = review.prompt;
                avoid = review.avoid;
            }

            setGenStatus('working', `④/⑤ 🖼 后端渲染中（${shotLabel}）…`);
            result = await generateImage(s, prompt, avoid, refs, {
                fetchToDataUrl,
                onWarning: (msg) => toastr.warning(escapeHtml(msg), '', { timeOut: 6000 }),
                slashCommandParser: SlashCommandParser,
                continuityReference: !!previousGenerated,
                sceneChanged: sameMessageReference ? false : sceneChanged !== false,
                denoisingStrength: previousGenerated
                    ? Math.min(0.85, Math.max(0.2, Number(s.continuityDenoising) || 0.48))
                    : undefined,
                signal,
            });

            if (previousGenerated && result.usedRefs === false) {
                toastr.warning('⚠️ 当前后端未实际使用上一张参考图，本次仅靠文字维持造型；建议检查 /images/edits 或图生图配置', '', { timeOut: 9000 });
            }

            if (!isSessionStillValid()) {
                toastr.info('消息内容已被改写、滑动或会话已切换，已中止并丢弃该配图生成任务');
                return;
            }

            setGenStatus('working', '⑤/⑤ 💾 正在持久化并挂载…');
            throwIfAborted(signal);
            const rawImageData = result.dataUrl || result.imageUrl;

            let persistedUrl = rawImageData;
            try {
                persistedUrl = await persistMediaUrl(rawImageData, character?.name, {
                    saveBase64AsFile,
                    fetchToDataUrl,
                });
            } catch (pErr) {
                if (isAbortError(pErr)) throw pErr;
                toastr.warning(`图片持久化失败，使用临时 Data URL：${escapeHtml(pErr.message || pErr)}`);
                persistedUrl = rawImageData;
            }

            if (!isSessionStillValid()) {
                toastr.info('消息内容已被改写、滑动或会话已切换，已中止并丢弃该配图生成任务');
                return;
            }
            throwIfAborted(signal);

            if (!capturedMessage.extra) capturedMessage.extra = {};
            migrateLegacyMedia(capturedMessage);
            const media = Array.isArray(capturedMessage.extra.media) ? capturedMessage.extra.media : [];
            media.push({
                url: persistedUrl,
                title: (presetPrompt ? '配图' : `RP ${shotLabel}`) + ` · ${result.model}`,
            });
            capturedMessage.extra.media = media;
            capturedMessage.extra.media_display = 'list';
            capturedMessage.extra.rpigInfo = {
                outputUrl: persistedUrl,
                targetIndex: messageIndex,
                focusSnippet: stripHtml(capturedMes || '').slice(0, 80),
                basePrompt,
                prompt: result.usedPrompt || prompt,
                avoid: result.usedAvoid || avoid,
                backend: s.backend,
                model: result.model,
                time: Date.now(),
                continuitySourceIndex: previousGenerated?.messageIndex ?? null,
                continuitySourceType: previousGenerated?.sourceType || null,
                referenceApplied: result.usedRefs === true,
                sceneAnchor,
                sceneChanged: sceneChanged !== false,
                directorDraft,
                omniscientDraft,
                visibleCharacters,
                excludedCharacters,
                finalizerApplied,
            };

            const el = $(`.mes[mesid="${messageIndex}"]`);
            el.addClass('rpig-media-message');

            try {
                updateMessageBlock(messageIndex, capturedMessage);
            } catch { /* ignore */ }

            ensureFallbackMediaRender(messageIndex, capturedMessage);

            try {
                if (typeof context.saveChat === 'function') {
                    await context.saveChat();
                }
            } catch (saveErr) {
                const safeSaveErr = scrubSensitiveText(saveErr.message || String(saveErr));
                toastr.error(`❌ 会话保存失败：${escapeHtml(safeSaveErr)}`);
                throw saveErr;
            }

            try {
                const entry = {
                    url: persistedUrl,
                    title: `RP ${shotLabel}`,
                    prompt: result.usedPrompt || prompt,
                    backend: s.backend,
                    model: result.model,
                    time: Date.now(),
                };
                await saveToGallery(character, entry);
            } catch (gErr) {
                console.warn('[RP 电影配图] 图库归档失败:', gErr);
            }

            setGenStatus('done', `${shotLabel}已生成并挂载！`);
            toastr.success(`✨ ${shotLabel}生成成功并已挂载到聊天！`, '', { timeOut: 4000 });
            return { success: true, url: persistedUrl };
        } catch (error) {
            if (isAbortError(error)) {
                setGenStatus('idle', '');
                toastr.info('已取消当前生成任务');
                return { cancelled: true };
            }
            const safeErrMsg = scrubSensitiveText(error.message || String(error));
            setGenStatus('error', safeErrMsg);
            toastr.error(`❌ 生成失败：${escapeHtml(safeErrMsg)}`, '', { timeOut: 12000 });
            return { error };
        }
}

async function generateCharacterSheetFlow({
    targetCharacter = null,
    type = 'three_views',
    customPrompt = '',
    autoAddToRefs = true,
    denoisingStrength = 0.55,
}) {
    const character = targetCharacter || getCurrentCharacter();
    if (!character) throw new Error('请先选择一个绑定的角色');

    const avatarData = await getCharacterAvatarDataUrl(character);
    if (!avatarData) throw new Error(`未找到角色「${character.name || ''}」的头像图片，请确保酒馆中该角色有头像`);

    const s = getSettings();
    const isTags = resolvePromptFormat(s) === 'tags';
    const { prompt, avoid } = buildCharacterSheetPrompt({
        character,
        type,
        isTags,
        customPrompt,
    });

    setGenStatus('working', '🎨 正在以原图为参考进行图生图渲染…');
    const refs = [{ dataUrl: avatarData, label: '角色卡原图' }];
    const result = await generateImage(s, prompt, avoid, refs, {
        denoisingStrength,
        fetchToDataUrl,
        onWarning: (msg) => toastr.warning(escapeHtml(msg)),
        slashCommandParser: SlashCommandParser,
        disableLimbSafeComposition: true,
    });

    const rawResultUrl = result.dataUrl || result.imageUrl;
    let addedToRefs = false;
    let persistedUrl = '';
    let isPersisted = false;

    if (rawResultUrl && character) {
        try {
            persistedUrl = await persistMediaUrl(rawResultUrl, character?.name, {
                saveBase64AsFile,
                fetchToDataUrl,
            });
            isPersisted = true;
        } catch (pErr) {
            console.warn('[RP 电影配图] 形象持久化失败:', pErr);
            toastr.warning(`形象图片持久化失败，仅作为临时预览：${escapeHtml(pErr.message || pErr)}`);
            isPersisted = false;
        }

        const label = type === 'three_views' ? '📐 图生图三视图' : '🧍 图生图全身立绘';
        if (isPersisted && autoAddToRefs) {
            const views = await getCharacterRefs(character);
            if (views.length < MAX_REFS_PER_CHAR) {
                if (!views.some(v => v.url === persistedUrl)) {
                    views.push({
                        url: persistedUrl,
                        label: `${label} · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
                    });
                    await saveCharacterRefs(character, views);
                    addedToRefs = true;
                }
            }
        }
        if (isPersisted) {
            try {
                await saveToGallery(character, {
                    url: persistedUrl,
                    title: label,
                    prompt,
                    backend: s.backend,
                    model: result.model,
                    time: Date.now(),
                });
            } catch { /* ignore gallery failure */ }
        }
    }

    setGenStatus('done', '图生图形象生成完成！');
    return {
        character,
        type,
        prompt,
        imageUrl: (isPersisted ? persistedUrl : rawResultUrl),
        persistedUrl: isPersisted ? persistedUrl : '',
        isPersisted,
        dataUrl: result.dataUrl,
        model: result.model,
        addedToRefs,
    };
}

const rpigRendering = new Set();

function injectManualButton(messageIndex) {
    if (typeof messageIndex !== 'number' || messageIndex < 0) return;
    if (rpigRendering.has(messageIndex)) return;
    rpigRendering.add(messageIndex);

    try {
        const context = getContext();
        const chat = context.chat || [];
        const message = chat[messageIndex];
        if (!message || message.is_user) return;

        const messageElement = $(`.mes[mesid="${messageIndex}"]`);
        if (!messageElement.length) return;

        if (migrateLegacyMedia(message)) {
            try {
                if (typeof context.saveChat === 'function') context.saveChat();
            } catch { /* ignore */ }
        }

        const hasMedia = Array.isArray(message.extra?.media) && message.extra.media.length > 0;
        if (hasMedia) {
            messageElement.addClass('rpig-media-message');
            bindMediaLightbox(messageIndex);
        }

        if (messageElement.find('.rpig-btn-wrap').length) return;

        const wrap = $(`<div class="rpig-btn-wrap">
            <div class="mes_button rpig-btn-manual" title="生成配图（单击按默认模式，悬浮/长按选择镜头）" data-i18n="rpig_gen">🎬</div>
            <div class="rpig-shot-popup">
                <div class="rpig-shot-item" data-mode="snapshot" title="剧情剧照抓拍：人景互动、动作抓拍、真实机位">🎬 剧照抓拍</div>
                <div class="rpig-shot-item" data-mode="portrait" title="角色微表情特写：神态眼神、微妙情绪、微表情">👤 表情特写</div>
            </div>
        </div>`);

        const mainBtn = wrap.find('.rpig-btn-manual');
        const popup = wrap.find('.rpig-shot-popup');

        let preventNextClick = false;

        mainBtn.on('click', async function (e) {
            e.stopPropagation();
            if (preventNextClick) {
                preventNextClick = false;
                return;
            }
            if (mainBtn.hasClass('rpig-busy')) return;
            popup.removeClass('rpig-show');
            mainBtn.addClass('rpig-busy').attr('title', '生成中…');
            try {
                await generateForMessage(messageIndex);
            } finally {
                mainBtn.removeClass('rpig-busy').attr('title', '生成配图');
            }
        });

        wrap.find('.rpig-shot-item').on('click', async function (e) {
            e.stopPropagation();
            if (mainBtn.hasClass('rpig-busy')) return;
            const mode = $(this).attr('data-mode');
            popup.removeClass('rpig-show');
            mainBtn.addClass('rpig-busy').attr('title', '生成中…');
            try {
                await generateForMessage(messageIndex, null, mode);
            } finally {
                mainBtn.removeClass('rpig-busy').attr('title', '生成配图');
            }
        });

        let hoverTimer = null;
        wrap.on('mouseenter', function () {
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => { popup.addClass('rpig-show'); }, 180);
        }).on('mouseleave', function () {
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => { popup.removeClass('rpig-show'); }, 220);
        });

        let touchTimer = null;
        mainBtn.on('touchstart', function () {
            touchTimer = setTimeout(() => {
                preventNextClick = true;
                popup.toggleClass('rpig-show');
            }, 450);
        }).on('touchend touchcancel', function () {
            clearTimeout(touchTimer);
        });

        messageElement.find('.mes_buttons').append(wrap);

        if (!messageElement.find('.rpig-btn-gallery').length) {
            const gBtn = $(`<div class="mes_button rpig-btn-gallery" title="打开角色图片库" data-i18n="rpig_gallery">📚</div>`);
            gBtn.on('click', () => {
                const msgChar = getCharacterForMessage(message);
                openGallery(msgChar || getCurrentCharacter());
            });
            messageElement.find('.mes_buttons').append(gBtn);
        }
    } finally {
        rpigRendering.delete(messageIndex);
    }
}

function scanAndInjectAllMessages() {
    const context = getContext();
    const chat = context.chat || [];
    for (let i = 0; i < chat.length; i++) {
        if (!chat[i]?.is_user) {
            injectManualButton(i);
        }
    }
}

const UPSTREAM_MODELS_TIMEOUT_MS = 12000;

function normalizeModelsBaseUrl(raw, appendV1 = false) {
    let base = String(raw || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('请先填写接口地址');
    if (appendV1 && !/\/v\d+$/.test(base)) base += '/v1';
    return base;
}

function parseUpstreamModels(payload) {
    const entries = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.models)
                ? payload.models
                : Array.isArray(payload?.result)
                    ? payload.result
                    : [];
    return [...new Set(entries.map(item => typeof item === 'string'
        ? item
        : (item?.id || item?.name || item?.model || item?.model_name || item?.title || ''))
        .map(name => String(name || '').replace(/^models\//, '').trim())
        .filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
}

async function requestUpstreamModels(url, key, authHeader = 'Authorization') {
    const headers = { Accept: 'application/json' };
    const cleanKey = String(key || '').trim();
    if (cleanKey && cleanKey !== 'none') {
        headers[authHeader] = authHeader === 'Authorization' ? `Bearer ${cleanKey}` : cleanKey;
    }
    let response;
    try {
        response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(UPSTREAM_MODELS_TIMEOUT_MS),
        });
    } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            throw new Error('获取模型列表超时，请检查接口地址或网络');
        }
        throw new Error(`无法连接上游：${error?.message || error}`);
    }
    if (!response.ok) throw new Error(`获取模型列表失败：HTTP ${response.status}`);
    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new Error('上游返回的模型列表不是有效 JSON');
    }
    const models = parseUpstreamModels(payload);
    if (!models.length) throw new Error('上游未返回可用模型名');
    return models;
}

async function fetchImageModelsFromUpstream(settings) {
    if (settings.backend !== BACKENDS.OPENAI && settings.backend !== BACKENDS.GEMINI) {
        throw new Error('请先选择 OpenAI 兼容或 Gemini 图片后端');
    }
    const base = normalizeModelsBaseUrl(settings.backendUrl);
    return requestUpstreamModels(
        `${base}/models`,
        settings.backendKey,
        settings.backend === BACKENDS.GEMINI ? 'x-goog-api-key' : 'Authorization',
    );
}

async function fetchLlmModelsFromUpstream(settings) {
    if (settings.llmSource !== 'custom') {
        throw new Error('请先把 LLM 配置来源切换为“扩展内独立配置”');
    }
    const base = normalizeModelsBaseUrl(settings.llmUrl, true);
    return requestUpstreamModels(`${base}/models`, settings.llmKey);
}

function createUpstreamModelControl(input, fetchModels, onSelect) {
    const control = $('<div class="rpig-model-control"></div>');
    const button = $('<button type="button" class="menu_button">从上游获取</button>');
    const picker = $('<select style="display:none;width:100%;margin-top:4px;"></select>');
    
    const wrapper = $('<div style="display:flex;flex-direction:column;width:100%;gap:4px;"></div>');
    const inputRow = $('<div style="display:flex;gap:6px;width:100%;align-items:center;"></div>');
    inputRow.append(input).append(button);
    wrapper.append(inputRow).append(picker);
    control.append(wrapper);

    button.on('click', async () => {
        const originalText = button.text();
        button.prop('disabled', true).text('获取中…');
        try {
            const models = await fetchModels();
            const current = String(input.val() || '').trim();
            picker.empty().append($('<option value="">').text(`请选择模型（共 ${models.length} 个）`));
            if (current && !models.includes(current)) {
                picker.append($('<option>').val(current).text(`${current}（当前手动值）`));
            }
            for (const model of models) picker.append($('<option>').val(model).text(model));
            if (current) picker.val(current);
            picker.show();
            toastr.success(`已从上游获取 ${models.length} 个模型`);
        } catch (error) {
            toastr.error(error?.message || String(error), '获取模型失败');
        } finally {
            button.prop('disabled', false).text(originalText);
        }
    });

    picker.on('change', () => {
        const value = String(picker.val() || '').trim();
        if (!value) return;
        input.val(value);
        onSelect(value);
    });
    return control;
}

function buildSettingsUI() {
    const s = getSettings();
    const container = $(document.createElement('div')).addClass('rpig-settings');

    // ── 顶部标头与状态药丸 ──
    const header = $(`<div class="rpig-settings-header">
        <div class="rpig-header-left">
            <span class="rpig-header-title">🎬 RP 电影配图</span>
            <span class="rpig-header-version">v2.9.18</span>
        </div>
        <div class="rpig-status-pill" id="rpig-header-status-pill">
            <span class="rpig-status-dot"></span>
            <span class="rpig-status-text">就绪</span>
        </div>
    </div>`);
    container.append(header);

    const updateStatusPill = () => {
        const backendName = s.backend === BACKENDS.OPENAI ? 'OpenAI 兼容'
            : s.backend === BACKENDS.GEMINI ? 'Gemini'
            : s.backend === BACKENDS.SD ? 'Stable Diffusion'
            : s.backend === BACKENDS.COMFYUI ? 'ComfyUI'
            : '酒馆内置 SD';
        const modelName = s.backendModel ? ` · ${s.backendModel}` : '';
        header.find('.rpig-status-text').text(`${backendName}${modelName}`);
    };
    updateStatusPill();

    const row = (label, control, hint) => {
        const r = $(document.createElement('div')).addClass('rpig-row');
        if (label) r.append($('<label>').text(label));
        r.append(control);
        if (hint) {
            r.append($('<div class="rpig-hint">').text(hint));
        }
        return r;
    };

    const switchRow = (label, checkboxEl, hint) => {
        const r = $(document.createElement('div')).addClass('rpig-row');
        const switchWrapper = $('<label class="rpig-switch">');
        switchWrapper.append(checkboxEl);
        switchWrapper.append($('<span>').text(label));
        r.append(switchWrapper);
        if (hint) {
            r.append($('<div class="rpig-hint">').text(hint));
        }
        return r;
    };

    // 卡片创建辅助函数
    const createCard = (title, icon, isSpan2 = false) => {
        const card = $(`<div class="rpig-card ${isSpan2 ? 'rpig-card-span-2' : ''}">
            <div class="rpig-card-header">
                <div class="rpig-card-header-left">
                    <span class="rpig-card-title">${icon} ${title}</span>
                </div>
                <span class="rpig-card-chevron">▼</span>
            </div>
            <div class="rpig-card-body"></div>
        </div>`);
        card.find('.rpig-card-header').on('click', function () {
            card.toggleClass('rpig-collapsed');
        });
        return {
            card,
            body: card.find('.rpig-card-body'),
        };
    };

    const grid = $('<div class="rpig-settings-grid"></div>');

    // ==========================================
    // 卡片 1: 🖼 图片模型
    // ==========================================
    const card1 = createCard('图片模型', '🖼');
    const backendSelect = $('<select>')
        .append($('<option value="openai">OpenAI 兼容 images API（gpt-image / 国产兼容）</option>'))
        .append($('<option value="gemini">Google Gemini 图像模型</option>'))
        .append($('<option value="sd">本地 Stable Diffusion WebUI</option>'))
        .append($('<option value="comfyui">本地 ComfyUI</option>'))
        .append($('<option value="tavern-sd">酒馆内置 sd 命令</option>'))
        .val(s.backend);

    const urlInput = $('<input type="text" placeholder="接口地址，如 https://api.openai.com/v1 或 http://127.0.0.1:7860">').val(s.backendUrl);
    const keyInput = $('<input type="password" placeholder="API Key（OpenAI / Gemini 需要）">').val(s.backendKey);
    const modelInput = $('<input type="text" placeholder="如 gpt-image-1, dall-e-3, gemini-2.5-flash-image 等">').val(s.backendModel);

    const sdStepsInput = $('<input type="number" min="1" max="150" step="1">').val(s.sdSteps || 28);
    const sdCfgInput = $('<input type="number" min="1" max="30" step="0.5">').val(s.sdCfg || 7);
    const sdNegInput = $('<textarea placeholder="SD 负面提示词">').val(s.sdNegative || DEFAULT_SD_NEGATIVE);

    const comfyWorkflowInput = $('<textarea placeholder="粘贴 ComfyUI API 格式 Workflow JSON">').val(s.comfyWorkflow || '');
    const comfyPosNodeInput = $('<input type="text" placeholder="可选：正向提示词节点 ID（如 6）">').val(s.comfyPositiveNodeId || '');
    const comfyNegNodeInput = $('<input type="text" placeholder="可选：负向提示词节点 ID（如 7）">').val(s.comfyNegativeNodeId || '');
    const comfyImgNodeInput = $('<input type="text" placeholder="可选：参考图 LoadImage 节点 ID（如 10）">').val(s.comfyImageNodeId || '');

    const promptFormatSelect = $('<select>')
        .append($('<option value="auto">智能自动（SD/ComfyUI 用 Tag，API/Flux 用自然语言）</option>'))
        .append($('<option value="natural">强制英文自然语言长句（DALL·E 3 / Flux / 多数 API）</option>'))
        .append($('<option value="tags">强制 Danbooru Tag 标签流（SD / SDXL / 动漫模型）</option>'))
        .val(s.promptFormat || 'auto');

    const styleSelect = $('<select>')
        .append($('<option value="character">跟随角色卡画风（二次元/写实自适应，推荐）</option>'))
        .append($('<option value="anime">强制二次元动画风</option>'))
        .append($('<option value="realistic">电影写实风格</option>'))
        .val(s.stylePreset || 'character');

    const sizeSelect = $('<select>')
        .append($('<option value="16:9">16:9 电影感（默认推荐）</option>'))
        .append($('<option value="2.39:1">2.39:1 超宽银幕（仅 SD 完整支持）</option>'))
        .append($('<option value="1:1">1:1 方形</option>'))
        .append($('<option value="9:16">9:16 竖屏</option>'))
        .val(s.imageSize);

    const urlRow = row('接口地址', urlInput);
    const keyRow = row('API Key', keyInput);
    const imageModelControl = createUpstreamModelControl(
        modelInput,
        () => fetchImageModelsFromUpstream(s),
        value => { s.backendModel = value; saveSettingsDebounced(); updateStatusPill(); },
    );
    const modelRow = row('模型名称', imageModelControl, '点击“从上游获取”后可在下拉框选择，亦可手动输入');

    // 高级参数抽屉（SD / ComfyUI 参数）
    const advancedToggle = $('<div class="rpig-advanced-toggle">⚙️ 高级参数（SD 步数 / CFG / 负面词 / ComfyUI 工作流） ▾</div>');
    const advancedDrawer = $('<div class="rpig-advanced-drawer"></div>');
    advancedToggle.on('click', () => {
        advancedDrawer.toggleClass('rpig-open');
        advancedToggle.text(advancedDrawer.hasClass('rpig-open')
            ? '⚙️ 高级参数（SD 步数 / CFG / 负面词 / ComfyUI 工作流） ▴'
            : '⚙️ 高级参数（SD 步数 / CFG / 负面词 / ComfyUI 工作流） ▾');
    });

    const sdStepsRow = row('SD 步数 (Steps)', sdStepsInput);
    const sdCfgRow = row('SD CFG 引导系数', sdCfgInput);
    const sdNegRow = row('SD 负面词', sdNegInput);
    const comfyWorkflowRow = row('Workflow JSON', comfyWorkflowInput, '在 ComfyUI 中点击「Save (API Format)」导出的 JSON');
    const comfyPosRow = row('正向节点 ID', comfyPosNodeInput);
    const comfyNegRow = row('负向节点 ID', comfyNegNodeInput);
    const comfyImgRow = row('参考图节点 ID', comfyImgNodeInput);

    advancedDrawer.append(sdStepsRow, sdCfgRow, sdNegRow, comfyWorkflowRow, comfyPosRow, comfyNegRow, comfyImgRow);

    function updateBackendVisibility() {
        const cur = backendSelect.val();
        urlRow.toggle(cur !== BACKENDS.TAVERN_SD);
        keyRow.toggle(cur === BACKENDS.OPENAI || cur === BACKENDS.GEMINI);
        modelRow.toggle(cur === BACKENDS.OPENAI || cur === BACKENDS.GEMINI);
        sdStepsRow.toggle(cur === BACKENDS.SD);
        sdCfgRow.toggle(cur === BACKENDS.SD);
        sdNegRow.toggle(cur === BACKENDS.SD);
        comfyWorkflowRow.toggle(cur === BACKENDS.COMFYUI);
        comfyPosRow.toggle(cur === BACKENDS.COMFYUI);
        comfyNegRow.toggle(cur === BACKENDS.COMFYUI);
        comfyImgRow.toggle(cur === BACKENDS.COMFYUI);
        const hasAdvanced = cur === BACKENDS.SD || cur === BACKENDS.COMFYUI;
        advancedToggle.toggle(hasAdvanced);
        advancedDrawer.toggle(hasAdvanced);
    }

    backendSelect.on('change', () => {
        s.backend = backendSelect.val();
        updateBackendVisibility();
        saveSettingsDebounced();
        updateStatusPill();
    });

    urlInput.on('input', () => { s.backendUrl = urlInput.val(); saveSettingsDebounced(); });
    keyInput.on('input', () => { s.backendKey = keyInput.val(); saveSettingsDebounced(); });
    modelInput.on('input', () => { s.backendModel = modelInput.val(); saveSettingsDebounced(); updateStatusPill(); });
    sdStepsInput.on('input', () => { s.sdSteps = parseInt(sdStepsInput.val(), 10) || 28; saveSettingsDebounced(); });
    sdCfgInput.on('input', () => { s.sdCfg = parseFloat(sdCfgInput.val()) || 7; saveSettingsDebounced(); });
    sdNegInput.on('input', () => { s.sdNegative = sdNegInput.val(); saveSettingsDebounced(); });
    comfyWorkflowInput.on('input', () => { s.comfyWorkflow = comfyWorkflowInput.val(); saveSettingsDebounced(); });
    comfyPosNodeInput.on('input', () => { s.comfyPositiveNodeId = comfyPosNodeInput.val().trim(); saveSettingsDebounced(); });
    comfyNegNodeInput.on('input', () => { s.comfyNegativeNodeId = comfyNegNodeInput.val().trim(); saveSettingsDebounced(); });
    comfyImgNodeInput.on('input', () => { s.comfyImageNodeId = comfyImgNodeInput.val().trim(); saveSettingsDebounced(); });
    promptFormatSelect.on('change', () => { s.promptFormat = promptFormatSelect.val(); saveSettingsDebounced(); });
    styleSelect.on('change', () => { s.stylePreset = styleSelect.val(); saveSettingsDebounced(); if (typeof window.rpigRefreshFloatingStatus === 'function') window.rpigRefreshFloatingStatus(); });
    sizeSelect.on('change', () => { s.imageSize = sizeSelect.val(); saveSettingsDebounced(); if (typeof window.rpigRefreshFloatingStatus === 'function') window.rpigRefreshFloatingStatus(); });

    card1.body.append(row('生图后端类型', backendSelect));
    card1.body.append(urlRow);
    card1.body.append(keyRow);
    card1.body.append(modelRow);
    card1.body.append(row('画幅比例', sizeSelect));
    card1.body.append(row('画风偏好', styleSelect));
    card1.body.append(row('提示词格式', promptFormatSelect));
    card1.body.append(advancedToggle);
    card1.body.append(advancedDrawer);
    updateBackendVisibility();
    grid.append(card1.card);

    // ==========================================
    // 卡片 2: 🧠 剧情分析
    // ==========================================
    const card2 = createCard('剧情分析', '🧠');

    // 重点显著：上帝视角人物调度独立区域
    const perspectiveSection = $(document.createElement('div'))
        .attr('id', 'rpig-perspective-section');
    const perspectiveModeSelect = $('<select id="rpig-perspective-mode">')
        .append($('<option value="omniscient">👁️ 上帝视角（全员调度：主角、群像与在场 NPC）</option>'))
        .append($('<option value="focus">🎬 原有焦点视角（当前镜头 + 总结 LLM）</option>'))
    perspectiveModeSelect.on('change', () => {
        s.omniscientMode = perspectiveModeSelect.val() === 'omniscient';
        $('#rpig-fab-omniscient-toggle').prop('checked', s.omniscientMode !== false);
        saveSettingsDebounced();
        if (typeof window.rpigRefreshFloatingStatus === 'function') window.rpigRefreshFloatingStatus();
        toastr.success(s.omniscientMode ? '已启用上帝视角人物调度' : '已切换为原有焦点视角');
    });

    const perspectiveWrapper = $(`<div style="display:flex;flex-direction:column;gap:6px;">
        <div style="font-weight:600;color:#fff;font-size:13px;display:flex;align-items:center;gap:6px;">
            <span>👁 上帝视角人物调度</span>
        </div>
        <div class="rpig-hint" style="color:var(--rpig-text-body);margin-bottom:2px;">
            识别当前真正入镜的人物，支持单聊、NPC 与群像
        </div>
    </div>`);
    perspectiveWrapper.append(perspectiveModeSelect);
    perspectiveSection.append(perspectiveWrapper);
    card2.body.append(perspectiveSection);

    // 剧情 LLM 配置
    const llmSourceSelect = $('<select>')
        .append($('<option value="tavern">复用酒馆当前 LLM（推荐，无需重复填写 Key）</option>'))
        .append($('<option value="custom">扩展内独立配置（OpenAI 兼容接口）</option>'))
        .val(s.llmSource || 'tavern');

    const llmUrlInput = $('<input type="text" placeholder="https://api.deepseek.com/v1">').val(s.llmUrl);
    const llmKeyInput = $('<input type="password" placeholder="LLM API Key">').val(s.llmKey);
    const llmModelInput = $('<input type="text" placeholder="如 deepseek-chat, gpt-4o-mini 等">').val(s.llmModel);

    const customLlmUrlRow = row('LLM 接口地址', llmUrlInput);
    const customLlmKeyRow = row('LLM API Key', llmKeyInput);
    const llmModelControl = createUpstreamModelControl(
        llmModelInput,
        () => fetchLlmModelsFromUpstream(s),
        value => { s.llmModel = value; saveSettingsDebounced(); },
    );
    const customLlmModelRow = row('LLM 模型', llmModelControl, '点击“从上游获取”后可直接选择可用模型');

    card2.body.append(row('剧情 LLM 来源', llmSourceSelect));
    card2.body.append(customLlmUrlRow);
    card2.body.append(customLlmKeyRow);
    card2.body.append(customLlmModelRow);

    // 最终总结 LLM 子卡片（视觉明确区隔）
    const finalLlmCard = $(`<div class="rpig-subcard">
        <div class="rpig-subcard-header">
            <span>✍️ 最终总结 LLM</span>
            <span style="font-size:10px;font-weight:normal;color:var(--rpig-text-muted);">消除分析冲突 · 生成单段生图词</span>
        </div>
    </div>`);

    const finalLlmSourceSelect = $('<select>')
        .append($('<option value="same">复用上方剧情 LLM（推荐）</option>'))
        .append($('<option value="custom">独立配置总结 LLM（OpenAI 兼容接口）</option>'))
        .val(s.finalLlmSource || 'same');
    const finalLlmUrlInput = $('<input type="text" placeholder="https://api.example.com/v1">').val(s.finalLlmUrl || '');
    const finalLlmKeyInput = $('<input type="password" placeholder="总结 LLM API Key">').val(s.finalLlmKey || '');
    const finalLlmModelInput = $('<input type="text" placeholder="总结模型名称">').val(s.finalLlmModel || '');
    const finalLlmModelControl = createUpstreamModelControl(
        finalLlmModelInput,
        () => fetchLlmModelsFromUpstream(getFinalizerLlmSettings(s)),
        value => { s.finalLlmModel = value; saveSettingsDebounced(); },
    );
    const finalLlmUrlRow = row('总结接口地址', finalLlmUrlInput);
    const finalLlmKeyRow = row('总结 API Key', finalLlmKeyInput);
    const finalLlmModelRow = row('总结模型', finalLlmModelControl);

    finalLlmCard.append(row('总结 LLM 配置', finalLlmSourceSelect));
    finalLlmCard.append(finalLlmUrlRow);
    finalLlmCard.append(finalLlmKeyRow);
    finalLlmCard.append(finalLlmModelRow);
    card2.body.append(finalLlmCard);

    function updateLlmVisibility() {
        const isCustom = llmSourceSelect.val() === 'custom';
        customLlmUrlRow.toggle(isCustom);
        customLlmKeyRow.toggle(isCustom);
        customLlmModelRow.toggle(isCustom);
        const useCustomFinalizer = finalLlmSourceSelect.val() === 'custom';
        finalLlmUrlRow.toggle(useCustomFinalizer);
        finalLlmKeyRow.toggle(useCustomFinalizer);
        finalLlmModelRow.toggle(useCustomFinalizer);
    }

    llmSourceSelect.on('change', () => {
        s.llmSource = llmSourceSelect.val();
        updateLlmVisibility();
        saveSettingsDebounced();
    });
    llmUrlInput.on('input', () => { s.llmUrl = llmUrlInput.val(); saveSettingsDebounced(); });
    llmKeyInput.on('input', () => { s.llmKey = llmKeyInput.val(); saveSettingsDebounced(); });
    llmModelInput.on('input', () => { s.llmModel = llmModelInput.val(); saveSettingsDebounced(); });
    finalLlmSourceSelect.on('change', () => {
        s.finalLlmSource = finalLlmSourceSelect.val();
        updateLlmVisibility();
        saveSettingsDebounced();
    });
    finalLlmUrlInput.on('input', () => { s.finalLlmUrl = finalLlmUrlInput.val(); saveSettingsDebounced(); });
    finalLlmKeyInput.on('input', () => { s.finalLlmKey = finalLlmKeyInput.val(); saveSettingsDebounced(); });
    finalLlmModelInput.on('input', () => { s.finalLlmModel = finalLlmModelInput.val(); saveSettingsDebounced(); });

    updateLlmVisibility();
    grid.append(card2.card);

    // ==========================================
    // 卡片 3: 🎥 镜头与构图
    // ==========================================
    const card3 = createCard('镜头与构图', '🎥');
    const shotModeSelect = $('<select>')
        .append($('<option value="snapshot">🎬 剧情剧照抓拍（人景互动 / 动作抓拍 / 电影机位）</option>'))
        .append($('<option value="portrait">👤 角色微表情特写（面部神态 / 眼神焦点 / 微妙情绪）</option>'))
        .val(s.shotMode || 'snapshot');
    shotModeSelect.on('change', () => { s.shotMode = shotModeSelect.val(); saveSettingsDebounced(); if (typeof window.rpigRefreshFloatingStatus === 'function') window.rpigRefreshFloatingStatus(); });

    const limbRuleNotice = $(`<div class="rpig-hint" style="color:var(--rpig-accent-green);background:rgba(52,211,153,0.08);padding:8px 10px;border-radius:6px;border:1px solid rgba(52,211,153,0.2);line-height:1.5;">
        <b>✨ 肢体与手足规则：</b>允许自然完整出镜。严格约束每只手五指、每只脚五趾与关节连贯，已全面废除旧版强制裁切画外的限制。
    </div>`);
    const previewBeforeGenerationCheck = $('<input type="checkbox">').prop('checked', s.previewBeforeGeneration !== false);
    previewBeforeGenerationCheck.on('change', () => {
        s.previewBeforeGeneration = previewBeforeGenerationCheck.prop('checked');
        saveSettingsDebounced();
    });

    card3.body.append(row('默认镜头模式', shotModeSelect, '消息操作区 🎬 按钮悬浮或长按时可即时快速切换镜头'));
    card3.body.append(switchRow(
        '生成前预览最终提示词',
        previewBeforeGenerationCheck,
        '手动出图时可检查并修改正向/负向提示词，确认后才请求图片后端；自动出图不弹窗。',
    ));
    card3.body.append(limbRuleNotice);
    grid.append(card3.card);

    // ==========================================
    // 卡片 4: 🔗 连续性与锁脸
    // ==========================================
    const card4 = createCard('连续性与锁脸', '🔗');
    const continuityCheck = $('<input type="checkbox">').prop('checked', s.usePreviousImage !== false);
    const continuityDenoisingInput = $('<input type="number" min="0.2" max="0.85" step="0.05">')
        .val(Number(s.continuityDenoising) || 0.48);

    const continuityStrengthRow = row(
        'SD 重绘变化强度',
        continuityDenoisingInput,
        '数值越低越贴合上一张（建议 0.45–0.55）；换装剧情时系统会自动自适应放宽'
    );

    continuityCheck.on('change', () => {
        s.usePreviousImage = continuityCheck.prop('checked');
        continuityStrengthRow.toggle(s.backend === BACKENDS.SD && continuityCheck.prop('checked'));
        saveSettingsDebounced();
    });
    continuityDenoisingInput.on('input', () => {
        s.continuityDenoising = Math.min(0.85, Math.max(0.2, parseFloat(continuityDenoisingInput.val()) || 0.48));
        saveSettingsDebounced();
    });

    const continuityNotice = $(`<div class="rpig-hint" style="color:var(--rpig-text-body);background:rgba(139,122,232,0.08);padding:8px 10px;border-radius:6px;border:1px solid rgba(139,122,232,0.2);line-height:1.4;">
        <b>🔒 完整原图锁脸体系：</b>每一轮生图均以角色卡原图作为第一优先级身份锚点，上一张剧情图仅作为服装发型连续性参考，彻底杜绝连续生图脸部特征漂移。
    </div>`);

    card4.body.append(switchRow('延续上一张剧情造型', continuityCheck, '以上张配图为图生图参考，继承衣物、发饰与道具；新剧情明确换装时仍服从新剧情'));
    card4.body.append(continuityStrengthRow);
    card4.body.append(continuityNotice);
    continuityStrengthRow.toggle(s.backend === BACKENDS.SD && continuityCheck.prop('checked'));
    grid.append(card4.card);

    // ==========================================
    // 卡片 5: 🤖 自动生成
    // ==========================================
    const card5 = createCard('自动生成', '🤖');
    const autoModeCheck = $('<input type="checkbox">').prop('checked', !!s.autoMode);
    const autoCooldownInput = $('<input type="number" min="1" max="20" step="1">').val(s.autoCooldown || 3);
    const autoWindowInput = $('<input type="number" min="2" max="50" step="1">').val(s.autoWindow || 12);

    autoModeCheck.on('change', () => {
        s.autoMode = autoModeCheck.prop('checked');
        $('#rpig-auto-toggle').prop('checked', s.autoMode);
        saveSettingsDebounced();
    });
    autoCooldownInput.on('input', () => {
        s.autoCooldown = parseInt(autoCooldownInput.val(), 10) || 3;
        saveSettingsDebounced();
    });
    autoWindowInput.on('input', () => {
        s.autoWindow = parseInt(autoWindowInput.val(), 10) || 12;
        saveSettingsDebounced();
    });

    card5.body.append(switchRow('启用自动剧情检测出图', autoModeCheck, '当 AI 消息回复完成后，自动分析场景转场并生成配图'));
    card5.body.append(row('检测冷却间隔 (消息条数)', autoCooldownInput, '至少间隔 N 条消息才进行下一轮剧情场景分析'));
    card5.body.append(row('剧情分析上下文条数', autoWindowInput, '用于剧情场景分析的最近对话消息数量'));
    grid.append(card5.card);

    // ==========================================
    // 卡片 6: 👑 形象工作台（横跨两栏）
    // ==========================================
    const card6 = createCard('形象工作台（原图锁脸 · 多视图参考图库）', '👑', true);

    const charSelect = $('<select id="rpig-char-selector" style="flex:1;font-weight:600;"></select>');
    const refreshCharListBtn = $('<button type="button" class="menu_button" style="font-size:11px;padding:4px 9px;" title="刷新角色列表">🔄 刷新</button>');
    const openGalleryBtn = $('<button type="button" class="menu_button" style="font-size:11px;padding:4px 9px;" title="打开该角色的图库">📚 打开图库</button>');

    const charBar = $('<div class="rpig-model-control" style="gap:8px;"></div>');
    charBar.append(charSelect).append(refreshCharListBtn).append(openGalleryBtn);
    card6.body.append(row('绑定角色', charBar));

    openGalleryBtn.on('click', () => { openGallery(getCurrentCharacter()); });

    const charSummaryBox = $(`<div class="rpig-char-summary">
        <img class="rpig-summary-avatar">
        <div style="flex:1;min-width:0;">
            <div class="rpig-summary-name"></div>
            <div class="rpig-summary-desc">
                <span>✅ 原图锁脸已就绪（以角色原图为基准身份锚点）</span>
            </div>
        </div>
    </div>`);
    card6.body.append(charSummaryBox);

    function updateCharacterSelectorUI() {
        const allChars = getAllCharacters();
        charSelect.empty();
        charSelect.append($('<option value="auto">🌟 自动跟随当前聊天角色</option>'));
        allChars.forEach(c => {
            const opt = $('<option>').attr('value', c.avatar || c.name).text(c.name);
            charSelect.append(opt);
        });
        charSelect.val(s.selectedTargetCharacter || 'auto');
        updateCharacterDetails();
    }

    async function updateCharacterDetails() {
        const liveChar = getCurrentCharacter();
        if (!liveChar) {
            charSummaryBox.hide();
            return;
        }
        charSummaryBox.show();
        const displayName = (s.selectedTargetCharacter === 'auto' ? '🌟 [当前聊天] ' : '') + (liveChar.name || '角色');
        charSummaryBox.find('.rpig-summary-name').text(displayName);

        const avatarData = await getCharacterAvatarDataUrl(liveChar);
        if (avatarData) {
            charSummaryBox.find('.rpig-summary-avatar').attr('src', avatarData).show();
        } else {
            charSummaryBox.find('.rpig-summary-avatar').hide();
        }
        refreshRefsList();
    }

    window.rpigRefreshCharacterUI = () => { updateCharacterSelectorUI(); };

    refreshCharListBtn.on('click', function () {
        updateCharacterSelectorUI();
        toastr.success('已刷新角色列表');
    });

    charSelect.on('change', function () {
        s.selectedTargetCharacter = $(this).val();
        saveSettingsDebounced();
        updateCharacterDetails();
    });

    // 参考图生成器（三视图 / 全身立绘）
    const sheetBox = $(`<div class="rpig-sheet-gen-box">
        <div class="rpig-sheet-header">
            <span>🎨 图生图参考生成（三视图 / 全身立绘）</span>
            <span class="rpig-sheet-tag">原图做底 · 条件引导</span>
        </div>

        <div class="rpig-row" style="margin-bottom:4px;">
            <label style="font-size:11px;">生成类型：</label>
            <select id="rpig-sheet-type">
                <option value="three_views">📐 角色三视图（正面 + 侧面 + 背面完整设计图）</option>
                <option value="full_body">🧍 角色全身立绘（从头到脚全身完整站姿图）</option>
            </select>
        </div>

        <div class="rpig-row" style="margin-bottom:4px;">
            <label style="font-size:11px;">附加服装/风格要求：</label>
            <input type="text" id="rpig-sheet-custom-prompt" placeholder="可选，如：现代常服 / 战斗机甲（留空忠实原图服装）">
        </div>

        <div class="rpig-row" style="margin-bottom:4px;">
            <label class="rpig-switch" style="font-size:11px;">
                <input type="checkbox" id="rpig-sheet-auto-ref" checked>
                <span>生成成功后自动加入参考图库</span>
            </label>
        </div>

        <button type="button" class="menu_button rpig-sheet-btn" id="rpig-sheet-gen-btn">
            🪄 开始以原图生成参考图
        </button>
        <div id="rpig-sheet-status" style="display:none;font-size:12px;color:var(--rpig-accent-green);margin-top:4px;"></div>
        <div id="rpig-sheet-result" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid var(--rpig-border);"></div>
    </div>`);

    const refsList = $(document.createElement('div')).addClass('rpig-refs-list');
    const refsEmpty = $(document.createElement('div')).addClass('rpig-ref-empty').text('暂无多视图参考图，点击下方按钮上传或生成');

    async function refreshRefsList() {
        const liveChar = getCurrentCharacter();
        const views = liveChar ? await getCharacterRefs(liveChar) : [];
        refsList.empty();
        if (!views.length) {
            refsList.append(refsEmpty);
        } else {
            views.forEach((view, index) => {
                const item = $(document.createElement('div')).addClass('rpig-ref-item');
                const img = $(document.createElement('img')).attr('src', view.url || view.dataUrl).attr('alt', view.label || '视图');
                const label = $(document.createElement('span')).text(view.label || `视图 ${index + 1}`);
                const del = $('<button title="删除参考图">✕</button>');
                del.on('click', async () => {
                    views.splice(index, 1);
                    try {
                        await saveCharacterRefs(liveChar, views);
                        refreshRefsList();
                    } catch (e) {
                        toastr.error('删除参考图失败');
                    }
                });
                item.append(img, label, del);
                refsList.append(item);
            });
        }
    }

    sheetBox.find('#rpig-sheet-gen-btn').on('click', async function () {
        const liveChar = getCurrentCharacter();
        if (!liveChar) {
            toastr.warning('请先在左侧选择或打开角色聊天');
            return;
        }
        const btn = $(this);
        if (btn.prop('disabled')) return;
        btn.prop('disabled', true);
        const statusBox = sheetBox.find('#rpig-sheet-status');
        const resBox = sheetBox.find('#rpig-sheet-result');
        resBox.hide().empty();
        statusBox.html('<span class="rpig-spinner"></span> 正在以角色卡原图进行图生图渲染…').show();

        try {
            const type = sheetBox.find('#rpig-sheet-type').val();
            const customPrompt = sheetBox.find('#rpig-sheet-custom-prompt').val();
            const autoAddToRefs = sheetBox.find('#rpig-sheet-auto-ref').prop('checked');

            const res = await generateCharacterSheetFlow({
                targetCharacter: liveChar,
                type,
                customPrompt,
                autoAddToRefs,
            });
            statusBox.text(`✅ 「${liveChar.name || '角色'}」参考图生成成功！`);
            toastr.success(`✅ 「${liveChar.name || '角色'}」形象参考已生成！`);

            const card = $(`<div style="display:flex;gap:12px;align-items:flex-start;">
                <img style="width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid var(--rpig-border);cursor:zoom-in;">
                <div style="flex:1;font-size:12px;line-height:1.5;">
                    <div class="rpig-sheet-card-title" style="font-weight:600;color:#fff;margin-bottom:4px;"></div>
                    <div style="display:flex;gap:6px;margin-top:8px;">
                        <button class="menu_button rpig-sheet-add-btn" style="font-size:11px;padding:4px 8px;"></button>
                        <button class="menu_button rpig-sheet-view-btn" style="font-size:11px;padding:4px 8px;">👁️ 查看大图</button>
                    </div>
                </div>
            </div>`);

            card.find('img').attr('src', res.imageUrl);
            card.find('.rpig-sheet-card-title').text(`${type === 'three_views' ? '📐 角色三视图' : '🧍 角色全身立绘'} · ${res.model}`);

            const addBtn = card.find('.rpig-sheet-add-btn');
            if (res.addedToRefs) {
                addBtn.text('✅ 已加入参考图').prop('disabled', true).css('opacity', '0.7');
            } else if (!res.isPersisted) {
                addBtn.text('⚠️ 未持久化').prop('disabled', true).attr('title', '图片未持久化到服务器，无法存入图库').css('opacity', '0.6');
            } else {
                addBtn.text('➕ 加入参考图');
            }

            const targetName = liveChar.name || '角色';
            card.find('img, .rpig-sheet-view-btn').on('click', () => openLightbox(res.imageUrl, `${targetName} · ${type === 'three_views' ? '三视图' : '全身立绘'}`));

            addBtn.on('click', async () => {
                if (!res.isPersisted || !res.persistedUrl) {
                    toastr.warning('该图片未持久化到服务器，无法加入参考图');
                    return;
                }
                if (liveChar) {
                    const views = await getCharacterRefs(liveChar);
                    if (views.length >= MAX_REFS_PER_CHAR) {
                        toastr.warning(`参考图数量已达上限 (${MAX_REFS_PER_CHAR} 张)`);
                        return;
                    }
                    if (views.some(v => v.url === res.persistedUrl)) {
                        toastr.info('该参考图已在列表中');
                        addBtn.text('✅ 已加入参考图').prop('disabled', true).css('opacity', '0.7');
                        return;
                    }
                    views.push({ url: res.persistedUrl, label: (type === 'three_views' ? '📐 图生图三视图' : '🧍 图生图全身立绘') });
                    await saveCharacterRefs(liveChar, views);
                    refreshRefsList();
                    addBtn.text('✅ 已加入参考图').prop('disabled', true).css('opacity', '0.7');
                    toastr.success(`已加入「${liveChar.name || '角色'}」参考图`);
                }
            });

            resBox.append(card).show();
            refreshRefsList();
        } catch (err) {
            const cleanErr = scrubSensitiveText(err.message || String(err));
            statusBox.html(`<span style="color:var(--rpig-danger)">❌ 生成失败：${escapeHtml(cleanErr)}</span>`);
            toastr.error(`❌ ${escapeHtml(cleanErr)}`);
        } finally {
            btn.prop('disabled', false);
        }
    });

    card6.body.append(sheetBox);

    const fileInput = $('<input type="file" accept="image/*" multiple style="display:none">');
    const uploadBtn = $('<button class="menu_button" style="width:100%;margin-top:6px;">📁 上传本地多视角参考图（正面/侧面/背面等）</button>');
    uploadBtn.on('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileInput.trigger('click');
    });
    fileInput.on('click', (e) => { e.stopPropagation(); });
    fileInput.on('change', async function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.originalEvent) e.originalEvent.stopImmediatePropagation();
        const liveChar = getCurrentCharacter();
        if (!liveChar) {
            toastr.warning('请先选择绑定的角色');
            return;
        }
        let files = Array.from(this.files || []);
        if (!files.length) return;

        if (files.length > MAX_BATCH_UPLOAD) {
            toastr.warning(`单次批量上传最多 ${MAX_BATCH_UPLOAD} 张，已自动截取前 ${MAX_BATCH_UPLOAD} 张`);
            files = files.slice(0, MAX_BATCH_UPLOAD);
        }

        const views = await getCharacterRefs(liveChar);
        let count = 0;
        for (const file of files) {
            if (views.length >= MAX_REFS_PER_CHAR) {
                toastr.warning(`该角色参考图已达上限 (${MAX_REFS_PER_CHAR} 张)`);
                break;
            }
            if (!file.type.startsWith('image/')) {
                toastr.warning(`跳过非图片文件：${escapeHtml(file.name)}`);
                continue;
            }
            if (file.size > MAX_UPLOAD_FILE_SIZE) {
                toastr.warning(`图片 ${escapeHtml(file.name)} 超过 15MB 限制，已跳过`);
                continue;
            }
            const dataUrl = await blobToDataUrl(file);
            let persistedUrl = '';
            try {
                persistedUrl = await persistMediaUrl(dataUrl, liveChar.name, {
                    saveBase64AsFile,
                    fetchToDataUrl,
                });
            } catch (upErr) {
                toastr.warning(`图片 ${escapeHtml(file.name)} 保存到服务器失败，已跳过：${escapeHtml(upErr.message || upErr)}`);
                continue;
            }

            if (!views.some(v => v.url === persistedUrl)) {
                views.push({ url: persistedUrl, label: file.name.replace(/\.[^.]+$/, '') });
                count++;
            }
        }
        if (count > 0) {
            try {
                await saveCharacterRefs(liveChar, views);
                refreshRefsList();
                toastr.success(`✅ 已为「${liveChar.name || '角色'}」保存 ${count} 张参考图`);
            } catch (saveErr) {
                toastr.error('参考图保存到本地数据库失败');
            }
        }
        this.value = '';
    });

    card6.body.append(uploadBtn).append(fileInput);
    card6.body.append(refsList);
    grid.append(card6.card);

    container.append(grid);
    setTimeout(() => { updateCharacterSelectorUI(); }, 100);

    return container;
}

function buildFloatingUI() {
    const fab = $(`<div class="rpig-fab" title="🎬 RP 电影配图 · 点击展开/收起 · 按住可拖拽">🎬</div>`);

    const panel = $(`<div class="rpig-fab-panel" style="display:none">
        <div class="rpig-fab-header" title="按住此处可自由拖动面板位置">
            <span class="rpig-fab-header-title"><span class="rpig-drag-handle">⠿</span>🎬 RP 电影配图 <small class="rpig-header-version">v2.9.18</small></span>
            <span class="rpig-fab-header-close" title="收起面板（亦可点击外部任意处收起）">✕</span>
        </div>

        <div class="rpig-fab-section-title">视角调度模式：</div>
        <div class="rpig-fab-segmented rpig-fab-perspective-segmented">
            <button type="button" class="rpig-fab-seg-btn rpig-fab-perspective-btn" data-perspective="omniscient" id="rpig-quick-omniscient" title="全员调度：识别当前真正入镜的主角、群像与在场 NPC">👁️ 上帝视角</button>
            <button type="button" class="rpig-fab-seg-btn rpig-fab-perspective-btn" data-perspective="focus" id="rpig-quick-focus" title="原有焦点视角：锁定最新焦点镜头 + 总结分析">🎬 焦点视角</button>
        </div>

        <div class="rpig-fab-section-title">镜头机位选择：</div>
        <div class="rpig-fab-segmented rpig-fab-shot-segmented">
            <button type="button" class="rpig-fab-seg-btn rpig-fab-shot-btn" data-mode="snapshot" id="rpig-quick-snapshot" title="人景互动、动作抓拍、环境构图">🎬 剧情剧照</button>
            <button type="button" class="rpig-fab-seg-btn rpig-fab-shot-btn" data-mode="portrait" id="rpig-quick-portrait" title="面部神态、眼神聚焦、微妙情绪">👤 微表情特写</button>
        </div>

        <div class="rpig-fab-grid-2">
            <div class="rpig-fab-select-wrap">
                <span class="rpig-fab-select-label">画幅:</span>
                <select id="rpig-fab-size-select" title="配图画幅比例">
                    <option value="16:9">16:9 电影</option>
                    <option value="2.39:1">2.39:1 宽幕</option>
                    <option value="1:1">1:1 方形</option>
                    <option value="9:16">9:16 竖屏</option>
                </select>
            </div>
            <div class="rpig-fab-select-wrap">
                <span class="rpig-fab-select-label">画风:</span>
                <select id="rpig-fab-style-select" title="配图画风偏好">
                    <option value="character">跟随角色卡</option>
                    <option value="anime">二次元动画</option>
                    <option value="realistic">电影写实</option>
                </select>
            </div>
        </div>

        <div class="rpig-fab-grid-2">
            <label class="rpig-switch" title="延续上一张剧情配图造型（衣服/发型/随身道具）" style="font-size:11px;">
                <input type="checkbox" id="rpig-fab-continuity-toggle">
                <span>🔗 延续造型</span>
            </label>
            <label class="rpig-switch" title="AI 回复完毕后自动分析场景转场并出图" style="font-size:11px;">
                <input type="checkbox" id="rpig-auto-toggle">
                <span>🤖 自动出图</span>
            </label>
        </div>

        <div style="display:none;">
            <select id="rpig-fab-shot-mode">
                <option value="snapshot">🎬 剧情剧照抓拍</option>
                <option value="portrait">👤 角色微表情特写</option>
            </select>
            <input type="checkbox" id="rpig-fab-omniscient-toggle">
        </div>

        <div class="rpig-fab-status" id="rpig-fab-status"></div>
        <div class="rpig-fab-gen-status" id="rpig-fab-gen-status" style="display:none"></div>
        <div class="rpig-taskbar" id="rpig-taskbar" style="display:none">
            <span id="rpig-task-summary"></span>
            <div class="rpig-task-list" id="rpig-task-list" style="display:none"></div>
            <div class="rpig-task-actions">
                <button type="button" class="menu_button" id="rpig-cancel-current">取消当前</button>
                <button type="button" class="menu_button" id="rpig-clear-queue">清空排队</button>
            </div>
        </div>

        <div class="rpig-fab-btns">
            <button class="menu_button rpig-btn-action-primary" id="rpig-gen-now" title="以当前所选镜头立即生成当前轮配图">🪄 立即出图</button>
            <button class="menu_button" id="rpig-gallery-btn" title="查看当前角色历史图片">📚 角色图库</button>
            <button class="menu_button" id="rpig-open-settings" title="打开扩展详细设置抽屉">⚙ 设置</button>
        </div>
    </div>`);

    $('body').append(fab).append(panel);
    updateGenerationQueueUI();

    function refreshStatus() {
        const s = getSettings();
        $('#rpig-auto-toggle').prop('checked', !!s.autoMode);
        $('#rpig-fab-omniscient-toggle').prop('checked', s.omniscientMode !== false);
        $('#rpig-fab-continuity-toggle').prop('checked', s.usePreviousImage !== false);
        $('#rpig-fab-size-select').val(s.imageSize || '16:9');
        $('#rpig-fab-style-select').val(s.stylePreset || 'character');
        $('#rpig-fab-shot-mode').val(s.shotMode || 'snapshot');

        // 视角模式高亮
        const isOmni = s.omniscientMode !== false;
        panel.find('.rpig-fab-perspective-btn').removeClass('rpig-active');
        panel.find(`.rpig-fab-perspective-btn[data-perspective="${isOmni ? 'omniscient' : 'focus'}"]`).addClass('rpig-active');

        // 镜头模式高亮
        const curMode = s.shotMode || 'snapshot';
        panel.find('.rpig-fab-shot-btn').removeClass('rpig-active');
        panel.find(`.rpig-fab-shot-btn[data-mode="${curMode}"]`).addClass('rpig-active');

        const curChar = getCurrentCharacter();
        const charName = curChar ? (curChar.name || '当前角色') : '跟随当前聊天';
        const shotText = curMode === 'portrait' ? '微表情特写' : '剧情剧照';
        const omniText = isOmni ? '👁️ 上帝视角' : '🎬 焦点视角';
        const styleMap = {
            character: '自适应',
            anime: '二次元',
            realistic: '电影写实'
        };
        const styleText = styleMap[s.stylePreset] || s.stylePreset || '自适应';
        const sizeText = s.imageSize || '16:9';
        $('#rpig-fab-status').html(`绑定：<b>${escapeHtml(charName)}</b> · <b>${omniText}</b> · <b>${shotText}</b><br>画幅：${escapeHtml(sizeText)} · 画风：${escapeHtml(styleText)} · 后端：${escapeHtml(s.backend)}`);
    }

    window.rpigRefreshFloatingStatus = refreshStatus;

    // 通用拖拽绑定函数（支持鼠标与移动端触摸）
    function setupDraggable(element, handle, onEnd) {
        let isDragging = false;
        let hasMoved = false;
        let startX = 0, startY = 0;
        let startLeft = 0, startTop = 0;

        const start = (clientX, clientY) => {
            isDragging = true;
            hasMoved = false;
            startX = clientX;
            startY = clientY;
            const rect = element[0].getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            element.addClass('rpig-dragging');
        };

        const move = (clientX, clientY) => {
            if (!isDragging) return;
            const dx = clientX - startX;
            const dy = clientY - startY;
            if (Math.abs(dx) + Math.abs(dy) > 4) {
                hasMoved = true;
            }
            if (hasMoved) {
                const w = element.outerWidth() || 40;
                const h = element.outerHeight() || 40;
                const maxL = Math.max(0, window.innerWidth - w);
                const maxT = Math.max(0, window.innerHeight - h);
                const newL = Math.max(0, Math.min(maxL, startLeft + dx));
                const newT = Math.max(0, Math.min(maxT, startTop + dy));
                element.css({
                    left: `${newL}px`,
                    top: `${newT}px`,
                    right: 'auto',
                    bottom: 'auto',
                });
            }
        };

        const end = () => {
            if (!isDragging) return;
            isDragging = false;
            element.removeClass('rpig-dragging');
            if (typeof onEnd === 'function') {
                onEnd(hasMoved);
            }
        };

        handle.on('mousedown', function (e) {
            if (e.button !== 0) return;
            if ($(e.target).closest('button, .rpig-fab-header-close, input, select, .rpig-switch').length) return;
            e.preventDefault();
            start(e.clientX, e.clientY);
        });

        $(document).on('mousemove.rpigDrag', function (e) {
            if (isDragging) move(e.clientX, e.clientY);
        });

        $(document).on('mouseup.rpigDrag', function () {
            if (isDragging) end();
        });

        handle.on('touchstart', function (e) {
            if ($(e.target).closest('button, .rpig-fab-header-close, input, select, .rpig-switch').length) return;
            const touch = e.originalEvent.touches[0];
            if (touch) start(touch.clientX, touch.clientY);
        });

        $(document).on('touchmove.rpigDrag', function (e) {
            if (!isDragging) return;
            const touch = e.originalEvent.touches[0];
            if (touch) move(touch.clientX, touch.clientY);
        });

        $(document).on('touchend.rpigDrag touchcancel.rpigDrag', function () {
            if (isDragging) end();
        });

        return { hasMoved: () => hasMoved };
    }

    let panelCustomPositioned = false;

    // 面板智能靠边定位（未手动拖拽时紧贴 FAB 并保证不出屏）
    function positionPanelNearFab() {
        const pW = panel.outerWidth() || 320;
        const pH = panel.outerHeight() || 240;

        if (panelCustomPositioned) {
            const rect = panel[0].getBoundingClientRect();
            const clampedL = Math.max(8, Math.min(window.innerWidth - pW - 8, rect.left));
            const clampedT = Math.max(8, Math.min(window.innerHeight - pH - 8, rect.top));
            panel.css({ left: `${clampedL}px`, top: `${clampedT}px`, right: 'auto', bottom: 'auto' });
            return;
        }

        const fabRect = fab[0].getBoundingClientRect();
        let left = fabRect.left - pW - 10;
        if (left < 10) {
            left = Math.min(window.innerWidth - pW - 10, fabRect.right + 10);
            if (left < 10) left = 10;
        }

        let top = fabRect.bottom - pH;
        if (top < 10) top = 10;
        if (top + pH > window.innerHeight - 10) {
            top = Math.max(10, window.innerHeight - pH - 10);
        }

        panel.css({
            left: `${left}px`,
            top: `${top}px`,
            right: 'auto',
            bottom: 'auto',
        });
    }

    // 绑定悬浮按钮拖拽
    const fabDrag = setupDraggable(fab, fab, () => {});

    // 绑定面板标头拖拽（允许用户随意将小方块拖移到不遮挡文本的任意位置）
    setupDraggable(panel, panel.find('.rpig-fab-header'), (moved) => {
        if (moved) panelCustomPositioned = true;
    });

    function toggleFloatingPanel() {
        if (panel.is(':visible')) {
            panel.hide();
        } else {
            positionPanelNearFab();
            refreshStatus();
            panel.show();
        }
    }

    fab.on('click', function () {
        if (fabDrag.hasMoved()) return;
        toggleFloatingPanel();
    });

    panel.find('.rpig-fab-header-close').on('click', () => {
        panel.hide();
    });

    // 点击外部区域自动收起，避免遮挡聊天文本
    $(document).on('mousedown.rpigOutside touchstart.rpigOutside', function (e) {
        if (!panel.is(':visible')) return;
        if (!$(e.target).closest('.rpig-fab-panel, .rpig-fab, .rpig-gallery-overlay, .rpig-lightbox').length) {
            panel.hide();
        }
    });

    // 视角调度分段按钮交互（👁️ 上帝视角 vs 🎬 焦点视角）
    panel.find('.rpig-fab-perspective-btn').on('click', function () {
        const perspective = $(this).attr('data-perspective');
        const s = getSettings();
        s.omniscientMode = (perspective === 'omniscient');
        $('#rpig-perspective-mode').val(s.omniscientMode ? 'omniscient' : 'focus');
        $('#rpig-fab-omniscient-toggle').prop('checked', s.omniscientMode);
        saveSettingsDebounced();
        refreshStatus();
        if (s.omniscientMode) {
            toastr.success('已切换为：👁️ 上帝视角（全员调度：主角、群像与在场 NPC）');
        } else {
            toastr.info('已切换为：🎬 原有焦点视角（锁定焦点角色镜头分析）');
        }
    });

    // 镜头选择分段按钮交互（🎬 剧情剧照 vs 👤 微表情特写）
    panel.find('.rpig-fab-shot-btn').on('click', function () {
        const mode = $(this).attr('data-mode');
        const s = getSettings();
        s.shotMode = mode;
        $('#rpig-fab-shot-mode').val(mode);
        saveSettingsDebounced();
        refreshStatus();
        toastr.info(`已切换镜头：${mode === 'portrait' ? '👤 角色微表情特写' : '🎬 剧情剧照抓拍'}`);
    });

    // 画风偏好快速切换
    $('#rpig-fab-style-select').on('change', function () {
        const s = getSettings();
        s.stylePreset = $(this).val();
        saveSettingsDebounced();
        refreshStatus();
        toastr.info(`画风偏好已设置为：${$(this).find('option:selected').text()}`);
    });

    // 画幅比例快速切换
    $('#rpig-fab-size-select').on('change', function () {
        const s = getSettings();
        s.imageSize = $(this).val();
        saveSettingsDebounced();
        refreshStatus();
        toastr.info(`画幅比例已设置为 ${s.imageSize}`);
    });

    // 上帝视角兼容复选框
    $('#rpig-fab-omniscient-toggle').on('change', function () {
        const s = getSettings();
        s.omniscientMode = $(this).prop('checked');
        $('#rpig-perspective-mode').val(s.omniscientMode ? 'omniscient' : 'focus');
        saveSettingsDebounced();
        refreshStatus();
    });

    // 自动出图开关
    $('#rpig-auto-toggle').on('change', function () {
        getSettings().autoMode = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // 造型连续性开关
    $('#rpig-fab-continuity-toggle').on('change', function () {
        const s = getSettings();
        s.usePreviousImage = $(this).prop('checked');
        saveSettingsDebounced();
        refreshStatus();
        toastr.info(s.usePreviousImage ? '已开启造型连续性（延续上一张服装）' : '已关闭造型连续性');
    });

    $('#rpig-fab-shot-mode').on('change', function () {
        getSettings().shotMode = $(this).val();
        saveSettingsDebounced();
        refreshStatus();
    });

    async function generateLatestAssistantMessage() {
        const liveContext = getContext();
        const chat = liveContext?.chat || [];
        const latestIdx = findLatestAssistantMessageIndex(chat);
        if (latestIdx >= 0) {
            const s = getSettings();
            await generateForMessage(latestIdx, null, s.shotMode || 'snapshot');
        } else {
            toastr.warning('未在当前会话中找到可生成配图的 AI 消息');
        }
    }

    $('#rpig-gen-now').on('click', generateLatestAssistantMessage);

    $('#rpig-cancel-current').on('click', cancelCurrentGeneration);
    $('#rpig-clear-queue').on('click', clearQueuedGenerations);
    $('#rpig-task-list').on('click', '.rpig-cancel-queued', function () {
        cancelQueuedGeneration(Number($(this).attr('data-task-id')));
    });

    $('#rpig-gallery-btn').on('click', () => {
        panel.hide();
        openGallery(getCurrentCharacter());
    });

    $('#rpig-open-settings').on('click', openSettingsPanel);
}

function openSettingsPanel() {
    try {
        if (typeof window.rpigRefreshCharacterUI === 'function') {
            window.rpigRefreshCharacterUI();
        }
        const drawer = $('#extensions-settings-button');
        if ($('#rm_extensions_block').hasClass('closedDrawer')) {
            drawer.find('.drawer-toggle').trigger('click');
        }
        setTimeout(() => {
            const target = $('#rpig_container');
            if (target.length) {
                $('#rm_extensions_block').animate({
                    scrollTop: target.offset().top - $('#rm_extensions_block').offset().top + $('#rm_extensions_block').scrollTop(),
                }, 400);
            }
        }, 400);
    } catch { /* ignore */ }
}

function mountSettingsPanel() {
    if ($('#rpig_container').length) return;
    const container = $(`<div id="rpig_container" class="extension_container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b data-i18n="rpig_title">🎬 RP 电影配图 v2.9.18</b>
                <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
            </div>
            <div class="inline-drawer-content"></div>
        </div>
    </div>`);
    container.find('.inline-drawer-content').append(buildSettingsUI());
    $('#extensions_settings2').append(container);
}

jQuery(async function () {
    loadSettings();

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageIndex, type) => {
        try {
            if (typeof messageIndex === 'number' && messageIndex >= 0) {
                injectManualButton(messageIndex);

                const s = getSettings();
                if (s.autoMode) {
                    const context = getContext();
                    const chat = context.chat || [];
                    const msg = chat[messageIndex];
                    if (msg && !msg.is_user) {
                        const char = getCharacterForMessage(msg) || getCurrentCharacter();
                        const previousGenerated = s.usePreviousImage !== false
                            ? getPreviousGeneratedImage(chat, messageIndex, char, {
                                strictCharacterMatch: context.groupId !== undefined && context.groupId !== null && context.groupId !== '',
                            })
                            : null;
                        executeAutoDetection({
                            messageIndex,
                            message: msg,
                            messageType: type,
                            character: char,
                            settings: s,
                            getContextFn: getContext,
                            callLLMFn: callLLM,
                            generateForMessageFn: (idx, prompt, mode, avoid, meta) => generateForMessage(idx, prompt, mode, avoid, meta),
                            continuityContext: previousGenerated?.prompt || '',
                            onStatusChange: setGenStatus,
                            onNotify: (notifyType, text) => {
                                if (notifyType === 'success') toastr.success(escapeHtml(text));
                                else if (notifyType === 'info') toastr.info(escapeHtml(text));
                                else if (notifyType === 'error') toastr.error(escapeHtml(text));
                            },
                        });
                    }
                }
            }
        } catch { /* ignore */ }
    });

    eventSource.on(event_types.MESSAGE_SWIPED, (messageIndex) => {
        try {
            if (typeof messageIndex === 'number' && messageIndex >= 0) {
                injectManualButton(messageIndex);
            }
        } catch { /* ignore */ }
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        rpigActiveTask?.controller.abort(createAbortError('会话已切换'));
        const removed = rpigGenerationQueue.splice(0);
        for (const task of removed) task.resolve({ cancelled: true, queued: true });
        updateGenerationQueueUI();
        resetAutoDetectState();
        $('.rpig-btn-manual').removeClass('rpig-busy').attr('title', '生成配图');
        if (typeof window.rpigRefreshCharacterUI === 'function') {
            window.rpigRefreshCharacterUI();
        }
        setTimeout(scanAndInjectAllMessages, 300);
    });

    eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => {
        if (typeof window.rpigRefreshCharacterUI === 'function') {
            window.rpigRefreshCharacterUI();
        }
    });

    try { buildFloatingUI(); } catch { /* ignore */ }
    try { mountSettingsPanel(); } catch { /* ignore */ }
    setTimeout(scanAndInjectAllMessages, 500);

    console.log('[RP 电影配图 v2.9.18] 移动端固定确认栏与统一悬浮工作台已启用。');
});
