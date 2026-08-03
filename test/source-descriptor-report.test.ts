import assert from "node:assert/strict";
import test from "node:test";

import type { ReportV2, Session } from "../src/core/model.js";
import {
  sourceDescriptorsForSessions,
  type SourceDescriptor,
} from "../src/core/source-descriptor.js";
import { renderJsonReport } from "../src/reporters/json.js";
import { renderMarkdownReport } from "../src/reporters/markdown.js";
import { projectReportPrivacy } from "../src/reporters/privacy.js";
import { renderTtyReport } from "../src/reporters/tty.js";

function session(
  source: Session["source"],
  sourcePath: string,
): Session {
  return {
    session_id: `${source}-session`,
    source,
    source_path: sourcePath,
    observed_cwds: ["/repo"],
    observed_branches: ["main"],
    started_at_ms: 1,
    ended_at_ms: 2,
    confidence: "high",
    events: [],
    warnings: [],
    ...(source === "codex"
      ? { capabilities: ["tool_timestamps", "edit_fragments"] }
      : {}),
  };
}

function report(sources?: SourceDescriptor[]): ReportV2 {
  return {
    version: 2,
    unit: { repo: "/repo", pr_ref: "main...feature", sessions: ["s1"] },
    ...(sources === undefined ? {} : { sources }),
    summary: {
      measured_min: 1,
      idle_excluded_min: 0,
      estimated_floor_min: 1,
      recoverable_min: 0,
      human_wait_min: 0,
      unexplained_min: 0,
      baseline: null,
    },
    findings: [],
    caveats: [],
  };
}

function descriptors(): SourceDescriptor[] {
  return sourceDescriptorsForSessions([
    session("codex", "/private/CODEX_PATH_CANARY.jsonl"),
    session("claude", "/private/CLAUDE_PATH_CANARY.jsonl"),
  ]);
}

test("JSON carries deterministic sources between unit and summary", () => {
  const expected = descriptors();
  const output = renderJsonReport(report(expected));
  const parsed = JSON.parse(output) as ReportV2;

  assert.deepEqual(parsed.sources, expected);
  assert.deepEqual(parsed.sources?.map((source) => source.adapter_id), [
    "claude",
    "codex",
  ]);
  assert.ok(output.indexOf('"unit"') < output.indexOf('"sources"'));
  assert.ok(output.indexOf('"sources"') < output.indexOf('"summary"'));
  assert.doesNotMatch(output, /CLAUDE_PATH_CANARY|CODEX_PATH_CANARY/u);
});

test("TTY and Markdown render a compact deterministic source summary", () => {
  const current = report(descriptors());
  const tty = renderTtyReport(current, { color: false });
  const markdown = renderMarkdownReport(current);

  assert.match(tty, /^Sources: claude@1\.0\.0 \(1\), codex@1\.0\.0 \(1\)\.$/mu);
  assert.match(
    markdown,
    /^\*\*Sources:\*\* claude@1\.0\.0 \(1\), codex@1\.0\.0 \(1\)\.$/mu,
  );
  assert.doesNotMatch(tty, /source-[a-f0-9]+|sha256:/u);
  assert.doesNotMatch(markdown, /source-[a-f0-9]+|sha256:/u);
});

test("strict and balanced privacy preserve only opaque descriptors without mutation", () => {
  const raw = report(descriptors());
  const before = JSON.stringify(raw);

  for (const profile of ["strict", "balanced"] as const) {
    const projected = projectReportPrivacy(raw, profile);
    assert.deepEqual(projected.sources, raw.sources);
    assert.notEqual(projected.sources, raw.sources);
    assert.notEqual(projected.sources?.[0], raw.sources?.[0]);
    assert.doesNotMatch(
      JSON.stringify(projected.sources),
      /CLAUDE_PATH_CANARY|CODEX_PATH_CANARY|\/private\//u,
    );
  }
  assert.equal(projectReportPrivacy(raw, "raw"), raw);
  assert.equal(JSON.stringify(raw), before);
});

test("legacy v2 reports without sources remain readable and byte-compatible", () => {
  const legacy = report();
  const expectedJson = `${JSON.stringify(legacy, null, 2)}\n`;

  assert.equal(renderJsonReport(legacy), expectedJson);
  assert.doesNotMatch(renderTtyReport(legacy, { color: false }), /Sources:/u);
  assert.doesNotMatch(renderMarkdownReport(legacy), /Sources:/u);
  const projected = projectReportPrivacy(legacy, "balanced");
  assert.equal(projected.sources, undefined);
  assert.ok(!Object.hasOwn(projected, "sources"));
});
