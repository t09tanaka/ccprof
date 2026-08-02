# PR creation skill snippet

Append this thin procedure to the end of an existing PR creation skill. Run the
analysis only after the PR has been created successfully with `gh pr create`.

```text
1. Run the repository's required checks and create the PR with `gh pr create`.
2. After PR creation succeeds, run `ccprof --pr --json`.
3. Show ccprof's top findings with recoverable minutes, evidence, confidence,
   scope, and fix_recipe.
4. Apply and verify only `scope: this_pr` findings in the current PR.
5. Present `separate_issue` and `claude_md` findings as follow-up proposals.
   Do not create an Issue or another PR automatically.
6. Post a Markdown PR comment only after the user explicitly opts in.
```

The primary analysis command:

```sh
ccprof --pr --json
```

After fixing a `this_pr` finding, rerun the same command and check how the
recoverable estimate and the findings changed. Present `separate_issue` as a
candidate for separate work and `claude_md` as a candidate instruction change —
just present them; do not create an Issue automatically.

Posting the Markdown comment is an **explicit opt-in**. Run the following only
when the user asks for it.

```sh
ccprof --pr --md | gh pr comment --body-file -
```

JSON warnings go to stderr and the report itself to stdout. A wrapper that
post-processes the JSON must not mix explanatory text into stdout either.
