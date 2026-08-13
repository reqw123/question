'use strict';
// 「即時對話」的持久記憶（ADR-0003：設上限、不做摘要壓縮；本 spec Q12：跟著 c1/c2
// 插槽分開存，不跟著模型身份）。只有 main process 會 require 這個檔案。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_TURNS = 20; // 一輪 = 一則使用者訊息 + 一則 AI 回覆，超過自動丟最舊的（見 spec Q D）

function memoryPath() {
  return path.join(app.getPath('userData'), 'chat-memory.json');
}

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(memoryPath(), 'utf8'));
    return {
      c1: Array.isArray(data.c1) ? data.c1 : [],
      c2: Array.isArray(data.c2) ? data.c2 : [],
    };
  } catch (err) {
    // 檔案不存在或損毀，視同兩個角色的記憶都是空的，不要讓桌寵啟動/聊天功能因此壞掉
    // （跟 0001 spec 對 settings.json 壞掉的處理方式一致）。
    if (err.code !== 'ENOENT') console.warn('[desktop-pet] 讀取 chat-memory.json 失敗，退回空記憶：', err.message);
    return { c1: [], c2: [] };
  }
}

// 回傳指定角色目前的對話歷史（{ role: 'user'|'assistant', content }[]），供 chat.js 的
// history 參數直接使用。
function getHistory(charKey) {
  const all = readAll();
  return all[charKey] || [];
}

// 存一輪對話（使用者訊息 + AI 回覆），超過 MAX_TURNS 輪自動丟最舊的一輪。
function appendTurn(charKey, userMessage, assistantReply) {
  const all = readAll();
  const history = all[charKey] || [];
  history.push({ role: 'user', content: userMessage });
  history.push({ role: 'assistant', content: assistantReply });
  const maxMessages = MAX_TURNS * 2;
  all[charKey] = history.length > maxMessages ? history.slice(history.length - maxMessages) : history;
  try {
    fs.mkdirSync(path.dirname(memoryPath()), { recursive: true });
    fs.writeFileSync(memoryPath(), JSON.stringify(all, null, 2));
  } catch (err) {
    console.error('[desktop-pet] 對話記憶存檔失敗：', err);
  }
}

// 清空指定角色的記憶（角色一/二各自獨立，不會互相影響，見 Q12：記憶跟著插槽走）。
function clearHistory(charKey) {
  const all = readAll();
  all[charKey] = [];
  try {
    fs.mkdirSync(path.dirname(memoryPath()), { recursive: true });
    fs.writeFileSync(memoryPath(), JSON.stringify(all, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { getHistory, appendTurn, clearHistory, MAX_TURNS };
