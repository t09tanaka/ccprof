# PR creation skill snippet

既存の PR 作成スキルの最後に、次の薄い手順を追加します。解析は
`gh pr create` による PR 作成成功後だけ実行してください。

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

主経路の解析コマンド:

```sh
ccprof --pr --json
```

`this_pr` の修正後は同じコマンドを再実行し、回収見積もりと finding の変化を
確認します。`separate_issue` は別作業の候補、`claude_md` は作業指示の候補
として提示するだけで、Issue は自動作成しないでください。

Markdown コメントの投稿は**明示的なオプトイン**です。ユーザーが希望した
場合だけ、次を実行します。

```sh
ccprof --pr --md | gh pr comment --body-file -
```

JSON の警告は stderr、レポート本体は stdout です。JSON を加工するラッパー
でも stdout に説明文を混ぜないでください。
