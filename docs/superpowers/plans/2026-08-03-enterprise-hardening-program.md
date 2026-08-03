# ccprof Enterprise Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Deliver an enterprise-ready ccprof audit platform with auditable identities and evidence, explicit source capabilities, privacy-preserving statistics, governed storage, versioned reports, and proven operational behavior while retaining existing user workflows and Store v2 readability.

## Architecture

The ingestion boundary canonicalizes every input into a source descriptor and an EventIdentity composed exactly of `source_adapter_id`, `source_instance_id`, `session_id`, `agent_id`, optional `tool_use_id`, and `source_index`. Source descriptors declare `adapter_id`, `adapter_version`, and required capabilities; unknown or undeclared adapters fail closed. Capabilities are evaluated per session lane/evidence group and report eligible/total sessions, partial/full status, and completeness/truncation rather than dropping eligible evidence. Rule Manifest entries define rule contracts, including split R004 and scoped R005. Findings use `ImpactEstimate { lower_ms, expected_ms?, upper_ms, kind }` and `FindingConfidence { evidence, causal, source_completeness }`; only high-confidence lower bounds reduce `estimated_floor`, with interval accounting and evidence under existing ledger semantics. Report v3 serializes the required producer/analysis/work-unit/window/source/policy/result contract through published JSON Schemas and supports N-2 readers. The Store keeps descriptors, budgets, catalogs, and indexed history summaries under workspace/repository policy controls. Operators use doctor, store, and export tools; CI and quality suites validate behavior, safety, and performance.

## Tech Stack

- Existing ccprof language, CLI framework, persistence layer, and test runner.
- Versioned JSON Schema for Report v3 and export contracts.
- Existing Store v2 migration mechanism, extended with idempotent transactional migrations.
- Existing CI provider plus language-native unit, property, fuzz, fault-injection, and benchmark tooling.

## PR Wave 1 — Identity, source contracts, and manifest foundation

- [ ] Add deterministic `EventIdentity` generation and canonical-event tests.
  - Acceptance criteria: identity contains exactly `source_adapter_id`, `source_instance_id`, `session_id`, `agent_id`, optional `tool_use_id`, and `source_index`; identical canonical events produce identical IDs; IDs contain no raw transcript or secrets; all new event persistence paths store the identity.
- [ ] Add a source descriptor contract with `adapter_id`, `adapter_version`, required capabilities, source kind, provenance, sensitivity, retention class, and canonical fingerprint.
  - Acceptance criteria: supported sources produce descriptors; unknown or undeclared adapters fail closed; unknown fields do not bypass validation; descriptors are available to reports and existing ledger semantics.
- [ ] Add a capability model and coverage result for every attempted rule.
  - Acceptance criteria: capabilities are evaluated per session lane/evidence group; only ineligible evidence is filtered; rules declare required capabilities; coverage reports `eligible_sessions`, `total_sessions`, `status` (`partial` or `full`), completeness, and truncation; CLI output and machine reports expose coverage.
- [ ] Introduce the Rule Manifest and register existing rules plus R004 and R005.
  - Acceptance criteria: each manifest entry declares `id`, `version`, `compatibility_epoch`, `required_capabilities`, `supported_sources`, `impact_kind`, `default_mode`, `aggregation_policy`, `evidence_schema`, and `policy_risk`; duplicate IDs fail validation; R004 is split into `approval_policy_latency` and observe-only `repeated_safe_approval_latency` with a policy-gated allowlist; R005 distinguishes `resource_domain`/`parallel-safe` from investigation candidates.
- [ ] Add unified privacy projection, strict stats, and terminal PR snapshot aggregation.
  - Acceptance criteria: one projection is applied by analyze, stats, explain, diagnose, export, warnings, errors, and advisory input; `stats --privacy strict --json` applies it; CI and collection strict mode cannot be weakened; snapshots are keyed by distinct repository, PR, and terminal snapshot; unioned intervals are deduplicated; snapshots separately report `confirmed_critical_path_ms`, `estimated_critical_path_upper_ms`, `resource_cost_ms`, `human_wait_ms`, and `unexplained_ms`; comparable baseline and R006 cohorts require the same repository/workspace, similar changed-file count and diff size, the same command identity, and observable cache state; qualifying cohorts report median, p50, p75, MAD, and sample count, while cohorts below the configured threshold are suppressed.
- [ ] Add advisory execution safeguards for stdin, minimal environment, input/output caps, and process-group kill.
  - Acceptance criteria: safeguards are advisory and observable; stdin behavior, environment minimization, caps, and group termination produce actionable diagnostics without altering unrelated execution semantics.
- [ ] Add additive Store migrations for source descriptors, event identities, rule catalog metadata, and migration tracking.
  - Acceptance criteria: migrations are idempotent and transactional; a populated Store v2 opens without data loss; migration state is inspectable.

## PR Wave 2 — Findings, confidence, and ledger evidence

- [ ] Extend finding contracts with `ImpactEstimate { lower_ms, expected_ms?, upper_ms, kind }`, `FindingConfidence { evidence, causal, source_completeness }`, scoring rationale, stable severity mapping, and a high-confidence lower-bound floor.
  - Acceptance criteria: each exact field, range, and nullability is schema-validated; only high-confidence lower bounds reduce `estimated_floor`; legacy findings receive compatible defaults; CLI rendering remains readable.
- [ ] Add interval accounting and evidence integration using existing ledger semantics.
  - Acceptance criteria: each finding links its EventIdentity, source evidence, rule/version, interval, and explanation through existing ledger semantics; no new immutable rule-decision ledger, audit-log subsystem, or ledger table is introduced.
- [ ] Add capability-coverage and evidence-integrity tests.
  - Acceptance criteria: missing capability, malformed manifest, changed rule version, interval mismatch, and mismatched source evidence cases are deterministically detected and surfaced.

## PR Wave 3 — Report v3, budgets, catalog, history, and exports

- [ ] Define Report v3 JSON Schemas and implement validated v3 writer/reader contracts.
  - Acceptance criteria: `producer`, `analysis`, `work_unit`, `window`, `sources`, `policy`, `summary`, `findings`, and `diagnostics` validate; reports return all findings or explicit pagination; invalid documents return actionable errors.
- [ ] Implement N-2 report readers and compatibility fixtures.
  - Acceptance criteria: current, N-1, and N-2 report fixtures load into a common internal model; documents older than N-2 fail with documented remediation; writers emit only v3.
- [ ] Add Store tables and APIs for run budgets, catalog entries, and indexed history queries.
  - Acceptance criteria: run input/compute budgets are recorded and enforce limits; catalog queries list installed rules/schemas/source kinds; bounded history queries return summaries without transcript replay.
- [ ] Add policy-checked, schema-versioned export commands.
  - Acceptance criteria: exports include provenance and schema version; unauthorized or over-retention exports are refused; protected content is redacted according to policy.

## PR Wave 4 — Privacy, governance controls, and operator tooling

- [ ] Implement terminal aggregation and cohort suppression for statistics.
  - Acceptance criteria: detailed payloads are not persisted in aggregate tables; cohorts below the configured threshold are suppressed; emitted statistics carry cohort and privacy metadata.
- [ ] Add signed organization policy configuration for privacy, advisory, raw data, retention, quotas, encryption, deletion, and export authorization.
  - Acceptance criteria: schema includes `minimum_privacy`, `allow_raw`, `allow_advisory`, `allow_export`, `raw_retention_days_max`, and `required_source_coverage`; precedence is organization constraints over repository policy over CLI settings and lower layers can only tighten; an administrative advisory kill switch overrides lower layers; deny-by-default behavior; `raw_evidence_retention_days` and `aggregate_retention_days` are distinct; quota includes `max_bytes`; storage mode is `os_keychain`, `enterprise_key`, or `none` with platform key providers; quota violations stop safely with an audit record.
- [ ] Add logical repository and workspace scoping.
  - Acceptance criteria: records are scoped to logical workspace/repository IDs; policy inheritance is deterministic; cross-workspace queries require authorization and create ledger evidence.
- [ ] Deliver doctor and store operational commands.
  - Acceptance criteria: doctor reports migration, capability, budget, policy, encryption, and store-health status; store inspect/migrate/compact/verify commands are documented and fail safely.

## PR Wave 5 — Delivery assurance and support

- [ ] Expand CI into a platform and compatibility matrix.
  - Acceptance criteria: supported runtime/OS matrix runs unit and integration coverage; report N-2 fixtures, Store v2 migration, manifest validation, and export policy checks are mandatory gates.
- [ ] Add calibration, property, fuzz, fault-injection, and performance suites.
  - Acceptance criteria: calibration fixtures define expected rule outcomes and confidence bands; property/fuzz tests cover parsers and schemas; fault tests cover interrupted migration and ledger/store failures; performance budgets cover ingestion, query, report generation, and aggregation.
- [ ] Publish support and governance documentation.
  - Acceptance criteria: operator runbook covers doctor/store/export recovery; user documentation explains capability coverage, report compatibility, privacy behavior, retention, and migrations; release checklist names policy, legal/privacy, security/key-management, incident-response, accessibility, and change-management owners.

## Program-wide acceptance criteria

- [ ] Existing CLI workflows and Store v2 data remain usable through every released wave.
- [ ] No raw transcript content or secret is added to EventIdentity, ledger identifiers, or statistics tables.
- [ ] Every rule outcome is explainable through manifest, coverage, scores, and ledger evidence.
- [ ] All Report v3 and export contracts have published schemas and compatibility fixtures.
- [ ] Policy denials, quota failures, migration failures, and integrity failures end safely with actionable diagnostics.
