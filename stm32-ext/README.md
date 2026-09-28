# STM32 Extension (goodbye_cubeide)

CubeIDE を使わずに、VSCode だけで STM32 ファームウェアを **ビルド → 書き込み → 変数監視 → グラフ** します。

## クイックスタート（clone して動かす）

```bash
git clone https://github.com/sosukigara/goodbye_cubeide.git
cd goodbye_cubeide/stm32-ext
npm ci
npm run verify     # typecheck → vitest → pytest → compile
```

`npm run verify` は clone 直後（ビルド成果物なし）で **green** になります。件数は環境によって変わりますので、`passed` / `skipped` の行をそのまま読んでください。

skip されるもの（失敗ではありません）:

| 対象 | 条件 | 出し方 |
|---|---|---|
| 実機ファームウェアの ELF を要する Python テスト | `build-ext/*.elf` 無し（未ビルド） | `needs_firmware_elf` で skip |
| DWARF の fixture テスト | `arm-none-eabi-gcc` 無し | `GCC is None` で skip |

`pytest` が入っていない環境では Python の段だけ skip されます（`npm run test:py` を個別に実行すれば明白に分かります）。

### 必要なもの

拡張機能を **入れるだけ** なら Node.js 18+ と npm だけです。**実機で動かす** には下表のツールが要ります。足りないものは `STM32: 診断` がまとめて、**導入コマンド付き**で教えてくれます。初めて入れたときにも、必須ツールが足りていなければ通知します。

| | 必須 | 用途 |
|---|---|---|
| Node.js 18+ / npm | ○ | 拡張機能のパッケージング |
| `arm-none-eabi-gcc` | ○ | ファームウェアのコンパイル |
| `ninja` | ○ | ビルドの実行 |
| `python3` | ○ | Live 監視のサイドカー |
| `pyocd` | ○ | 書き込みと Live 監視（`pip install --user pyocd`） |
| `ccache` | △ | ビルドキャッシュ。無くても動きますが遅くなります |
| ST-LINK | 実機のみ | 接続。机上で動かすだけなら不要です |

導入例:

```bash
sudo apt install gcc-arm-none-eabi ninja-build python3 ccache
pip install --user pyocd
```

`pyocd` が無くても **ビルドと型解析は動きます**。「何もできない」状況を作らないためです。

### VSCode に読み込む

```bash
npm run package                                  # stm32-ext-<version>.vsix
code --install-extension stm32-ext-*.vsix
```

表示したら `Developer: Reload Window`。

**設定ファイルは触らなくて構いません。** `stm32ext.probe` / `interface` / `resetMode` / `pollHz` は既定値（ST-LINK / SWD / connect-under-reset / 100Hz）で動きます。ST-LINK 以外を使うときだけ設定してください。

### 動かないとき

コマンドパレットで **STM32: 診断**。ツールチェーン・設定・CubeIDE 競合をまとめて点検し、不足していれば導入コマンドを表示します。

## 画面構成

**サイドバー 1 枚**（アクティビティバーの STM32 アイコン）に 6 セクションが縦に積まれています。パネルは 6 枚ではなく 1 枚です。

| セクション | 中身 |
|---|---|
| プロジェクト | `.cproject` を含むプロジェクトの検出・選択・再検出 |
| ビルド | ビルド / ビルドして書込、進捗バー、ELF 名、エラー一覧（クリックで `command:stm32ext.openBuildDiag` へ移動） |
| 書き込み | 書込、進捗行、結果行、失敗時だけ現れる「再試行」 |
| 変数 | 監視状態・Hz・欠損率、監視開始/停止/一時停止/再接続/変数追加/CSV、型ツリーの表 |
| グラフ | 系列の追加/削除と現在値の一覧。「グラフを開く」でエディタ領域にグラフパネルがひらきます |
| ログ | 監視セッションのログ。フィルタ・消去・自動スクロール |

webview の HTML は起動時に 1 度だけ設定され、以降はメッセージだけで差分更新されます（100Hz 監視中でも入力欄やフォーカス、表が消えません）。

## 機能

### プロジェクト
- 開いたフォルダ直下に `.cproject` があれば単一プロジェクト、なければその下 1 階層のディレクトリをコンテナとして検出します（`build-ext` / `Debug` / `Release` / `out` などは降りません）。
- 選択は `stm32ext.selectProject` からも行えます。

### ビルド
- `.cproject` を読み、`build-ext/build.ninja` を生成して `ninja -C build-ext` を実行します。生成規則は C/C++/ASM/リンクのフラグまで `.cproject` 由来です。
- コンパイルは `ccache` 経由（`--no-ccache` は本拡張のビルド経路では無効）。
- ninja の `[n/total]` を進捗として表示し、GCC の `file:line:col:` 行を Problems パネルにも登録します。
- ビルド後に `python3 scripts/elf_resolve.py <elf> --all-members --json` を実行し、DWARF から型ツリーと葉の集合を解決します。

### 書き込み
- 書き込み前に必ず確認ダイアログが出ます。
- `stm32ext.flashTool`:
  - `pyocd`（既定）: `pyocd load --target <mcu> --format elf --connect <mode> <elf>`。検証とリセットは pyOCD の既定動作です。追加のベンダーツールチェインは不要です。
  - `cubeprogr`: `STM32_Programmer_CLI -c port=<interface> -w <elf> -v -rst`（`-v` は常に付与）。
- `stm32ext.interface` と `stm32ext.probe` は CubeProgrammer 経路にのみ効きます。pyOCD 経路は接続する ST-LINK を自分で選び、インターフェースは probe から導出されます。
- `stm32ext.resetMode=connect-under-reset` は pyOCD では `--connect under-reset`、`none` は `--no-reset` になります。
- 書き込み前にプローブ競合（CubeIDE 起動中、別の監視セッションがロックファイル `/tmp/stm32ext-live.lock` を保持）を検査し、 modal で確認します。失敗したときの「再試行」はビルドからやり直します。
- 書き込みが成功して停止していた監視セッションがあれば自動で再開します。

### 変数（Live）
- GDB ではありません。ホストが `python3 scripts/live_poll.py`（pyOCD 製サイドカー）を起動し、`build-ext/live.csv` に吐きます。`arm-none-eabi-gdb` は不要です。
- 監視対象は `DebugGlobal` 構造体の葉です。DWARF からネストした構造体を再帰的に列挙し、`live-types` メッセージで木構造ごと届きます。
- 表の表示は葉の型で解釈します: `bool` → true/false、`float`(4/8) → 有効数字 6 桁、`enum` → 列挙名（未登録は `2 (unknown)`）、符号付き → `BigInt.asIntN` で 10 進、`string` → NUL まで UTF-8、`bitfield` → ビットマスク、型不明 → 生 hex + 「型不明」。値は 10 進/16 進をセルクリック（または Enter / Space）で切替できます。
- グループ行（構造体）は折りたためます（クリックまたは Enter / Space）。グループ行には `N葉`、`監視数/総数` が出ます。監視していない葉は淡色表示です。
- 構造体の「+」で配下の葉をまとめて監視へ追加します。**上限はありません** — 選択した葉はすべて監視されます。ホスト側は監視リスト全体をポーリングするため、webview 側で切り詰めると「追加したのに監視されない」変数が生まれるだけです（これは実際の不具合でした）。監視する変数を絞りたい場合は、葉の行の「×」で個別に外してください。
- 葉の行にも「+」があり、その葉 1 個だけを監視へ追加します（グループ行の「+」は配下すべて）。「×」は葉ならその葉だけ、グループなら配下すべてを外します。監視リストは workspaceState に保存されます。
- 「変数追加」は QuickPick で、点線名をグループ化した区切り表示、`sys.` のような前方入力で絞り込み、ソース解析（`Core/Src`, `Core/Inc`）で出たグローバル変数の候補、および任意のシンボル名入力（`arm-none-eabi-nm` で解決）に対応します。
- セル右の「✎」で書き込み。書込は 1/2/4/8 バイト幅のみ受け付け、幅がそれ以外なら拒否します。
- 一時停止は**表示のみ**の停止です。記録と CSV は継続します。
- 「CSV」はワークスペース直下の `live.csv` に書き出します。メモリ上の直近 5000 行ではなく、サイドカーのセッション CSV（回転後の世代を含む）を優先します。スキーマは `timestamp,address,name,value` の 4 列固定です。
- 欠損率は期待 tick 対取得サンプル数（tear 含む）で計算され、サイドバーの `live-drop-rate` とログに出ます。1% を超えた場合はサイドカーが終了コード 4 で終了します。

### グラフ
- グラフは**エディタ領域に開く実パネル**です。サイドバーの「グラフ」セクションの「グラフを開く」（またはコマンドパレットの `STM32: グラフパネルを開く` / コマンド `stm32ext.showGraph`）でひらきます。サイドバー側は系列の追加/削除と最新値の一覧だけで、描画は持ちません（描画実装が2つあると表示が食い違うため）。
- パネルは軸目盛と単位付き時間軸、凡例と系列ごとの表示 ON/OFF、系列ごとの min/max/last 読み出し、時間窓 1/5/10/30/60 秒の選択、enum の名前ステップ描画、`rAF` バッチ描画（フレーム時間 p50/p95/max をフッターに表示）、`devicePixelRatio` 対応とリサイズ追従を行います。
- 系列の履歴はホスト側に最大 20000 行|archiveされ、「CSV 保存」で `stm32-graph.csv` に書けます（4 列スキーマ。系列を削除しても他系列の履歴は失われません）。
- 値は型ツリー（DWARF）を参照して解釈します。float は実数、bool は true/false、符号付きは符号付き十進、enum は名前として描画されます。型情報が無いシンボルは「型不明」として表示し、ビット列のまま数値として描画しません。
- 系列名(input)は補完付きです。DWARF の型インデックスから「すべての葉」と「その上の構造体ノード」（`drive.emergency` など、内部で葉へ展開される名前）を候補にします。候補は名前順で、ブラウザ標準の前方一致で絞り込めます。候補はサイドバーの入力とグラフパネルの入力の両方に付きます。
- 系列の追加/削除は**監視リストの更新と同じ操作**です。どちらの画面から追加しても、その系列は実際に監視されます（グラフに並べたのに値が出ない、という状態を作りません）。
- グラフパネルは**ビルド前でも開けます**。開いた後にビルドしても型インデックスが届き、その場合は即座に描画されます。
- 1 回の操作で複数の系列を追加/削除しても、監視リストの更新とセッションの再起動は**まとめて 1 回**です。構造体を指定すると最大 32 葉に展開されますが逐次処理はしません。

### ログ
- サイドバーのログセクションは監視セッションのログ（`[live] ...`）です。フィルタ・消去・自動スクロールは webview 内で完結します。保持は webview 側 2000 行。
- ビルドや書き込みのログは VSCode の出力チャネル「STM32」に出ます。セッションログは `build-ext/live-session.log` にも追記されます。

## 設定

`package.json` の `contributes.configuration` が正です。

| キー | 型 / 選択肢 | 既定値 | 意味 |
|---|---|---|---|
| `stm32ext.flashTool` | `pyocd` / `cubeprogr` | `pyocd` | 書き込みツール。`pyocd` は live と同じライブラリ、追加インストール不要 |
| `stm32ext.cliPath` | string | `STM32_Programmer_CLI` | CubeProgrammer CLI のパス。`flashTool=cubeprogr` のときだけ参照 |
| `stm32ext.probe` | `ST-LINK` / `J-LINK` | `ST-LINK` | プローブ種別（pyOCD 経路では未使用） |
| `stm32ext.interface` | `SWD` / `JTAG` | `SWD` | デバッグインターフェース（CubeProgrammer 経路の `port=` になる） |
| `stm32ext.resetMode` | `connect-under-reset` / `software-reset` / `hardware-reset` / `core-reset` / `none` | `connect-under-reset` | リセット戦略。pyOCD では `connect-under-reset` → `--connect under-reset`、`none` → `--no-reset` |
| `stm32ext.pollHz` | number, 1–200 | `100` | Live のポーリング周波数 |
| `stm32ext.uiFontPx` | number, 12–22 | `15` | サイドバーの基本文字サイズ(px)。操作ボタンのタップ領域と値列/操作列の幅はこれに追従します。変更後は `Developer: Reload Window`（または再起動）が必要です。サイドバーの HTML は 1 度だけ生成されるためです |

`probe` / `interface` / `resetMode` / `pollHz` は上の表の既定値で有效的です。ホストは設定値が**空のときだけ**操作を止め、空になるのは利用者が明示的に `""` にした場合だけです。`cliPath` も `flashTool=cubeprogr` のときしか必須になりません（pyOCD 経路はベンダーツールチェーン不要）。`uiFontPx` は既定値を持つ表示設定なので、この必須設定の検査には含まれません。

## コマンド

`STM32: Show * Panel`（6 種すべてサイドバーをフォーカスします）、`STM32: Build Project (Ninja + ccache)`、`STM32: Build & Flash (auto ELF, confirm + verify)`、`STM32: Flash ELF (confirm + verify)`、`STM32: Select Target Project`、`STM32: Diagnose (CubeIDE/CLI/settings)`、`STM32: Open Build Diagnostic Location`。

`STM32: Diagnose` は設定・`STM32_Programmer_CLI` の解決可否・CubeIDE プロセスの有無を点検して出力チャネルに残します。

## 書き込みの安全規則

`src/live/allowlist.ts` が強制します。

1. 対象は ELF で解決済み、かつ解決された `DebugGlobal` の範囲 `[base, end)` 内のアドレスであること。範囲外・未解決はダイアログも出さずに拒否。
2. 幅は 1/2/4/8 バイトのみ（`live_write.py` が扱える幅）。
3. 必ず modal 確認。値と現在の値（型デコード済み）を表示。
4. `drive` / `motor` / `current` などを含むパスの変数にはモーター駆動警告を先頭に付けて確認。
5. 許可・拒否のすべてを `[live-write] <時刻> ALLOWED|REFUSED(...)` の監査行として出力チャネルに記録し、拒否理由は画面にも表示。

実書き込みは、実行中のサイドカーの stdin に JSON 1 行として送り、サイドカーのポールループが 1 tick 遅延で実行します。サイドカー側でも同じ範囲チェックを行い、さらに read-modify-write で触る 32 ビットワード全体が範囲内に収まることを確認してからバスに触り、書き戻し値を読み戻して結果として返します。

## 必要環境

Live と型解決は Python サイドカーで、GDB ではありません。

- `python3`（ホストは `python3` を PATH から解決して起動します）
- `pyocd`（Live 監視・pyOCD 書き込み用）: `pip install --user pyocd`
- `pyelftools`（DWARF 型解決用、無い場合は `arm-none-eabi-nm` + `arm-none-eabi-readelf` のフォールバックに落ちます）
- ビルド: `arm-none-eabi-gcc` / `arm-none-eabi-g++` / `arm-none-eabi-nm` / `arm-none-eabi-readelf`、`ninja`、`ccache`
- 書き込み: `pyocd`（既定）または `STM32_Programmer_CLI`（`flashTool=cubeprogr`）
- ソースツリーに `.cproject` があること

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| `プローブ使用中: 別のウィンドウ/プロセスが監視セッションで掴んでいます` | USB の `Resource busy`。ロックファイル `/tmp/stm32ext-live.lock` を別の監視セッションが保持している | 相手側の「停止」で解放するか、そのウィンドウを閉じる。停止時は子プロセスの終了を待ってから再接続する |
| 起動時に `STM32CubeIDEが起動しています` の modal | CubeIDE のデバッグサーバが ST-LINK を掴んでいる | CubeIDE を完全終了してから再実行。CubeIDE 自身のプロセスは kill しません |
| サイドカーが `pyocd is not installed` で終了（終了コード 3） | pyOCD 未導入。再試行では直りません | `pip install --user pyocd`、または `python3 scripts/live_poll.py --ensure-pyocd`。自動インストールはしません |
| 接続時に USB タイムアウト（終了コード 5） | 初回接続の USB 応答なし。サイドカーは指数バックオフで既定回数だけ USB エラーだけ再試行し、尽きたらハントonormalします | ケーブルの接触、USB 負荷、他のプローブ保持プロセス（CubeProgrammer / OpenOCD / GDB / 別の VSCode ウィンドウ）を確認。ST-LINK を挿し直し「再接続」。ST-LINK V2 (0483:3748) の udev ルールも確認 |
| `監視できる変数がありません`（終了コード 6） | 解決 JSON に監視可能な葉がない | 「変数追加」から選ぶか、ビルドし直す。監視リストは workspaceState に残るため、意図しない表示なら「×」で消して再ビルド |
| `ELF has no debug info (stripped or built without -g)`（`elf_resolve` の終了コード 2） | DWARF がない、または `--strip-debug` 済み | Debug 構成を `-g3` でビルドし直して `ninja -C build-ext`。生成される build.ninja は `-g3` を含みます |
| `symbol 'debug' not found; is this a firmware ELF with debug.hpp linked in?` | `DebugGlobal` シンボルが無い | ファームウェアに `DebugGlobal` を定義するヘッダを include しているか確認 |
| `MCU が不明です。ビルドしてから再度書き込みしてください` | `pyocd` はターゲット ID（例 `stm32g474retx`）が必要で、ビルド結果からしか分からない | 先にビルドしてから書き込む |
| グラフに線が一切出ない | 型ツリーを受け取っていない、または数値化できない型（`string` など）だけを追加している | 先にビルドする（`live-types` はビルド時の解決で届きます）。型ツリー受信前は「変数追加」が無効化されます |
| 値に `0x… 型不明` と表示される | DWARF ではなく `arm-none-eabi-nm` で解決したシンボル（型情報なし） | DWARF 付き（`-g3`）ビルドで再解決するか、`DebugGlobal` 配下の葉を直接追加する |
| 監視が勝手に再開される | サイドカーがユーザー停止以外で終了した場合、ホストは自動再起動します（上限 3 回） | 出力チャネルの `live_poll exited code=` を確認。真因は終了コード 3/4/5/6 のどれかで上表に対応 |

## 補足

- ST-LINK は排他リソースです。別のセッションや CubeIDE が掴んでいる場合は modal で検知して書き込み・監視を開始しません。衝突の解消先は「トラブルシューティング」の表にあります。
- 監視セッションの CSV とグラフの CSV は同じ 4 列スキーマ（`timestamp,address,name,value`）で、`value` は生の hex（桁数 = メンバ幅）です。型解釈は表示側で行うので、CSV は機械解析できます。

## ライセンス

MIT License（`LICENSE` を参照）。Copyright (c) 2026 so sukigara。

本リポジトリは STM32CubeIDE / STM32CubeMX / STM32CubeProgrammer の
実行ファイル・ライブラリ・ソース・生成物を**一切同梱していません**。
ST の各ツールは、利用者が自身の PC にインストール済みの実行ファイルを
`subprocess` で呼ぶだけで、再配布していません。`.ioc` / `.cproject` は利用者の
プロジェクト設定として**読むだけ**で、コード生成は再実装していません。
`STM32` は STMicroelectronics の商標であり、本プロジェクトはその製品ではありません。
本ソフトウェアは STMicroelectronics によって承認・後援・提供されたものではなく、
STMicroelectronics と提携関係にもありません。
