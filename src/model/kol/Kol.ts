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
 * The KOL fields that hold a per-platform handle. Used by the generic finder and the
 * bot's create/update commands so a KOL's handle on ANY platform is settable, not just
 * Instagram.
 */
export type KolHandleField = 'ig_username' | 'tiktok_username' | 'youtube_channel';

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
   * Normalize any handle input to the bare form we store (no `"@"`, no URL path).
   *
   * @remarks
   * Accepts a bare handle (`janerider`), an `"@"`-prefixed handle (`@janerider`), or a
   * pasted profile URL (`https://www.tiktok.com/@sibangcan`,
   * `https://instagram.com/janerider/reels`) and returns the bare handle. Storing bare
   * keeps every adapter consistent: Instagram/TikTok read the value with a plain
   * `.trim()`, YouTube re-normalizes on read (idempotent on an already-bare value).
   *
   * @param raw - The handle in any form.
   * @returns The bare handle, or `""` when the input is empty.
   */
  static sanitizeHandle(raw: string): string {
    let cleaned = String(raw ?? '').trim();
    const urlMatch = /^https?:\/\/[^/]+\/(.+)$/i.exec(cleaned);
    if (urlMatch?.[1]) cleaned = urlMatch[1]; // drop scheme + host, keep the path
    const atIndex = cleaned.lastIndexOf('@');
    if (atIndex >= 0) cleaned = cleaned.slice(atIndex + 1); // take everything after "@"
    return cleaned.split(/[/?#]/)[0] ?? ''; // cut at the first path/query/fragment separator
  }

  /**
   * Find a KOL by the handle on a given platform, case-insensitively.
   *
   * @remarks
   * Both sides are run through {@link Kol.sanitizeHandle}, so a stored bare handle
   * matches an input pasted as `@handle` or a URL. An empty (post-sanitize) value never
   * matches — a KOL with no handle on that platform is not a duplicate of another such
   * KOL.
   *
   * @param field - Which handle column to match (`ig_username` / `tiktok_username` /
   * `youtube_channel`).
   * @param value - The handle to match (any form).
   * @returns The matching KOL, or `null` if none.
   */
  static findByHandle(field: KolHandleField, value: string): Kol | null {
    const normalizedValue = Kol.sanitizeHandle(value).toLowerCase();
    if (!normalizedValue) return null;
    return (
      Kol.getAll().find((kol) => Kol.sanitizeHandle(kol[field]).toLowerCase() === normalizedValue) ??
      null
    );
  }
}
