import { stripHtml } from './utils.js';

// These blocks belong to the chat's game UI, recap, or bonus interlude.
// They do not describe the moment in the main narrative being illustrated.
export function storyTextForIllustration(rawStory) {
    let text = String(rawStory || '');
    text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
    for (const tag of ['lantern_event', 'lantern_recap', 'lantern_interlude', 'w2g', 'catsay', 'UpdateVariable', 'JSONPatch']) {
        text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi'), '');
    }
    // Only the observed summary card is removed; unrelated details may be story.
    text = text.replace(/<details\b[^>]*>\s*<summary\b[^>]*>\s*小总结\s*<\/summary>[\s\S]*?(?:<\/details\s*>|$)/gi, '');
    return stripHtml(text).trim();
}
