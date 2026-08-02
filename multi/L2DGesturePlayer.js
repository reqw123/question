
'use strict';

/**
 * L2DGesturePlayer — 自訂 Live2D 動作組合模組（高強度修復版）
 *
 * 透過直接操控 coreModel 參數，設計內建 motion 之外的客製動作。
 * 每個動作（gesture）是一組參數 keyframe，相鄰 frame 之間線性插值。
 *
 * 公開 API:
 * L2DGesturePlayer.play(name?, charKey?)
 *   name    省略 → 從所有已定義動作裡隨機挑一個
 *   charKey 省略 → 所有角色（c1+c2）都播放；帶 'c1' 或 'c2' → 只播放指定角色
 * L2DGesturePlayer.playAll(charKey?, gapMs?)  ← 依序播放所有已定義動作（各播完整段時長 + gapMs 緩衝才接下一個，gapMs 預設 300）
 * L2DGesturePlayer.stop(charKey?)      ← 停止（省略 = 兩角色都停）
 * L2DGesturePlayer.define(name, def)   ← 執行期間新增/覆蓋動作定義
 * L2DGesturePlayer.list()              ← 回傳所有已定義的動作名稱
 *
 * Gesture 定義格式：
 * {
 * blend:  0.0~1.0,                   // 每 update 的 blend 強度（越大越快到位）
 * frames: [                          // 關鍵幀（t 單位 ms，需遞增）
 * { t: 0,   params: { PARAM_ID: value, ... } },
 * { t: 400, params: { PARAM_ID: value, ... } },
 * ...
 * ],
 * }
 * 播放時要套用到哪個角色由呼叫端透過 play(name, charKey) 決定，動作定義本身不再帶 char 欄位。
 */
const L2DGesturePlayer = (() => {

  // 參數範圍（模型實測）：
  // PARAM_BODY_ANGLE_X/Y/Z  : -10 ~ 10
  // PARAM_STRETCH            :  -1 ~ 1
  // PARAM_SHOLDER_POSITION   : -10 ~ 10
  // PARAM_ARM_L/R_ROTATE     : -10 ~ 60   ← 正值才是有效範圍
  // PARAM_SHOULDER_L/R_ROTATE: -35 ~ 20
  // PARAM_HAND_L/R_ROTATE    : -30 ~ 30
  // PARAM_ANGLE_X/Y/Z        : -30 ~ 30
  // 產生「單一參數快速開合交錯」的 keyframe 陣列，避免長時間動作要手動打幾十顆 frame。
  // durationMs 內每 stepMs 切一次 openVal/closeVal，t=0 跟收尾都固定停在 closeVal。
  function _toggleFrames(paramId, durationMs, stepMs, openVal, closeVal) {
    const frames = [{ t: 0, params: { [paramId]: closeVal } }];
    let open = true;
    for (let t = stepMs; t < durationMs; t += stepMs) {
      frames.push({ t, params: { [paramId]: open ? openVal : closeVal } });
      open = !open;
    }
    frames.push({ t: durationMs, params: { [paramId]: closeVal } });
    return frames;
  }

  // ── 動作資料庫（全面優化動態與張力強度） ───────────────────────────────────────────
  const GESTURES = {

    // 蓄力壓低：極速下壓 → 死寂般的蓄力等待 → 瞬間猛烈彈回
    'crouch': {
      blend: 0.5,
      frames: [
        { t: 0,    params: { PARAM_STRETCH: 0,    PARAM_BODY_ANGLE_Y: 0,   PARAM_SHOLDER_POSITION: 0,   PARAM_ANGLE_Y: 0 } },
        { t: 150,  params: { PARAM_STRETCH: -1.0, PARAM_BODY_ANGLE_Y: -10, PARAM_SHOLDER_POSITION: -10, PARAM_ANGLE_Y: -30 } }, // 快狠準下壓
        { t: 1800, params: { PARAM_STRETCH: -1.0, PARAM_BODY_ANGLE_Y: -10, PARAM_SHOLDER_POSITION: -10, PARAM_ANGLE_Y: -30 } }, // 蓄力維持
        { t: 2000, params: { PARAM_STRETCH: 0.5,  PARAM_BODY_ANGLE_Y: 5,   PARAM_SHOLDER_POSITION: 5,   PARAM_ANGLE_Y: 10 } },  // 反彈超載
        { t: 2300, params: { PARAM_STRETCH: 0,    PARAM_BODY_ANGLE_Y: 0,   PARAM_SHOLDER_POSITION: 0,   PARAM_ANGLE_Y: 0 } },   // 回歸偏置
      ],
    },

    // 指向手勢：身體大幅轉向並前傾，手臂與肩膀直接拉到物理極限，產生定格張力
    'pointing': {
      blend: 0.45,
      frames: [
        { t: 0,    params: { PARAM_ARM_R_ROTATE: 0,  PARAM_SHOULDER_R_ROTATE: 0,   PARAM_BODY_ANGLE_X: 0,   PARAM_BODY_ANGLE_Y: 0,   PARAM_ANGLE_X: 0,   PARAM_ANGLE_Y: 0,   PARAM_ARM_L_ROTATE: 0,  PARAM_SHOULDER_L_ROTATE: 0,   PARAM_HAND_L_ROTATE: 0  } },
        { t: 350,  params: { PARAM_ARM_R_ROTATE: 10, PARAM_SHOULDER_R_ROTATE: -15, PARAM_BODY_ANGLE_X: -10, PARAM_BODY_ANGLE_Y: -5,  PARAM_ANGLE_X: -20, PARAM_ANGLE_Y: 10,  PARAM_ARM_L_ROTATE: 60, PARAM_SHOULDER_L_ROTATE: -35, PARAM_HAND_L_ROTATE: 30 } }, // 擺出霸氣指向
        { t: 2500, params: { PARAM_ARM_R_ROTATE: 10, PARAM_SHOULDER_R_ROTATE: -15, PARAM_BODY_ANGLE_X: -10, PARAM_BODY_ANGLE_Y: -5,  PARAM_ANGLE_X: -20, PARAM_ANGLE_Y: 10,  PARAM_ARM_L_ROTATE: 60, PARAM_SHOULDER_L_ROTATE: -35, PARAM_HAND_L_ROTATE: 30 } }, // 定格
        { t: 2900, params: { PARAM_ARM_R_ROTATE: 0,  PARAM_SHOULDER_R_ROTATE: 0,   PARAM_BODY_ANGLE_X: 0,   PARAM_BODY_ANGLE_Y: 0,   PARAM_ANGLE_X: 0,   PARAM_ANGLE_Y: 0,   PARAM_ARM_L_ROTATE: 0,  PARAM_SHOULDER_L_ROTATE: 0,   PARAM_HAND_L_ROTATE: 0  } },
      ],
    },

    // 勝利：極高頻率的上下彈跳與左右擺動，疊加頭部 Z 軸晃動
    'victory': {
      blend: 0.6,
      frames: [
        { t: 0,   params: { PARAM_BODY_ANGLE_Y: 0,   PARAM_STRETCH: 0,    PARAM_BODY_ANGLE_X: 0,   PARAM_ANGLE_Z: 0 } },
        { t: 100, params: { PARAM_BODY_ANGLE_Y: -10, PARAM_STRETCH: -1.0, PARAM_BODY_ANGLE_X: -10, PARAM_ANGLE_Z: -15 } }, // 往下蹲蓄力
        { t: 250, params: { PARAM_BODY_ANGLE_Y: 10,  PARAM_STRETCH: 1.0,  PARAM_BODY_ANGLE_X: 10,  PARAM_ANGLE_Z: 20 } },  // 猛烈往上彈+右歪頭
        { t: 400, params: { PARAM_BODY_ANGLE_Y: -8,  PARAM_STRETCH: -0.7, PARAM_BODY_ANGLE_X: -8,  PARAM_ANGLE_Z: -15 } }, // 二次彈跳+左歪頭
        { t: 550, params: { PARAM_BODY_ANGLE_Y: 8,   PARAM_STRETCH: 0.7,  PARAM_BODY_ANGLE_X: 6,   PARAM_ANGLE_Z: 10 } },
        { t: 700, params: { PARAM_BODY_ANGLE_Y: -4,  PARAM_STRETCH: -0.3, PARAM_BODY_ANGLE_X: -4,  PARAM_ANGLE_Z: -5 } },
        { t: 950, params: { PARAM_BODY_ANGLE_Y: 0,   PARAM_STRETCH: 0,    PARAM_BODY_ANGLE_X: 0,   PARAM_ANGLE_Z: 0 } },
      ],
    },

    // 驚嚇：100ms 內瞬間抽搐硬直！頭部、身體、肩膀全塞滿最大極限值
    'surprise': {
      blend: 0.8, // 高 Blend 讓動作幾乎瞬間到位
      frames: [
        { t: 0,    params: { PARAM_BODY_ANGLE_Y: 0,   PARAM_SHOLDER_POSITION: 0,   PARAM_BODY_ANGLE_Z: 0,   PARAM_BODY_ANGLE_X: 0,   PARAM_ANGLE_X: 0,   PARAM_ANGLE_Y: 0 } },
        { t: 80,   params: { PARAM_BODY_ANGLE_Y: 10,  PARAM_SHOLDER_POSITION: 10,  PARAM_BODY_ANGLE_Z: -10, PARAM_BODY_ANGLE_X: 10,  PARAM_ANGLE_X: -30, PARAM_ANGLE_Y: 30 } }, // 瞬間往後抽搐定格
        { t: 900,  params: { PARAM_BODY_ANGLE_Y: 10,  PARAM_SHOLDER_POSITION: 10,  PARAM_BODY_ANGLE_Z: -10, PARAM_BODY_ANGLE_X: 10,  PARAM_ANGLE_X: -30, PARAM_ANGLE_Y: 30 } }, // 嚇傻僵直
        { t: 1500, params: { PARAM_BODY_ANGLE_Y: 0,   PARAM_SHOLDER_POSITION: 0,   PARAM_BODY_ANGLE_Z: 0,   PARAM_BODY_ANGLE_X: 0,   PARAM_ANGLE_X: 0,   PARAM_ANGLE_Y: 0 } },
      ],
    },

    // 洩氣：如同漏氣氣球，極致的癱軟，連同頭部（ANGLE_Y）一起絕望低垂
    'slump': {
      blend: 0.15, // 低 Blend 營造無力沉重感
      frames: [
        { t: 0,    params: { PARAM_BODY_ANGLE_Y: 0,   PARAM_STRETCH: 0,    PARAM_SHOLDER_POSITION: 0,   PARAM_BODY_ANGLE_X: 0,   PARAM_ANGLE_Y: 0 } },
        { t: 800,  params: { PARAM_BODY_ANGLE_Y: -10, PARAM_STRETCH: -1.0, PARAM_SHOLDER_POSITION: -10, PARAM_BODY_ANGLE_X: 5,   PARAM_ANGLE_Y: -30 } }, // 絕望無力下塌
        { t: 2600, params: { PARAM_BODY_ANGLE_Y: -10, PARAM_STRETCH: -1.0, PARAM_SHOLDER_POSITION: -10, PARAM_BODY_ANGLE_X: 5,   PARAM_ANGLE_Y: -30 } }, // 沮喪定格
        { t: 3400, params: { PARAM_BODY_ANGLE_Y: 0,   PARAM_STRETCH: 0,    PARAM_SHOLDER_POSITION: 0,   PARAM_BODY_ANGLE_X: 0,   PARAM_ANGLE_Y: 0 } },
      ],
    },

    // 抖動：極高頻的高速交錯震盪（每 40ms 變換一次正負極值）
    'tremble': {
      blend: 0.75,
      frames: [
        { t: 0,   params: { PARAM_BODY_ANGLE_X: 0,   PARAM_BODY_ANGLE_Z: 0,   PARAM_SHOLDER_POSITION: 0,   PARAM_ANGLE_X: 0 } },
        { t: 40,  params: { PARAM_BODY_ANGLE_X: 10,  PARAM_BODY_ANGLE_Z: 8,   PARAM_SHOLDER_POSITION: 10,  PARAM_ANGLE_X: 8 } },
        { t: 80,  params: { PARAM_BODY_ANGLE_X: -10, PARAM_BODY_ANGLE_Z: -8,  PARAM_SHOLDER_POSITION: -10, PARAM_ANGLE_X: -8 } },
        { t: 120, params: { PARAM_BODY_ANGLE_X: 8,   PARAM_BODY_ANGLE_Z: 6,   PARAM_SHOLDER_POSITION: 8,   PARAM_ANGLE_X: 6 } },
        { t: 160, params: { PARAM_BODY_ANGLE_X: -8,  PARAM_BODY_ANGLE_Z: -6,  PARAM_SHOLDER_POSITION: -8,  PARAM_ANGLE_X: -6 } },
        { t: 200, params: { PARAM_BODY_ANGLE_X: 6,   PARAM_BODY_ANGLE_Z: 4,   PARAM_SHOLDER_POSITION: 6,   PARAM_ANGLE_X: 4 } },
        { t: 240, params: { PARAM_BODY_ANGLE_X: -6,  PARAM_BODY_ANGLE_Z: -4,  PARAM_SHOLDER_POSITION: -6,  PARAM_ANGLE_X: -4 } },
        { t: 280, params: { PARAM_BODY_ANGLE_X: 4,   PARAM_BODY_ANGLE_Z: 2,   PARAM_SHOLDER_POSITION: 4,   PARAM_ANGLE_X: 2 } },
        { t: 320, params: { PARAM_BODY_ANGLE_X: -4,  PARAM_BODY_ANGLE_Z: -2,  PARAM_SHOLDER_POSITION: -4,  PARAM_ANGLE_X: -2 } },
        { t: 360, params: { PARAM_BODY_ANGLE_X: 0,   PARAM_BODY_ANGLE_Z: 0,   PARAM_SHOLDER_POSITION: 0,   PARAM_ANGLE_X: 0 } },
      ],
    },

    // 失控崩壞：每幀極端亂數抽搐 90 幀（≈1440ms）→ 還原回起始值
    'random_1': {
      type: 'fn',
      duration: 15000,   // 給還原多一點緩衝
      interval: 1000,     // ← 調這裡：16 = 逼近螢幕刷新率；0 = 每幀（更密）
      fn(elapsed, cm, ids, mins, maxs, ctx, duration) {
        // 第一幀捕捉原始值（ctx 每次播放都是乾淨的 {}）
        if (!ctx.originals) {
          ctx.originals = ids.map(id => { try { return cm.getParameterValueById(id); } catch { return 0; } });
        }

        if (elapsed < duration - 60) {
          // 失控崩壞：極限亂數抽搐
          ids.forEach((id, i) => {
            if (id.includes('ANGLE') || id.includes('ROT') || id.includes('STRETCH') || id.includes('SHOLDER')) {
              const bias   = Math.random() > 0.5 ? maxs[i] : mins[i];
              const jitter = (Math.random() - 0.5) * (maxs[i] - mins[i]) * 0.3;
              cm.setParameterValueById(id, Math.max(mins[i], Math.min(maxs[i], bias + jitter)));
            } else {
              cm.setParameterValueById(id, mins[i] + Math.random() * (maxs[i] - mins[i]));
            }
          });
        } else {
          // 還原回起始捕捉的值
          ctx.originals.forEach((v, i) => { try { cm.setParameterValueById(ids[i], v); } catch {} });
        }
      },
    },

    'random_2': {
      blend: 0.4,
      frames: [
        { t: 0,    params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
        { t: 600,  params: { PARAM_ANGLE_X: -4.213, PARAM_ANGLE_Y: 14.205, PARAM_ANGLE_Z: 8.519, PARAM_SHOULDER_R_ROTATE: 10.751, PARAM_ARM_R_ROTATE: 35.68, PARAM_HAND_R_ROTATE: 18.428, PARAM_SHOULDER_L_ROTATE: -18.92, PARAM_ARM_L_ROTATE: 28.913, PARAM_HAND_L_ROTATE: 6.797, PARAM_BODY_ANGLE_X: 8.887, PARAM_BODY_ANGLE_Y: -5.494, PARAM_BODY_ANGLE_Z: 5.193, PARAM_STRETCH: 0.671, PARAM_SHOLDER_POSITION: -7.258, PARAM_POSITION_X: -0.273, PARAM_POSITION_Y: -0.545, PARAM_ROTATION_Z: -0.35 } },
        { t: 2000, params: { PARAM_ANGLE_X: -4.213, PARAM_ANGLE_Y: 14.205, PARAM_ANGLE_Z: 8.519, PARAM_SHOULDER_R_ROTATE: 10.751, PARAM_ARM_R_ROTATE: 35.68, PARAM_HAND_R_ROTATE: 18.428, PARAM_SHOULDER_L_ROTATE: -18.92, PARAM_ARM_L_ROTATE: 28.913, PARAM_HAND_L_ROTATE: 6.797, PARAM_BODY_ANGLE_X: 8.887, PARAM_BODY_ANGLE_Y: -5.494, PARAM_BODY_ANGLE_Z: 5.193, PARAM_STRETCH: 0.671, PARAM_SHOLDER_POSITION: -7.258, PARAM_POSITION_X: -0.273, PARAM_POSITION_Y: -0.545, PARAM_ROTATION_Z: -0.35 } },
        { t: 2500, params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
      ],
    },

    'random_3': {
      blend: 0.4,
      frames: [
        { t: 0,    params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
        { t: 600,  params: { PARAM_ANGLE_X: 4.381, PARAM_ANGLE_Y: -19.157, PARAM_ANGLE_Z: -26.113, PARAM_SHOULDER_R_ROTATE: 11.43, PARAM_ARM_R_ROTATE: 40.666, PARAM_HAND_R_ROTATE: 4.161, PARAM_SHOULDER_L_ROTATE: -21.931, PARAM_ARM_L_ROTATE: -3.633, PARAM_HAND_L_ROTATE: -12.694, PARAM_BODY_ANGLE_X: -0.813, PARAM_BODY_ANGLE_Y: -1.807, PARAM_BODY_ANGLE_Z: -1.536, PARAM_STRETCH: -0.299, PARAM_SHOLDER_POSITION: 4.226, PARAM_POSITION_X: -0.424, PARAM_POSITION_Y: 0.97, PARAM_ROTATION_Z: -0.396 } },
        { t: 2000, params: { PARAM_ANGLE_X: 4.381, PARAM_ANGLE_Y: -19.157, PARAM_ANGLE_Z: -26.113, PARAM_SHOULDER_R_ROTATE: 11.43, PARAM_ARM_R_ROTATE: 40.666, PARAM_HAND_R_ROTATE: 4.161, PARAM_SHOULDER_L_ROTATE: -21.931, PARAM_ARM_L_ROTATE: -3.633, PARAM_HAND_L_ROTATE: -12.694, PARAM_BODY_ANGLE_X: -0.813, PARAM_BODY_ANGLE_Y: -1.807, PARAM_BODY_ANGLE_Z: -1.536, PARAM_STRETCH: -0.299, PARAM_SHOLDER_POSITION: 4.226, PARAM_POSITION_X: -0.424, PARAM_POSITION_Y: 0.97, PARAM_ROTATION_Z: -0.396 } },
        { t: 2500, params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
      ],
    },

    'random_4': {
      blend: 0.4,
      frames: [
        { t: 0,    params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
        { t: 600,  params: { PARAM_ANGLE_X: -11.177, PARAM_ANGLE_Y: 27.97, PARAM_ANGLE_Z: 20.1, PARAM_SHOULDER_R_ROTATE: 8.495, PARAM_ARM_R_ROTATE: 56.279, PARAM_HAND_R_ROTATE: 24.103, PARAM_SHOULDER_L_ROTATE: 19.165, PARAM_ARM_L_ROTATE: 33.286, PARAM_HAND_L_ROTATE: -22.893, PARAM_BODY_ANGLE_X: 2.013, PARAM_BODY_ANGLE_Y: -0.793, PARAM_BODY_ANGLE_Z: -7.104, PARAM_STRETCH: -0.428, PARAM_SHOLDER_POSITION: -4.264, PARAM_POSITION_X: -0.442, PARAM_POSITION_Y: 0.849, PARAM_ROTATION_Z: 0.319 } },
        { t: 2000, params: { PARAM_ANGLE_X: -11.177, PARAM_ANGLE_Y: 27.97, PARAM_ANGLE_Z: 20.1, PARAM_SHOULDER_R_ROTATE: 8.495, PARAM_ARM_R_ROTATE: 56.279, PARAM_HAND_R_ROTATE: 24.103, PARAM_SHOULDER_L_ROTATE: 19.165, PARAM_ARM_L_ROTATE: 33.286, PARAM_HAND_L_ROTATE: -22.893, PARAM_BODY_ANGLE_X: 2.013, PARAM_BODY_ANGLE_Y: -0.793, PARAM_BODY_ANGLE_Z: -7.104, PARAM_STRETCH: -0.428, PARAM_SHOLDER_POSITION: -4.264, PARAM_POSITION_X: -0.442, PARAM_POSITION_Y: 0.849, PARAM_ROTATION_Z: 0.319 } },
        { t: 2500, params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
      ],
    },

    'random_5': {
      blend: 0.4,
      frames: [
        { t: 0,    params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
        { t: 600,  params: { PARAM_ANGLE_X: 13.633, PARAM_ANGLE_Y: -26.581, PARAM_ANGLE_Z: -4.656, PARAM_SHOULDER_R_ROTATE: -21.305, PARAM_ARM_R_ROTATE: 12.564, PARAM_HAND_R_ROTATE: 6.222, PARAM_SHOULDER_L_ROTATE: -28.029, PARAM_ARM_L_ROTATE: 25.301, PARAM_HAND_L_ROTATE: 13.506, PARAM_BODY_ANGLE_X: 3.808, PARAM_BODY_ANGLE_Y: 8.657, PARAM_BODY_ANGLE_Z: -9.771, PARAM_STRETCH: -0.488, PARAM_SHOLDER_POSITION: 0.082, PARAM_POSITION_X: 0.138, PARAM_POSITION_Y: -0.648, PARAM_ROTATION_Z: -0.469 } },
        { t: 2000, params: { PARAM_ANGLE_X: 13.633, PARAM_ANGLE_Y: -26.581, PARAM_ANGLE_Z: -4.656, PARAM_SHOULDER_R_ROTATE: -21.305, PARAM_ARM_R_ROTATE: 12.564, PARAM_HAND_R_ROTATE: 6.222, PARAM_SHOULDER_L_ROTATE: -28.029, PARAM_ARM_L_ROTATE: 25.301, PARAM_HAND_L_ROTATE: 13.506, PARAM_BODY_ANGLE_X: 3.808, PARAM_BODY_ANGLE_Y: 8.657, PARAM_BODY_ANGLE_Z: -9.771, PARAM_STRETCH: -0.488, PARAM_SHOLDER_POSITION: 0.082, PARAM_POSITION_X: 0.138, PARAM_POSITION_Y: -0.648, PARAM_ROTATION_Z: -0.469 } },
        { t: 2500, params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
      ],
    },

    'random_6': {
      blend: 0.4,
      frames: [
        { t: 0,    params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
        { t: 600,  params: { PARAM_ANGLE_X: -0.157, PARAM_ANGLE_Y: 0.998, PARAM_ANGLE_Z: -25.069, PARAM_SHOULDER_R_ROTATE: -20.561, PARAM_ARM_R_ROTATE: 5.689, PARAM_HAND_R_ROTATE: -11.164, PARAM_SHOULDER_L_ROTATE: -3.972, PARAM_ARM_L_ROTATE: 40.625, PARAM_HAND_L_ROTATE: 18.229, PARAM_BODY_ANGLE_X: -4.855, PARAM_BODY_ANGLE_Y: 8.552, PARAM_BODY_ANGLE_Z: -0.909, PARAM_STRETCH: 0.964, PARAM_SHOLDER_POSITION: 0.649, PARAM_POSITION_X: 0.264, PARAM_POSITION_Y: 0.585, PARAM_ROTATION_Z: -0.705 } },
        { t: 2000, params: { PARAM_ANGLE_X: -0.157, PARAM_ANGLE_Y: 0.998, PARAM_ANGLE_Z: -25.069, PARAM_SHOULDER_R_ROTATE: -20.561, PARAM_ARM_R_ROTATE: 5.689, PARAM_HAND_R_ROTATE: -11.164, PARAM_SHOULDER_L_ROTATE: -3.972, PARAM_ARM_L_ROTATE: 40.625, PARAM_HAND_L_ROTATE: 18.229, PARAM_BODY_ANGLE_X: -4.855, PARAM_BODY_ANGLE_Y: 8.552, PARAM_BODY_ANGLE_Z: -0.909, PARAM_STRETCH: 0.964, PARAM_SHOLDER_POSITION: 0.649, PARAM_POSITION_X: 0.264, PARAM_POSITION_Y: 0.585, PARAM_ROTATION_Z: -0.705 } },
        { t: 2500, params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
      ],
    },

    'random_7': {
      blend: 0.4,
      frames: [
        { t: 0,    params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
        { t: 600,  params: { PARAM_ANGLE_X: 5.24, PARAM_ANGLE_Y: -2.231, PARAM_ANGLE_Z: -4.276, PARAM_SHOULDER_R_ROTATE: -17.902, PARAM_ARM_R_ROTATE: 20.915, PARAM_HAND_R_ROTATE: 10.542, PARAM_SHOULDER_L_ROTATE: -25.748, PARAM_ARM_L_ROTATE: 24.062, PARAM_HAND_L_ROTATE: 9.733, PARAM_BODY_ANGLE_X: 2.725, PARAM_BODY_ANGLE_Y: 9.3, PARAM_BODY_ANGLE_Z: 4.768, PARAM_STRETCH: 0.843, PARAM_SHOLDER_POSITION: -7.605, PARAM_POSITION_X: 0.298, PARAM_POSITION_Y: -0.22, PARAM_ROTATION_Z: -0.81 } },
        { t: 2000, params: { PARAM_ANGLE_X: 5.24, PARAM_ANGLE_Y: -2.231, PARAM_ANGLE_Z: -4.276, PARAM_SHOULDER_R_ROTATE: -17.902, PARAM_ARM_R_ROTATE: 20.915, PARAM_HAND_R_ROTATE: 10.542, PARAM_SHOULDER_L_ROTATE: -25.748, PARAM_ARM_L_ROTATE: 24.062, PARAM_HAND_L_ROTATE: 9.733, PARAM_BODY_ANGLE_X: 2.725, PARAM_BODY_ANGLE_Y: 9.3, PARAM_BODY_ANGLE_Z: 4.768, PARAM_STRETCH: 0.843, PARAM_SHOLDER_POSITION: -7.605, PARAM_POSITION_X: 0.298, PARAM_POSITION_Y: -0.22, PARAM_ROTATION_Z: -0.81 } },
        { t: 2500, params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
      ],
    },

    'random_8': {
      blend: 0.4,
      frames: [
        { t: 0,    params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
        { t: 600,  params: { PARAM_ANGLE_X: 27.271, PARAM_ANGLE_Y: 15.515, PARAM_ANGLE_Z: 4.659, PARAM_SHOULDER_R_ROTATE: 10.7, PARAM_ARM_R_ROTATE: 52.451, PARAM_HAND_R_ROTATE: -14.91, PARAM_SHOULDER_L_ROTATE: 6.238, PARAM_ARM_L_ROTATE: 9.998, PARAM_HAND_L_ROTATE: 6.644, PARAM_BODY_ANGLE_X: -0.699, PARAM_BODY_ANGLE_Y: 3.007, PARAM_BODY_ANGLE_Z: -7.548, PARAM_STRETCH: -0.092, PARAM_SHOLDER_POSITION: 2.283, PARAM_POSITION_X: 0.363, PARAM_POSITION_Y: -0.777, PARAM_ROTATION_Z: 0.42 } },
        { t: 2000, params: { PARAM_ANGLE_X: 27.271, PARAM_ANGLE_Y: 15.515, PARAM_ANGLE_Z: 4.659, PARAM_SHOULDER_R_ROTATE: 10.7, PARAM_ARM_R_ROTATE: 52.451, PARAM_HAND_R_ROTATE: -14.91, PARAM_SHOULDER_L_ROTATE: 6.238, PARAM_ARM_L_ROTATE: 9.998, PARAM_HAND_L_ROTATE: 6.644, PARAM_BODY_ANGLE_X: -0.699, PARAM_BODY_ANGLE_Y: 3.007, PARAM_BODY_ANGLE_Z: -7.548, PARAM_STRETCH: -0.092, PARAM_SHOLDER_POSITION: 2.283, PARAM_POSITION_X: 0.363, PARAM_POSITION_Y: -0.777, PARAM_ROTATION_Z: 0.42 } },
        { t: 2500, params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
      ],
    },

    'random_9': {
      blend: 0.4,
      frames: [
        { t: 0,    params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
        { t: 600,  params: { PARAM_ANGLE_X: 23.972, PARAM_ANGLE_Y: -19.725, PARAM_ANGLE_Z: -16.146, PARAM_SHOULDER_R_ROTATE: -15.418, PARAM_ARM_R_ROTATE: 54.192, PARAM_HAND_R_ROTATE: 17.836, PARAM_SHOULDER_L_ROTATE: 10.239, PARAM_ARM_L_ROTATE: 55.186, PARAM_HAND_L_ROTATE: -1.378, PARAM_BODY_ANGLE_X: 5.132, PARAM_BODY_ANGLE_Y: 7.098, PARAM_BODY_ANGLE_Z: 4.631, PARAM_STRETCH: 0.032, PARAM_SHOLDER_POSITION: -7.083, PARAM_POSITION_X: 0.959, PARAM_POSITION_Y: -0.392, PARAM_ROTATION_Z: -0.882 } },
        { t: 2000, params: { PARAM_ANGLE_X: 23.972, PARAM_ANGLE_Y: -19.725, PARAM_ANGLE_Z: -16.146, PARAM_SHOULDER_R_ROTATE: -15.418, PARAM_ARM_R_ROTATE: 54.192, PARAM_HAND_R_ROTATE: 17.836, PARAM_SHOULDER_L_ROTATE: 10.239, PARAM_ARM_L_ROTATE: 55.186, PARAM_HAND_L_ROTATE: -1.378, PARAM_BODY_ANGLE_X: 5.132, PARAM_BODY_ANGLE_Y: 7.098, PARAM_BODY_ANGLE_Z: 4.631, PARAM_STRETCH: 0.032, PARAM_SHOLDER_POSITION: -7.083, PARAM_POSITION_X: 0.959, PARAM_POSITION_Y: -0.392, PARAM_ROTATION_Z: -0.882 } },
        { t: 2500, params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
      ],
    },

    'random_10': {
      blend: 0.4,
      frames: [
        { t: 0,    params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
        { t: 600,  params: { PARAM_ANGLE_X: 25.943, PARAM_ANGLE_Y: 13.688, PARAM_ANGLE_Z: 14.921, PARAM_SHOULDER_R_ROTATE: -16.471, PARAM_ARM_R_ROTATE: 55.528, PARAM_HAND_R_ROTATE: -20.467, PARAM_SHOULDER_L_ROTATE: 13.691, PARAM_ARM_L_ROTATE: -7.953, PARAM_HAND_L_ROTATE: -24.916, PARAM_BODY_ANGLE_X: 6.112, PARAM_BODY_ANGLE_Y: 9.016, PARAM_BODY_ANGLE_Z: -5.764, PARAM_STRETCH: -0.271, PARAM_SHOLDER_POSITION: -2.527, PARAM_POSITION_X: -0.132, PARAM_POSITION_Y: 0.483, PARAM_ROTATION_Z: 0.719 } },
        { t: 2000, params: { PARAM_ANGLE_X: 25.943, PARAM_ANGLE_Y: 13.688, PARAM_ANGLE_Z: 14.921, PARAM_SHOULDER_R_ROTATE: -16.471, PARAM_ARM_R_ROTATE: 55.528, PARAM_HAND_R_ROTATE: -20.467, PARAM_SHOULDER_L_ROTATE: 13.691, PARAM_ARM_L_ROTATE: -7.953, PARAM_HAND_L_ROTATE: -24.916, PARAM_BODY_ANGLE_X: 6.112, PARAM_BODY_ANGLE_Y: 9.016, PARAM_BODY_ANGLE_Z: -5.764, PARAM_STRETCH: -0.271, PARAM_SHOLDER_POSITION: -2.527, PARAM_POSITION_X: -0.132, PARAM_POSITION_Y: 0.483, PARAM_ROTATION_Z: 0.719 } },
        { t: 2500, params: { PARAM_ANGLE_X: 0, PARAM_ANGLE_Y: 0, PARAM_ANGLE_Z: 0, PARAM_BODY_ANGLE_X: 0, PARAM_BODY_ANGLE_Y: 0, PARAM_BODY_ANGLE_Z: 0, PARAM_STRETCH: 0, PARAM_SHOLDER_POSITION: 0, PARAM_SHOULDER_R_ROTATE: 0, PARAM_ARM_R_ROTATE: 0, PARAM_HAND_R_ROTATE: 0, PARAM_SHOULDER_L_ROTATE: 0, PARAM_ARM_L_ROTATE: 0, PARAM_HAND_L_ROTATE: 0, PARAM_POSITION_X: 0, PARAM_POSITION_Y: 0, PARAM_ROTATION_Z: 0 } },
      ],
    },

    // 納茲專用：嘴巴快速開合模擬碎嘴子／碎碎念。
    // ⚠️ ParamMouthOpenY 在納茲身上是自訂的 -30(閉)~30(開/露牙) 範圍，不是標準 Cubism 的 0~1，
    // 露西（077）同名參數是標準 0~1，兩邊量尺不同，這組數值只適用納茲，不能直接套到露西身上。
    'chatter': {
      blend: 0.85, // 高 blend 讓嘴巴幾乎瞬間到位，才有碎念的顆粒感，不會糊成一片開合不明顯
      frames: _toggleFrames('ParamMouthOpenY', 10000, 90, 1, 0), // 10 秒，每 90ms 切一次開(1)/閉(0)；實測 F12 getParameterMinimumValue/MaximumValue 確認範圍是標準 0~1，不是舊文件寫的 -30~30
    },
  };

  // ── 執行期狀態 ─────────────────────────────────────────────────────────────
  const _hooks = { c1: null, c2: null };

  function _cm(charKey) {
    try { return L2D?.['_' + charKey]?.model?.internalModel?.coreModel ?? null; }
    catch { return null; }
  }

  // 動作總時長（ms）：type:'fn' 用 gesture.duration（預設 1500），keyframe 用最後一幀的 t
  function _gestureDuration(gesture) {
    return gesture.type === 'fn'
      ? (gesture.duration ?? 1500)
      : (gesture.duration ?? gesture.frames[gesture.frames.length - 1].t);
  }

  // 線性插值：給定 elapsed(ms)，從 frames 算出當前目標參數
  function _lerp(frames, elapsed) {
    if (elapsed >= frames[frames.length - 1].t) return { ...frames[frames.length - 1].params };
    for (let i = 0; i < frames.length - 1; i++) {
      const a = frames[i], b = frames[i + 1];
      if (elapsed >= a.t && elapsed <= b.t) {
        const p   = (elapsed - a.t) / (b.t - a.t);
        const ids = new Set([...Object.keys(a.params ?? {}), ...Object.keys(b.params ?? {})]);
        const r   = {};
        for (const id of ids) {
          const va = a.params?.[id], vb = b.params?.[id];
          if (va !== undefined && vb !== undefined) r[id] = va + (vb - va) * p;
          else r[id] = vb ?? va;
        }
        return r;
      }
    }
    return { ...frames[0].params };
  }

  function _hookChar(charKey, gesture) {
    _unhookChar(charKey);
    const cm = _cm(charKey);
    if (!cm) return;

    const orig      = cm.update.bind(cm);
    const startTime = performance.now();
    const hook      = { orig };
    _hooks[charKey] = hook;

    // ── type:'fn' — 自訂函數模式 ─────────────────────────────────────────────
    // gesture.interval (ms) : fn 重新計算姿勢的最小間隔；0 或不設定 = 每幀
    // 兩次 fn 呼叫之間用快取值繼續壓制 Live2D motion，不讓動作檔覆蓋
    if (gesture.type === 'fn') {
      const totalDur  = _gestureDuration(gesture);
      const interval  = gesture.interval  ?? 0;
      let _ids = [], _mins = [], _maxs = [];
      try {
        const m = cm._model;
        _ids  = [...m.parameters.ids];
        _mins = [...m.parameters.minimumValues];
        _maxs = [...m.parameters.maximumValues];
      } catch {}

      let lastComputeAt = -Infinity;
      const cache = new Map();   // id → value（fn 執行後快照）
      const ctx   = {};          // 每次播放的獨立狀態空間，供 fn 跨幀儲存資料

      const _runFn = elapsed => {
        try { gesture.fn(elapsed, cm, _ids, _mins, _maxs, ctx, totalDur); } catch {}
        _ids.forEach(id => { try { cache.set(id, cm.getParameterValueById(id)); } catch {} });
      };
      const _applyCache = () => {
        cache.forEach((v, id) => { try { cm.setParameterValueById(id, v); } catch {} });
      };

      cm.update = function () {
        const elapsed = performance.now() - startTime;
        if (elapsed < totalDur) {
          if (interval <= 0 || (elapsed - lastComputeAt) >= interval) {
            lastComputeAt = elapsed;
            _runFn(elapsed);    // 計算新姿勢並快照
          } else {
            _applyCache();      // 沿用上次姿勢（pre-orig）
          }
          orig();
          _applyCache();        // orig 後再壓一次，確保 motion 不蓋掉
        } else {
          _runFn(totalDur);     // 強制跑最後一次 fn（觸發 restore 分支）
          cm.update = orig;
          _hooks[charKey] = null;
          orig();
          _applyCache();        // 把 restore 後的值壓過 orig 這幀
        }
      };
      return;
    }

    // ── 原有 keyframe 插值模式 ────────────────────────────────────────────────
    const totalDur  = _gestureDuration(gesture);
    const blend     = gesture.blend ?? 0.3;

    cm.update = function () {
      const elapsed = performance.now() - startTime;
      if (elapsed < totalDur) {
        const target = _lerp(gesture.frames, elapsed);

        for (const [id, tv] of Object.entries(target)) {
          try {
            const cur = cm.getParameterValueById(id);
            cm.setParameterValueById(id, cur + (tv - cur) * blend);
          } catch {}
        }
        orig();
        for (const [id, tv] of Object.entries(target)) {
          try {
            const cur = cm.getParameterValueById(id);
            cm.setParameterValueById(id, cur + (tv - cur) * blend);
          } catch {}
        }

      } else {
        cm.update = orig;
        _hooks[charKey] = null;
        orig();
      }
    };
  }

  function _unhookChar(charKey) {
    const h = _hooks[charKey];
    if (!h) return;
    const cm = _cm(charKey);
    if (cm && h.orig) try { cm.update = h.orig; } catch {}
    _hooks[charKey] = null;
  }

  // ── 公開 API ───────────────────────────────────────────────────────────────
  return {
    /**
     * @param {string} [name]    省略 → 從所有已定義動作隨機挑一個
     * @param {'c1'|'c2'} [charKey] 省略 → 所有角色都播放；指定則只播放該角色
     */
    play(name, charKey) {
      const names = Object.keys(GESTURES);
      if (!name) name = names[Math.floor(Math.random() * names.length)];
      const g = GESTURES[name];
      if (!g) { console.warn('[GesturePlayer] 未知動作:', name, '| 可用:', names.join(', ')); return; }
      const chars = charKey ? [charKey] : ['c1', 'c2'];
      chars.forEach(c => _hookChar(c, g));
    },

    /**
     * 依序播放所有已定義動作，一個播完（滿它自己的時長）才接下一個。
     * @param {'c1'|'c2'} [charKey]   省略 → 每個動作都在兩個角色身上播放
     * @param {number} [gapMs=300]    每段動作之間的緩衝間隔
     */
    playAll(charKey, gapMs = 300) {
      const names = Object.keys(GESTURES);
      let i = 0;
      const next = () => {
        if (i >= names.length) return;
        const name = names[i++];
        this.play(name, charKey);
        setTimeout(next, _gestureDuration(GESTURES[name]) + gapMs);
      };
      next();
    },

    stop(charKey) {
      if (charKey) { _unhookChar(charKey); return; }
      _unhookChar('c1');
      _unhookChar('c2');
    },

    define(name, gesture) { GESTURES[name] = gesture; },
    list()                { return Object.keys(GESTURES); },
  };
})();

