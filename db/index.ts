// index.ts — the db barrel. Import models from here: `import { Kol, Campaign } from '../db/index.js'`.
//
// Data is stored as flat JSON arrays (db/kols.json, db/campaigns.json). Each model owns
// its own file-backed CRUD (see db/model/Model.ts). Reads always hit disk fresh, so
// direct edits to the JSON files — or bot commands — take effect without a restart.

export { Model } from './model/Model.js';
export type { ModelRow, ModelStatic } from './model/Model.js';
export { Kol } from './model/Kol.js';
export type { KolRow } from './model/Kol.js';
export { Campaign } from './model/Campaign.js';
export type { CampaignRow, CampaignStatus } from './model/Campaign.js';
