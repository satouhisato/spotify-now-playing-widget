# Spotify Now Playing Widget

Spotifyで現在再生中の曲のジャケット、曲名、アーティスト名だけを表示するTauri 2ウィジェットです。ドラッグ移動、自由なリサイズ、常時最前面に対応します。

## 1. Spotify側の準備
1. https://developer.spotify.com/dashboard でアプリを作成
2. Redirect URI に `http://127.0.0.1:43821/callback` を追加して保存（localhostではありません）
3. Client IDをコピー

## 2. 開発環境
- Node.js 20以上
- Rust stable
- Windowsの場合はMicrosoft C++ Build ToolsとWebView2（Tauri公式Prerequisites参照）

## 3. 起動
```bash
npm install
npm run tauri dev
```
初回画面にClient IDを貼り、「Spotifyに接続」を押します。ブラウザで許可すると表示が始まります。4秒ごとに曲を確認します。

## 4. 配布用ビルド
```bash
npm run tauri build
```
生成物は `src-tauri/target/release/bundle/` に入ります。

## 5. Windowsでの通常利用
`src-tauri/target/release/bundle/nsis/` に生成されたセットアップEXEを使ってインストールし、スタートメニューから起動します。通常利用ではPowerShellや開発用ターミナルを開いておく必要はありません。

インストール版を初めて起動すると、Windowsへのサインイン時に自動起動するよう登録されます。開発版の起動では自動起動設定を変更しません。

## 操作
- カードの空いている部分をドラッグ: 移動
- 辺・四隅をドラッグ: リサイズ
- マウスを置く: 閉じるボタン表示
- ダブルクリック: Spotifyの曲ページを開く

## 注意
Spotify Developer Dashboardの開発モードでは、利用可能ユーザーの設定が必要になる場合があります。トークンはOSの設定ディレクトリ内 `spotify-now-playing-widget/tokens.json` に保存されます。個人利用向けの最小実装です。
