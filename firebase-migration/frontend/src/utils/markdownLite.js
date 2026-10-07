/**
 * markdownLite.js
 * 把 AI 診斷回應（Claude／Gemini 依 AI_DIAGNOSIS_SYSTEM_PROMPT 的「# Output
 * Format」寫死輸出格式的 Markdown 文字，見 functions/lib/aiDiagnosis.js）轉成
 * 可以直接閱讀的 HTML——跟舊版 apps-script/src/JavaScript.html 的
 * renderMarkdownLite／splitMarkdownSections_／pickSectionIcon_ 同一個精神
 * （純文字 dump 出來完全不可讀，舊版這幾支函式解決的就是這個問題），這裡是
 * 獨立重寫的版本，不是逐字搬運，但轉換規則跟涵蓋範圍刻意保持一致：只處理
 * AI 診斷模板用到的標題/表格/引用/粗體/清單，不是完整的 Markdown 解析器。
 *
 * 安全性：所有文字內容都先用 escapeHtml 跳脫過，只有這支檔案自己產生的標籤
 * （p/strong/blockquote/hr/div）會被當成真正的 HTML 插入，即使 AI 回應裡
 * 真的出現 `<script>` 這種文字，也只會被當成逐字顯示的文字，不會被瀏覽器
 * 當成標籤執行——傳進 v-html 之前已經做過這層跳脫。
 */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 行內格式：目前只有 **粗體**（AI_DIAGNOSIS_SYSTEM_PROMPT 的輸出格式只用到
 *  這一種行內標記）。先跳脫 HTML 特殊字元，再處理 `**...**`，避免跳脫動作
 *  把 `**` 自己跳脫掉或把插入的 `<strong>` 標籤也跳脫掉。 */
function inlineMd(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function isTableRow(line) {
  return /^\|.*\|$/.test(line.trim());
}

/** 拿掉開頭/結尾的 `|`，依剩下的 `|` 切欄位，每欄去掉前後空白。 */
function parseTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
}

/** Markdown 表格的對齊標記列（`| :--- | :--- |`），每欄都是這個形狀就跳過
 *  不當成真正的資料列。 */
function isAlignmentRow(cells) {
  return cells.length > 0 && cells.every(function (c) { return /^:?-+:?$/.test(c); });
}

/**
 * 表格刻意不轉成 `<table>`——手機螢幕窄，欄位一多整個表格會被壓縮到看不清楚
 * （這正是舊版改用 kv-card 呈現的理由）。改成每一列資料變成一張小卡片：卡片
 * 標題用第一欄的值（通常是項目名稱，例如「營收與三率」），其餘每一欄變成
 * 「欄位名稱：這一列在這欄的值」的 key-value 列，值是空字串就跳過那一行，
 * 不留一排空白。
 */
function renderTableAsCards(rows) {
  if (rows.length === 0) return '';
  var headers = rows[0];
  var dataRows = rows.slice(1);
  var cardsHtml = dataRows.map(function (cells) {
    var title = inlineMd(cells[0] || '');
    var kvHtml = headers.slice(1).map(function (h, i) {
      var value = cells[i + 1] || '';
      if (!value.trim()) return '';
      return '<div class="kv-row"><span class="kv-key">' + inlineMd(h) + '</span><span class="kv-value">' + inlineMd(value) + '</span></div>';
    }).join('');
    return '<div class="md-table-card"><div class="md-table-card-title">' + title + '</div>' + kvHtml + '</div>';
  }).join('');
  return '<div class="md-table-cards">' + cardsHtml + '</div>';
}

/** 單一區塊（intro 或 splitMarkdownSections 拆出來的某一節）轉成 HTML 字串。 */
export function renderMarkdownLite(markdown) {
  var lines = String(markdown || '').split('\n');
  var htmlParts = [];
  var paragraphBuf = [];
  var blockquoteBuf = [];

  function flushParagraph() {
    if (paragraphBuf.length) {
      htmlParts.push('<p>' + inlineMd(paragraphBuf.join(' ')) + '</p>');
      paragraphBuf = [];
    }
  }
  function flushBlockquote() {
    if (blockquoteBuf.length) {
      htmlParts.push('<blockquote>' + blockquoteBuf.map(inlineMd).join('<br>') + '</blockquote>');
      blockquoteBuf = [];
    }
  }

  var i = 0;
  while (i < lines.length) {
    var line = lines[i].trim();

    if (line === '') { flushParagraph(); flushBlockquote(); i++; continue; }

    if (/^-{3,}$/.test(line)) { flushParagraph(); flushBlockquote(); htmlParts.push('<hr>'); i++; continue; }

    if (/^#{1,6}\s+/.test(line)) {
      // 區塊切分已經在 splitMarkdownSections 做過，正常不會再遇到標題行——
      // 防禦性處理，退化成粗體一行，不是真的當成巢狀標題渲染。
      flushParagraph(); flushBlockquote();
      htmlParts.push('<p><strong>' + inlineMd(line.replace(/^#{1,6}\s+/, '')) + '</strong></p>');
      i++; continue;
    }

    if (line.charAt(0) === '>') {
      flushParagraph();
      blockquoteBuf.push(line.replace(/^>\s?/, ''));
      i++; continue;
    }

    if (isTableRow(line)) {
      flushParagraph(); flushBlockquote();
      var tableRows = [];
      while (i < lines.length && isTableRow(lines[i].trim())) {
        tableRows.push(parseTableRow(lines[i]));
        i++;
      }
      var dataOnly = tableRows.filter(function (cells) { return !isAlignmentRow(cells); });
      htmlParts.push(renderTableAsCards(dataOnly));
      continue;
    }

    if (/^[*-]\s+/.test(line)) {
      flushParagraph(); flushBlockquote();
      htmlParts.push('<div class="md-li">• ' + inlineMd(line.replace(/^[*-]\s+/, '')) + '</div>');
      i++; continue;
    }

    flushBlockquote();
    paragraphBuf.push(line);
    i++;
  }
  flushParagraph();
  flushBlockquote();
  return htmlParts.join('');
}

/**
 * 把整份診斷內容拆成 intro（從開頭到第一個標題那一段，含風險評級的引言段）
 * 跟後面每個 `###` 標題各自獨立的一節——AI_DIAGNOSIS_SYSTEM_PROMPT 的輸出
 * 格式固定是 `## 🚨 策略個股總體診斷：...`（含風險評級）接著五個 `### 一、
 * ...` 到 `### 五、...` 小節，這裡依任意層級的標題行切，不假設一定是 ##/###
 * （防禦性處理，LLM 偶爾會輸出跟範本層級不完全一致的標題)。
 */
export function splitMarkdownSections(markdown) {
  var lines = String(markdown || '').split('\n');
  var headerIdx = [];
  lines.forEach(function (line, i) {
    if (/^#{1,6}\s+/.test(line.trim())) headerIdx.push(i);
  });
  if (headerIdx.length === 0) return { intro: markdown, sections: [] };

  var chunks = [];
  for (var i = 0; i < headerIdx.length; i++) {
    var start = headerIdx[i];
    var end = i + 1 < headerIdx.length ? headerIdx[i + 1] : lines.length;
    chunks.push(lines.slice(start, end).join('\n'));
  }
  var leading = lines.slice(0, headerIdx[0]).join('\n');
  var intro = (leading.trim() ? leading + '\n' : '') + chunks[0];
  var sections = chunks.slice(1).map(function (chunk) {
    var chunkLines = chunk.split('\n');
    var title = chunkLines[0].replace(/^#{1,6}\s+/, '').trim();
    return { title: title, body: chunkLines.slice(1).join('\n') };
  });
  return { intro: intro, sections: sections };
}

/** 「最終操作決策」那一節已經在上面的結論橫幅顯示過一次，不用在底下的
 *  收合清單裡重複一次——跟舊版 renderAiDiagnosisReportBody_ 排除同一節的
 *  邏輯一致。 */
var FINAL_DECISION_TITLE_RE = /最終操作決策|最終建議/;

export function sectionsExcludingFinalDecision(markdown) {
  return splitMarkdownSections(markdown).sections.filter(function (s) {
    return !FINAL_DECISION_TITLE_RE.test(s.title);
  });
}

/** 依標題文字挑一個代表性 emoji，純粹是讓收合清單掃過去更快分辨每一節在講
 *  什麼，跟舊版 pickSectionIcon_ 同一套規則。 */
export function pickSectionIcon(title) {
  var t = String(title || '');
  if (/CoVE|驗證|警示/.test(t)) return '🛡️';
  if (/財務|EPS|ROE/.test(t)) return '📑';
  if (/護城河|產業/.test(t)) return '🏢';
  if (/籌碼|技術/.test(t)) return '📊';
  return '📄';
}

/** 跟 functions/lib/aiDiagnosis.js 的 extractCoreReason_ 同一個規則，前端
 *  重複一份而不是跨前後端共用——這是展示層需要的小抽取，單一正規表示式，
 *  不值得為了共用建一個前後端都能 import 的套件。 */
export function extractCoreReason(text) {
  var m = String(text || '').match(/\*\*核心理由：\*\*\s*(.+)/);
  return m ? m[1].trim() : '';
}

/** 結論橫幅要上色成「偏多」還是「偏空」——深度診斷／持股續抱診斷各四個結論選項
 *  （見 functions/lib/aiDiagnosis.js 的 AI_VERDICT_OPTIONS_），分組對應舊版
 *  AI_VERDICT_UP_/AI_VERDICT_DOWN_ 的精神：「續抱」跟「加碼」都算正向（原本看好
 *  的理由還成立，或更成立），「減碼」跟「出場」都算負向。 */
var VERDICT_UP = ['強力買入', '分批布局', '體質轉強，加碼', '體質穩健，續抱'];
var VERDICT_DOWN = ['立刻退出', '體質轉弱，減碼', '體質惡化，出場'];

export function verdictDirection(verdict) {
  if (VERDICT_UP.indexOf(verdict) !== -1) return 'up';
  if (VERDICT_DOWN.indexOf(verdict) !== -1) return 'down';
  return 'neutral'; // 觀望不追 / 未明確
}
