// recap.ts — entry point + wiring (composition root).
//
// This is where concrete adapters are chosen and injected into RecapService. To add a
// platform:
//   import { TikTokAdapter } from './adapters/TikTokAdapter.js';
//   adapters.push(new TikTokAdapter(process.env.APIFY_TOKEN));
// RecapService/CsvWriter do NOT need to change (OCP).
//
// CLI:  tsx src/recap.ts   (dev)   |   node dist/src/recap.js   (built)
// The runRecap() facade preserves the old signature so bot.ts does not change.
//
// NOTE: an empty CSV is NOT automatically a bug. The hashtag filter is deliberately
// strict — content a KOL did not tag is missed on purpose (an accepted tradeoff,
// audited manually). The diagnostics tell "0 matched of N" (filter working) apart from
// "all errored" (scrape broken).

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { InstagramAdapter } from './adapters/InstagramAdapter.js';
import { TikTokAdapter } from './adapters/TikTokAdapter.js';
import { YouTubeAdapter } from './adapters/YouTubeAdapter.js';
import { CsvWriter } from './CsvWriter.js';
import { RecapService } from './RecapService.js';
import type { PlatformAdapter } from './adapters/PlatformAdapter.js';
import type { RecapResult, RunOptions } from './types.js';

/** Composition root: assemble the active adapters + writer into a RecapService. */
function buildService(): RecapService {
  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) throw new Error('APIFY_TOKEN is missing from .env');

  const adapters: PlatformAdapter[] = [
    new InstagramAdapter(apifyToken),
    new TikTokAdapter(apifyToken),
  ];
  // YouTube is optional: enabled only when a key is present (free, official API).
  // Without a key it is skipped and the recap still runs (IG + TikTok). The constructor
  // throws if called without a key.
  if (process.env.YOUTUBE_API_KEY) {
    adapters.push(new YouTubeAdapter(process.env.YOUTUBE_API_KEY));
  }
  // out/ is resolved from the working directory (matches the Docker volume ./out:/app/out).
  const outDir = process.env.OUT_DIR ?? resolve(process.cwd(), 'out');
  return new RecapService({ adapters, csvWriter: new CsvWriter(outDir) });
}

/**
 * Facade used by bot.ts. Returns the same shape as before the refactor.
 * @param options - Passed through to RecapService.run (e.g. { onKolDone }).
 */
export async function runRecap(options?: RunOptions): Promise<RecapResult> {
  return buildService().run(options);
}

// --- CLI: run directly ---
const runDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (runDirect) {
  try {
    const r = await runRecap();
    console.log(`\n=== recap: "${r.campaign.name}" #${r.hashtag} since ${r.since} ===`);
    for (const d of r.diagnostics) {
      const note = d.allError ? ` ⚠ ALL errored (e.g. ${d.firstError})` : '';
      console.log(
        `@${d.handle} [${d.platform}]: scraped ${d.scraped}, errored ${d.errored}, matched #${r.hashtag} → ${d.matched} rows${note}`,
      );
    }
    console.log(`\n--- RESULT ---`);
    console.log(`${r.records.length} rows written → ${r.outPath}`);
    console.log(`total cost = $${r.totalCost.toFixed(4)} for ${r.diagnostics.length} fetches`);
    if (r.records.length === 0) {
      console.log(
        `\nEmpty CSV. "scraped N>0" but 0 matched = the filter tradeoff (audit manually). scraped 0 / all errored = a scrape problem (handle/private/token).`,
      );
    }
    console.log(`\nManual steps: add TikTok/YouTube rows, fill Tone, audit missed (untagged) content.\n`);
    process.exit(0);
  } catch (e) {
    console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
