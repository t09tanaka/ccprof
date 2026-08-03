import { createReadStream } from "node:fs";
export interface JsonlParserBudgets {
  maxFileBytes: number; maxLineBytes: number; maxNodesPerLine: number;
  maxNestingDepth: number; maxRetainedBytes: number; maxWarnings: number;
}
export interface JsonlParserControls {
  budgets?: Partial<JsonlParserBudgets>; signal?: AbortSignal;
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
export class JsonlBudgetTracker {
  readonly budgets: Readonly<JsonlParserBudgets>;
  readonly signal: AbortSignal | undefined;
  #retainedBytes = 0;
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
  sourcePath: string, tracker: JsonlBudgetTracker,
): AsyncGenerator<JsonlLine> {
  tracker.throwIfAborted();
  const input = createReadStream(sourcePath, tracker.signal === undefined
    ? {} : { signal: tracker.signal });
  let parts: Buffer[] = [], partBytes = 0, fileBytes = 0, line = 1;
  try {
    for await (const value of input) {
      tracker.throwIfAborted();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const admittedLength = Math.min(chunk.byteLength, Math.max(0,
        tracker.budgets.maxFileBytes - fileBytes));
      const admitted = chunk.subarray(0, admittedLength);
      fileBytes += admittedLength;
      let offset = 0;
      while (offset < admitted.byteLength) {
        const newline = admitted.indexOf(0x0a, offset);
        const end = newline < 0 ? admitted.byteLength : newline;
        const part = admitted.subarray(offset, end);
        const bufferedBytes = partBytes + part.byteLength;
        const lastByte = part.at(-1) ?? parts.at(-1)?.at(-1);
        tracker.assertLineBytes(bufferedBytes - (lastByte === 0x0d ? 1 : 0), line);
        if (part.byteLength > 0) { parts.push(part); partBytes += part.byteLength; }
        if (newline < 0) break;
        const raw = Buffer.concat(parts, partBytes);
        const content = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
        yield { text: content.toString("utf8"), bytes: content.byteLength, line };
        parts = []; partBytes = 0; line += 1; offset = newline + 1;
      }
      if (admittedLength < chunk.byteLength) {
        throw new ParserBudgetExceededError("file", line);
      }
    }
    if (partBytes > 0) {
      const raw = Buffer.concat(parts, partBytes);
      const content = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
      yield { text: content.toString("utf8"), bytes: content.byteLength, line };
    }
  } catch (error) {
    if (tracker.signal?.aborted === true) tracker.throwIfAborted();
    throw error;
  } finally { input.destroy(); }
}
