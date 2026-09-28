# stm32-ext 全面完成 + 構造体対応 デザイン

日付: 2026-09-28 / 対象: `/home/so/lab/goodbye_cubeide/stm32-ext`
前提: 拡張 1.6.0 / vscode ^1.85.0 / node 22 / pyocd 0.45.1 / pyelftools

---

## 0. 実装前に必ず解決する前提条件

| # | 前提 | 状態 |
|---|---|---|
| 0-1 | **ロールバック手段**。このリポジトリは git 管理下にない（親/子とも `git rev-parse` が fatal） | **解決済み**: `.omo/session-work/pre-S1-snapshot-20260928.tgz`（src/ scripts/ tests/ package.json tsconfig.json docs、159KB）を取得済み。S6 完了まで保持する |
| 0-2 | **実機 Flash は実行禁止**。対象は実ロボット。書込は dry-run のみ | すべての検証で `flash` を実行しないこと。実機で行うのは no-halt の読み取りとビルドのみ |
| 0-3 | ホストの类是**実機**（ST-LINK/V2 接続済み、probe は排他）。probe を掴む処理は同時に1つだけ | 検証手順 (§5.6) は直列で実行する |

---

## 1. 動機と実測証拠

ユーザー要求（優先順の最新が有効）: ①全機能がちゃんと動作してかつ使いやすい ②変数値表示に構造体対応 ③グラフ表示など各種の仕上げ

ベースライン（2026-09-28 実測）: `npx tsc --noEmit` クリーン / `npx vitest run` 165 green / `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest -q` 18 green。
**テストは緑だが実機は壊れている。**

### 1.1 実機（ST-LINK/V2, `build-ext/unit_omni3.elf`）で測定した事実

| 事実 | 測定 |
|---|---|
| live poll は実機で動作する（block read / 10 symbols / span 360B） | `ticks=790 collected=787 dropped=3 drop_rate=0.3797% tears=0`、`read mode=block`（`live_poll.py:271-273` の block 経路） |
| 値は実際に変動する | `sys.loop_hz` が 0x508 → 0x504 |
| **初回接続が稀に失敗する** | 11 回の接続試行で 1 回のみ `USB Error: [Errno 110] Operation timed out`。**「アイドル後の初回接続」仮説は棄却済み**（30s アイドル後 3/3 成功）。根本原因**未特定** |
| **CSV は 8KB バッファで束ねる** | 500ms サンプリングでファイル長が 0→16451→49324→82198…（+32KB 単位）。host には最大 約145行/145ms 分の束ねでしか見えない |
| connect 時に core が 1回 halt される | `live_poll.py:178-183` が resume で相殺。halt 中は `read32` が静的値を返す |

### 1.2 DWARF で実測した対象 firmware の形

| 事実 | 値 |
|---|---|
| `DebugGlobal` の実サイズ | 976 B（解決器の base 0x200000b4 / size 976 と一致） |
| ネストされた構造体ノード | 29。うち **16 は名前なし*型***（`DW_TAG_structure_type` に `DW_AT_name` が無い）だが、**参照するメンバは名前あり**なので既存コードは捨てていなかった（下記 P0-6 の訂正を参照） |
| スカラ葉 | **324**（現状の watchlist は curation 10 個のみ）。幅の分布は 4B:173 / 1B:142 / 2B:9、8B は 0 |
| 配列 | 3 |
| **bitfield** | **0**。ELF 全走査で `DW_AT_bit_size` / `DW_AT_data_bit_offset` / `DW_AT_bit_offset` を持つ DIE は 1件も存在しない |
| DebugGlobal 内の enum 型葉 | **0**（`DW_TAG_enumeration_type` は ELF 内に 319 個あるが DebugGlobal 配下には無い） |
| 最上位グループ別の葉数 | `periph` **185** / `drive` 52 / `nav` 49 / `sys` 14 / `comm` 11 / `backup` 9 / `wheel_odom` 4 |
| 1/2 バイト幅の葉 | **151**（1B:142 + 2B:9）。block read は 32bit 語を返すので、これらは個別 read が必須 |

**`drive.controller` の正体**（bitfield ではない — DIE の実 Attr で確認）:

```
Controller byte_size=16
  up   {DW_AT_data_member_location: 0}  type=DW_TAG_base_type/bool
  down {DW_AT_data_member_location: 1}  type=DW_TAG_base_type/bool   … 計16個が byte offset 0..15
```

byte offset が 1 ずつ進む = **独立した 1バイト `bool` 16 個**。現行コードは 32bit 単位読みなので
**16個すべてが `0xff000001` のような上位 garbage 付き表示**になり、`drive.*` は
`allowlist.ts:32` の書込許可パスなので**その壊れた表示が書込ダイアログの初期値になる**。

**型解決の実装上の落とし穴**（実測）:
- `uint32_t` は `DW_TAG_typedef` で、直下の `DW_AT_byte_size` が **0**。大きさは typedef を辿って
  `DW_TAG_base_type` まで降りないと取れない（現状の `_die_type_name` は名前を辿るだけ）。
- 符号有無は `DW_AT_encoding` の**数値**（`DW_ATE_signed=0x05`）で来る。文字列 "signed" の
  部分一致写法は機能しない。

### 1.3 壊れている機能（P0）

| ID | 欠陥 | 証拠 | 症状 |
| P0-6 | **訂正: 本 firmware では発生していない。** 匿名 16 個は「名前なしメンバ」ではなく「名前ありメンバが参照する匿名*型*」であり、旧実装は黙って捨てていなかった。合成名の規則は他 firmware 防御として実装する | `elf_resolve.py:361-364` | 実害なし。規則自体は実装済み（合成 fixture で担保） |
| P0-1 | `nmLookup` が `(name) => undefined` に固定 | `extension.ts:652` | 「変数を追加」が 100% 失敗。追加した変数は必ず未解決で一度も読まれない |
| P0-2 | `exportCsv` が `this.view === undefined` で即 return | `extension.ts:1004` | 「CSV保存」が無反応。エラーも出ない |
| P0-3 | `refresh()` が `webview.html` を丸ごと代入し `appendLog` から呼ばれる | `extension.ts:1704`, `:1699` | 100Hz 監視中に毎秒数十回 DOM 再構築。live表・グラフ点列・入力中の文字・フォーカス流失 |
| P0-4 | 値表示が型に非依存、読み取り幅が全 32bit 固定 | `sidebar.ts:236-238`, `live_poll.py:282`（read32）, `:243`（mask 32bit） | `float` がビット列を10進整数表示。1B `bool`（`drive.controller` の16個）は上位 garbage 付き。64bit は下位32bitのみ。符号付き `-1` が `4294967295`。**書込ダイアログの初期値も壊れる** |
| P0-5 | 構造体が一切扱えない | `elf_resolve.py:38-49`（curation 10個）, `:419-420`（`--all-members` は no-op） | 葉324個に対し手動10個。1個ずつ追加必須 |
| P0-6 | 匿名ネスト構造体が黙って捨てられる | `elf_resolve.py:361-364`（`nm is None` で continue） | 16 個のサブツリーが `unresolved` にも出ずに消える |
| P0-7 | ビルド進捗が UI に出ない | `panel.set()` は未登録 view のみ refresh（`extension.ts:1390-1392` の gate, `:1494,1503,1531`） | ビルドが数秒〜数分「無反応」に見える。progress が 0% で固まる |
| P0-8 | `flash-retry` が恒久 `hidden` | `sidebar.ts:103`、 unhide するコード無し | 失敗後の再試行導線が無い |
| P0-9 | flash 進捗が常に空文字 | `extension.ts:1807,1812` が `""` を渡す。`stm32ext.flash` は `setFlashStatus` を呼ばない（`:1831`） | 書き込み中も結果も UI に出ない |
| P0-10 | tear ガードが自己比較 | `live_poll.py:274,283` = `check(v, v)` | `tears` は常に 0。`<1%` 予算は原理的に失敗せず、ログの欠損率が嘘 |
| P0-11 | CSV 回転でヘッダがデータ行として混入 | host が offset だけリセットし `headerSkipped` を残す（`extension.ts:799-803` vs `:823-828`） | 100k 行ごとに `name`/`value` という架空の行が出る |
| P0-12 | 1時間後に値が固まる | `--seconds 3600` の clean exit が `session ended` で終了（`extension.ts:671`, `:746-748`） | 監視開始から1時間で無言で停止 |
| P0-13 | 死んだレンダラ 3 枚が登録されず、テストはそれらを検証 | `registerWebviewViewProvider` は `extension.ts:1817` の1件のみ（`resolveWebviewView` は `extension.ts:995,1145,1392` で走るが解決されない） | 緑テストが実 UI を保証しない |
| P0-14 | `elf_resolve.py:463` が `types` を読むが、`types` は pyelftools 分岐（`:224`, `:427`）でしか束縛されない | 同左 | nm+readelf フォールバックで `NameError` |
| P0-15 | 解決 JSON を書き出す 2 箇所が新フィールドを落とす | `elfResolver.ts:57-70`（`ResolvedSymbol` へ5項目だけコピー）, `manager.ts:56-62`（`buildResolutionJson`） | S1 が出した型情報が host を通雇员消え、sidecar に届かない |

### 1.4 仕様上の穴・偽装

| ID | 内容 | 証拠 |
|---|---|---|
| D-1 | README は GDB `var-update` と `arm-none-eabi-gdb` 必須と書くが、実体は `python3` + pyOCD サイドカ。requirements に python3/pyocd が無い | `README.md:12,19` vs `extension.ts:680` |
| D-2 | README の「6 fixed panels」「Graph ... CSV export」は実在しない（実体は 1サイドバー、`graph-download-csv` にホスト実装ゼロ） | `README.md:5,13` vs `extension.ts:1817`, `graphPanel.ts:63` |
| D-3 | `buildResolutionJson(res, extras)` が extras を使わない（doc コメントは逆を言う） | `manager.ts:49-50` |
| D-4 | `assertCsvHeader` / `pollConfigOf` / `TearGuard` / `dropStats` が製品で未使用 | `poller.ts:25,38,45,66` |
| D-5 | `checkProbeConflict` の結果を破棄 | `extension.ts:651` |
| D-6 | ログセクションに操作系 control がなく、供給元は `slog` のみ | `sidebar.ts:139`, `extension.ts:605-608` |
| D-7 | `live-remove` で行が DOM から消えない | `sidebar.ts:243-256` は append のみ |
| D-8 | クリック可能セルにキーボード経路が無い（`td.v` に tabindex/role/keydown 無し） | `sidebar.ts:240-252` |
| D-9 | `project-select` 行クリックが `msg.dir` を無視して QuickPick を開く | `extension.ts:1621` |
| D-10 | グラフが `float` のビット列を数値軸にプロット | `sidebar.ts:221-222` の `num()` |
| D-11 | 回転で履歴が消え、export はメモリ上の 5000 件上限だけを書き出す | `live_poll.py:296-303`, `extension.ts:977-980`, `:1002-1011` |
| D-12 | `setLiveDrop` に呼び出し元が無く `SidebarState.liveDrop` が常に空 | `extension.ts:1695` |

### 1.5 テスト infrastructural の穴

- **`tests/test_live_poll.py` が存在しない**。`poll_loop` / `DoubleReadGuard` / `DropTracker` /
  8KB バッファ / tear ガード / CSV 書込の自動カバーは **0 件**。現状「mock 試験緑」は S2 の前に既に成立してしまう。
- `tests/panel-scripts.test.ts` / `tests/ui-actions.test.ts` / `tests/flash.test.ts` は
  **登録されない死んだレンダラ**を検証している（緑テストの偽安全感）。
- `out/extension.js` は追跡済みで `npm run compile` でのみ更新される（`out/extension.js:656` に
  `nmLookup` 行）。`npx tsc --noEmit` は何も出力しないので、**`npx vsce package` 単独では旧 JS を焼く**。

---

## 2. 決定事項

| # | 決定 | 理由 | 却下した対案 |
|---|---|---|---|
| **D1** | UI 骨格は **ハイブリッド**（ユーザー選択済み）: サイドバー=Project/Build/Flash/Live/Log + Graph 起動、Graph はエディタ領域の実パネル | サイドバー幅 300px では軸目盛・凡例・読み出しが物理的に入らない。README の「6パネル」の約束は sections として保ち、Graph のみ別面として独立させる | A: サイドバー1枚に集約（グラフが狭すぎ） / B: 6枚すべて実パネル（変更量最大、操作/状態の集点が崩れる） |
| **D2** | **CSV スキーマは4列固定のまま**。`value` は「生バイト列」の hex（桁数 = メンバ size） | G12 受入が `head -1 \| grep -x 'timestamp,address,name,value'` 固定。列追加は受入契約の破壊 | 列追加（`type,size,signed`）— 契約破壊 |
| **D3** | **型解釈は UI 側**。型ツリーを host が post、webview が decode | CSV が非可逆性を保持し機械解析可能なまま。sidecar と表示の結合を外せる | sidecar で decode（CSV が可逆でなくなり、表示変更で CSV が変わる） |
| **D4** | **監視対象は葉のみ**。構造体は選択の単位に過ぎず行としては流さない。**一括追加は上限つきで、超過分は黙って捨てない**（追加件数と先頭未追加葉を必ず表示） | 実測: `periph` 単 subtree で 185葉 = 18,500行/秒 ≒ 1MB/s。1個追加＝全葉追加は不可能 | 構造体行をそのまま流す（値が無意味）/ 無制限一括追加（UI と CSV が崩壊） |
| **D5** | sidecar は**メンバ幅に合わせる**。ただし **block read は「4バイト境界に整列した4バイト葉」のみに許可**し、1/2/8バイト葉は個別 read とする | `read_memory_block32` は 32bit 語を返す API で、1/2バイト葉の境界情報を持たない。実 ELF の 355葉中 153葉が 1/2バイト。`use_block` の既存 gate（`live_poll.py:245-249`）は `width <= 32` しか見ていないので誤った値を返す | 全部 32bit 固定（現状）/ block をバイト列で読んで切り出す（复杂度増、`read_memory_block` の戻り値型が未検証） |
| **D6** | **死んだレンダラは削除**し 1レンダラに集約。仍在する価値のある部品（型列、`live-cause`、thead）は取り込む | D-3。drift は既に発生している | 3枚生かして登録（重複実装が残り続けて腐る） |
| **D7** | **sidecar は tick ごとに flush** | §1.1 実測: 8KB バッファで最大145ms 束ね。1行で消える | 定期 flush（依然束ねる）/ ファイル tail 廃止（受入 `{out}` CSV を失う） |
| **D8** | connect 時の halt を**可視化**し、resume 失敗はエラーにする | halt 中は `read32` が静的値を返す。「値が動かない」原因を隠している | 黙って resume（原因が隠れる） |
| **D9** | 型ツリーは **入れ子 `children[]`** で表現する（フラットなノード列 + 親 ID ではない） | §3.1 の JSON 例と §3.3 の `tree: TypeNode` と一致させる。webview は深さ優先で描画でき post は1回 | フラットノード列 + 親 ID（3節全体で形が割れる） |
| **D10** | 値は**近似ではなく厳密**に表示。float は有効数字6桁、enum は名前、bool は true/false、char配列は NUL までの文字列 | 「使える」の最低線 | 16進一律（現状） |
| **D11** | **host が書き出す解決 JSON は watchlist で必ずフィルタする**。`tree` は表示専用で決して poll しない | `--all-members` をそのまま渡すと 355葉 = 35,500行/秒。`load_watchlist`（`live_poll.py:206-218`）は watchlist の notion を持たない | 全部流す（CSV と UI が崩壊） |
| **D12** | **書込経路にも size を通す**。葉の追加で 1/2/8バイトが watchlist に入っても `live_write.py:52-56` の明示 size と整合する | `live_write.py` は既に 1/2/4/8 の read/write を実装済み（`:83-86`）。壊れるのは host 側の size 供給だけ | 書込を 4バイトに制限（構造体対応の意味が薄れる） |

---

## 3. 契約（並列実装の前提。最優先で確定させる）

### 3.1 型ツリー JSON（`elf_resolve.py --json` 出力）

既存フィールド `elf, base, size, end, has_debug_info, backend, symbols[], unresolved[]` は互換拡張。

**`size` の意味を明示**（3つ意味が同居するため混同厳禁）:

| 場所 | 意味 | 例 |
|---|---|---|
| トップレベル `size` | **DebugGlobal ウィンドウのバイトスパン**（書込範囲 fence が依存: `live_poll.py:209-210`） | 976 |
| `symbols[].size` / `tree.children[].size` の**葉** | **メンバの幅（バイト）** | 4 / 1 / 2 / 8 |
| `tree.size`（内部ノード） | その構造体のバイトスパン | 976 / 16 |

`symbols[]` の各要素:

```jsonc
{
  "name": "drive.drive_mode",       // 点線パス（葉）
  "address": "0x20000104",          // 絶対アドレス
  "offset": 80,                     // DebugGlobal base からの絶対オフセット
  "size": 4,                        // 葉の幅（バイト）
  "type": "int",                    // DWARF 型名（従来互換）
  "kind": "scalar|bool|enum|float|string|array",  // 新規。array は葉（要素1個）か多次元か length で表す
  "signed": true,                   // 新規: 符号有無
  "enumerators": [{"name":"MODE_FOLLOW","value":2}],  // kind=enum のみ
  "length": 12                      // kind=array/string のみ（要素数 or バイト数）
}
```

`tree`（表示専用、poll しない）:

```jsonc
"tree": { "name": "debug", "address": "0x200000b4", "size": 976, "kind": "struct",
          "children": [ /* 再帰・同じ形。葉は children: [] と size=幅 */ ] }
```

解決ルール:
- `kind: "struct"` / `"array"` のノードは行としては読まない（D4/D11）。葉だけが `symbols[]` に入る。
- **typedef を辿って `DW_TAG_base_type` まで降りてから size / signed を確定**（`uint32_t` の size が 0 になる既知の落とし穴、§1.2）。
- `DW_AT_encoding` は数値なので `DW_ATE_signed`(0x05) / `DW_ATE_unsigned`(0x07) との比較で判定する。
- `DW_TAG_enumeration_type` の `DW_TAG_enumerator` を列挙する。
- `DW_AT_data_bit_offset` / `DW_AT_bit_size` の読みは**防御的に実装**するが、本 firmware には bitfield が 0 件（§1.2）なので**受入条件にはしない**。合成 fixture でだけ検証する。
- **匿名構造体メンバには合成名を与える**（宣言順で安定、run を跨いで不変）。`elf_resolve.py:361-364` は
  現状 `nm is None` で黙って落とすので、匿名 16 個を全て列挙すること。命名規則:
  `<親パス>.<宣言順>.<field>`（例 `drive.emergency.0.req_active`）。`tree` にも必ず node を作る。
- オフセットは**親を積み上げた絶対オフセット**で出す（現状の `walk_struct` と同じ考え方）。
- nm+readelf フォールバックでも**例外を出さない**（`types` を必ず束縛する / P0-14）。

### 3.2 CSV 行

**純 CSV のみ**（注釈を書かない。5列になった行は host に黙って捨てられる）:

```
timestamp,address,name,value
2026-09-28T01:22:52.037,0x200000b4,sys.loop_hz,0x00000508
2026-09-28T01:22:52.037,0x20000100,drive.motor_timeout,0x01
2026-09-28T01:22:52.037,0x20000104,drive.drive_mode,0x00000002
2026-09-28T01:22:52.037,0x20000108,gpio.pins,0x1234
2026-09-28T01:22:52.037,0x2000010c,debug.sys.loop_hz.f32,0x3f800000
2026-09-28T01:22:52.037,0x20000110,ctrl.time_ns,0x0000000105e2b6a4
```

| 名前 | size | 期待される hex 桁数 |
|---|---|---|
| `sys.loop_hz` | 4 | 8 |
| `drive.motor_timeout` | 1 | 2 |
| `drive.drive_mode` | 4 | 8 |
| `gpio.pins` | 2 | 4 |
| `debug.sys.loop_hz.f32` | 4 | 8 |
| `ctrl.time_ns` | 8 | 16 |

契約:
- 列は4つ。header は `timestamp,address,name,value` で不変。
- `value` は `0x` + **小文字 hex、`size` バイトぶんの桁数**（ゼロ埋め、MSB 側からの並び）。例: 4B の float 1.0 は `0x3f800000`、1B の true は `0x01`、8B は 16 桁。これは旧挙動（`f"0x{value:08x}"`）と 4バイトについては同一。
- `name` は点線パス（可変長Segments）。comma を含まない。
- **host は `parts.length === 4` の行のみ受理する**（`src/live/manager.ts:98`）。`value` の桁数は
  検証しないので可変幅で問題ない。5列/3列の行は黙って捨てられる（= 不可視障害になるので出さない）。
- tick ごとに `flush()`（D7）。
- `symbols[]` には **watchlist の葉だけ**が入る（D11）。
- **float/string のデコードは上記 hex 整数をリトルエンディアンバイト列として解釈する**（最下位バイト = 末尾の hex 桁対）。`DataView` に詰めて `getFloat32(0, true)`。
### 3.3 webview メッセージ（双方向の完全な契約）

**送信 host → webview**（`src/extension.ts` が発行、`src/panels/sidebar.ts` / `src/live/graphPanel.ts` が消費）:

```ts
{ kind: "live-bootstrap", state: SidebarState, hz: number, project: string }  // 新規: 初期状態。HTML 再代入を廃止した後はこれが唯一の初期化経路
{ kind: "live-types", tree: TypeNode, index: Record<string, LeafMeta> }       // kinds/sizes/enumerators を備える
{ kind: "live-sample", samples: LiveSample[] }
{ kind: "live-status", state: "idle|starting|running|paused|error", text: string, detail?: string }
{ kind: "live-drop", summary: string }                                        // 既存 11 箇所からの生ログをそのまま webview へ
{ kind: "live-unresolved", names: string[] }
{ kind: "live-write-result", message: string }
{ kind: "live-watchlist", names: string[] }                                   // 追加/削除の正（host が正とする）
{ kind: "build-progress", phase: string, percent: number|null, done: number, total: number|null }
{ kind: "flash-progress", phase: string, percent: number|null }
{ kind: "log-append", lines: string[] }                                       // 差分だけ。HTML を触らない
{ kind: "graph-series", series: {name:string; color:string; visible:boolean}[] }
```

`LeafMeta` = `{ size: number; kind: string; signed: boolean; type: string; enumerators?: {name:string;value:number}[]; length?: number }`。

**`live-types` の既存 payload は `types: Record<string,string>`**（`extension.ts:411-416` が送信、
`sidebar.ts:265` / `livePanel.ts:103-104` が受信）。本仕様はこれを `tree` + `index` に**置換**し、
`types` は廃止する。送信は S3、受信は S4 が同時に変更する。

**送信 webview → host**（`parseSidebarMessage` / `parseGraphPanelMessage` が受理）:

```ts
{ kind: "live-add", names: string[] }          // 新規: 構造体/葉の追加。構造体は tree から葉集合に展開
{ kind: "live-remove-names", names: string[] } // 新規: 削除。接頭辞一致で配下の葉を全て削る
{ kind: "live-write", name: string, value: string }
{ kind: "live-export-csv" } | { kind: "live-pause" } | { kind: "live-resume" }
{ kind: "live-stop" } | { kind: "live-reconnect" } | { kind: "live-stop" }
{ kind: "graph-add", name: string } | { kind: "graph-remove", name: string }
{ kind: "graph-download-csv" }                  // 実ハンドラを S3 が実装する
{ kind: "build-run" } | { kind: "build-flash" } | { kind: "flash" } | { kind: "flash-retry" }
{ kind: "project-select", dir: string } | { kind: "project-refresh" }
{ kind: "log-clear" } | { kind: "log-filter", text: string }
```

QuickPick（`extension.ts:877-956`）は副次的経路として**残す**が、木-structured picker が主。

### 3.4 値デコード（webview 共通・1箇所に集約）

hex 文字列 → 数値: `BigInt("0x" + hex)`。float は **リトルエンディアン**（Cortex-M と対象 host 共通）で
`DataView` に詰めて `getFloat32(0, true)` / `getFloat64(0, true)`。JS のビット演算は 32bit なので
`size > 4` では **BigInt 演算**を使う。

| kind | 例 | 実装 |
|---|---|---|
| `bool` | `0x01` | `v !== 0n` |
| `float` (4) | `0x3f800000` | `getFloat32` → `Number.toPrecision(6)` |
| `float` (8) | 8B hex | `getFloat64` → `Number.toPrecision(6)` |
| `enum` | `0x00000002` | `enumerators[]` で名前に変換。未登録値は `2 (unknown)` |
| `scalar` signed | `0xffffffff` | `BigInt.asIntN(size*8, v)` → 10進 |
| `scalar` unsigned | `0x00000508` | `v` → 10進 |
| `string` | `0x52554e00` | 下位バイトから NUL までの UTF-8 デコード |
| `bitfield` | 任意 | `(v >> BigInt(bit_offset)) & ((1n << BigInt(bit_size)) - 1n)`（size>4 でも安全） |
| 判別不能 | 任意 | 生 hex + 「型不明」注記 |

グラフの数値軸には**数値変換可能な kind のみ** plottable。`enum` は**名前ステップ系列として必ず描画する**
（構造体ダッシュボードの主役が enum のため）。`string` は数値軸に出さない。

---

## 4. 実装スライス

各スライスは「実装 + テスト」を1単位。所有ファイルが重ならないよう配分する。
**`src/extension.ts` / `src/live/elfResolver.ts` / `src/live/manager.ts` の所有権は S3 のみ**。

| # | 内容 | 主なファイル | 完了条件（観測可能な形で書く） |
|---|---|---|---|
| **S0** | ロールバック用スナップショット | `.omo/session-work/pre-S1-snapshot-20260928.tgz` | **済**（159KB）。S6 まで保持 |
| **S1** | 型ツリー解決: ネスト構造体 / 匿名構造体の合成名 / 配列 / 符号 / typedef 追跡 / `--all-members` 実体化 / fallback 例外排除。bitfield と enumerator は**合成 fixture のみ**で検証 | `scripts/elf_resolve.py`, `tests/test_elf_resolve.py` | 実 ELF で **324葉すべてが `symbols[]` に現れ、うち `unresolved` 0 件**、各葉の `size` が typedef を辿った正しい幅（`uint32_t`=4, `bool`=1, `int`=4）、匿名16個が合成名で列挙。`tree` ノード数 29。合成 fixture で enum / bitfield も断言。pytest 緑 |
| **S2** | sidecar 幅対応: `read8/16/32/64` による個別読み / block read は 4バイト整列・4バイト葉のみに限定 / 値は size 桁の hex / 真のダブルリード / tick flush / USBError の捕捉+再試行+明示メッセージ / tear と drop を正直に計上 | `scripts/live_poll.py`, **`tests/test_live_poll.py`（新規）** | 新規 pytest が次をすべて断言して緑: (a) 1/2/8バイト値が 2/4/16 桁小文字 hex にゼロ埋め (b) tick ごとに flush が呼ばれる（偽ファイルで write/flush 回数 = tick 数）(c) 1バイト読みが正しいバイトを返す (d) `size` 欠落 watch 項目を暗黙既定せず明示処理 (e) 2回一致しない値は tear として計上され drop 予算に反映 (f) USBError 相当の例外で明确规定メッセージが出て終了 code が分かる |
| **S3** | 宿主: P0-1,2,7,8,9,11,12,15 と D-3,4,5。`nmLookup` 実装 / 解決 JSON の **watchlist フィルタ**（D11, 単独関数としてテストする）/ `ResolvedSymbol`・`ElfResolution` の拡張と 2 箇所の写し出し先の全フィールド通過 / `ElfResolveRunner` に追加 argv / CSV export 到達可能化 + 回転後履歴を含む（D-11）/ build・flash 進捗の postMessage 化 / **`webview.html` 再代入の全面廃止**（P0-3, 既存11箇所の `live-drop` と 未解決/書込結果/進捗/ログを §3.3 のメッセージに変換）/ 回転で `headerSkipped` reset / clean exit でも **セッションを無期限に維持**（P0-12）/ USBError のユーザー向け日本語メッセージ / `checkProbeConflict` の反映 / `graph-download-csv` の実ハンドラ / size を書込経路に通す（D12）/ 構造体接頭辞削除 | `src/extension.ts`, `src/live/elfResolver.ts`, `src/live/manager.ts`, `src/live/poller.ts`（`assertCsvHeader` / `dropStats` を製品で使い、`pollConfigOf` / `TearGuard` は削除） | vitest 緑。加えて: (a) watchlist フィルタの単体テスト（355葉を渡しても sidecar に行くのは watchlist の葉だけ）(b) 解決 JSON に `kind`/`signed`/`tree` が含まれるテスト (c) **HTML 再代入に到達する経路が製品に存在しない**ことのテスト（`webview.html` への代入が `resolveWebviewView` の初期1回だけであることを assert） |
| **S4** | サイドバー UI: 差分レンダリング（`live-bootstrap` 起点）/ 型デコード付きテーブル / `thead` + empty state / 構造体折りたたみツリー / **葉の選択 UI（一括追加は上限つき・超過を必ず表示）** / `live-add`・`live-remove-names` の送信 / `live-remove` の行削除 / pause の視覚状態 / ボタンの disabled + 理由 / `flash-retry` の Reveal 条件 / ログ操作（clear/filter/autoscroll/Output）/ キーボード操作 / 言語統一 / `project-select` が `msg.dir` を尊重 | `src/panels/sidebar.ts` | webview スクリプトを `node:vm` + DOM スタブで跑的既存ハーネス（`tests/panel-scripts.test.ts` 方式）で: (a) `live-sample` が arrivals 順に差分更新され、`innerHTML` 差し替えが起きない (b) float / bool / signed / enum / string の表示が §3.4 と一致 (c) 一括追加が上限で止まり、超過件数が画面に出る |
| **S5** | Graph 実パネル: webview panel 化 / rAF バッチ / devicePixelRatio / 軸目盛+単位 / 凡例 / min・max・最新値の読み出し / 時間窓 / 系列 ON・OFF / resize 追従 / enum の名前ステップ描画 / CSV export ハンドラ | `src/live/graphPanel.ts` | 測定方法を定義する: webview が全 `draw()` 時間をリングバッファに記録し `data-testid="graph-perf"` で公開。受入は **200Hz 相当の `live-sample` 5,000件 × 8系列をホスト側テストで注入し、p95 フレーム時間 ≤ 16.7ms**、かつ **既知のランプ 0..100 を喂って min/max 読み出しが 0 と 100 に一致し y 写像が単調**。検証は `tests/panel-scripts.test.ts` と同じ canvas スタブで |
| **S6** | 統合 + 文書: 死んだレンダラ削除（`src/live/livePanel.ts`, `src/build/panel.ts`）と `src/panels/frames.ts` の整理（使われていない CSS と `PANEL_IDS`/`PANEL_TITLES` を落とす）/ 追加テストの削除（`tests/panel-scripts.test.ts:6-8,23-27`, `tests/ui-actions.test.ts:3,6-8`, `tests/flash.test.ts:12,99-101` の該当部分）/ README 書き換え（D-1, D-2）/ `rm -rf out/` | 全体 | tsc + vitest + pytest が緑。README が実装と一致し偽の記載が無い。`npm run package` で vsix が生成され、**その vsix の `out/extension.js` に `nmLookup = (name) => undefined` が無い**ことを grep で確認 |

**依存**: S1・S2 は独立。S3 は §3.1/§3.2 の契約に並列に進めてよい。S4・S5 は §3.3 の形に対して並列。
S6 は最後に統合のみ。S4/S5 が `src/extension.ts` を触る必要がある場合は S3 Via 契約（メッセージ形）だけを使う。

---

## 5. 検証計画（RULES.md §2 の blocking gate）

**flash は実行しない。dry-run のみ**（対象は実ロボット / §0-2）。

1. `npx tsc --noEmit` — 緑
2. lint: **N/A** — `package.json` に lint スクリプトも linter 依存も無い
3. `npx vitest run` — 緑
4. `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest -q` — 緑
5. `rm -rf out/ && npm run package` — vsix 生成（`npx tsc --noEmit` は何も出力しないので、
   `npx vsce package` 単独では**旧 JS を焼く**。必ず `npm run compile` を挟む）
6. 実機 E2E（直列・probe は1つだけ）:
   - `python3 scripts/live_poll.py --resolution <host が書いた live-resolution.json> --out .omo/session-work/e2e.csv --hz 100 --seconds 30 --target stm32g474retx`
     → 期待: `done: ticks=... drop_rate<1%`、CSV の `head -1` が正確に `timestamp,address,name,value`、
     `grep -v` で 1バイト値が 2桁、8バイト値が 16桁であること
   - 10回連続 start/stop: **失敗ゼロは目標であって受入ではない**（初回接続の 1/11 失敗は未解決）。
     受入は「10回中 N 回成功し、各失敗が `live-status.state === "error"` と原因テキスト
     （`Errno 110` 等の生文字列）を伴う」こと
   - 検証後に `is_halted() == False` を確認（halt を残さない）
   - 結果を `.omo/session-work/e2e-result.md` に記録する
7. **実機 Flash**: 実行しない。dry-run（`--dry-run` のコマンド生成結果）だけを §5 の記録に残す

---

## 6. リスク

| リスク | 影響 | 対処 |
|---|---|---|
| USB timeout の根本原因が未特定（11回中1回、「アイドル後初回」仮説は棄却） | S2 の再試行で表面だけ改善 | pyOCD 内部例外の完全取得で切り分け。3回失敗したら設計相談（`skill://debugging` の手順） |
| typedef 追跡 / `DW_AT_encoding` 数値判定の誤り | size=0 や符号反転が静かに混入し、表示と書込幅が壊れる | S1 の pytest で typedef ケース（`uint32_t` 等）を実 ELF で必ず assert |
| 匿名 16 構造体の合成名が実機 firmware の利用率と合わない | ユーザが見慣れた名前で参照できない | 命名規則（§3.1）を文書化し、tree のラベルには型名（`Controller` 等）を併記する |
| `webview.html` 再代入の廃止で UI が凍る（メッセージ変換漏れ） | 画面の情報が一切更新されなくなる | §3.3 の全 message kind を S3 の受入テストで網羅。不足は S4 へ報告して一体化 |
| `read_memory_block32` の戻り値形の未確認 | block 経路の 1/2バイト処理が誤る | D5 で block を「4バイト境界に整列した4バイト葉」に限定しており、この API の制約に当たらない。非4バイトは個別 read |
| サイドバーの state 一本化が、既に動作確認済みの挙動を壊す | 退行 | S3 の html 再代入廃止は postMessage 経路へ一本化してから切り替える |
| git 管理が無い | ロールバック不能 | §0-1 のスナップショットのみ（本作業前にユーザーへ `git init` の可否を提示予定） |

---

## 7. 未確定事項（unverified と明記）

- USB timeout の発生条件。11回中1回で再現せず、「30s アイドル後」は 3/3 成功。probe 初回列挙か、
  カーネル USB 層か、pyOCD 内部のラッパー例外か、まだ特定できていない
- pyOCD の 32bit read が非整列アドレスで fault するか（1/2バイト読みの実装方式に影響）
- typedef を辿った先の base type の size 解決が、再帰的な typedef（配列の要素型等）で破綻しないか
- `read_memory_block`（byte 版）の pyOCD における戻り値形。存在するかは未確認
- 実 ELF には bitfield も DebugGlobal 配下の enum 型葉も 0 件（§1.2）。合成 fixture でのみ担保する
