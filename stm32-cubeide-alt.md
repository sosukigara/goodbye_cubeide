# stm32-cubeide-alt - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** 重いCubeIDEの代わりに、普段のVSCodeの中でボタンを押すだけでビルド・書き込み・変数の生監視ができる拡張機能が手に入ります。グラフ表示や記録、実行中の値の書き換えもパネル操作だけで行えます。

**Why this approach:** 車輪の再発明をしません。今あるプロジェクト定義をそのまま読み取って互換性を保ち、書き込みはST純正ツールに任せ、実行中監視の仕組みだけ自作します。公式のVSCode拡張とも共存できます。

**What it will NOT do:** 自動コード生成の作り直し、デバッガ本体の自作、条件トリガ、既存チューナー画面の再実装はしません。ロボット側のプログラム自体にも触りません。

**Effort:** Large
**Risk:** Medium - 実機(SWD・プローブ)依存の検証が成否を握る
**Decisions to sanity-check:** 監視の読み取り方式にpyOCDを主採用(OpenOCD予備)、書き込みは安全のため監視用構造体のみ許可、対応機種はG4実証＋他系列ベストエフォート、の3点。

Your next move: approveして `/start-work stm32-cubeide-alt` で別セッションのワーカーに渡すか、高精度レビュー(momus+独立Oracle)を先に回すか選んでください。Full execution detail follows below.

---

> TL;DR (machine): Large effort, Medium risk; VSCode ext delivering generic project recognition, fast build, one-click flash, enhanced live expressions GUI.

## Scope
### Must have
- 汎用プロジェクト認識: 任意STM32プロジェクトの `.cproject`+`.ioc` を自動検出・監視し、MCU/FPU/Include/Define/リンカスクリプトを抽出。分岐時は `.cproject` を正とする(G1)。workspace相対パスをVSCode multi-rootで解決(G3)。MCU別フラグテーブルはG4実証+F4/H7/G0テーブル駆動のベストエフォート(G11)。
- 高速ビルド: `.cproject` のフラグ(`-mcpu/-mfpu/-mfloat-abi`/Define/Include/リンカスクリプト)を逐語インポートし(G2)、Ninja+ccache+並列で `.elf/.hex/.bin` を生成。Debug構成は `-g3`+`-Og` 契約(G7)。`build_check/CMakeLists.txt` は正準フラグ参照として扱い二重管理しない(G4)。ビルドパリティ(既存Debug成果物と一致)検証付き(G12)。
- ワンクリック書込: STM32CubeProgrammer CLI(`STM32_Programmer_CLI`)に委譲。プローブ=ST-LINK、IF=SWD、リセット=connect-under-reset既定、速度・ポートは設定化(G5)。verify付き(G12)。
- Live Expressions強化版: ELF/DWARFから `debug` 等シンボルのアドレスをビルド毎に自動解決(絶対アドレス手貼り廃止)。pyOCDを主SWDリードバックエンドとし(OpenOCD予備)(G6)、10Hz既定ポーリング+ダブルリードのちぎれ対策(G8)。表示/グラフ/CSVログ(スキーマ固定)/メモリ書込(G12)。書込は `DebugGlobal` 配下のみ許可+確認ダイアログ+モータ駆動中警告の安全インターロック(G9)。
- GUIシェル: 全機能をVSCodeパネル(Webview)+コマンドパレットで操作。パネル Inventory は「プロジェクト/ビルド/Flash/Live変数/グラフ/ログ」の6枚に固定(G10)。
### Must NOT have (guardrails, anti-slop, scope boundaries)
- CubeMXコード生成(`.ioc`→HAL生成)の再実装をしない
- 独自GDBサーバ/デバッガコアを自作しない(既存サーバ・pyOCD/OpenOCDに委譲)
- トリガ条件式・ブレーク的停止機能を作らない(将来拡張)
- PIDチューナーSWDパス(`tuner_params`直接操作)/CubeMonitorフロー(`monitor/flows*.json`)の再実装をしない(G10)
- ファーム製品コード(`unit_omni3`/`unit_pc-stm`/`pid_tuner_stm_bridge`の中身)を改変しない
- Eclipse機能の全移植をしない

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + framework (TypeScript側: vitest / Python側: pytest with PYTEST_DISABLE_PLUGIN_AUTOLOAD=1)
- Evidence: .omo/evidence/task-<N>-stm32-cubeide-alt.<ext> (outside ulw-loop use .omo/evidence/)
- 計測基準(G12): ビルドパリティ=同一ソースでCubeIDE Debug成果物とセクションサイズ一致(±1%以内)/シンボル一致。増分ビルド時間=2回目以降のwall-clockを記録しCubeIDE比で報告。Flash=CLIのverify成功+リセット後起動。Live=10Hz既定で欠損率<1%/5分、CSVスキーマ固定(timestamp,address,name,value)。

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- Wave 1 (todos 1-3): 拡張土台+汎用パーサ+パーサ試験。並列不可(2→1依存、3は1,2の後)。
- Wave 2 (todos 4-7): 高速ビルド+書込。4と6は並列可、5は4の後、7は6の後。
- Wave 3 (todos 8-11): ELF解決+SWDリード+GUI。8と9は並列可、10は8,9の後、11は9の後。
- Wave 4 (todos 12-14): 実機統合+回帰+文書化包装。直列。

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | - | 2,5,7,10 | - |
| 2 | 1 | 3,4 | - |
| 3 | 2 | 4 | - |
| 4 | 2,3 | 5,12 | 6 |
| 5 | 1,4 | 12 | 7 |
| 6 | - | 7,12 | 4 |
| 7 | 1,6 | 12 | 5 |
| 8 | - | 10,12 | 9 |
| 9 | - | 10,11,12 | 8 |
| 10 | 1,8,9 | 12 | 11 |
| 11 | 9 | 12 | 10 |
| 12 | 4,5,6,7,8,9,10,11 | 13 | - |
| 13 | 12 | 14 | - |
| 14 | 13 | - | - |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [ ] 1. VSCode拡張の土台+GUIシェル骨格を作る
  What to do: TypeScript拡張をscaffoldし、コマンドパレット登録・Activity Bar・設定スキーマ(CLIパス/プローブ/IF/リセット方式/ポーリングHz)・6枚固定のWebviewパネル枠(プロジェクト/ビルド/Flash/Live変数/グラフ/ログ)を用意する。Must NOT do: CubeMX生成・デバッガ自作・7枚目以降のパネル追加(G10)。
  Parallelization: Wave 1 | Blocked by: - | Blocks: 2,5,7,10
  References (executor has NO interview context - be exhaustive): unit_omni3/.cproject:17-101 (抽出すべき項目の正体), unit_omni3/unit_omni3.launch:1-90 (既存デバッグ設定の全体像), monitor/flows.json (再実装禁止の既存資産の例)
  Acceptance criteria (agent-executable): `npx tsc --noEmit` が通り、`vsce package` がvsixを生成すること。
  QA scenarios (name the exact tool + invocation): happy=`vscode-test`相当の起動試験で全6パネルが例外なく開くこと、failure=設定欠落時にエラーメッセージ付きで無操作終了すること。Evidence .omo/evidence/task-1-stm32-cubeide-alt.log
  Commit: Y | feat(stm32-ext): scaffold VSCode extension shell with 6 fixed panels
- [ ] 2. 汎用.cproject/.iocパーサを作る(.cproject優先・パス解決・MCU別テーブル)
  What to do: `.cproject` XMLからMCU/FPU/FloatABI/Include/Define/リンカスクリプト/ビルド構成を抽出。`.ioc` と乖離したら `.cproject` を正とする(G1)。workspace相対・`${workspace_loc}` をmulti-root解決する(G3)。MCU→`-mcpu/-mfpu/-mfloat-abi`/起動ファイルのテーブルを持ち、G4完全対応+F4/H7/G0はテーブル駆動ベストエフォート(G11)。`.ioc` は再生成検出(変更監視)のみに使う。Must NOT do: CubeMXコード生成の再実装、フラグの再解釈・丸め(G2)。
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3,4
  References: unit_omni3/.cproject:17-101 (MCU STM32G474RETx/FPU fpv4-sp-d16/hard/Include/Define/リンカスクリプトの実例), unit_omni3/unit_omni3.ioc (監視対象の形式), unit_pc-stm/.cproject + pid_tuner_stm_bridge/.cproject (第2・第3の実例で汎用性確認)
  Acceptance criteria: `npx vitest run parser` で3プロジェクト全ての抽出結果が期待JSONと一致すること。
  QA scenarios: happy=unit_omni3の抽出が.cproject全文と一致、failure=`.ioc`のみ変更時は「再生成の可能性」警告を出し`.cproject`値を維持すること(G1)。Evidence .omo/evidence/task-2-stm32-cubeide-alt.log
  Commit: Y | feat(stm32-ext): generic cproject/ioc parser with precedence and MCU tables
- [ ] 3. パーサの試験を固める(フィクスチャ+乖離ケース)
  What to do: todo2のパーサに対し、実物フィクスチャ(unit_omni3/unit_pc-stm/pid_tuner)＋合成乖離ケース(.iocと.cprojectが食い違う)/multi-rootパス/未知MCUのテストを追加する。Must NOT do: パーサ本体の仕様変更(失敗はtodo2へ差し戻し)。
  Parallelization: Wave 1 | Blocked by: 2 | Blocks: 4
  References: todo2と同一 (欠落・代替根拠なし — 当該参照を削除し本系譜に代替: G1/G3/G11は本planのScope記述に代替)
  Acceptance criteria: `npx vitest run` が全緑で、カバレッジが分岐(G1/G3/G11相当)を全て踏むこと。
  QA scenarios: happy=全ケース緑、failure=未知MCUでは「未検証テーブル」警告+処理継続(G11)。Evidence .omo/evidence/task-3-stm32-cubeide-alt.log
  Commit: Y | test(stm32-ext): parser fixtures for divergence paths and unknown MCU
- [ ] 4. Ninja+ccache高速ビルドバックエンドを作る(逐語フラグ+Debug契約+パリティ検証)
  What to do: todo2の抽出結果を逐語でNinjaビルドに流す(G2)。`build_check/CMakeLists.txt` を正準フラグ参照とし二重管理しない(G4)。Debug構成は `-g3`+`-Og` を強制(G7)。`arm-none-eabi-gcc`+ccache+並列。成果物は独立dir(例 `build-ext/`)に出し既存 `Debug/` を汚さない。ビルドパリティ検査(既存Debug成果物とセクションサイズ±1%/シンボル一致)を同梱(G12)。Must NOT do: 最適化レベルの勝手な変更、既存Debug dirへの上書き。
  Parallelization: Wave 2 | Blocked by: 2,3 | Blocks: 5,12
  References: unit_omni3/build_check/CMakeLists.txt:1-82 (正準フラグ: cortex-m4/hard/fpv4-sp-d16/Include/Define), unit_omni3/Debug-fast/ (別dir運用の前例: objects.list/unit_omni3.elf/unit_omni3.map), unit_omni3/.cproject:26-101 (リンカスクリプト/ツール別定義の実例)
  Acceptance criteria: unit_omni3が `ninja -C build-ext` で `.elf` を生成し、パリティ検査スクリプトがPASSすること。
  QA scenarios: happy=初回フルビルド成功+2回目増分ビルドが1回目より高速(時間記録)、failure=ツールチェイン不在時は導入手順付きエラーで停止すること。Evidence .omo/evidence/task-4-stm32-cubeide-alt.log
  Commit: Y | feat(stm32-ext): ninja ccache build backend with parity check
- [ ] 5. ビルドGUIパネル(ターゲット選択・実行・診断表示)を作る
  What to do: ターゲット(構成)選択・ビルドボタン・進捗・診断(エラーはファイル:行ジャンプ)・増分ビルド時間表示をWebviewに実装。todo1の枠・todo4のバックエンドに接続。Must NOT do: 新規パネル追加(G10)。
  Parallelization: Wave 2 | Blocked by: 1,4 | Blocks: 12
  References: todo1(パネル枠)/todo4(バックエンドIF)、unit_omni3/.cproject:29 (parallelBuildOnの既定思想)
  Acceptance criteria: パネル操作のみでビルド→成功表示→診断ジャンプが通ること(コマンドパレット経由の手操作試験を手順化して実行)。
  QA scenarios: happy=成功パス、failure=ビルド失敗時にエラー行ジャンプ+再ビルド導線が出ること。Evidence .omo/evidence/task-5-stm32-cubeide-alt.log
  Commit: Y | feat(stm32-ext): build GUI panel with diagnostics jump
- [ ] 6. STM32CubeProgrammer CLI書込バックエンドを作る(既定値+verify)
  What to do: `STM32_Programmer_CLI -c port=SWD -w <elf> -v -rst` 系をラップ。既定=ST-LINK/SWD/connect-under-reset(G5)。CLIパス・プローブ・速度・ポートはtodo1設定から注入。verify必須(G12)。Linux名差異(`STM32_Programmer_CLI`)を吸収。Must NOT do: 独自フラッシュアルゴリズムの実装。
  Parallelization: Wave 2 | Blocked by: - | Blocks: 7,12
  References: unit_omni3/unit_omni3.launch:42-50 (既存リセット戦略connect_under_reset等の実例)、STM32CubeProgrammer CLI公式ドキュメント https://www.st.com/en/development-tools/stm32cubeprog.html (2026-09時点の最新版を採用しバージョンをコード内コメントに記録)(Web調査所見をコード内コメントで引用)
  Acceptance criteria: [dry-run] `--dry-run`で生成コマンドが期待形(`-c port=SWD -w <.elf> -v -rst`相当)になる単体試験が緑であること(独立pass/fail)。[real-device] 実機接続時はverify成功がログに残ること(独立pass/fail)。dry-run合格を実機合格とみなさない。
  QA scenarios: happy=dry-run一致+実機verify成功、failure=プローブ未検出時に再試行導線付きエラーになること。Evidence .omo/evidence/task-6-stm32-cubeide-alt.log
  Commit: Y | feat(stm32-ext): flash backend via CubeProgrammer CLI with verify
- [ ] 7. Flash GUI(確認・進捗・マルチプローブ)を作る
  What to do: Flashボタン・対象elf表示・進捗・verify結果・プローブ選択を実装。誤爆防止の確認ステップ付き。Must NOT do: 自動再Flashループ等の危険機能。
  Parallelization: Wave 2 | Blocked by: 1,6 | Blocks: 12
  References: todo1/todo6、unit_omni3/unit_omni3.launch:42-50
  Acceptance criteria: [dry-run] パネル操作のみでdry-run Flash→verify表示が通ること(独立pass/fail)。[real-device] パネル操作のみで実機Flash→verify表示が通ること(独立pass/fail)。dry-run合格を実機合格とみなさない。
  QA scenarios: happy=成功表示、failure=書込失敗時にリトライ+ログ保存導線が出ること。Evidence .omo/evidence/task-7-stm32-cubeide-alt.log
  Commit: Y | feat(stm32-ext): flash GUI panel with confirm and verify view
- [ ] 8. ELF/DWARFアドレス解決器を作る(ビルド毎に自動再解決)
  What to do: ビルド成果物 `.elf` から `debug` 等シンボルのアドレス+フィールドオフセットを解決(pyelftools相当または`arm-none-eabi-nm`/`readelf`ラップ)。ビルド毎に再解決し、CubeMonitor式の絶対アドレス手貼りを不要にする。DWARF欠落時は `-g3` 不足としてtodo4の契約違反を報告(G7)。Must NOT do: 解決結果のハードコード保存。
  Parallelization: Wave 3 | Blocked by: - | Blocks: 10,12
  References: unit_omni3/Core/Inc/debug.hpp:1-422 (DebugGlobalのappend-only構造=解決対象)、unit_omni3/Debug-fast/unit_omni3.elf (解決対象の実例)、todo4(-g3/-Og契約)
  Acceptance criteria: `pytest` で実elfに対する解決試験が緑(`debug`シンボル解決+主要フィールドオフセット>0を確認)。
  QA scenarios: happy=実elf解決成功、failure=ストリップ済みelfでは「デバッグ情報不足」の明示エラーになること(G7)。Evidence .omo/evidence/task-8-stm32-cubeide-alt.log
  Commit: Y | feat(stm32-ext): elf dwarf symbol resolver with per-build refresh
- [ ] 9. SWD周期リードバックエンドを作る(pyOCD主・OpenOCD予備・ちぎれ対策)
  What to do: pyOCD Python APIを主バックエンドに実行中haltなし周期リード(既定10Hz・設定可)。OpenOCDを予備に。マルチバイト/構造体はダブルリード+不一致時再読でちぎれ対策(G8)。欠損率を計測しログ化(G12)。Must NOT do: ターゲットhaltを伴う読み方を既定にする(G6のCubeIDE意味論の維持)。
  Parallelization: Wave 3 | Blocked by: - | Blocks: 10,11,12
  References: unit_omni3/unit_omni3.launch:11 (enable_live_exprの意味論=実行中リード)、unit_omni3/Core/Inc/debug.hpp:421-422 (volatile定義の実体はcode.cpp)、pyOCD公式Python APIドキュメント https://pyocd.io/docs/api.html (2026-09時点の最新版を採用しバージョンをコード内コメントに記録)
  Acceptance criteria: [real-device] 実機で5分間10Hzリードし欠損率<1%を満たすこと(独立pass/fail)。[dry-run] モックプローブ試験が緑であること(独立pass/fail)。一方の合格を他方の合格とみなさない。
  QA scenarios: happy=欠損率基準達成、failure=プローブ切断時に自動再接続試行+明示エラーになること。Evidence .omo/evidence/task-9-stm32-cubeide-alt.log
  Commit: Y | feat(stm32-ext): swd polling backend with tear guard
- [ ] 10. Live Expressions GUI(変数表+グラフ+CSVログ)を作る
  What to do: 変数テーブル(リアルタイム値)・時系列グラフ・CSV記録(スキーマ `timestamp,address,name,value` 固定)(G12)をWebviewに実装。todo8の解決結果+todo9の値を購読。Must NOT do: トリガ条件式・PIDチューナー画面の再実装(G10)。
  Parallelization: Wave 3 | Blocked by: 1,8,9 | Blocks: 12
  References: todo1/todo8/todo9、unit_omni3/Core/Inc/debug.hpp:14-36 (sys/ioタイミング等の表示対象の実例)
  Acceptance criteria: 実機接続で変数表示+グラフ描画+CSV保存が通ること。CSVヘッダが固定スキーマ(timestamp,address,name,value)と一致すること。assertion: `head -1 *.csv | grep -x 'timestamp,address,name,value'` が緑であること。
  QA scenarios: happy=表示・記録成功、failure=解決失敗時は項目ごとに「未解決」表示で他項目は継続すること。Evidence .omo/evidence/task-10-stm32-cubeide-alt.log
  Commit: Y | feat(stm32-ext): live expressions GUI with graph and csv log
- [ ] 11. メモリ書込パスを作る(許可リスト+確認+安全警告)
  What to do: `DebugGlobal` 配下アドレスのみ許可のallowlist書込(G9)。実行前に確認ダイアログ+モータ駆動中(実機)警告を必須表示。範囲外・未解決アドレスは拒否。Must NOT do: 任意アドレス書込、確認なし書込。
  Parallelization: Wave 3 | Blocked by: 9 | Blocks: 12
  References: todo9、unit_omni3/Core/Inc/debug.hpp:1-422 (許可範囲の根拠)
  Acceptance criteria: `pytest` でallowlist試験(範囲内OK/範囲外拒否/未解決拒否)が緑であること。
  QA scenarios: happy=許可範囲書込成功+読み返し一致、failure=範囲外で拒否+監査ログ記録。Evidence .omo/evidence/task-11-stm32-cubeide-alt.log
  Commit: Y | feat(stm32-ext): allowlisted memory write with confirm and audit
- [ ] 12. unit_omni3で end-to-end 統合する(認識→ビルド→Flash→Live→CSV→書込)
  What to do: 実機(または許容環境)で全フロー統合試験。G12の全基準(パリティ/増分時間/verify/欠損率/CSV schema)を証跡付きで確認。Must NOT do: ファーム本体の改変。
  Parallelization: Wave 4 | Blocked by: 4,5,6,7,8,9,10,11 | Blocks: 13
  References: 前todo全体 + unit_omni3/AGENTS.md (ProductionはCubeIDE onlyという現状制約=本拡張が満たすべき同等性の定義)
  Acceptance criteria: 全G12基準を満たし、証跡ログが .omo/evidence/ に揃うこと。
  QA scenarios: happy=全基準PASS、failure=いずれかFAIL時は原因todoへ差し戻し記録を残すこと。Evidence .omo/evidence/task-12-stm32-cubeide-alt.log
  Commit: N (検証のみ。修正が出たら該当todoの型で別コミット)
- [ ] 13. unit_pc-stmとpid_tunerで回帰確認する(汎用性の実証)
  What to do: todo12と同一フローを残り2プロジェクトで実行し、パーサ汎用性(G11)とビルド互換を実証。差異はMCUテーブル/設定に吸収し分岐コードを増やさない。Must NOT do: 機種別ハードコードの追加。
  Parallelization: Wave 4 | Blocked by: 12 | Blocks: 14
  References: unit_pc-stm/.cproject、pid_tuner_stm_bridge/.cproject、unit_pc-stm/AGENTS.md・pid_tuner_stm_bridge/AGENTS.md
  Acceptance criteria: 2機種とも認識→ビルド→Flash→Live解決が通ること。下表のMUSTを満たすこと(独立pass/fail・OR合格禁止)。| device | MUST | | unit_pc-stm | MUST: 認識・ビルド・Flash・Live解決を通すこと | | pid_tuner_stm_bridge | MUST: 認識・ビルド・Flash・Live解決を通すこと |
  QA scenarios: happy=両機種PASS、failure=機種固有失敗はテーブル不足としてtodo2へ差し戻すこと。Evidence .omo/evidence/task-13-stm32-cubeide-alt.log
  Commit: N (検証のみ)
- [ ] 14. 文書化しvsix包装して守備範囲を固定する
  What to do: 使い方・設定項目・対応MCU表(G11)・G12基準の達成値・Must NOT have再掲を含むREADME相当を拡張内に同梱し、`vsce package` で配布物を作る。公式STM32Cube for VS Codeとの共存手順も明記。Must NOT do: スコープ外機能の追加。
  Parallelization: Wave 4 | Blocked by: 13 | Blocks: -
  References: 全todoの証跡 (欠落・代替根拠なし — 当該参照を削除し本系譜に代替: G10/G11/G12は本planのScope記述に代替)
  Acceptance criteria: `vsce package` 成功+同梱ドキュメントに全必須項目があること。
  QA scenarios: happy=クリーン環境での再現手順が文書通り通ること、failure=不足項目はチェックリスト化して残すこと。Evidence .omo/evidence/task-14-stm32-cubeide-alt.log
  Commit: Y | docs(stm32-ext): usage mcu matrix and packaging

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit
- [ ] F2. Code quality review
- [ ] F3. Real manual QA
- [ ] F4. Scope fidelity

## Commit strategy
- Conventional Commits。TypeScript拡張は `feat(stm32-ext)` / `test(stm32-ext)` / `docs(stm32-ext)` を使用。
- 検証のみのtodo(12,13)はコミットしない。修正が出たら原因todoの型で別コミットする。
- mainへ直接pushしない。新機能はworktreeで作業し、完了後は `git worktree remove` + `git branch -d` で掃除する(リポジトリ運用則)。
- ファーム製品コード・`monitor/flows*.json`・CubeMX生成物への混入コミットを禁止。

## Success criteria
- 任意の対応STM32プロジェクトを開くと自動認識され、MCU/フラグが正しく抽出される(3実機プロジェクトで実証)。
- 同一ソースのビルド成果物がCubeIDE Debug成果物とパリティ(セクションサイズ±1%/シンボル一致)を満たす。
- パネル操作のみでビルド→Flash(verify付)→Live変数表示→グラフ→CSV記録→許可範囲書込が通る。
- Live既定10Hzで5分欠損率<1%。CSVは固定スキーマ。
- `vsce package` で配布物が作れ、共存手順書どおりに公式拡張と併用できる。
- Must NOT have(生成再実装/デバッガ自作/トリガ/チューナー再実装/ファーム改変)の混入がゼロ。
