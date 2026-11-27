// The state the page shows for one account, built from the context.
import { currencyInfo as gameCurrencyInfo } from './game/currencies.mjs';
import { compareVersions } from './game/model.mjs';
import { accountLabel, unitSlug } from './userdata.mjs';

/** The requested account if the tracker knows it, else the first one, or null when there is none yet. */
export function resolveAccount(ctx, requested) {
  const ids = [...ctx.accounts.keys()];
  return ids.includes(requested) ? requested : ids[0] || null;
}

/** Whether the game build that wrote the save is newer than the game data's. */
export const dataStale = (ctx) => {
  const built = ctx.tables.gameData?.gameBuild, seen = ctx.scan.gameBuild;
  return !!(seen && built && compareVersions(seen, built) > 0);
};

/** App update for the page: { version, auto, state, error, later, done, total }, or null when this is the latest. */
function updateState(ctx) {
  const { appUpdate } = ctx;
  if (!appUpdate.newVersion) return null;
  return {
    version: appUpdate.newVersion,
    auto: ctx.official && !!appUpdate.latestApp, // can download and install itself
    state: appUpdate.state, error: appUpdate.error,
    later: appUpdate.later === appUpdate.newVersion,
    done: appUpdate.done, total: appUpdate.total,
  };
}

/** State that changes without a new revision (also sent with "unchanged" answers). */
export function liveState(ctx) {
  return {
    lastScan: ctx.scan.lastScan, lastError: ctx.scan.lastError, problems: ctx.errorLog.list().length,
    gameRunning: ctx.game.running(), update: updateState(ctx),
  };
}

/** Tags used in the given armies, most frequent first: [{ tag, count }]. */
function tagList(armies) {
  const m = new Map();
  for (const a of armies) for (const t of a.tags || []) {
    const e = m.get(t.toLowerCase()) || { tag: t, count: 0 };
    e.count++;
    m.set(t.toLowerCase(), e);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** The full state for one account (resolveAccount first). */
export function buildState(ctx, account) {
  const { user: u, tables: t, gameData } = ctx;
  const ids = [...ctx.accounts.keys()];
  const acc = account && ctx.accounts.get(account);
  const picks = (account && u.talents[account]) || {};
  const slots = (account && u.army[account]) || {};
  const slug = (id) => unitSlug(ctx, id);
  const currencyInfo = (id) => gameCurrencyInfo(id, { events: t.events, rules: t.rules, activeEvents: acc?.activeEvents || [] });
  const withSlugs = (shop) => ({
    ...shop,
    grid: { ...shop.grid, rows: shop.grid.rows.map((row) => row.map((s) => (s.mini ? { ...s, slug: slug(s.mini) } : s))) },
    offers: shop.offers.map((o) => ({ ...o, slugs: o.minis.map(slug) })),
  });
  return {
    rev: ctx.rev,
    ...liveState(ctx),
    account,
    accounts: ids.map((id) => ({ id, label: accountLabel(ctx, id), units: ctx.accounts.get(id).snapshot?.units.length || 0 })),
    units: acc?.snapshot ? acc.snapshot.units.map((x) => ({ ...x, slug: slug(x.id), talentPicks: picks[x.id] || [],
      army: slots[x.id] || null })) : [],
    currencies: acc?.snapshot ? acc.snapshot.currencies.map((c) => ({ ...c, ...currencyInfo(c.id) })) : [],
    currencyNames: Object.fromEntries(Object.values(t.rules.currencyIds || {}).map((id) => [id, currencyInfo(id).name])),
    events: acc ? acc.events.slice(-200) : [],
    activeEvents: acc?.activeEvents || [],
    pvp: acc?.pvp || null,
    pvpLog: acc?.pvp ? (u.pvpHistory[account] || []).filter((e) => e.season === acc.pvp.season) : [],
    activeEventsAt: acc?.activeEventsAt || null,
    incomeBonuses: acc?.incomeBonuses || [],
    ownedAvatars: acc?.ownedAvatars || [],
    plans: (account && u.plans[account]) || {},
    progress: (account && u.progress[account]) || null,
    // Game build of the tables vs. the build that wrote the save.
    dataStatus: {
      dataBuild: t.gameData?.gameBuild || null,
      dataVersion: t.gameData?.dataVersion || null,
      gameBuild: ctx.scan.gameBuild,
      stale: dataStale(ctx),
      // reading: game data is being read now (readingForTracker: a new version of the tracker reads it anew);
      // canRead: this tracker reads it by itself
      reading: gameData.reading, readingForTracker: gameData.reading && gameData.forTracker, canRead: gameData.canBuild,
      readError: gameData.error,
    },
    // Shop with unit IDs resolved to slugs (null if unknown), plus G.R.I.D. history.
    shop: acc?.shop ? withSlugs(acc.shop) : null,
    gridHistory: ((account && u.gridHistory[account]) || []).slice(-120).map((g) =>
      ({ ...g, items: g.items.map((x) => ({ ...x, slug: x.mini ? slug(x.mini) : null })) })),
    savedArmies: (account && u.armies[account]) || [],
    armyTags: tagList((account && u.armies[account]) || []),
    draft: (account && u.drafts[account]) || null,
    standalone: ctx.standalone,
    appVersion: ctx.appVersion,
  };
}
