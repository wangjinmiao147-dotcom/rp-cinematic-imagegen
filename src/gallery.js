// ============================================================
// RP 电影配图 - 图库与多视图持久化模块
// ============================================================

import { blobToDataUrl, stripHtml, RpigError, isAbortError, scrubSensitiveText } from './utils.js';

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
            if (typeof savedPath === 'string' && savedPath.trim()) {
                return savedPath.trim();
            }
            throw new Error('saveBase64AsFile 返回了空路径');
        } catch (err) {
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
            fetchedDataUrl = await fetchFn(rawUrl);
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
            if (typeof savedPath === 'string' && savedPath.trim()) {
                return savedPath.trim();
            }
            throw new Error('saveBase64AsFile 返回了空路径');
        } catch (saveErr) {
            throw new Error(`远程临时图片保存到服务器失败：${saveErr.message || saveErr}`);
        }
    }

    // 3. 酒馆本地相对路径（如 /User Avatars/... 或 img/...），直接返回
    return rawUrl;
}

// ------------------------------------------------------------
// IndexedDB: 多视图参考图
// ------------------------------------------------------------
export function openRefsDB() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            return reject(new Error('IndexedDB 不可用'));
        }
        const request = indexedDB.open(REFS_DB_NAME, 1);
        let abandoned = false;
        const timer = setTimeout(() => { abandoned = true; reject(new RpigError('REFERENCE_STORAGE_BLOCKED', '参考图库打开超时，请关闭其他酒馆标签页后重试')); }, 10000);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(REFS_STORE, { keyPath: 'characterId' });
        };
        request.onsuccess = () => { clearTimeout(timer); if (abandoned) request.result.close(); else resolve(request.result); };
        request.onerror = () => { clearTimeout(timer); reject(request.error); };
        request.onblocked = () => { clearTimeout(timer); abandoned = true; reject(new RpigError('REFERENCE_STORAGE_BLOCKED', '参考图库被其他标签页阻塞，请关闭其他酒馆标签页后重试')); };
    });
}

export async function getCharacterRefs(characterOrId) {
    const key = getCharacterIdentifier(characterOrId);
    if (!key || key === 'default') return [];
    let db;
    try {
        db = await openRefsDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(REFS_STORE, 'readonly');
            const req = tx.objectStore(REFS_STORE).get(key);
            let views = [];
            req.onsuccess = () => { views = Array.isArray(req.result?.views) ? req.result.views : []; };
            req.onerror = () => reject(req.error);
            tx.oncomplete = () => { db.close(); resolve(views); };
            tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('参考图读取事务已中止')); };
        });
    } catch (error) {
        const failure = new RpigError('REFERENCE_STORAGE_READ_FAILED', `参考图库读取失败：${error?.name || 'Error'}：${error?.message || error}。读取失败不等于没有参考图`, { reason: error?.code || error?.name });
        console.error('[RP 电影配图]', failure);
        throw failure;
    } finally { db?.close(); }
}

export async function saveCharacterRefs(characterOrId, views) {
    const key = getCharacterIdentifier(characterOrId);
    if (!key || key === 'default') return;
    let db;
    try {
        db = await openRefsDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(REFS_STORE, 'readwrite');
            // 只保留 url 与 label，清理冗余的大 base64
            const cleanViews = (views || []).slice(0, MAX_REFS_PER_CHAR).map(v => {
                const item = { ...v };
                if (item.url && !item.url.startsWith('data:')) {
                    delete item.dataUrl;
                }
                return item;
            });
            tx.objectStore(REFS_STORE).put({ characterId: key, views: cleanViews });
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('参考图保存事务已中止')); };
        });
    } catch (e) {
        const failure = new RpigError('REFERENCE_STORAGE_WRITE_FAILED', `参考图保存失败：${e?.name || 'Error'}：${e?.message || e}`);
        console.error('[RP 电影配图]', failure);
        throw failure;
    } finally { db?.close(); }
}

// ------------------------------------------------------------
// IndexedDB: 角色专属图库
// ------------------------------------------------------------
export function openGalleryDB() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            return reject(new Error('IndexedDB 不可用'));
        }
        const request = indexedDB.open(GALLERY_DB_NAME, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(GALLERY_STORE, { keyPath: 'characterId' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function getStoredGallery(charKey) {
    if (!charKey || charKey === 'default') return [];
    try {
        const db = await openGalleryDB();
        return new Promise((resolve) => {
            const tx = db.transaction(GALLERY_STORE, 'readonly');
            const req = tx.objectStore(GALLERY_STORE).get(charKey);
            req.onsuccess = () => resolve(Array.isArray(req.result?.images) ? req.result.images : []);
            req.onerror = () => resolve([]);
        });
    } catch {
        return [];
    }
}

export async function saveToGallery(characterOrId, entry) {
    const key = getCharacterIdentifier(characterOrId);
    if (!key || key === 'default' || !entry) return;
    try {
        const db = await openGalleryDB();
        const images = await getStoredGallery(key);
        // 去重
        const targetUrl = entry.url || entry.dataUrl;
        const filtered = images.filter(i => (i.url !== targetUrl && i.dataUrl !== targetUrl));

        // 避免在独立图库中冗余塞入超大 base64
        const cleanEntry = { ...entry };
        if (cleanEntry.url && !cleanEntry.url.startsWith('data:')) {
            delete cleanEntry.dataUrl;
        }

        filtered.unshift(cleanEntry);
        return new Promise((resolve, reject) => {
            const tx = db.transaction(GALLERY_STORE, 'readwrite');
            tx.objectStore(GALLERY_STORE).put({ characterId: key, images: filtered.slice(0, 300) });
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e);
        });
    } catch (e) {
        if (typeof indexedDB !== 'undefined') {
            console.error('[RP 电影配图] 保存到图库失败:', e);
            throw e;
        }
    }
}

export async function removeFromGallery(characterOrId, targetUrl) {
    const key = getCharacterIdentifier(characterOrId);
    if (!key || !targetUrl) return;
    try {
        const db = await openGalleryDB();
        let images = await getStoredGallery(key);
        images = images.filter(i => (i.url !== targetUrl && i.dataUrl !== targetUrl));
        return new Promise((resolve, reject) => {
            const tx = db.transaction(GALLERY_STORE, 'readwrite');
            tx.objectStore(GALLERY_STORE).put({ characterId: key, images: images });
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e);
        });
    } catch (e) {
        if (typeof indexedDB !== 'undefined') {
            console.error('[RP 电影配图] 从图库移除失败:', e);
            throw e;
        }
    }
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
    } catch { /* ignore */ }

    images.sort((a, b) => (b.time || 0) - (a.time || 0));
    return images;
}

/**
 * 彻底删除图片：同时清理 IndexedDB 图库、参考图与当前会话消息中的挂载
 */
export async function deleteImageCompletely(character, targetUrl, getContextFn) {
    if (!targetUrl) return;

    // 1. 从图库数据库删除
    if (character) {
        await removeFromGallery(character, targetUrl);
    }

    // 2. 从参考图列表删除
    if (character) {
        try {
            const refs = await getCharacterRefs(character);
            const filteredRefs = refs.filter(r => r.dataUrl !== targetUrl && r.url !== targetUrl);
            if (filteredRefs.length !== refs.length) {
                await saveCharacterRefs(character, filteredRefs);
            }
        } catch (error) { console.error('[RP 电影配图] 删除参考图失败:', error); throw error; }
    }

    // 3. 从当前聊天消息 extra.media 中清除并保存会话
    try {
        const context = typeof getContextFn === 'function' ? getContextFn() : null;
        const chat = context?.chat || [];
        let chatModified = false;

        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg?.extra) continue;
            if (Array.isArray(msg.extra.media)) {
                const lenBefore = msg.extra.media.length;
                msg.extra.media = msg.extra.media.filter(m => m && m.url !== targetUrl);
                if (msg.extra.media.length !== lenBefore) {
                    chatModified = true;
                }
            }
            if (msg.extra.image === targetUrl) {
                delete msg.extra.image;
                chatModified = true;
            }
            if (Array.isArray(msg.extra.image_swipes)) {
                const lenBefore = msg.extra.image_swipes.length;
                msg.extra.image_swipes = msg.extra.image_swipes.filter(u => u !== targetUrl);
                if (msg.extra.image_swipes.length !== lenBefore) {
                    chatModified = true;
                }
            }
        }

        if (chatModified && typeof context?.saveChat === 'function') {
            await context.saveChat();
        }
    } catch (e) {
        console.warn('[RP 电影配图] 清除聊天挂载媒体异常:', e);
        throw e;
    }
}
