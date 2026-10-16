# CLI 実機テスト結果 — flash / 変数監視 (unit_omni3, 2026-10-07)

拡張機能に追加した `stm32 flash` / `stm32 poll` を実機の unit_omni3 (STM32G474RETx)
で検証した記録。CLI 実装は `b67dd53`。所要時間・値は実測。

## 環境

| 項目 | 値 |
|---|---|
| 対象基板 | unit_omni3 (モーター制御, FDCAN2 駆動) |
| MCU | STM32G474RETx |
| プローブ | ST-LINK/V2 (`0483:3748`) |
| ELF | `unit_omni3/build-ext/unit_omni3.elf` (3453824 bytes, mtime 2026-10-07T09:46Z) |
| 実行者 | DSH エージェント (CLI 経由, GUI 不使用) |

## 1. 書き込み — 成功

コマンド:

```bash
node out/cli/stm32.js flash unit_omni3/build-ext/unit_omni3.elf \
  --target stm32g474retx --yes
```

実行された argv (`--dry-run` で先に形状確認済み):

```
pyocd load --target stm32g474retx --format elf --connect under-reset <elf>
```

結果:

```json
{"ok":true,"op":"flash","message":"書き込み + 検証 OK"}
exit=0  elapsed=10628ms  outBytes=510
```

- verify は pyOCD が常時実施 (無効化オプションなし)
- dry-run は確認プロンプトを要求せず、実書き込みは `--yes` または TTY プロンプトを要求
- 非 TTY かつ `--yes` なしは書き込み前に拒否 (実測: `exit=2`)

## 2. 変数読み出し — 成功

```bash
node out/cli/stm32.js get <name> --elf <elf> --target stm32g474retx
```

| シンボル | 生値 | 解釈 |
|---|---|---|
| `sys.loop_hz` | `0x596` | 1430 Hz |
| `sys.loop_period_us` | `0x1c6` | 454 µs |
| `sys.uptime_ms` | `0x45ca` | 17866 ms |
| `drive.drive_mode` | `0x0` | 停止 |
| `comm.tn3_rx_count` | `0x0` | TERUNET3 受信なし |
| `comm.tn3_tx_count` | `0x965` | 2405 |
| `drive.motor_timeout` | `0x01` | true (指令が無くタイムアウト中 = 安全側) |

書き込み直後の基板は `drive.motor_timeout = true`、`drive.drive_mode = 0` で
モーターは停止状態だった。

## 3. 連続監視 (`poll`) — 成功

```bash
node out/cli/stm32.js poll sys.uptime_ms sys.loop_hz \
  --elf <elf> --target stm32g474retx --count 4 --interval-ms 400
```

| tick | uptime_ms (10進) | loop_hz |
|---|---|---|
| 0 | 34366 | 1431 |
| 1 | 38703 | 1428 |
| 2 | 42964 | 1429 |
| 3 | 47246 | 1428 |

uptime は単調増加、loop_hz は安定。stdout は JSON 一行で `samples` 配列に落ちる。

## 4. 書き込みゲート (`set`) — 拒否動作を確認

実際の値書き換えは行わず、ゲートのみ検証:

```
set sys.loop_hz 1000 (--yes なし, 非 TTY)
→ {"ok":false,"op":"set","stage":"op","error":"refused: modal confirmation not given"}
```

`--yes` なしでは sidecar に到達しない。モーター系パスは
`isMotorDrivePath` により `MOTOR_DRIVE_WARNING` が出る。

## 検出した問題と修正

### A. `poll` がサンプル毎に worker を起動する — 修正済み

修正前は `samples` 1 件ごとに python worker + pyOCD attach が走るため、実測で
**約 4.3 秒/サンプル**。`--interval-ms 400` は「サンプル間の sleep」であって
実周期ではなかった (uptime が 4337 ms 進んだことで確認)。

`scripts/probe_op.py` に `poll` op を追加し、CLI は worker を **1 回だけ**
起動する形に変更した。worker は attach を 1 回で済ませ、`count × names` を
ループしてサンプリングする。全 name はバスに触る前に解決するので、打ち間違いは
実行途中ではなく `stage: "resolve"` で即座に落ちる。読み取り専用で書き込まない。

spawn のタイムアウトも修正した。既定 60 秒は解決 (elf_resolve 2 回) + 全 tick を
賄えず、長い poll を実行途中で SIGKILL する。`60s × 2 + count × (interval + 1s)`
(上限 30 分) を渡す。

修正後の実測 (`--count 6 --interval-ms 500`):

| tick | uptime_ms | 前 tick との差 |
|---|---|---|
| 0 | 800181 | — |
| 1 | 800678 | 497 ms |
| 2 | 801185 | 507 ms |
| 3 | 801688 | 503 ms |
| 4 | 802193 | 505 ms |
| 5 | 802698 | 505 ms |

`loop_hz` は 1427〜1430 で安定。要求 500 ms に対し実測 497〜507 ms (誤差 ~1.4%)。
コマンド全体は 11.3 秒 (解決 ~5.5s + attach ~2.5s + sleep 3s)。

### B. `ls` と `get`/`set` で解決モードが違う — 修正済み

| コマンド | 修正前の elf_resolve モード | シンボル数 |
|---|---|---|
| `ls` | `--catalog` | 4291 |
| `get` / `set` | `--all-members` | 338 |

当初は「catalog が all-members の上位集合」と想定していたが、実測すると
**ほぼ排他**だった:

```
--all-members 338 件, --catalog 4291 件, 名前の重複は 10 件のみ
all-members にあり catalog に無い: 328 件 (sys.loop_min_us, sys.io.total, comm.link.* ...)
catalog にあり all-members に無い: 4281 件 (robot.yaw, monitor_wheel.* ...)
同じ名前で別アドレス: 0 件
```

どちらも上位集合ではないため、片方に寄せるともう片方が読めなくなる。ずれは
双方向だった — `ls` は読めない `robot.yaw` を提示し、`ls` は読める
`sys.loop_min_us` を隠していた。

修正は **和集合**。`probe_op.py` の `load_res` が 2 モードを実行して名前で
マージし (`--all-members` 優先、重複なし)、`ls` もこれを使う。1 つのローダが
全 op の「解決できる名前」を定義する状態にした。

`src/live/allowlist.ts` は「DebugGlobal フェンスはもう無い」と明記しており、
GUI と `live_poll.py --extra` は元々カタログ側も扱える。カタログ候補は書込可能
RAM セクション (`.data/.bss/.ccmram/.ram/.sram/.noinit`) の `STT_OBJECT` に
限定されるため、HW レジスタを書く経路は増えない。`set` のゲート
(extent 適合 + 明示確認 + モーター警告) は変更していない。

修正後の実測 (unit_omni3):

```
ls                 → count 4619 (union), robot.yaw も sys.loop_min_us も含む
get robot.yaw      → ok, 0x20003584, size 4
get sys.loop_min_us→ ok, 0x20000448, size 4
```

`ls` の所要時間は elf_resolve 2 回で 3.2s → 5.5s。`set robot.yaw` を `--yes`
なしで実行すると従来どおり
`{"ok":false,"stage":"op","error":"refused: modal confirmation not given"}`
で拒否され、書き込みは発生しない。

### インストール版での最終確認

`~/.vscode/extensions/goodbye-cubeide.stm32-ext-2.0.6` の CLI を実機で実行
(`--count 3 --interval-ms 1000`):

| tick | uptime_ms | 差 | drive.motor_timeout | robot.yaw |
|---|---|---|---|---|
| 0 | 977878 | — | true | 0.0000 rad |
| 1 | 978878 | 1000 ms | true | 0.0000 rad |
| 2 | 979880 | 1002 ms | true | 0.0000 rad |

要求 1000 ms に対し実測 1000/1002 ms。`robot.yaw` は catalog 側にしか無い
シンボルで、B 修正前に `get` が拒否していたもの。コマンド全体 6.0 秒。

### C. インストール版 CLI が cwd 依存で動かない — 修正済み

修正前は、cwd が extension のインストール先 (またはその配下) でないと
worker を見つけられず、全 op が失敗していた:

```
cwd = firmware プロジェクト
→ {"ok":false,"op":"list","stage":"op",
   "error":"worker list returned non-JSON output: python3: can't open file
   '<cwd>/scripts/probe_op.py': [Errno 2] No such file or directory"}
```

原因は `src/cli/resolve.ts` の `defaultProbeOpScript()` が
`process.cwd()` から最大 6 階層遡って `scripts/probe_op.py` を探し、
見つからなければ `join(cwd, "scripts/probe_op.py")` を返していたこと。
worker の実体は extension 側 (`<ext>/scripts/probe_op.py`) にあり、
上書き用の環境変数も無かった (`resolveCliPaths` が読むのは
`XDG_DATA_HOME` / `STM32_ELF` / `STM32_TARGET` のみ)。

修正は探索根を 2 つにした。順序は cwd → モジュール自身のディレクトリで、
cwd 優先は従来どおり (展開済みチェックアウトやプロジェクト固有の worker が
引き続き勝つ)。モジュール側は `typeof __dirname` でガードしてあるので、
CJS 以外のロード (バンドラ/ESM) ではこの根を飛ばすだけで例外にならない。
探索の打ち切り (6 階層 / 親が自分自身) と、どちらの根にも無い場合の
cwd 相対フォールバック (既存のエラー文言) は変えていない。

修正後の実測 — cwd を firmware プロジェクト
(`/home/so/robocon_ubuntu/NHK2026/nhk-2026-b-ros-android-controller/main`、
`scripts/probe_op.py` を持たない) にして、インストール版 CLI を実行:

```
ls   → ok, count 4619, robot.yaw も sys.loop_min_us も含む
poll sys.uptime_ms sys.loop_hz --count 3 --interval-ms 1000
  tick 0 uptime 13990 ms
  tick 1 uptime 14991 ms  delta=1001 ms
  tick 2 uptime 15994 ms  delta=1003 ms
  loop_hz: [1429, 1430, 1431]
```

### 未対応 (本変更のスコープ外)

- `sys.loop_hz` (1430 Hz) と `sys.loop_period_us` (454 µs = 2202 Hz) は
  1.5 倍ほど食い違う。計測ウィンドウが違う可能性が高いが未確認。
- 高レート監視は従来どおり `scripts/live_poll.py` (常時接続サイドカー) の担当。
  CLI `poll` は「AI が数点サンプルして状態を確認する」用途。今回の実測では
  解決 (elf_resolve 2 回) + attach に約 3 秒の固定費が乗る。
- テスト `tests/csv-export.test.ts > never holds more than one chunk in memory`
  は `heapUsed` 計測のフレーク。本変更とは無関係 (`src/live/csvExport.js` のみ
  import) で、単独実行では 5 回連続 pass、並列実行時に落ちることがある。


