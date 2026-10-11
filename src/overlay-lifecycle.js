/** Own both mounted overlays and pending asynchronous open requests. */
export function createOverlayLifecycle() {
    const active = new Map();
    const close = kind => active.get(kind)?.close();
    return {
        begin(kind) {
            close(kind);
            let closed = false;
            let cleanup;
            const handle = {
                isCurrent: () => !closed && active.get(kind) === handle,
                setCleanup(fn) {
                    if (closed) fn();
                    else cleanup = fn;
                },
                close() {
                    if (closed) return;
                    closed = true;
                    if (active.get(kind) === handle) active.delete(kind);
                    cleanup?.();
                },
            };
            active.set(kind, handle);
            return handle;
        },
        close,
        has: kind => active.has(kind),
        closeAll() {
            for (const handle of [...active.values()]) handle.close();
        },
    };
}

/** Capture identities rather than the context object, which the host may recreate. */
export function captureOverlayContext(context, messageIndex, readSelection = () => globalThis.window?.selected_chat) {
    const chat = context?.chat;
    const identity = [context?.chatId, context?.characterId, context?.groupId, readSelection()];
    const hasMessage = Number.isInteger(messageIndex);
    const message = hasMessage ? chat?.[messageIndex] : null;
    const text = message?.mes;
    const swipe = message?.swipe_id;
    const dateValue = value => value instanceof Date ? value.getTime() : value;
    const date = dateValue(message?.send_date);
    return {
        context,
        isCurrent(current) {
            if (!current || current.chat !== chat) return false;
            const next = [current.chatId, current.characterId, current.groupId, readSelection()];
            if (next.some((value, index) => value !== identity[index])) return false;
            if (!hasMessage) return true;
            const item = current.chat?.[messageIndex];
            return !!message && item === message && item.mes === text && item.swipe_id === swipe
                && dateValue(item.send_date) === date;
        },
    };
}
