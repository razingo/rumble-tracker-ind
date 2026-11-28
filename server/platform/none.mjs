// A system the tracker has no code for yet: it starts and shows what it has, and reads no save. platform/index.mjs
// says what each of these is to do.
export const name = 'none';
export const readSave = async () => {
  throw new Error(`The tracker can't read the game's saved data on this system (${process.platform}) yet.`);
};
const unknown = () => ({ running: () => null });
export const watchGame = unknown;
export const watchGameFromTray = unknown;
export const gameRunningOnce = async () => false;
export const showNotification = async () => false;
export const autostart = null;
export const openFolder = () => {};
