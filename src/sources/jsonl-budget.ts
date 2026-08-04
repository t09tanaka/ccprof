import { createHash } from "node:crypto";
import { createReadStream, read } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export interface JsonlParserBudgets {
  maxFileBytes: number; maxLineBytes: number; maxNodesPerLine: number;
  maxNestingDepth: number; maxRetainedBytes: number; maxWarnings: number;
}
export interface JsonlParserControls {
  budgets?: Partial<JsonlParserBudgets>; signal?: AbortSignal;
}
export interface ParserReadRange {
  start_offset: number;
  starting_line: number;
}
export interface SourceReadReceipt {
  start_offset: number;
  end_offset: number;
  bytes_read: number;
  digest: string;
}
export interface ParserStateReadResult<State> {
  state: State;
  receipt: SourceReadReceipt;
  completeness: "complete" | "partial";
}
export interface ParserStateWarningV1 {
  order: number;
  applicability:
    | { kind: "unconditional" }
    | { kind: "timestamp"; timestamp_ms: number };
  scope: "source" | "session";
  target_session_id: string | null;
  warning: {
    code: string;
    message: string;
    source_path: string;
    line?: number;
    session_ref?: string;
  };
}
export interface ParserStateRowBaseV1 {
  original_bytes: number;
  byte_start: number;
  byte_end: number;
  line: number;
  timestamp_ms: number;
}
export type ParserReadBudgets = Pick<JsonlParserBudgets,
  "maxFileBytes" | "maxLineBytes" | "maxNodesPerLine" |
  "maxNestingDepth">;
export type ParserProjectionBudgets = Pick<JsonlParserBudgets,
  "maxRetainedBytes" | "maxWarnings">;
export interface JsonlReadWindow extends ParserReadRange {
  file_handle: FileHandle;
}
export const MAX_INCREMENTAL_PARSER_STATE_BYTES = 128 * 1024 * 1024;
export const PARSER_STATE_SCHEMA_FINGERPRINT =
  "sha256:bd3f8bd7da3819214a46fe96969bdc35b439803e30171218c0564e1f1d75f996";
export class IncrementalParserStateCapacityError extends Error {
  readonly code = "incremental_state_capacity" as const;
  constructor() {
    super("Incremental parser state exceeds its fixed capacity.");
    this.name = "IncrementalParserStateCapacityError";
  }
}
export const DEFAULT_JSONL_PARSER_BUDGETS: Readonly<JsonlParserBudgets> =
  Object.freeze({
    maxFileBytes: 512 * 1024 * 1024, maxLineBytes: 8 * 1024 * 1024,
    maxNodesPerLine: 200_000, maxNestingDepth: 128,
    maxRetainedBytes: 128 * 1024 * 1024, maxWarnings: 1_000,
  });
export type ParserBudget = "file" | "line" | "node" | "depth" | "byte";
export class ParserBudgetExceededError extends Error {
  readonly line: number | undefined;
  constructor(readonly budget: ParserBudget, line?: number) {
    super(`JSONL parser ${budget} budget exceeded${line === undefined
      ? "" : ` at line ${line.toString(10)}`}.`);
    this.name = "ParserBudgetExceededError"; this.line = line;
  }
}
export interface JsonlLine { text: string; bytes: number; line: number; }

const physicalRanges = new WeakMap<JsonlLine, {
  byte_start: number;
  byte_end: number;
}>();

/** Internal parser-state metadata kept non-enumerable to preserve JsonlLine. */
export function jsonlLinePhysicalRange(line: JsonlLine): {
  byte_start: number;
  byte_end: number;
} {
  const range = physicalRanges.get(line);
  if (range === undefined) {
    throw new TypeError("JSONL line has no physical byte range.");
  }
  return { ...range };
}
export class JsonlBudgetTracker {
  readonly budgets: Readonly<JsonlParserBudgets>;
  readonly signal: AbortSignal | undefined;
  #retainedBytes = 0;
  readonly #readStops: ParserBudgetExceededError[] = [];
  #lastPhysicalLine = 0;
  constructor(controls: JsonlParserControls = {}) {
    const value = (name: keyof JsonlParserBudgets): number => {
      const result = controls.budgets?.[name] ??
        DEFAULT_JSONL_PARSER_BUDGETS[name];
      if (!Number.isSafeInteger(result) || result < 0) {
        throw new TypeError(`${name} must be a nonnegative safe integer`);
      }
      return result;
    };
    this.budgets = {
      maxFileBytes: value("maxFileBytes"), maxLineBytes: value("maxLineBytes"),
      maxNodesPerLine: value("maxNodesPerLine"),
      maxNestingDepth: value("maxNestingDepth"),
      maxRetainedBytes: value("maxRetainedBytes"),
      maxWarnings: value("maxWarnings"),
    };
    this.signal = controls.signal;
    this.throwIfAborted();
  }
  throwIfAborted(): void { this.signal?.throwIfAborted(); }
  assertLineBytes(bytes: number, line: number): void {
    if (bytes > this.budgets.maxLineBytes)
      throw new ParserBudgetExceededError("line", line);
  }
  assertNodes(value: unknown, line: number): void {
    const stack: Array<{ value: unknown; depth: number }> = [
      { value, depth: 0 },
    ];
    let count = 0;
    while (stack.length > 0) {
      if ((count & 0x3ff) === 0) this.throwIfAborted();
      const { value: current, depth } = stack.pop()!;
      if (depth > this.budgets.maxNestingDepth)
        throw new ParserBudgetExceededError("depth", line);
      if (++count > this.budgets.maxNodesPerLine) {
        throw new ParserBudgetExceededError("node", line);
      }
      if (current === null || typeof current !== "object") continue;
      const children = Array.isArray(current) ? current : Object.values(current);
      for (const child of children) stack.push({ value: child, depth: depth + 1 });
    }
  }
  retain(bytes: number, line: number): void {
    if (bytes > this.budgets.maxRetainedBytes - this.#retainedBytes)
      throw new ParserBudgetExceededError("byte", line);
    this.#retainedBytes += bytes;
  }
  recordReadStop(error: ParserBudgetExceededError): void {
    this.#readStops.push(error);
  }
  get readStop(): ParserBudgetExceededError | undefined {
    return this.#readStops[0];
  }
  get readStops(): readonly ParserBudgetExceededError[] {
    return this.#readStops;
  }
  observePhysicalLine(line: number): void {
    this.#lastPhysicalLine = Math.max(this.#lastPhysicalLine, line);
  }
  get lastPhysicalLine(): number {
    return this.#lastPhysicalLine;
  }
}
export function budgetWarningCode(error: ParserBudgetExceededError): string {
  return `parser_${error.budget}_budget_exceeded`;
}
export function boundedWarnings<T>(limit: number, overflow: () => T): T[] {
  const result: T[] = [];
  let overflowed = false;
  result.push = (...items: T[]): number => {
    for (const item of items) {
      if (overflowed || limit === 0) { overflowed = true; continue; }
      if (result.length < limit) result[result.length] = item;
      else { result[limit - 1] = overflow(); overflowed = true; }
    }
    return result.length;
  };
  return result;
}
export async function* boundedJsonlLines(
  sourcePath: string,
  tracker: JsonlBudgetTracker,
  window?: JsonlReadWindow,
): AsyncGenerator<JsonlLine, SourceReadReceipt> {
  tracker.throwIfAborted();
  const startOffset = window?.start_offset ?? 0;
  const startingLine = window?.starting_line ?? 1;
  if (!Number.isSafeInteger(startOffset) || startOffset < 0) {
    throw new TypeError("start_offset must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(startingLine) || startingLine < 1) {
    throw new TypeError("starting_line must be a positive safe integer");
  }
  const input = createReadStream(sourcePath, {
    ...(tracker.signal === undefined ? {} : { signal: tracker.signal }),
    ...(window === undefined
      ? {}
      : {
          fd: window.file_handle.fd,
          autoClose: false,
          start: startOffset,
          fs: {
            read,
            close: (_fd: number, callback: (error: Error | null) => void) =>
              callback(null),
          },
        }),
  });
  const hasher = createHash("sha256");
  let parts: Buffer[] = [];
  let partBytes = 0;
  let scannedBytes = 0;
  let receiptBytes = 0;
  let line = startingLine;
  let lineStart = startOffset;
  let truncated = false;
  let skippingLine = false;
  try {
    for await (const value of input) {
      tracker.throwIfAborted();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const admittedLength = Math.min(chunk.byteLength, Math.max(0,
        tracker.budgets.maxFileBytes - scannedBytes));
      const admitted = chunk.subarray(0, admittedLength);
      scannedBytes += admittedLength;
      let offset = 0;
      while (offset < admitted.byteLength) {
        const newline = admitted.indexOf(0x0a, offset);
        const end = newline < 0 ? admitted.byteLength : newline;
        const part = admitted.subarray(offset, end);
        const physicalEnd = startOffset + scannedBytes - admitted.byteLength +
          (newline < 0 ? admitted.byteLength : newline + 1);
        if (skippingLine) {
          if (part.byteLength > 0) hasher.update(part);
          receiptBytes = physicalEnd - startOffset;
          if (newline < 0) break;
          hasher.update(Buffer.from([0x0a]));
          tracker.observePhysicalLine(line);
          skippingLine = false;
          parts = []; partBytes = 0; line += 1; offset = newline + 1;
          lineStart = physicalEnd;
          continue;
        }
        const bufferedBytes = partBytes + part.byteLength;
        const lastByte = part.at(-1) ?? parts.at(-1)?.at(-1);
        try {
          tracker.assertLineBytes(
            bufferedBytes - (lastByte === 0x0d ? 1 : 0),
            line,
          );
        } catch (error) {
          if (!(error instanceof ParserBudgetExceededError)) throw error;
          if (window === undefined) throw error;
          tracker.recordReadStop(error);
          if (parts.length > 0) {
            hasher.update(Buffer.concat(parts, partBytes));
          }
          if (part.byteLength > 0) hasher.update(part);
          receiptBytes = physicalEnd - startOffset;
          parts = []; partBytes = 0;
          if (newline < 0) {
            skippingLine = true;
            break;
          }
          hasher.update(Buffer.from([0x0a]));
          tracker.observePhysicalLine(line);
          line += 1; offset = newline + 1; lineStart = physicalEnd;
          continue;
        }
        if (part.byteLength > 0) { parts.push(part); partBytes += part.byteLength; }
        if (newline < 0) break;
        const raw = Buffer.concat(parts, partBytes);
        const content = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
        const yielded = {
          text: content.toString("utf8"),
          bytes: content.byteLength,
          line,
        };
        hasher.update(raw);
        hasher.update(Buffer.from([0x0a]));
        receiptBytes = physicalEnd - startOffset;
        physicalRanges.set(yielded, {
          byte_start: lineStart,
          byte_end: physicalEnd,
        });
        tracker.observePhysicalLine(line);
        yield yielded;
        parts = []; partBytes = 0; line += 1; offset = newline + 1;
        lineStart = physicalEnd;
      }
      if (admittedLength < chunk.byteLength) {
        truncated = true;
        if (window === undefined) {
          throw new ParserBudgetExceededError("file", line);
        }
        tracker.recordReadStop(new ParserBudgetExceededError("file", line));
        if (!skippingLine && partBytes > 0) {
          hasher.update(Buffer.concat(parts, partBytes));
        }
        receiptBytes = scannedBytes;
        break;
      }
    }
    if (!truncated && skippingLine) {
      tracker.observePhysicalLine(line);
    } else if (!truncated && partBytes > 0) {
      const raw = Buffer.concat(parts, partBytes);
      try {
        tracker.assertLineBytes(raw.byteLength, line);
      } catch (error) {
        if (!(error instanceof ParserBudgetExceededError)) throw error;
        if (window === undefined) throw error;
        tracker.recordReadStop(error);
        hasher.update(raw);
        receiptBytes = scannedBytes;
        tracker.observePhysicalLine(line);
        return {
          start_offset: startOffset,
          end_offset: startOffset + receiptBytes,
          bytes_read: receiptBytes,
          digest: `sha256:${hasher.digest("hex")}`,
        };
      }
      const yielded = {
        text: raw.toString("utf8"),
        bytes: raw.byteLength,
        line,
      };
      physicalRanges.set(yielded, {
        byte_start: lineStart,
        byte_end: startOffset + scannedBytes,
      });
      tracker.observePhysicalLine(line);
      hasher.update(raw);
      receiptBytes = scannedBytes;
      yield yielded;
    }
    return {
      start_offset: startOffset,
      end_offset: startOffset + receiptBytes,
      bytes_read: receiptBytes,
      digest: `sha256:${hasher.digest("hex")}`,
    };
  } catch (error) {
    if (tracker.signal?.aborted === true) tracker.throwIfAborted();
    throw error;
  } finally {
    if (window === undefined) input.destroy();
  }
}
