// RecapService — the orchestrator. It knows no concrete platform (DIP): it only
// knows the PlatformAdapter contract. Adding TikTok/YouTube = inject a new adapter;
// this file does NOT change (OCP).
//
// Flow: active campaign -> KOLs processed SEQUENTIALLY (one at a time, so Apify
// concurrency is capped at the number of adapters, not KOLs x adapters) -> but the
// adapters WITHIN one KOL run in PARALLEL ("concurrent per handle") -> CENTRAL hashtag
// filter -> onKolDone callback per finished KOL (progress) -> flatten + sort by name
// -> CsvWriter -> result.

import { activeCampaign, loadKols } from '../db/db.js';

/**
 * @typedef {import('./adapters/PlatformAdapter.js').ContentRecord} ContentRecord
 * @typedef {import('./adapters/PlatformAdapter.js').FetchDiagnostic} FetchDiagnostic
 */

/**
 * Orchestrates a recap run across all registered platform adapters.
 */
export class RecapService {
  /**
   * @param {object} deps
   * @param {import('./adapters/PlatformAdapter.js').PlatformAdapter[]} deps.adapters - Injected adapters.
   * @param {import('./CsvWriter.js').CsvWriter} deps.csvWriter - Injected CSV writer.
   */
  constructor({ adapters, csvWriter }) {
    if (!adapters?.length) throw new Error('RecapService requires at least 1 adapter');
    if (!csvWriter) throw new Error('RecapService requires a csvWriter');
    this.adapters = adapters;
    this.csvWriter = csvWriter;
  }

  /**
   * Run the recap for the active campaign.
   * @param {object} [options]
   * @param {(result: {kol: object, records: ContentRecord[], diagnostics: FetchDiagnostic[]}) => (void|Promise<void>)} [options.onKolDone]
   *   Called after each KOL finishes (all its platforms). Used by the bot for progress
   *   streaming. It is awaited, and errors thrown in it are swallowed (a progress
   *   failure must not fail the run).
   * @returns {Promise<{campaign: object, hashtag: string, since: string, records: ContentRecord[], rows: Array, diagnostics: FetchDiagnostic[], totalCost: number, outPath: string}>}
   */
  async run({ onKolDone } = {}) {
    const campaign = activeCampaign();
    if (!campaign) throw new Error('No campaign with status=active in db/campaigns.json');

    const hashtag = String(campaign.hashtag || '').replace(/^#/, '').toLowerCase();
    if (!hashtag) throw new Error(`Active campaign "${campaign.name}" has no hashtag`);
    const since = String(campaign.started_at || '').slice(0, 10);

    const kols = loadKols();
    const anyHandled = kols.some((k) => this.adapters.some((a) => a.canHandle(k)));
    if (!anyHandled) throw new Error('No KOL matches any adapter');

    // SEQUENTIAL per KOL (await one at a time). Inside #processKol, adapters run in
    // parallel. Each finished KOL fires onKolDone (in-order progress streaming).
    const perKol = [];
    for (const kol of kols) {
      const res = await this.#processKol(kol, campaign, hashtag);
      if (onKolDone) {
        try { await onKolDone(res); } catch { /* progress failed, ignore */ }
      }
      perKol.push(res);
    }

    const matchedRecords = perKol.flatMap((r) => r.records);
    const diagnostics = perKol.flatMap((r) => r.diagnostics);
    const totalCost = diagnostics.reduce((s, d) => s + (d.cost || 0), 0);

    // Sort by KOL name (used by both CSV and chat cards). localeCompare 'id', stable within a name.
    matchedRecords.sort((a, b) => String(a.name).localeCompare(String(b.name), 'id'));

    const { outPath, rows } = this.csvWriter.write(matchedRecords, campaign);
    return { campaign, hashtag, since, records: matchedRecords, rows, diagnostics, totalCost, outPath };
  }

  /**
   * Process one KOL: every adapter that canHandle it runs in PARALLEL.
   * @param {object} kol - KOL record.
   * @param {object} campaign - Active campaign.
   * @param {string} hashtag - Lowercased campaign hashtag (no "#").
   * @returns {Promise<{kol: object, records: ContentRecord[], diagnostics: FetchDiagnostic[]}>}
   */
  async #processKol(kol, campaign, hashtag) {
    const adapters = this.adapters.filter((a) => a.canHandle(kol)); // no handle -> skip (no row)
    const perAdapter = await Promise.all(
      adapters.map((a) => this.#runAdapter(a, kol, campaign, hashtag)),
    );
    return {
      kol,
      records: perAdapter.flatMap((x) => x.records),
      diagnostics: perAdapter.map((x) => x.diagnostic),
    };
  }

  /**
   * Run one adapter for one KOL: fetch (wrapped in try/catch so one adapter's error
   * does not kill the run), then apply the CENTRAL hashtag filter / placeholder.
   * @param {import('./adapters/PlatformAdapter.js').PlatformAdapter} adapter
   * @param {object} kol - KOL record.
   * @param {object} campaign - Active campaign.
   * @param {string} hashtag - Lowercased campaign hashtag (no "#").
   * @returns {Promise<{diagnostic: FetchDiagnostic & {matched: number}, records: ContentRecord[]}>}
   */
  async #runAdapter(adapter, kol, campaign, hashtag) {
    let diagnostic;
    let records;
    try {
      ({ diagnostic, records } = await adapter.fetchContent(kol, campaign));
    } catch (e) {
      diagnostic = {
        handle: adapter.handleFor(kol), name: kol.name, platform: adapter.platform,
        scraped: 0, errored: 0, allError: true, firstError: e.message, cost: 0,
      };
      records = [];
    }

    // Fetch FAILED (allError) but the KOL has a handle -> still write 1 EMPTY-STATE row
    // (audited manually). Different from a filter-miss (scraped>0, matched 0), which is
    // deliberately not written.
    if (diagnostic.allError) {
      return {
        diagnostic: { ...diagnostic, matched: 0 },
        records: [this.#placeholder(kol, adapter, diagnostic)],
      };
    }

    // CENTRAL hashtag filter — case-insensitive HERE (adapters need not pre-lowercase).
    // Leaky by design (misses untagged content) — audited manually. Do NOT loosen it
    // without a deliberate decision.
    const matched = records.filter((r) =>
      (r.hashtags || []).some((h) => String(h).toLowerCase() === hashtag));
    return { diagnostic: { ...diagnostic, matched: matched.length }, records: matched };
  }

  /**
   * Build a placeholder row for a KOL whose fetch failed: identity filled, data fields
   * use "-" (a VISIBLE "failed / fill manually" marker, not blank/0). date stays "" so
   * CsvWriter blanks Release Date/Month/YEAR (it cannot parse "-"). hashtags [] so it
   * would not pass the filter (it is pushed directly). JML stays 1 (hardcoded in
   * CsvWriter, a deliberate decision).
   * @param {object} kol - KOL record.
   * @param {import('./adapters/PlatformAdapter.js').PlatformAdapter} adapter
   * @param {FetchDiagnostic} diagnostic
   * @returns {ContentRecord}
   */
  #placeholder(kol, adapter, diagnostic) {
    return {
      name: kol.name,
      platform: adapter.platform,
      type: '-',
      handle: diagnostic.handle || adapter.handleFor(kol),
      title: '-',
      url: '-',
      views: '-',
      likes: '-',
      comments: '-',
      date: '',
      hashtags: [],
    };
  }
}
