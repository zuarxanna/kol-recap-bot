import { Campaign, Kol } from '../../model/index.js';
import type { CsvWriter } from '../../csvwriter/index.js';
import type { PlatformAdapter } from '../../adapter/index.js';
import type {
  ContentRecord,
  DiagnosticWithMatched,
  FetchDiagnostic,
  KolResult,
  RecapResult,
  RunOptions,
} from '../../types.js';

/** Injected dependencies for a {@link RecapService}. */
interface RecapServiceDeps {
  /** The platform adapters to run (the concrete strategies). */
  adapters: PlatformAdapter[];
  /** The writer that emits the recap CSV. */
  csvWriter: CsvWriter;
}

/** Result of running one adapter for one KOL, after the central filter/placeholder. */
interface AdapterRunResult {
  /** The fetch diagnostic, augmented with the post-filter match count. */
  diagnostic: DiagnosticWithMatched;
  /** The records that survived the hashtag filter (or a single placeholder row). */
  records: ContentRecord[];
}

/**
 * Orchestrates a recap run across all registered platform adapters.
 *
 * @remarks
 * Dependency-inverted: it knows no concrete platform, only the {@link PlatformAdapter}
 * contract, so adding a platform means injecting an adapter — this class does NOT change
 * (OCP).
 *
 * Flow: active campaign → KOLs processed SEQUENTIALLY (so Apify concurrency is capped at
 * the number of adapters, not KOLs × adapters), but the adapters WITHIN one KOL run in
 * PARALLEL → CENTRAL hashtag filter → `onKolDone` per finished KOL → flatten + sort by
 * name → CSV → result.
 */
export class RecapService {
  private readonly adapters: PlatformAdapter[];
  private readonly csvWriter: CsvWriter;

  /**
   * @param deps - Injected adapters + CSV writer.
   * @throws If no adapters are given, or the writer is missing.
   */
  constructor({ adapters, csvWriter }: RecapServiceDeps) {
    if (!adapters?.length) throw new Error('RecapService requires at least 1 adapter');
    if (!csvWriter) throw new Error('RecapService requires a csvWriter');
    this.adapters = adapters;
    this.csvWriter = csvWriter;
  }

  /**
   * Run the recap for the active campaign.
   * @param options - Run options (e.g. the `onKolDone` progress callback).
   * @returns The full recap result (records, rows, diagnostics, cost, output path).
   * @throws If there is no active campaign, it has no hashtag, or no KOL matches any adapter.
   */
  async run({ onKolDone }: RunOptions = {}): Promise<RecapResult> {
    const campaign = Campaign.active();
    if (!campaign) throw new Error('No campaign with status=active in db/campaigns.json');

    const hashtag = String(campaign.hashtag || '').replace(/^#/, '').toLowerCase();
    if (!hashtag) throw new Error(`Active campaign "${campaign.name}" has no hashtag`);
    const since = String(campaign.started_at || '').slice(0, 10);

    const kols = Kol.all();
    const anyHandled = kols.some((k) => this.adapters.some((a) => a.canHandle(k)));
    if (!anyHandled) throw new Error('No KOL matches any adapter');

    // SEQUENTIAL per KOL (await one at a time). Inside #processKol, adapters run in
    // parallel. Each finished KOL fires onKolDone (in-order progress streaming).
    const perKol: KolResult[] = [];
    for (const kol of kols) {
      const res = await this.#processKol(kol, campaign, hashtag);
      if (onKolDone) {
        try {
          await onKolDone(res);
        } catch {
          /* progress failed, ignore */
        }
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
   * Process one KOL: every adapter that `canHandle` it runs in PARALLEL.
   * @param kol - The KOL to process.
   * @param campaign - The active campaign.
   * @param hashtag - The lowercased campaign hashtag (no `"#"`).
   * @returns The KOL's combined records + diagnostics.
   */
  async #processKol(kol: Kol, campaign: Campaign, hashtag: string): Promise<KolResult> {
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
   * Run one adapter for one KOL: fetch (wrapped so one adapter's error cannot kill the
   * run), then apply the CENTRAL hashtag filter, or emit a placeholder row on failure.
   * @param adapter - The adapter to run.
   * @param kol - The KOL to fetch.
   * @param campaign - The active campaign.
   * @param hashtag - The lowercased campaign hashtag (no `"#"`).
   * @returns The diagnostic (with match count) and the surviving records.
   */
  async #runAdapter(
    adapter: PlatformAdapter,
    kol: Kol,
    campaign: Campaign,
    hashtag: string,
  ): Promise<AdapterRunResult> {
    let diagnostic: FetchDiagnostic;
    let records: ContentRecord[];
    try {
      ({ diagnostic, records } = await adapter.fetchContent(kol, campaign));
    } catch (e) {
      diagnostic = {
        handle: adapter.handleFor(kol),
        name: kol.name,
        platform: adapter.platform,
        scraped: 0,
        errored: 0,
        allError: true,
        firstError: e instanceof Error ? e.message : String(e),
        cost: 0,
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
      (r.hashtags || []).some((h) => String(h).toLowerCase() === hashtag),
    );
    return { diagnostic: { ...diagnostic, matched: matched.length }, records: matched };
  }

  /**
   * Build a placeholder row for a KOL whose fetch failed.
   *
   * @remarks
   * Identity is filled; data fields use `"-"` (a VISIBLE "failed / fill manually"
   * marker, not blank/0). `date` stays `""` so CsvWriter blanks Release Date/Month/YEAR
   * (it cannot parse `"-"`). `hashtags` is `[]` so it would not pass the filter (it is
   * pushed directly).
   *
   * @param kol - The KOL that failed.
   * @param adapter - The adapter that failed.
   * @param diagnostic - The failure diagnostic (for the handle).
   * @returns A single placeholder record.
   */
  #placeholder(kol: Kol, adapter: PlatformAdapter, diagnostic: FetchDiagnostic): ContentRecord {
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
