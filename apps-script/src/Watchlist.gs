/**
 * Watchlist.gs
 * 觀察個股清單：跟「持股庫存」不同，這裡存的是「還沒有買、但想繼續追蹤」的股票——常見情境
 * 是某檔股票曾經出現在戰報候選名單裡，後來因為排名/因子變化不再出現，但使用者還是想不定期
 * 回來看看它現在的整體評估情形（點進股票詳情 modal 看 AI 深度診斷／走勢），不用每次都重新
 * 用代號手動搜尋、也不用記住到底是哪些代號想追蹤。
 *
 * 跟持股庫存刻意保持互斥，同一檔股票同一時間只會出現在其中一份清單：
 * - 已經是「持有中」的股票不能加進觀察清單（見 addToWatchlist）——已經買了就直接去持股庫存
 *   管理，繼續留在觀察清單只是徒增一份對不起來的重複資訊。
 * - 反過來，一旦某檔觀察中的股票被實際買進（Portfolio.gs savePortfolioItem 新增一筆全新
 *   持有），會自動從觀察清單移除（見 removeFromWatchlistSilently_），不用使用者自己記得
 *   手動同步兩份清單。
 */

function getWatchlistSheet_() {
  return ensureSheetWithHeaders_(getSpreadsheet_(), CONFIG.SHEET_NAMES.WATCHLIST, CONFIG.WATCHLIST_COLUMNS);
}

function readWatchlistRows_() {
  return readSheetObjects_(getWatchlistSheet_());
}

/**
 * 供「持股庫存」頁面的「觀察個股」子分頁呼叫：依加入日期新到舊排序，補上跟持股卡片一致的
 * 「最近一次戰報燈號」跟最新收盤價，一眼就能看出這檔股票現在的訊號還在不在戰報裡、價格
 * 大概到哪裡，不用每張卡片都點開才知道。
 */
function getWatchlist() {
  var rows = readWatchlistRows_();
  var items = rows.map(function (r) {
    return {
      code: zfill4(String(r['證券代號'] || '').trim()),
      name: r['證券名稱'] || '',
      addedDate: normalizeDateStr(r['加入日期']),
      note: r['備註'] || ''
    };
  }).filter(function (it) { return it.code; });
  if (items.length === 0) return items;

  // 補救措施：跟 getPortfolio() 一樣，名稱是空的（例如用純代號加入、沒有透過自動完成帶入
  // 名稱）就順便補一次，不用逐筆手動編輯。
  items.forEach(function (it) {
    if (it.name) return;
    var found = getStockNameByCode(it.code);
    if (found && found.name) it.name = found.name;
  });

  var latestByCode = getLatestCloseByCode_(items.map(function (it) { return it.code; }));
  var signalByCode = {};
  readSheetObjects_(getReportsSheet_()).forEach(function (r) {
    var code = zfill4(String(r['證券代號'] || '').trim());
    var d = normalizeDateStr(r['日期']);
    if (!signalByCode[code] || d > signalByCode[code].date) {
      signalByCode[code] = { date: d, strategy: r['操作策略'], action: r['建議動作'] };
    }
  });
  items.forEach(function (it) {
    it.latestClose = latestByCode[it.code] ? latestByCode[it.code].close : null;
    it.signal = signalByCode[it.code] || null;
  });
  items.sort(function (a, b) { return (a.addedDate || '') < (b.addedDate || '') ? 1 : -1; });
  return items;
}

/**
 * 加入觀察清單。code 必填，name/note 選填。
 * - 已經是「持有中」的股票（見 Portfolio.gs getPortfolioMap_）不能加入，直接報錯提醒改去
 *   持股庫存管理——這是使用者明確要的「跟持有清單互相檢查重複」。
 * - 同一檔股票重複加入不會產生第二列，只會更新名稱/備註（視為「更新這筆觀察」）。
 */
function addToWatchlist(code, name, note) {
  if (!code) throw new Error('股票代號不可為空');
  code = zfill4(String(code).trim());

  if (getPortfolioMap_()[code]) {
    throw new Error(code + ' 目前是持有中的股票，已經在「持股庫存」裡了，不需要重複加進觀察清單');
  }

  var sheet = getWatchlistSheet_();
  var rows = readSheetObjects_(sheet);
  var existing = rows.filter(function (r) { return zfill4(String(r['證券代號'] || '').trim()) === code; })[0];
  if (existing) {
    existing['證券名稱'] = name || existing['證券名稱'] || '';
    existing['備註'] = note || existing['備註'] || '';
  } else {
    rows.push({
      '證券代號': code,
      '證券名稱': name || '',
      '加入日期': normalizeDateStr(new Date()),
      '備註': note || ''
    });
  }
  writeSheetObjects_(sheet, CONFIG.WATCHLIST_COLUMNS, rows);
  logRun_('觀察清單', '成功', (existing ? '更新' : '新增') + ' ' + code + ' 觀察名單', 0);
  return getWatchlist();
}

function removeFromWatchlist(code) {
  if (!code) throw new Error('股票代號不可為空');
  code = zfill4(String(code).trim());
  var sheet = getWatchlistSheet_();
  var rows = readSheetObjects_(sheet).filter(function (r) { return zfill4(String(r['證券代號'] || '').trim()) !== code; });
  writeSheetObjects_(sheet, CONFIG.WATCHLIST_COLUMNS, rows);
  return getWatchlist();
}

/**
 * 「持股庫存」新增一筆全新持有（Portfolio.gs savePortfolioItem）時呼叫：這檔股票既然已經
 * 真的買進，就不再只是「觀察」，自動從觀察清單移除，避免兩份清單長期同時列出同一檔股票、
 * 需要使用者自己手動同步。本來就不在觀察清單（絕大多數情況）是正常狀況，不當錯誤處理；
 * 就算寫入真的失敗，也不該讓整筆買進紀錄跟著失敗——最壞情況只是觀察清單多留一筆其實已經
 * 買進的股票，之後手動刪除就好，不影響持股庫存本身的正確性。
 */
function removeFromWatchlistSilently_(code) {
  try { removeFromWatchlist(code); } catch (e) { /* 不讓觀察清單同步失敗擋住真正的買進紀錄 */ }
}
