import { Model } from '../Model.js';
import type { ModelRow } from '../Model.js';

/**
 * The persisted shape of a campaign row.
 */
export interface CampaignRow extends ModelRow {
  /** Display name. */
  name: string;
  /** Campaign hashtag, including the leading `"#"` (e.g. `"#DemoOne"`). */
  hashtag: string;
  /** Whether this is the live campaign. Exactly one row is `true` at a time. */
  isActive: boolean;
  /** Scrape start boundary, `"YYYY-MM-DD"`. */
  started_at: string;
  /** End date, or `null` while active/open. */
  ended_at: string | null;
}

/**
 * A campaign master record, backed by `db/campaigns.json`.
 *
 * @remarks
 * Exactly one campaign is active at a time; {@link Campaign.activate} enforces that
 * invariant.
 */
export class Campaign extends Model implements CampaignRow {
  /** {@inheritDoc Model.table} */
  static override table = 'campaigns.json';

  name: string;
  hashtag: string;
  isActive: boolean;
  started_at: string;
  ended_at: string | null;

  /**
   * @param row - Partial campaign row; missing fields default (`isActive` → `false`,
   * `ended_at` → `null`, strings → `''`, plus the base `id`/`created_at` defaults).
   */
  constructor(row: Partial<CampaignRow> = {}) {
    super(row);
    this.name = row.name ?? '';
    this.hashtag = row.hashtag ?? '';
    this.isActive = row.isActive ?? false;
    this.started_at = row.started_at ?? '';
    this.ended_at = row.ended_at ?? null;
  }

  /**
   * Rebuild a {@link Campaign} instance from a plain row (CRUD read hook).
   * @param row - A raw row read from disk.
   * @returns The hydrated instance.
   */
  static hydrate(row: ModelRow): Campaign {
    return new Campaign(row as Partial<CampaignRow>);
  }

  /**
   * Serialize this campaign to a plain row (CRUD write hook).
   * @override
   * @returns The row to persist.
   */
  override toRow(): CampaignRow {
    return {
      id: this.id,
      created_at: this.created_at,
      name: this.name,
      hashtag: this.hashtag,
      isActive: this.isActive,
      started_at: this.started_at,
      ended_at: this.ended_at,
    };
  }

  /**
   * Get the single active campaign.
   * @returns The active campaign, or `null` if none is active.
   */
  static active(): Campaign | null {
    return Campaign.all().find((c) => c.isActive) ?? null;
  }

  /**
   * Make one campaign active and every other one inactive, preserving the single-active
   * invariant.
   * @param id - The campaign to activate.
   * @returns The activated campaign, or `null` if the id does not exist.
   */
  static activate(id: number): Campaign | null {
    const all = Campaign.all();
    if (!all.some((c) => c.id === id)) return null;
    for (const c of all) c.isActive = c.id === id;
    Campaign.saveAll(all);
    return all.find((c) => c.id === id) ?? null;
  }
}
