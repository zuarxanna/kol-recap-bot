// model/index.ts — barrel for all domain models + the shared base.
// Import from here: `import { Kol, Campaign } from './model/index.js'`.

export { Model } from './Model.js';
export type { ModelRow, ModelStatic } from './Model.js';
export { Kol } from './Kol/index.js';
export type { KolRow } from './Kol/index.js';
export { Campaign } from './Campaign/index.js';
export type { CampaignRow, CampaignStatus } from './Campaign/index.js';
