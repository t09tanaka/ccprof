import { createHash } from "node:crypto";

export type SourceCoverageCompleteness = "complete" | "partial";

export interface AvailableBuiltInSourceCoverage {
  status: "available";
  adapter_id: "claude" | "codex";
  adapter_version: "1.0.0";
  parser_version: string;
  schema_fingerprint: `sha256:${string}`;
  files_discovered: number;
  files_parsed: number;
  rows_seen: number;
  rows_accepted: number;
  events_emitted: number;
  completeness: SourceCoverageCompleteness;
}

export interface UnavailableSourceCoverage {
  status: "unavailable";
}

export type BuiltInSourceCoverage =
  | AvailableBuiltInSourceCoverage
  | UnavailableSourceCoverage;

export interface BuiltInSourceCoverageAccumulator {
  recordDiscoveredFile(): void;
  recordParsedFile(rowsSeen: number, rowsAccepted: number, eventsEmitted: number,
    completeness: SourceCoverageCompleteness): void;
  markPartial(): void;
  snapshot(): Readonly<AvailableBuiltInSourceCoverage>;
}

const MAX_VERSION_BYTES = 256;
const PARSER_STATE_FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const UNAVAILABLE_SOURCE_COVERAGE: Readonly<UnavailableSourceCoverage> =
  Object.freeze({ status: "unavailable" });

function validateVersion(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_VERSION_BYTES) {
    throw new TypeError("Invalid parser version.");
  }
}
function validateCounter(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError("Source coverage counters must be nonnegative safe integers.");
}
function addCounter(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result))
    throw new TypeError("Source coverage counter overflow.");
  return result;
}

function schemaFingerprint(
  adapterId: "claude" | "codex", adapterVersion: "1.0.0",
  parserVersion: string, parserStateFingerprint: string,
): `sha256:${string}` {
  const canonical = [adapterId, adapterVersion, parserVersion,
    parserStateFingerprint] as const;
  return `sha256:${createHash("sha256")
    .update("source-coverage-schema-v1")
    .update("\0")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;
}

export function unavailableSourceCoverage(): Readonly<UnavailableSourceCoverage> {
  return UNAVAILABLE_SOURCE_COVERAGE;
}

export function createBuiltInSourceCoverageAccumulator(
  adapterId: "claude" | "codex", adapterVersion: "1.0.0",
  parserVersion: string, parserStateFingerprint: `sha256:${string}`,
): BuiltInSourceCoverageAccumulator {
  if (adapterId !== "claude" && adapterId !== "codex")
    throw new TypeError("Invalid built-in source adapter.");
  if (adapterVersion !== "1.0.0")
    throw new TypeError("Invalid built-in source adapter version.");
  validateVersion(parserVersion);
  if (!PARSER_STATE_FINGERPRINT.test(parserStateFingerprint))
    throw new TypeError("Invalid parser-state fingerprint.");

  const fingerprint = schemaFingerprint(adapterId, adapterVersion, parserVersion,
    parserStateFingerprint);
  let filesDiscovered = 0, filesParsed = 0, rowsSeen = 0, rowsAccepted = 0,
    eventsEmitted = 0;
  let completeness: SourceCoverageCompleteness = "complete";

  return {
    recordDiscoveredFile(): void {
      filesDiscovered = addCounter(filesDiscovered, 1);
    },
    recordParsedFile(seen, accepted, emitted, nextCompleteness): void {
      validateCounter(seen);
      validateCounter(accepted);
      validateCounter(emitted);
      if (accepted > seen || (nextCompleteness !== "complete" &&
        nextCompleteness !== "partial"))
        throw new TypeError("Invalid parsed-file source coverage.");
      const nextFilesParsed = addCounter(filesParsed, 1);
      if (nextFilesParsed > filesDiscovered)
        throw new TypeError("Parsed files cannot exceed discovered files.");
      const nextRowsSeen = addCounter(rowsSeen, seen);
      const nextRowsAccepted = addCounter(rowsAccepted, accepted);
      const nextEventsEmitted = addCounter(eventsEmitted, emitted);
      filesParsed = nextFilesParsed;
      rowsSeen = nextRowsSeen;
      rowsAccepted = nextRowsAccepted;
      eventsEmitted = nextEventsEmitted;
      if (nextCompleteness === "partial") completeness = "partial";
    },
    markPartial(): void {
      completeness = "partial";
    },
    snapshot(): Readonly<AvailableBuiltInSourceCoverage> {
      return Object.freeze({
        status: "available", adapter_id: adapterId, adapter_version: adapterVersion,
        parser_version: parserVersion,
        schema_fingerprint: fingerprint,
        files_discovered: filesDiscovered, files_parsed: filesParsed,
        rows_seen: rowsSeen, rows_accepted: rowsAccepted,
        events_emitted: eventsEmitted,
        completeness,
      });
    },
  };
}
