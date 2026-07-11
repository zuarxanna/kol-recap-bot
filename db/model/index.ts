// model/index.ts — barrel for all domain models + the shared base.
// Import models from the db root (`import { Kol, Campaign } from '../db/index.js'`),
// which re-exports this file.

export { Model } from './Model.js';
export type { ModelRow, ModelStatic } from './Model.js';
export { Kol } from './Kol/index.js';
export type { KolRow } from './Kol/index.js';
export { Campaign } from './Campaign/index.js';
export type { CampaignRow, CampaignStatus } from './Campaign/index.js';
