// API handlers that change the user's data. Each takes the parsed JSON body and returns [status, body]; error
// messages are shown to the player as they are.
import { unitSlug } from '../userdata.mjs';
import { LIMITS, cleanTags } from '../../web/scripts/lib/limits.js';
import { APP_NAME } from '../../web/scripts/lib/constants.js';
import { newId } from '../../web/scripts/lib/ids.js';

const isId = (s) => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);
// every mini has three talents, numbered 0 to 2
const isTalent = (v) => Number.isInteger(v) && v >= 0 && v < 3;

// The page only sends these for accounts and units it shows, so they mean the page is out of date.
const STALE = [400, { error: 'The tracker could not save this. Reload the page and try again.' }];

/** A saved army with only known minis, valid talents and bounded text. */
export function cleanArmy(a, slugs, { keepEmptyId = false } = {}) {
  const okSlug = (s) => typeof s === 'string' && slugs.has(s);
  return {
    id: String(a?.id || '').slice(0, 40) || (keepEmptyId ? null : newId()),
    name: String(a?.name || 'Army').trim().slice(0, LIMITS.armyName) || 'Army',
    leader: okSlug(a?.leader) ? a.leader : null,
    minis: Array.from({ length: 6 }, (_, i) => (okSlug(a?.minis?.[i]) ? a.minis[i] : null)),
    talents: Object.fromEntries(Object.entries(a?.talents || {}).filter(([k, v]) => okSlug(k) && isTalent(v))),
    description: String(a?.description || '').slice(0, LIMITS.description),
    tags: cleanTags(a?.tags),
  };
}

// An exported armory: one account's saved armies, to keep or share, and to import into any account.
const ARMORY_FORMAT = 'rumble-tracker-armory';

/** The file Export armory downloads: the armies without their IDs, which only matter inside one tracker. */
export function armoryFile(armies, now = new Date()) {
  return { format: ARMORY_FORMAT, version: 1, exported: now.toISOString(), armies: armies.map(({ id, ...a }) => a) };
}

/**
 * The saved armies with the armies of an exported armory added: cleaned, with new IDs, skipping ones already there
 * (same name, leader, minis and talents) and ones beyond the limit. Returns { armies, added, duplicates, full }, or
 * null when `file` isn't an exported armory.
 */
export function addArmory(saved, file, slugs) {
  if (file?.format !== ARMORY_FORMAT || !Array.isArray(file.armies)) return null;
  const key = (a) => JSON.stringify([a.name, a.leader, a.minis, Object.entries(a.talents).sort()]);
  const have = new Set(saved.map(key));
  const armies = [...saved];
  let added = 0, duplicates = 0, full = 0;
  for (const raw of file.armies.slice(0, 10 * LIMITS.savedArmies)) {
    const army = cleanArmy({ ...raw, id: newId() }, slugs);
    if (have.has(key(army))) duplicates++;
    else if (armies.length >= LIMITS.savedArmies) full++;
    else {
      armies.push(army);
      have.add(key(army));
      added++;
    }
  }
  return { armies, added, duplicates, full };
}

export function createHandlers(ctx) {
  const u = () => ctx.user;
  /** The answer once `saved` (the write of what changed) is done. */
  const ok = async (saved, body = { ok: true }, bump = true) => {
    await saved;
    if (bump) ctx.bump();
    return [200, body];
  };

  return {
    /** Names an account or assigns a mini to a unit ID: { kind: 'account'|'unit', id, value }. */
    async name({ kind, id, value }) {
      const v = typeof value === 'string' ? value.trim() : '';
      const names = u().names;
      if (!isId(id) || (kind !== 'unit' && kind !== 'account')) return STALE;
      if (kind === 'unit') {
        if (v && !ctx.tables.slugs.has(v)) return [400, { error: 'That mini is not in the game data.' }];
        const ids = new Set([...Object.keys(ctx.tables.builtinUnits), ...Object.keys(names.units)]);
        const takenBy = [...ids].find((other) => other !== id && unitSlug(ctx, other) === v);
        if (v && takenBy) return [409, { error: 'That mini is already assigned to another unit.', takenBy }];
        return ok(u().setUnitSlug(id, v));
      }
      if (v.length > LIMITS.accountName) return [400, { error: `An account name can be at most ${LIMITS.accountName} characters long.` }];
      return ok(u().setAccountName(id, v));
    },

    /** Talents the user picked for a unit: { account, unitId, picks: [0..2] }. */
    async talents({ account, unitId, picks }) {
      if (!isId(account) || !isId(unitId) || !Array.isArray(picks)) return STALE;
      const clean = [...new Set(picks.filter(isTalent))].sort();
      return ok(u().setTalents(account, unitId, clean), { ok: true, picks: clean });
    },

    /** A leader's army slots: { account, unitId, slots: [{ type, tier, boost? }] }. */
    async army({ account, unitId, slots }) {
      const A = ctx.tables.rules.armySlots;
      const maxTier = A.tiers.length - 1;
      if (!isId(account) || !isId(unitId) || !Array.isArray(slots) || slots.length !== A.count) return STALE;
      const clean = slots.map((s, i) => ({
        type: i === A.leaderSlot ? 'Leader' : String(s?.type || '').slice(0, 40),
        tier: Math.max(0, Math.min(maxTier, Number.isInteger(s?.tier) ? s.tier : 0)),
        // Only the bottom-right slot can be a Boost slot.
        ...(i === A.boostSlot && s?.boost === true ? { boost: true } : {}),
      }));
      return ok(u().setArmySlots(account, unitId, clean), { ok: true, slots: clean });
    },

    /** Sets or clears a reward goal: { account, eventId, plan: { cost, label } | null }. */
    async plan({ account, eventId, plan }) {
      if (!isId(account) || typeof eventId !== 'string' || eventId.length > 80) return STALE;
      const clean = plan && Number.isInteger(plan.cost) && plan.cost > 0
        ? { cost: plan.cost, label: String(plan.label || 'your picks').slice(0, LIMITS.goalLabel), set: new Date().toISOString() }
        : null;
      return ok(u().setPlan(account, eventId, clean));
    },

    /** The army being edited: { account, draft }. No new revision, as the sending page already shows it. */
    async draft({ account, draft }) {
      if (!isId(account) || !draft || typeof draft !== 'object') return STALE;
      const clean = { ...cleanArmy(draft, ctx.tables.slugs, { keepEmptyId: true }), updated: new Date().toISOString() };
      return ok(u().setDraft(account, clean), { ok: true }, false);
    },

    /** All saved armies of an account: { account, armies }. */
    async armies({ account, armies }) {
      if (!isId(account) || !Array.isArray(armies)) return STALE;
      if (armies.length > LIMITS.savedArmies) return [400, {
        error: `You can keep at most ${LIMITS.savedArmies} saved armies. Delete one first.` }];
      const clean = armies.map((a) => cleanArmy(a, ctx.tables.slugs));
      return ok(u().setArmies(account, clean), { ok: true, armies: clean });
    },

    /** Adds the armies of an exported armory to an account's saved armies: { account, file }. */
    async importArmory({ account, file }) {
      if (!isId(account)) return STALE;
      const r = addArmory(u().armies[account] || [], file, ctx.tables.slugs);
      if (!r) return [400, { error: 'This file is not an Armory exported from the tracker.' }];
      return ok(u().setArmies(account, r.armies), { ok: true, added: r.added, duplicates: r.duplicates, full: r.full });
    },

    /**
     * The player's own result for an unexplained PvP change: { account, id, result: 'win' | 'loss' | null }. A page
     * from before the entries had IDs names it by its time, `t`.
     */
    async pvpResult({ account, id, t, result }) {
      if (!isId(account) || typeof (id ?? t) !== 'string') return STALE;
      if (!(await u().setPvpResult(account, id == null ? { t } : { id }, result ?? null))) {
        return [400, { error: 'Only changes marked as unexplained can be set by hand.' }];
      }
      return ok();
    },

    /**
     * Restores a backup file: { backup }. Answers what was restored, what was left out for what it holds, and of
     * what was restored the parts that lost some of what they held for an account (`incomplete`).
     */
    async restore({ backup }) {
      const r = await u().restore(backup);
      if (!r) return [400, { error: `This file is not a ${APP_NAME} backup.` }];
      ctx.bump();
      return [200, { ok: true, ...r, created: backup.created }];
    },
  };
}
