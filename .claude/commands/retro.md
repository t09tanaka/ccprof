---
description: Profile the current PR and apply only in-scope ccprof fixes
argument-hint: "[PR number, URL, or base...head]"
---

# ccprof retrospective

Run a deterministic retrospective for the current repository.

1. If no argument was supplied, run:

   ```sh
   ccprof --pr --json
   ```

   If `$ARGUMENTS` contains a PR number, URL, or `base...head`, run:

   ```sh
   ccprof --pr "$ARGUMENTS" --json
   ```

2. Parse the single JSON v2 document. Treat stderr warnings as caveats, not as
   JSON. Present the conclusion and the top findings with their recoverable
   minutes, evidence, confidence, and scope.

3. Apply changes only for findings whose literal contract is
   `scope: this_pr`. Inspect the cited paths and session references before
   editing, make the smallest relevant change, and run the finding's
   `fix_recipe.verify` command when it is safe and applicable.

4. For `scope: separate_issue`, explain the proposed follow-up. For
   `scope: claude_md`, explain the suggested instruction change. Do not mix
   either class into the feature PR, and Issue や別PRは自動作成しない。

5. After an applied `this_pr` fix passes its relevant checks, rerun
   `ccprof --pr --json` and report what changed. Do not dismiss a finding
   unless the user explicitly asks to dismiss its `finding_key`.

If ccprof returns no findings, say so and stop without inventing improvements.
