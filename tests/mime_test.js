const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.Utilities = {
  sleep: function () {},
  Charset: { UTF_8: 'UTF-8' },
  base64Encode: function (data) {
    var buf = Array.isArray(data) ? Buffer.from(data) : Buffer.from(String(data), 'utf8');
    return buf.toString('base64');
  },
  getUuid: function () { return '11111111-2222-3333-4444-555555555555'; }
};

function loadGs(file) {
  const mod = { exports: {} };
  new Function('module', 'exports', fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'))(mod, mod.exports);
  return mod.exports;
}

const draft = loadGs('InvoiceDraft.gs');

let pass = 0;
function t(name, fn) {
  fn();
  pass++;
  console.log('ok', name);
}

t('mimeEncodeHeader_ はUTF-8 Base64のエンコード済みヘッダーを返す', () => {
  const encoded = draft.mimeEncodeHeader_('件名');
  assert.strictEqual(encoded, '=?UTF-8?B?' + Buffer.from('件名', 'utf8').toString('base64') + '?=');
});

t('wrapBase64Lines_ は76文字ごとにCRLFで折り返す', () => {
  const base64 = 'A'.repeat(200);
  const wrapped = draft.wrapBase64Lines_(base64);
  const lines = wrapped.split('\r\n');
  assert.strictEqual(lines.length, Math.ceil(200 / 76));
  lines.slice(0, -1).forEach((l) => assert.strictEqual(l.length, 76));
});

t('buildMimeMessage_ は宛先・件名・添付ファイル名を含むMIME本文を組み立てる', () => {
  const attachment = {
    mimeType: 'application/pdf',
    name: 'INV-2026-0001_C-001_invoice.pdf',
    blob: { getBytes: () => [1, 2, 3] }
  };
  const mime = draft.buildMimeMessage_('to@example.com', '件名', '本文（見本）', attachment);

  assert.ok(mime.indexOf('To: to@example.com') !== -1, 'To ヘッダーがない');
  assert.ok(mime.indexOf('Subject: ' + draft.mimeEncodeHeader_('件名')) !== -1, 'Subject ヘッダーがない');
  assert.ok(mime.indexOf('MIME-Version: 1.0') !== -1, 'MIME-Version がない');
  assert.ok(mime.indexOf('filename="' + attachment.name + '"') !== -1, '添付ファイル名がない');

  const boundaryMatch = mime.match(/boundary="(boundary_[0-9a-f]+)"/);
  assert.ok(boundaryMatch, 'boundary が見つからない');
  const occurrences = mime.split('--' + boundaryMatch[1]).length - 1;
  assert.strictEqual(occurrences, 3, 'boundary の区切りが本文・添付・終端の3箇所にない');
});

console.log('\n' + pass + ' tests passed');
