// IDs for what the tracker makes itself (saved armies, history entries, this install). They are random, so two
// trackers never make the same one, which lets their data be put together later.
export const newId = () => globalThis.crypto.randomUUID();
