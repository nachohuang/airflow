const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// extractDateFromFilename_ / extractDriveFileId_ 都是純函式（不碰 DriveApp），直接測。
const context = { console: console };
vm.createContext(context);
function loadIntoContext(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', relPath), 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}
loadIntoContext('Config.gs');
loadIntoContext('Utils.gs');
loadIntoContext('HistoryFiles.gs');
loadIntoContext('ImportHistory.gs');

// --- extractDriveFileId_ ---
assert.strictEqual(context.extractDriveFileId_('https://drive.google.com/file/d/abcDEF123456/view'), 'abcDEF123456');
assert.strictEqual(context.extractDriveFileId_('https://drive.google.com/open?id=abcDEF123456&usp=drive_copy'), 'abcDEF123456');
assert.strictEqual(context.extractDriveFileId_('abcDEF123456'), 'abcDEF123456');
console.log('Test extractDriveFileId_ passed.');

// --- extractDateFromFilename_ ---
assert.strictEqual(context.extractDateFromFilename_('2026-07-30_ALL_COMBINED.csv'), '2026-07-30');
assert.strictEqual(context.extractDateFromFilename_('20260730_report.csv'), '2026-07-30');
assert.strictEqual(context.extractDateFromFilename_('2026_07_30.csv'), '2026-07-30');
assert.strictEqual(context.extractDateFromFilename_('2026-07_ALL_COMBINED.csv'), '2026-07-01');
assert.strictEqual(context.extractDateFromFilename_('random_export.csv'), null);
assert.strictEqual(context.extractDateFromFilename_('2026-13-40.csv'), null); // 月/日超出範圍
console.log('Test extractDateFromFilename_ passed.');

console.log('All ImportHistory.gs tests passed.');
