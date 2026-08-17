'use strict';

// desktop-pet「語音輸入」的測試 seam之一：純函式模組，不 import 任何 Electron API。
// 對外契約：給錄音的 bytes/key → 呼叫 OpenAI Whisper API → 回傳轉錄文字，
// 或在失敗時拋出分類過的 SttError（見 docs/specs/0004-desktop-pet-voice-input.md）。
// 介面形狀刻意跟 tts.js/chat.js 一致。

class SttError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SttError';
    this.code = code;
  }
}

// Whisper 對近乎無語音的音檔常常還是會「幻覺」出一段像模像樣的文字（例如「Thanks for
// watching」），但這種情況下模型自己回報的 no_speech_prob（每個 segment 認為這段其實
// 沒有語音的機率）通常也偏高。用這個信號當第二道防線，是刻意不去檢查/比對轉錄出來的
// 文字內容（猜幻覺片語有哪些既猜不完、也可能誤殺使用者真的講到類似字句），而是看模型
// 對「這裡有沒有語音」這件事本身的信心程度——跟 index.html 那道錄音期間 RMS 累計時長
// 的防線是兩個獨立來源（一個看錄音當下的音量，一個看轉錄模型的事後判斷），任一道失守
// 另一道還能擋。門檻 0.6 沒有精確科學依據，是社群常見的經驗值。
//
// 判斷方式是「至少一個 segment 有信心地認為有語音」，不是「segments 平均值」：
// index.html 的錄音邏輯設計上固定會在偵測到安靜後，還多錄 DEFAULT_SILENCE_DURATION_MS
// （見 silence-detector.js，目前 1500ms）才真的停止——也就是每一段錄音幾乎一定帶著一截
// 尾端靜音。這截尾端靜音常常會被 Whisper 切成獨立的高 no_speech_prob segment，如果拿
// 全部 segment 取平均，一句簡短的真實發言＋這截固定會有的尾端靜音，平均值很容易被拉過
// 0.6 門檻，變成「講了話卻被整段丟棄、輸入框完全沒有反應」（使用者看得到麥克風變紅在
// 錄音，轉錄卻悄悄被判定成沒講話，UI 上沒有任何錯誤訊息可看）。改成「只要有任一個
// segment 信心地判斷有語音，就採信這次轉錄」，尾端靜音那截 segment 不會拖累真正講話
// 那截 segment 的判斷。
const NO_SPEECH_PROB_THRESHOLD = 0.6;

async function transcribeAudio({ audioBuffer, mimeType = 'audio/webm', apiKey, fetchImpl = fetch, signal }) {
  if (!audioBuffer || audioBuffer.length === 0) {
    throw new SttError('audio buffer is empty', 'INVALID_INPUT');
  }
  if (!apiKey) {
    throw new SttError('missing API key', 'INVALID_INPUT');
  }

  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('file', new Blob([audioBuffer], { type: mimeType }), 'audio.webm');
  // verbose_json 讓回應多帶 segments[].no_speech_prob，見上面 NO_SPEECH_PROB_THRESHOLD
  // 的說明。
  form.append('response_format', 'verbose_json');

  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
  } catch (err) {
    // 使用者主動取消（AbortController.abort()）——不包裝成 SttError，讓呼叫端用
    // err.name === 'AbortError' 自己判斷這是取消還是真的網路失敗，兩者要顯示的
    // 訊息不一樣（取消不是錯誤，不用嚇使用者）。
    if (err.name === 'AbortError') throw err;
    throw new SttError(`network error: ${err.message}`, 'NETWORK_ERROR');
  }

  if (!response.ok) {
    let bodyText = '';
    try { bodyText = await response.text(); } catch {}
    const detail = bodyText ? `: ${bodyText}` : '';

    if (response.status === 401 || response.status === 403) {
      throw new SttError(`OpenAI auth error (${response.status})${detail}`, 'AUTH_ERROR');
    }
    if (response.status === 429) {
      throw new SttError(`OpenAI rate limit or quota exceeded${detail}`, 'RATE_LIMIT');
    }
    throw new SttError(`OpenAI API error (${response.status})${detail}`, 'API_ERROR');
  }

  const data = await response.json();
  const segments = Array.isArray(data.segments) ? data.segments : [];
  if (segments.length > 0) {
    const hasConfidentSpeech = segments.some((seg) => (seg.no_speech_prob || 0) < NO_SPEECH_PROB_THRESHOLD);
    if (!hasConfidentSpeech) {
      // 每一個 segment 模型自己都覺得很可能沒有語音——即使吐出了文字，也當作沒講話，
      // 不要把可能是幻覺的文字回傳給呼叫端。
      return { text: '' };
    }
  }
  return { text: (data.text || '').trim() };
}

module.exports = { transcribeAudio, SttError };
