import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";

export type LegacyJsonRead =
  | { kind: "missing" }
  | { kind: "corrupt"; message: string }
  | { kind: "value"; value: unknown };

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error &&
    typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readLegacyJson(path: string): LegacyJsonRead {
  let before;
  try { before = lstatSync(path); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    return { kind: "corrupt", message: "not a regular file" };
  }
  const descriptor = openSync(path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("legacy JSON file changed while opening");
    }
    if (!opened.isFile()) return { kind: "corrupt", message: "not a regular file" };
    const text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error("legacy JSON file changed while reading");
    }
    try { return { kind: "value", value: JSON.parse(text) as unknown }; }
    catch (error) { return { kind: "corrupt", message: errorMessage(error) }; }
  } finally {
    closeSync(descriptor);
  }
}
