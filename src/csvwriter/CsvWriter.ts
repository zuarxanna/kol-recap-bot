import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Campaign, ContentRecord, CsvRow } from '../types.js';

/**
 * Writes normalized records to the team's 21-column recap CSV template.
 *
 * @remarks
 * Manual columns (code, product, brand, type content, tone article, value, ID) are left
 * blank to be filled in the spreadsheet after export. `name of event` is auto-filled with
 * the active campaign's name. Numbers (views/commentars) are RAW integers so the
 * spreadsheet can compute on them; dates are `DD/MM/YYYY`; month entry is English. There
 * is no hashtag/likes column (not in the template) — hashtags remain an internal filter
 * concern only.
 *
 * The {@link CsvWriter.HEADER} strings must match the client's actual spreadsheet EXACTLY
 * (their sheet maps columns BY NAME). Any rename here requires the same rename there —
 * including the current `"commentars"` / `"link articel/video"` spellings.
 */
export class CsvWriter {
  /** Team template column order (verbatim — the client sheet maps BY NAME). */
  static readonly HEADER: string[] = [
    'code', 'date', 'kol name', 'kol domain', 'source',
    'source type', 'release date', 'month entry', 'title article/video', 'link articel/video',
    'product', 'brand', 'type content', 'tone article', 'commentars', 'views',
    'value', 'name of event', 'qty', 'ID', 'YEAR',
  ];

  /** English month abbreviations, indexed 0–11, for the Month Entry column. */
  static readonly MONTHS: string[] = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  /**
   * @param outputDir - Absolute path to the output folder (created on write if missing).
   */
  constructor(private readonly outputDir: string) {}

  /**
   * RFC-4180 cell escaping.
   * @param value - The raw cell value.
   * @returns The value, quoted if it contains a comma/quote/newline (inner quotes doubled).
   */
  #formatCell(value: string | number | null | undefined): string {
    const str = value == null ? '' : String(value);
    return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  }

  /**
   * Join a row's values into one escaped CSV line.
   * @param cells - The row cells.
   * @returns The comma-joined, escaped line.
   */
  #formatRow(cells: CsvRow): string {
    return cells.map((value) => this.#formatCell(value)).join(',');
  }

  /**
   * Slugify a name for the output filename.
   * @param name - The campaign name.
   * @returns A lowercase, hyphenated slug.
   */
  #slugify(name: string): string {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /**
   * Parse `"YYYY-MM-DD"` (WIB, from an adapter) into CSV date parts.
   *
   * @remarks
   * Parses the string directly (NOT `new Date`) so there is no further timezone shift.
   *
   * @param iso - Date as `"YYYY-MM-DD"`.
   * @returns `{ date: "DD/MM/YYYY", month: "Jun", year: "2026" }`, or empty strings if unparseable.
   */
  #deriveDateParts(iso: string): { date: string; month: string; year: string } {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!match) return { date: '', month: '', year: '' };
    const [, year, month, day] = match;
    return { date: `${day}/${month}/${year}`, month: CsvWriter.MONTHS[Number(month) - 1] ?? '', year: year ?? '' };
  }

  /**
   * Write normalized records (already filtered & sorted) to the campaign's CSV file.
   *
   * @remarks
   * The header is always written, even with zero rows — the file must exist for the
   * manual spreadsheet work.
   *
   * @param records - The records to write.
   * @param campaign - The campaign (used for the output filename).
   * @returns The absolute output path plus the row arrays that were written.
   */
  write(records: ContentRecord[], campaign: Campaign): { outPath: string; rows: CsvRow[] } {
    const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); // YYYY-MM-DD
    const recapDate = this.#deriveDateParts(todayIso).date;

    const rows: CsvRow[] = records.map((record) => {
      const dateParts = this.#deriveDateParts(record.date);
      return [
        '',                    // code — manual
        recapDate,             // date (recap run date)
        record.name,           // kol name
        `@${record.handle}`,   // kol domain
        record.platform,       // source
        record.type,           // source type (IG='Reels')
        dateParts.date,        // release date
        dateParts.month,       // month entry
        record.title,          // title article/video
        record.url,            // link articel/video
        '',                    // product — manual
        '',                    // brand — manual
        '',                    // type content — manual
        '',                    // tone article — manual
        record.comments,       // commentars
        record.views,          // views
        '',                    // value — manual
        campaign.name,         // name of event (auto: active campaign name)
        1,                     // qty
        '',                    // ID — manual
        dateParts.year,        // YEAR
      ];
    });

    const outPath = join(this.outputDir, `${this.#slugify(campaign.name)}_${todayIso}.csv`);
    mkdirSync(this.outputDir, { recursive: true });
    const csv = [this.#formatRow(CsvWriter.HEADER), ...rows.map((row) => this.#formatRow(row))].join('\n') + '\n';
    writeFileSync(outPath, csv);

    return { outPath, rows };
  }
}
