# ccprof Enterprise Hardening Program Design

## Purpose

This program evolves ccprof from a useful local audit into a repeatable, privacy-aware audit system suitable for enterprise review. It preserves the existing command-line workflow while introducing explicit identities, declared capabilities, versioned evidence, and operational controls.

## Scope and exclusions

The program addresses the remaining audit hardening work. The following are already fixed and are not redesigned here: transcript budget handling, Store v2 basics, v0.3 release consistency, and SBOM/provenance attestation. Existing users and stored audit data remain supported through additive schemas, readers, and migration tooling.

## Architecture

Each audited run has a stable `EventIdentity` containing a run identifier, source identity, event sequence, timestamp, and content fingerprint. Ingestion normalizes raw inputs into source descriptors and event records; rules consume a declared capability set rather than relying on ambient source fields. Findings carry impact and confidence scores and append evidence to an immutable ledger. The ledger records rule version, input fingerprint, decision, explanation, and report linkage.

Rules are declared in a Rule Manifest. The manifest is the source of truth for identifiers, required capabilities, severity defaults, stable schema versions, deprecation status, and test fixtures. R004 and R005 are introduced through that manifest and are gated on the capabilities they genuinely need. A coverage report makes unavailable rules and unmet capabilities visible instead of silently omitting analysis.

Report v3 is a versioned, schema-validated report envelope. It contains audit metadata, capability coverage, findings, ledger references, aggregation metadata, and compatibility markers. Readers support the current report and the two preceding report versions (N-2); writers emit only v3 after migration is complete. Published JSON Schemas are used by the CLI, exports, and CI fixtures.

The Store is extended with source descriptor, run budget, catalog, and history-query tables. Source descriptors preserve provenance and retention classification. Run budgets record input and compute limits as audit evidence. The catalog indexes rules, report schemas, source kinds, and exports. History-query tables provide bounded, indexed summaries without requiring transcript replay.

Statistics are privacy-first. Terminal aggregation occurs before persistence where detailed payloads are not required. Cohorts must meet a minimum threshold before aggregate output is emitted; smaller cohorts are suppressed. Stats use bounded dimensions, redacted identifiers, and explicit privacy metadata. Raw content is never introduced into aggregate tables.

Policy controls define retention periods, deletion behavior, quotas, encryption-at-rest requirements, key ownership boundaries, and export authorization. Logical repositories and workspaces separate tenancy and enable policy inheritance without forcing a physical repository layout change. The doctor command verifies configuration, migrations, capabilities, encryption configuration, budget enforcement, and store health. Store tools provide inspect, migrate, compact, and verify operations; exports are schema-versioned and policy-checked.

## Dependency waves

1. Establish shared contracts: EventIdentity, source descriptors, capability model, manifest model, and migration framework.
2. Add rules and evidence: capability coverage, R004/R005, impact/confidence scoring, and ledger persistence.
3. Deliver durable outputs: Report v3 schemas, N-2 readers, catalog/history tables, source/run budgets, and safe export.
4. Add governance and operations: policies, retention, quotas, encryption, logical repo/workspace handling, and doctor/store tools.
5. Prove behavior: CI matrix, calibration fixtures, property/fuzz/fault/performance suites, and operator/support documentation.

Each wave is additive and deployable behind compatible readers. A later wave must not require deletion or reinterpretation of evidence emitted by an earlier compatible release.

## Compatibility, migration, and privacy rules

- Public CLI commands and existing Store v2 data remain readable throughout the program.
- Migrations are ordered, idempotent, transactionally applied, and recorded in the catalog. Downgrades are not promised; backups and verification are required before destructive maintenance operations.
- New fields are optional to older readers where possible. Report readers accept N, N-1, and N-2 schema versions and reject older documents with a clear upgrade path.
- EventIdentity is deterministic for the same canonical event and includes no secret or raw transcript content.
- Source descriptors, ledgers, reports, telemetry, and exports carry retention and sensitivity labels.
- Privacy defaults are deny-by-default for detailed exports, cohort suppression for statistics, bounded retention, and encryption for protected store classes.
- Workspace and repository identifiers are logical scoped identifiers; cross-workspace querying requires explicit authorization and is logged.

## External governance items

Enterprise adoption also requires governance outside the implementation: a named policy owner, data classification and retention approvals, encryption/key-management approval, legal/privacy review of exports and telemetry, incident response and support ownership, accessibility and documentation review, release/change-management approval, and a customer-facing compatibility/deprecation policy. These are tracked as release gates rather than encoded as hidden runtime behavior.
