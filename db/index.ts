// index.ts — the db barrel. Import models from here:
//   import { Kol, Campaign } from '../db/index.js'
//
// Data is stored as flat JSON arrays, one per domain folder under db/model/ (e.g.
// db/model/Kol/kols.json). Each model owns its own file-backed CRUD (see
// db/model/Model.ts). Reads always hit disk fresh, so direct edits to the JSON files —
// or bot commands — take effect without a restart.

export * from './model/index.js';
