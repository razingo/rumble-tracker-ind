// Where the exe and npm run fetch-gamedata get data packs, and the Ed25519 public keys accepted for their signatures
// (manifest.sig over manifest.json). To rotate a key, ship a release listing both keys, then remove the old one.
export const PACK_URL = 'https://razingo.github.io/rumble-tracker-data/';

export const PACK_PUBLIC_KEYS = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAzO8XOdr+ZAG2Ue65721aZAWy/AKz+/v5+aZ4a9gD0Ho=
-----END PUBLIC KEY-----`,
];
