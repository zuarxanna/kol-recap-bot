// model/index.ts — barrel for all domain models + the shared base.
// Import from here: `import { Kol, Campaign } from './model/index.js'`.

export { Model } from './Model.js';
export type { ModelRow, ModelStatic } from './Model.js';
export { Kol } from './kol/index.js';
export type { KolRow } from './kol/index.js';
export { Campaign } from './campaign/index.js';
export type { CampaignRow, CampaignStatus } from './campaign/index.js';
