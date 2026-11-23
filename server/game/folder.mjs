// Where Warcraft Rumble is installed, for the tracker that reads its game data from the game install. The tools find
// the game through Windows' install entry (tools/gamedata/build.mjs, findGame). Where there is none, or it is wrong
// (a copied folder, a second install), the player gives the folder by hand: on the loading page when the game is not
// found, or in Settings. It is kept in the data folder's config.json as gameFolder.
import path from 'node:path';
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';

const configFile = (ctx) => path.join(ctx.paths.DATA, 'config.json');
const readConfig = (ctx) => readFile(configFile(ctx), 'utf8').then((t) => JSON.parse(t.replace(/^﻿/, '')), () => ({}));

/** What a typed or pasted folder becomes: no quotes around it, no slash at its end. */
const clean = (dir) => String(dir || '').trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');

/** Whether `dir` is the game's folder: it holds the game's files. */
export const isGameFolder = (dir) => stat(path.join(dir, 'Data', 'StreamingAssets', 'Bundles')).then((s) => s.isDirectory(), () => false);

/** The folder given by hand, or '' when there is none. */
export async function givenGameFolder(ctx) {
  const dir = (await readConfig(ctx)).gameFolder;
  return typeof dir === 'string' ? dir : '';
}

/**
 * Keeps the folder given by hand; an empty one forgets it, so the game is looked for again. Resolves with the folder
 * kept. Rejects with a message for the player when it is not the game's folder.
 */
export async function setGameFolder(ctx, given) {
  const dir = clean(given);
  if (dir && !path.isAbsolute(dir)) throw new Error('Give the whole path of the folder, starting with its drive.');
  if (dir && !(await isGameFolder(dir))) {
    throw new Error(`${dir} is not the game's folder: it should be the one that holds WarcraftRumble.exe and Data.`);
  }
  const config = await readConfig(ctx);
  if (dir) config.gameFolder = dir;
  else delete config.gameFolder;
  await mkdir(ctx.paths.DATA, { recursive: true });
  await writeFile(configFile(ctx), JSON.stringify(config, null, 1) + '\n');
  return dir;
}
