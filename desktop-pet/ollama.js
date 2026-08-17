'use strict';

// desktop-pet「即時對話」的第二個聊天 provider——本機 Ollama，跟 chat.js（OpenAI）介面
// 形狀刻意一致（{ reply } / 分類過的 Error），呼叫端（main.js）可以直接用同一套錯誤處理
// 包住兩者，只在最上層依設定分流。見 docs/specs/0005-desktop-pet-ollama-provider.md、
// docs/adr/0001-openai-for-live-chat.md 的更新說明。
//
// 這裡跑在 Electron main process（Node），不是瀏覽器，所以不會撞到
// ai-quiz-generator/index.html 那邊瀏覽器呼叫 Ollama 常見的 CORS/OLLAMA_ORIGINS 問題——
// Node 的 fetch 不受同源政策限制，使用者不用額外設定 OLLAMA_ORIGINS 環境變數。
// 呼叫 Ollama 原生 /api/chat（不是 OpenAI 相容的 /v1/chat/completions），格式跟
// ai-quiz-generator 的 callOllama() 保持一致，同一份文件/除錯經驗兩邊都適用。

class OllamaError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OllamaError';
    this.code = code;
  }
}

// 使用者可能貼 '192.168.0.171:11434'、'localhost:11434'、'http://host:11434/api' 這些
// 不同寫法，一律正規化成乾淨的 origin（跟 ai-quiz-generator 的 _normalizeOllamaUrl 同款）。
function normalizeOllamaUrl(raw) {
  let s = (raw || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = 'http://' + s;
  try { return new URL(s).origin; } catch { return s; }
}

async function sendOllamaChatMessage({ message, systemPrompt, history = [], model, baseUrl, fetchImpl = fetch, signal }) {
  if (!message || !message.trim()) {
    throw new OllamaError('message is empty', 'INVALID_INPUT');
  }
  if (!model || !model.trim()) {
    throw new OllamaError('missing model', 'INVALID_INPUT');
  }
  if (!baseUrl || !baseUrl.trim()) {
    throw new OllamaError('missing base URL', 'INVALID_INPUT');
  }

  const origin = normalizeOllamaUrl(baseUrl);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: message },
  ];

  let response;
  try {
    response = await fetchImpl(origin + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal,
    });
  } catch (err) {
    // 使用者主動取消（AbortController.abort()）——不包裝成 OllamaError，讓呼叫端用
    // err.name === 'AbortError' 自己判斷這是取消還是真的連不上，兩者要顯示的
    // 訊息不一樣（取消不是錯誤，不用嚇使用者）。
    if (err.name === 'AbortError') throw err;
    // fetch 本身丟出例外（連不上主機）——這是「本機根本沒開 Ollama」最常見的樣子，
    // 訊息裡帶上 origin 讓使用者一眼看出是連錯位址還是真的沒開。
    throw new OllamaError(`network error: 無法連線到 ${origin}（${err.message}）`, 'NETWORK_ERROR');
  }

  if (!response.ok) {
    let bodyText = '';
    try { bodyText = await response.text(); } catch {}
    const detail = bodyText ? `：${bodyText}` : '';

    if (response.status === 404) {
      // 最常見原因是模型還沒 pull，訊息直接給複製貼上就能跑的指令。
      throw new OllamaError(`模型「${model}」找不到，請先在本機執行 ollama pull ${model}${detail}`, 'MODEL_NOT_FOUND');
    }
    throw new OllamaError(`Ollama API error (${response.status})${detail}`, 'API_ERROR');
  }

  const data = await response.json();
  const content = data.message && data.message.content;
  if (!content) {
    throw new OllamaError('Ollama 回傳空內容，請重試', 'EMPTY_REPLY');
  }
  return { reply: content };
}

// 設定畫面「測試連線」用：打 /api/tags 列出這台 Ollama 已經下載好的模型，
// 讓使用者從清單選，不用自己記模型名稱怎麼拼（跟 ai-quiz-generator 的
// testOllamaConnection() 同一個端點）。
async function listOllamaModels({ baseUrl, fetchImpl = fetch }) {
  if (!baseUrl || !baseUrl.trim()) {
    throw new OllamaError('missing base URL', 'INVALID_INPUT');
  }
  const origin = normalizeOllamaUrl(baseUrl);

  let response;
  try {
    response = await fetchImpl(origin + '/api/tags');
  } catch (err) {
    throw new OllamaError(`network error: 無法連線到 ${origin}（${err.message}）`, 'NETWORK_ERROR');
  }

  if (!response.ok) {
    throw new OllamaError(`Ollama API error (${response.status})`, 'API_ERROR');
  }

  const data = await response.json();
  const models = Array.isArray(data.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
  return { models };
}

module.exports = { sendOllamaChatMessage, listOllamaModels, normalizeOllamaUrl, OllamaError };
