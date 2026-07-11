// PlatformAdapter — the contract for a single platform (Instagram/TikTok/YouTube).
//
// OCP: adding a new platform = subclass this + register it in recap.ts. Do NOT touch
// RecapService. Hashtag filtering does NOT live here — it is central in RecapService
// (identical for every platform, per the settled "auto hashtag filter" decision).

import type { Campaign, FetchResult, Kol } from '../types.js';

/** Base class every platform adapter must extend. */
export abstract class PlatformAdapter {
  /** Platform name used for the CSV column and display (e.g. "Instagram"). */
  abstract get platform(): string;

  /** Whether this KOL has a handle for this platform. */
  abstract canHandle(kol: Kol): boolean;

  /**
   * The KOL's handle for this platform, used to label a failed row in the CSV.
   * Default "" — override in subclasses. Used by RecapService when fetchContent throws
   * before a diagnostic exists.
   */
  handleFor(_kol: Kol): string {
    return '';
  }

  /**
   * Fetch a KOL's content for a campaign.
   * @returns Diagnostic + normalized records (PRE hashtag-filter).
   */
  abstract fetchContent(kol: Kol, campaign: Campaign): Promise<FetchResult>;
}
