import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPORT_V3_SCHEMA = "report-v3.schema.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const manifest: unknown = JSON.parse(
        readFileSync(resolve(directory, "package.json"), "utf8"),
      );
      if (isRecord(manifest) && manifest.name === "ccprof") return directory;
    } catch {
      // Keep walking: compiled layouts place this module below the package root.
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("ccprof package root was not found");
    }
    directory = parent;
  }
}

function readPackagedReportV3Schema(): string {
  return readFileSync(
    resolve(packageRoot(), "schemas", REPORT_V3_SCHEMA),
    "utf8",
  );
}

export function runSchemaCommand(
  readSchema: () => string = readPackagedReportV3Schema,
): string {
  try {
    const schema: unknown = JSON.parse(readSchema());
    const properties = isRecord(schema) ? schema.properties : undefined;
    const schemaVersion = isRecord(properties)
      ? properties.schema_version
      : undefined;
    if (!isRecord(schemaVersion) || schemaVersion.const !== 3) {
      throw new TypeError();
    }
    return `${JSON.stringify(schema, null, 2)}\n`;
  } catch {
    throw new Error("published Report v3 schema is unavailable");
  }
}
