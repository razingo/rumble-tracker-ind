// Limits on what players enter, and tag cleaning. The page uses them for its inputs; the server enforces them.
export const LIMITS = {
  accountName: 40,
  armyName: 40,
  description: 1000,
  tag: 30,
  tagsPerArmy: 20,
  savedArmies: 50,
  goalLabel: 120,
};

/** A tag as stored: trimmed, single spaces, at most LIMITS.tag characters. */
export const cleanTag = (raw) => String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, LIMITS.tag);

const sameTag = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Cleaned, without duplicates (ignoring case), at most LIMITS.tagsPerArmy. */
export function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const v = cleanTag(t);
    if (v && !out.some((x) => sameTag(x, v))) out.push(v);
    if (out.length >= LIMITS.tagsPerArmy) break;
  }
  return out;
}

/**
 * The tags with `raw` added, or null when it is empty, already there or the army is full. A tag already in use
 * elsewhere (`known`) keeps its spelling.
 */
export function withTag(tags, raw, known = []) {
  const v = cleanTag(raw);
  if (!v || tags.some((t) => sameTag(t, v)) || tags.length >= LIMITS.tagsPerArmy) return null;
  return [...tags, known.find((t) => sameTag(t, v)) || v];
}

/**
 * A key in a tag box: Enter or a comma adds the typed tag, Backspace in an empty box removes the last one. Returns the
 * new tags, or null when the key changes nothing.
 */
export function tagKey(e, tags, known) {
  const input = e.target;
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const next = withTag(tags, input.value, known);
    input.value = '';
    return next;
  }
  if (e.key === 'Backspace' && !input.value && tags.length) return tags.slice(0, -1);
  return null;
}
