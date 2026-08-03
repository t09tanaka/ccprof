# Versioned Repository Config Design

## Scope

This change introduces the first repository-owned ccprof configuration contract.
It intentionally covers only `.ccprof/config.json`, strict schema validation,
test-map precedence, packaging the JSON Schema, and snapshot digest attribution.
Workspace-scoped mappings and ecosystem adapters are separate follow-up PRs because
the current mapping model has no command CWD scope; discovering nested manifests
without that foundation could mix identical commands from different workspaces.

Package version `0.2.0`, report schema v2, and Store schema v2 remain unchanged.

## Contract

The optional `.ccprof/config.json` has this v1 shape:

```json
{
  "$schema": "https://raw.githubusercontent.com/t09tanaka/ccprof/main/schemas/config.schema.json",
  "schema_version": 1,
  "test_map": {
    "mappings": [
      {
        "source": ["src/**"],
        "tests": ["test/**"],
        "commands": ["npm test"]
      }
    ]
  }
}
```

`$schema` and `test_map` are optional; `schema_version` is required and must be
exactly `1`. Every object is closed: unknown top-level, test-map, or mapping keys
fail validation. Arrays must be non-empty where present. Existing repository-path,
glob, traversal, and command normalization checks are reused rather than duplicated.

The runtime reads only the fixed repository-relative path
`.ccprof/config.json`. A missing file preserves existing behavior. A symlink,
non-regular file, unreadable file, malformed JSON, unsupported version, unknown
key, or invalid mapping fails closed with a `RepositoryConfigError` that identifies
the repository-relative config path without exposing arbitrary file contents.

## Resolution and determinism

All available maps remain available as fallbacks, but selection for a matching
command follows this order:

1. injected or CLI `--test-map` mappings (`explicit`),
2. `.ccprof/config.json` mappings (`config`),
3. root manifest conventions (`manifest`),
4. the existing conservative fallback.

This preserves the current behavior where an explicit map can refine one command
without disabling manifest inference for unrelated commands. Repository config is
loaded and validated even when a CLI map is supplied, so a checked-in invalid
contract cannot be silently bypassed.

Mapping paths and commands are normalized by the existing test-map parser. Merged
maps preserve deterministic input order, and snapshot canonicalization continues to
sort and deduplicate mappings. The loaded repository schema version is included in
the existing `config_digest`, so adding a valid no-op v1 config remains auditable;
the informational `$schema` URI is excluded because it does not affect analysis.

## Packaging and documentation

`schemas/config.schema.json` is the editor/tooling contract and is included in the
npm package through the existing `files` allowlist. README documents discovery,
strict validation, precedence, the supported v1 shape, and the continuing
`--test-map` escape hatch.

## Tests

Tests cover absence compatibility, valid parsing/normalization, strict rejection of
unknown versions and keys, unsafe paths, symlinks/non-files, precedence across all
origins, deterministic merged output, schema/package metadata, and a changed
snapshot `config_digest` when repository config is introduced. Test execution and
static validation are delegated to the later validator as required by the task.
