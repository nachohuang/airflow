/**
 * Portfolio.gs
 * 持股庫存：一列＝一筆買進紀錄（lot），支援同一檔股票分批買進/加碼，「持股庫存」頁面
 * 依證券代號把「持有中」的紀錄聚合成加權平均成本／總股數一張卡片；賣出時把整檔股票目前
 * 「持有中」的紀錄一次標記成「已賣出」，移到「歷史結案紀錄」，記錄已實現損益。
 */

var PORTFOLIO_LEGACY_COLUMNS_ = ['證券代號', '證券名稱', '成本', '買進日期', '備註'];
var PORTFOLIO_DEFAULT_LOT_SHARES_ = 1000; // 舊格式沒有股數欄位，遷移時的預設值（1 張）

/**
 * Portfolio 分頁的資料結構在這次改版前是「一列一檔股票」（成本/買進日期各一個值，沒有股數，
 * 不支援分批買進）。改成「一列一筆買進紀錄」之後，第一次讀取時如果偵測到還是舊格式的標題列，
 * 就地把每一列轉成新格式的一筆「持有中」紀錄——股數用 PORTFOLIO_DEFAULT_LOT_SHARES_ 當預設值，
 * 這只影響「總股數」這個新欄位的顯示，不影響加權平均成本：舊資料每檔股票本來就只有一筆記錄，
 * 不管填哪個股數，單筆記錄的加權平均一定等於它自己的成本，數學上不會失真。使用者之後可以自己
 * 到「編輯」修正實際股數。只會執行一次：轉完之後分頁標題列就是新格式，下次呼叫這個函式時
 * 偵測到已經是新格式就直接跳過，不會重複轉換。
 */
function migratePortfolioSheetIfNeeded_(sheet) {
  if (sheet.getLastRow() === 0) return;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var isLegacy = PORTFOLIO_LEGACY_COLUMNS_.every(function (c) { return headers.indexOf(c) !== -1; }) &&
    headers.indexOf('交易ID') === -1;
  if (!isLegacy) return;

  var legacyRows = readSheetObjects_(sheet);
  var migrated = legacyRows.map(function (r) {
    return {
      '交易ID': Utilities.getUuid(),
      '證券代號': zfill4(String(r['證券代號'] || '').trim()),
      '證券名稱': r['證券名稱'] || '',
      '買進日期': r['買進日期'] || '',
      '買進價格': toNumber(r['成本']),
      '股數': PORTFOLIO_DEFAULT_LOT_SHARES_,
      '備註': r['備註'] || '',
      '狀態': '持有中',
      '賣出日期': '',
      '賣出價格': ''
    };
  }).filter(function (r) { return r['證券代號']; });

  writeSheetObjects_(sheet, CONFIG.PORTFOLIO_COLUMNS, migrated);
  logRun_('持股資料格式轉換', '成功',
    '已把 ' + migrated.length + ' 筆舊格式持股轉成新的分批買進紀錄格式（股數預設 ' + PORTFOLIO_DEFAULT_LOT_SHARES_ + '，可自行編輯調整）', 0);
}

function getPortfolioSheet_() {
  var sheet = ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.PORTFOLIO, CONFIG.PORTFOLIO_COLUMNS);
  migratePortfolioSheetIfNeeded_(sheet);
  return sheet;
}

function readPortfolioLots_() {
  return readSheetObjects_(getPortfolioSheet_());
}

/**
 * 一批同一檔股票的 lot，彙總成加權平均成本／總股數／最早買進日。純運算，抽成獨立函式
 * 方便測試（不用真的接 Sheets）。rows 只需要有 '股數'／'買進價格'／'買進日期' 三個欄位。
 */
function aggregateLots_(rows) {
  var totalShares = 0, totalCost = 0, earliestBuyDate = null;
  rows.forEach(function (r) {
    var shares = toNumber(r['股數']);
    var price = toNumber(r['買進價格']);
    totalShares += shares;
    totalCost += shares * price;
    var d = normalizeDateStr(r['買進日期']);
    if (d && (!earliestBuyDate || d < earliestBuyDate)) earliestBuyDate = d;
  });
  return {
    totalShares: totalShares,
    avgCost: totalShares > 0 ? round_(totalCost / totalShares, 4) : 0,
    earliestBuyDate: earliestBuyDate
  };
}

/**
 * 給 Analysis.gs 用：{code: {cost, buyDate}}，等同原本的 user_portfolio dict——只看「持有中」
 * 的 lot，聚合成加權平均成本跟「最早買進日期」（Adjusted_Peak 從第一次進場開始算起，符合
 * 分批買進時「整體部位」的直覺：只要這檔股票還有任何一筆沒賣，追蹤高點就從第一次進場算起）。
 */
function getPortfolioMap_() {
  var lots = readPortfolioLots_().filter(function (r) { return (r['狀態'] || '持有中') === '持有中'; });
  var byCode = {};
  lots.forEach(function (r) {
    var code = zfill4(String(r['證券代號'] || '').trim());
    if (!code) return;
    if (!byCode[code]) byCode[code] = [];
    byCode[code].push(r);
  });
  var map = {};
  Object.keys(byCode).forEach(function (code) {
    var agg = aggregateLots_(byCode[code]);
    map[code] = { cost: agg.avgCost, buyDate: agg.earliestBuyDate };
  });
  return map;
}

/** 只讀「持有中」的某一檔股票的 lot（給持股續抱 AI 診斷用，AiDiagnosis.gs）。 */
function getHoldingLotsForCode_(code) {
  var target = zfill4(String(code || '').trim());
  return readPortfolioLots_().filter(function (r) {
    return zfill4(String(r['證券代號'] || '').trim()) === target && (r['狀態'] || '持有中') === '持有中';
  });
}

/** 近幾天的歷史資料裡，每檔股票最新一筆收盤價（給持股損益％用，跟 getPortfolio() 共用同一套邏輯）。 */
function getLatestCloseByCode_() {
  var recent = readRecentHistory_(10);
  var latestByCode = {};
  recent.forEach(function (r) {
    var code = zfill4(String(r['證券代號'] || '').trim());
    var d = normalizeDateStr(r['日期']);
    if (!latestByCode[code] || d > latestByCode[code].date) {
      latestByCode[code] = { date: d, close: toNumber(r['收盤價']) };
    }
  });
  return latestByCode;
}

/**
 * 供「持股庫存」頁面呼叫：依股票代號把「持有中」的買進紀錄聚合成一張卡片（加權平均成本、
 * 總股數、現價損益%、最近一次戰報燈號），lots 欄位保留每一筆個別買進紀錄供展開檢視/編輯/
 * 刪除單筆——這是跟改版前最大的不同：改版前一檔股票只有一筆紀錄可以編輯，現在是一張卡片
 * 底下可能有好幾筆買進紀錄。
 */
function getPortfolio() {
  var lots = readPortfolioLots_().filter(function (r) { return (r['狀態'] || '持有中') === '持有中'; });
  var byCode = {};
  lots.forEach(function (r) {
    var code = zfill4(String(r['證券代號'] || '').trim());
    if (!code) return;
    if (!byCode[code]) byCode[code] = { code: code, name: r['證券名稱'] || '', lots: [] };
    if (r['證券名稱']) byCode[code].name = r['證券名稱'];
    byCode[code].lots.push({
      id: r['交易ID'],
      buyDate: normalizeDateStr(r['買進日期']),
      cost: toNumber(r['買進價格']),
      shares: toNumber(r['股數']),
      note: r['備註'] || ''
    });
  });

  var items = Object.keys(byCode).map(function (code) {
    var entry = byCode[code];
    var agg = aggregateLots_(entry.lots.map(function (l) {
      return { '股數': l.shares, '買進價格': l.cost, '買進日期': l.buyDate };
    }));
    entry.lots.sort(function (a, b) { return a.buyDate < b.buyDate ? -1 : 1; });
    return {
      code: code,
      name: entry.name,
      cost: agg.avgCost,
      totalShares: agg.totalShares,
      buyDate: agg.earliestBuyDate,
      lots: entry.lots,
      note: entry.lots.length === 1 ? entry.lots[0].note : '',
      latestClose: null,
      signal: null
    };
  });
  if (items.length === 0) return items;

  var latestByCode = getLatestCloseByCode_();
  var signalByCode = {};
  readSheetObjects_(getReportsSheet_()).forEach(function (r) {
    var code = zfill4(String(r['證券代號'] || '').trim());
    var d = normalizeDateStr(r['日期']);
    if (!signalByCode[code] || d > signalByCode[code].date) {
      signalByCode[code] = { date: d, strategy: r['操作策略'], action: r['建議動作'] };
    }
  });

  items.forEach(function (it) {
    if (latestByCode[it.code]) it.latestClose = latestByCode[it.code].close;
    if (signalByCode[it.code]) it.signal = signalByCode[it.code];
  });
  items.sort(function (a, b) { return a.code < b.code ? -1 : 1; });
  return items;
}

/**
 * 新增一筆買進紀錄，或編輯既有的一筆（依 item.lotId 判斷，不帶就是新增）。
 * item: {lotId?, code, name, cost, buyDate, shares, note}
 */
function savePortfolioItem(item) {
  if (!item || !item.code) throw new Error('股票代號不可為空');
  var code = zfill4(String(item.code).trim());
  var sheet = getPortfolioSheet_();
  var rows = readSheetObjects_(sheet);

  if (item.lotId) {
    var found = false;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i]['交易ID'] === item.lotId) {
        rows[i]['證券代號'] = code;
        rows[i]['證券名稱'] = item.name || rows[i]['證券名稱'] || '';
        rows[i]['買進價格'] = toNumber(item.cost);
        rows[i]['股數'] = toNumber(item.shares) || rows[i]['股數'] || PORTFOLIO_DEFAULT_LOT_SHARES_;
        rows[i]['買進日期'] = item.buyDate || rows[i]['買進日期'] || '';
        rows[i]['備註'] = item.note || '';
        found = true;
        break;
      }
    }
    if (!found) throw new Error('找不到這筆買進紀錄，可能已被刪除，請重新整理後再試一次');
  } else {
    rows.push({
      '交易ID': Utilities.getUuid(),
      '證券代號': code,
      '證券名稱': item.name || '',
      '買進日期': item.buyDate || '',
      '買進價格': toNumber(item.cost),
      '股數': toNumber(item.shares) || PORTFOLIO_DEFAULT_LOT_SHARES_,
      '備註': item.note || '',
      '狀態': '持有中',
      '賣出日期': '',
      '賣出價格': ''
    });
  }
  writeSheetObjects_(sheet, CONFIG.PORTFOLIO_COLUMNS, rows);
  return getPortfolio();
}

/** 刪除單一一筆買進紀錄（依交易ID，不是依股票代號——同一檔可能有好幾筆）。 */
function deletePortfolioLot(lotId) {
  if (!lotId) throw new Error('缺少交易ID');
  var sheet = getPortfolioSheet_();
  var rows = readSheetObjects_(sheet).filter(function (r) { return r['交易ID'] !== lotId; });
  writeSheetObjects_(sheet, CONFIG.PORTFOLIO_COLUMNS, rows);
  return getPortfolio();
}

/** 保留給還在用舊版前端（只知道股票代號、不知道交易ID）呼叫的相容用法：刪掉某檔股票全部
 *  「持有中」的紀錄。新版前端請一律用 deletePortfolioLot(lotId) 刪除單一一筆。 */
function deletePortfolioItem(code) {
  var target = zfill4(String(code).trim());
  var sheet = getPortfolioSheet_();
  var rows = readSheetObjects_(sheet).filter(function (r) {
    return !(zfill4(String(r['證券代號'] || '').trim()) === target && (r['狀態'] || '持有中') === '持有中');
  });
  writeSheetObjects_(sheet, CONFIG.PORTFOLIO_COLUMNS, rows);
  return getPortfolio();
}

/**
 * 「💰 標示已賣出/結案」：把某檔股票目前所有「持有中」的紀錄一次性標記為已賣出（用同一個
 * 賣出日期/價格），移到「歷史結案紀錄」。不支援部分賣出——想部分獲利了結的話，可以先刪除
 * 想保留的那幾筆買進紀錄以外的其他筆，只結案想結束的那幾筆（進階用法），這裡先解決
 * 「一次全部賣掉」這個最常見的情境。
 */
function closePortfolioPosition(code, sellDate, sellPrice) {
  code = zfill4(String(code || '').trim());
  if (!code) throw new Error('股票代號不可為空');
  sellPrice = toNumber(sellPrice);
  if (!sellPrice) throw new Error('請輸入賣出價格');
  if (!sellDate) throw new Error('請輸入賣出日期');

  var sheet = getPortfolioSheet_();
  var rows = readSheetObjects_(sheet);
  var closedCount = 0;
  rows.forEach(function (r) {
    if (zfill4(String(r['證券代號'] || '').trim()) === code && (r['狀態'] || '持有中') === '持有中') {
      r['狀態'] = '已賣出';
      r['賣出日期'] = sellDate;
      r['賣出價格'] = sellPrice;
      closedCount++;
    }
  });
  if (closedCount === 0) throw new Error('找不到 ' + code + ' 目前持有中的買進紀錄');
  writeSheetObjects_(sheet, CONFIG.PORTFOLIO_COLUMNS, rows);
  logRun_('持股結案', '成功', code + ' 標示已賣出，賣出價 ' + sellPrice + '（' + closedCount + ' 筆買進紀錄一併結案）', 0);
  return getPortfolio();
}

/**
 * 「歷史結案紀錄」頁面用：依股票代號＋賣出日期＋賣出價格分組（同一次結案動作的所有 lot
 * 共用同一組賣出日期/價格），算出已實現損益。
 */
function getClosedPortfolioHistory() {
  var lots = readPortfolioLots_().filter(function (r) { return r['狀態'] === '已賣出'; });
  var byGroup = {};
  var order = [];
  lots.forEach(function (r) {
    var code = zfill4(String(r['證券代號'] || '').trim());
    var sellDate = normalizeDateStr(r['賣出日期']);
    var sellPrice = toNumber(r['賣出價格']);
    var key = code + '|' + sellDate + '|' + sellPrice;
    if (!byGroup[key]) {
      byGroup[key] = { code: code, name: r['證券名稱'] || '', sellDate: sellDate, sellPrice: sellPrice, lots: [] };
      order.push(key);
    }
    byGroup[key].lots.push({
      buyDate: normalizeDateStr(r['買進日期']), cost: toNumber(r['買進價格']), shares: toNumber(r['股數'])
    });
  });

  var groups = order.map(function (key) {
    var g = byGroup[key];
    var agg = aggregateLots_(g.lots.map(function (l) {
      return { '股數': l.shares, '買進價格': l.cost, '買進日期': l.buyDate };
    }));
    return {
      code: g.code,
      name: g.name,
      sellDate: g.sellDate,
      sellPrice: g.sellPrice,
      avgCost: agg.avgCost,
      totalShares: agg.totalShares,
      buyDate: agg.earliestBuyDate,
      realizedPct: agg.avgCost ? round_((g.sellPrice - agg.avgCost) / agg.avgCost * 100, 2) : null,
      realizedAmount: round_((g.sellPrice - agg.avgCost) * agg.totalShares, 0)
    };
  });
  groups.sort(function (a, b) { return a.sellDate < b.sellDate ? 1 : -1; });
  return groups;
}
