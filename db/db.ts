// db.ts — read/write local JSON master data (campaigns + kols).
// Used by recap.ts (read) and bot.ts (read + write via chat commands).
// Every load* reads fresh from disk, so direct edits to the JSON files are reflected
// without restarting the process.
//
// IMPORTANT: data files are resolved from the WORKING DIRECTORY (process.cwd()/db),
// NOT relative to this module. That keeps the path stable whether the code runs from
// source (tsx src/…) or compiled (node dist/src/…) — after compilation this file lives
// in dist/db/, but the real data (and the Docker volume) is always at <cwd>/db. Set
// DATA_DIR to override.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Campaign, Kol } from '../src/types.js';

const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), 'db');
const CAMPAIGNS = resolve(DATA_DIR, 'campaigns.json');
const KOLS = resolve(DATA_DIR, 'kols.json');

/**
 * Read and parse a JSON file.
 * @param path - Absolute file path.
 * @returns Parsed JSON content.
 */
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

/**
 * Serialize data to a JSON file (pretty-printed, trailing newline).
 * @param path - Absolute file path.
 * @param data - JSON-serializable value.
 */
const write = (path: string, data: unknown): void =>
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');

/** Load all campaigns. */
export const loadCampaigns = (): Campaign[] => read<Campaign[]>(CAMPAIGNS);

/** Persist the full campaigns list. */
export const saveCampaigns = (data: Campaign[]): void => write(CAMPAIGNS, data);

/** Load all KOLs. */
export const loadKols = (): Kol[] => read<Kol[]>(KOLS);

/** Persist the full KOL list. */
export const saveKols = (data: Kol[]): void => write(KOLS, data);

/** Get the single campaign whose status is "active", or null if none. */
export const activeCampaign = (): Campaign | null =>
  loadCampaigns().find((c) => c.status === 'active') ?? null;

/**
 * Compute the next integer id for a list: max(id) + 1, or 1 when empty.
 * @param rows - Existing records.
 */
export const nextId = (rows: Array<{ id: number }>): number =>
  rows.length ? Math.max(...rows.map((r) => Number(r.id) || 0)) + 1 : 1;
