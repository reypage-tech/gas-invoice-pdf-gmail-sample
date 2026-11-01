const assert = require('assert');
const fs = require('fs');
const path = require('path');

function loadGs(file) {
  const mod = { exports: {} };
  new Function('module', 'exports', fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'))(mod, mod.exports);
  return mod.exports;
}

const pdf = loadGs('InvoicePdf.gs');

let pass = 0;
function t(name, fn) {
  fn();
  pass++;
  console.log('ok', name);
}

t('renderInvoicePlainText_ は登録番号と税率ごとの内訳(対象額・消費税額)を印字する', () => {
  const invoice = {
    number: 'INV-2026-0002', doc_type: 'INV', date: '2026-11-02', due_date: '2026-12-01',
    currency: 'JPY', net: 50999, vat: 5079, gross: 56078
  };
  const customer = { customer_id: 'C-002', name: '見本デザイン事務所' };
  const lineDetails = [
    { sku: 'SKU-DSN02', name: 'ロゴ作成(見本)', qty: 1, unitPrice: 50000, lineNet: 50000, rate: 10, reduced: false },
    { sku: 'SKU-SNK05', name: '会議用菓子(見本)', qty: 1, unitPrice: 999, lineNet: 999, rate: 8, reduced: true }
  ];
  const byRate = [{ rate: 8, taxable: 999, tax: 79 }, { rate: 10, taxable: 50000, tax: 5000 }];

  const text = pdf.renderInvoicePlainText_(invoice, customer, lineDetails, {
    registrationNumber: 'T1234567890123',
    byRate: byRate
  });

  assert.ok(text.indexOf('登録番号: T1234567890123') !== -1, '登録番号が印字されていない');
  assert.ok(text.indexOf('8%対象') !== -1, '8%区分の内訳がない');
  assert.ok(text.indexOf('10%対象') !== -1, '10%区分の内訳がない');
  assert.ok(text.indexOf('対象額 999') !== -1, '8%区分の対象額がない');
  assert.ok(text.indexOf('消費税 79') !== -1, '8%区分の消費税額がない');
  assert.ok(text.indexOf('税率 8%') !== -1, '8%明細行に税率表示がない');
  assert.ok(text.indexOf('税率 10%') !== -1, '10%明細行に税率表示がない');
  assert.ok(/SKU-SNK05.*※/.test(text), '軽減税率の明細行に※が付いていない');
  assert.ok(!/SKU-DSN02[^\n]*※/.test(text), '標準税率の明細行に※が付いてしまっている');
  assert.ok(text.indexOf('※は軽減税率対象') !== -1, '欄外の軽減税率注記がない');
});

console.log('\n' + pass + ' tests passed');
