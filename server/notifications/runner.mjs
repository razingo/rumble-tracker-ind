// Sends due notifications every 30 seconds. notify.mjs decides what is due and toast.mjs shows it. Each notification
// is sent once. Quiet hours hold them until the quiet hours end; types the player doesn't want while playing are
// skipped while the game runs.
import { combined, dueNotifications, inQuietHours } from './notify.mjs';
import { showToast } from './toast.mjs';
import { accountLabel, unitSlug } from '../userdata.mjs';
import { DAY } from '../../web/scripts/lib/constants.js';

/** gameRunning(): Promise<boolean>. Returns { tick, test }. */
export function createNotifier(ctx, { gameRunning, toast = showToast }) {
  const u = () => ctx.user;

  async function save() {
    const log = u().sentLog;
    const cutoff = Date.now() - 30 * DAY; // keys expire after 30 days
    for (const [k, t] of Object.entries(log.sent)) if (Date.parse(t) < cutoff) delete log.sent[k];
    log.log = log.log.slice(-50);
    await u().save('sentLog');
  }

  async function tick() {
    const { notifySettings: settings, sentLog: log } = u();
    if (!settings.enabled) return;
    const now = Date.now();
    const nameOf = new Map(ctx.tables.minis.map((m) => [m.slug, m.name]));
    const list = [...ctx.accounts.entries()]
      .filter(([id, acc]) => acc.snapshot && (!settings.account || id === settings.account))
      .map(([id, acc]) => ({
        id, label: accountLabel(ctx, id), shop: acc.shop, currencies: acc.snapshot.currencies, pvp: acc.pvp || null,
        units: acc.snapshot.units.map((x) => ({ ...x, slug: unitSlug(ctx, x.id), name: nameOf.get(unitSlug(ctx, x.id)) })),
      }));
    const due = dueNotifications({
      now, accounts: list, events: ctx.tables.events, store: ctx.tables.store, rules: ctx.tables.rules,
      pvp: ctx.tables.pvp, plans: u().plans, settings,
      multi: list.length > 1, newVersion: ctx.appUpdate.newVersion,
    }).filter((n) => !log.sent[n.key]);
    // (an account of this PC, whichever ones the notifications are for)
    const read = [...ctx.accounts.values()].some((acc) => acc.snapshot);
    if (!(u().notifyBaseline && read) && !due.length && !(log.pending.length && !inQuietHours(settings.quiet))) return;
    const stamp = new Date(now).toISOString();
    for (const n of due) log.sent[n.key] = stamp;
    // On the first run with an account read, what is already due is recorded without a notification. That run is
    // over even when nothing was due.
    if (u().notifyBaseline) {
      if (read) u().notifyBaseline = false;
      await save();
      return;
    }
    const playing = due.length ? await gameRunning() : false;
    const deliver = due.filter((n) => !playing || settings.types[n.type]?.whenPlaying);
    if (inQuietHours(settings.quiet)) {
      log.pending = [...log.pending, ...deliver].slice(-20);
      await save();
      return;
    }
    const batch = [...log.pending, ...deliver];
    log.pending = [];
    // More than two of one kind are combined into one notification.
    const byType = new Map();
    for (const n of batch) (byType.get(n.type) || byType.set(n.type, []).get(n.type)).push(n);
    for (const [type, items] of byType) {
      const toSend = items.length > 2 ? [combined(type, items)] : items;
      for (const n of toSend) {
        const ok = await toast(n.title, n.body);
        log.log.push({ t: stamp, type: n.type, title: n.title, body: n.body, delivered: ok });
      }
    }
    await save();
  }

  /** "Send a test notification". */
  async function test() {
    const title = 'Test notification', body = 'Notifications from the tracker are working.';
    const ok = await toast(title, body);
    u().sentLog.log.push({ t: new Date().toISOString(), type: 'test', title, body, delivered: ok });
    await save();
    return ok;
  }

  return { tick, test };
}
