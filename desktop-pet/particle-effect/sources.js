// 3D 模型（光粒子）設定的 ES module 入口。資料本身放在 sources.json——用桌寵系統匣
// 「模型設定...」視窗新增/修改，不用手打程式碼；也可以直接手動編輯 sources.json。
// 每個欄位的意思見 particle-effect/動畫參數說明.md 的「完整欄位對照表」。
//
// 這支檔案只負責把 JSON 轉成 particle-effect.js 原本就在 import 的那幾個 export，
// 讓 renderer 端的程式碼不用跟著改。main.js／asset-check.js（Node 端）直接用 fs 讀
// sources.json，不經過這裡。
//
// sources.json 結構：
//   models:                    { 模型 key: { file, particle, color, idleMotion, note } }
//   sequenceModels:            模型序列播放的順序（空陣列＝全部模型照 models 的順序）
//   sequenceHoldSeconds:       序列每一站定格停留幾秒
//   sequenceTransitionSeconds: 序列切到下一站的轉換秒數
//   sequenceBgm:               序列播放期間的背景音樂檔名（audio/bgm/ 底下），空字串＝不播
import data from './sources.json' with { type: 'json' };

export default data.models || {};
export const sequenceModels = Array.isArray(data.sequenceModels) ? data.sequenceModels : [];
export const sequenceHoldSeconds = data.sequenceHoldSeconds;
export const sequenceTransitionSeconds = data.sequenceTransitionSeconds;
export const sequenceBgm = data.sequenceBgm;
