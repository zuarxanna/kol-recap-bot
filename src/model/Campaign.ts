// Campaign.ts — a campaign master record. Extends Model (JSON-file-backed CRUD).
// Exactly one campaign is "active" at a time (enforced by activate()).

import { Model } from './Model.js';
import type { ModelRow } from './Model.js';

export type CampaignStatus = 'active' | 'ended';

/** The persisted shape of a campaign row. */
export interface CampaignRow extends ModelRow {
  name: string;
  /** Campaign hashtag, including the leading "#" (e.g. "#DemoOne"). */
  hashtag: string;
  status: CampaignStatus;
  /** Scrape start boundary, "YYYY-MM-DD". */
  started_at: string;
  ended_at: string | null;
}

/** A campaign, backed by db/campaigns.json. */
export class Campaign extends Model implements CampaignRow {
  static override table = 'campaigns.json';

  name: string;
  hashtag: string;
  status: CampaignStatus;
  started_at: string;
  ended_at: string | null;

  constructor(row: Partial<CampaignRow> = {}) {
    super(row);
    this.name = row.name ?? '';
    this.hashtag = row.hashtag ?? '';
    this.status = row.status ?? 'ended';
    this.started_at = row.started_at ?? '';
    this.ended_at = row.ended_at ?? null;
  }

  /** Rebuild a Campaign instance from a plain row (CRUD read hook). */
  static hydrate(row: ModelRow): Campaign {
    return new Campaign(row as Partial<CampaignRow>);
  }

  /** Serialize this Campaign to a plain row (CRUD write hook). */
  override toRow(): CampaignRow {
    return {
      id: this.id,
      created_at: this.created_at,
      name: this.name,
      hashtag: this.hashtag,
      status: this.status,
      started_at: this.started_at,
      ended_at: this.ended_at,
    };
  }

  /** The single active campaign, or null (CRUD read override). */
  static active(): Campaign | null {
    return Campaign.all().find((c) => c.status === 'active') ?? null;
  }

  /**
   * Make campaign `id` active and every other one ended, preserving the single-active
   * invariant (CRUD update override). Returns the activated campaign, or null if the id
   * does not exist.
   */
  static activate(id: number): Campaign | null {
    const all = Campaign.all();
    if (!all.some((c) => c.id === id)) return null;
    for (const c of all) c.status = c.id === id ? 'active' : 'ended';
    Campaign.saveAll(all);
    return all.find((c) => c.id === id) ?? null;
  }
}
