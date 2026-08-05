# Instruction Resource Identity Foundation Design

## Context

The current runtime and wire contracts use the legacy vendor-specific finding scope
`claude_md` and adoption method `claude_md_edit`. The audit recommends a neutral
`instruction_resource` identity, but replacing the existing shared contracts in one
change would alter runtime, Store, fingerprint, and Report v2 bytes.

This change therefore establishes an additive identity foundation only. It creates
new, currently unused modules for canonical identities and an explicit compatibility
boundary. Existing modules, signatures, schemas, imports, serialized records, and
detectors remain unchanged.

Base: `origin/main@e247c3f89ca3d6dd3b113386a73f41ffc04992b9`.

## Goals

- Define canonical finding scopes `this_pr`, `separate_issue`, and
  `instruction_resource`.
- Define canonical adoption methods `target_file_edit` and
  `instruction_resource_edit`.
- Keep `claude_md` and `claude_md_edit` as explicit legacy wire identities in the
  compatibility layer, never as neutral core names.
- Provide exact, deterministic normalization from legacy to canonical identities and
  projection from canonical identities to legacy identities.
- Reject malformed or hostile inputs without evaluating user-controlled object code
  and without including input content in errors.
- Describe only the current fixed `CLAUDE.md` resource and detector behavior through
  an explicitly named immutable compatibility descriptor.
- Preserve every current runtime and serialized byte by leaving the new modules
  unimported by existing production code.

## Non-goals

- No edit to the existing `Scope`, `AdoptionMethod`, or any other shared type,
  interface, or function signature.
- No runtime integration, Store normalization, Report projection, schema change,
  migration, backfill, export-map change, or package entry point.
- No support claim for `AGENTS.md`, arbitrary paths, adapter discovery, resource
  precedence, or multiple instruction resources.
- No generalized resource registry or detector abstraction.

## Considered approaches

### 1. Additive neutral modules plus an explicit compatibility boundary — selected

Three focused modules separate canonical finding scope, canonical adoption method,
and legacy `CLAUDE.md` compatibility. This is deletion-safe, has no current consumers,
and gives later migration PRs one vocabulary without changing bytes now.

### 2. Replace existing shared unions immediately — rejected

Changing `src/core/model.ts` or `src/store/adoptions.ts` would affect rule producers,
finding fingerprints, strict Store readers, Report v2, privacy hashing, and existing
tests. That is a later compatibility migration, not an additive foundation.

### 3. Introduce a general instruction-resource registry — rejected

A registry would require resource IDs, adapter discovery, path privacy, precedence,
and mixed-source semantics. None is needed to establish identity compatibility, and
the active session-contract PR owns adjacent source-contract files.

## Module design

### `src/core/finding-scope.ts`

Exports a frozen `CANONICAL_FINDING_SCOPES` object, the derived `FindingScope` type,
a content-free `FindingScopeValidationError`, and `parseFindingScope(value: unknown)`.
The parser accepts only the three exact canonical primitive strings.

### `src/analysis/adoption-identity.ts`

Exports a frozen `CANONICAL_ADOPTION_METHODS` object, the derived `AdoptionMethod`
type, a content-free `AdoptionMethodValidationError`, and
`parseAdoptionMethod(value: unknown)`. The parser accepts only the two exact
canonical primitive strings.

### `src/compat/instruction-resource.ts`

Exports frozen legacy vocabulary constants and types:

- `LegacyFindingScope`: `this_pr | separate_issue | claude_md`
- `LegacyAdoptionMethod`: `target_file_edit | claude_md_edit`

It also exports four boundary functions:

- `normalizeFindingScopeIdentity(unknown)` maps `claude_md` to
  `instruction_resource` and otherwise validates canonical scope.
- `projectLegacyFindingScope(unknown)` validates canonical scope, maps
  `instruction_resource` to `claude_md`, and leaves the other scopes unchanged.
- `normalizeAdoptionMethodIdentity(unknown)` maps `claude_md_edit` to
  `instruction_resource_edit` and otherwise validates canonical method.
- `projectLegacyAdoptionMethod(unknown)` validates canonical method, maps
  `instruction_resource_edit` to `claude_md_edit`, and leaves
  `target_file_edit` unchanged.

The module alone exposes `CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY`. Its deeply
frozen fields state only current facts: the fixed path and evidence path are
`CLAUDE.md`; the legacy/canonical identities are the mappings above; the detector
matches suggestion keywords in added Git-history text after `recorded_at_ms` and
chooses the oldest qualifying commit. The descriptor does not accept configuration
and does not imply other resources.

## Input safety and errors

All public identity functions take `unknown` and inspect only primitive string
identity. A `typeof value !== "string"` guard rejects objects before property,
prototype, key, or coercion access. This rejects accessors, ordinary proxies, hostile
proxies, and revoked proxies without invoking their traps or getters.

Accepted values are exact. Case variants, leading/trailing whitespace, embedded NUL,
unknown strings, symbols, boxed strings, arrays, functions, and all other non-string
values fail closed. Errors have fixed name, code, and message and never interpolate
the rejected value.

## Immutability and determinism

Exported object constants are frozen. The compatibility descriptor is deeply frozen.
Normalization and projection return primitive string literals and have no mutation,
I/O, locale, time, randomness, or environment dependency.

## Testing

One focused test file verifies:

- exact canonical and legacy constants;
- every required mapping and both round-trip directions;
- unchanged `this_pr`, `separate_issue`, and `target_file_edit` tokens;
- rejection of unknowns, case variants, whitespace, NUL, non-strings, accessors,
  proxies, and revoked proxies with stable content-free errors;
- zero getter/trap execution for hostile objects;
- frozen constants and deeply frozen compatibility descriptor;
- mutation attempts cannot alter later results;
- the descriptor contains only the current fixed `CLAUDE.md` facts.

The PR-level proof of no runtime/serialization change is structural: all production
changes are new modules, and no existing production module imports them.

## Risks and controls

- A caller might pass a legacy token to a projector. Projectors validate canonical
  inputs first and fail closed rather than silently accepting the wrong boundary.
- A broad object validator could execute hostile traps. Public APIs accept primitive
  values only and reject objects before inspection.
- A descriptor could accidentally imply general resource support. Its name and literal
  fields are `CLAUDE.md`-specific and contain no configurable path or resource list.
- Later migration work might accidentally change current bytes. That work is excluded
  from this PR; this foundation remains unused until an explicit compatibility PR.
