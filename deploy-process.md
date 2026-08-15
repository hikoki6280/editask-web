# デプロイ手順

このディレクトリは、単体リポジトリ `editask-web` として使う前提です。

## 1. GitHub リポジトリを作成する

GitHub で新しいリポジトリを作成します。

```text
editask-web
```

別のリポジトリ名にする場合は、`vite.config.ts` の `base` も変更してください。

```ts
base: '/editask-web/',
```

## 2. ローカルから push する

`editask-web` ディレクトリ内で実行します。

```powershell
git init
git branch -M main
git add .
git commit -m "Initial editask web app"
git remote add origin https://github.com/{your-user}/editask-web.git
git push -u origin main
```

`{your-user}` は自分の GitHub ユーザー名に置き換えてください。

## 3. GitHub Pages を有効にする

GitHub リポジトリで以下を開きます。

```text
Settings -> Pages
```

次のように設定します。

```text
Source: GitHub Actions
```

このリポジトリには `.github/workflows/deploy.yml` が含まれています。`main` に push すると GitHub Actions が `npm run build` を実行し、生成された `dist` を GitHub Pages にデプロイします。

## 4. Firebase の環境変数を GitHub に登録する

GitHub Pages 上では `.env.local` は使われません。Firebase の設定値は、GitHub Actions のビルド時に Repository variables から渡します。

GitHub リポジトリで以下を開きます。

```text
Settings -> Secrets and variables -> Actions -> Variables
```

`New repository variable` から、`.env.local` の内容を **1行ずつ別々の Variable として** 登録します。

例えば `.env.local` が以下の場合:

```env
VITE_FIREBASE_API_KEY=abc
VITE_FIREBASE_AUTH_DOMAIN=example.firebaseapp.com
```

GitHub では次のように2つの Variable を作ります。

```text
Name: VITE_FIREBASE_API_KEY
Value: abc
```

```text
Name: VITE_FIREBASE_AUTH_DOMAIN
Value: example.firebaseapp.com
```

`.env.local` 全体を1つの Variable に貼り付けないでください。必ずキーごとに分けて登録します。

登録する Variable は以下です。

```text
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_APP_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
```

最低限、以下の4つがないとアプリは起動しません。

```text
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_APP_ID
```

設定が不足していると、デプロイ後に以下のような画面が出ます。

```text
Firebase environment variables are missing.
```

その場合は Repository variables を追加・修正してから、GitHub Actions を再実行してください。

```text
Actions -> Deploy GitHub Pages -> Run workflow
```

Firebase Web API key は公開されるクライアント設定です。データ保護は Firestore Security Rules と Google Authentication で行います。

## 5. Firebase Console を設定する

Firebase Console で以下を確認します。

```text
Authentication -> Sign-in method -> Google: enabled
Firestore Database: created
```

Authentication の承認済みドメインに GitHub Pages のドメインを追加します。

```text
{your-user}.github.io
```

Firestore Rules には、このリポジトリの `firestore.rules` の内容を設定します。

```text
Firestore Database -> Rules
```

現在のルールでは、ログインユーザーは自分の UID 配下だけを読み書きできます。

```text
users/{uid}/files/{file}
```

一般ユーザー同士ではデータは見えません。ただし Firebase プロジェクトの管理者は Firebase Console からデータを確認できます。

## 6. デプロイする

`main` に push します。

```powershell
git push
```

または GitHub Actions から手動実行します。

```text
Actions -> Deploy GitHub Pages -> Run workflow
```

デプロイ後、以下を開きます。

```text
https://{your-user}.github.io/editask-web/
```

初回デプロイは反映まで数分かかることがあります。

## 7. ローカル開発

依存関係をインストールします。

```powershell
npm install
```

`.env.example` をコピーして `.env.local` を作ります。

```powershell
Copy-Item .env.example .env.local
```

`.env.local` に Firebase Web app config を入力します。

開発サーバーを起動します。

```powershell
npm run dev
```

通常は以下で開きます。

```text
http://localhost:5173/editask-web/
```

## 8. 手元でビルド確認する

push 前に production build を確認できます。

```powershell
npm run build
```
