# goodbye_cubeide

STM32CubeIDE を使わずに、VSCode だけで STM32 ファームウェアを **ビルド → 書き込み → 変数監視 → グラフ** する拡張機能です。

```
[ VSCode サイドバー ]  プロジェクト → ビルド → 書き込み → 変数 → グラフ → ログ
[ Python サイドカー  ]  pyOCD で ST-LINK を叩き、DWARF の型で値を解釈
```

既存の `.cproject` を読むだけなので、コード生成の作り直しもしません。`STM32: 診断` で必要なツールの不足が分かります。

## 何ができますか

| | |
|---|---|
| **ビルド** | `.cproject` から `build-ext/build.ninja` を生成して `ninja` を実行。`ccache` 経由、進捗バーと Problems 連携つき |
| **書き込み** | 確認ダイアログ → 検証付き書き込み。`pyOCD` か `STM32_Programmer_CLI` のどちらでも |
| **変数監視** | `DebugGlobal` の葉を DWARF の型解釈付きで監視（既定 100Hz、最大 200Hz）。bool / float / enum / 符号付き / bitfield / string |
| **グラフ** | エディタ領域に開く実パネル。時間窓は 1/5/10/30/60 秒から選択、系列ごとの min/max/enum 名表示、CSV 出力 |
| **値の書込** | 1/2/4/8 バイト幅。対象は ELF で解決できる変数すべてで `DebugGlobal` の範囲には限らない。毎回 modal 確認と監査ログつき |
| **CSV** | 監視セッションとグラフが同じ 4 列スキーマ（`timestamp,address,name,value`）で出力 |

詳細は **[`stm32-ext/README.md`](stm32-ext/README.md)** にあります。設定一覧・コマンド一覧・トラブルシューティング・書き込みの安全規則はすべてそちらです。

## クイックスタート

```bash
git clone https://github.com/sosukigara/goodbye_cubeide.git
cd goodbye_cubeide/stm32-ext
npm ci
npm run verify        # typecheck → vitest → pytest → compile
```

`npm run verify` はビルド成果物の無い clone 直後で green になります。ツールが足りない環境では該当の test が skip されるので、`passed` / `skipped` の行をそのまま読んでください。

VSCode に読み込む:

```bash
npm run package       # stm32-ext-<version>.vsix
code --install-extension stm32-ext-*.vsix
```

表示したら `Developer: Reload Window`。

**設定ファイルは触らなくて構いません。** `probe` / `interface` / `resetMode` / `pollHz` は既定値で動きます。

## 必要なもの

拡張機能を **入れるだけ** なら Node.js 18+ と npm だけです。**実機で動かす** には下表のツールが要ります。足りないものは `STM32: 診断` が導入コマンド付きで教えてくれます。

| | 必須 | 用途 |
|---|---|---|
| Node.js 18+ / npm | ○ | パッケージング |
| `arm-none-eabi-gcc` | ○ | ファームウェアのコンパイル |
| `ninja` | ○ | ビルドの実行 |
| `python3` | ○ | DWARF の型解決と Live 監視のサイドカー |
| `pyocd` | △ | 書き込みと Live 監視（`pip install --user pyocd`） |
| `ccache` | △ | ビルドキャッシュ。無くても動きますが遅くなります |
| `pyelftools` | △ | DWARF の型解決。無いと型情報が付きません（`0x… 型不明` と表示） |
| ST-LINK | 実機のみ | 接続 |

導入例:

```bash
sudo apt install gcc-arm-none-eabi ninja-build python3 ccache python3-pyelftools
pip install --user pyocd pyelftools
```

`pyocd` が無くても **ビルドと型解析は動きます**。表の `△` は「その機能だけ使えない」という意味です。

ソースツリーに `.cproject` があることが前提です。Live 監視は Python サイドカーで、**GDB ではありません**（`arm-none-eabi-gdb` は要りません）。

## リポジトリ構成

| | |
|---|---|
| `stm32-ext/` | 拡張機能本体（TypeScript + Python）。`README.md` は詳細仕様 |
| `stm32-cubeide-alt.md` | 当初の作業計画 |
| `docs/` | 設計・検証記録 |
| `LICENSE` | MIT |

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
