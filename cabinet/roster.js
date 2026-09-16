/** Agent Fighter content the dashboard shows: fighters, items, pets.
 *  Names, styles and item lines are the real ones from the AF repo; the
 *  portraits are hotlinked from the hosted build. The player's OWN loadout
 *  (which fighters are unlocked, what is equipped) is account data that
 *  arrives with the Agent Fighter sync — until then INVENTORY_SAMPLE stands
 *  in and is labelled as a sample. */

export const AF_ASSETS = 'https://agent-fighter.vercel.app';
export const portraitUrl = (id) => `${AF_ASSETS}/characters/${id}/sprites/_select.png`;

export const STYLES = {
  rushdown: { label: 'Rushdown', color: '#ff5c6c' },
  zoner: { label: 'Zoner', color: '#33c6ff' },
  grappler: { label: 'Grappler', color: '#ffb84d' },
  turtle: { label: 'Turtle', color: '#5ee38a' },
  jumpy: { label: 'Jumpy', color: '#a78bfa' },
  'all-rounder': { label: 'All-rounder', color: '#b8c4d1' },
  boss: { label: 'Boss', color: '#ff2d95' },
};

export const CHARACTERS = [
  { id: 'analog', name: 'Lord Sedano', style: 'rushdown', hp: 10000 },
  { id: 'eliza', name: 'eliza OS', style: 'all-rounder', hp: 10000 },
  { id: '0xzero', name: 'Jeffrey', style: 'zoner', hp: 11000 },
  { id: 'bato', name: 'bato', style: 'turtle', hp: 10000 },
  { id: 'blaze', name: 'Mr.Beast', style: 'grappler', hp: 10000 },
  { id: 'claw', name: 'OpenClaw', style: 'grappler', hp: 10000 },
  { id: 'elon', name: 'elon', style: 'zoner', hp: 10000 },
  { id: 'gbush', name: 'gbush', style: 'turtle', hp: 10000 },
  { id: 'hermes', name: 'hermes', style: 'jumpy', hp: 10000 },
  { id: 'jensen', name: 'jensen', style: 'zoner', hp: 10000 },
  { id: 'kim', name: 'kim', style: 'all-rounder', hp: 10000 },
  { id: 'kimp', name: 'kim possible', style: 'jumpy', hp: 10000 },
  { id: 'minds', name: 'Daredevil', style: 'turtle', hp: 10000 },
  { id: 'nezuko', name: 'nezuko', style: 'jumpy', hp: 10000 },
  { id: 't800', name: 't800', style: 'grappler', hp: 10000 },
  { id: 'unitree-g1', name: 'unitree-g1', style: 'rushdown', hp: 10000 },
  { id: 'vector', name: 'Diddy', style: 'rushdown', hp: 10000 },
  { id: 'yatsiu', name: 'yatsiu', style: 'all-rounder', hp: 10000 },
  { id: 'boss1', name: 'Aracnus', style: 'boss', hp: 13000 },
];

/** Four consumable lines × three tiers (packages/core/src/items.ts). */
export const ITEM_LINES = {
  heal: { label: 'Patch', effect: 'restores health', color: '#5ee38a' },
  damageMult: { label: 'Overclock', effect: 'damage up', color: '#ff5c6c' },
  defenseMult: { label: 'Firewall', effect: 'damage taken down', color: '#33c6ff' },
  meterGain: { label: 'Volt', effect: 'meter gain up', color: '#ffb84d' },
};
export const ITEMS = [
  { id: 'patch1', name: 'PATCH COLA', line: 'heal', tier: 1 },
  { id: 'patch2', name: 'PATCH COLA ZERO', line: 'heal', tier: 2 },
  { id: 'patch3', name: 'PATCH OMEGA', line: 'heal', tier: 3 },
  { id: 'over1', name: 'OVERCLOCK LITE', line: 'damageMult', tier: 1 },
  { id: 'over2', name: 'OVERCLOCK', line: 'damageMult', tier: 2 },
  { id: 'over3', name: 'OVERCLOCK REDLINE', line: 'damageMult', tier: 3 },
  { id: 'wall1', name: 'FIREWALL FIZZ', line: 'defenseMult', tier: 1 },
  { id: 'wall2', name: 'FIREWALL PRO', line: 'defenseMult', tier: 2 },
  { id: 'wall3', name: 'FIREWALL TITANIUM', line: 'defenseMult', tier: 3 },
  { id: 'volt1', name: 'VOLT SODA', line: 'meterGain', tier: 1 },
  { id: 'volt2', name: 'VOLT SURGE', line: 'meterGain', tier: 2 },
  { id: 'volt3', name: 'VOLT MAXIMUM', line: 'meterGain', tier: 3 },
];

export const RARITY = {
  common: { label: 'Common', color: '#b8c4d1', pct: 70 },
  rare: { label: 'Rare', color: '#33c6ff', pct: 25 },
  epic: { label: 'Epic', color: '#a78bfa', pct: 5 },
};
export const PETS = [
  { id: 'bird', name: 'BIRD', glyph: '🐦' },
  { id: 'circuitmoth', name: 'CIRCUIT MOTH', glyph: '🦋' },
  { id: 'nullpup', name: 'NULL PUP', glyph: '🐶' },
  { id: 'sparkbit', name: 'SPARKBIT', glyph: '⚡' },
];

/** Stand-in loadout until the account sync. Everything here is labelled
 *  "sample" in the UI. */
export const INVENTORY_SAMPLE = {
  unlocked: ['analog', 'eliza', '0xzero', 'nezuko', 't800', 'hermes'],
  main: 'analog',
  items: [{ id: 'patch2', qty: 3 }, { id: 'over1', qty: 2 }, { id: 'wall1', qty: 1 }, { id: 'volt3', qty: 1 }],
  pets: [{ id: 'sparkbit', rarity: 'rare', aura: { atk: 12, def: 4, crit: 3 } }, { id: 'nullpup', rarity: 'common', aura: { atk: 3, def: 6, crit: 0 } }],
  equippedPet: 'sparkbit',
  tickets: 0,
};
