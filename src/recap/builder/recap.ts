import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { InstagramAdapter, TikTokAdapter, YouTubeAdapter } from '../../adapter/index.js';
import { CsvWriter } from '../../csvwriter/index.js';
import { RecapService } from '../service/index.js';
import type { PlatformAdapter } from '../../adapter/index.js';
import type { RecapResult, RunOptions } from '../../types.js';

/**
 * Composition root: assemble the active adapters + writer into a {@link RecapService}.
 *
 * @remarks
 * This is where concrete adapters are chosen and injected — to add a platform, push a
 * new adapter here; `RecapService`/`CsvWriter` do NOT change (OCP). YouTube is optional:
 * it is enabled only when `YOUTUBE_API_KEY` is set, otherwise skipped (IG + TikTok still
 * run).
 *
 * @returns A ready-to-run service.
 * @throws If `APIFY_TOKEN` is missing from the environment.
 */
function buildService(): RecapService {
  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) throw new Error('APIFY_TOKEN is missing from .env');

  const adapters: PlatformAdapter[] = [
    new InstagramAdapter(apifyToken),
    new TikTokAdapter(apifyToken),
  ];
  if (process.env.YOUTUBE_API_KEY) {
    adapters.push(new YouTubeAdapter(process.env.YOUTUBE_API_KEY));
  }
  // out/ is resolved from the working directory (matches the Docker volume ./out:/app/out).
  const outDir = process.env.OUT_DIR ?? resolve(process.cwd(), 'out');
  return new RecapService({ adapters, csvWriter: new CsvWriter(outDir) });
}

/**
 * Facade used by `bot.ts`. Builds the service and runs one recap.
 *
 * @remarks
 * An empty CSV is NOT automatically a bug: the hashtag filter is deliberately strict, so
 * content a KOL did not tag is missed on purpose (audited manually). The diagnostics
 * tell "0 matched of N" (filter working) apart from "all errored" (scrape broken).
 *
 * @param options - Passed through to {@link RecapService.run} (e.g. `{ onKolDone }`).
 * @returns The full recap result.
 */
export async function runRecap(options?: RunOptions): Promise<RecapResult> {
  return buildService().run(options);
}

// --- CLI: run directly (tsx src/recap/builder/recap.ts, or node dist/src/recap/builder/recap.js) ---
const runDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (runDirect) {
  try {
    const recapResult = await runRecap();
    console.log(`\n=== recap: "${recapResult.campaign.name}" #${recapResult.hashtag} since ${recapResult.since} ===`);
    for (const diagnostic of recapResult.diagnostics) {
      const note = diagnostic.allError ? ` ⚠ ALL errored (e.g. ${diagnostic.firstError})` : '';
      console.log(
        `@${diagnostic.handle} [${diagnostic.platform}]: scraped ${diagnostic.scraped}, errored ${diagnostic.errored}, matched #${recapResult.hashtag} → ${diagnostic.matched} rows${note}`,
      );
    }
    console.log(`\n--- RESULT ---`);
    console.log(`${recapResult.records.length} rows written → ${recapResult.outPath}`);
    console.log(`total cost = $${recapResult.totalCost.toFixed(4)} for ${recapResult.diagnostics.length} fetches`);
    if (recapResult.records.length === 0) {
      console.log(
        `\nEmpty CSV. "scraped N>0" but 0 matched = the filter tradeoff (audit manually). scraped 0 / all errored = a scrape problem (handle/private/token).`,
      );
    }
    console.log(`\nManual steps: add TikTok/YouTube rows, fill Tone, audit missed (untagged) content.\n`);
    process.exit(0);
  } catch (error) {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
