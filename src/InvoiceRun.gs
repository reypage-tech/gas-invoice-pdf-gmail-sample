/**
 * 「請求キュー」シートの行から PDF・Drive・Gmail 下書きまで一括処理する入口。
 * マスタタブ名は Customers, Products, Invoices, Invoice lines, Settings を想定。
 */

var QUEUE_SHEET = '請求キュー';
var QUEUE_HEADER = ['invoice_number', 'to_email', 'subject', 'body', 'status', 'pdf_url', 'draft_id', 'note'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('請求書部品')
    .addItem('キューから PDF と下書きを作る', 'processInvoiceQueue')
    .addToUi();
}

function ensureQueueSheet_(ss) {
  var sh = ss.getSheetByName(QUEUE_SHEET) || ss.insertSheet(QUEUE_SHEET);
  if (sh.getLastRow() === 0) sh.appendRow(QUEUE_HEADER);
  return sh;
}

/** @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss */
function readTable_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) return [];
  var v = sh.getDataRange().getValues();
  var head = v.shift();
  return v.filter(function (r) { return r.join('') !== ''; }).map(function (r) {
    var o = {};
    head.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

/** Settings タブ（key/value）を { key: value } のオブジェクトに変換する。 */
function readSettings_(ss) {
  var s = {};
  readTable_(ss, 'Settings').forEach(function (r) { s[r.key] = r.value; });
  return s;
}

/**
 * 未処理行（status が空）を上から処理する。
 * dryRun が true の場合、宛先・明細・合計突き合わせのチェックのみ行い、PDF作成・下書き作成は行わない（status には DRYRUN を書き戻す。DRYRUN の行は次の本番実行で未処理として扱う）。
 * 合計突き合わせ（reconcileInvoiceTotals_）は dryRun の指定に関わらず行い、不一致なら ERROR として記録する。
 * @param {{maxRows?:number, driveRootFolderId?:string, dryRun?:boolean}} options
 */
function processInvoiceQueue(options) {
  options = options || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var queueSh = ensureQueueSheet_(ss);
  var values = queueSh.getDataRange().getValues();
  if (values.length < 2) return { processed: 0 };

  var customers = readTable_(ss, 'Customers');
  var products = readTable_(ss, 'Products');
  var invoices = readTable_(ss, 'Invoices');
  var invLines = readTable_(ss, 'Invoice lines');
  var settings = readSettings_(ss);
  var registrationNumber = settings.registration_number || '';
  var maxRows = options.maxRows || 10;
  var processed = 0;

  for (var i = 1; i < values.length && processed < maxRows; i++) {
    var row = values[i];
    var status = String(row[4] || '').trim();
    if (status && status !== 'DRYRUN') continue; // 空またはDRYRUNは未処理として扱う

    var invNo = String(row[0] || '').trim();
    var toEmail = String(row[1] || '').trim();
    var subject = String(row[2] || '').trim();
    var body = String(row[3] || '').trim();
    var note = '';

    try {
      var invoice = invoices.filter(function (x) { return String(x.number) === invNo; })[0];
      if (!invoice) throw new Error('Invoices に番号がありません: ' + invNo);
      var customer = customers.filter(function (c) { return c.customer_id === invoice.customer_id; })[0];
      if (!customer) throw new Error('Customers に ID がありません: ' + invoice.customer_id);
      if (!toEmail && customer.billing_email) toEmail = String(customer.billing_email);
      if (!toEmail) throw new Error('宛先メールアドレスが空です: ' + invNo);
      var lineDetails = buildInvoiceLineDetails(invoice, invLines, products, customer.vat_status, settings);
      if (!lineDetails.length) throw new Error('明細が0件です: ' + invNo);

      var totals = invoiceTotals(
        products,
        lineDetails.map(function (d) { return { sku: d.sku, qty: d.qty }; }),
        customer.vat_status,
        settings
      );
      var recorded = { net: Number(invoice.net), vat: Number(invoice.vat), gross: Number(invoice.gross) };
      var reconcile = reconcileInvoiceTotals_(totals, recorded);
      if (!reconcile.ok) {
        var mismatchNote = '合計不一致: ' + reconcile.reasons.join(' / ');
        if (typeof Logger !== 'undefined' && Logger.log) Logger.log('[processInvoiceQueue] ' + invNo + ': ' + mismatchNote);
        throw new Error(mismatchNote);
      }

      if (options.dryRun) {
        queueSh.getRange(i + 1, 5, 1, 4).setValues([['DRYRUN', '', '', '']]);
        processed++;
        continue;
      }

      var pdfOpts = {
        driveRootFolderId: options.driveRootFolderId,
        registrationNumber: registrationNumber,
        byRate: totals.byRate
      };
      var pdf = createInvoicePdfOnDrive_(invoice, customer, lineDetails, pdfOpts);
      var draftId = createInvoiceGmailDraft_(
        toEmail,
        subject || buildDefaultDraftSubject_(invoice),
        body || buildDefaultDraftBody_(invoice, customer),
        pdf.blob,
        pdf.fileName
      );
      queueSh.getRange(i + 1, 5, 1, 4).setValues([['DONE', pdf.url, draftId, '']]);
      processed++;
    } catch (err) {
      note = String(err.message || err);
      queueSh.getRange(i + 1, 5, 1, 4).setValues([['ERROR', '', '', note]]);
    }
  }
  return { processed: processed };
}
