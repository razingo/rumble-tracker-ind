// Everything the tracker knows about the player that is the same wherever it runs: the collections read from the
// save, and the player's own files. What belongs to this install (settings, drafts, notifications, the window) is
// left out. Nothing uses this yet; it is the one place that says what a copy of the player's data is made of.
import { SCHEMA } from './migrations.mjs';

/**
 * { schema, device, rev, collections: { account: { changed, units, currencies } }, files: { backup key: contents } }.
 * `device` is this install's ID and `rev` the count of the player's changes here (changes.mjs). An account whose save
 * was not read yet has no collection.
 */
export function playerData(ctx) {
  const collections = {};
  for (const [id, acc] of ctx.accounts) {
    if (!acc.snapshot) continue;
    collections[id] = { changed: acc.lastChange || null, units: acc.snapshot.units, currencies: acc.snapshot.currencies };
  }
  return { schema: SCHEMA, device: ctx.user.device.id, rev: ctx.user.changes.rev, collections, files: ctx.user.playerFiles() };
}
