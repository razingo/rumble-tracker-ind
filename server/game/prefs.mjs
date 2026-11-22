// Reads Warcraft Rumble's PlayerPrefs from the registry via reg.exe. Only the entries below are decoded;
// everything else in the key, including login tokens, is ignored and never stored.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { REG } from '../system.mjs';
import { SECOND } from '../../web/scripts/lib/constants.js';

const KEY = 'HKCU\\Software\\Blizzard Entertainment, Inc.\\Warcraft Rumble';
const WANTED = {
  units: /^MiniProgressionManagerState_v\d+_h\d+$/,
  currencies: /^VirtualCurrencyState_v\d+_h\d+$/,
  store: /^StoreState_v\d+_h\d+$/, // shop, running events, income bonuses
  profile: /^ProfileManagerState_v\d+_h\d+$/, // owned avatars
  commerce: /^CommerceState_v\d+_h\d+$/, // game build
  pvp: /^PvpPlayerRankState_v\d+_h\d+$/, // PvP season, honor, Victory Points
};
// "<account>_prod-actual_<entry>"=hex:0a,1b,... (REG_BINARY in a .reg file)
const REG_LINE = /^"([0-9a-f]{32})_prod-actual_([^"\\]+)"=hex:([0-9a-fA-F,]*)$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reads the key, retrying: reg.exe fails transiently when the game rewrites its save during the read.
 * @returns {Promise<Record<string, Record<string, Buffer>>>} per account prefix, the entries named in WANTED
 */
export async function readRumblePrefs(attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      return await queryOnce();
    } catch (e) {
      if (i >= attempts) throw e;
      await sleep(150 * i);
    }
  }
}

/**
 * One read via `reg export` into a named pipe. `reg query` takes ~6 s on this key (large CommerceState values);
 * export takes ~0.1 s. The pipe keeps the export, which includes login tokens, off the disk.
 */
function queryOnce() {
  return new Promise((resolve, reject) => {
    const pipe = `\\\\.\\pipe\\rumble-tracker-${process.pid}-${randomUUID()}`;
    // reg.exe opens the pipe twice (a check, then the export); the export is the connection with data
    const received = [];
    let connections = 0;
    let open = 0;
    let exited = null; // { err, stderr } once reg.exe has exited
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn(value);
    };
    const done = () => {
      if (settled || !exited || open > 0) return;
      const { err, stderr } = exited;
      if (err) {
        // Without the key, the game has never run on this PC.
        if (err.code === 1 && !connections) return finish(resolve, {});
        const detail = String(stderr || err.message).split(/\r?\n/).filter(Boolean).pop();
        return finish(reject, new Error(`Could not read the game's saved data (${detail}).`));
      }
      try {
        const data = received.reduce((a, b) => (b.length > a.length ? b : a), Buffer.alloc(0));
        finish(resolve, parse(data.toString('utf16le')));
      } catch (e) {
        // A value caught mid-write counts as a failed read.
        finish(reject, e);
      }
    };
    const server = net.createServer((socket) => {
      if (++connections > 4) return socket.destroy();
      open++;
      const chunks = [];
      socket.on('data', (c) => chunks.push(c));
      socket.on('close', () => {
        open--;
        received.push(Buffer.concat(chunks));
        done();
      });
      socket.on('error', () => {});
    });
    server.on('error', (e) => finish(reject, new Error(`Could not read the game's saved data (${e.message}).`)));
    const timer = setTimeout(() => finish(reject, new Error("Could not read the game's saved data (timed out).")), 30 * SECOND);
    server.listen(pipe, () => {
      execFile(REG, ['export', KEY, pipe, '/y'], { windowsHide: true, timeout: 25 * SECOND }, (err, stdout, stderr) => {
        exited = { err, stderr };
        done();
      });
    });
  });
}

/** Parses the REG_BINARY values of a .reg export. */
function parse(text) {
  const result = {};
  for (const line of text.replace(/\\\r?\n\s*/g, '').split(/\r?\n/)) {
    const m = REG_LINE.exec(line);
    if (!m) continue;
    const [, account, entry, hexList] = m;
    const hex = hexList.replace(/,/g, '');
    const kind = Object.keys(WANTED).find((k) => WANTED[k].test(entry));
    if (!kind) continue;
    // The value is null-terminated base64 of a protobuf message.
    const b64 = Buffer.from(hex, 'hex').toString('latin1').replace(/\0+$/, '');
    (result[account] ??= {})[kind] = Buffer.from(b64, 'base64');
  }
  return result;
}
