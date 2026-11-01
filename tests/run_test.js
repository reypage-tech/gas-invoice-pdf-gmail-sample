const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function csvRows(file) {
  return fs.readFileSync(path.join(__dirname, '..', 'sample_data', file), 'utf8')
    .trim().split('\n').map(function (l) { return l.split(','); });
}

function makeBlob(name) {
  var bytes = Buffer.from('PDF-BYTES');
  return {
    name: name,
    setName: function (n) { this.name = n; },
    getBytes: function () { return bytes; }
  };
}

function makeSheetFromRows(rows) {
  var values = rows.map(function (r) { return r.slice(); });
  return {
    getDataRange: function () {
      return { getValues: function () { return values.map(function (r) { return r.slice(); }); } };
    },
    getLastRow: function () { return values.length; },
    getRange: function (r, c, nr, nc) {
      return {
        setValues: function (v) {
          for (var i = 0; i < nr; i++) {
            for (var j = 0; j < nc; j++) values[r - 1 + i][c - 1 + j] = v[i][j];
          }
        }
      };
    },
    appendRow: function (row) { values.push(row); }
  };
}

function makeSpreadsheet(sheets) {
  return {
    getSheetByName: function (name) { return sheets[name]; },
    insertSheet: function (name) {
      var sh = makeSheetFromRows([]);
      sheets[name] = sh;
      return sh;
    }
  };
}

/** Logic.gs/Retry.gs/InvoicePdf.gs/InvoiceDraft.gs/InvoiceRun.gs を GAS グローバル相当のモックを注入した同一vmコンテキストで読み込む。 */
function loadInvoiceRunContext(sheets) {
  var docCounter = 0, pdfCounter = 0, draftCounter = 0;
  var calls = { documentCreate: 0, draftCreate: 0 };
  var docBodies = {};

  var sandbox = {
    console: console,
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return makeSpreadsheet(sheets); }
    },
    PropertiesService: {
      getScriptProperties: function () {
        return { getProperty: function () { return 'ROOT_FOLDER_ID'; } };
      }
    },
    DriveApp: {
      getFolderById: function () {
        return {
          getFoldersByName: function () { return { hasNext: function () { return false; } }; },
          createFolder: function () { return { getId: function () { return 'MONTH_FOLDER_ID'; } }; }
        };
      }
    },
    Drive: {
      Files: {
        export: function () { return makeBlob('tmp.pdf'); },
        create: function () { pdfCounter++; return { id: 'PDF_FILE_ID_' + pdfCounter }; },
        update: function () { return {}; },
        get: function () { return makeBlob('fallback.pdf'); }
      }
    },
    DocumentApp: {
      ParagraphHeading: { HEADING1: 'HEADING1' },
      create: function () {
        docCounter++;
        calls.documentCreate++;
        var docId = 'DOC_ID_' + docCounter;
        docBodies[docId] = [];
        return {
          getId: function () { return docId; },
          getBody: function () {
            return {
              clear: function () {},
              appendParagraph: function (text) {
                docBodies[docId].push(text);
                return { setHeading: function () {} };
              }
            };
          },
          saveAndClose: function () {}
        };
      }
    },
    Gmail: {
      Users: {
        Drafts: {
          create: function () { draftCounter++; calls.draftCreate++; return { id: 'DRAFT_ID_' + draftCounter }; }
        }
      }
    },
    Utilities: {
      sleep: function () {},
      Charset: { UTF_8: 'UTF-8' },
      base64Encode: function (data) {
        var buf = Array.isArray(data) || Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data), 'utf8');
        return buf.toString('base64');
      },
      base64EncodeWebSafe: function (bytes) {
        return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      },
      newBlob: function (bytesOrString) {
        var bytes = Buffer.isBuffer(bytesOrString) ? bytesOrString : Buffer.from(String(bytesOrString));
        return { getBytes: function () { return bytes; } };
      },
      getUuid: function () { return '11111111-2222-3333-4444-555555555555'; }
    }
  };

  var context = vm.createContext(sandbox);
  ['Logic.gs', 'Retry.gs', 'InvoicePdf.gs', 'InvoiceDraft.gs', 'InvoiceRun.gs'].forEach(function (file) {
    var code = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  });
  context.__calls = calls;
  context.__docBodies = docBodies;
  return context;
}

function buildSheets() {
  return {
    Customers: makeSheetFromRows(csvRows('customers.csv')),
    Products: makeSheetFromRows(csvRows('products.csv')),
    Invoices: makeSheetFromRows(csvRows('invoices.csv')),
    'Invoice lines': makeSheetFromRows(csvRows('invoice_lines.csv')),
    Settings: makeSheetFromRows(csvRows('settings.csv')),
    '請求キュー': makeSheetFromRows(csvRows('invoice_queue.csv'))
  };
}

let pass = 0;
function t(name, fn) {
  fn();
  pass++;
  console.log('ok', name);
}

t('processInvoiceQueue は宛先メールアドレスが空の行をERRORにし、processedに含めない', () => {
  var sheets = buildSheets();
  var context = loadInvoiceRunContext(sheets);

  var result = context.processInvoiceQueue({});

  // sample_data/invoice_queue.csv: 1,2行目はDONEになり、3行目(INV-2026-0003)は
  // キュー・顧客マスタ双方でメールアドレスが空のためERRORになる想定。
  assert.strictEqual(result.processed, 2, 'ERROR行がprocessedに含まれている');

  var rows = sheets['請求キュー'].getDataRange().getValues();
  assert.strictEqual(rows[1][4], 'DONE', '1行目(INV-2026-0001)がDONEでない');
  assert.ok(String(rows[1][5]).length > 0, '1行目のpdf_urlが空');
  assert.strictEqual(rows[2][4], 'DONE', '2行目(INV-2026-0002)がDONEでない');
  assert.strictEqual(rows[3][4], 'ERROR', '3行目(INV-2026-0003)がERRORでない');
  assert.ok(/宛先メールアドレスが空です/.test(rows[3][7]), '3行目のnoteにエラー理由が記録されていない');
  assert.strictEqual(rows[3][5], '', 'ERROR行にpdf_urlが残っている');

  // INV-2026-0002(10%と8%の混在)のPDF本文に登録番号と税率ごとの内訳が印字されていること。
  var body2 = context.__docBodies['DOC_ID_2'].join('\n');
  assert.ok(body2.indexOf('登録番号: T1234567890123') !== -1, 'settings.csvの登録番号がPDFに印字されていない');
  assert.ok(body2.indexOf('8%対象') !== -1, '8%区分の内訳がPDFにない');
  assert.ok(body2.indexOf('10%対象') !== -1, '10%区分の内訳がPDFにない');
});

t('processInvoiceQueue の dryRun は副作用なしでDRYRUNを書き戻し、processedに含める', () => {
  var sheets = buildSheets();
  var context = loadInvoiceRunContext(sheets);

  var result = context.processInvoiceQueue({ dryRun: true });

  var rows = sheets['請求キュー'].getDataRange().getValues();
  assert.strictEqual(rows[1][4], 'DRYRUN', '1行目がDRYRUNでない');
  assert.strictEqual(rows[2][4], 'DRYRUN', '2行目がDRYRUNでない');
  assert.strictEqual(rows[3][4], 'ERROR', '3行目はdryRunでも検証先行でERRORになる想定');
  assert.strictEqual(result.processed, 2, 'DRYRUN行がprocessedに含まれていない');
  assert.strictEqual(context.__calls.documentCreate, 0, 'dryRunなのにDocument作成が呼ばれている');
  assert.strictEqual(context.__calls.draftCreate, 0, 'dryRunなのにGmail下書き作成が呼ばれている');
});

t('processInvoiceQueue は合計不一致の行をdryRunでもERRORにし、PDF・下書きを作らない', () => {
  var sheets = buildSheets();
  var invRows = sheets.Invoices.getDataRange().getValues();
  // INV-2026-0001 の net 列(インデックス6)を1円ずらして不一致を作る。
  invRows[1][6] = Number(invRows[1][6]) + 1;
  sheets.Invoices = makeSheetFromRows(invRows);
  var context = loadInvoiceRunContext(sheets);

  var result = context.processInvoiceQueue({ dryRun: true });

  var rows = sheets['請求キュー'].getDataRange().getValues();
  assert.strictEqual(rows[1][4], 'ERROR', '合計不一致の行がERRORでない');
  assert.ok(/合計不一致/.test(rows[1][7]), 'noteに不一致の理由が記録されていない: ' + rows[1][7]);
  assert.strictEqual(rows[1][5], '', 'ERROR行にpdf_urlが残っている');
  assert.strictEqual(context.__calls.documentCreate, 0, '不一致行でDocument作成が呼ばれている');
  assert.strictEqual(context.__calls.draftCreate, 0, '不一致行でGmail下書き作成が呼ばれている');
  assert.strictEqual(rows[2][4], 'DRYRUN', '合計が一致する2行目はDRYRUNのまま処理されるべき');
  assert.strictEqual(result.processed, 1, '合計不一致の行はprocessedに含まれるべきではない');
});

t('processInvoiceQueue は dryRun 後の DRYRUN 行を未処理として本番実行で処理する', () => {
  var sheets = buildSheets();
  var context = loadInvoiceRunContext(sheets);
  context.processInvoiceQueue({ dryRun: true });
  var result = context.processInvoiceQueue({});
  var rows = sheets['請求キュー'].getDataRange().getValues();
  assert.notStrictEqual(rows[1][4], 'DRYRUN', '1行目がDRYRUNのまま飛ばされている');
  assert.notStrictEqual(rows[2][4], 'DRYRUN', '2行目がDRYRUNのまま飛ばされている');
  assert.strictEqual(result.processed, 2, 'DRYRUN行が本番実行で処理されていない');
  assert.ok(context.__calls.documentCreate > 0, '本番実行でDocument作成が呼ばれていない');
});

console.log('\n' + pass + ' tests passed');
