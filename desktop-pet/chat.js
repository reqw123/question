'use strict';

// desktop-pet「即時對話」的測試 seam之一：純函式模組，不 import 任何 Electron API。
// 對外契約：給訊息/人設/歷史/key → 呼叫 OpenAI Chat Completions API → 回傳回覆文字，
// 或在失敗時拋出分類過的 ChatError（見 docs/specs/0002-desktop-pet-live-chat.md）。
// 介面形狀刻意跟 tts.js 的 synthesizeSpeech() 一致。

class ChatError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
  }
}

async function sendChatMessage({ message, systemPrompt, history = [], apiKey, model = 'gpt-4o-mini', fetchImpl = fetch }) {
  if (!message || !message.trim()) {
    throw new ChatError('message is empty', 'INVALID_INPUT');
  }
  if (!apiKey) {
    throw new ChatError('missing API key', 'INVALID_INPUT');
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: message },
  ];

  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages }),
    });
  } catch (err) {
    throw new ChatError(`network error: ${err.message}`, 'NETWORK_ERROR');
  }

  if (!response.ok) {
    let bodyText = '';
    try { bodyText = await response.text(); } catch {}
    const detail = bodyText ? `: ${bodyText}` : '';

    if (response.status === 401 || response.status === 403) {
      throw new ChatError(`OpenAI auth error (${response.status})${detail}`, 'AUTH_ERROR');
    }
    if (response.status === 429) {
      throw new ChatError(`OpenAI rate limit or quota exceeded${detail}`, 'RATE_LIMIT');
    }
    throw new ChatError(`OpenAI API error (${response.status})${detail}`, 'API_ERROR');
  }

  const data = await response.json();
  return { reply: data.choices[0].message.content };
}

module.exports = { sendChatMessage, ChatError };
