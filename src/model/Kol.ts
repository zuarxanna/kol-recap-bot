// Kol.ts — a KOL (influencer) master record. Extends Model (JSON-file-backed CRUD).

import { Model } from './Model.js';
import type { ModelRow } from './Model.js';

/** The persisted shape of a KOL row. */
export interface KolRow extends ModelRow {
  name: string;
  /** Instagram handle, bare (no "@"). Empty string = not on Instagram. */
  ig_username: string;
  /** TikTok handle, bare (no "@"). Empty string = not on TikTok. */
  tiktok_username: string;
  /** YouTube handle, bare (no "@"). Empty string = not on YouTube. */
  youtube_channel: string;
}

/** A KOL, backed by db/kols.json. */
export class Kol extends Model implements KolRow {
  static override table = 'kols.json';

  name: string;
  ig_username: string;
  tiktok_username: string;
  youtube_channel: string;

  constructor(row: Partial<KolRow> = {}) {
    super(row);
    this.name = row.name ?? '';
    this.ig_username = row.ig_username ?? '';
    this.tiktok_username = row.tiktok_username ?? '';
    this.youtube_channel = row.youtube_channel ?? '';
  }

  /** Rebuild a Kol instance from a plain row (CRUD read hook). */
  static hydrate(row: ModelRow): Kol {
    return new Kol(row as Partial<KolRow>);
  }

  /** Serialize this Kol to a plain row (CRUD write hook). */
  override toRow(): KolRow {
    return {
      id: this.id,
      created_at: this.created_at,
      name: this.name,
      ig_username: this.ig_username,
      tiktok_username: this.tiktok_username,
      youtube_channel: this.youtube_channel,
    };
  }

  /** Find a KOL by Instagram username (case-insensitive), or null. */
  static findByIg(username: string): Kol | null {
    const u = String(username).toLowerCase();
    return Kol.all().find((k) => k.ig_username.toLowerCase() === u) ?? null;
  }
}
