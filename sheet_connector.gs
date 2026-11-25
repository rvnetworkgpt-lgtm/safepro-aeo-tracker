/**
 * SAFE PRO AEO Tracker – Google Sheet connector.
 * Paste this into the sheet: Extensions → Apps Script, then
 * Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * Copy the web app URL into the GitHub secret SHEET_WEBHOOK_URL.
 * The secret TOKEN below must match the GitHub secret SHEET_TOKEN.
 */
const TOKEN = 'CHANGE-ME';

function doGet(e) {
  if (e.parameter.token !== TOKEN) return out({error: 'bad token'});
  const values = SpreadsheetApp.getActive().getSheets()[0].getDataRange().getValues();
  const head = values.shift();
  return out({prompts: values.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])))});
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.token !== TOKEN) return out({error: 'bad token'});
  const book = SpreadsheetApp.getActive();
  let sh = book.getSheetByName(body.tab);
  if (!sh) {
    sh = book.insertSheet(body.tab);
    sh.appendRow(body.cols);
    sh.setFrozenRows(1);
  }
  if (body.rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, body.rows.length, body.rows[0].length).setValues(body.rows);
  }
  return out({ok: true, added: body.rows.length});
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
