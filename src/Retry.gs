/**
 * UrlFetch 等の再試行ヘルパー（invoice 部品用。他部品と関数名を共有しない）。
 * @param {function():*} fn 実行する処理
 * @param {{maxAttempts?:number, baseMs?:number, shouldRetry?:function(Error,number):boolean}} opts
 */
function invoiceWithRetry_(fn, opts) {
  opts = opts || {};
  var max = opts.maxAttempts || 4;
  var base = opts.baseMs || 500;
  var shouldRetry = opts.shouldRetry || invoiceDefaultShouldRetry_;
  var lastErr;
  for (var attempt = 1; attempt <= max; attempt++) {
    try {
      return fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= max || !shouldRetry(err, attempt)) throw err;
      Utilities.sleep(base * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

/** @param {Error} err @param {number} attempt */
function invoiceDefaultShouldRetry_(err, attempt) {
  var msg = String(err && err.message ? err.message : err);
  if (/429/.test(msg) || /5\d{2}/.test(msg)) return true;
  if (/Service unavailable/i.test(msg)) return true;
  return false;
}

/** HTTP レスポンスコードから再試行可否 */
function invoiceHttpShouldRetry_(code) {
  return code === 429 || (code >= 500 && code <= 599);
}

if (typeof module !== 'undefined') {
  module.exports = {
    invoiceWithRetry_: invoiceWithRetry_,
    invoiceDefaultShouldRetry_: invoiceDefaultShouldRetry_,
    invoiceHttpShouldRetry_: invoiceHttpShouldRetry_
  };
}
