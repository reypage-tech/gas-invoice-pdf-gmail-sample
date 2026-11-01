/**
 * 請求書 PDF を Google ドキュメント経由で生成し Drive に保存する。
 * Drive 高度なサービス（Drive.Files.export）が必要です。
 */

var INVOICE_PROP_DRIVE_ROOT = 'INVOICE_DRIVE_ROOT_FOLDER_ID';

/**
 * @param {Object} invoice Invoices タブの1行相当
 * @param {Object} customer Customers タブの1行相当
 * @param {Object[]} lineDetails buildInvoiceLineDetails の結果
 * @param {{driveRootFolderId?:string}} opts
 * @returns {{fileId:string, url:string, fileName:string, blob:GoogleAppsScript.Base.Blob}}
 */
function createInvoicePdfOnDrive_(invoice, customer, lineDetails, opts) {
  opts = opts || {};
  var rootId = opts.driveRootFolderId || PropertiesService.getScriptProperties().getProperty(INVOICE_PROP_DRIVE_ROOT);
  if (!rootId) throw new Error('スクリプトプロパティ未設定: ' + INVOICE_PROP_DRIVE_ROOT);

  var fileName = String(invoice.number) + '_' + String(customer.customer_id) + '_invoice.pdf';
  var monthFolder = getOrCreateMonthFolder_(rootId, String(invoice.date).slice(0, 7));
  var bodyText = renderInvoicePlainText_(invoice, customer, lineDetails, opts);

  return invoiceWithRetry_(function () {
    var doc = DocumentApp.create('tmp_invoice_' + invoice.number);
    var docId = doc.getId();
    try {
      var body = doc.getBody();
      body.clear();
      body.appendParagraph('請求書（見本／架空データ）').setHeading(DocumentApp.ParagraphHeading.HEADING1);
      bodyText.split('\n').forEach(function (line) {
        if (line) body.appendParagraph(line);
      });
      doc.saveAndClose();
      var pdfBlob = Drive.Files.export(docId, 'application/pdf');
      pdfBlob.setName(fileName);
      var pdfFile = Drive.Files.create({ name: fileName, parents: [monthFolder] }, pdfBlob);
      return { fileId: pdfFile.id, url: 'https://drive.google.com/file/d/' + pdfFile.id + '/view', fileName: fileName, blob: pdfBlob };
    } finally {
      try {
        Drive.Files.update({ trashed: true }, docId);
      } catch (trashErr) {
        // 元の例外（あれば）を隠さないため、ここでは握り潰すのみに留める。一時ファイルが残る可能性は README の制約に記載。
      }
    }
  });
}

/** @param {string} rootFolderId @param {string} yyyyMm */
function getOrCreateMonthFolder_(rootFolderId, yyyyMm) {
  var root = DriveApp.getFolderById(rootFolderId);
  var it = root.getFoldersByName(yyyyMm);
  if (it.hasNext()) return it.next().getId();
  return root.createFolder(yyyyMm).getId();
}

/**
 * @param {Object} invoice @param {Object} customer @param {Object[]} lineDetails
 * @param {{registrationNumber?:string, byRate?:{rate:number,taxable:number,tax:number}[]}} opts
 */
function renderInvoicePlainText_(invoice, customer, lineDetails, opts) {
  opts = opts || {};
  var lines = [
    '請求書番号: ' + invoice.number,
    '種別: ' + invoice.doc_type,
    '登録番号: ' + (opts.registrationNumber || '(未設定)'),
    '請求先ID: ' + customer.customer_id,
    '請求先名: ' + customer.name,
    '請求日: ' + invoice.date,
    '支払期限: ' + invoice.due_date,
    '通貨: ' + invoice.currency,
    '',
    '明細:'
  ];
  lineDetails.forEach(function (d) {
    lines.push('- ' + d.sku + ' / ' + d.name + ' / 数量 ' + d.qty + ' / 単価 ' + d.unitPrice + ' / 小計 ' + d.lineNet + ' / 税率 ' + d.rate + '%' + (d.reduced ? ' ※' : ''));
  });
  if (lineDetails.some(function (d) { return d.reduced; })) {
    lines.push('');
    lines.push('※は軽減税率対象');
  }
  lines.push('');
  lines.push('税率ごとの内訳（消費税額は税率ごとに1回切り捨て。詳細はREADME参照）:');
  (opts.byRate || []).forEach(function (r) {
    lines.push('- ' + r.rate + '%対象 / 対象額 ' + r.taxable + ' / 消費税 ' + r.tax);
  });
  lines.push('');
  lines.push('税抜合計: ' + invoice.net);
  lines.push('消費税合計: ' + invoice.vat);
  lines.push('税込合計: ' + invoice.gross);
  lines.push('');
  lines.push('※ Apps Script 部品の見本です。送信は行いません。インボイス制度の要件充足はご自身で税理士等にご確認ください。');
  return lines.join('\n');
}

if (typeof module !== 'undefined') {
  module.exports = {
    createInvoicePdfOnDrive_: createInvoicePdfOnDrive_,
    getOrCreateMonthFolder_: getOrCreateMonthFolder_,
    renderInvoicePlainText_: renderInvoicePlainText_
  };
}
