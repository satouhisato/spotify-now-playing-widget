# Spotify Now Playing Widget

Spotifyで再生中のジャケット、曲名、アーティスト名をデスクトップへ表示する、Windows向けのミニプレイヤーです。

再生ボタンを並べるのではなく、音楽を聴いている間の見た目と邪魔にならない操作感に特化しています。Tauri 2、React、Rustで動作します。

## 特徴

- ジャケットと、同じ画像を使ったぼかし背景を一体表示
- 曲変更を約0.4秒間隔で検知し、スライドとフェードで切り替え
- 幅180〜520px、高さ72〜180pxで自由にリサイズ
- 長い曲名とアーティスト名だけを自動スクロール
- 常に最前面へ表示し、通常のタスクバーボタンは非表示
- Windowsへのサインイン時に自動起動
- インストール版ではPowerShellや開発用ターミナルの常駐が不要
- スライド時間、背景ぼかし、文字サイズを設定画面から変更可能

## 必要なもの

- WindowsとWebView2
- Spotifyアカウント
- Spotify Developer Dashboardで作成したアプリのClient ID

Client Secretは使用しません。Spotifyへの接続にはAuthorization Code with PKCEを使用します。

## Spotifyの準備

1. [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)でアプリを作成します。
2. アプリのRedirect URIへ次のURLを追加して保存します。

   ```text
   http://127.0.0.1:43821/callback
   ```

   `localhost`ではなく、必ず`127.0.0.1`を使用してください。

3. Dashboardに表示されるClient IDをコピーします。
4. ウィジェットの初回画面へClient IDを貼り付け、「Spotifyに接続」を押します。
5. ブラウザでSpotifyへのアクセスを許可すると、再生情報の表示が始まります。

Spotify Developer Dashboardの開発モードでは、使用するSpotifyアカウントをアプリの許可ユーザーへ追加する必要がある場合があります。

## 通常利用

配布用ビルドで生成されたセットアップEXEを実行し、スタートメニューから`Spotify Now Playing Widget`を起動します。

インストール版は初回起動時にWindowsの自動起動へ登録されます。通常利用では、PowerShellやソースコードのフォルダを開いておく必要はありません。

## 操作

| 操作 | 動作 |
| --- | --- |
| 空いている部分をドラッグ | ウィジェットを移動 |
| 辺・四隅をドラッグ | 幅180〜520px、高さ72〜180pxでリサイズ |
| マウスを置く | 表示設定ボタンと閉じるボタンを表示 |
| 歯車ボタン | 表示設定を開く |
| ×ボタン | アプリを終了 |

横幅変更中は文字スクロールが停止します。リサイズが終わると表示幅を再計測し、必要な文字だけ先頭からスクロールを再開します。

## 表示設定

設定値は変更と同時にPC内へ保存され、次回起動時にも引き継がれます。

| 項目 | 範囲 | 初期値 |
| --- | --- | --- |
| スライド時間 | 0.4〜3.0秒 | 1.6秒 |
| 背景ぼかし | 0〜24px | 6px |
| 文字サイズ | 80〜140% | 100% |

「初期値に戻す」を押すと、上記の標準設定へ戻ります。設定画面を閉じると、ウィンドウは開く前のサイズへ戻ります。

## 曲情報の更新

- 再生中: 約0.4秒間隔
- 一時停止中・再生曲なし: 約1秒間隔
- 通信エラー時: 再試行間隔を自動的に延長

新しいジャケットを先読みしてから表示を切り替えるため、画像の読み込み状況によっては検知後にわずかな待ち時間が加わります。

## 開発

### 開発環境

- Node.js 20以上
- Rust stable
- Microsoft C++ Build Tools
- WebView2

TauriのWindows向け依存関係は[Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)も参照してください。

### セットアップと開発起動

```powershell
npm install
npm run tauri dev
```

開発版の起動では、Windowsの自動起動設定を変更しません。

### 確認

```powershell
npm run build
cd src-tauri
cargo fmt -- --check
cargo test --locked
```

### 配布用ビルド

```powershell
npm run tauri build
```

Windows用セットアップEXEは次のフォルダへ生成されます。

```text
src-tauri/target/release/bundle/nsis/
```

## 保存されるデータ

- SpotifyのClient IDと表示設定: WebViewのローカルストレージ
- Spotifyのアクセストークンと更新トークン: OSの設定ディレクトリ内にある`spotify-now-playing-widget/tokens.json`

認証トークンや個人用の設定ファイルをリポジトリへコミットしないでください。

## トラブルシューティング

### Spotify認証後も接続できない

- Redirect URIが`http://127.0.0.1:43821/callback`と完全に一致しているか確認してください。
- Spotify Developer Dashboardで設定を保存したか確認してください。
- 開発モードの場合は、使用中のSpotifyアカウントが許可ユーザーになっているか確認してください。

### 曲が表示されない

- Spotifyで実際に曲が再生されているか確認してください。
- 一度再生を開始し、最大数秒待ってください。
- 継続する場合はアプリを終了し、スタートメニューから再起動してください。

### PowerShellの画面が残る

`npm run tauri dev`などで起動した開発版ではなく、セットアップEXEからインストールした正式版をスタートメニューから起動してください。

## 更新履歴

バージョンごとの変更内容は[CHANGELOG.md](CHANGELOG.md)で確認できます。コード単位の詳細はGitHubのコミット履歴を参照してください。
