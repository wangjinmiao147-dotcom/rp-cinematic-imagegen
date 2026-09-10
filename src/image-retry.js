// Keep completed analysis only for failed image attempts, within this page/session.
// Never persist prompts or credentials in browser storage or chat metadata.
export function createImageRetryCache() {
    let entries = new WeakMap();
    const copy = value => JSON.parse(JSON.stringify(value));
    return {
        get(message, signature) {
            const entry = entries.get(message);
            if (entry?.signature !== signature) { entries.delete(message); return null; }
            return copy(entry.analysis);
        },
        save(message, signature, analysis) { entries.set(message, { signature, analysis: copy(analysis) }); },
        delete(message) { entries.delete(message); },
        clear() { entries = new WeakMap(); },
    };
}

export function imageRetrySignature({ sessionKey, messageIndex, message, dialogueHistory, participantContext,
    character, characterAnchor, previousGenerated, settings, shotMode, promptFormat, presetPrompt, presetAvoid, generationMeta }) {
    return JSON.stringify({ sessionKey, messageIndex, message: [message.mes, message.swipe_id, message.send_date],
        dialogueHistory, participantContext, character: [character?.avatar, character?.name, character?.data?.description || character?.description], characterAnchor,
        previousGenerated, shotMode, promptFormat,
        // Endpoint/key/image-model repairs must not force another round of text calls.
        style: settings.stylePreset, omniscient: settings.omniscientMode,
        useCharacterImage: settings.useCharacterImage, usePreviousImage: settings.usePreviousImage,
    });
}
