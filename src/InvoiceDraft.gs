/**
 * PDF 添付付き Gmail 下書きを作成する（送信 API は呼ばない）。
 * Gmail 高度なサービス（Gmail.Users.Drafts.create）が必要です。
 */

function mimeEncodeHeader_(text) {
  return '=?UTF-8?B?' + Utilities.base64Encode(text, Utilities.Charset.UTF_8) + '?=';
}

function wrapBase64Lines_(base64) {
  var lines = [];
  for (var i = 0; i < base64.length; i += 76) lines.push(base64.slice(i, i + 76));
  return lines.join('\r\n');
}

/** @param {string} to @param {string} subject @param {string} bodyText @param {{mimeType:string,name:string,blob:GoogleAppsScript.Base.Blob}} attachment */
function buildMimeMessage_(to, subject, bodyText, attachment) {
  var boundary = 'boundary_' + Utilities.getUuid().replace(/-/g, '');
  return [
    'To: ' + to,
    'Subject: ' + mimeEncodeHeader_(subject),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64Lines_(Utilities.base64Encode(bodyText, Utilities.Charset.UTF_8)),
    '--' + boundary,
    'Content-Type: ' + attachment.mimeType + '; name="' + attachment.name + '"',
    'Content-Disposition: attachment; filename="' + attachment.name + '"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64Lines_(Utilities.base64Encode(attachment.blob.getBytes())),
    '--' + boundary + '--',
    ''
  ].join('\r\n');
}

/**
 * @param {string} to
 * @param {string} subject
 * @param {string} bodyText
 * @param {GoogleAppsScript.Base.Blob} pdfBlob
 * @param {string} pdfFileName
 * @returns {string} draftId
 */
function createInvoiceGmailDraft_(to, subject, bodyText, pdfBlob, pdfFileName) {
  if (!to) throw new Error('宛先メールアドレスが空です');
  return invoiceWithRetry_(function () {
    var raw = Utilities.base64EncodeWebSafe(Utilities.newBlob(
      buildMimeMessage_(to, subject, bodyText, { mimeType: 'application/pdf', name: pdfFileName, blob: pdfBlob })
    ).getBytes());
    var draft = Gmail.Users.Drafts.create({ message: { raw: raw } }, 'me');
    return draft.id;
  });
}

function buildDefaultDraftBody_(invoice, customer) {
  return [
    customer.name + ' 御中',
    '',
    '請求書番号 ' + invoice.number + ' を添付いたします（見本／架空データ）。',
    '税込合計: ' + formatMoney_(invoice.gross, invoice.currency),
    '',
    '担当者が内容を確認したうえで送信してください。'
  ].join('\n');
}

function buildDefaultDraftSubject_(invoice) {
  return '【請求書】' + invoice.number + '（見本）';
}

if (typeof module !== 'undefined') {
  module.exports = {
    mimeEncodeHeader_: mimeEncodeHeader_,
    wrapBase64Lines_: wrapBase64Lines_,
    buildMimeMessage_: buildMimeMessage_,
    buildDefaultDraftBody_: buildDefaultDraftBody_,
    buildDefaultDraftSubject_: buildDefaultDraftSubject_
  };
}
