# ccprof

`ccprof` は、Claude Code のセッションログと最終 Git diff を PR 単位で
照合し、「どこを何分削れそうか」を証拠と修正レシピ付きで示すローカル
プロファイラです。同じ入力からは同じ結果を返す決定的なルールだけを使い、
解析に LLM は使いません。

## 必要環境とインストール

- Node.js 20 以上
- `git`
- PR 番号・URLや現在の PR を GitHub から解決する場合のみ `gh`

公開パッケージは一度グローバルにインストールします。以後の実行コマンドは
常に `ccprof` です。

```sh
npm install --global ccprof
ccprof --help
```

ソースから開発する場合は、依存関係を入れてビルドした後にリンクします。

```sh
git clone <repository-url>
cd ccprof
npm install
npm run build
npm link
ccprof --help
```

## クイックスタート

リポジトリ内で引数なしで実行すると、現在の PR（見つからない場合は
デフォルトブランチと `HEAD` の差分）を解析し、1画面の TTY レポートを
表示します。

```sh
ccprof
```

現在の PR を明示的に選ぶ形も同じです。

```sh
ccprof --pr
```

エージェントから使う主経路は JSON v2 です。

```sh
ccprof --pr --json
ccprof --pr 123 --json
ccprof --pr https://github.com/example/project/pull/123 --json
```

ローカルの base/head を直接指定すれば、PR メタデータ取得のネットワーク
アクセスなしで解析できます。

```sh
ccprof --pr main...feature
ccprof --pr main..feature --json
```

PR コメント向け Markdown は明示的に生成します。

```sh
ccprof --pr main...feature --md
ccprof --pr 123 --md | gh pr comment 123 --body-file -
```

## コマンド

```text
ccprof
ccprof --pr [<number|url|base...head>] [--json|--md]
       [--idle-threshold <duration>] [--test-map <path>]
ccprof stats [--json]
ccprof dismiss <finding-key> [--reason <text>]
```

### 解析

出力形式は次の3つです。

| 実行例 | 出力 |
|---|---|
| `ccprof --pr 123` | 人間向けのコンパクトな TTY レポート |
| `ccprof --pr 123 --json` | エージェント向け JSON v2 |
| `ccprof --pr 123 --md` | PR コメント向け Markdown |

`--json` と `--md` は同時には指定できません。`--idle-threshold` は裸の
数値（分）または `s`、`m`、`h` 付きの期間を受け取ります。

```sh
ccprof --pr --idle-threshold 45m
ccprof --pr main...feature --idle-threshold 2h --json
ccprof --pr 123 --test-map /absolute/path/to/ccprof-test-map.json --json
```

PR の解決順序は、明示された `base...head` / `base..head`、明示された
PR 番号・URL、現在の PR、リモートのデフォルトブランチ（次いで `main`、
`master`）と `HEAD` の順です。

### 集計

現在のリポジトリに保存された解析履歴、ベースライン、ルール別時間、
慢性的なコマンドコストを表示します。

```sh
ccprof stats
ccprof stats --json
```

### Finding の却下

JSON/TTY/Markdown に表示された安定した `finding_key` を指定します。
理由は任意です。

```sh
ccprof dismiss <finding-key>
ccprof dismiss <finding-key> --reason "このリポジトリでは意図したフル検証"
```

同じキーは14日間抑制され、ちょうど14日で失効します。期間内でも回収見積もり
が却下時の **2×を厳密に超えた** 場合は再提示され、保存した理由も caveat
として表示されます。

## JSON v2

JSON モードの標準出力は、余分なログを混ぜない単一の JSON 文書です。警告は
標準エラーに出ます。表示する finding は回収可能時間順の上位1〜3件ですが、
ストアには解析で得た全 finding を保存します。

```json
{
  "version": 2,
  "unit": {
    "repo": "/work/project",
    "pr_ref": "main...feature",
    "sessions": ["session-1"]
  },
  "summary": {
    "measured_min": 52,
    "idle_excluded_min": 35,
    "estimated_floor_min": 38,
    "recoverable_min": 14,
    "human_wait_min": 4,
    "unexplained_min": 2,
    "baseline": null
  },
  "findings": [
    {
      "finding_key": "6d4f...",
      "rule_id": "R002",
      "title": "Redundant test or build runs",
      "classification": "behavior",
      "cause": null,
      "scope": "this_pr",
      "confidence": "high",
      "evidence": {
        "session_refs": ["session-1#entry-42"],
        "interval_ids": ["R002:session-1#entry-42"],
        "command": "npm test",
        "count": 2
      },
      "recoverable": {
        "min": 14,
        "bound": "point"
      },
      "fix_recipe": {
        "suggestion": "変更中は対象テストに絞り、最後にフル検証する",
        "verify": "npm test"
      },
      "caveats": []
    }
  ],
  "caveats": []
}
```

時間の意味は次のとおりです。

```text
raw_observed = measured_min + idle_excluded_min
measured_min = normal_min + point_recoverable_min + human_wait_min + unexplained_min
estimated_floor_min = measured_min - point_recoverable_min
```

`human_wait_min` は閾値以下の人間待ち（ターン間の応答待ちと
AskUserQuestion の回答待ち）で、エージェントの非効率ではないため独立して
表示します。承認起因として回収可能と証明できた待ちは従来どおり
`recoverable_min` 側に入ります。`unexplained_min` は、正常コストにも
決定的な削減候補にも分類できなかった活動時間です。未知の無駄を正常コスト
へ黙って混ぜないために残します。
`bound: "upper"` の finding は表示されますが、推定最短時間を減らしません。

### `scope` の扱い

- `this_pr`: 現在の feature PR で修正して再検証できる候補
- `separate_issue`: リポジトリ基盤などの別作業として提案する候補
- `claude_md`: Claude Code の作業手順や `CLAUDE.md` の改善候補

連携テンプレートは `this_pr` だけを現在の PR で自動修正の対象にします。
`separate_issue` と `claude_md` は提案として提示し、Issue や別PRを自動作成
しません。

## 時間計測と放置

ツール実行、推論、人間待ちをタイムスタンプ間の区間として組み立てます。
複数セッションや sidechain が重なる時間は合算せず、wall-clock 区間の和集合
を使います。

人間待ちが idle threshold を**厳密に超える**場合は放置（away）として分離
します。放置は生活時間なので `idle_excluded_min` に記録し、`measured_min`
と回収可能時間から除外します。閾値以下の人間待ちは `human_wait_min` とし
て unexplained から分離して表示します。閾値以下の待ちは合計できますが、
「放置」と「熟考」をログだけで区別することはできません。

タイムスタンプはログの書き込み時刻であり、ツールや推論の厳密な開始・終了
時刻ではない、という既知の限界があります。結果が欠けたツールに終了時刻を
推測で補うことはせず、0時間・低 confidence として扱います。Git 自体にも
ブランチ作成時刻がないため、PR作成時刻が得られない場合は head 固有の最古
コミットを開始境界として使い、caveat を付けます。

名前で決定的に識別できる既知の調整・委任・調査ツール（TodoWrite / Agent /
Skill / WebFetch 等）と、既知の安全な単一コマンド（git / gh と ls・cat・rg
などの読み取り系）は、unexplained ではなく正常コスト（normal）に分類しま
す。`cd backend && npm test` や `npm test 2>&1 | tail` のような複合コマン
ドも、全セグメントが既知（test/build/check/vcs/読み取り系/cd）でリダイレ
クトを除いて解釈できる場合に限り同じ規則で分類します。未知のツール（MCP
ツール等）や、未知のセグメント・コマンド置換を含むシェル合成は従来どおり
unexplained のままです。AskUserQuestion はツール実行時間ではなくユーザー
回答待ち（人間待ち）として扱い、idle threshold を厳密に超えた場合は放置
（away）として `idle_excluded_min` に分離します。

## テスト対応の上書き

JS/TS の `package.json`、Rust の `Cargo.toml` と一般的なテストパスは
自動認識します。精度を明示的に上げたい場合は、リポジトリ外に次の JSON を
保存して `--test-map` で渡します。

```json
{
  "mappings": [
    {
      "source": ["src/**"],
      "tests": ["test/**"],
      "commands": ["npm test", "npm run test:unit"]
    }
  ]
}
```

```sh
ccprof --pr --test-map /absolute/path/to/test-map.json --json
```

ログに記録されたコマンド文字列は分類にだけ使い、再実行しません。

## 検出ルール

| ID | 検出内容 | 回収見積もり | 主な scope |
|---|---|---|---|
| R001 | 最終 diff に残らない手戻り編集 | point | `this_pr` / `claude_md` / `separate_issue` |
| R002 | 変更と無関係なテスト・ビルド実行 | point | `this_pr` |
| R003 | 編集を挟まない同一ファイルの再読 | pointまたはupper | `claude_md` |
| R004 | 証明済み承認待ち（他の入力待ちは `human_wait_min` 側） | point | `separate_issue` |
| R005 | 独立した読み取りの直列実行 | upper | `claude_md` |
| R006 | 複数解析で恒常的なコマンドコスト | upper | `separate_issue` |
| R007 | 50,000 token超の結果・compaction | upper | `claude_md` / `separate_issue` |
| R008 | 関連編集なしの同一テスト fail→pass | pointまたはupper | `separate_issue` |

R006 は少なくとも過去5解析、うち3解析以上での出現、全 measured time の30%
以上を必要とします。R008 の判定は Phase 1 ではテスト名ではなく正規化コマ
ンド単位で行い、失敗テスト名は失敗実行の出力から決定的に抽出して evidence
（`failed_tests`）に含めます（対応: TAP / jest / vitest / cargo / pytest）。

## 対応ソースとスキーマ変化

Phase 1 の実装済みソースは **Claude Code** です。通常は
`~/.claude/projects` を自動発見します。`SessionSource` インターフェースは
Codex などの追加に備えていますが、Codex ログのパーサーはまだ実装して
いません。

Claude Code の JSONL は非公開スキーマなので、パーサー境界で変化を吸収
します。同じ `message.id` の累積スナップショットは最終形を採用し、同じ
IDに分割された異なる content fragment は順序を保って結合します。不正行、
未知 content block、欠損 result は警告と confidence 低下へ縮退し、解析可能
なセッションまで巻き添えにして停止しません。sidechain と compaction も
正規化します。

Markdown、ベースライン、ストア駆動 R006 は当初の Phase 2 項目ですが、
このリリースに含まれます。framework 固有の flaky test 名抽出、提案採用後の
効果追跡、Codex parser は今後の拡張です。

## プライバシーと保存先

解析、diff 照合、ストア保存はローカルで完結し、セッション本文や findings
を ccprof がテレメトリとして送信・アップロードしない設計です。PR 番号・URL
または現在の PR の解決では、インストール済みの `gh pr view` が GitHub の
メタデータを取得することがあります。ネットワークを避ける場合は
`base...head` を指定してください。

ストアはリポジトリ内ではなく、次のリポジトリ別ディレクトリに置かれます。

```text
$XDG_DATA_HOME/ccprof/<sha256(canonical-repo-path)>/
~/.local/share/ccprof/<sha256(canonical-repo-path)>/
```

検証や特殊な配置では `CCPROF_DATA_DIR` で保存ルートを、また
`CCPROF_CLAUDE_PROJECTS_DIR` で Claude projects ディレクトリを上書き
できます。

## 終了コード

| Code | 意味 |
|---:|---|
| 0 | 成功（finding が0件の場合も含む） |
| 2 | CLI の使用方法エラー |
| 3 | リポジトリまたは PR context を解決できない |
| 4 | 対応セッションまたは解析可能な timestamp がない |
| 5 | 回復不能な source / git / store エラー |

一部の JSONL 行が壊れていても、解析可能なセッションが残れば code 5 には
しません。

## 開発

```sh
npm install
npm run build
npm test
npm run typecheck
npm run check
```

個別テストは TypeScript をテスト用ディレクトリへコンパイルしてから Node
built-in test runner で実行します。ランタイム依存はなく、`git` と必要に
応じた `gh` だけを外部プロセスとして呼び出します。
