const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.Utilities = { sleep: function () {} };

function loadGs(file) {
  const mod = { exports: {} };
  new Function('module', 'exports', fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'))(mod, mod.exports);
  return mod.exports;
}

function parseCsv(file) {
  const rows = fs.readFileSync(path.join(__dirname, '..', 'sample_data', file), 'utf8').trim().split('\n').map(function (l) { return l.split(','); });
  const head = rows.shift();
  return rows.map(function (r) {
    const o = {};
    head.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

const logic = loadGs('Logic.gs');
const retry = loadGs('Retry.gs');

let pass = 0;
function t(name, fn) {
  fn();
  pass++;
  console.log('ok', name);
}

t('nextInvoiceNumber', () => {
  assert.strictEqual(logic.nextInvoiceNumber([], 'INV', '2026'), 'INV-2026-0001');
  assert.strictEqual(logic.nextInvoiceNumber(['INV-2026-0009'], 'INV', '2026'), 'INV-2026-0010');
});

t('invoiceTotals', () => {
  const products = [{ sku: 'SKU-A', unit_price: 10, vat_rate: 10, name: '架空商品A' }];
  const res = logic.invoiceTotals(products, [{ sku: 'SKU-A', qty: 2 }], 'LV', {});
  assert.strictEqual(res.net, 20);
  assert.strictEqual(res.vat, 2);
  assert.strictEqual(res.gross, 22);
});

t('buildInvoiceLineDetails', () => {
  const products = [{ sku: 'SKU-A', unit_price: 10, vat_rate: 10, name: '架空商品A' }];
  const inv = { number: 'INV-2026-0001' };
  const lines = [{ number: 'INV-2026-0001', sku: 'SKU-A', qty: 3 }];
  const details = logic.buildInvoiceLineDetails(inv, lines, products, 'STD', {});
  assert.strictEqual(details.length, 1);
  assert.strictEqual(details[0].lineNet, 30);
  assert.strictEqual(details[0].rate, 10);
  assert.strictEqual(details[0].reduced, false);
});

t('buildInvoiceLineDetails は NON_EU の国別税率が偶然8%でも reduced:true を付けない(日本の軽減税率ではないため)', () => {
  const products = [{ sku: 'SKU-STD', unit_price: 50000, vat_rate: 10, name: '標準税率商品(見本)' }];
  const inv = { number: 'INV-2026-0009' };
  const lines = [{ number: 'INV-2026-0009', sku: 'SKU-STD', qty: 1 }];
  const details = logic.buildInvoiceLineDetails(inv, lines, products, 'NON_EU', { vat_rate_NON_EU: '8' });
  assert.strictEqual(details[0].rate, 8);
  assert.strictEqual(details[0].reduced, false);
});

t('buildInvoiceLineDetails は軽減税率(8%)の行に reduced:true を付け、10%の行には付けない', () => {
  const products = [
    { sku: 'SKU-STD', unit_price: 50000, vat_rate: 10, name: '標準税率商品(見本)' },
    { sku: 'SKU-RED', unit_price: 999, vat_rate: 8, name: '軽減税率商品(見本)' }
  ];
  const inv = { number: 'INV-2026-0002' };
  const lines = [
    { number: 'INV-2026-0002', sku: 'SKU-STD', qty: 1 },
    { number: 'INV-2026-0002', sku: 'SKU-RED', qty: 1 }
  ];
  const details = logic.buildInvoiceLineDetails(inv, lines, products, 'STD', {});
  const bySku = {};
  details.forEach((d) => { bySku[d.sku] = d; });
  assert.strictEqual(bySku['SKU-STD'].rate, 10);
  assert.strictEqual(bySku['SKU-STD'].reduced, false);
  assert.strictEqual(bySku['SKU-RED'].rate, 8);
  assert.strictEqual(bySku['SKU-RED'].reduced, true);
});

t('httpShouldRetry', () => {
  assert.strictEqual(retry.invoiceHttpShouldRetry_(429), true);
  assert.strictEqual(retry.invoiceHttpShouldRetry_(503), true);
  assert.strictEqual(retry.invoiceHttpShouldRetry_(400), false);
});

t('docTypeFor', () => {
  assert.strictEqual(logic.docTypeFor('LV'), 'INV');
  assert.strictEqual(logic.docTypeFor('EU'), 'PPR');
  assert.strictEqual(logic.docTypeFor('NON_EU'), 'PPR');
});

t('formatMoney_', () => {
  assert.strictEqual(logic.formatMoney_(77000, 'JPY'), 'JPY 77000');
  assert.strictEqual(logic.formatMoney_(1200, 'USD'), 'USD 1200.00');
  assert.strictEqual(logic.formatMoney_(1200.5, 'USD'), 'USD 1200.50');
});

t('invoiceTotals error on unknown sku', () => {
  assert.throws(() => logic.invoiceTotals([], [{ sku: 'X', qty: 1 }], 'LV', {}), /Unknown SKU/);
});

t('invoiceTotals error on qty <= 0', () => {
  const products = [{ sku: 'SKU-A', unit_price: 10, vat_rate: 10 }];
  assert.throws(() => logic.invoiceTotals(products, [{ sku: 'SKU-A', qty: 0 }], 'LV', {}), /Quantity/);
});

t('vatRateFor EU reverse charge', () => {
  assert.strictEqual(logic.vatRateFor('EU', 20, { reverse_charge_EU: 'TRUE' }), 0);
  assert.strictEqual(logic.vatRateFor('EU', 20, { reverse_charge_EU: 'FALSE' }), 20);
  assert.strictEqual(logic.vatRateFor('NON_EU', 20, { vat_rate_NON_EU: '5' }), 5);
});

t('vatRateFor STD/REDUCED は商品側の税率をそのまま使う', () => {
  assert.strictEqual(logic.vatRateFor('STD', 10, {}), 10);
  assert.strictEqual(logic.vatRateFor('REDUCED', 8, {}), 8);
});

t('docTypeFor STD/REDUCED はINV', () => {
  assert.strictEqual(logic.docTypeFor('STD'), 'INV');
  assert.strictEqual(logic.docTypeFor('REDUCED'), 'INV');
});

t('isValidInvoiceRegistrationNumber は T+数字13桁のみ許可', () => {
  assert.strictEqual(logic.isValidInvoiceRegistrationNumber('T1234567890123'), true);
  assert.strictEqual(logic.isValidInvoiceRegistrationNumber('T123456789012'), false);
  assert.strictEqual(logic.isValidInvoiceRegistrationNumber('t1234567890123'), false);
  assert.strictEqual(logic.isValidInvoiceRegistrationNumber('1234567890123'), false);
  assert.strictEqual(logic.isValidInvoiceRegistrationNumber(''), false);
  assert.strictEqual(logic.isValidInvoiceRegistrationNumber(undefined), false);
});

t('invoiceTotals は税率ごとに1回だけ切り捨てる(四捨五入なら80円になるケース)', () => {
  const products = [{ sku: 'SKU-A', unit_price: 999, vat_rate: 8, name: '架空商品A' }];
  const res = logic.invoiceTotals(products, [{ sku: 'SKU-A', qty: 1 }], 'REDUCED', {});
  // 999 * 8% = 79.92 円。切り捨てなら79円、四捨五入なら80円になるため、切り捨ての確認になる。
  assert.strictEqual(res.vat, 79);
  assert.strictEqual(res.net, 999);
  assert.strictEqual(res.gross, 1078);
  assert.strictEqual(res.byRate.length, 1);
  assert.strictEqual(res.byRate[0].rate, 8);
  assert.strictEqual(res.byRate[0].taxable, 999);
  assert.strictEqual(res.byRate[0].tax, 79);
});

t('invoiceTotals は同一請求書内の10%と8%の混在を税率ごとに集計する', () => {
  const products = [
    { sku: 'SKU-STD', unit_price: 50000, vat_rate: 10, name: '標準税率商品(見本)' },
    { sku: 'SKU-RED', unit_price: 999, vat_rate: 8, name: '軽減税率商品(見本)' }
  ];
  const lines = [{ sku: 'SKU-STD', qty: 1 }, { sku: 'SKU-RED', qty: 1 }];
  const res = logic.invoiceTotals(products, lines, 'STD', {});
  assert.strictEqual(res.net, 50999);
  assert.strictEqual(res.vat, 5079);
  assert.strictEqual(res.gross, 56078);
  assert.strictEqual(res.byRate.length, 2);
  const byRateMap = {};
  res.byRate.forEach((r) => { byRateMap[r.rate] = r; });
  assert.strictEqual(byRateMap[10].taxable, 50000);
  assert.strictEqual(byRateMap[10].tax, 5000);
  assert.strictEqual(byRateMap[8].taxable, 999);
  assert.strictEqual(byRateMap[8].tax, 79);
});

t('reconcileInvoiceTotals_ は一致なら ok:true で reasons が空', () => {
  const computed = { net: 1000, vat: 100, gross: 1100, byRate: [{ rate: 10, taxable: 1000, tax: 100 }] };
  const recorded = { net: 1000, vat: 100, gross: 1100 };
  const res = logic.reconcileInvoiceTotals_(computed, recorded);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.reasons, []);
});

t('reconcileInvoiceTotals_ は税抜(net)のずれを検出する', () => {
  const computed = { net: 1000, vat: 100, gross: 1100, byRate: [] };
  const recorded = { net: 1001, vat: 100, gross: 1100 };
  const res = logic.reconcileInvoiceTotals_(computed, recorded);
  assert.strictEqual(res.ok, false);
  assert.ok(res.reasons.some((r) => /税抜/.test(r)), '税抜ずれの理由がない: ' + res.reasons.join(' / '));
});

t('reconcileInvoiceTotals_ は消費税(vat)のずれを検出する', () => {
  const computed = { net: 1000, vat: 100, gross: 1100, byRate: [] };
  const recorded = { net: 1000, vat: 101, gross: 1100 };
  const res = logic.reconcileInvoiceTotals_(computed, recorded);
  assert.strictEqual(res.ok, false);
  assert.ok(res.reasons.some((r) => /消費税/.test(r)), '消費税ずれの理由がない: ' + res.reasons.join(' / '));
});

t('reconcileInvoiceTotals_ は税込(gross)のずれを検出する', () => {
  const computed = { net: 1000, vat: 100, gross: 1100, byRate: [] };
  const recorded = { net: 1000, vat: 100, gross: 1101 };
  const res = logic.reconcileInvoiceTotals_(computed, recorded);
  assert.strictEqual(res.ok, false);
  assert.ok(res.reasons.some((r) => /税込/.test(r)), '税込ずれの理由がない: ' + res.reasons.join(' / '));
});

t('reconcileInvoiceTotals_ は税率別内訳(byRate)のずれを検出する', () => {
  const computed = {
    net: 50999, vat: 5079, gross: 56078,
    byRate: [{ rate: 8, taxable: 999, tax: 79 }, { rate: 10, taxable: 50000, tax: 5000 }]
  };
  const recorded = {
    net: 50999, vat: 5079, gross: 56078,
    byRate: [{ rate: 8, taxable: 999, tax: 80 }, { rate: 10, taxable: 50000, tax: 5000 }]
  };
  const res = logic.reconcileInvoiceTotals_(computed, recorded);
  assert.strictEqual(res.ok, false);
  assert.ok(res.reasons.some((r) => /8%/.test(r)), '8%区分のずれの理由がない: ' + res.reasons.join(' / '));
});

t('invoiceDefaultShouldRetry_', () => {
  assert.strictEqual(retry.invoiceDefaultShouldRetry_(new Error('429 Too Many Requests'), 1), true);
  assert.strictEqual(retry.invoiceDefaultShouldRetry_(new Error('500 Internal Server Error'), 1), true);
  assert.strictEqual(retry.invoiceDefaultShouldRetry_(new Error('Service unavailable'), 1), true);
  assert.strictEqual(retry.invoiceDefaultShouldRetry_(new Error('400 Bad Request'), 1), false);
});

t('invoiceWithRetry_ succeeds after transient failures', () => {
  let calls = 0;
  const result = retry.invoiceWithRetry_(function () {
    calls++;
    if (calls < 3) throw new Error('503 Service Unavailable');
    return 'ok';
  }, { baseMs: 1 });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 3);
});

t('invoiceWithRetry_ throws after max attempts', () => {
  let calls = 0;
  assert.throws(() => {
    retry.invoiceWithRetry_(function () {
      calls++;
      throw new Error('503 Service Unavailable');
    }, { maxAttempts: 2, baseMs: 1 });
  }, /503/);
  assert.strictEqual(calls, 2);
});

t('invoiceWithRetry_ does not retry non-retryable errors', () => {
  let calls = 0;
  assert.throws(() => {
    retry.invoiceWithRetry_(function () {
      calls++;
      throw new Error('400 Bad Request');
    }, { maxAttempts: 4, baseMs: 1 });
  }, /400/);
  assert.strictEqual(calls, 1);
});

let invoiceCount = 0;
let lineCount = 0;

t('sample_data totals match invoices.csv', () => {
  const customers = parseCsv('customers.csv');
  const products = parseCsv('products.csv');
  const invoices = parseCsv('invoices.csv');
  const invLines = parseCsv('invoice_lines.csv');
  const settingsRows = parseCsv('settings.csv');
  const settings = {};
  settingsRows.forEach((r) => { settings[r.key] = r.value; });

  invoices.forEach((inv) => {
    const customer = customers.filter((c) => c.customer_id === inv.customer_id)[0];
    assert.ok(customer, 'customer not found: ' + inv.customer_id);
    const lines = invLines
      .filter((l) => l.number === inv.number)
      .map((l) => ({ sku: l.sku, qty: Number(l.qty) }));
    assert.ok(lines.length > 0, 'no lines for ' + inv.number);
    lineCount += lines.length;

    const totals = logic.invoiceTotals(products, lines, customer.vat_status, settings);
    assert.strictEqual(totals.net, Number(inv.net), inv.number + ' net');
    assert.strictEqual(totals.vat, Number(inv.vat), inv.number + ' vat');
    assert.strictEqual(totals.gross, Number(inv.gross), inv.number + ' gross');
    assert.strictEqual(logic.docTypeFor(customer.vat_status), inv.doc_type, inv.number + ' doc_type');

    const details = logic.buildInvoiceLineDetails(inv, invLines, products, customer.vat_status, settings);
    assert.strictEqual(details.length, lines.length, inv.number + ' line details count');
    invoiceCount++;
  });
});

console.log('\n' + pass + ' tests passed (sample_data: invoices=' + invoiceCount + ', lines=' + lineCount + ')');
