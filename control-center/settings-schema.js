'use strict';

// 控制中心（control-center.html）可管理欄位的單一事實來源。刻意不 require('electron')——
// 這個檔案要能在 vitest（純 Node，不是真的 Electron 行程）底下被直接測試，settings-store.js
// 因為開頭 `require('electron')` 的關係做不到這件事（純 Node 環境下 require('electron') 回傳
// 的是安裝路徑字串，不是真的 app 物件，一旦呼叫 app.getPath() 就會炸），所以「驗證/差異
// 比對/匯出過濾」這些不需要碰檔案系統的邏輯全部放在這裡，settings-store.js 只負責讀寫檔案、
// 呼叫這裡的函式做驗證，不重新寫一份驗證邏輯。
//
// 新增一個可調整欄位只需要在 SCHEMA 加一筆——control-center.html 的表單、
// settings-store.js 的白名單驗證，都是照這份陣列自動長出來/自動套用，不用另外改表單
// 程式碼或驗證程式碼。
//
// 每個欄位描述：
//   key             settings.json 裡的實際 key（跟 settings-store.js 既有 getX/setX 用的
//                    key 完全一致，這樣才能共用同一份 settings.json，不是另外開一份檔案）
//   tab             控制中心裡所屬分頁（'chat' | 'voice' | 'display' | 'cli'）
//   label           顯示名稱
//   description     使用者看得懂的用途說明
//   type            'boolean' | 'number' | 'text' | 'password' | 'select'
//   defaultValue    預設值——跟 settings-store.js 對應 getX() 沒存過時回傳的 fallback
//                    完全一致（照現有程式碼抄，不是憑印象）
//   min/max/step    僅 number 類型使用
//   choices         僅 select 類型使用，[{ value, label }]
//   restartRequired 是否要重啟桌寵才會生效
//   sensitive       true 的話值本身永遠不會出現在 renderer/log/匯出檔——只會有
//                    「已設定／未設定」這種狀態，不會有實際值
//   existingSetting 這個欄位在這次改動之前就已經存在於 settings-store.js（跟使用者要求
//                    的「先把現有已支援的設定安全納入」對應，全部是 true——這次沒有新增
//                    任何桌寵原本沒有的設定項目）
//   appliesAt       什麼時候真正生效（依現有程式碼行為判斷，不是憑感覺寫的）：
//                    'restart'        下次啟動桌寵（或 F8／套用角色選擇這種 reload）生效
//                    'nextChatSend'   下次送出聊天訊息（或呼叫 OpenAI／Ollama）生效
//                    'nextRecording'  下次開始錄音生效
//                    'immediate'      存檔當下就是新的生效狀態（沒有「下一次才生效」的延遲）
//   requiresNativeConfirm  true 代表這個欄位有專屬的、main process 原生二次確認流程
//                    （dialog.showMessageBox），控制中心不可以把它塞進一般的批次儲存，
//                    必須透過既有的專屬 IPC channel（例如 settings-set-cli-free-mode）
//
// 沒有放進這份 SCHEMA 的東西：API key 的「實際值」本身（只有 hasKey 狀態）、角色一/二的
// 模型選擇（那是 personas.json／name-manager 走的另一套系統，不是這份 settings.json）、
// 對話記憶清空（那是動作，不是「值」，沒有 default/current 的概念，控制中心走既有的
// settings-clear-memory channel，不透過這份 schema）。

const TABS = {
  chat: '聊天與 AI',
  voice: '語音輸入',
  display: '桌寵顯示',
  cli: 'CLI 與安全性',
};

const SCHEMA = [
  {
    key: 'openaiApiKey',
    tab: 'chat',
    label: 'OpenAI API Key',
    description: '即時對話（OpenAI 模式）與語音輸入轉錄（Whisper）都需要這組 key。控制中心只顯示「已設定／未設定」狀態，不會顯示金鑰本身；要更換或清除請用下方的專屬操作。',
    type: 'password',
    defaultValue: '',
    restartRequired: false,
    sensitive: true,
    existingSetting: true,
    appliesAt: 'nextChatSend',
  },
  {
    key: 'chatProvider',
    tab: 'chat',
    label: '即時對話 AI 提供者',
    description: '角色一/二共用同一個設定。Ollama 本機模型不用 OpenAI key、可離線／免費使用，但中文對話品質與速度通常不如雲端。',
    type: 'select',
    choices: [
      { value: 'openai', label: '☁️ OpenAI' },
      { value: 'ollama', label: '🖥️ Ollama 本機' },
    ],
    defaultValue: 'openai',
    restartRequired: false,
    sensitive: false,
    existingSetting: true,
    appliesAt: 'nextChatSend',
  },
  {
    key: 'ollamaBaseUrl',
    tab: 'chat',
    label: 'Ollama Base URL',
    description: '本機 Ollama 服務位址，僅在提供者選 Ollama 時使用。',
    type: 'text',
    defaultValue: 'http://localhost:11434',
    restartRequired: false,
    sensitive: false,
    existingSetting: true,
    appliesAt: 'nextChatSend',
  },
  {
    key: 'ollamaModel',
    tab: 'chat',
    label: 'Ollama 模型名稱',
    description: '例如 qwen2.5:7b。可先用「測試連線」查出這台 Ollama 已下載的模型清單。',
    type: 'text',
    defaultValue: 'qwen2.5:7b',
    restartRequired: false,
    sensitive: false,
    existingSetting: true,
    appliesAt: 'nextChatSend',
  },
  {
    key: 'micRmsThreshold',
    tab: 'voice',
    label: '聲音最低門檻（RMS）',
    description: '音量要達到這個值才算「有聲音」。環境雜音一直被誤判成有講話就調高一點；小聲說話常被當成沒講話就調低一點。',
    type: 'number',
    min: 0.005,
    max: 1,
    step: 0.005,
    defaultValue: 0.04,
    restartRequired: false,
    sensitive: false,
    existingSetting: true,
    appliesAt: 'nextRecording',
  },
  {
    key: 'micMinSpeechDurationMs',
    tab: 'voice',
    label: '聲音累計時長（毫秒）',
    description: '達到門檻的音量合計要累積多久才算「真的有講話」，用來濾掉單一次瞬間噪音（滑鼠聲、椅子聲）。',
    type: 'number',
    min: 0,
    max: 60000,
    step: 50,
    defaultValue: 400,
    restartRequired: false,
    sensitive: false,
    existingSetting: true,
    appliesAt: 'nextRecording',
  },
  {
    key: 'showLive2DOnStartup',
    tab: 'display',
    label: 'Live2D 模型啟動時預設顯示',
    description: '決定桌寵下次啟動（或 F8／套用角色選擇這種重新整理）時，Live2D 模型要不要預設顯示。不會立刻套用到目前畫面。',
    type: 'boolean',
    defaultValue: true,
    restartRequired: true,
    sensitive: false,
    existingSetting: true,
    appliesAt: 'restart',
  },
  {
    key: 'showParticleModelOnStartup',
    tab: 'display',
    label: '光粒子 3D 模型啟動時預設顯示',
    description: '決定桌寵下次啟動（或 F8／套用角色選擇這種重新整理）時，光粒子 3D 模型要不要預設顯示。現在開著/關著由系統匣選單控制，這裡改的是「下次開機」的起始狀態。',
    type: 'boolean',
    defaultValue: false,
    restartRequired: true,
    sensitive: false,
    existingSetting: true,
    appliesAt: 'restart',
  },
  {
    key: 'cliFreePermissionMode',
    tab: 'cli',
    label: 'CLI 模式免確認',
    description: '⚠️ 開啟後，CLI 模式（跟角色說「進入 CLI 模式」觸發）的寫檔/執行指令等風險操作會直接自動執行，不再逐步問你同意——等於拿掉「觸發短語被誤判也不會被誤執行」的最後一道防線。開啟時仍會跳出主程式的原生確認對話框，控制中心無法略過這個確認。',
    type: 'boolean',
    defaultValue: false,
    restartRequired: false,
    sensitive: false,
    existingSetting: true,
    appliesAt: 'immediate',
    requiresNativeConfirm: true,
  },
];

const APPLIES_AT_LABEL = {
  restart: '下次啟動生效',
  nextChatSend: '下次送出聊天訊息生效',
  nextRecording: '下次開始錄音生效',
  immediate: '立即生效',
};

function findField(key) {
  return SCHEMA.find((f) => f.key === key);
}

// 唯一允許被控制中心一般批次儲存流程寫入的 key 白名單——sensitive／requiresNativeConfirm
// 的欄位不算在內，那些各自有專屬流程（見檔案開頭說明），不可以被塞進 saveControlCenterSettings()
// 這種批次寫入路徑，避免繞過既有的二次確認或不小心把 API key 明文寫進去。
const BATCH_WRITABLE_KEYS = SCHEMA
  .filter((f) => !f.sensitive && !f.requiresNativeConfirm)
  .map((f) => f.key);

// 驗證單一欄位的原始輸入（字串/數字/布林，可能來自 renderer 或匯入的 JSON 檔，一律當作
// 不可信），回傳 { ok, value, error }——main process／settings-store.js 一定要呼叫這個，
// 不能只信任 renderer 端 <input min max> 那種前端驗證。
function validateFieldValue(field, rawValue) {
  if (!field) return { ok: false, error: '不明的欄位' };
  switch (field.type) {
    case 'boolean':
      return { ok: true, value: !!rawValue };
    case 'number': {
      const num = Number(rawValue);
      if (!Number.isFinite(num)) return { ok: false, error: `${field.label}必須是數字` };
      if (typeof field.min === 'number' && num < field.min) {
        return { ok: false, error: `${field.label}不能小於 ${field.min}` };
      }
      if (typeof field.max === 'number' && num > field.max) {
        return { ok: false, error: `${field.label}不能大於 ${field.max}` };
      }
      return { ok: true, value: num };
    }
    case 'select': {
      const choices = (field.choices || []).map((c) => c.value);
      if (!choices.includes(rawValue)) {
        return { ok: false, error: `${field.label}必須是：${choices.join('、')} 其中之一` };
      }
      return { ok: true, value: rawValue };
    }
    case 'text': {
      const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
      return { ok: true, value: trimmed };
    }
    default:
      return { ok: false, error: `不支援驗證欄位類型：${field.type}` };
  }
}

// 驗證一批要寫入的設定（渲染端送來的 payload 或匯入的 JSON），回傳
// { ok, values, errors }：
//   - values 只會包含 BATCH_WRITABLE_KEYS 白名單內、且通過驗證的欄位（不在白名單/不在
//     schema 裡的 key 一律被忽略，不會被寫入——不允許任意 key 寫入 settings.json）。
//   - errors 是 [{ key, label, message }]，任何一筆驗證失敗都不會讓其他欄位一起失敗，
//     呼叫端可以自行決定「部分成功」或「全部一起擋下來」（settings-store.js 選擇後者，
//     見該檔案 saveControlCenterSettings 的說明）。
function validatePayload(payload) {
  const values = {};
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return { ok: false, values, errors: [{ key: null, label: null, message: 'payload 格式不正確' }] };
  }
  for (const key of BATCH_WRITABLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    const field = findField(key);
    const result = validateFieldValue(field, payload[key]);
    if (result.ok) {
      values[key] = result.value;
    } else {
      errors.push({ key, label: field.label, message: result.error });
    }
  }
  return { ok: errors.length === 0, values, errors };
}

// 比較兩份設定值（目前值 vs 匯入檔內容），只比對 BATCH_WRITABLE_KEYS 白名單內的欄位——
// 敏感欄位／需要原生確認的欄位不會出現在匯入檔裡（buildSafeExport 就已經排除，見下方），
// 就算匯入檔裡混進這些 key 也會在這裡被忽略，不會被列進差異、更不會被寫入。
// 回傳 [{ key, label, oldValue, newValue }]，只列出真的有變化的欄位。
function diffSettings(current, incoming) {
  const changes = [];
  for (const key of BATCH_WRITABLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
    const field = findField(key);
    const oldValue = Object.prototype.hasOwnProperty.call(current, key) ? current[key] : field.defaultValue;
    const newValue = incoming[key];
    if (oldValue !== newValue) {
      changes.push({ key, label: field.label, oldValue, newValue });
    }
  }
  return changes;
}

// 把目前的設定值收斂成可以安全匯出的物件——只保留 BATCH_WRITABLE_KEYS 白名單內的欄位，
// sensitive（API key）／requiresNativeConfirm（CLI 免確認）一律不出現在匯出檔裡，即使
// 呼叫端不小心把整包 settings.json 傳進來也一樣被過濾掉，不是只靠呼叫端自己小心。
function buildSafeExport(values) {
  const safe = {};
  for (const key of BATCH_WRITABLE_KEYS) {
    const field = findField(key);
    safe[key] = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : field.defaultValue;
  }
  return safe;
}

module.exports = {
  TABS,
  SCHEMA,
  APPLIES_AT_LABEL,
  BATCH_WRITABLE_KEYS,
  findField,
  validateFieldValue,
  validatePayload,
  diffSettings,
  buildSafeExport,
};
