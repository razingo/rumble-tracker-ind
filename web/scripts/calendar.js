// Calendar tab: the event schedules from gamedata/events.json and the events the save reports as running.
import { $, imageUrl, getJson, post, RULES, BY_SLUG, TAG_ICONS, state, onTablesReload, ui } from './core.js';
import { STORE, loadStore } from './grid.js';
import { SECOND, MINUTE, DAY } from './lib/constants.js';
import { esc, fmt, plural, when, dayOnly, dayWithYear, longDay, timeOnly, span, ago, titleCase } from './lib/format.js';
import { rewardKey, rewardPlanner } from './lib/reward-tree.js';
import { occurrences, rotationAt, rotationName } from './lib/schedule.js';

let EVENTS = null; // { currencies: { A|B|C: saveId }, rotations: [...], events: [...] }
onTablesReload(() => { EVENTS = null; });
// How far the timeline is shifted (in days), the event whose reward tree is open, the rewards picked in it, and
// whether its challenge list is open.
const view = { offset: 0, tree: null, picks: [], challengesOpen: false };
// The event ticket slots A, B and C, with their currency IDs (events.json).
const ticketSlots = () => EVENTS?.currencies || {};
// The event's ticket icon in events/, named by events.json
const eventIcon = (ev) => `/static/events/${ev.icon || 'generic'}.webp`;
const TIMELINE_DAYS = 35; // centered on today
const TIMELINE_RANGE = 120; // slider range in days, each way
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;

export async function loadEvents() {
  if (EVENTS) return EVENTS;
  EVENTS = await getJson('/static/events.json', 'the event schedule');
  return EVENTS;
}

// Schedules

function runsBetween(from, to) {
  return EVENTS.events.flatMap((ev) => occurrences(ev, from, to).map((o) => ({ ev, ...o })));
}

/** "2nd Wednesday of every month · 7 days" */
function ruleText(s) {
  if (s.kind === 'once') return null;
  const when = s.kind === 'nthWeekday'
    ? `${ordinal(s.nth)} ${WEEKDAY_NAMES[s.weekday]} of ${s.every === 'month' ? 'every month' : MONTH_NAMES[s.month - 1]}`
    : `${s.every === 'month' ? 'Every month on the' : MONTH_NAMES[s.month - 1]} ${ordinal(s.day)}`;
  return `${when} · ${s.days} days`;
}

// Events and their tickets
const isLive = (ev) => (state?.activeEvents || []).includes(ev.saveId);
// Tickets reset between events, so a balance belongs to the event that uses its slot now.
function ticketBalance(ev) {
  const id = ev.currency && ticketSlots()[ev.currency];
  const c = id && state?.currencies?.find((x) => x.id === id);
  return c && c.event === (ev.name || ev.id) ? c.balance : null;
}

// Dungeon and raid rotations
const rotationColor = (rot, item) =>
  (rot.id === 'dungeonFamily' ? `var(--family-${String(item).toLowerCase()}, var(--event-default))` : rot.id === 'raid'
  ? (item.type === 'Siege' ? 'var(--event-siege)' : 'var(--event-raid)') : 'var(--event-dungeon)');
const rotationIcon = (rot, item) => (rot.id === 'dungeonFamily' && TAG_ICONS?.[item]
  ? `<img class="rotation-icon" src="/static/${TAG_ICONS[item]}" alt="">` : '');

/** The account's Ankh, which continues a failed dungeon, for the Dungeon card. */
function ankhLine() {
  const c = state?.currencies?.find((x) => x.id === RULES.ankhId);
  const icon = RULES.currencyIcons?.[RULES.ankhId];
  const img = icon ? `<img class="currency-icon" src="/static/${icon}" alt="">` : '';
  return `<div class="rotation-ankh" title="Used to continue failed dungeons">${img}${esc(c?.name || 'Ankh')}
    <b>${fmt(c?.balance ?? 0)}</b> <small class="muted">continues a failed dungeon</small></div>`;
}

function renderRotations(now) {
  const card = (rot) => {
    const cur = rotationAt(rot, now);
    const next = [1, 2, 3].map((k) => rotationAt(rot, cur.end + (k - 1) * rot.periodDays * DAY));
    return `<article class="rotation-card" style="--event-color:${rotationColor(rot, cur.item)}">
      <div class="card-label">${esc(rot.label)} <span class="muted">· every
        ${rot.periodDays === 7 ? 'week' : `${rot.periodDays / 7} weeks`}</span></div>
      <div class="rotation-now">${rotationIcon(rot, cur.item)}<b>${esc(rotationName(cur.item))}</b></div>
      <div class="time-highlight">Changes in ${span(cur.end - now)}</div>
      ${rot.id === 'dungeon' ? ankhLine() : ''}
      <div class="rotation-next">${next.map((x) => `<span title="${esc(when(x.start))}">${rotationIcon(rot, x.item)}${
        esc(rotationName(x.item))} <small>${esc(dayOnly(x.start))}</small></span>`).join('')}</div>
    </article>`;
  };
  return `<section class="panel">
    <div class="section-head"><h2>Dungeons, raids &amp;
    sieges</h2><span class="muted small">Rotations from the game files</span></div>
    <div class="cal-cards">${(EVENTS.rotations || []).map(card).join('')}</div>
  </section>`;
}

// Shop offers
// The tome an offer sells, from the save or from a generic offer's name.
function offerTome(o) {
  if (o.tome && STORE?.tomes?.[o.tome]) return STORE.tomes[o.tome];
  const m = /Tome(Modest|Major|Mega|Mythic)(?:_(\w+?))?_StoreOffer/.exec(STORE?.offers?.[o.offer]?.name || '');
  return m ? `${m[1]} ${m[2] && !/Generic/.test(m[2]) ? `${m[2]} ` : ''}Tome` : null;
}
// a tome's icon (static/rewards). A tome of no faction is the game's "Generic" one, but for the Modest size, whose
// picture the game calls "Star".
function tomeIcon(name) {
  const m = /^(Modest|Major|Mega|Mythic)(?: (\w+))? Tome$/.exec(name || '');
  return m ? `/static/rewards/Shared_Tex_Tome${m[1]}_${m[2] || (m[1] === 'Modest' ? 'Star' : 'Generic')}.webp` : null;
}
function offerTitle(o) {
  const info = STORE?.offers?.[o.offer];
  const minis = (o.slugs || []).map((s) => BY_SLUG.get(s)?.name).filter(Boolean);
  let t = info?.title || 'Offer';
  t = t.replace('{mini}', minis.join(' + ') || 'Mini').replace('{tome}', offerTome(o) || 'Tome');
  return titleCase(t);
}
// The save's timed store slots and limited offers, with titles and prices from static/store.json. Permanent packs
// have no timer and aren't listed.
function renderShopOffers(now) {
  const shop = state?.shop;
  if (!shop || !STORE) return '';
  const timed = [...shop.offers.filter((o) => o.expires && Date.parse(o.expires) > now - MINUTE),
    ...shop.limited.filter((o) => o.expires && Date.parse(o.expires) > now - MINUTE)]
    .sort((a, b) => Date.parse(a.expires) - Date.parse(b.expires));
  if (!timed.length) return '';
  const card = (o) => {
    const info = STORE.offers[o.offer] || {};
    const isFree = /^FreeGift/.test(info.name || '');
    const price = isFree ? 'Free' : info.cost ? `${fmt(info.cost.amount)}
      ${info.cost.coins ? '<span class="gold">●</span>' : esc(info.cost.currency || '')}` : info.realMoney ? 'Real money' : '';
    const minis = (o.slugs || []).map((s) => s && BY_SLUG.get(s)).filter(Boolean);
    // The offered minis' art, else the tome, else the offer banner.
    const tIcon = o.tome ? tomeIcon(offerTome(o)) : null;
    const art = minis.length ? minis.slice(0, 2).map((m) => `<img src="/static/${m.art}" alt="">`).join('')
      : tIcon ? `<img class="tome" src="${tIcon}" alt="">`
        : info.icon ? `<img class="tome" src="${imageUrl('store', info.icon)}" alt="">`
          : `<span>${isFree ? '🎁' : '◆'}</span>`;
    return `<article class="shop-card">
      <div class="shop-art">${art}</div>
      <div class="shop-body">
        <div class="cal-name">${esc(offerTitle(o))}</div>
        <div class="time-highlight">${isFree ? 'Next free gift in' : /Siege|Chain/i.test(info.name || '')
          ? 'Ends in' : 'Resets in'} ${esc(span(Date.parse(o.expires) - now))}</div>
        <div class="cal-dates">${esc(when(Date.parse(o.expires)))}${price ? ` · ${price}` : ''}</div>
      </div>
    </article>`;
  };
  // Daily offers first (the free gift leading), then special offers, then the rest.
  const nameOf = (o) => STORE.offers[o.offer]?.name || '';
  const groups = [
    ['Daily offers', timed.filter((o) => /^(FreeGift|Daily)_/.test(nameOf(o))).sort((a, b) =>
      /^FreeGift/.test(nameOf(b)) - /^FreeGift/.test(nameOf(a)))],
    ['Special offers', timed.filter((o) => /^Special_/.test(nameOf(o)))],
    ['Other offers', timed.filter((o) => !/^(FreeGift|Daily|Special)_/.test(nameOf(o)))],
  ].filter(([, list]) => list.length);
  return `<section class="panel">
    <div class="section-head"><h2>Shop offers</h2><span class="muted small">From your save · daily offers reset at 18:00 UTC</span></div>
    ${groups.map(([title, list]) => `<h3 class="shop-group">${title}</h3><div
      class="cal-cards shop-cards">${list.map(card).join('')}</div>`).join('')}
  </section>`;
}

// Event currencies
function renderTickets(now) {
  const soon = runsBetween(now - DAY, now + 60 * DAY).sort((a, b) => a.start - b.start);
  const chips = Object.entries(ticketSlots()).map(([k, id]) => {
    const c = state?.currencies?.find((x) => x.id === id);
    const runs = soon.filter((r) => r.ev.currency === k && r.end > now);
    const users = [...new Set(runs.map((r) => r.ev.name || r.ev.id))].slice(0, 3);
    // Icon of the current or next event using these tickets.
    const icon = RULES.currencyIcons?.[id] ? `/static/${RULES.currencyIcons[id]}` : runs[0] ? eventIcon(runs[0].ev) : null;
    // Between events the slot is idle; its old balance resets when the next event starts.
    const name = c?.name || 'Event tickets';
    const idle = !c?.event;
    const next = users.filter((u) => u !== c?.event);
    return `<div class="currency${idle ? ' idle' : ''}" title="${esc(name)}${idle ? ' · no event is using these tickets now' : ''}">
      ${icon ? `<img class="currency-icon" src="${icon}" alt="">` : ''}<span>${esc(name)}</span><b>${idle ? '–' : fmt(c?.balance ?? 0)}</b>
      ${next.length ? `<small class="muted">next: ${esc(next.join(', '))}</small>` : ''}</div>`;
  }).join('');
  return `<div class="currencies cal-tickets">${chips}</div>`;
}

// Reward tree
function rewardImg(r, ev) {
  const art = r.mini && BY_SLUG.get(r.mini)?.art;
  const src = art ? `/static/${art}` : r.icon ? imageUrl('rewards', r.icon) : eventIcon(ev);
  return `<img class="${art ? 'mini-art' : ''}" src="${esc(src)}" alt="" data-image-fallback="${esc(eventIcon(ev))}">`;
}
// An image that fails falls back once to data-image-fallback (the CSP blocks inline handlers).
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.imageFallback) return;
  const fallback = img.dataset.imageFallback;
  delete img.dataset.imageFallback;
  img.src = fallback;
}, true);
/** Extra coin percentage from owned income bonuses. */
function coinBonusPercent() {
  return (state?.incomeBonuses || []).reduce((s, id) => s + (EVENTS.incomeBonuses?.[id]?.coinsPercent || 0), 0);
}
/** The event's challenges, which pay its tickets, collapsed at first. */
function renderChallenges(ev) {
  const groups = ev.challenges || [];
  if (!groups.length) return '';
  const count = groups.reduce((s, g) => s + g.challenges.length, 0);
  const steps = (c) => (c.steps.length > 1
    ? `<span class="challenge-steps">${c.steps.map((x) => `<span title="${esc(x.title)}">${fmt(x.target)} →
      ${fmt(x.tickets)}</span>`).join('')}</span>`
    : c.steps[0] && c.steps[0].target > 1 ? `<span class="challenge-steps"><span>${fmt(c.steps[0].target)} →
      ${fmt(c.steps[0].tickets)}</span></span>` : '');
  const item = (c) => `<li><span class="challenge-title">${esc(c.title)}</span>${steps(c)}<b>${fmt(c.total)}</b></li>`;
  const head = (g) => {
    if (g.kind === 'daily') return `Daily challenges · ${g.active} a day from ${g.poolSize}, about ${fmt(g.perDay)} tickets a day`;
    if (g.kind === 'weekly') return g.challenges.length > 1 ? 'Weekly challenges' : 'Weekly challenge';
    return `Event challenges · ${g.challenges.length}`;
  };
  return `<details class="tree-challenges" ${view.challengesOpen ? 'open' : ''}>
    <summary>Challenges <span class="muted small">${count} · ${fmt(ev.challengeTickets || 0)} tickets in total</span></summary>
    ${groups.map((g) => `<h4>${head(g)}</h4><ul class="challenge-list${g.kind === 'daily'
      ? ' pool' : ''}">${g.challenges.map(item).join('')}</ul>`).join('')}
  </details>`;
}

/** Days left and remaining daily-challenge tickets for a running event. */
function dailiesLeft(ev, now) {
  const run = occurrences(ev, now, now + 1)[0];
  const daily = (ev.challenges || []).find((g) => g.kind === 'daily');
  if (!run || !daily) return null;
  const days = Math.max(0, Math.ceil((run.end - now) / DAY));
  return { days, tickets: days * daily.perDay, perDay: daily.perDay };
}

/**
 * How a reward is shown. As in the game, an owned cosmetic is replaced by its fallback. Avatars are checked against
 * the save. Skins aren't in the save, so their replacement is only mentioned.
 */
function rewardLook(ev) {
  const bonus = coinBonusPercent();
  const coins = (r) => (r.coins && bonus ? Math.round(r.amount * (1 + bonus / 100)) : r.amount);
  const owned = (r) => r.kind === 'avatar' && !!r.cosmetic && (state?.ownedAvatars || []).includes(r.cosmetic);
  const fallbackText = (fb) => `${fb.amount ? `${fmt(fb.coins ? coins(fb) : fb.amount)} ` : ''}${fb.label}`;
  return {
    bonus,
    coins,
    shown: (r) => (owned(r) && r.fallback
      ? { ...r, label: r.fallback.label, amount: r.fallback.amount, coins: r.fallback.coins, icon: r.fallback.icon,
        kind: 'currency', mini: null, swappedFrom: r.label }
      : r),
    swapNote: (r) => {
      if (!r.fallback) return '';
      if (owned(r)) return ` · you own ${r.label}, so you get ${fallbackText(r.fallback)} instead`;
      if (r.kind === 'skin') return ` · if you already own this skin, you get ${fallbackText(r.fallback)} instead`;
      return ` · you would get ${fallbackText(r.fallback)} instead if you owned it`;
    },
    amountText: (r) => {
      if (r.mini || r.kind === 'mini') return `x${r.amount || 1}`;
      if (r.amount) return `+${fmt(coins(r))}`;
      if (r.choices) return `Pick 1 of ${r.choices}`;
      return r.kind === 'tome' ? 'x1' : esc(r.label);
    },
  };
}

function treeTotals(ev, rewards) {
  const total = rewards.reduce((sum, r) => sum + (r.cost || 0), 0);
  const tickets = ev.challengeTickets;
  const enough = tickets != null && tickets >= total;
  return `<div class="tree-totals">
    <span><small>Collectable tickets</small><b>${tickets != null ? fmt(tickets) : '–'}</b></span>
    <span><small>Total rewards cost</small><b>${fmt(total)}</b></span>
    <span><small>Rewards</small><b>${rewards.length}</b></span>
    ${tickets != null ? `<span class="${enough ? 'text-good' : 'text-warn'}"><small>${enough
      ? 'Enough for everything' : 'Short of everything by'}</small><b>${enough ? '✓' : fmt(total - tickets)}</b></span>` : ''}
  </div>`;
}

/** The goal button: a notification once the ticket balance reaches the path's cost. */
function goalButton(ev, plan) {
  const goal = state?.plans?.[ev.id];
  if (goal && goal.cost === plan.cost) {
    return `<button class="chip small-chip tree-goal" data-tree-goal="clear"
      title="You'll get a notification when you have ${fmt(goal.cost)} tickets">🔔 Goal set · remove</button>`;
  }
  const label = plan.targets.length === 1 ? plan.targets[0].label : `${plan.targets.length} rewards`;
  return `<button class="chip small-chip tree-goal" data-tree-goal="set" data-tree-cost="${plan.cost}"
    data-tree-label="${esc(label)}" title="Get a notification when you have ${fmt(plan.cost)} tickets">🔔 Notify me when I
    have enough tickets</button>`;
}

/** The cheapest path to the picked rewards, with what it costs against the tickets the player has and can collect. */
function treePath(ev, plan, look) {
  const have = ticketBalance(ev);
  const dailies = dailiesLeft(ev, Date.now());
  const notes = [
    `${plural(plan.path.length, 'reward')} to claim`,
    have != null ? `you have ${fmt(have)} (${have >= plan.cost ? 'enough' : `${fmt(plan.cost - have)} short`})` : null,
    ev.challengeTickets != null
      ? `${plan.cost <= ev.challengeTickets ? 'fits within' : 'more than'} the ${fmt(ev.challengeTickets)} collectable` : null,
    dailies ? `daily challenges still pay about ${fmt(dailies.tickets)} (${plural(dailies.days, 'day')} left)` : null,
  ].filter(Boolean);
  const title = plan.targets.length === 1 ? `Cheapest path to ${esc(plan.targets[0].label)}`
    : `Cheapest way to get all ${plan.targets.length} picks`;
  const item = (r0) => {
    const r = look.shown(r0);
    const amount = r.mini ? ` x${r.amount || 1}` : r.amount ? ` +${fmt(look.coins(r))}` : '';
    const swapped = r.swappedFrom ? ` <small class="muted">(owned ${esc(r.swappedFrom)})</small>` : '';
    return `<li class="${plan.picked.has(rewardKey(r0)) ? 'pick'
      : ''}">${rewardImg(r, ev)}<span>${esc(r.label)}${amount}${swapped}</span><b>${fmt(r0.cost || 0)}</b></li>`;
  };
  return `<div class="tree-path">
    <div><b>${title}: ${fmt(plan.cost)} tickets</b>
      <span class="muted">· ${notes.join(' · ')}</span>
      <button class="chip small-chip" data-tree-pick="">Clear</button>
      ${goalButton(ev, plan)}</div>
    <ol>${plan.path.map(item).join('')}</ol>
  </div>`;
}

/** The tree: rewards at their row and column, with lines to the rewards they require. */
function treeGrid(ev, rewards, planner, plan, look) {
  const rows = Math.max(...rewards.map((r) => r.row)) + 1;
  const cols = Math.max(...rewards.map((r) => r.col)) + 1;
  const onPath = plan ? plan.claimed : new Set();
  const picked = plan ? plan.picked : new Set();
  const lines = rewards.flatMap((b) => planner.requirements(b).map((a) => {
    const cls = `${onPath.has(rewardKey(a)) && onPath.has(rewardKey(b)) ? 'on' : ''}${b.requireAll ? ' all' : ''}`;
    return `<line class="${cls}" x1="${a.col}" y1="${a.row + 0.5}" x2="${b.col}" y2="${b.row + 0.5}"/>`;
  })).join('');
  const node = (r0) => {
    const k = rewardKey(r0);
    const r = look.shown(r0);
    const solo = planner.cheapest([k]).cost;
    const title = `${r0.label}${look.swapNote(r0)}${r0.requireAll
      ? ' · needs all linked rewards above' : ''}${solo < Infinity ? ` · cheapest path ${fmt(solo)} tickets` : ''}`;
    const badge = r.swappedFrom ? '<span class="tree-tag owned" title="You own this, so you get its replacement">Owned</span>'
      : r0.fallback && r0.kind === 'skin' ? '<span class="tree-tag maybe" title="Owned skins are not in the save. '
        + 'If you have this one, you get its replacement.">?</span>' : '';
    const cls = `tree-node${r0.kind === 'avatar' || r0.kind === 'skin' ? ' cosmetic' : ''}${onPath.has(k)
      ? ' on-path' : ''}${picked.has(k) ? ' target' : ''}`;
    return `<div class="${cls}" data-tree-pick="${k}" role="button" tabindex="0" aria-pressed="${picked.has(k)}"
      style="left:${(r0.col / cols) * 100}%;top:${r0.row * 118}px" title="${esc(title)}">
      <div class="tree-icon">${rewardImg(r, ev)}${badge}</div>
      <div class="tree-amt">${look.amountText(r)}</div>
      ${r0.cost != null ? `<div class="tree-cost">${fmt(r0.cost)}<img src="${eventIcon(ev)}" alt=""></div>` : ''}
    </div>`;
  };
  return `<div class="tree-wrap${plan ? ' picking' : ''}" style="--cols:${cols};--rows:${rows}">
    <svg class="tree-lines" viewBox="0 0 ${cols} ${rows}" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>
    <div class="tree-grid">${rewards.map(node).join('')}</div>
  </div>`;
}

function renderRewardTree(ev) {
  const rewards = ev.rewards || [];
  if (!rewards.length) return '';
  const planner = rewardPlanner(rewards);
  const look = rewardLook(ev);
  const targets = view.picks.map((k) => planner.byKey.get(k)).filter(Boolean);
  const best = targets.length ? planner.cheapest(targets.map(rewardKey)) : null;
  const plan = best && best.cost < Infinity
    ? { cost: best.cost, targets, claimed: new Set(best.take), picked: new Set(targets.map(rewardKey)),
      path: planner.order.filter((r) => best.take.includes(rewardKey(r))) }
    : null;
  return `<section class="panel cal-tree" id="calendarTree" style="--event-color:var(--event-${esc(ev.family)}, var(--event-default))">
    <div class="section-head"><img class="tree-head-icon" src="${eventIcon(ev)}" alt=""><h2>${esc(ev.name || ev.id)} rewards</h2>
      <button class="chip" data-calendar-tree="">Close</button></div>
    ${treeTotals(ev, rewards)}
    <p class="muted small">Collectable means every challenge, random dailies and weeklies at their usual
      count${ev.family === 'darkmoon' ? ', plus tickets from guild mates' : ''}.
      ${look.bonus ? `Coins include your +${look.bonus}% Booster bonus.` : 'Coins are shown without the Booster (+50%).'}
      Click a reward to see the cheapest path to it. Ctrl+click adds more rewards.</p>
    ${renderChallenges(ev)}
    ${plan ? treePath(ev, plan, look) : ''}
    ${treeGrid(ev, rewards, planner, plan, look)}
  </section>`;
}

// Rendering
function eventCard(r, now) {
  const { ev } = r;
  const running = r.start <= now && now < r.end;
  const live = (running || r.unknown) && isLive(ev); // the save lists only current events
  const tickets = running ? ticketBalance(ev) : null;
  const status = r.unknown
    ? 'Running now'
    : running ? `Ends in ${span(r.end - now)}` : `Starts in ${span(r.start - now)}`;
  return `<article class="cal-card" style="--event-color:var(--event-${esc(ev.family)}, var(--event-default))">
    <img src="${eventIcon(ev)}" alt="">
    <div class="cal-name">${esc(ev.name || ev.id)}</div>
    <div class="time-highlight">${status}</div>
    <div class="cal-dates">${r.unknown ? 'Dates not in the game files' : `${when(r.start)} – ${when(r.end)}`}</div>
    ${live || tickets != null || ev.rewards ? `<div class="cal-badges">
      ${live ? '<span class="cal-badge" title="Your game lists this event as running">Running in your game</span>' : ''}
      ${tickets != null ? `<span class="cal-badge tickets" title="As last saved by the game">${fmt(tickets)} tickets</span>` : ''}
      ${ev.rewards ? `<button class="cal-badge tree-button" data-calendar-tree="${esc(ev.id)}"
        aria-pressed="${view.tree === ev.id}">Rewards</button>` : ''}
    </div>` : ''}
  </article>`;
}

/** The timeline's date range, e.g. "Nov 2 – Dec 6, 2026". */
function timelineRange(now) {
  const t = new Date(now);
  const a = new Date(t.getFullYear(), t.getMonth(), t.getDate() - Math.floor(TIMELINE_DAYS / 2) + (view.offset || 0));
  const b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + TIMELINE_DAYS - 1);
  return `${dayOnly(a)} – ${dayWithYear(b)}`;
}

/** The timeline: header, slider and bars. */
function renderCalendarTimeline(now) {
  const off = view.offset || 0;
  return `<section class="panel cal-timeline">
    <div class="section-head">
      <h2 id="calendarRange">${esc(timelineRange(now))}</h2>
      <button class="chip" data-calendar-today title="Back to today in the middle" ${off ? '' : 'disabled'}>Today</button>
      <span class="muted small">Wednesdays are highlighted because most events start and end on one.</span>
    </div>
    <div class="cal-slide-row">
      <span class="muted small">Earlier · later</span>
      <input type="range" class="cal-slider" data-calendar-slider min="${-TIMELINE_RANGE}" max="${TIMELINE_RANGE}"
        step="1" value="${off}" list="calendarTicks" aria-label="Move the timeline (days from today)">
      <datalist id="calendarTicks"><option value="0"></option></datalist>
    </div>
    <div class="cal-body">${renderTimelineBody(now)}</div>
  </section>`;
}

/** Full and short bar labels; CSS container queries show the one that fits. */
const barLabel = (full, short) => `<span class="bar-label bar-label-full">${full}</span><span
  class="bar-label bar-label-short">${short}</span>`;

/** The days the timeline shows: TIMELINE_DAYS centered on today, shifted by the slider. */
function timelineWindow(now) {
  const n = TIMELINE_DAYS;
  const today = new Date(now);
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate() - Math.floor(n / 2) + (view.offset || 0));
  const dates = Array.from({ length: n + 1 }, (_, i) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + i));
  const from = dates[0].getTime();
  const to = dates.pop().getTime();
  // A time's position across the timeline, in percent.
  const pct = (t) => ((Math.min(Math.max(t, from), to) - from) / (to - from)) * 100;
  return { n, today, dates, from, to, pct };
}

/** One row per event name, in alphabetical order so rows keep their place while the slider moves. */
function eventRows(runs) {
  const byName = new Map();
  for (const r of runs.sort((x, y) => x.start - y.start)) {
    const key = r.ev.name || r.ev.id;
    if (!byName.has(key)) byName.set(key, { ev: r.ev, runs: [] });
    byName.get(key).runs.push(r);
  }
  return [...byName].sort(([x], [y]) => x.localeCompare(y)).map(([, row]) => row);
}

function dayHeader(w) {
  return w.dates.map((d, i) => {
    const cls = [d.getDay() === 3 ? 'wednesday' : '', d.toDateString() === w.today.toDateString() ? 'today' : '',
      i > 0 && d.getDate() === 1 ? 'month-start' : ''].filter(Boolean).join(' ');
    return `<span class="${cls}" title="${longDay(d)}">${d.getDate()}</span>`;
  }).join('');
}

/** Month labels spanning their days; short names where a month has only a few days showing. */
function monthHeader(w) {
  const months = [];
  w.dates.forEach((d, i) => {
    const last = months[months.length - 1];
    if (last && last.m === d.getMonth()) last.span++;
    else months.push({ m: d.getMonth(), y: d.getFullYear(), start: i + 1, span: 1 });
  });
  return months.map((x) => `<span class="${x.start > 1 ? 'month-start' : ''}"
    style="grid-column:${x.start} / span ${x.span}" title="${MONTH_NAMES[x.m]} ${x.y}">${x.span >= 6
    ? `${MONTH_NAMES[x.m]} ${x.y}` : MONTH_NAMES[x.m].slice(0, 3)}</span>`).join('');
}

/** The classes a bar gets for being over, or cut off by either edge. */
const barEdges = (w, start, end, now) => [end <= now ? 'past' : '', start < w.from ? 'cut-l' : '', end > w.to ? 'cut-r' : ''];

function eventBar(w, r, now) {
  const left = w.pct(r.start), width = Math.max(w.pct(r.end) - left, 0.8);
  const cls = ['cal-bar', ...barEdges(w, r.start, r.end, now), r.start <= now && now < r.end && isLive(r.ev) ? 'live' : '']
    .filter(Boolean).join(' ');
  const label = barLabel(`${esc(dayOnly(r.start))} – ${esc(dayOnly(r.end))}`,
    `${new Date(r.start).getDate()} – ${new Date(r.end).getDate()}`);
  return `<span class="${cls}" style="left:${left}%;width:${width}%"
    title="${esc(r.ev.name || r.ev.id)}: ${esc(when(r.start))} – ${esc(when(r.end))}">${label}</span>`;
}

function rotationRow(w, rot, now, nowLine) {
  const segments = [];
  for (let seg = rotationAt(rot, w.from); seg.start < w.to; seg = rotationAt(rot, seg.end)) segments.push(seg);
  const bars = segments.map((seg) => {
    const left = w.pct(seg.start), width = w.pct(seg.end) - left;
    const icon = rotationIcon(rot, seg.item);
    const cls = ['cal-bar', 'rotation-bar', icon ? 'has-icon' : '', ...barEdges(w, seg.start, seg.end, now)].filter(Boolean).join(' ');
    return `<span class="${cls}" style="left:${left}%;width:${width}%;--event-color:${rotationColor(rot, seg.item)}"
      title="${esc(rotationName(seg.item))}: ${esc(when(seg.start))} – ${esc(when(seg.end))}">${icon}<span
      class="bar-label bar-label-name">${esc(rotationName(seg.item))}</span></span>`;
  }).join('');
  return `<div class="cal-row-label rotation-row"><span>${esc(rot.label)}</span></div><div class="cal-track">${bars}${nowLine}</div>`;
}

function renderTimelineBody(now) {
  const w = timelineWindow(now);
  const rows = eventRows(runsBetween(w.from, w.to));
  if (!rows.length) return '<p class="muted">No events in the game files for these days.</p>';
  const nowLine = now >= w.from && now < w.to ? `<span class="cal-now" style="left:${w.pct(now)}%"></span>` : '';
  return `<div class="cal-grid" style="--days:${w.n}">
      <span></span><div class="cal-months">${monthHeader(w)}</div>
      <span></span><div class="cal-days">${dayHeader(w)}</div>
      ${rows.map((row) => `
        <div class="cal-row-label"><img src="${eventIcon(row.ev)}" alt=""><span>${esc(row.ev.name || row.ev.id)}</span></div>
        <div class="cal-track" style="--event-color:var(--event-${esc(row.ev.family)}, var(--event-default))">
          ${row.runs.map((r) => eventBar(w, r, now)).join('')}${nowLine}</div>`).join('')}
      ${(EVENTS.rotations || []).map((rot) => rotationRow(w, rot, now, nowLine)).join('')}
    </div>`;
}

function renderCalendarRules() {
  // One line per event name (some events have one definition per month).
  const groups = new Map();
  for (const ev of EVENTS.events) {
    if (ev.schedule.kind === 'once') continue;
    const key = ev.name || ev.id;
    if (!groups.has(key)) groups.set(key, { ev, items: [] });
    groups.get(key).items.push(ev.schedule);
  }
  const line = ({ ev, items }) => {
    let text;
    if (items.length > 1 && items.every((s) => s.kind === 'dayOfMonth' && s.day === items[0].day && s.days === items[0].days)) {
      const months = items.map((s) => s.month).sort((a, b) => a - b).map((m) => MONTH_NAMES[m - 1].slice(0, 3));
      text = `${ordinal(items[0].day)} of the month · ${items[0].days} days <span
        class="muted">(${months.length === 12 ? 'every month' : months.join(', ')})</span>`;
    } else {
      text = items.map(ruleText).map(esc).join('<br>');
    }
    return `<li><img src="${eventIcon(ev)}" alt=""><b>${esc(ev.name || ev.id)}</b><span>${text}</span></li>`;
  };
  const hour = timeOnly(Date.UTC(2026, 0, 1, 18));
  return `<section class="panel cal-rules">
    <h2>How events repeat</h2>
    <p class="muted small">Events switch at 18:00 UTC (${esc(hour)} your time). A patch can change this;
      "Running in your game" always matches your game.</p>
    <ul>${[...groups.values()].sort((a, b) => (a.ev.name || '').localeCompare(b.ev.name || '')).map(line).join('')}</ul>
  </section>`;
}

export async function renderCalendar() {
  const page = $('#tab-calendar');
  if (!page) return;
  try {
    await loadEvents();
    await loadStore();
  } catch (err) {
    page.innerHTML = `<div class="panel muted">${esc(err.message)}</div>`;
    return;
  }
  if (ui.tab !== 'calendar') return;
  const now = Date.now();
  const soon = runsBetween(now - 60 * DAY, now + 60 * DAY);
  const running = soon.filter((r) => r.start <= now && now < r.end).sort((a, b) => a.end - b.end);
  // Running events not covered by the schedule rules.
  for (const id of state?.activeEvents || []) {
    if (running.some((r) => r.ev.saveId === id)) continue;
    const ev = EVENTS.events.find((e) => e.saveId === id);
    if (ev) running.push({ ev, start: now, end: now, unknown: true });
  }
  const upcoming = soon.filter((r) => r.start > now).sort((a, b) => a.start - b.start).slice(0, 8);

  const treeEv = view.tree && EVENTS.events.find((e) => e.id === view.tree);
  const scrollY = window.scrollY; // keep the scroll position on periodic re-renders
  page.innerHTML = `
    ${renderTickets(now)}
    <section class="panel">
      <div class="section-head"><h2>Running now</h2>
        ${state?.activeEventsAt ? `<span class="muted small">Your game last reported its events
          ${esc(ago(state.activeEventsAt))}</span>` : ''}</div>
      ${running.length ? `<div class="cal-cards">${running.map((r) => eventCard(r, now)).join('')}</div>`
        : '<p class="muted">No events running.</p>'}
    </section>
    ${treeEv ? renderRewardTree(treeEv) : ''}
    ${renderShopOffers(now)}
    ${renderRotations(now)}
    <section class="panel">
      <div class="section-head"><h2>Coming up</h2><span class="muted small">Next 60 days</span></div>
      ${upcoming.length ? `<div class="cal-cards">${upcoming.map((r) => eventCard(r, now)).join('')}</div>`
        : '<p class="muted">Nothing scheduled in the next 60 days.</p>'}
    </section>
    ${renderCalendarTimeline(now)}
    ${renderCalendarRules()}`;
  window.scrollTo(0, scrollY);
}

/** A click picks one reward and a second click clears it; Ctrl+click adds or removes it from the picks. */
function pickReward(el, multi) {
  const k = el.dataset.treePick;
  const picks = view.picks || [];
  if (!k) view.picks = [];
  else if (multi) view.picks = picks.includes(k) ? picks.filter((x) => x !== k) : [...picks, k];
  else view.picks = picks.length === 1 && picks[0] === k ? [] : [k];
  renderCalendar();
}

/** Sets or clears the reward goal of the open tree. */
async function setGoal(button) {
  const plan = button.dataset.treeGoal === 'set'
    ? { cost: Number(button.dataset.treeCost), label: button.dataset.treeLabel } : null;
  try {
    await post('/api/plans', { account: state.account, eventId: view.tree, plan });
  } catch (err) {
    button.textContent = `Not saved. ${err.message}`;
    return;
  }
  state.plans = { ...(state.plans || {}) };
  if (plan) state.plans[view.tree] = plan;
  else delete state.plans[view.tree];
  renderCalendar();
}

/** Opens an event's reward tree, or closes it when it is already open. */
async function toggleTree(id) {
  view.tree = id && view.tree !== id ? id : null;
  view.picks = [];
  await renderCalendar();
  if (view.tree) $('#calendarTree')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function calendarClick(e) {
  const goal = e.target.closest('[data-tree-goal]');
  if (goal) return setGoal(goal);
  const reward = e.target.closest('[data-tree-pick]');
  if (reward) return pickReward(reward, e.ctrlKey || e.metaKey);
  const tree = e.target.closest('[data-calendar-tree]');
  if (tree) return toggleTree(tree.dataset.calendarTree);
  // Today brings the timeline back
  if (e.target.closest('[data-calendar-today]')) {
    view.offset = 0;
    renderCalendar();
  }
}

/** Moving the slider redraws only the timeline, so the slider keeps its grip. */
function slideTimeline(e) {
  if (!e.target.matches('[data-calendar-slider]')) return;
  view.offset = Number(e.target.value);
  const now = Date.now();
  $('.cal-timeline .cal-body').innerHTML = renderTimelineBody(now);
  $('#calendarRange').textContent = timelineRange(now);
  $('.cal-timeline [data-calendar-today]').disabled = !view.offset;
}

export function bindCalendar() {
  const page = $('#tab-calendar');
  page.addEventListener('click', calendarClick);
  // rewards can be picked with the keyboard too
  page.addEventListener('keydown', (e) => {
    const el = e.target.closest?.('.tree-node[data-tree-pick]');
    if (!el || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    pickReward(el, e.ctrlKey || e.metaKey);
  });
  page.addEventListener('input', slideTimeline);
  // remember whether the challenge list is open across redraws
  page.addEventListener('toggle', (e) => {
    if (e.target.classList?.contains('tree-challenges')) view.challengesOpen = e.target.open;
  }, true);
  // refresh the countdowns, except while the slider is in use
  setInterval(() => {
    const sliding = document.activeElement?.matches('[data-calendar-slider]');
    if (ui.tab === 'calendar' && !document.hidden && !sliding) renderCalendar();
  }, 30 * SECOND);
}
