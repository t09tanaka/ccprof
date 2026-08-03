# ccprof Enterprise Hardening Program Design

## Purpose

This program evolves ccprof from a useful local audit into a repeatable, privacy-aware audit system suitable for enterprise review. It preserves the existing command-line workflow while introducing explicit identities, declared capabilities, versioned evidence, and operational controls.

## Scope and exclusions

The program addresses the remaining audit hardening work. The following are already fixed and are not redesigned or scheduled here: transcript budget handling, Store v2 basics, v0.3 release consistency, and SBOM/provenance attestation/supply-chain verification. Existing users and stored audit data remain supported through additive schemas, readers, and migration tooling.

## Architecture

Each audited event has a stable `EventIdentity` containing exactly `source_adapter_id`, `source_instance_id`, `session_id`, `agent_id`, optional `tool_use_id`, and `source_index`. Ingestion normalizes raw inputs into source descriptors and event records. A SourceDescriptor declares `adapter_id`, `adapter_version`, and required capabilities; unknown or undeclared adapters fail closed. Capabilities are evaluated per session lane/evidence group, filtering only ineligible evidence rather than discarding an entire source. Coverage reports `eligible_sessions`, `total_sessions`, `status` (`partial` or `full`), and completeness/truncation metadata. Findings use `ImpactEstimate { lower_ms, expected_ms?, upper_ms, kind }` and `FindingConfidence { evidence, causal, source_completeness }`; only high-confidence lower bounds reduce `estimated_floor`. Findings retain interval accounting and evidence using existing ledger semantics; this program does not introduce a new immutable rule-decision ledger or audit-log subsystem.

Rules are declared in a Rule Manifest. The manifest is the source of truth for `id`, `version`, `compatibility_epoch`, `required_capabilities`, `supported_sources`, `impact_kind`, `default_mode`, `aggregation_policy`, `evidence_schema`, and `policy_risk`. R004 is split into `approval_policy_latency` and `repeated_safe_approval_latency`; the latter is observe-only unless a policy-gated allowlist permits it. R005 distinguishes `resource_domain`/`parallel-safe` evidence from an investigation candidate. A coverage report makes unavailable rules and unmet capabilities visible instead of silently omitting analysis.

Report v3 is a versioned, schema-validated report envelope with exact `producer`, `analysis`, `work_unit`, `window`, `sources`, `policy`, `summary`, `findings`, and `diagnostics` sections. It emits all findings or uses explicit pagination. Readers support the current report and the two preceding report versions (N-2); writers emit only v3 after migration is complete. Published JSON Schemas are used by the CLI, exports, and CI fixtures.

The Store is extended with source descriptor, run budget, catalog, and history-query tables. Source descriptors preserve provenance and retention classification. Run budgets record input and compute limits as audit evidence. The catalog indexes rules, report schemas, source kinds, and exports. History-query tables provide bounded, indexed summaries without requiring transcript replay; no new rule-decision ledger table is added.

Statistics are privacy-first. A stats privacy projection removes disallowed fields before terminal aggregation keyed by the distinct repository, PR, and terminal snapshot. Interval unions are deduplicated before metrics are calculated. Snapshots separately report `confirmed_critical_path_ms`, `estimated_critical_path_upper_ms`, `resource_cost_ms`, `human_wait_ms`, and `unexplained_ms`. Cohorts must meet a minimum threshold before aggregate output is emitted; smaller cohorts are suppressed. Baselines include median, p50, p75, MAD, and sample count. Stats use bounded dimensions, redacted identifiers, and explicit privacy metadata. Raw content is never introduced into aggregate tables.

Policy controls define retention periods, deletion behavior, quotas, encryption-at-rest requirements, key ownership boundaries, and export authorization. Logical repositories and workspaces separate tenancy and enable policy inheritance without forcing a physical repository layout change. The doctor command verifies configuration, migrations, capabilities, encryption configuration, budget enforcement, and store health. Store tools provide inspect, migrate, compact, and verify operations; exports are schema-versioned and policy-checked.

## Dependency waves

1. Establish shared contracts: exact EventIdentity, source descriptors, capability model, manifest model, stats privacy projection, and advisory stdin/minimal-environment/input-output-cap/process-group-kill controls.
2. Add rules and evidence: capability coverage, split/gated R004, scoped R005, impact/confidence scoring, and interval accounting using existing ledger semantics.
3. Deliver durable outputs: Report v3 schemas, N-2 readers, catalog/history tables, source/run budgets, and safe export.
4. Add governance and operations: policies, retention, quotas, encryption, logical repo/workspace handling, and doctor/store tools.
5. Prove behavior: CI matrix, calibration fixtures, property/fuzz/fault/performance suites, and operator/support documentation.

Each wave is additive and deployable behind compatible readers. A later wave must not require deletion or reinterpretation of evidence emitted by an earlier compatible release.

## Compatibility, migration, and privacy rules

- Public CLI commands and existing Store v2 data remain readable throughout the program.
- Migrations are ordered, idempotent, transactionally applied, and recorded in the catalog. Downgrades are not promised; backups and verification are required before destructive maintenance operations.
- New fields are optional to older readers where possible. Report readers accept N, N-1, and N-2 schema versions and reject older documents with a clear upgrade path.
- EventIdentity is deterministic from exactly `source_adapter_id`, `source_instance_id`, `session_id`, `agent_id`, optional `tool_use_id`, and `source_index`, and includes no secret or raw transcript content.
- Source descriptors, ledgers, reports, telemetry, and exports carry retention and sensitivity labels.
- Privacy defaults are deny-by-default for detailed exports, cohort suppression for statistics, bounded retention, and encryption for protected store classes.
- Workspace and repository identifiers are logical scoped identifiers; cross-workspace querying requires explicit authorization and is logged.

## External governance items

Enterprise adoption also requires governance outside the implementation: a named policy owner, data classification and retention approvals, encryption/key-management approval, legal/privacy review of exports and telemetry, incident response and support ownership, accessibility and documentation review, release/change-management approval, and a customer-facing compatibility/deprecation policy. These are tracked as release gates rather than encoded as hidden runtime behavior.
