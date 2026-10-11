// ============================================================
// RP 电影配图 - 图库与多视图持久化模块
// ============================================================

import { stripHtml, RpigError, isAbortError, scrubSensitiveText, throwIfAborted } from './utils.js';

const REFS_DB_NAME = 'rpig-refs';
const REFS_STORE = 'refs';
const GALLERY_DB_NAME = 'rpig-gallery';
const GALLERY_STORE = 'gallery';

export const MAX_UPLOAD_FILE_SIZE = 15 * 1024 * 1024; // 单张 15MB
export const MAX_BATCH_UPLOAD = 10;                  // 单次批量上限 10 张
export const MAX_REFS_PER_CHAR = 50;                 // 每角色参考图上限 50 张

/**
 * 解析 Data URL 中的纯 Base64 正文与文件扩展名
 * @param {string} dataUrl 
 * @returns {{ extension: string, base64Body: string } | null}
 */
export function parseDataUrl(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    const match = dataUrl.match(/^data:image\/([a-zA-Z0-9\+\-]+);base64,(.+)$/s);
    if (!match) return null;
    const rawExt = match[1].toLowerCase();
    const extMap = {
        jpeg: 'jpg',
        jpg: 'jpg',
        png: 'png',
        webp: 'webp',
        gif: 'gif',
        avif: 'avif',
    };
    const extension = extMap[rawExt] || 'png';
    const base64Body = match[2].trim();
    return { extension, base64Body };
}

/**
 * 获取角色唯一标识字符串
 * @param {object|string|number} characterOrId 
 * @returns {string}
 */
export function getCharacterIdentifier(characterOrId) {
    if (!characterOrId) return 'default';
    if (characterOrId === 'user') return 'user';
    if (typeof characterOrId === 'object') {
        return characterOrId.avatar || characterOrId.name || 'default';
    }
    return String(characterOrId);
}

/**
 * 判断某条聊天消息是否归属于指定角色（用于群聊隔离）
 * @param {object} msg 
 * @param {object} character 
 * @returns {boolean}
 */
export function isMessageForCharacter(msg, character) {
    if (!msg || msg.is_user) return false;
    if (!character) return true;

    const charAvatar = character.avatar;
    const charName = character.name;

    if (msg.original_avatar && charAvatar) {
        return msg.original_avatar === charAvatar;
    }
    if (msg.name && charName) {
        return msg.name === charName;
    }
    // 单人聊天回退
    return true;
}

/**
 * 查找连续性参考图：同一条消息重生成时优先使用本轮上一张；
 * 当前消息没有匹配图片时，再回溯同一角色之前的剧情配图。
 * @param {Array} chat
 * @param {number} beforeIndex
 * @param {object} character
 * @param {object} [options]
 * @returns {{url:string, prompt:string, messageIndex:number, sourceType:string}|null}
 */
export function getPreviousGeneratedImage(chat, beforeIndex, character, options = {}) {
    if (!Array.isArray(chat) || !Number.isInteger(beforeIndex) || beforeIndex < 0 || beforeIndex >= chat.length) return null;
    const strictCharacterMatch = options.strictCharacterMatch !== false;

    const getCandidate = (msg, messageIndex, sourceType) => {
        const info = msg?.extra?.rpigInfo;
        if (!msg || msg.is_user || !info) return null;

        const swipes = Array.isArray(msg.extra?.image_swipes)
            ? msg.extra.image_swipes.filter(url => typeof url === 'string' && url)
            : [];
        const media = Array.isArray(msg.extra?.media) ? msg.extra.media : [];
        const generatedMedia = media.filter(item => item?.url &&
            (info || /(?:RP|剧情剧照|微表情特写|配图)/i.test(item.title || '')));
        const savedOutputUrl = typeof info.outputUrl === 'string' ? info.outputUrl : '';
        const legacyUrl = typeof msg.extra?.image === 'string' ? msg.extra.image : '';
        // 当前滑动图优先；其次使用本插件保存的“本轮最终成图”，避免酒馆清空 media 后回退到旧轮次。
        const url = swipes[swipes.length - 1]
            || savedOutputUrl
            || generatedMedia[generatedMedia.length - 1]?.url
            || legacyUrl;
        if (!url) return null;

        return {
            url,
            prompt: typeof info.basePrompt === 'string'
                ? info.basePrompt
                : (typeof info.prompt === 'string' ? info.prompt : ''),
            sceneState: info.sceneState || null,
            messageIndex,
            sourceType,
        };
    };

    // 同一消息连续生成：仅当上一张图确实对应当前文本时才复用，防止滑动/改写后串图。
    const currentMessage = chat[beforeIndex];
    const currentInfo = currentMessage?.extra?.rpigInfo;
    const currentFocus = stripHtml(currentMessage?.mes || '').slice(0, 80);
    const savedFocus = typeof currentInfo?.focusSnippet === 'string' ? currentInfo.focusSnippet.trim() : '';
    if (savedFocus && savedFocus === currentFocus) {
        const currentCandidate = getCandidate(currentMessage, beforeIndex, 'same_message');
        if (currentCandidate) return currentCandidate;
        // 已知当前轮曾生成过图，却找不到它的有效地址：禁止退回更早镜头。
        // 否则旧场景、旧造型会被高保真图生图重新带回，造成角色“突然换人”。
        return null;
    }

    for (let i = Math.min(beforeIndex - 1, chat.length - 1); i >= 0; i--) {
        const msg = chat[i];
        if (!msg || msg.is_user) continue;
        // 群聊必须严格按角色隔离；单人聊天允许角色改名或名称尾缀变化。
        if (strictCharacterMatch && !isMessageForCharacter(msg, character)) continue;

        const candidate = getCandidate(msg, i, 'previous_message');
        if (candidate) return candidate;
    }
    return null;
}

/**
 * 将媒体 URL（尤其是 Base64 Data URL 或临时远程 URL）通过酒馆工具持久化为服务器文件路径
 * 严格遵照 SillyTavern saveBase64AsFile(base64Data, subFolder, fileName, extension) 4 参数签名
 * @param {string} rawUrl 
 * @param {string} [characterName] 
 * @param {object} [options] 
 * @returns {Promise<string>}
 */
export async function persistMediaUrl(rawUrl, characterName = 'character', options = {}) {
    throwIfAborted(options.signal);
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error('无效的媒体 URL');
    }

    const saveFn = options.saveBase64AsFile
        || (typeof window !== 'undefined' && window.saveBase64AsFile);

    const safeFolder = (characterName || 'cinematic').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
    const fileName = `rpig_${Date.now()}`;

    // 1. 如果是 Data URL：解析纯 Base64 并调用 4 参数接口 saveBase64AsFile(base64Data, subFolder, fileName, extension)
    if (rawUrl.startsWith('data:')) {
        const parsed = parseDataUrl(rawUrl);
        if (!parsed) {
            throw new Error('Data URL 格式无效，无法解析 Base64 图像');
        }

        if (typeof saveFn !== 'function') {
            throw new Error('未提供 saveBase64AsFile 持久化接口');
        }

        try {
            const savedPath = await saveFn(parsed.base64Body, safeFolder, fileName, parsed.extension);
            throwIfAborted(options.signal);
            if (typeof savedPath === 'string' && savedPath.trim()) {
                return savedPath.trim();
            }
            throw new Error('saveBase64AsFile 返回了空路径');
        } catch (err) {
            if (isAbortError(err)) throw err;
            console.error('[RP 电影配图] saveBase64AsFile 存储异常:', err);
            throw new Error(`媒体文件保存到酒馆服务器失败：${err.message || err}`);
        }
    }

    // 2. 如果是远程 HTTP/HTTPS 临时链接，尝试通过 fetchToDataUrl 下载后再持久化
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        const fetchFn = options.fetchToDataUrl;
        if (typeof fetchFn !== 'function') {
            throw new Error('未提供 fetchToDataUrl 下载接口，无法持久化远程临时图片');
        }
        if (typeof saveFn !== 'function') {
            throw new Error('未提供 saveBase64AsFile 存储接口，无法持久化远程临时图片');
        }

        let fetchedDataUrl;
        try {
            fetchedDataUrl = await fetchFn(rawUrl, { signal: options.signal });
            throwIfAborted(options.signal);
        } catch (fetchErr) {
            if (isAbortError(fetchErr)) throw fetchErr;
            throw new RpigError('TEMP_IMAGE_DOWNLOAD_FAILED', `生成接口已返回图片链接，但临时图片无法下载：${scrubSensitiveText(fetchErr.message || String(fetchErr))}。这不是 edits 不支持；请检查下载请求的 CORS、链接有效期与 HTTP 状态`, { reason: fetchErr.code || fetchErr.name });
        }

        const parsed = parseDataUrl(fetchedDataUrl);
        if (!parsed) {
            throw new Error('远程临时图片转 Base64 格式无效');
        }

        try {
            const savedPath = await saveFn(parsed.base64Body, safeFolder, fileName, parsed.extension);
            throwIfAborted(options.signal);
            if (typeof savedPath === 'string' && savedPath.trim()) {
                return savedPath.trim();
            }
            throw new Error('saveBase64AsFile 返回了空路径');
        } catch (saveErr) {
            if (isAbortError(saveErr)) throw saveErr;
            throw new Error(`远程临时图片保存到服务器失败：${saveErr.message || saveErr}`);
        }
    }

    // 3. 酒馆本地相对路径（如 /User Avatars/... 或 img/...），直接返回
    return rawUrl;
}

// ------------------------------------------------------------
// IndexedDB: 多视图参考图
// ------------------------------------------------------------
function openImageDB(name, storeName, label, errorPrefix) {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            return reject(new Error('IndexedDB 不可用'));
        }
        const request = indexedDB.open(name, 1);
        let abandoned = false;
        const timer = setTimeout(() => { abandoned = true; reject(new RpigError(`${errorPrefix}_BLOCKED`, `${label}打开超时，请关闭其他酒馆标签页后重试`)); }, 10000);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(storeName, { keyPath: 'characterId' });
        };
        request.onsuccess = () => {
            clearTimeout(timer);
            const db = request.result;
            db.onversionchange = () => db.close();
            if (abandoned) db.close(); else resolve(db);
        };
        request.onerror = () => { clearTimeout(timer); reject(request.error); };
        request.onblocked = () => { clearTimeout(timer); abandoned = true; reject(new RpigError(`${errorPrefix}_BLOCKED`, `${label}被其他标签页阻塞，请关闭其他酒馆标签页后重试`)); };
    });
}

export function openRefsDB() {
    return openImageDB(REFS_DB_NAME, REFS_STORE, '参考图库', 'REFERENCE_STORAGE');
}

export function openGalleryDB() {
    return openImageDB(GALLERY_DB_NAME, GALLERY_STORE, '角色图库', 'GALLERY_STORAGE');
}

/** Read/modify/write in one transaction so concurrent writers never overwrite a stale snapshot. */
async function accessImageList(openDB, storeName, field, key, update, errorPrefix, label) {
    if (!key || key === 'default') return [];
    let db;
    try {
        db = await openDB();
        return await new Promise((resolve, reject) => {
            let tx;
            let result = [];
            let operationError;
            try {
                tx = db.transaction(storeName, update ? 'readwrite' : 'readonly');
                tx.oncomplete = () => resolve(result);
                tx.onerror = tx.onabort = () => reject(operationError || tx.error || new Error(`${label}事务已中止`));
                const store = tx.objectStore(storeName);
                const req = store.get(key);
                req.onerror = () => reject(req.error);
                req.onsuccess = () => {
                    try {
                        result = Array.isArray(req.result?.[field]) ? req.result[field] : [];
                        if (update) {
                            result = update(result);
                            if (!Array.isArray(result)) throw new TypeError('图库更新必须返回数组');
                            store.put({ characterId: key, [field]: result });
                        }
                    } catch (error) {
                        operationError = error;
                        tx.abort();
                    }
                };
            } catch (error) {
                operationError = error;
                try { tx?.abort(); } catch { /* The transaction may already have ended. */ }
                reject(error);
            }
        });
    } catch (error) {
        const action = update ? '保存' : '读取';
        const failure = new RpigError(`${errorPrefix}_${update ? 'WRITE' : 'READ'}_FAILED`, `${label}${action}失败：${error?.name || 'Error'}：${error?.message || error}${update ? '' : '。读取失败不等于图库为空'}`, { reason: error?.code || error?.name });
        console.error('[RP 电影配图]', failure);
        throw failure;
    } finally { db?.close(); }
}

function cleanStoredImage(image) {
    const item = { ...image };
    if (typeof item.url === 'string' && item.url && !item.url.startsWith('data:')) delete item.dataUrl;
    return item;
}

let referenceIdSequence = 0;
function newReferenceId() {
    let entropy;
    try { entropy = globalThis.crypto?.randomUUID?.(); } catch { /* Older WebViews may lack a secure context. */ }
    return `ref_${entropy || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}_${++referenceIdSequence}`;
}

function referencesHaveIds(views) {
    const seen = new Set();
    return views.every(view => {
        const id = view?.refId;
        if (typeof id !== 'string' || !id.trim() || seen.has(id)) return false;
        seen.add(id); return true;
    });
}

function ensureReferenceIds(views) {
    const used = new Set();
    return views.map(view => {
        const item = cleanStoredImage(view);
        let id = item.refId;
        if (typeof id !== 'string' || !id.trim() || used.has(id)) {
            do { id = newReferenceId(); } while (used.has(id));
        }
        used.add(id);
        return { ...item, refId: id };
    });
}

export async function getCharacterRefs(characterOrId) {
    const views = await accessImageList(openRefsDB, REFS_STORE, 'views', getCharacterIdentifier(characterOrId), null, 'REFERENCE_STORAGE', '参考图库');
    if (referencesHaveIds(views)) return views;
    // Re-read inside the write transaction: another tab may have imported or
    // edited references after the initial read. Never migrate that stale list.
    try { return await updateCharacterRefs(characterOrId, current => current); }
    catch (error) {
        throw new RpigError('REFERENCE_STORAGE_READ_FAILED', `参考图库标识迁移失败：${error?.message || error}。读取失败不等于图库为空`, { reason: error?.code || error?.name });
    }
}

/** The callback must be synchronous; async work belongs before the transaction. */
export function updateCharacterRefs(characterOrId, update) {
    return accessImageList(openRefsDB, REFS_STORE, 'views', getCharacterIdentifier(characterOrId), views => {
        const next = update(ensureReferenceIds(views));
        if (!Array.isArray(next)) throw new TypeError('参考图更新必须返回数组');
        if (next.length > MAX_REFS_PER_CHAR) throw new Error(`参考图数量超过上限 (${MAX_REFS_PER_CHAR} 张)，未保存或截断`);
        return ensureReferenceIds(next);
    }, 'REFERENCE_STORAGE', '参考图库');
}

export async function saveCharacterRefs(characterOrId, views) {
    await updateCharacterRefs(characterOrId, () => views || []);
}

// ------------------------------------------------------------
// IndexedDB: 角色专属图库
// ------------------------------------------------------------
export function getStoredGallery(characterOrId) {
    return accessImageList(openGalleryDB, GALLERY_STORE, 'images', getCharacterIdentifier(characterOrId), null, 'GALLERY_STORAGE', '角色图库');
}

function updateStoredGallery(characterOrId, update) {
    return accessImageList(openGalleryDB, GALLERY_STORE, 'images', getCharacterIdentifier(characterOrId), update, 'GALLERY_STORAGE', '角色图库');
}

export async function saveToGallery(characterOrId, entry) {
    if (!entry) return;
    await updateStoredGallery(characterOrId, images => {
        const targetUrl = entry.url || entry.dataUrl;
        const filtered = images.filter(i => i.url !== targetUrl && i.dataUrl !== targetUrl);
        return [cleanStoredImage(entry), ...filtered].slice(0, 300);
    });
}

export async function removeFromGallery(characterOrId, targetUrl) {
    if (!targetUrl) return;
    await updateStoredGallery(characterOrId, images => images.filter(i => i.url !== targetUrl && i.dataUrl !== targetUrl));
}

// ------------------------------------------------------------
// 全源聚合与彻底删除
// ------------------------------------------------------------
export async function getAllImagesForCharacter(character, getContextFn) {
    const images = [];
    const seenUrls = new Set();

    const addImg = (url, title, time) => {
        if (!url || typeof url !== 'string' || seenUrls.has(url)) return;
        seenUrls.add(url);
        images.push({
            url: url,
            title: title || '配图',
            time: time || Date.now(),
        });
    };

    // 1. 扫描当前聊天窗口的对应角色配图（群聊按身份过滤）
    try {
        const context = typeof getContextFn === 'function' ? getContextFn() : null;
        const chat = context?.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (!msg || msg.is_user) continue;
            if (!isMessageForCharacter(msg, character)) continue;

            const t = Date.parse(msg.send_date) || (Date.now() - (chat.length - i) * 1000);
            if (Array.isArray(msg.extra?.media)) {
                for (const m of msg.extra.media) {
                    if (m?.url) addImg(m.url, m.title || `聊天配图 · #${i}`, t);
                }
            }
            if (typeof msg.extra?.image === 'string' && msg.extra.image) {
                addImg(msg.extra.image, `聊天配图 · #${i}`, t);
            }
            if (Array.isArray(msg.extra?.image_swipes)) {
                for (const u of msg.extra.image_swipes) {
                    if (typeof u === 'string' && u) addImg(u, `聊天配图 · #${i}`, t);
                }
            }
        }
    } catch (e) {
        console.warn('[RP 电影配图] 扫描聊天媒体异常:', e);
    }

    // 2. 聚合三视图 / 全身立绘参考图
    try {
        if (character) {
            const refs = await getCharacterRefs(character);
            for (const r of refs) {
                if (r?.dataUrl || r?.url) addImg(r.url || r.dataUrl, r.label || '形象参考图', Date.now());
            }
        }
    } catch (error) { console.error('[RP 电影配图] 图库中的参考图读取失败:', error); throw error; }

    // 3. 聚合 IndexedDB 独立图库记录
    try {
        const charKey = getCharacterIdentifier(character);
        const stored = await getStoredGallery(charKey);
        for (const s of stored) {
            addImg(s.url || s.dataUrl, s.title, s.time);
        }
    } catch (error) { console.error('[RP 电影配图] 角色图库读取失败:', error); throw error; }

    images.sort((a, b) => (b.time || 0) - (a.time || 0));
    return images;
}

/**
 * 彻底删除图片：同时清理 IndexedDB 图库、参考图与当前会话消息中的挂载
 */
export async function deleteImageCompletely(character, targetUrl, getContextFn) {
    const context = typeof getContextFn === 'function' ? getContextFn() : null;
    const chat = context?.chat || [];
    const session = [context?.chatId, context?.characterId, context?.groupId,
        typeof window !== 'undefined' ? window.selected_chat : undefined];
    const result = { affectedMessageIndexes: [], chatModified: false, chatSkipped: false, context };
    if (!targetUrl) return result;

    // 1. 从图库数据库删除
    if (character) {
        await removeFromGallery(character, targetUrl);
    }

    // 2. 从参考图列表删除
    if (character) {
        try {
            await updateCharacterRefs(character, refs => refs.filter(r => r.dataUrl !== targetUrl && r.url !== targetUrl));
        } catch (error) { console.error('[RP 电影配图] 删除参考图失败:', error); throw error; }
    }

    // 3. 从当前聊天消息 extra.media 中清除并保存会话
    try {
        if (typeof getContextFn === 'function') {
            const current = getContextFn();
            const currentSession = [current?.chatId, current?.characterId, current?.groupId,
                typeof window !== 'undefined' ? window.selected_chat : undefined];
            if (current?.chat !== context?.chat || currentSession.some((id, index) => id !== session[index])) {
                result.chatSkipped = true;
                return result;
            }
        }

        const changes = [];

        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg?.extra) continue;
            const next = {};
            if (Array.isArray(msg.extra.media)) {
                const media = msg.extra.media.filter(m => !m || m.url !== targetUrl);
                if (media.length !== msg.extra.media.length) next.media = media;
            }
            if (msg.extra.image === targetUrl) next.image = undefined;
            if (msg.extra.rpigInfo?.outputUrl === targetUrl) {
                next.rpigInfo = { ...msg.extra.rpigInfo };
                delete next.rpigInfo.outputUrl;
            }
            if (Array.isArray(msg.extra.image_swipes)) {
                const swipes = msg.extra.image_swipes.filter(u => u !== targetUrl);
                if (swipes.length !== msg.extra.image_swipes.length) next.image_swipes = swipes;
            }
            if (Object.keys(next).length) {
                const previous = Object.fromEntries(Object.keys(next).map(key => [key, { value: msg.extra[key], exists: Object.prototype.hasOwnProperty.call(msg.extra, key) }]));
                changes.push({ extra: msg.extra, previous, next });
                result.affectedMessageIndexes.push(i);
            }
        }

        if (changes.length) {
            if (typeof context?.saveChat !== 'function') throw new RpigError('GALLERY_CHAT_SAVE_FAILED', '当前会话无法保存，聊天中的图片未删除');
            for (const { extra, next } of changes) for (const [key, value] of Object.entries(next)) {
                if (value === undefined) delete extra[key]; else extra[key] = value;
            }
            try {
                if (await context.saveChat() === false) throw new RpigError('GALLERY_CHAT_SAVE_FAILED', '会话保存失败');
            } catch (error) {
                // Undo only fields still owned by this deletion. Preserve
                // concurrent changes made while chat persistence was pending.
                for (const { extra, previous, next } of changes) for (const [key, saved] of Object.entries(previous)) {
                    if (extra[key] !== next[key]) continue;
                    if (saved.exists) extra[key] = saved.value; else delete extra[key];
                }
                throw error;
            }
            result.chatModified = true;
        }
    } catch (e) {
        console.warn('[RP 电影配图] 清除聊天挂载媒体异常:', e);
        throw e;
    }
    return result;
}
