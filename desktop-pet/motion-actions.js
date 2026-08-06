'use strict';

// 動作測試選單清單：main.js 的 buildMotionSubmenu()／triggerMotion() 讀這份清單建立
// 系統匣選單項目，手動觸發 lib/live2d.js 既有的公開動作方法。
// 之後想加新動作只要在這個陣列多加一筆 { label, call }，main.js 都不用改。
// （對角線交叉飛行是「開始/停止」合一的切換式選項，label 會動態變化，不適合放這種固定
// label 的陣列，另外用 toggleFly() 處理，見 main.js）
module.exports = [
  { label: '角色一隨機動作（playRandom1）', call: 'L2D.playRandom1()' },
  { label: '角色二隨機動作（playRandom2）', call: 'L2D.playRandom2()' },
  // L2D.play(name) 跟上面兩個不一樣：沒有分角色版本（沒有 play1()/play2()），
  // 呼叫一次是「目前所有啟用角色」同時一起播（_activeSlotKeys.forEach 全部下去）。
  // skill 系列目前只有 skill2（skill_02.motion3.json 的別名）真的有內容，納茲/露西
  // 都各自掛了這顆檔案；skill_01/'skill' 目前是刻意留空的保留編號，還沒有對應檔案，
  // 呼叫下去會找不到而安靜退回播放待機動作，所以這裡先不放這個按鈕，避免點了卻誤以為壞掉。
  { label: '雙角色技能動作（skill2）', call: "L2D.play('skill2')" },
];
