'use strict';

// ── AvatarModule ──────────────────────────────────────────────────────────────
// 玩家自訂頭像：選圖、中心裁切、Base64 轉換、MQTT Publish / Receive、快取與渲染
// 對外只暴露 select / cacheOwn / publish / resetPublished / receive / html
// 不觸碰遊戲流程、題庫、分數、MQTT State
const AvatarModule = (() => {
  const DEFAULT = 'default_avatar.png';
  const TOPIC   = MP_TOPICS.PROFILE;
  const SIZE    = 256;

  let _myAvatar  = null;   // 自己裁好的 Base64 PNG
  const _cache   = {};     // playerId → Base64 src（避免重複解析）
  let _published = false;  // 每次加入遊戲只發送一次

  // 讀取 File → 中心裁切為正方形 → 縮放至 256×256 → PNG Base64
  function _crop(file) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
        reject('不支援此格式（jpg / png / webp）'); return;
      }
      if (file.size > 5 * 1024 * 1024) {
        reject('圖片過大（上限 5MB）'); return;
      }
      const reader = new FileReader();
      reader.onload = ev => {
        const img = new Image();
        img.onload = () => {
          const s = Math.min(img.naturalWidth, img.naturalHeight);
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = SIZE;
          canvas.getContext('2d').drawImage(
            img,
            (img.naturalWidth  - s) / 2,
            (img.naturalHeight - s) / 2,
            s, s, 0, 0, SIZE, SIZE
          );
          resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => reject('無法讀取圖片');
        img.src = ev.target.result;
      };
      reader.onerror = () => reject('讀取失敗');
      reader.readAsDataURL(file);
    });
  }

  return {
    // 選取圖片 → 裁切 → 回傳預覽 src；失敗時 throw 字串訊息
    async select(file) {
      const src = await _crop(file);
      _myAvatar = src;
      return src;
    },

    // 加入前把自己的頭像存入快取（publish 前呼叫）
    cacheOwn(playerId) {
      if (_myAvatar && !_cache[playerId]) _cache[playerId] = _myAvatar;
    },

    // 透過 MQTT client 發布 profile，每個 session 只送一次
    publish(client, playerId, playerName) {
      if (_published || !client?.publish) return;
      _published = true;
      client.publish(
        TOPIC,
        JSON.stringify({ playerId, name: playerName, avatar: _myAvatar || null }),
        { qos: 0 }
      );
    },

    // 玩家返回加入畫面時重置，讓下一局可再次發布
    resetPublished() { _published = false; },

    // 收到其他玩家的 profile 訊息時呼叫（不重複解析）
    receive({ playerId, avatar } = {}) {
      if (avatar && !_cache[playerId]) _cache[playerId] = avatar;
    },

    // 回傳可嵌入 innerHTML 的圓形頭像 <img> 字串
    html(playerId, size = 32) {
      const src = _cache[playerId] || DEFAULT;
      return `<img src="${src}" data-avid="${playerId}" width="${size}" height="${size}" `
        + `style="border-radius:50%;object-fit:cover;flex-shrink:0;vertical-align:middle;`
        + `border:1px solid rgba(255,255,255,.15)" `
        + `onerror="this.onerror=null;this.src='${DEFAULT}'">`;
    },

    topic: TOPIC,
  };
})();
