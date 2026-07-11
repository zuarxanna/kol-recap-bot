import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * Root directory for the JSON data files.
 *
 * @remarks
 * Resolved from the working directory (`process.cwd()/db`), NOT relative to this
 * module, so the compiled `dist/src/model/*.js` still reads the real `db/*.json` and
 * the Docker volume. Override with the `DATA_DIR` environment variable.
 */
const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), 'db');

/**
 * The minimum shape of any persisted row — every model has at least these fields.
 */
export interface ModelRow {
  /** Stable numeric primary key, assigned on first {@link Model.save}. */
  id: number;
  /** ISO-8601 timestamp of when the record was created. */
  created_at: string;
}

/**
 * The static side of a concrete {@link Model} subclass, used to type the generic CRUD
 * helpers so they return the subclass instance type.
 *
 * @typeParam T - The concrete model instance type (e.g. `Kol`).
 */
export interface ModelStatic<T extends Model> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructors have
  // per-subclass row types; this type only asserts "is a constructor for T".
  new (row?: any): T;
  /** Backing JSON filename, relative to {@link DATA_DIR}. */
  table: string;
  /**
   * Build an instance from a plain row.
   * @param row - A raw row read from disk.
   * @returns The hydrated model instance.
   */
  hydrate(row: ModelRow): T;
}

/**
 * Resolve a table name to its absolute file path under {@link DATA_DIR}.
 * @param table - Backing filename (e.g. `"kols.json"`).
 * @returns The absolute path to the JSON file.
 */
const fileFor = (table: string): string => resolve(DATA_DIR, table);

/**
 * Read and parse the JSON array backing a table.
 * @param table - Backing filename.
 * @returns The raw rows, unhydrated.
 */
const readRows = (table: string): ModelRow[] =>
  JSON.parse(readFileSync(fileFor(table), 'utf8')) as ModelRow[];

/**
 * Overwrite a table's JSON array (pretty-printed, trailing newline). Creates the
 * containing directory if it does not exist.
 * @param table - Backing filename.
 * @param rows - The full set of rows to persist.
 */
const writeRows = (table: string, rows: ModelRow[]): void => {
  const file = fileFor(table);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(rows, null, 2) + '\n');
};

/**
 * Compute the next integer id for a set of rows.
 * @param rows - The existing rows.
 * @returns `max(id) + 1`, or `1` when the set is empty.
 */
const nextId = (rows: ModelRow[]): number =>
  rows.length ? Math.max(...rows.map((r) => Number(r.id) || 0)) + 1 : 1;

/**
 * Abstract ActiveRecord-style base for JSON-file-backed models.
 *
 * @remarks
 * Each concrete model (`Kol`, `Campaign`) is one object in an array inside
 * `<DATA_DIR>/<table>`. The base provides generic CRUD; a subclass must supply:
 *
 * - `static table` — the backing JSON filename (e.g. `"kols.json"`);
 * - `static hydrate(row)` — build an instance from a plain row;
 * - `toRow()` — serialize an instance back to a plain row.
 *
 * @example
 * ```ts
 * const kols = Kol.all();                        // read all
 * const kol  = new Kol({ name, ig_username }).save(); // create (auto id + created_at)
 * Kol.find(kol.id)?.delete();                    // delete
 * ```
 */
export abstract class Model implements ModelRow {
  /**
   * Backing JSON filename, relative to `DATA_DIR`.
   * @defaultValue `''` — must be overridden by each subclass.
   */
  static table = '';

  id: number;
  created_at: string;

  /**
   * @param row - Partial row to seed the instance; missing fields get defaults
   * (`id` → `0`, `created_at` → now).
   */
  constructor(row: Partial<ModelRow> = {}) {
    this.id = Number(row.id ?? 0);
    this.created_at = row.created_at ?? new Date().toISOString();
  }

  /**
   * Serialize this instance to a plain JSON row. Subclasses extend it with their own
   * fields.
   * @returns The row to persist.
   */
  abstract toRow(): ModelRow;

  // ---- CRUD: read (static / collection) ----

  /**
   * Read every record of this model, as hydrated instances.
   * @typeParam T - The concrete model type (inferred from the calling subclass).
   * @returns All records.
   */
  static all<T extends Model>(this: ModelStatic<T>): T[] {
    return readRows(this.table).map((r) => this.hydrate(r));
  }

  /**
   * Find the record with the given id.
   * @typeParam T - The concrete model type (inferred from the calling subclass).
   * @param id - The record id to look up.
   * @returns The matching record, or `null` if none exists.
   */
  static find<T extends Model>(this: ModelStatic<T>, id: number): T | null {
    const row = readRows(this.table).find((r) => r.id === id);
    return row ? this.hydrate(row) : null;
  }

  /**
   * Overwrite the whole collection with the given instances (bulk update).
   * @typeParam T - The concrete model type (inferred from the calling subclass).
   * @param models - The full set of records to persist.
   */
  static saveAll<T extends Model>(this: ModelStatic<T>, models: T[]): void {
    writeRows(this.table, models.map((m) => m.toRow()));
  }

  // ---- CRUD: write (instance) ----

  /**
   * Insert this record (assigning a fresh id) or update it in place if its id already
   * exists in the backing file.
   * @returns This instance (with `id` populated), for chaining.
   */
  save(): this {
    const { table } = this.constructor as typeof Model;
    const rows = readRows(table);
    const idx = this.id ? rows.findIndex((r) => r.id === this.id) : -1;
    if (idx >= 0) {
      rows[idx] = this.toRow();
    } else {
      this.id = this.id || nextId(rows);
      rows.push(this.toRow());
    }
    writeRows(table, rows);
    return this;
  }

  /**
   * Remove this record from the backing file (matched by `id`).
   */
  delete(): void {
    const { table } = this.constructor as typeof Model;
    writeRows(table, readRows(table).filter((r) => r.id !== this.id));
  }
}
