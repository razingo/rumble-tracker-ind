import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currencyInfo } from '../server/game/currencies.mjs';

const DAY = 86400000;
const now = Date.UTC(2026, 4, 10, 12);
const events = {
  currencies: { A: 'a'.repeat(32), C: 'c'.repeat(32) },
  currencyNames: { ['1'.repeat(32)]: 'Arc Energy' },
  events: [
    { id: 'Arthas', saveId: 'e1', name: 'Arthas Reforged', currency: 'A',
      schedule: { kind: 'once', start: new Date(now - DAY).toISOString(), end: new Date(now + DAY).toISOString() } },
    { id: 'Login', saveId: 'e2', name: 'Login Calendar', currency: 'C',
      schedule: { kind: 'once', start: new Date(now + 5 * DAY).toISOString(), end: new Date(now + 9 * DAY).toISOString() } },
    { id: 'DMF05', saveId: 'e3', name: 'Darkmoon Faire', currency: 'C',
      schedule: { kind: 'once', start: new Date(now - 30 * DAY).toISOString(), end: new Date(now - 20 * DAY).toISOString() } },
  ],
};
const rules = { currencyIds: { valor: '2'.repeat(32) }, currencyDefaultNames: { valor: 'Valor' } };

test('names from the game data', () => {
  assert.deepEqual(currencyInfo('1'.repeat(32), { events, rules, now }), { name: 'Arc Energy' });
});

test('older game data uses the names in rules.json, or none', () => {
  assert.equal(currencyInfo('2'.repeat(32), { events, rules, now }).name, 'Valor');
  assert.equal(currencyInfo('3'.repeat(32), { events, rules, now }).name, null);
});

test('a ticket slot is named after the event running now (schedule)', () => {
  assert.deepEqual(currencyInfo('a'.repeat(32), { events, rules, now }),
    { name: 'Arthas Reforged tickets', slot: 'A', event: 'Arthas Reforged' });
});

test('the save\'s event list names a slot no scheduled event is using', () => {
  assert.equal(currencyInfo('c'.repeat(32), { events, rules, now, activeEvents: ['e3'] }).event, 'Darkmoon Faire');
});

test('an ended event still in the save loses to the scheduled one', () => {
  const ended = { id: 'DMF', saveId: 'e4', name: 'Darkmoon Faire', currency: 'A',
    schedule: { kind: 'once', start: new Date(now - 8 * DAY).toISOString(), end: new Date(now - DAY).toISOString() } };
  const e = { ...events, events: [...events.events, ended] };
  assert.equal(currencyInfo('a'.repeat(32), { events: e, rules, now, activeEvents: ['e4'] }).event, 'Arthas Reforged');
});

test('when two scheduled events share a slot, the later start wins', () => {
  const later = { id: 'Bling', saveId: 'e5', name: "Blingtron's Bounties", currency: 'A',
    schedule: { kind: 'once', start: new Date(now - DAY / 2).toISOString(), end: new Date(now + DAY).toISOString() } };
  const e = { ...events, events: [...events.events, later] };
  assert.equal(currencyInfo('a'.repeat(32), { events: e, rules, now }).event, "Blingtron's Bounties");
});

test('between events a slot has no event', () => {
  assert.deepEqual(currencyInfo('c'.repeat(32), { events, rules, now }), { name: 'Event tickets', slot: 'C', event: null });
});
