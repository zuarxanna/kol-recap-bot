import type { Campaign, FetchResult, Kol } from '../types.js';

/**
 * The contract for a single platform (Instagram / TikTok / YouTube).
 *
 * @remarks
 * Open/Closed: adding a new platform = subclass this and register it in `recap.ts`; do
 * NOT touch `RecapService`. Hashtag filtering does NOT live here — it is central in
 * `RecapService` (identical for every platform, per the settled "auto hashtag filter"
 * decision).
 */
export abstract class PlatformAdapter {
  /** Platform name used for the CSV column and display (e.g. `"Instagram"`). */
  abstract get platform(): string;

  /**
   * Whether this KOL has a handle for this platform.
   * @param kol - The KOL to check.
   * @returns `true` if the platform should be attempted for this KOL.
   */
  abstract canHandle(kol: Kol): boolean;

  /**
   * The KOL's handle for this platform, used to label a failed row in the CSV.
   *
   * @remarks
   * Default `""` — override in subclasses. Used by `RecapService` when `fetchContent`
   * throws before a diagnostic exists.
   *
   * @param _kol - The KOL whose handle to resolve.
   * @returns The bare handle, or `""` if none.
   */
  getHandleFor(_kol: Kol): string {
    return '';
  }

  /**
   * Fetch a KOL's content for a campaign.
   * @param kol - The KOL to scrape.
   * @param campaign - The active campaign (provides the start boundary).
   * @returns A diagnostic plus normalized records, PRE hashtag-filter.
   */
  abstract fetchContent(kol: Kol, campaign: Campaign): Promise<FetchResult>;
}
