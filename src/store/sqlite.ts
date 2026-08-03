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

export const STORE_SCHEMA_VERSION = 2;

const BUSY_TIMEOUT_MS = 5_000;

export class UnsupportedStoreSchemaError extends Error {
  constructor(readonly schema_version: number) {
    super(
      `Unsupported ccprof store schema version ${schema_version}; expected 0 or ${STORE_SCHEMA_VERSION}`,
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
  if (version !== 0 && version !== STORE_SCHEMA_VERSION) {
    throw new UnsupportedStoreSchemaError(version);
  }
}

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

function bootstrapSchema(database: Database.Database): void {
  const bootstrap = database.transaction(() => {
    const version = schemaVersion(database);
    assertSupportedSchema(version);
    if (version === STORE_SCHEMA_VERSION) return;

    database.exec(`
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

    database.pragma(`user_version = ${STORE_SCHEMA_VERSION}`);
  });

  bootstrap.immediate();
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
    if (version === 0) bootstrapSchema(database);
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
