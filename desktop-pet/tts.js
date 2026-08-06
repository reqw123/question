'use strict';

// desktop-pet「語音播放」的唯一測試 seam：純函式模組，不 import 任何 Electron API。
// 對外契約：給文字（跟可選的 voice/fetchImpl）→ 呼叫 OpenAI TTS API → 回傳音檔 bytes，
// 或在失敗時拋出分類過的 TtsError（見 docs/specs/0001-desktop-pet-tts-playback.md）。

class TtsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
  }
}

const MAX_TEXT_LENGTH = 4096; // OpenAI TTS API 的輸入長度上限

async function synthesizeSpeech({ text, apiKey, voice = 'alloy', fetchImpl = fetch }) {
  if (!text || !text.trim()) {
    throw new TtsError('text is empty', 'INVALID_INPUT');
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new TtsError(`text exceeds ${MAX_TEXT_LENGTH} characters`, 'INVALID_INPUT');
  }
  if (!apiKey) {
    throw new TtsError('missing API key', 'INVALID_INPUT');
  }

  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'tts-1', voice, input: text }),
    });
  } catch (err) {
    throw new TtsError(`network error: ${err.message}`, 'NETWORK_ERROR');
  }

  if (!response.ok) {
    // 狀態碼只能分類錯誤種類，實際原因（model/voice 名稱錯誤、參數格式問題等）
    // 要看 OpenAI 回傳的錯誤內文才知道，讀不到就算了，不能讓診斷資訊本身又拋錯。
    let bodyText = '';
    try { bodyText = await response.text(); } catch {}
    const detail = bodyText ? `: ${bodyText}` : '';

    if (response.status === 401 || response.status === 403) {
      throw new TtsError(`OpenAI auth error (${response.status})${detail}`, 'AUTH_ERROR');
    }
    if (response.status === 429) {
      throw new TtsError(`OpenAI rate limit or quota exceeded${detail}`, 'RATE_LIMIT');
    }
    throw new TtsError(`OpenAI API error (${response.status})${detail}`, 'API_ERROR');
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { synthesizeSpeech, TtsError, MAX_TEXT_LENGTH };
