// db.js — read/write local JSON master data (campaigns + kols).
// Used by recap.js (read) and bot.js (read + write via chat commands).
// Every load* reads fresh from disk, so direct edits to the JSON files are
// reflected without restarting the process.

import { readFileSync, writeFileSync } from 'node:fs';

const CAMPAIGNS = new URL('./campaigns.json', import.meta.url);
const KOLS = new URL('./kols.json', import.meta.url);

/**
 * Read and parse a JSON file.
 * @param {URL} url - File URL to read.
 * @returns {*} Parsed JSON content.
 */
const read = (url) => JSON.parse(readFileSync(url));

/**
 * Serialize data to a JSON file (pretty-printed, trailing newline).
 * @param {URL} url - File URL to write.
 * @param {*} data - JSON-serializable value.
 * @returns {void}
 */
const write = (url, data) => writeFileSync(url, JSON.stringify(data, null, 2) + '\n');

/**
 * Load all campaigns.
 * @returns {Array<object>} Campaign records.
 */
export const loadCampaigns = () => read(CAMPAIGNS);

/**
 * Persist the full campaigns list.
 * @param {Array<object>} data - Campaign records to save.
 * @returns {void}
 */
export const saveCampaigns = (data) => write(CAMPAIGNS, data);

/**
 * Load all KOLs.
 * @returns {Array<object>} KOL records.
 */
export const loadKols = () => read(KOLS);

/**
 * Persist the full KOL list.
 * @param {Array<object>} data - KOL records to save.
 * @returns {void}
 */
export const saveKols = (data) => write(KOLS, data);

/**
 * Get the single campaign whose status is "active".
 * @returns {object|null} The active campaign, or null if none.
 */
export const activeCampaign = () => loadCampaigns().find((c) => c.status === 'active') || null;

/**
 * Compute the next integer id for a list: max(id) + 1, or 1 when empty.
 * @param {Array<{id:number}>} rows - Existing records.
 * @returns {number} Next id to assign.
 */
export const nextId = (rows) => (rows.length ? Math.max(...rows.map((r) => Number(r.id) || 0)) + 1 : 1);
