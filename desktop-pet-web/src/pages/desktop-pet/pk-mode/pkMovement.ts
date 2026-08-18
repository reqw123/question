// 手勢 PK 對戰模式的移動控制：食指自己的「傾斜角度」連續控制角色前進/後退，跟攻擊/
// 防禦/跳躍那三個「手勢分類」不同，這裡讀的是 MediaPipe 回報的 landmark 座標算出來的
// 角度，不是 gestures 分類——手勢類別（握拳/張手/比 V）不影響移動，只有食指傾斜角度
// 影響，兩者可以同時發生（例如邊移動邊防禦）。純函式，方便單元測試，不碰
// MediaPipe/camera。見 docs/specs/0013。
//
// 2026-08-18（第一次）從「手腕在畫面裡的絕對左右位置」改成「手腕傾斜角度」：舊版要把
// 整隻手臂橫向大幅度擺動到畫面左/右邊界才能控制方向，使用者實測回報「像手指尖端指向，
// 反轉方向非常吃力」。改成角度後，手腕定點不動，只要小幅度左右傾斜（像轉方向盤／
// 搖桿），回正就自然停止，物理負擔小很多。
//
// 2026-08-18（第二次）再從「手腕傾斜角度」改成「食指自己的傾斜角度」：使用者回報
// 「單純手腕傾斜可能會誤判」——量測起點放在手腕（wrist→middleMcp）時，向量同時受
// 整隻手掌的位置/朝向影響，使用者只是自然轉動或移動手掌（不是刻意要控制移動）也會被
// 誤判成傾斜意圖。改成量測食指自己的彎曲/指向角度（indexMcp→indexTip，向量完全落在
// 食指這一節上，不跨到手腕），只有食指本身刻意的指向才會被讀到，手掌整體怎麼擺動都
// 不影響——訊號更貼近使用者真正想控制移動的那個動作。方向慣例維持跟改版前一致（見
// tiltToMoveValue() 的說明），不用重新學。
export type Point2D = { x: number; y: number }

// 死區：食指接近垂直（傾斜角度接近 0）算「不移動」，避免手部辨識雜訊在食指打直時被
// 誤判成小幅度傾斜。單位是弧度，約 8 度——比 ANGLE_MAX_TILT 小很多，食指打直時的
// 自然抖動通常在這個範圍內。
export const ANGLE_DEAD_ZONE = 0.14

// 滿刻度傾斜角度：超過這個角度就視為最大前進/後退強度（±1），不用真的把食指折到
// 生理極限才能全速移動。約 40 度，食指自然側傾就能到。
export const ANGLE_MAX_TILT = 0.7

// 平滑係數：0～1，越小平滑越強（越不受單幀雜訊影響，但反應也越慢）。跟舊版「手放回
// 中間有時鬆不開」同一個理由——單靠死區沒辦法完全解決逐幀雜訊，EMA 平滑掉高頻抖動，
// 讓「食指回正」這件事能穩定被判定成真的回正。
export const SMOOTHING_ALPHA = 0.35

// EMA 平滑：previousSmoothed 是上一次平滑後的值，null 代表「還沒有歷史值」（例如手
// 剛出現在畫面裡），這時候直接採用這一幀的原始值，不用平滑。手離開畫面時呼叫端應該
// 把 previousSmoothed 重置回 null（見 PkArenaView.tsx／PkControllerView.tsx 的呼叫
// 處），不要讓手重新出現時還帶著舊角度的平滑殘留。跟舊版 smoothHandX() 是同一個通用
// EMA 公式，只是輸入從「x 座標」換成「角度」，改個通用名字。
export function smoothValue(previousSmoothed: number | null, raw: number, alpha: number = SMOOTHING_ALPHA): number {
  if (previousSmoothed === null) return raw
  return previousSmoothed + (raw - previousSmoothed) * alpha
}

// fingerBase→fingerTip（食指：landmarks[5]→landmarks[8]，食指根部到指尖）向量跟
// 「垂直向上」的夾角，單位弧度。正值＝食指往（原始鏡頭畫面，未鏡像）右邊傾斜，負值＝
// 往左傾斜。MediaPipe landmark 座標系 y 往下，食指伸直朝上時 fingerTip 通常在
// fingerBase 上方（dy 為負），所以用 -dy 當「向上」分量。向量完全落在食指這一節上，
// 不經過手腕——手掌整體移動/轉動不會改變這個角度，只有食指自己彎/指向的角度改變才會，
// 見檔頭「2026-08-18（第二次）」說明。
export function handTiltAngle(fingerBase: Point2D, fingerTip: Point2D): number {
  const dx = fingerTip.x - fingerBase.x
  const dy = fingerTip.y - fingerBase.y
  return Math.atan2(dx, -dy)
}

// 跟舊版 mirrorX() 同一個道理：畫面用 CSS scaleX(-1) 鏡像顯示（像照鏡子），角度也要
// 對應翻轉方向，使用者往自己視角的方向傾斜食指，才會對應到螢幕上看到的同一個方向。
export function mirrorAngle(angle: number): number {
  return -angle
}

// angle 是已經鏡像修正過的傾斜角度。回傳值語意：正值＝前進意圖強度（靠近對手），
// 負值＝後退意圖強度（遠離對手），0＝死區內或沒偵測到手——「手指往右傾＝前進」的方向
// 慣例（2026-08-18 修正過一次：原本是「左傾＝前進」，玩家一玩家二實測回報方向都反了，
// 見下方 tilt 的說明；量測起點從手腕改成食指自己時，這個方向慣例維持不變，不用重新
// 學）。死區外到 ANGLE_MAX_TILT 之間線性映射到 ±1。
export function tiltToMoveValue(angle: number): number {
  const tilt = angle // 右傾（正值）對應「前進」
  if (Math.abs(tilt) < ANGLE_DEAD_ZONE) return 0
  const usableRange = ANGLE_MAX_TILT - ANGLE_DEAD_ZONE
  const beyondDeadZone = tilt > 0 ? tilt - ANGLE_DEAD_ZONE : tilt + ANGLE_DEAD_ZONE
  const value = beyondDeadZone / usableRange
  return Math.max(-1, Math.min(1, value))
}
