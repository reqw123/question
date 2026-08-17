'use strict';

// desktop-pet「即時對話」的測試 seam之二：純函式模組，不 import 任何 Electron API、
// 不引入額外的 HTML parser 套件（保持零依賴）。
// 對外契約：給網址 → fetch HTML → 去標籤轉純文字（截斷長度）→ 回傳文字，
// 或在失敗時拋出分類過的 PageDigestError（見 docs/specs/0002-desktop-pet-live-chat.md）。

const MAX_TEXT_LENGTH = 4000; // 避免整篇網頁塞爆聊天請求的 token

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

class PageDigestError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PageDigestError';
    this.code = code;
  }
}

async function fetchPageText({ url, fetchImpl = fetch, signal }) {
  if (!url || !/^https?:\/\//i.test(url.trim())) {
    throw new PageDigestError('invalid url', 'INVALID_INPUT');
  }

  let response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (err) {
    // 使用者主動取消（AbortController.abort()）——不包裝成 PageDigestError，見呼叫端
    // main.js 的說明：取消時要整個跳過「當作讀取失敗、照樣送去問 AI」那條路，不是
    // 顯示成一般的網址讀取失敗訊息。
    if (err.name === 'AbortError') throw err;
    throw new PageDigestError(`network error: ${err.message}`, 'NETWORK_ERROR');
  }
  if (!response.ok) {
    throw new PageDigestError(`fetch failed (${response.status})`, 'FETCH_ERROR');
  }

  const html = await response.text();
  const text = stripHtml(html);
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

module.exports = { fetchPageText, PageDigestError, MAX_TEXT_LENGTH };
