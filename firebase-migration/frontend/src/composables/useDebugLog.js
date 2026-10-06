/**
 * useDebugLog.js
 * 手機瀏覽器沒有內建 DevTools，沒辦法像桌機那樣開 Network 分頁看失敗請求的細節
 * ——這支把 console.error/console.warn、沒被 catch 到的例外、以及呼叫
 * identitytoolkit.googleapis.com／cloudfunctions.net 的 fetch 請求（連同失敗
 * 回應的內容）全部記到一個畫面上就能看到、也能一鍵複製的清單裡，取代「打開
 * DevTools 貼內容給別人看」這個手機上做不到的步驟。
 *
 * 只在第一次呼叫 useDebugLog() 時安裝一次全域攔截（console/fetch/
 * window.onerror），之後每次呼叫都回傳同一份清單——整個 App 共用一份紀錄，
 * 不是每個元件各自攔截一次。
 */
import { ref } from 'vue';

const entries = ref([]);
const MAX_ENTRIES = 300;

/** 這次部署的 build 版本——是哪個 commit 建出來的，用來分辨手機上看到的是不是
 *  真的最新版（跟之前追快取問題時「畫面明明是舊版但看不出來」那次踩的坑直接
 *  對應）。`VITE_BUILD_SHA` 由 .github/workflows/deploy-firebase.yml 在 CI build
 *  時從 `github.sha` 帶進來；手動在 Cloud Shell 跑 `npm run build` 的話這個值
 *  預設是空的，顯示成 'local'，一樣看得出不是透過自動部署建的。 */
export const BUILD_VERSION = (import.meta.env.VITE_BUILD_SHA || 'local').slice(0, 7);

function stringify(v) {
  if (v instanceof Error) {
    return v.code ? `${v.message}（code: ${v.code}）` : v.message;
  }
  if (typeof v === 'object' && v !== null) {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function truncate(s, n = 800) {
  return s.length > n ? s.slice(0, n) + '…（已截斷）' : s;
}

function pushLog(level, message) {
  entries.value.push({
    time: new Date().toLocaleTimeString('zh-TW', { hour12: false }),
    level,
    message: String(message)
  });
  if (entries.value.length > MAX_ENTRIES) entries.value.shift();
}

function installGlobalCapture() {
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.error = function (...args) {
    origError(...args);
    pushLog('error', args.map(stringify).join(' '));
  };
  console.warn = function (...args) {
    origWarn(...args);
    pushLog('warn', args.map(stringify).join(' '));
  };

  window.addEventListener('error', function (e) {
    pushLog('error', `未捕捉的錯誤：${e.message}`);
  });
  window.addEventListener('unhandledrejection', function (e) {
    pushLog('error', `未捕捉的 Promise 錯誤：${stringify(e.reason)}`);
  });

  if (window.fetch) {
    const origFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      const start = Date.now();
      try {
        const res = await origFetch(...args);
        const ms = Date.now() - start;
        const isRelevant = /identitytoolkit\.googleapis\.com|cloudfunctions\.net/.test(url);
        if (!res.ok || isRelevant) {
          const clone = res.clone();
          clone
            .text()
            .then(function (body) {
              pushLog(res.ok ? 'info' : 'error', `${res.status} ${url}（${ms}ms）\n${truncate(body)}`);
            })
            .catch(function () {});
        }
        return res;
      } catch (err) {
        pushLog('error', `fetch 失敗：${url} — ${stringify(err)}`);
        throw err;
      }
    };
  }
}

let installed = false;

export function useDebugLog() {
  if (!installed) {
    installed = true;
    installGlobalCapture();
    pushLog('info', `除錯日誌已啟動（版本 ${BUILD_VERSION}）——會記錄 console.error/warn、沒被 catch 的例外，以及打給 Firebase 的請求（含失敗回應內容）。`);
  }
  function clear() {
    entries.value.splice(0, entries.value.length);
  }
  return { entries, pushLog, clear };
}
