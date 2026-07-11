// model/index.ts — barrel for all models + the shared base.
// Import from here: `import { Kol, Campaign } from './model/index.js'`.

export { Model } from './Model.js';
export type { ModelRow, ModelStatic } from './Model.js';
export { Kol } from './Kol.js';
export type { KolRow } from './Kol.js';
export { Campaign } from './Campaign.js';
export type { CampaignRow, CampaignStatus } from './Campaign.js';
