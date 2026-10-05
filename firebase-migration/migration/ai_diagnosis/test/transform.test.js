const assert = require('assert');
const { zfill4, normalizeDateStr, parseNumber, translateDiagnosisType, transformAiDiagnosisRow } = require('../transform');

// --- zfill4／normalizeDateStr／parseNumber：跟 watchlist/portfolio 共用同一份
//    lib/normalize，這裡只是確認 re-export 沒有漏掉或接錯 ---
{
  assert.strictEqual(zfill4('330'), '0330');
  assert.strictEqual(normalizeDateStr('2026/8/21'), '2026-08-21');
  assert.strictEqual(parseNumber('85.5'), 85.5);
  assert.strictEqual(parseNumber(''), null);
  console.log('Test zfill4/normalizeDateStr/parseNumber re-export passed.');
}

// --- translateDiagnosisType：中文診斷類型翻成英文列舉，空白/未知值比照
//    aiDiagnosisRowKey_ 的 `r['診斷類型'] || '深度診斷'` 預設邏輯，當成 deep ---
{
  assert.strictEqual(translateDiagnosisType('深度診斷'), 'deep');
  assert.strictEqual(translateDiagnosisType('持股續抱診斷'), 'hold');
  assert.strictEqual(translateDiagnosisType('TOP3推薦'), 'top3');
  assert.strictEqual(translateDiagnosisType(''), 'deep');
  assert.strictEqual(translateDiagnosisType(undefined), 'deep');
  console.log('Test translateDiagnosisType passed.');
}

// --- transformAiDiagnosisRow：正常一筆深度診斷的轉換結果 ---
{
  const row = {
    '日期': '2026-08-21', '證券代號': '330', '證券名稱': '某某股',
    'Armor_Score': '85.5', '操作策略': '強力買入訊號', '最終建議': '強力買入',
    '診斷類型': '深度診斷', '診斷內容': '完整診斷內文……', '時間戳記': '台股監控 2026-08-21 09:30'
  };
  const doc = transformAiDiagnosisRow(row, '2026-09-30T00:00:00.000Z');
  assert.strictEqual(doc.id, '0330_2026-08-21_deep', '文件 ID 要是 code_date_diagnosisType');
  assert.strictEqual(doc.date, '2026-08-21');
  assert.strictEqual(doc.code, '0330');
  assert.strictEqual(doc.name, '某某股');
  assert.strictEqual(doc.armorScore, 85.5);
  assert.strictEqual(doc.strategy, '強力買入訊號');
  assert.strictEqual(doc.verdict, '強力買入');
  assert.strictEqual(doc.diagnosisType, 'deep');
  assert.strictEqual(doc.content, '完整診斷內文……');
  assert.strictEqual(doc.timestamp, '台股監控 2026-08-21 09:30');
  assert.strictEqual(doc.migratedFrom, 'sheets:AiDiagnosis');
  assert.strictEqual(doc.migratedAt, '2026-09-30T00:00:00.000Z');
  console.log('Test transformAiDiagnosisRow (basic, deep) passed.');
}

// --- transformAiDiagnosisRow：Top3 推薦的證券代號固定是文字 'TOP3'（不是真正
//    的股票代號），Armor_Score/操作策略/最終建議通常是空字串——這不是壞資料 ---
{
  const row = {
    '日期': '2026-08-21', '證券代號': 'TOP3', '證券名稱': '（全市場橫向比較）',
    'Armor_Score': '', '操作策略': '', '最終建議': '',
    '診斷類型': 'TOP3推薦', '診斷內容': '1. 2330 台積電 - 理由……', '時間戳記': '台股監控 2026-08-21 09:00'
  };
  const doc = transformAiDiagnosisRow(row, 'x');
  assert.strictEqual(doc.id, 'TOP3_2026-08-21_top3');
  assert.strictEqual(doc.code, 'TOP3', 'zfill4 對已經是 4 字元的 TOP3 要原樣保留，不能誤補零');
  assert.strictEqual(doc.diagnosisType, 'top3');
  assert.strictEqual(doc.armorScore, null, 'Armor_Score 空字串要轉成 null，不是 0');
  assert.strictEqual(doc.strategy, '');
  assert.strictEqual(doc.verdict, '');
  console.log('Test transformAiDiagnosisRow (top3, non-numeric code) passed.');
}

// --- transformAiDiagnosisRow：代號或日期空白要回傳 null，不能匯入一筆缺主鍵的垃圾文件 ---
{
  assert.strictEqual(transformAiDiagnosisRow({ '證券代號': '', '日期': '2026-08-21' }, 'x'), null);
  assert.strictEqual(transformAiDiagnosisRow({ '證券代號': '2330', '日期': '' }, 'x'), null);
  console.log('Test transformAiDiagnosisRow (blank code or date -> null, not imported) passed.');
}

// --- transformAiDiagnosisRow：名稱/策略/建議/內容/時間戳記缺欄位時要用空字串，
//    不能是 undefined ---
{
  const doc = transformAiDiagnosisRow({ '證券代號': '2330', '日期': '2026-08-21' }, 'x');
  assert.strictEqual(doc.name, '');
  assert.strictEqual(doc.strategy, '');
  assert.strictEqual(doc.verdict, '');
  assert.strictEqual(doc.content, '');
  assert.strictEqual(doc.timestamp, '');
  assert.strictEqual(doc.diagnosisType, 'deep', '沒帶診斷類型預設當深度診斷');
  console.log('Test transformAiDiagnosisRow (missing optional fields default to empty string, not undefined) passed.');
}

console.log('All transform.js tests passed.');
