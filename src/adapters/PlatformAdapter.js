// PlatformAdapter — the contract for a single platform (Instagram/TikTok/YouTube).
//
// OCP: adding a new platform = subclass this + register it in recap.js. Do NOT
// touch RecapService. Hashtag filtering does NOT live here — it is central in
// RecapService (identical for every platform, per the settled "auto hashtag filter"
// decision).

/**
 * @typedef {object} ContentRecord
 * A normalized piece of content, returned PRE hashtag-filter.
 * @property {string} name - KOL display name.
 * @property {string} platform - Platform label (e.g. "Instagram").
 * @property {string} type - Content type / CSV "Source Type" (e.g. "Reels", "Video", "Shorts").
 * @property {string} handle - Platform handle, without a leading "@".
 * @property {string} title - Short title (first line of caption/title, truncated).
 * @property {string} url - Canonical link to the content.
 * @property {number|string} views - View count, or "" if unavailable.
 * @property {number|string} likes - Like count, or "" if hidden/unavailable.
 * @property {number|string} comments - Comment count, or "" if disabled/unavailable.
 * @property {string} date - Publish date bucketed to WIB, as "YYYY-MM-DD" (or "" if unknown).
 * @property {string[]} hashtags - Lowercased hashtags without "#".
 */

/**
 * @typedef {object} FetchDiagnostic
 * Per-fetch diagnostic used for logs and to distinguish "filter working" from "scrape broken".
 * @property {string} handle - Handle that was fetched.
 * @property {string} name - KOL display name.
 * @property {string} platform - Platform label.
 * @property {number} scraped - Number of items returned by the source.
 * @property {number} errored - Number of items that came back as errors (deleted/private/missing).
 * @property {boolean} allError - True when every item failed (fetch effectively failed).
 * @property {string|null} firstError - First error message, if any.
 * @property {number} cost - Monetary cost in USD (0 for free APIs).
 */

/**
 * @typedef {object} FetchResult
 * @property {FetchDiagnostic} diagnostic - Diagnostic for this fetch.
 * @property {ContentRecord[]} records - Normalized records, PRE hashtag-filter.
 */

/**
 * Base class every platform adapter must extend.
 * @abstract
 */
export class PlatformAdapter {
  /**
   * Platform name used for the CSV column and display (e.g. "Instagram").
   * @returns {string}
   * @abstract
   */
  get platform() {
    throw new Error(`${this.constructor.name}: platform getter not implemented`);
  }

  /**
   * Whether this KOL has a handle for this platform.
   * @param {object} _kol - KOL record.
   * @returns {boolean}
   * @abstract
   */
  canHandle(_kol) {
    throw new Error(`${this.constructor.name}: canHandle() not implemented`);
  }

  /**
   * The KOL's handle for this platform, used to label a failed row in the CSV.
   * Default "" — override in subclasses. Used by RecapService when fetchContent
   * throws before a diagnostic exists.
   * @param {object} _kol - KOL record.
   * @returns {string}
   */
  handleFor(_kol) { return ''; }

  /**
   * Fetch a KOL's content for a campaign.
   * @param {object} _kol - KOL record.
   * @param {object} _campaign - Active campaign record.
   * @returns {Promise<FetchResult>} Diagnostic + normalized records (PRE-filter).
   * @abstract
   */
  async fetchContent(_kol, _campaign) {
    throw new Error(`${this.constructor.name}: fetchContent() not implemented`);
  }
}
