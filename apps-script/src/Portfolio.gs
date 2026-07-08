/**
 * Portfolio.gs
 * 對應原本寫死在程式碼裡的 user_portfolio = {'9907': (19.10, '2026-03-05'), ...}，
 * 這裡改成 Portfolio 分頁，並開放「持股管理」頁面 CRUD。
 */

function getPortfolioSheet_() {
  return ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.PORTFOLIO, CONFIG.PORTFOLIO_COLUMNS);
}

function readPortfolio_() {
  return readSheetObjects_(getPortfolioSheet_());
}

/** 給 Analysis.gs 用：{code: {cost, buyDate}}，等同原本的 user_portfolio dict。 */
function getPortfolioMap_() {
  var rows = readPortfolio_();
  var map = {};
  rows.forEach(function (r) {
    var code = zfill4(String(r['證券代號'] || '').trim());
    if (!code) return;
    map[code] = {
      cost: toNumber(r['成本']),
      buyDate: normalizeDateStr(r['買進日期'])
    };
  });
  return map;
}

/** 供「持股管理」頁面呼叫，回傳整理過的持股清單（含代號補零 + 最新收盤價）。 */
function getPortfolio() {
  var items = readPortfolio_().map(function (r) {
    return {
      code: zfill4(String(r['證券代號'] || '').trim()),
      name: r['證券名稱'] || '',
      cost: toNumber(r['成本']),
      buyDate: normalizeDateStr(r['買進日期']),
      note: r['備註'] || '',
      latestClose: null
    };
  }).filter(function (r) { return r.code; });
  if (items.length === 0) return items;

  var recent = readRecentHistory_(10);
  var latestByCode = {};
  recent.forEach(function (r) {
    var code = zfill4(String(r['證券代號'] || '').trim());
    var d = normalizeDateStr(r['日期']);
    if (!latestByCode[code] || d > latestByCode[code].date) {
      latestByCode[code] = { date: d, close: toNumber(r['收盤價']) };
    }
  });
  items.forEach(function (it) {
    if (latestByCode[it.code]) it.latestClose = latestByCode[it.code].close;
  });
  return items;
}

/** 新增或更新一筆持股（依代號 upsert）。item: {code, name, cost, buyDate, note} */
function savePortfolioItem(item) {
  if (!item || !item.code) throw new Error('股票代號不可為空');
  var code = zfill4(String(item.code).trim());
  var sheet = getPortfolioSheet_();
  var rows = readSheetObjects_(sheet);

  var found = false;
  for (var i = 0; i < rows.length; i++) {
    if (zfill4(String(rows[i]['證券代號'] || '').trim()) === code) {
      rows[i] = {
        '證券代號': code,
        '證券名稱': item.name || rows[i]['證券名稱'] || '',
        '成本': toNumber(item.cost),
        '買進日期': item.buyDate || rows[i]['買進日期'] || '',
        '備註': item.note || ''
      };
      found = true;
      break;
    }
  }
  if (!found) {
    rows.push({
      '證券代號': code,
      '證券名稱': item.name || '',
      '成本': toNumber(item.cost),
      '買進日期': item.buyDate || '',
      '備註': item.note || ''
    });
  }
  writeSheetObjects_(sheet, CONFIG.PORTFOLIO_COLUMNS, rows);
  return getPortfolio();
}

function deletePortfolioItem(code) {
  var target = zfill4(String(code).trim());
  var sheet = getPortfolioSheet_();
  var rows = readSheetObjects_(sheet).filter(function (r) {
    return zfill4(String(r['證券代號'] || '').trim()) !== target;
  });
  writeSheetObjects_(sheet, CONFIG.PORTFOLIO_COLUMNS, rows);
  return getPortfolio();
}
