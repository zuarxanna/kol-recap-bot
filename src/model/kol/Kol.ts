import { Model } from '../Model.js';
import type { ModelRow } from '../Model.js';

/**
 * The persisted shape of a KOL row.
 */
export interface KolRow extends ModelRow {
  /** Display name. */
  name: string;
  /** Instagram handle, bare (no `"@"`). Empty string = not on Instagram. */
  ig_username: string;
  /** TikTok handle, bare (no `"@"`). Empty string = not on TikTok. */
  tiktok_username: string;
  /** YouTube handle, bare (no `"@"`). Empty string = not on YouTube. */
  youtube_channel: string;
}

/**
 * A KOL (influencer) master record, backed by `db/kols.json`.
 */
export class Kol extends Model implements KolRow {
  /** {@inheritDoc Model.table} */
  static override table = 'kols.json';

  name: string;
  ig_username: string;
  tiktok_username: string;
  youtube_channel: string;

  /**
   * @param row - Partial KOL row; missing fields default to empty strings (plus the
   * base `id`/`created_at` defaults).
   */
  constructor(row: Partial<KolRow> = {}) {
    super(row);
    this.name = row.name ?? '';
    this.ig_username = row.ig_username ?? '';
    this.tiktok_username = row.tiktok_username ?? '';
    this.youtube_channel = row.youtube_channel ?? '';
  }

  /**
   * Rebuild a {@link Kol} instance from a plain row (CRUD read hook).
   * @param row - A raw row read from disk.
   * @returns The hydrated instance.
   */
  static hydrate(row: ModelRow): Kol {
    return new Kol(row as Partial<KolRow>);
  }

  /**
   * Serialize this KOL to a plain row (CRUD write hook).
   * @override
   * @returns The row to persist.
   */
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

  /**
   * Find a KOL by Instagram username, case-insensitively.
   * @param username - The Instagram handle to match (bare, no `"@"`).
   * @returns The matching KOL, or `null` if none.
   */
  static findByIg(username: string): Kol | null {
    const normalizedUsername = String(username).toLowerCase();
    return Kol.getAll().find((kol) => kol.ig_username.toLowerCase() === normalizedUsername) ?? null;
  }
}
