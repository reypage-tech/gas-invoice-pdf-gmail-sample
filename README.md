# 請求書 PDF 作成・Gmail 下書き（Google Apps Script 見本）

> 見本データのみを用いています。実在の会社・個人とは関係ありません。

## 概要

請求書マスタ（`Customers` / `Products` / `Invoices` / `Invoice lines` / `Settings`）と「請求キュー」シートを読み、1行ごとに次の処理をまとめて行う部品です。

1. 請求内容から本文を組み立て、Google ドキュメント経由で PDF を生成し Drive の `YYYY-MM` フォルダへ保存する
2. PDF を添付した Gmail の**下書き**を作成する（下書きのみで、送信 API は呼びません）
3. 「請求キュー」シートの該当行に `DONE`／`ERROR` と PDF の URL・下書き ID・エラー内容を書き戻す

メールの送信そのものは行わず、担当者が下書きの内容を確認してから手動で送る前提です。**実機（Google アカウント上での動作）は未確認**で、Node 上で金額ロジックのみ検証しています。

税区分（`vat_status`）は `LV`（海外取引向けの通常税率）・`EU`（域内取引、`reverse_charge_EU` が `TRUE` なら0%）・`NON_EU`（域外取引、`vat_rate_NON_EU` を使用）に加えて、国内取引向けに `STD`（標準税率10%）・`REDUCED`（軽減税率8%）を区分として扱います（`vatRateFor` / `docTypeFor`、`src/Logic.gs`）。`LV` / `STD` / `REDUCED` はいずれも各商品（`products.csv` の `vat_rate`）の税率をそのまま使う点が共通しており、同じ請求書内で `vat_rate` が異なる商品（10%と8%）を組み合わせれば、標準・軽減の混在した請求書を扱えます。`doc_type` は `LV` / `STD` / `REDUCED` が `INV`、`EU` / `NON_EU` が `PPR` になります。

適格請求書発行事業者の登録番号（`Settings.registration_number`、`T`+数字13桁）はPDF本文に印字します。`isValidInvoiceRegistrationNumber`（`src/Logic.gs`）は文字列の形式（`T`+数字13桁）のみを確認する部品で、実在の登録番号かどうかの確認（国税庁のサイト等での照合）は行いません。

消費税額の端数処理は、税率ごとに請求書1件につき1回だけ行い、円未満を切り捨てます（`invoiceTotals` の `byRate`、`src/Logic.gs`）。行（明細）ごとに端数処理してから合計する方式ではありません。切り捨て以外の端数処理（四捨五入・切り上げ）を採用する場合は `floorVatForRate_` の実装を変更してください。

PDF本文の明細行には行ごとの税率（%）を表示し、軽減税率（8%、`rate === 8`）の行には「※」を付けます（`buildInvoiceLineDetails`、`src/Logic.gs`）。※付きの行が1件以上あるときは、明細の下に欄外注記「※は軽減税率対象」を1行追加します（`renderInvoicePlainText_`、`src/InvoicePdf.gs`）。

`processInvoiceQueue` はPDF・Gmail下書きの作成前に、再計算した合計（税抜・消費税・税込、`invoiceTotals`）とInvoicesタブの記録値（`net`/`vat`/`gross`列）を `reconcileInvoiceTotals_`（`src/Logic.gs`、Google サービス非依存の純粋関数）で突き合わせます。1円でも不一致があれば、`dryRun` の指定に関わらずPDF・下書きを作らずに「請求キュー」シートの `status` を `ERROR`、`note` に不一致の理由（どの金額が計算値と記録値でいくつ違うか）を記録し、同じ理由をGASの `Logger` にも出力します。`reconcileInvoiceTotals_` は税率別内訳（`byRate`）の比較もできますが、Invoicesタブに税率別の列が無いため、`processInvoiceQueue` からの呼び出しでは税抜・消費税・税込のみを突き合わせています。

本見本はインボイス制度（適格請求書等保存方式）に関する国税庁の要件を網羅的に満たすことを保証するものではありません。税率区分・登録番号の表示・端数処理など、実際の請求書発行に利用する前に税理士等の専門家にご確認ください。

## ファイル構成

```
v2/
  src/
    Logic.gs          採番・税計算・明細組み立て・合計突き合わせ（reconcileInvoiceTotals_、Google サービス非依存）
    Retry.gs          再試行ヘルパー（invoiceWithRetry_ ほか）
    InvoicePdf.gs      Document 経由で PDF を生成し Drive へ保存（登録番号・税率別内訳・明細ごとの税率と軽減税率マークの印字を含む）
    InvoiceDraft.gs    PDF 添付の Gmail 下書きを作成
    InvoiceRun.gs      請求キュー処理の入口・メニュー登録
    appsscript.json    マニフェスト（スコープ・高度なサービス）
  sample_data/
    customers.csv        架空の請求先（国内取引、vat_status は STD/REDUCED）
    products.csv          架空の商品・単価・税率（10%と8%が混在）
    invoices.csv          架空の請求書（税抜・税・税込は Logic.gs の計算結果と一致）
    invoice_lines.csv     請求書ごとの明細行
    settings.csv          税区分・登録番号の例（reverse_charge_EU, vat_rate_NON_EU, registration_number）
    invoice_queue.csv     「請求キュー」シートに貼る例（3行目は宛先・顧客マスタ側のメールアドレスが
                          ともに空欄で、ERROR記録の動作確認用の行）
  tests/
    logic_test.js      Node でのロジック確認（金額・採番・再試行判定・税率別集計・端数・登録番号の形式）
    mime_test.js       Node でのMIME組み立て確認（buildMimeMessage_ ほか）
    pdf_test.js        Node でのPDF本文組み立て確認（renderInvoicePlainText_、GASサービスはモック不要）
    run_test.js        Node でのキュー走査ロジック確認（processInvoiceQueue、GASサービスはモック）
  README.md
  LICENSE
```

## 設定

1. 請求データのスプレッドシートに `Customers`, `Products`, `Invoices`, `Invoice lines`, `Settings` の各タブを用意します（列名は `sample_data/*.csv` の見出し行に合わせています）。`Customers` に任意列 `billing_email` を足すと、キューの `to_email` が空のときに使われます。`Settings` に `registration_number`（適格請求書発行事業者の登録番号、`T`+数字13桁）を設定すると、`processInvoiceQueue` が生成するPDFに印字されます。未設定の場合は「登録番号: (未設定)」と印字されます。
2. 同じスプレッドシートに「請求キュー」タブを用意します。無ければ `processInvoiceQueue` 実行時に自動作成されます（見出し行は `sample_data/invoice_queue.csv` と同じ）。
3. 拡張機能 > Apps Script に `src/*.gs` を貼り、マニフェストを `src/appsscript.json` に合わせます（clasp 利用可）。高度なサービスとして **Drive API v3**・**Gmail API v1** を有効にします（スクリプトエディタ左側メニューの「サービス」の＋ボタンから追加します）。
4. スクリプトプロパティに `INVOICE_DRIVE_ROOT_FOLDER_ID`（PDF を置く Drive フォルダ ID）を設定します（スクリプトエディタ左側メニューの「プロジェクトの設定」内「スクリプト プロパティ」から追加します）。
5. 必要な OAuth スコープ: `spreadsheets.currentonly`, `documents`, `drive`, `gmail.compose`（`src/appsscript.json` に含めています）。既存の任意のDriveフォルダを `DriveApp.getFolderById` で参照する構成のため、作成・編集したファイルのみに限定される `drive.file` では権限が不足する可能性があり、`drive`（フルアクセス）にしています。

## 使い方

メニュー「請求書部品」>「キューから PDF と下書きを作る」、またはスクリプトエディタから直接呼び出します。

```javascript
// 既定では未処理（status 空欄）の行を最大10件処理
processInvoiceQueue();

// 処理件数を変える
processInvoiceQueue({ maxRows: 5 });

// Drive ルートフォルダをスクリプトプロパティの代わりに引数で指定
processInvoiceQueue({ driveRootFolderId: '1AbCdEfGhIjKlMnOpQrStUvWxYz' });

// PDF作成・下書き作成を行わず、宛先メールアドレスの有無・明細1件以上のみ確認する
processInvoiceQueue({ dryRun: true });
```

処理結果は「請求キュー」シートの `status`（`DONE`/`ERROR`/`DRYRUN`）、`pdf_url`、`draft_id`、`note` 列に書き戻されます。1行の失敗は `ERROR` と理由を記録し、他の行の処理は継続します。宛先メールアドレスが空、明細が0件、または再計算した合計がInvoicesタブの記録値と1円でも不一致の行は、`dryRun` の指定に関わらず、PDF作成前に `ERROR` として記録されます（合計不一致の場合は `note` に不一致の理由も記録し、GASの `Logger` にも同じ理由を出力します）。これらのチェックを通過した行については、`dryRun: true` のときは PDF作成・下書き作成を行わず `DRYRUN` として記録し、指定がないときは通常どおり PDF作成・下書き作成を行って `DONE` として記録します。`status` が空または `DRYRUN` の行は未処理として扱うため、`dryRun` で確認したあとは列を戻さずにそのまま本番実行できます。

## テスト

```bash
cd v2
node tests/logic_test.js
node tests/mime_test.js
node tests/pdf_test.js
node tests/run_test.js
```

結果（箱の中で確認済み）:

```
ok nextInvoiceNumber
ok invoiceTotals
ok buildInvoiceLineDetails
ok buildInvoiceLineDetails は NON_EU の国別税率が偶然8%でも reduced:true を付けない(日本の軽減税率ではないため)
ok buildInvoiceLineDetails は軽減税率(8%)の行に reduced:true を付け、10%の行には付けない
ok httpShouldRetry
ok docTypeFor
ok formatMoney_
ok invoiceTotals error on unknown sku
ok invoiceTotals error on qty <= 0
ok vatRateFor EU reverse charge
ok vatRateFor STD/REDUCED は商品側の税率をそのまま使う
ok docTypeFor STD/REDUCED はINV
ok isValidInvoiceRegistrationNumber は T+数字13桁のみ許可
ok invoiceTotals は税率ごとに1回だけ切り捨てる(四捨五入なら80円になるケース)
ok invoiceTotals は同一請求書内の10%と8%の混在を税率ごとに集計する
ok reconcileInvoiceTotals_ は一致なら ok:true で reasons が空
ok reconcileInvoiceTotals_ は税抜(net)のずれを検出する
ok reconcileInvoiceTotals_ は消費税(vat)のずれを検出する
ok reconcileInvoiceTotals_ は税込(gross)のずれを検出する
ok reconcileInvoiceTotals_ は税率別内訳(byRate)のずれを検出する
ok invoiceDefaultShouldRetry_
ok invoiceWithRetry_ succeeds after transient failures
ok invoiceWithRetry_ throws after max attempts
ok invoiceWithRetry_ does not retry non-retryable errors
ok sample_data totals match invoices.csv

26 tests passed (sample_data: invoices=3, lines=5)
```

```
ok mimeEncodeHeader_ はUTF-8 Base64のエンコード済みヘッダーを返す
ok wrapBase64Lines_ は76文字ごとにCRLFで折り返す
ok buildMimeMessage_ は宛先・件名・添付ファイル名を含むMIME本文を組み立てる

3 tests passed
```

```
ok renderInvoicePlainText_ は登録番号と税率ごとの内訳(対象額・消費税額)を印字する

1 tests passed
```

```
ok processInvoiceQueue は宛先メールアドレスが空の行をERRORにし、processedに含めない
ok processInvoiceQueue の dryRun は副作用なしでDRYRUNを書き戻し、processedに含める
ok processInvoiceQueue は dryRun 後の DRYRUN 行を未処理として本番実行で処理する
ok processInvoiceQueue は合計不一致の行をdryRunでもERRORにし、PDF・下書きを作らない

4 tests passed
```

`tests/logic_test.js` は `Logic.gs`（採番・税計算・明細組み立て・税率別集計・端数処理・登録番号の形式チェック・`reconcileInvoiceTotals_` による合計突き合わせ）と `Retry.gs`（再試行判定・再試行ヘルパー本体）の純粋関数を検証しています。`reconcileInvoiceTotals_` については一致／税抜ずれ／消費税ずれ／税込ずれ／税率別内訳ずれの5パターンを確認し、`buildInvoiceLineDetails` については軽減税率(8%)の行にだけ `reduced:true` が付くこと、および `NON_EU` の国別税率が偶然8になっても `reduced:true` が付かないことを確認しています。`sample_data/*.csv` の架空の請求書3件・明細5行（10%と8%が混在）について、`invoiceTotals` の計算結果が `invoices.csv` の税抜・税・税込・`doc_type` と一致することも確認しています。`tests/mime_test.js` は `InvoiceDraft.gs` の `buildMimeMessage_` ほかのMIME組み立てを、`Utilities` を簡易モックして検証しています。`tests/pdf_test.js` は `InvoicePdf.gs` の `renderInvoicePlainText_` が登録番号・税率ごとの内訳・明細行ごとの税率と軽減税率マーク（※）・欄外注記（「※は軽減税率対象」）を本文に含めることを検証しています。`tests/run_test.js` は `InvoiceRun.gs` の `processInvoiceQueue`（`ERROR` 行が `processed` カウントに含まれない仕様・`dryRun` 時に副作用が発生しない仕様・生成するPDF本文に登録番号と税率別内訳が渡る仕様・合計不一致の行が `dryRun` の指定に関わらず `ERROR` になり副作用が発生しない仕様・`DRYRUN` 行を次の本番実行で未処理として処理する仕様）を、`SpreadsheetApp` / `Drive` / `Gmail` / `DocumentApp` / `PropertiesService` / `DriveApp` を簡易モックして検証しています。いずれもモックによる検証であり、実際の Google サービス呼び出し（実機）は未確認です。

### 実機確認の最小手順（未実施）

1. テスト用スプレッドシートに `Customers` / `Products` / `Invoices` / `Invoice lines` / `Settings` タブと「請求キュー」タブを `sample_data/*.csv` の内容で用意する（`invoice_queue.csv` の3行目は宛先・顧客マスタ側のメールアドレスがともに空欄のため、実行すると `ERROR`（宛先メールアドレスが空）になります。これは異常系の動作確認用の行であり、サンプルデータの不備ではありません）。
2. スクリプトプロパティに `INVOICE_DRIVE_ROOT_FOLDER_ID` を設定し、テスト用の Drive フォルダを指定する。
3. `processInvoiceQueue({ maxRows: 1, dryRun: true })` を実行し、副作用なしで検証だけ通るかを確認したうえで、`processInvoiceQueue({ maxRows: 1 })` で1行だけ実行し、Drive への PDF 作成・Gmail 下書き作成・「請求キュー」シートへの書き戻しをそれぞれ確認する。

この手順自体は未実施です。

## 扱える行数の目安（未検証）

架空データの請求書3件・明細5行でロジックの整合のみ確認しました。実際のスプレッドシート上での処理件数・1件あたりの所要時間（PDF生成・下書き作成を含む）は未検証です。`maxRows` で1回の呼び出しあたりの処理件数を絞れます。

Google Apps Script には1回の実行で6分の実行時間上限があります。1行あたりDocument作成、PDF変換、Drive保存、Gmail下書き作成を行うため、件数が多いと上限に達する可能性があります。`maxRows` の既定値を10件にしているのはこの想定によるもので、件数が多い場合は時間主導トリガーなどで呼び出しを分割する想定です。いずれも実機では未検証です。

処理済みの行には `status`（`DONE` または `ERROR`）が書き戻され、`processInvoiceQueue` は `status` が空の行だけを処理します。そのため時間主導トリガーなどで複数回に分けて呼び出しても、処理済みの行は次回実行時に自動でスキップされ、未処理の行から再開されます。

## 制約

- PDF 生成は `DocumentApp` で本文を組み立てたうえで `Drive.Files.export` を使うため、レイアウトは簡易な見本相当です。請求書らしい書式（ロゴ・表組みなど）は含みません。
- 明細行の軽減税率マーク「※」は、`docTypeFor(vatStatus)` が `INV`（`LV`/`STD`/`REDUCED`、商品側の `vat_rate` をそのまま使う国内向け区分）かつ `rate === 8` の行にのみ付けます。`NON_EU` の国別税率（`settings.vat_rate_NON_EU`）が偶然8になっても、日本の軽減税率ではないためマークは付けません（`EU`/`NON_EU` は `doc_type` が `PPR` になる海外向け書式のため対象外です）。
- `reconcileInvoiceTotals_` による合計突き合わせは、Invoicesタブに税率別内訳の列が無いため、税抜・消費税・税込の3項目のみを行っています。税率別内訳（`byRate`）の突き合わせ自体は関数として実装・テスト済みですが、`processInvoiceQueue` からは呼び出していません。
- Gmail は下書きの作成までで、送信は行いません。宛先・本文は担当者が下書き画面で確認する前提です。
- 税区分は `LV`（海外取引向けの通常税率）・`EU`（`reverse_charge_EU` が `TRUE` なら0%）・`NON_EU`（`vat_rate_NON_EU` を使用）・`STD`（国内標準10%）・`REDUCED`（国内軽減8%）の5種類を想定しています。`LV`/`STD`/`REDUCED`、およびそれ以外の未知の区分は、商品側の税率（`vat_rate`）をそのまま使います。
- 消費税額の端数処理は切り捨てのみ対応しています。四捨五入・切り上げなど他の端数処理が必要な場合は `src/Logic.gs` の `floorVatForRate_` を変更してください。
- `isValidInvoiceRegistrationNumber` は登録番号の文字列形式（`T`+数字13桁）のみを確認します。国税庁の公表情報との照合など、実在性の確認は行っていません。
- 一時的に作成する Google ドキュメントは PDF 出力後にゴミ箱へ移動しますが、完全削除は行いません。ゴミ箱への移動自体が失敗した場合は、一時ファイルが残る可能性があります（未確認）。
- Drive・Gmail の実際の権限エラーやレート制限時の挙動は未確認です。`invoiceWithRetry_` は429・5xx系のメッセージを対象に再試行しますが、実際のレスポンス形式での動作確認はしていません。
- PDF保存後にGmail下書きの作成で失敗した行を、ステータス欄を空にして再実行すると、同じファイル名のPDFがDriveに重複して作成されます。ファイル名の重複チェックは行っていません（未確認）。
- `src/Logic.gs` の `nextInvoiceNumber` は、請求書データ作成（Invoices タブへの行追加）という別工程で採番に使う想定の部品で、`processInvoiceQueue` 自体からは呼び出していません。`invoiceTotals` と `src/InvoiceRun.gs` の `readSettings_` は、`processInvoiceQueue` がPDF本文の税率別内訳・登録番号を組み立てる際に呼び出しています。`reconcileInvoiceTotals_` は、`processInvoiceQueue` がPDF・Gmail下書きの作成前に合計を突き合わせる際に呼び出しています。
