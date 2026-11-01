/**
 * 請求書の金額・採番ロジック（Google サービス非依存）。
 * Node: node tests/logic_test.js
 * データはすべて架空です。
 */

/**
 * processInvoiceQueue からは呼び出していません。請求書データ作成（Invoices タブへの行追加）という
 * 別工程で採番に使う想定の部品です。
 * @param {string[]} existingNumbers @param {string} docType @param {string} year
 */
function nextInvoiceNumber(existingNumbers, docType, year) {
  var prefix = docType + '-' + year + '-';
  var max = 0;
  existingNumbers.forEach(function (n) {
    var tail = String(n).trim().slice(prefix.length);
    if (String(n).trim().indexOf(prefix) === 0 && /^\d+$/.test(tail)) {
      var k = parseInt(tail, 10);
      if (k > max) max = k;
    }
  });
  return prefix + ('000' + (max + 1)).slice(-4);
}

/**
 * LV（海外取引向けの通常税率）/ STD（国内標準10%）/ REDUCED（国内軽減8%）はいずれも
 * 適格請求書（インボイス）の発行対象として扱う。EU/NON_EUは海外向けの別書式（PPR）。
 * @param {string} vatStatus
 */
function docTypeFor(vatStatus) {
  return (vatStatus === 'LV' || vatStatus === 'STD' || vatStatus === 'REDUCED') ? 'INV' : 'PPR';
}

function vatRateFor(vatStatus, productVatRate, settings) {
  if (vatStatus === 'LV' || vatStatus === 'STD' || vatStatus === 'REDUCED') return productVatRate;
  if (vatStatus === 'EU' && String(settings.reverse_charge_EU).toUpperCase() === 'TRUE') return 0;
  if (vatStatus === 'NON_EU') return Number(settings.vat_rate_NON_EU || 0);
  return productVatRate;
}

/**
 * 適格請求書発行事業者の登録番号の形式チェック（T+数字13桁）のみ。実在性の確認は行いません。
 * @param {string} value
 */
function isValidInvoiceRegistrationNumber(value) {
  return /^T\d{13}$/.test(String(value == null ? '' : value));
}

/** 税率1件分の消費税額を切り捨てで求める（cents単位で受け取り cents単位で返す）。 */
function floorVatForRate_(taxableCents, rate) {
  var exact = Number((taxableCents * rate / 10000).toFixed(6));
  return Math.floor(exact) * 100;
}

/**
 * 請求書データ作成（Invoices タブの net/vat/gross 入力）での金額計算に加え、
 * processInvoiceQueue がPDF本文の税率別内訳（byRate）を組み立てる際、および reconcileInvoiceTotals_ による
 * 合計突き合わせの再計算元としても呼び出しています。
 * 消費税額の端数処理は、税率ごとに1回だけ行います（本実装では切り捨て。README参照）。
 * 行ごとに端数処理してから合計する方式ではありません。
 * @param {Object[]} products
 * @param {{sku:string,qty:number}[]} lines
 * @param {string} vatStatus
 * @param {Object} settings
 * @returns {{net:number, vat:number, gross:number, byRate:{rate:number,taxable:number,tax:number}[]}}
 */
function invoiceTotals(products, lines, vatStatus, settings) {
  var bySku = {};
  products.forEach(function (p) { bySku[p.sku] = p; });
  var taxableCentsByRate = {};
  lines.forEach(function (l) {
    var p = bySku[l.sku];
    if (!p) throw new Error('Unknown SKU: ' + l.sku);
    if (!(Number(l.qty) > 0)) throw new Error('Quantity must be above zero: ' + l.sku);
    var rate = vatRateFor(vatStatus, Number(p.vat_rate), settings);
    var lineNetC = toCents(Number(p.unit_price) * Number(l.qty));
    taxableCentsByRate[rate] = (taxableCentsByRate[rate] || 0) + lineNetC;
  });
  var rates = Object.keys(taxableCentsByRate).map(Number).sort(function (a, b) { return a - b; });
  var netC = 0, vatC = 0;
  var byRate = rates.map(function (rate) {
    var taxableC = taxableCentsByRate[rate];
    var taxC = floorVatForRate_(taxableC, rate);
    netC += taxableC;
    vatC += taxC;
    return { rate: rate, taxable: taxableC / 100, tax: taxC / 100 };
  });
  return { net: netC / 100, vat: vatC / 100, gross: (netC + vatC) / 100, byRate: byRate };
}

var RECONCILE_LABELS_ = { net: '税抜合計', vat: '消費税合計', gross: '税込合計' };

/**
 * 再計算した合計（computed）と記録済みの合計（recorded、Invoices タブの1行相当）を突き合わせる純粋関数。
 * 税抜・消費税・税込は必ず比較し、recorded.byRate を渡した場合のみ税率別内訳も比較する
 * （現状の Invoices タブには税率別の列が無いため、processInvoiceQueue からの呼び出しでは byRate 比較は行っていない）。
 * @param {{net:number, vat:number, gross:number, byRate?:{rate:number,taxable:number,tax:number}[]}} computed
 * @param {{net:number, vat:number, gross:number, byRate?:{rate:number,taxable:number,tax:number}[]}} recorded
 * @returns {{ok:boolean, reasons:string[]}}
 */
function reconcileInvoiceTotals_(computed, recorded) {
  var reasons = [];
  ['net', 'vat', 'gross'].forEach(function (key) {
    var a = round2(Number(computed[key]));
    var b = round2(Number(recorded[key]));
    if (a !== b) {
      reasons.push(RECONCILE_LABELS_[key] + 'が一致しません(計算 ' + a + ' / 記録 ' + b + ')');
    }
  });

  if (recorded.byRate) {
    var byComputed = {};
    (computed.byRate || []).forEach(function (r) { byComputed[r.rate] = r; });
    var byRecorded = {};
    recorded.byRate.forEach(function (r) { byRecorded[r.rate] = r; });
    var rateKeys = {};
    Object.keys(byComputed).forEach(function (k) { rateKeys[k] = true; });
    Object.keys(byRecorded).forEach(function (k) { rateKeys[k] = true; });
    Object.keys(rateKeys).map(Number).sort(function (a, b) { return a - b; }).forEach(function (rate) {
      var c = byComputed[rate];
      var r = byRecorded[rate];
      if (!c || !r) {
        reasons.push(rate + '%の内訳が一致しません(計算 ' + (c ? 'あり' : 'なし') + ' / 記録 ' + (r ? 'あり' : 'なし') + ')');
        return;
      }
      if (round2(c.taxable) !== round2(r.taxable) || round2(c.tax) !== round2(r.tax)) {
        reasons.push(rate + '%の内訳が一致しません(計算 対象額' + c.taxable + '/税' + c.tax + ' / 記録 対象額' + r.taxable + '/税' + r.tax + ')');
      }
    });
  }

  return { ok: reasons.length === 0, reasons: reasons };
}

/**
 * @param {Object} invoice @param {Object[]} lineRows @param {Object[]} products
 * @param {string} vatStatus @param {Object} settings
 */
function buildInvoiceLineDetails(invoice, lineRows, products, vatStatus, settings) {
  var bySku = {};
  products.forEach(function (p) { bySku[p.sku] = p; });
  return lineRows.filter(function (r) { return String(r.number) === String(invoice.number); }).map(function (r) {
    var p = bySku[r.sku];
    if (!p) throw new Error('Unknown SKU on line: ' + r.sku);
    var qty = Number(r.qty);
    var unit = Number(p.unit_price);
    var lineNet = round2(unit * qty);
    var rate = vatRateFor(vatStatus, Number(p.vat_rate), settings);
    // 軽減税率は日本の国内取引（docTypeFor が INV、商品側 vat_rate をそのまま使う経路）だけが対象。
    // NON_EU の国別税率（settings.vat_rate_NON_EU）が偶然8になっても軽減税率扱いはしない。
    var reduced = rate === 8 && docTypeFor(vatStatus) === 'INV';
    return { sku: r.sku, name: p.name || r.sku, qty: qty, unitPrice: unit, lineNet: lineNet, rate: rate, reduced: reduced };
  });
}

function formatMoney_(amount, currency) {
  var cur = currency || 'JPY';
  if (cur === 'JPY') return cur + ' ' + Math.round(round2(amount));
  return cur + ' ' + round2(amount).toFixed(2);
}

function toCents(x) {
  var n = Number(x);
  var s = n < 0 ? -1 : 1;
  return s * Math.round(Number((Math.abs(n) * 100).toFixed(6)));
}
function round2(x) { return toCents(x) / 100; }

if (typeof module !== 'undefined') {
  module.exports = {
    nextInvoiceNumber: nextInvoiceNumber,
    docTypeFor: docTypeFor,
    vatRateFor: vatRateFor,
    invoiceTotals: invoiceTotals,
    reconcileInvoiceTotals_: reconcileInvoiceTotals_,
    buildInvoiceLineDetails: buildInvoiceLineDetails,
    formatMoney_: formatMoney_,
    round2: round2,
    isValidInvoiceRegistrationNumber: isValidInvoiceRegistrationNumber
  };
}
