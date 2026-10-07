import { getChatSessionKey } from './auto.js';
import { getCharacterIdentifier, persistMediaUrl as defaultPersistMediaUrl, saveToGallery as defaultSaveToGallery } from './gallery.js';
import { sanitizeDiagnostics } from './diagnostics.js';
import { RpigError, throwIfAborted } from './utils.js';

const sources = new WeakMap();

function canonicalUrl(value, baseURI) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
        const url = new URL(value.trim(), baseURI);
        url.hash = '';
        return url.href;
    } catch { return value.trim(); }
}

function hasSource(message, sourceUrl, baseURI, storage) {
    const extra = message?.extra;
    if (!extra) return false;
    const mediaUrls = Array.isArray(extra.media) ? extra.media.map(item => item?.url) : [];
    if (storage === 'media') return mediaUrls.some(value => canonicalUrl(value, baseURI) === sourceUrl);
    const values = [extra.image, extra.rpigInfo?.outputUrl,
        ...(Array.isArray(extra.image_swipes) ? extra.image_swipes : []),
        ...mediaUrls];
    return values.some(value => canonicalUrl(value, baseURI) === sourceUrl);
}

function sendDate(value) {
    return value instanceof Date ? value.getTime() : value;
}

function sourceChanged() {
    return new RpigError('LOCAL_DETAIL_SOURCE_CHANGED', '原图所在消息或会话已经变化，候选仍保留在预览中，请从当前原图重新打开精修');
}

/** Capture a source without inferring a chat message for gallery-only images. */
export function captureLocalDetailSource({ context, messageIndex, sourceUrl, character, baseURI } = {}) {
    const base = baseURI || globalThis.document?.baseURI || 'http://localhost/';
    if (typeof sourceUrl !== 'string' || !sourceUrl.trim()) {
        throw new RpigError('LOCAL_DETAIL_SOURCE_INVALID', '没有可精修的原图');
    }
    const galleryOnly = messageIndex === undefined || messageIndex === null;
    if (!galleryOnly && (!Number.isInteger(messageIndex) || messageIndex < 0)) {
        throw new RpigError('LOCAL_DETAIL_SOURCE_INVALID', '原图消息位置无效');
    }
    const chat = context?.chat;
    const message = galleryOnly ? null : chat?.[messageIndex];
    const normalized = canonicalUrl(sourceUrl, base);
    if (!galleryOnly && (!Array.isArray(chat) || !message || !hasSource(message, normalized, base))) {
        throw sourceChanged();
    }
    const capturedCharacter = character && typeof character === 'object' ? { ...character } : character;
    const state = {
        context, chat, message, galleryOnly, baseURI: base, normalized,
        sourceStorage: Array.isArray(message?.extra?.media)
            && message.extra.media.some(item => canonicalUrl(item?.url, base) === normalized) ? 'media' : 'legacy',
        sessionKey: getChatSessionKey(context), mes: message?.mes,
        swipe: message?.swipe_id, date: sendDate(message?.send_date),
        files: new Map(), committed: new Map(), queue: Promise.resolve(),
    };
    const snapshot = {
        character: capturedCharacter,
        messageIndex: galleryOnly ? null : messageIndex,
        sourceUrl: sourceUrl.trim(),
        sessionKey: state.sessionKey,
        isCurrent(getContext) {
            if (galleryOnly) return true;
            let current;
            try { current = typeof getContext === 'function' ? getContext() : context; }
            catch { return false; }
            const item = current?.chat?.[messageIndex];
            return getChatSessionKey(current) === state.sessionKey
                && current?.chat === chat && item === message
                && item?.mes === state.mes && item?.swipe_id === state.swipe
                && sendDate(item?.send_date) === state.date
                && hasSource(item, normalized, base, state.sourceStorage);
        },
    };
    sources.set(snapshot, state);
    return snapshot;
}

function isDurableUrl(value, baseURI) {
    if (typeof value !== 'string' || !value.trim() || /^(?:data|blob):/i.test(value.trim())) return false;
    try {
        const url = new URL(value.trim(), baseURI);
        const base = new URL(baseURI);
        return /^https?:$/.test(url.protocol) && url.origin === base.origin;
    } catch { return false; }
}

function detailMetadata(snapshot, candidate, diagnosticKeys) {
    const region = candidate.region;
    const metadata = {
        sourceUrl: snapshot.sourceUrl,
        region: region ? Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, region[key]])) : null,
        preset: String(candidate.preset || 'custom'),
        instruction: String(candidate.instruction || ''),
        time: Date.now(),
    };
    const result = candidate.generationResult;
    if (result?.requestId) metadata.requestId = String(result.requestId);
    if (result?.diagnostics && typeof result.diagnostics === 'object') {
        try { metadata.diagnostics = sanitizeDiagnostics(result.diagnostics, diagnosticKeys); }
        catch { /* An unavailable optional diagnostic must not discard the image. */ }
    }
    return sanitizeDiagnostics(metadata, diagnosticKeys);
}

async function gallerySave(snapshot, entry, deps) {
    if (getCharacterIdentifier(snapshot.character) === 'default') {
        throw new RpigError('LOCAL_DETAIL_GALLERY_SAVE_FAILED', '没有可保存到的角色图库');
    }
    const save = deps.saveToGallery || defaultSaveToGallery;
    // The existing gallery API intentionally no-ops without IndexedDB. An explicit
    // "save candidate" must report that condition instead of claiming success.
    if (save === defaultSaveToGallery && typeof indexedDB === 'undefined') {
        throw new RpigError('LOCAL_DETAIL_GALLERY_SAVE_FAILED', '当前环境无法保存角色图库');
    }
    if (await save(snapshot.character, entry) === false) {
        throw new RpigError('LOCAL_DETAIL_GALLERY_SAVE_FAILED', '局部精修候选未保存到角色图库');
    }
}

function rollbackAppend(extra, media, item, hadMedia, previousMedia) {
    const index = media.indexOf(item);
    if (index >= 0) media.splice(index, 1);
    if (!Array.isArray(previousMedia) && extra.media === media && media.length === 0) {
        if (hadMedia) extra.media = previousMedia;
        else delete extra.media;
    }
}

/**
 * Save a candidate as a new media item, retaining the original image and rpigInfo.
 * updateMessage(index, message, capturedContext) must await chat persistence;
 * renderMessage is a best-effort UI update after that commit. Cancellation is
 * honored before commit; once the chat/gallery commit begins it finishes normally.
 */
export function saveLocalDetailCandidate(snapshot, candidate, deps = {}) {
    const state = sources.get(snapshot);
    if (!state || !candidate || typeof candidate !== 'object') {
        return Promise.reject(new RpigError('LOCAL_DETAIL_SAVE_INVALID', '没有可保存的精修候选'));
    }
    const operation = state.queue.then(async () => {
        const signal = candidate.signal || deps.signal;
        const raw = candidate.dataUrl || candidate.imageUrl || candidate.url;
        if (typeof raw !== 'string' || !raw) throw new RpigError('LOCAL_DETAIL_SAVE_INVALID', '精修候选没有有效图片');
        if (candidate.sourceUrl && canonicalUrl(candidate.sourceUrl, state.baseURI) !== state.normalized) throw sourceChanged();
        const previous = state.committed.get(raw);
        if (previous) return { ...previous, staleAfterSave: !snapshot.isCurrent(deps.getContext) };
        throwIfAborted(signal);
        if (!snapshot.isCurrent(deps.getContext)) throw sourceChanged();
        if (!state.galleryOnly && typeof deps.updateMessage !== 'function') {
            throw new RpigError('LOCAL_DETAIL_CHAT_SAVE_FAILED', '未提供会话保存接口，候选仍在预览中');
        }
        let url = state.files.get(raw);
        if (!url) {
            const fetchImage = deps.fetchToDataUrl;
            let input = raw;
            if (/^blob:/i.test(input)) {
                if (typeof fetchImage !== 'function') throw new RpigError('LOCAL_DETAIL_FILE_SAVE_FAILED', '无法持久化临时精修图片');
                input = await fetchImage(input, { signal });
                throwIfAborted(signal);
            }
            url = await (deps.persistMediaUrl || defaultPersistMediaUrl)(input, snapshot.character?.name || String(snapshot.character || 'character'), {
                saveBase64AsFile: deps.saveBase64AsFile,
                fetchToDataUrl: typeof fetchImage === 'function' ? value => fetchImage(value, { signal }) : undefined,
            });
            if (!isDurableUrl(url, state.baseURI)) {
                throw new RpigError('LOCAL_DETAIL_FILE_SAVE_FAILED', '精修图片没有保存为酒馆文件，候选仍保留在预览中');
            }
            url = url.trim();
            state.files.set(raw, url);
        }
        throwIfAborted(signal);
        if (!snapshot.isCurrent(deps.getContext)) throw sourceChanged();
        const metadata = detailMetadata(snapshot, candidate, deps.diagnosticKeys || []);
        const model = candidate.generationResult?.model || '';
        const entry = { url, title: '局部精修', prompt: metadata.instruction, time: metadata.time, detailEdit: metadata, ...(model ? { model } : {}) };
        if (state.galleryOnly) {
            // This is the commit point for a gallery-only save.
            await gallerySave(snapshot, entry, deps);
            const result = { saved: true, url, messageIndex: null, galleryOnly: true, staleAfterSave: false };
            state.committed.set(raw, result);
            return result;
        }
        // No signal checks after this point: aborting an in-flight durable save
        // cannot honestly be reported as "not saved".
        const extra = state.message.extra;
        const hadMedia = Object.prototype.hasOwnProperty.call(extra, 'media');
        const previousMedia = extra.media;
        const media = Array.isArray(previousMedia) ? previousMedia : [];
        const previousItems = [...media];
        const hadDisplay = Object.prototype.hasOwnProperty.call(extra, 'media_display');
        const previousDisplay = extra.media_display;
        const item = { url, title: '局部精修', detailEdit: metadata };
        media.push(item);
        extra.media = media;
        extra.media_display = 'list';
        try {
            if (await deps.updateMessage(snapshot.messageIndex, state.message, state.context) === false) {
                throw new RpigError('LOCAL_DETAIL_CHAT_SAVE_FAILED', '会话保存未完成，候选仍保留在预览中');
            }
        } catch (error) {
            const otherMedia = media.filter(entry => entry !== item);
            const ownsDisplay = extra.media === media && extra.media_display === 'list'
                && otherMedia.length === previousItems.length
                && otherMedia.every((entry, index) => entry === previousItems[index]);
            rollbackAppend(extra, media, item, hadMedia, previousMedia);
            if (ownsDisplay) {
                if (hadDisplay) extra.media_display = previousDisplay;
                else delete extra.media_display;
            }
            throw error;
        }
        const result = { saved: true, url, messageIndex: snapshot.messageIndex, galleryOnly: false };
        // Record the durable chat commit before trying optional gallery/UI work.
        state.committed.set(raw, result);
        try { await gallerySave(snapshot, entry, deps); }
        catch (error) { result.galleryWarning = error?.message || String(error); }
        result.staleAfterSave = !snapshot.isCurrent(deps.getContext);
        if (!result.staleAfterSave && typeof deps.renderMessage === 'function') {
            try { await deps.renderMessage(snapshot.messageIndex, state.message, state.context); }
            catch (error) { result.renderWarning = error?.message || String(error); }
        }
        result.staleAfterSave = !snapshot.isCurrent(deps.getContext);
        return { ...result };
    });
    state.queue = operation.catch(() => {});
    return operation;
}
