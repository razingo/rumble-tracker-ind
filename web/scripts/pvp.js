// PvP tab: the season, rank, Victory Road, season-end rewards and modifiers (gamedata/pvp.json), and the wins and
// losses the server works out from honor and Victory Point changes. The calculations are in lib/pvp-season.js.
import { poll } from './app.js';
import { loadEvents } from './calendar.js';
import { chartFrame, yLabel, linePath, timeScale } from './chart.js';
import { $, store, imageUrl, getJson, post, state, onTablesReload, ui } from './core.js';
import { alertDialog } from './dialogs.js';
import { esc, fmt, plural, when, dayOnly, span, ago } from './lib/format.js';
import { seasonAt, rankOf, nextRank, setAt, record, streak, matchesWithMods, modifierStats, withModifiers,
  winRateSeries } from './lib/pvp-season.js';

// The modifiers chosen to filter the win rate, kept between visits.
let chosenMods = store.get('pvpMods', []);

let PVP = null;
onTablesReload(() => { PVP = null; });
async function loadPvp() {
  if (PVP) return PVP;
  PVP = await getJson('/static/pvp.json', 'the PvP data');
  return PVP;
}

const pvpSeasonAt = (t) => seasonAt(PVP, t);
const pvpRankOf = (honor) => rankOf(PVP, honor);
const pvpNextRank = (rank) => nextRank(PVP, rank);
const pvpSetAt = (t) => setAt(PVP, t);
const pvpFrame = (rank) => (rank?.frame ? imageUrl('pvp', rank.frame) : '');
const modifierIcon = (m) => (m.icon ? `<img src="${imageUrl('pvp', m.icon)}" alt="">` : '');

function pvpReward(r) {
  const amount = r.amount != null && r.amount !== 1 ? `${fmt(r.amount)}× ` : r.amount === 1 && r.kind === 'currency' ? '1× ' : '';
  const icon = r.icon ? `<img src="${imageUrl('rewards', r.icon)}" alt="">` : '';
  const options = r.options ? ` <small class="muted">(pick from ${r.options})</small>` : '';
  return `<span class="pvp-reward">${icon}<span>${esc(amount)}${esc(r.label)}${options}</span></span>`;
}

/** A season chart's frame: full width, dates under the ends. */
const seasonFrame = (H, label, t0, t1) => ({ W: 1100, H, pad: 44, label, from: dayOnly(t0), to: dayOnly(t1), cls: 'chart pvp-chart' });

function pvpHonorChart(log, season) {
  const pts = log.map((e) => ({ t: Date.parse(e.t), honor: e.honor, e }));
  if (pts.length < 2) return '<p class="muted small">The chart fills in as the tracker sees your honor change.</p>';
  const t0 = Math.min(Date.parse(season.start), pts[0].t), t1 = Math.max(Date.now(), pts[pts.length - 1].t);
  const size = seasonFrame(170, 'Honor this season', t0, t1);
  const { W, H, pad } = size;
  const lo = Math.min(...pts.map((p) => p.honor)), hi = Math.max(...pts.map((p) => p.honor));
  const range = Math.max(200, hi - lo), base = lo - range * 0.1, top = hi + range * 0.1;
  const x = timeScale(size, t0, t1);
  const y = (v) => 8 + (1 - (v - base) / (top - base)) * (H - 16);
  // Rank floors inside the visible range.
  const floors = PVP.ranks.filter((r) => r.from > base && r.from < top)
    .map((r) => `<line x1="${pad}" x2="${W}" y1="${y(r.from).toFixed(1)}" y2="${y(r.from).toFixed(1)}"
      class="floor"/><text x="${W - 4}" y="${(y(r.from) - 3).toFixed(1)}" class="tick" text-anchor="end">${esc(r.name)}</text>`).join('');
  const dots = pts.filter((p) => p.e.wins || p.e.losses).map((p) => {
    const cls = p.e.wins && !p.e.losses ? 'win' : p.e.losses && !p.e.wins ? 'loss' : 'mixed';
    return `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.honor).toFixed(1)}" r="3.5"
      class="${cls}"><title>${esc(when(p.t))}: ${fmt(p.honor)} honor (${pvpResult(p.e)})</title></circle>`;
  }).join('');
  return chartFrame(size, `${floors}${yLabel(pad, (y(hi) + 4).toFixed(1), fmt(hi))}${yLabel(pad, (y(lo) + 4).toFixed(1), fmt(lo))}
    ${linePath(pts.map((p) => [x(p.t), y(p.honor)]), 'var(--gold-1)')}${dots}`);
}

function pvpResult(e) {
  const parts = [];
  if (e.wins) parts.push(e.wins === 1 ? 'win' : `${e.wins} wins`);
  if (e.losses) parts.push(e.losses === 1 ? 'loss' : `${e.losses} losses`);
  return parts.join(' + ') || 'no match';
}

const percent = (wins, losses) => (wins + losses ? `${Math.round((wins / (wins + losses)) * 100)}%` : '–');

function modifier(id, big) {
  const m = PVP.modifiers[id] || { name: id };
  const text = big && m.description ? `<div class="small">${esc(m.description)}</div>` : '';
  const title = esc(m.description || '');
  return `<div class="pvp-mod${big ? ' big' : ''}" title="${title}">${modifierIcon(m)}<div><b>${esc(m.name)}</b>${text}</div></div>`;
}

function rankCard({ mine, stale, mySeason }) {
  if (!mine) {
    return `<div class="pvp-card"><div class="card-label">Rank</div>
      <p class="muted">This account's save has no PvP rank yet. It shows up here after a PvP match.</p></div>`;
  }
  const rank = pvpRankOf(mine.honor), next = pvpNextRank(rank);
  const pct = next ? Math.min(100, Math.max(0, ((mine.honor - rank.from) / (next.from - rank.from)) * 100)) : 100;
  const progress = next
    ? `<div class="bar" title="${fmt(mine.honor - rank.from)} of ${fmt(next.from - rank.from)}"><span
      style="width:${pct.toFixed(1)}%"></span></div>
      <div class="small">${fmt(next.from - mine.honor)} to ${esc(next.name)}</div>`
    : '<div class="small">Top rank</div>';
  return `<div class="pvp-card pvp-rank">
    <div class="pvp-frame">${rank.frame ? `<img src="${pvpFrame(rank)}" alt="">` : ''}<b>${fmt(mine.honor)}</b></div>
    <div class="pvp-rank-text">
      <div class="card-label">Rank${stale ? ` · ${esc(mySeason.name)}` : ''}</div>
      <div class="pvp-big">${esc(rank.name)}</div>
      <div>${fmt(mine.honor)} honor</div>
      ${progress}
    </div>
  </div>`;
}

function recordCard({ log }) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const season = record(log), today = record(log, midnight.getTime());
  const run = streak(log);
  const unexplained = log.filter((e) => e.unexplained && !e.manual).length;
  const estimated = season.estimated
    ? ' <span class="flag warn" title="Some changes fit more than one combination of wins and losses. The tracker '
      + 'picked the likeliest one.">estimated</span>'
    : '';
  const rate = season.wins + season.losses ? ` <small class="muted">${percent(season.wins, season.losses)}</small>` : '';
  const inARow = run ? ` · ${run.kind === 'win' ? plural(run.n, 'win') : plural(run.n, 'loss', 'losses')} in a row` : '';
  return `<div class="pvp-card">
    <div class="card-label">Wins / losses${estimated}</div>
    <div class="pvp-big"><span class="pvp-win">${fmt(season.wins)}</span> – <span class="pvp-loss">${fmt(season.losses)}</span>${rate}</div>
    <div class="small">Today ${fmt(today.wins)} – ${fmt(today.losses)}${inARow}</div>
    <div class="small">Counted from the honor and Victory Point changes the tracker sees, so matches from before it first saw
      this account are not included.${season.honorOnly ? ' Victory Points stopped moving, so some results come '
        + 'from honor alone and losses at a rank floor may be missing.' : ''}</div>
    ${unexplained ? `<div class="small"><span class="flag warn">${unexplained}
      unexplained</span> ${unexplained > 1 ? 'changes are' : 'change is'} listed below. Mark
      ${unexplained > 1 ? 'them' : 'it'} as a win or a loss.</div>` : ''}
  </div>`;
}

function roadCard({ season, mine, stale }) {
  if (!season) return '';
  const vp = mine && !stale ? mine.vp : 0;
  const road = season.victoryRoad;
  const next = road.find((m) => m.vp > vp);
  const prevVp = [...road].reverse().find((m) => m.vp <= vp)?.vp ?? 0;
  const pct = next ? Math.min(100, ((vp - prevVp) / (next.vp - prevVp)) * 100) : 100;
  return `<div class="pvp-card">
    <div class="card-label">Victory Road</div>
    <div class="pvp-big">${fmt(vp)} <small class="muted">Victory Points</small></div>
    ${next ? `<div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div>
      <div class="small">${fmt(next.vp - vp)} to the next reward,
        ${pvpReward(next.reward)}</div>` : '<div class="small">Every reward reached.</div>'}
    <div class="small">${road.filter((m) => m.vp <= vp).length} of ${road.length} rewards reached. Victory Road resets
      when the season ends, so claim them in the game before then.</div>
  </div>`;
}

function seasonCard({ season, now }) {
  if (!season) return '';
  return `<div class="pvp-card">
    <div class="card-label">Season</div>
    <div class="pvp-big">${esc(season.name)}</div>
    <div class="time-highlight">Ends in ${span(Date.parse(season.end) - now)}</div>
    <div class="small">${esc(dayOnly(season.start))} – ${esc(when(season.end))}</div>
    <div class="small">Maps: ${esc(season.maps.join(', '))}</div>
  </div>`;
}

function modifiersPanel({ now }) {
  const cur = pvpSetAt(now);
  if (!cur) return '';
  const upcoming = [];
  for (let t = cur.end, i = 0; i < 4; i++) {
    const next = pvpSetAt(t + 1);
    if (!next) break;
    upcoming.push(next);
    t = next.end;
  }
  const rows = upcoming.map((set) => `<div class="pvp-next-row"><span
    class="muted small">${esc(dayOnly(set.start))}</span>${set.mods.map((id) => modifier(id, false)).join('')}</div>`);
  return `<section class="panel">
    <div class="section-head"><h2>Modifiers</h2><span class="muted small">They change every
      ${PVP.seasons[0]?.rotation?.periodDays || 3} days, next in ${span(cur.end - now)}</span></div>
    <div class="pvp-mods">${cur.mods.map((id) => modifier(id, true)).join('')}</div>
    ${rows.length ? `<div class="pvp-next">${rows.join('')}</div>` : ''}
  </section>`;
}

/** Every match this season, newest first; changes no win/loss combination explains can be marked by hand. */
function matchTable(log) {
  const recent = log.filter((e) => e.wins || e.losses || e.unexplained).reverse();
  if (!recent.length) return '<p class="muted small">No matches seen yet this season.</p>';
  const result = (e) => {
    if (e.unexplained && !e.manual) {
      return `<td><span class="flag warn" title="No combination of wins and losses gives this change">unexplained</span>
        <button class="chip" data-pvp-result="win" data-time="${esc(e.t)}">Win</button> <button class="chip"
          data-pvp-result="loss" data-time="${esc(e.t)}">Loss</button></td>`;
    }
    const cls = e.wins && !e.losses ? 'pvp-win' : e.losses && !e.wins ? 'pvp-loss' : '';
    const note = e.manual
      ? ` <span class="muted small">(set by you)</span> <button class="chip" data-pvp-result=""
        data-time="${esc(e.t)}" title="Mark as unexplained again">Undo</button>`
      : e.estimated ? ' <span class="muted small" title="More than one combination fits this change">(est.)</span>' : '';
    return `<td class="${cls}">${esc(pvpResult(e))}${note}</td>`;
  };
  const signed = (n) => `${n > 0 ? '+' : ''}${fmt(n)}`;
  const rows = recent.map((e) => `<tr><td>${esc(ago(e.t))}</td>${result(e)}<td>${signed(e.dh)} →
    ${fmt(e.honor)}</td><td>${signed(e.dv)} → ${fmt(e.vp)}</td></tr>`);
  return `<div class="pvp-matches"><table class="progress-table">
    <thead><tr><th>When</th><th>Result</th><th>Honor</th><th>Victory Points</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>`;
}

function historyPanel({ log, season }) {
  return `<section class="panel">
    <div class="section-head"><h2>Honor this season</h2></div>
    ${pvpHonorChart(log, season)}
    ${matchTable(log)}
  </section>`;
}

/** The record while each modifier was active; chosen modifiers narrow the chart to matches played with all of them. */
function winRatePanel({ log, season }) {
  const matches = matchesWithMods(PVP, log);
  const byMod = modifierStats(matches);
  const ids = Object.keys(byMod).sort((x, y) => (byMod[y].wins + byMod[y].losses) - (byMod[x].wins + byMod[x].losses));
  if (!ids.length) return '<section class="panel"><div class="section-head"><h2>Win rate</h2></div><p class="muted '
    + 'small">This fills in as the tracker sees your matches.</p></section>';
  const chosen = chosenMods.filter((id) => byMod[id]);
  const shown = withModifiers(matches, chosen);
  const wins = shown.reduce((n, m) => n + m.wins, 0), losses = shown.reduce((n, m) => n + m.losses, 0);
  const chip = (id) => {
    const m = PVP.modifiers[id] || { name: id }, st = byMod[id], on = chosen.includes(id);
    return `<button class="pvp-stat${on ? ' on' : ''}" data-pvp-modifier="${esc(id)}" aria-pressed="${on}"
      title="${esc(m.description || '')}">
      ${modifierIcon(m)}<span><b>${esc(m.name)}</b><br><span class="small">${st.wins}–${st.losses} ·
        ${percent(st.wins, st.losses)}</span></span></button>`;
  };
  const label = chosen.length ? `With ${chosen.map((id) => esc(PVP.modifiers[id]?.name || id)).join(' + ')}` : 'All matches';
  return `<section class="panel">
    <div class="section-head"><h2>Win rate</h2><span class="muted small">Pick modifiers to see only the matches played
      while all of them were active</span></div>
    <div class="pvp-stats">${ids.map(chip).join('')}</div>
    <div class="pvp-stat-sum">${label}: <b>${wins}–${losses}</b> · ${percent(wins, losses)}
      ${chosen.length ? ' <button class="chip" data-pvp-modifier-clear>Show all</button>' : ''}</div>
    ${pvpWinRateChart(winRateSeries(shown), season)}
  </section>`;
}

function endRewardsPanel({ season, mine, stale }) {
  if (!season) return '';
  const rank = mine && !stale ? pvpRankOf(mine.honor) : PVP.ranks[0];
  const rowFor = (r) => season.endRewards.find((e) => e.rank === r.id && !e.top);
  const lowest = PVP.ranks.find((r) => rowFor(r));
  const target = PVP.ranks.slice(PVP.ranks.indexOf(rank) + 1).find((r) => rowFor(r));
  const line = (label, row) => `<div class="pvp-end"><div class="pvp-end-label">${label}</div><div
    class="pvp-rewards">${row.rewards.map(pvpReward).join('')}</div></div>`;
  const current = rowFor(rank)
    ? line(`At your rank, <b>${esc(rank.name)}</b>`, rowFor(rank))
    : `<p class="small">There are no season-end rewards below ${esc(lowest?.name || 'Platinum Prodigy I')}
      (${fmt(lowest?.from ?? 9000)} honor).</p>`;
  const more = mine && !stale && target ? ` <span class="muted">(${fmt(target.from - mine.honor)} more honor)</span>` : '';
  return `<section class="panel">
    <div class="section-head"><h2>Season-end rewards</h2><span class="muted small">By your rank when ${esc(season.name)}
      ends on ${esc(dayOnly(season.end))}</span></div>
    ${current}
    ${target ? line(`At ${esc(target.name)}${more}`, rowFor(target)) : ''}
  </section>`;
}

function roadPanel({ season, mine, stale }) {
  if (!season) return '';
  const vp = PVP.victoryPoints;
  const steps = season.victoryRoad.map((m) => `<div class="pvp-step${mine && !stale && mine.vp >= m.vp
    ? ' got' : ''}"><span class="pvp-step-vp">${fmt(m.vp)}</span>${pvpReward(m.reward)}</div>`);
  return `<section class="panel">
    <div class="section-head"><h2>Victory Road</h2><span class="muted small">${esc(season.name)}. Every finished match
      adds Victory Points: ${fmt(vp.base * vp.loss)} for a loss, ${fmt(vp.base * vp.win)} for a win, more on a win streak.</span></div>
    <div class="pvp-road">${steps.join('')}</div>
  </section>`;
}

export async function renderPvp() {
  const page = $('#tab-pvp');
  try {
    await loadPvp();
    await loadEvents();
  } catch (err) {
    // Game data from before PvP was added has no pvp.json.
    page.innerHTML = `<div class="panel muted">${err.status === 404
      ? 'This game data has no PvP information yet. It comes with the next game-data update.' : esc(err.message)}</div>`;
    return;
  }
  if (ui.tab !== 'pvp') return;
  const now = Date.now();
  const season = pvpSeasonAt(now);
  const mine = state?.pvp || null;
  const mySeason = mine && PVP.seasons.find((x) => x.saveId === mine.season);
  // The save keeps the last season's honor and Victory Points until the account plays a match in the new one.
  const stale = !!(mine && season && mySeason && mySeason.id !== season.id);
  const v = { now, season, mine, mySeason, stale, log: state?.pvpLog || [] };
  const current = mine && season && !stale;
  page.innerHTML = `
    ${stale ? `<div class="panel small">This account's save still shows ${esc(mySeason.name)}. The game updates it
      after the next PvP match.</div>` : ''}
    <section class="pvp-cards">${rankCard(v)}${recordCard(v)}${roadCard(v)}${seasonCard(v)}</section>
    ${modifiersPanel(v)}${current ? historyPanel(v) + winRatePanel(v) : ''}${endRewardsPanel(v)}${roadPanel(v)}`;
}

/** The win rate over the season after each match, with 50% marked. */
function pvpWinRateChart(series, season) {
  if (series.length < 2) return '<p class="muted small">The chart needs at least two matches.</p>';
  const t0 = Math.min(Date.parse(season.start), series[0].t), t1 = Math.max(Date.now(), series[series.length - 1].t);
  const size = seasonFrame(150, 'Win rate this season', t0, t1);
  const { W, H, pad } = size;
  const x = timeScale(size, t0, t1);
  const y = (r) => 8 + (1 - r) * (H - 16);
  const last = series[series.length - 1];
  const percent = (r) => yLabel(pad, (y(r) + 4).toFixed(1), `${r * 100}%`);
  return chartFrame(size, `<line x1="${pad}" x2="${W}" y1="${y(0.5).toFixed(1)}" y2="${y(0.5).toFixed(1)}" class="floor"/>
    ${percent(1)}${percent(0.5)}${percent(0)}${linePath(series.map((p) => [x(p.t), y(p.rate)]), 'var(--gold-1)')}
    <circle cx="${x(last.t).toFixed(1)}" cy="${y(last.rate).toFixed(1)}" r="3.5"
      class="win"><title>${Math.round(last.rate * 100)}% after ${last.wins + last.losses} matches</title></circle>`);
}

export function bindPvp() {
  // Win or Loss for an unexplained change; Undo sends an empty result, which clears it.
  $('#tab-pvp').addEventListener('click', async (e) => {
    // the win rate's modifier filter
    const mod = e.target.closest('[data-pvp-modifier]');
    if (mod || e.target.closest('[data-pvp-modifier-clear]')) {
      const id = mod?.dataset.pvpModifier;
      const cur = new Set(chosenMods || []);
      if (!id) cur.clear(); else if (cur.has(id)) cur.delete(id); else cur.add(id);
      chosenMods = [...cur];
      store.set('pvpMods', chosenMods);
      renderPvp();
      return;
    }
    const b = e.target.closest('[data-pvp-result]');
    if (!b || !state?.account) return;
    b.disabled = true;
    try { await post('/api/pvp/result', { account: state.account, t: b.dataset.time, result: b.dataset.pvpResult || null }); }
    catch (err) { alertDialog(err.message, { title: 'Not saved' }); }
    poll();
  });
}
