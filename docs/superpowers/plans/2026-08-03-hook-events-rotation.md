# Hook Events Rotation Implementation Plan

> **Goal:** Bound the per-repository `hook-events.jsonl` log with size-triggered in-place compaction so unlimited Stop-hook appends can never grow it past 1 MiB.

## Scope

- Compact only on the write side, in `ccprof hook-event`, right after the Stop-row append; the analysis readers stay untouched.
- Trigger compaction only when `stat` reports the log above 1 MiB, keeping the common path at a single `stat`.
- Keep valid rows newer than 30 days, discard malformed lines, and enforce the 1 MiB cap newest-first while preserving relative order.
- Replace the log via the existing lock-free temp + fsync + rename atomic-write pattern; accept the rare read-to-rename append race as a documented TOCTOU, with no lock.
- Swallow every compaction failure so the hook always exits 0.
- Do not change package versions or release metadata, and do not touch `CHANGELOG.md`.

## Files

- `src/commands/hook-event.ts`
- `test/hook-event.test.ts`
- `README.md`
- this plan

## Task 1: Size-triggered compaction

- [x] Add `MAX_HOOK_EVENTS_BYTES` (1 MiB) and `RETENTION_MS` (30 days) constants next to the throttle constants.
- [x] Add `maybeCompactHookEvents(path, nowMs)` that returns immediately when the log is at or below the cap.
- [x] Filter oversized logs to `isHookEventLogRow`-valid rows with `received_at_ms >= nowMs - RETENTION_MS`, dropping malformed lines.
- [x] When retention filtering is not enough, keep only the newest suffix of rows that fits in 1 MiB, preserving original relative order.
- [x] Rewrite via temp file + fsync + atomic rename, following the `writeJsonAtomically` pattern in `src/store/analyses.ts`.
- [x] Wrap the whole compaction in try/catch so failures degrade to silent success, and document the accepted read-to-rename TOCTOU in the same style as the throttle race comment.
- [x] Call compaction after the Stop-row append, reusing the already injected `nowMs`.

## Task 2: Tests

- [x] Below-threshold logs are appended to but never rewritten, even when they contain expired or malformed rows.
- [x] Oversized logs lose expired rows while recent rows and the fresh append survive as valid JSONL, in order.
- [x] Malformed lines are discarded during compaction.
- [x] Rows entirely within retention still respect the 1 MiB absolute cap, newest-first, order preserved.
- [x] A failing compaction (write-only log file) is swallowed: the append lands, the hook returns silent success, and the log is left intact.
- [x] `--notify` throttling still honors a recent `ccprof_notified` row after compaction rewrites the log.

## Task 3: Documentation and delivery

- [x] Add a README paragraph in the hooks section describing the 1 MiB / 30-day bound and its best-effort nature.
- [x] Run `npm run check` and confirm it is fully green.
- [x] Commit implementation + tests and this plan as separate commits on `feature/hook-events-rotation` (no push).
