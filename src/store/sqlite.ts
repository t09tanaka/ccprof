import Database from "better-sqlite3";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

import type { StorePaths } from "./paths.js";

export const STORE_SCHEMA_VERSION = 5;
export const SOURCE_CATALOG_MIGRATION = "schema-v3-source-catalog";
export const ANALYSIS_BUDGETS_MIGRATION = "schema-v4-analysis-budgets";
export const INCREMENTAL_SOURCES_MIGRATION = "schema-v5-incremental-sources";

const BUSY_TIMEOUT_MS = 5_000;
const STORE_SCHEMA_V2 = 2;
const STORE_SCHEMA_V3 = 3;
const STORE_SCHEMA_V4 = 4;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export class UnsupportedStoreSchemaError extends Error {
  constructor(readonly schema_version: number) {
    super(
      `Unsupported ccprof store schema version ${schema_version}; expected 0, ${STORE_SCHEMA_V2}, ${STORE_SCHEMA_V3}, ${STORE_SCHEMA_V4}, or ${STORE_SCHEMA_VERSION}`,
    );
    this.name = "UnsupportedStoreSchemaError";
  }
}

export function storeDatabasePath(paths: StorePaths): string {
  return join(paths.repo_dir, "store.sqlite3");
}

function schemaVersion(database: Database.Database): number {
  return Number(database.pragma("user_version", { simple: true }));
}

function assertSupportedSchema(version: number): void {
  if (
    version !== 0 &&
    version !== STORE_SCHEMA_V2 &&
    version !== STORE_SCHEMA_V3 &&
    version !== STORE_SCHEMA_V4 &&
    version !== STORE_SCHEMA_VERSION
  ) {
    throw new UnsupportedStoreSchemaError(version);
  }
}

const SOURCE_CATALOG_SCHEMA = `
  CREATE TABLE source_catalog (
    adapter_id TEXT NOT NULL CHECK (adapter_id IN ('claude', 'codex')),
    adapter_version TEXT NOT NULL CHECK (adapter_version = '1.0.0'),
    source_identity TEXT NOT NULL PRIMARY KEY
      CHECK (length(source_identity) = 71
        AND substr(source_identity, 1, 7) = 'source-'
        AND substr(source_identity, 8) NOT GLOB '*[^0-9a-f]*'),
    canonical_path TEXT NOT NULL
      CHECK (length(canonical_path) > 0 AND instr(canonical_path, char(0)) = 0),
    device INTEGER CHECK (device IS NULL OR
      (typeof(device) = 'integer' AND device BETWEEN 0 AND ${MAX_SAFE_INTEGER})),
    inode INTEGER CHECK (inode IS NULL OR
      (typeof(inode) = 'integer' AND inode BETWEEN 0 AND ${MAX_SAFE_INTEGER})),
    mtime_ms INTEGER NOT NULL CHECK (typeof(mtime_ms) = 'integer'
      AND mtime_ms BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    size_bytes INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer'
      AND size_bytes BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    prefix_hash TEXT NOT NULL CHECK (length(prefix_hash) = 71
      AND substr(prefix_hash, 1, 7) = 'sha256:'
      AND substr(prefix_hash, 8) NOT GLOB '*[^0-9a-f]*'),
    suffix_hash TEXT NOT NULL CHECK (length(suffix_hash) = 71
      AND substr(suffix_hash, 1, 7) = 'sha256:'
      AND substr(suffix_hash, 8) NOT GLOB '*[^0-9a-f]*'),
    content_revision TEXT NOT NULL CHECK (length(content_revision) = 71
      AND substr(content_revision, 1, 7) = 'sha256:'
      AND substr(content_revision, 8) NOT GLOB '*[^0-9a-f]*'),
    discovery_cursor INTEGER NOT NULL CHECK (typeof(discovery_cursor) = 'integer'
      AND discovery_cursor BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    last_parsed_offset INTEGER NOT NULL CHECK (typeof(last_parsed_offset) = 'integer'
      AND last_parsed_offset BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    last_normalized_event_index INTEGER NOT NULL
      CHECK (typeof(last_normalized_event_index) = 'integer'
        AND last_normalized_event_index BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    parser_version TEXT NOT NULL
      CHECK (length(parser_version) > 0 AND instr(parser_version, char(0)) = 0),
    schema_fingerprint TEXT NOT NULL CHECK (length(schema_fingerprint) = 71
      AND substr(schema_fingerprint, 1, 7) = 'sha256:'
      AND substr(schema_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'),
    observed_at_ms INTEGER NOT NULL CHECK (typeof(observed_at_ms) = 'integer'
      AND observed_at_ms BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial')),
    CHECK ((device IS NULL) = (inode IS NULL)),
    CHECK (last_parsed_offset <= size_bytes),
    CHECK (completeness <> 'complete' OR last_parsed_offset = size_bytes)
  );
`;

const ANALYSIS_BUDGETS_SCHEMA = `
  CREATE TABLE analysis_budget_runs (
    execution_id TEXT NOT NULL PRIMARY KEY,
    max_input_bytes INTEGER NOT NULL CHECK (typeof(max_input_bytes) = 'integer'
      AND max_input_bytes BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    max_input_events INTEGER NOT NULL CHECK (typeof(max_input_events) = 'integer'
      AND max_input_events BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    max_wall_ms INTEGER NOT NULL CHECK (typeof(max_wall_ms) = 'integer'
      AND max_wall_ms BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    max_cpu_ms INTEGER NOT NULL CHECK (typeof(max_cpu_ms) = 'integer'
      AND max_cpu_ms BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    max_output_bytes INTEGER NOT NULL CHECK (typeof(max_output_bytes) = 'integer'
      AND max_output_bytes BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    max_source_items INTEGER NOT NULL CHECK (typeof(max_source_items) = 'integer'
      AND max_source_items BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    consumed_input_bytes INTEGER NOT NULL
      CHECK (typeof(consumed_input_bytes) = 'integer'
        AND consumed_input_bytes BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    consumed_input_events INTEGER NOT NULL
      CHECK (typeof(consumed_input_events) = 'integer'
        AND consumed_input_events BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    consumed_wall_ms INTEGER NOT NULL CHECK (typeof(consumed_wall_ms) = 'integer'
      AND consumed_wall_ms BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    consumed_cpu_ms INTEGER NOT NULL CHECK (typeof(consumed_cpu_ms) = 'integer'
      AND consumed_cpu_ms BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    consumed_output_bytes INTEGER NOT NULL
      CHECK (typeof(consumed_output_bytes) = 'integer'
        AND consumed_output_bytes BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    consumed_source_items INTEGER NOT NULL
      CHECK (typeof(consumed_source_items) = 'integer'
        AND consumed_source_items BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    observed_input_bytes INTEGER NOT NULL
      CHECK (typeof(observed_input_bytes) = 'integer'
        AND observed_input_bytes BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    observed_input_events INTEGER NOT NULL
      CHECK (typeof(observed_input_events) = 'integer'
        AND observed_input_events BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    observed_wall_ms INTEGER NOT NULL CHECK (typeof(observed_wall_ms) = 'integer'
      AND observed_wall_ms BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    observed_cpu_ms INTEGER NOT NULL CHECK (typeof(observed_cpu_ms) = 'integer'
      AND observed_cpu_ms BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    observed_output_bytes INTEGER NOT NULL
      CHECK (typeof(observed_output_bytes) = 'integer'
        AND observed_output_bytes BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    observed_source_items INTEGER NOT NULL
      CHECK (typeof(observed_source_items) = 'integer'
        AND observed_source_items BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial')),
    truncation_reason TEXT CHECK (truncation_reason IS NULL OR
      truncation_reason IN ('max_input_bytes', 'max_input_events',
        'max_wall_ms', 'max_cpu_ms', 'max_output_bytes', 'max_source_items',
        'source_failure', 'meter_error')),
    coverage REAL NOT NULL CHECK (typeof(coverage) IN ('integer', 'real')
      AND coverage BETWEEN 0 AND 1),
    FOREIGN KEY (execution_id) REFERENCES analysis_executions(execution_id)
      ON DELETE CASCADE,
    CHECK (consumed_input_bytes <= observed_input_bytes),
    CHECK (consumed_input_events <= observed_input_events),
    CHECK (consumed_wall_ms <= observed_wall_ms),
    CHECK (consumed_cpu_ms <= observed_cpu_ms),
    CHECK (consumed_output_bytes <= observed_output_bytes),
    CHECK (consumed_source_items <= observed_source_items),
    CHECK (consumed_input_bytes <= max_input_bytes),
    CHECK (consumed_input_events <= max_input_events),
    CHECK (consumed_output_bytes <= max_output_bytes),
    CHECK (consumed_source_items <= max_source_items),
    CHECK ((completeness = 'complete' AND truncation_reason IS NULL
        AND coverage = 1
        AND consumed_input_bytes = observed_input_bytes
        AND consumed_input_events = observed_input_events
        AND consumed_wall_ms = observed_wall_ms
        AND consumed_cpu_ms = observed_cpu_ms
        AND consumed_output_bytes = observed_output_bytes
        AND consumed_source_items = observed_source_items
        AND consumed_input_bytes <= max_input_bytes
        AND consumed_input_events <= max_input_events
        AND consumed_wall_ms <= max_wall_ms
        AND consumed_cpu_ms <= max_cpu_ms
        AND consumed_output_bytes <= max_output_bytes
        AND consumed_source_items <= max_source_items)
      OR (completeness = 'partial' AND truncation_reason IS NOT NULL
        AND coverage < 1))
  );
`;

const SOURCE_EVIDENCE_CACHE_SCHEMA = `
  CREATE TABLE source_evidence_cache (
    source_identity TEXT NOT NULL
      CHECK (length(source_identity) = 71
        AND substr(source_identity, 1, 7) = 'source-'
        AND substr(source_identity, 8) NOT GLOB '*[^0-9a-f]*'),
    repository_identity TEXT NOT NULL
      CHECK (length(repository_identity) = 64
        AND repository_identity NOT GLOB '*[^0-9a-f]*'),
    eligibility_identity TEXT NOT NULL
      CHECK (length(eligibility_identity) = 64
        AND eligibility_identity NOT GLOB '*[^0-9a-f]*'),
    adapter_id TEXT NOT NULL CHECK (adapter_id IN ('claude', 'codex')),
    canonical_path TEXT NOT NULL
      CHECK (length(canonical_path) > 0 AND instr(canonical_path, char(0)) = 0),
    content_revision TEXT NOT NULL CHECK (length(content_revision) = 71
      AND substr(content_revision, 1, 7) = 'sha256:'
      AND substr(content_revision, 8) NOT GLOB '*[^0-9a-f]*'),
    parser_version TEXT NOT NULL
      CHECK (length(parser_version) > 0 AND instr(parser_version, char(0)) = 0),
    schema_fingerprint TEXT NOT NULL CHECK (length(schema_fingerprint) = 71
      AND substr(schema_fingerprint, 1, 7) = 'sha256:'
      AND substr(schema_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'),
    last_parsed_offset INTEGER NOT NULL
      CHECK (typeof(last_parsed_offset) = 'integer'
        AND last_parsed_offset BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    line_count INTEGER NOT NULL CHECK (typeof(line_count) = 'integer'
      AND line_count BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    ends_with_newline INTEGER NOT NULL
      CHECK (typeof(ends_with_newline) = 'integer'
        AND ends_with_newline IN (0, 1)),
    payload_json TEXT NOT NULL
      CHECK (length(payload_json) > 0 AND instr(payload_json, char(0)) = 0),
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 71
      AND substr(payload_digest, 1, 7) = 'sha256:'
      AND substr(payload_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    descriptor_digest TEXT NOT NULL CHECK (length(descriptor_digest) = 71
      AND substr(descriptor_digest, 1, 7) = 'sha256:'
      AND substr(descriptor_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    sensitivity TEXT NOT NULL CHECK (sensitivity = 'sensitive'),
    retention_class TEXT NOT NULL CHECK (retention_class = 'raw_evidence'),
    updated_at_ms INTEGER NOT NULL CHECK (typeof(updated_at_ms) = 'integer'
      AND updated_at_ms BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    PRIMARY KEY (source_identity, eligibility_identity),
    FOREIGN KEY (source_identity) REFERENCES source_catalog(source_identity)
      ON DELETE CASCADE
  );
`;

const SOURCE_DISCOVERY_ROOTS_SCHEMA = `
  CREATE TABLE source_discovery_roots (
    root_identity TEXT NOT NULL PRIMARY KEY
      CHECK (length(root_identity) = 69
        AND substr(root_identity, 1, 5) = 'root-'
        AND substr(root_identity, 6) NOT GLOB '*[^0-9a-f]*'),
    adapter_id TEXT NOT NULL CHECK (adapter_id IN ('claude', 'codex')),
    canonical_root TEXT NOT NULL
      CHECK (length(canonical_root) > 0 AND instr(canonical_root, char(0)) = 0),
    cursor INTEGER NOT NULL CHECK (typeof(cursor) = 'integer'
      AND cursor BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    capability TEXT NOT NULL
      CHECK (capability IN ('stable_directory_token', 'full_scan_required')),
    tree_json TEXT NOT NULL
      CHECK (length(tree_json) > 0 AND instr(tree_json, char(0)) = 0),
    tree_digest TEXT NOT NULL CHECK (length(tree_digest) = 71
      AND substr(tree_digest, 1, 7) = 'sha256:'
      AND substr(tree_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    observed_at_ms INTEGER NOT NULL CHECK (typeof(observed_at_ms) = 'integer'
      AND observed_at_ms BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
    completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial')),
    sensitivity TEXT NOT NULL CHECK (sensitivity = 'sensitive'),
    retention_class TEXT NOT NULL CHECK (retention_class = 'source_metadata')
  );
`;

function unsafeStorePath(path: string, reason: string): Error {
  return new Error(`unsafe store path "${path}": ${reason}`);
}

function pathStatus(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validateRepositoryDirectory(path: string): boolean {
  const status = pathStatus(path);
  if (status === undefined) return false;
  if (status.isSymbolicLink()) {
    throw unsafeStorePath(path, "symbolic link not allowed");
  }
  if (!status.isDirectory()) {
    throw unsafeStorePath(path, "expected a directory");
  }
  return true;
}

function validateDatabaseFile(path: string): boolean {
  const status = pathStatus(path);
  if (status === undefined) return false;
  if (status.isSymbolicLink()) {
    throw unsafeStorePath(path, "symbolic link not allowed");
  }
  if (!status.isFile()) {
    throw unsafeStorePath(path, "expected a regular file");
  }
  return true;
}

function precreatePrivateDatabase(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  if (!validateDatabaseFile(path)) {
    throw unsafeStorePath(path, "database disappeared during creation");
  }
}

function prepareDatabasePath(paths: StorePaths, databasePath: string): boolean {
  const repositoryExists = validateRepositoryDirectory(paths.repo_dir);
  const databaseExists = repositoryExists && validateDatabaseFile(databasePath);
  if (databaseExists) return true;

  if (!repositoryExists) {
    mkdirSync(paths.repo_dir, { recursive: true, mode: 0o700 });
  }
  validateRepositoryDirectory(paths.repo_dir);
  if (process.platform !== "win32") chmodSync(paths.repo_dir, 0o700);
  precreatePrivateDatabase(databasePath);
  return false;
}

function configureConnection(database: Database.Database): void {
  database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (Number(database.pragma("busy_timeout", { simple: true })) !== BUSY_TIMEOUT_MS) {
    throw new Error("Failed to configure the SQLite busy timeout");
  }

  const journalMode = String(
    database.pragma("journal_mode = WAL", { simple: true }),
  ).toLowerCase();
  if (journalMode !== "wal") {
    throw new Error(`Failed to enable SQLite WAL mode: received ${journalMode}`);
  }

  database.pragma("foreign_keys = ON");
  if (Number(database.pragma("foreign_keys", { simple: true })) !== 1) {
    throw new Error("Failed to enable SQLite foreign keys");
  }
}

function migrateSchema(database: Database.Database): void {
  const migrate = database.transaction(() => {
    const version = schemaVersion(database);
    assertSupportedSchema(version);
    if (version === STORE_SCHEMA_VERSION) return;

    if (version === 0) database.exec(`
      CREATE TABLE store_migrations (
        name TEXT NOT NULL PRIMARY KEY,
        completed_at_ms INTEGER NOT NULL
      );

      CREATE TABLE analysis_snapshots (
        snapshot_id TEXT NOT NULL PRIMARY KEY,
        created_at_ms INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX analysis_snapshots_created_at
        ON analysis_snapshots(created_at_ms);

      CREATE TABLE analysis_executions (
        execution_id TEXT NOT NULL PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        executed_at_ms INTEGER NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES analysis_snapshots(snapshot_id)
          ON DELETE CASCADE
      );
      CREATE INDEX analysis_executions_snapshot_executed_at
        ON analysis_executions(snapshot_id, executed_at_ms);
      CREATE INDEX analysis_executions_executed_at
        ON analysis_executions(executed_at_ms);

      CREATE TABLE dismissals (
        finding_key TEXT NOT NULL PRIMARY KEY,
        dismissed_at_ms INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX dismissals_dismissed_at
        ON dismissals(dismissed_at_ms);

      CREATE TABLE adoptions (
        finding_key TEXT NOT NULL PRIMARY KEY,
        detected_at_ms INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX adoptions_detected_at
        ON adoptions(detected_at_ms);
    `);

    if (version === 0 || version === STORE_SCHEMA_V2) {
      database.exec(SOURCE_CATALOG_SCHEMA);
      database.prepare(
        "INSERT INTO store_migrations(name, completed_at_ms) VALUES (?, ?)",
      ).run(SOURCE_CATALOG_MIGRATION, Date.now());
    }
    if (
      version === 0 ||
      version === STORE_SCHEMA_V2 ||
      version === STORE_SCHEMA_V3
    ) {
      database.exec(ANALYSIS_BUDGETS_SCHEMA);
      database.prepare(
        "INSERT INTO store_migrations(name, completed_at_ms) VALUES (?, ?)",
      ).run(ANALYSIS_BUDGETS_MIGRATION, Date.now());
    }
    if (
      version === 0 ||
      version === STORE_SCHEMA_V2 ||
      version === STORE_SCHEMA_V3 ||
      version === STORE_SCHEMA_V4
    ) {
      database.exec(SOURCE_EVIDENCE_CACHE_SCHEMA);
      database.exec(SOURCE_DISCOVERY_ROOTS_SCHEMA);
      database.prepare(
        "INSERT INTO store_migrations(name, completed_at_ms) VALUES (?, ?)",
      ).run(INCREMENTAL_SOURCES_MIGRATION, Date.now());
    }
    database.pragma(`user_version = ${STORE_SCHEMA_VERSION}`);
  });

  migrate.immediate();
}

export function openStoreDatabase(paths: StorePaths): Database.Database {
  const databasePath = storeDatabasePath(paths);
  prepareDatabasePath(paths, databasePath);

  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath);
    const version = schemaVersion(database);
    assertSupportedSchema(version);

    if (process.platform !== "win32") {
      chmodSync(paths.repo_dir, 0o700);
      chmodSync(databasePath, 0o600);
    }

    configureConnection(database);
    if (version !== STORE_SCHEMA_VERSION) migrateSchema(database);
    return database;
  } catch (error) {
    if (database?.open === true) {
      try {
        database.close();
      } catch {
        // Preserve the original open/configuration/bootstrap failure.
      }
    }
    throw error;
  }
}
