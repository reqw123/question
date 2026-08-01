'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// 換模型只需改 char1.model 或 char2.model 的路徑，其他全自動
// ══════════════════════════════════════════════════════════════════════════════
const L2D_CFG = {
  // ── 角色一（左側）────────────────────────────────────────────────────────
  char1: {
    enabled:  true,    // false → 不載入角色一
    model:    '../Live2d-model-master/少女次元/076/c_7001.model3.json',   // ../Live2d-model-master/Live2D/Senko_Normals/senko.model3.json
    width:    '30vw',    // 佔畫面寬度百分比（vw）或像素（px）
    maxWidth: '500px',   // 最大寬度上限
    scale:     0.7,     // 模型本體大小（1.0 = 填滿欄位寬）
    offsetX:  270,      // 水平微調（host 頁面）正 → 右；負 → 左
    offsetY:  86,      // 垂直微調（host 頁面）正 → 下；負 → 上
    rotation:  0,      // 旋轉角度（度數，正 → 順時針；負 → 逆時針）
    headRatio:  0.1,   // 泡泡 Y：頭部距  模型頂端比例（0=頂；調大往下移）
    headXRatio: 0.65,  // 泡泡 X：距模型左緣比例（0.5=中心；調大往右移）
  },
  // ── 角色二（左側第二欄，緊靠角色一右側）────────────────────────────────
  char2: {
    enabled:  true,    // false → 不載入角色二
    model:    '../Live2d-model-master/少女次元/077/c_7002.model3.json',  //../live2d_model/1024100/1024100.model3.json
    width:    '30vw',
    maxWidth: '500px',
    scale:      0.7,
    offsetX:    -39,     // 水平微調（host 頁面）
    offsetY:    131,       // 垂直微調（host 頁面）
    rotation:   0,       // 旋轉角度（度數）
    side:       'left',
    colIndex:   1,
    headRatio:  0.35,
    headXRatio: 0.3,
  },
  // ── 文字泡泡顯示時間 ──────────────────────────────────────────────────────
  speechDurationBefore: 3000,  // 答題前泡泡顯示時間 ms（type:'info'）
  speechDurationAfter:  2000,  // 答題後泡泡顯示時間 ms（type:'correct'/'wrong'/'celebrate'，比答題前少一秒）
  // ── 閒話家常隨機音效（與文字泡泡同步播放，留空陣列即靜音）────────────────
  chatSounds: [
    '../live2d-master/live2d-master/model/Violet/sound/start.mp3',
    '../live2d-master/live2d-master/model/Violet/sound/tap_Lhand.mp3',
    '../live2d-master/live2d-master/model/Violet/sound/tap_Rhand.mp3',
    '../live2d-master/live2d-master/model/Violet/sound/tap_body.mp3',
  ],
  // ── 遊戲內容被推開的距離 ──────────────────────────────────────────────────
  paddingLeft:  '40vw',
  paddingRight: '0',
  // ── 拖曳模式縮放上下限（滾輪 / 雙指 pinch 共用）────────────────────────
  scaleMin: 0.15,   // 最小縮放倍率
  scaleMax: 20.0,    // 最大縮放倍率
  storageNS: '',    // 位置存檔命名空間（host.html 設 'h'，player.html 設 'p'，各自獨立互不蓋）
  // ── player.html 專屬位置（host 直接改上方 char1/char2 的 offsetX/Y 即可）──
  playerPos: {
    char1: { offsetX:  -69,   offsetY: 70,  rotation: 0 },
    char2: { offsetX:  -354, offsetY: 110,  rotation: 0 },
  },
  // ── VFX 特效模式 ─────────────────────────────────────────────────────────
  // 'full' = 完整版（MagicShotVFX.js）| 'simple' = 備用版 | 'off' = 停用
  // 手機自動停用：/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'off' : 'full'
  vfxMode: 'simple',
  // ── 手機端專屬設定（player.html 套用，可獨立調整）───────────────────────
  mobile: {
    char1: { scale: 2.2, width: '20vw', side: 'center', offsetX:5, offsetY: 60,
             rotation: 0, headRatio: 0.13, headXRatio: 0.48 },
    char2: { scale: 2.2, width: '20vw', side: 'center', offsetX: 20, offsetY: 80,
             rotation: 0 },
  },
};
// ══════════════════════════════════════════════════════════════════════════════

// ── 通用動作別名表（動作檔名 → 程式碼 key）─────────────────────────────────
// 換模型後若有新動作，在這裡加一行即可；不在表內的動作以清理後的檔名作為 key
const L2D_ALIASES = {
  'wait_01':'wait', 'wait_02':'wait2',
  'happy_01':'happy', 'happy_02':'happy2', 'happy_03':'happy3',
  'sad_01':'sad', 'sad_02':'sad2',
  'cry_01':'cry', 'cry_02':'cry2', 'cry_03':'cry3', 'cry_04':'cry4',
  'serious_01':'serious', 'puzzle_01':'puzzle', 'surprise_01':'surprise',
  'shame_01':'shame', 'upset_01':'upset', 'doubt_01':'doubt',
  'anger_01':'anger', 'anger_02':'anger2', 'anger_03':'anger3',
  'excite_01':'excite', 'pride_01':'pride', 'appeal_01':'appeal',
  'skill_01':'skill', 'skill_02':'skill2',
  'bound':'bound', 'bound_double':'boundx2', 'bound_down':'bound_d',
  'expression_smile_01':'smile_e', 'expression_sad_01':'sad_e',
  'expression_serious_01':'serious_e', 'expression_anger_01':'anger_e',
  'expression_shame_01':'shame_e', 'expression_puzzle_01':'puzzle_e',
  'expression_upset_01':'upset_e', 'expression_upset_02':'upset2_e',
  'expression_eye_01':'eye_e', 'expression_crymouth_01':'crymouth_e',
  'expression_tooth_01':'tooth_e',
};

// ── 角色一閒話字典（50 句，索引對應角色二）────────────────────────────────
const L2D_CHAT_C1 = [
  '別緊張，慢慢來～',
  '我一直都在旁邊陪著你喔！',
  '今天看起來很有精神呢！',
  '記得多喝水喔～',
  '偶爾伸個懶腰也不錯！',
  '我剛剛偷偷發呆了一下。',
  '不知道晚餐要吃什麼呢？',
  '今天的天空不知道漂不漂亮。',
  '努力的人最閃閃發光了！',
  '你現在一定很專注吧？',
  '嘿嘿，我有在認真看著你喔！',
  '有時候放鬆反而更有效率。',
  '不要給自己太大壓力啦～',
  '慢慢累積，一定會變厲害。',
  '感覺今天會有好事發生。',
  '我喜歡這種一起努力的感覺。',
  '認真工作的樣子很帥氣呢！',
  '偶爾休息一下也是必要的。',
  '別忘了照顧自己的身體。',
  '看到你在線上我就很開心。',
  '加油加油！我幫你打氣！',
  '你覺得今天過得如何呢？',
  '有時候運氣也是實力的一部分。',
  '希望今天是順利的一天。',
  '哎呀，好像有點想睡覺。',
  '你有養寵物嗎？',
  '貓咪真的超可愛的。',
  '狗狗也很可愛就是了。',
  '今天天氣好像不錯。',
  '我喜歡安安靜靜陪伴人的感覺。',
  '有沒有覺得時間過得特別快？',
  '偶爾看看窗外吧。',
  '一直盯著螢幕眼睛會累喔。',
  '感覺今天的運勢不錯呢。',
  '嘿嘿，我又出現啦！',
  '不用急，照自己的步調來。',
  '有時候答案會自己浮現出來。',
  '今天也是努力的一天。',
  '希望你每天都開開心心。',
  '如果累了就休息一下吧。',
  '專注的時候時間總是過很快。',
  '最近有看什麼有趣的東西嗎？',
  '偶爾發呆其實也不錯。',
  '我正在幫你默默應援中。',
  '這個世界還有很多有趣的事呢！',
  '保持好奇心是很棒的事。',
  '未來一定會越來越好的。',
  '相信自己的能力吧！',
  '我對你很有信心喔！',
  '今天也請多多指教啦～',
];

// ── 角色二閒話字典（50 句，索引對應角色一）────────────────────────────────
const L2D_CHAT_C2 = [
  '放輕鬆！反正有我在！',
  '左右都有人陪，穩穩的！',
  '精神好，表現也一定好！',
  '對！喝水很重要，我也去喝一口！',
  '手往上舉，深呼吸一下！',
  '我也是⋯我們同步發呆了！',
  '我想吃麻辣鍋！超辣那種！',
  '如果能出去走走就好了！',
  '你現在超閃的！我被晃到了！',
  '專注臉很帥！繼續！',
  '我也是！雙重監視中！（誤）',
  '深呼吸——吸——呼——',
  '失敗沒關係，再來就好了！',
  '每一步努力都算數的！',
  '對！今天一定是好日子！',
  '一起加油！最強搭檔！',
  '真的！我看了也覺得很帥！',
  '對！健康才是最重要的！',
  '眼睛累了就閉一下嘛！',
  '我也超開心！感謝你在線！',
  '我也幫忙打氣！嗚哈哈！',
  '希望是很充實的一天！',
  '對！今天運氣超好我感覺到了！',
  '一定會順順的，放心！',
  '不對，要撐住！我也快睡了⋯',
  '我想養一隻小兔子！',
  '貓貓⋯貓貓⋯（腦迴路短路）',
  '狗狗搖尾巴超療癒！',
  '曬太陽充電，活力滿滿！',
  '我喜歡熱鬧，剛好互補！',
  '超快的！感覺剛開始而已！',
  '不知道外面是晴是陰！',
  '眨眨眼！像我這樣——',
  '對！財運桃花全開！（誤）',
  '我也是！雙倍驚喜出現！',
  '慢工出細活就是這樣！',
  '等靈感來敲門就好啦！',
  '明天繼續努力！今天辛苦了！',
  '開心的人最漂亮最帥了！',
  '累了就說，我陪你休息！',
  '進入心流狀態了嗎？',
  '有的話記得分享給我！',
  '放空一下超解壓的！',
  '雙重應援！加油加油！',
  '好奇心是最棒的動力！',
  '凡事多問一個為什麼！',
  '一步一步來，一定越來越好！',
  '我比你更相信你！',
  '信心加倍！你絕對沒問題！',
  '彼此彼此，一起加油！',
];

// ── 兩角色互動對話（c:1=左角色說, c:2=右角色說）────────────────────────────
const L2D_DIALOGUE = [
  [{ c:1, t:'加油哦！我們一起！' },           { c:2, t:'嗯！絕對沒問題的！' }],
  [{ c:2, t:'欸，你有沒有想說什麼？' },       { c:1, t:'就是... 謝謝你陪著我！' }],
  [{ c:1, t:'好難喔這題...' },               { c:2, t:'慢慢來，不要急！' }],
  [{ c:2, t:'好無聊，聊點什麼吧！' },         { c:1, t:'那你最近在幹嘛？' }],
  [{ c:1, t:'今天感覺狀態不太對...' },        { c:2, t:'怎麼了？說出來吧！' }],
  [{ c:2, t:'嘿嘿，我剛才眨眼了！' },         { c:1, t:'我有看到！太可愛了！' }],
  [{ c:1, t:'你有在看我嗎？' },              { c:2, t:'一直都有！怎麼了嗎？' }],
  [{ c:2, t:'快結束了吧？' },               { c:1, t:'再撐一下下！加油！' }],
  [{ c:1, t:'努力的樣子最閃閃發光了！' },     { c:2, t:'說、說什麼啦，害羞！' }],
  [{ c:2, t:'好緊張喔...' },               { c:1, t:'但我們一起就沒問題！' }],
  [{ c:1, t:'你覺得今天運氣好嗎？' },        { c:2, t:'感覺超好的！一定穩了！' }],
  [{ c:2, t:'我們是最強搭檔！' },           { c:1, t:'哈哈，說得對，無敵！' }],
  [{ c:1, t:'不管結果怎樣，謝謝你！' },      { c:2, t:'哎呀～當然要一起努力！' }],
  [{ c:2, t:'要不要喝點水休息一下？' },      { c:1, t:'嗯嗯，等等就去！' }],
  [{ c:1, t:'這次一定可以的！' },           { c:2, t:'當然！一起衝吧！' }],
];

const L2D = {
  app: null,
  _c1: { model: null, mMap: {}, gMap: {}, expList: [], expQueue: [], lastExpIdx: -1, ready: false },
  _c2: { model: null, mMap: {}, gMap: {}, expList: [], expQueue: [], lastExpIdx: -1, ready: false },
  _c1Queue: [],   _c1LastName: null,   _c1SeqIdx: -1,
  _c2Queue: [],   _c2LastName: null,
  _idleChatTimer:    null,
  _idleMotionTimer:  null,
  _exprTimer:        null,
  _emotionResetTimer:null,
  _lastChatIdx: -1,
  _chatAudio:   null,
  _dragging:    null,
  _pinching:    null,
  _rotMode:     false,
  _speechRaf:   null,
  _speechRaf2:  null,
  _dialogueTimer: null,
  _lastDlgIdx:    -1,

  // ── 公開 API ──────────────────────────────────────────────────────────────

  async init() {
    this._applyCSS();
    if (!this._checkDeps()) return;

    // 單一全螢幕透明 canvas — 避免多 PIXI Application 互搶 WebGL context
    // autoDensity:true → PIXI 自動把 canvas CSS 尺寸壓回邏輯像素，
    // 使 PIXI 座標系 = CSS 邏輯像素，解決高 DPI 螢幕解析度破壞問題
    this.app = new PIXI.Application({
      width:           window.innerWidth,
      height:          window.innerHeight,
      backgroundAlpha: 0,
      antialias:       true,
      resolution:      Math.min(window.devicePixelRatio || 1, 2),
      autoDensity:     true,
    });
    const cv = this.app.view;
    // position:fixed 讓 canvas 釘在視口；CSS 尺寸由 autoDensity 管理，
    // 此處只補 Android Chrome 100vh 偏差（URL bar 顯示時 innerHeight 比 100vh 小）
    cv.style.cssText = `position:fixed;top:0;left:0;` +
                       `width:${window.innerWidth}px;height:${window.innerHeight}px;` +
                       `pointer-events:none;z-index:5;`;
    document.body.appendChild(cv);
    this._initDragButtons();

    // 依序載入，避免 pixi-live2d-display 初始化競爭
    await this._load('c1', L2D_CFG.char1, 'left');
    await this._load('c2', L2D_CFG.char2, 'right');

    if (this._c1.ready || this._c2.ready) {
      document.body.classList.add('l2d-ready');
      console.log('[L2D] ✓ ready  c1=' + this._c1.ready + '  c2=' + this._c2.ready);
      setTimeout(() => this.printPos(), 300);
    }
    // 防抖 150 ms：連發 resize 事件只執行最後一次，防止頻繁 _fit() 破壞渲染
    let _resizeTid = null;
    window.addEventListener('resize', () => {
      clearTimeout(_resizeTid);
      _resizeTid = setTimeout(() => this._onResize(), 150);
    });
  },

  /** 同時播放兩個角色 */
  play(name, delayMs = 0) {
    this._go(this._c1, name, delayMs);
    this._go(this._c2, name, delayMs);
  },
  /** 角色一依序輪流播放（不是隨機洗牌）：固定照 gMap 收集到的順序一顆接一顆循環，
   *  播完最後一顆自動回到第一顆。跟 playRandom2（角色二，仍是隨機洗牌）刻意不對稱——
   *  角色一目前掛的是固定的「idle → skill」兩顆動作，用依序輪流才可預期、可控制何時觸發技能。 */
  playRandom1(delayMs = 0, exclude = []) {
    const run = () => {
      const s = this._c1;
      if (!s.ready || !s.model) return;
      const all = [];
      Object.entries(s.gMap).forEach(([group, names]) => {
        if (!exclude.includes(group))
          names.forEach((name, idx) => all.push({ group, idx, name }));
      });
      if (!all.length) return;
      this._c1SeqIdx = (this._c1SeqIdx + 1) % all.length;
      const { group, idx, name } = all[this._c1SeqIdx];
      this._c1LastName = name;
      Promise.resolve(s.model.motion(group, idx, 3)).catch(() => {});
      this._showMotionLabel('c1:' + name);
    };
    delayMs > 0 ? setTimeout(run, delayMs) : run();
  },

  /** 角色二洗牌輪播動作：同一輪內不重複，播完自動重洗，自動排除角色一目前動作 */
  playRandom2(delayMs = 0, exclude = []) {
    const run = () => {
      const s = this._c2;
      if (!s.ready || !s.model) return;
      const all = [];
      Object.entries(s.gMap).forEach(([group, names]) => {
        if (!exclude.includes(group))
          names.forEach((name, idx) => all.push({ group, idx, name }));
      });
      if (!all.length) return;
      if (!this._c2Queue.length) {
        this._c2Queue = [...all].sort(() => Math.random() - 0.5);
        const last = this._c2Queue.length - 1;
        if (last > 0 && this._c2Queue[last].name === this._c2LastName)
          [this._c2Queue[last], this._c2Queue[last - 1]] = [this._c2Queue[last - 1], this._c2Queue[last]];
      }
      // 若佇列頂端與角色一目前動作相同，對調避免兩角色動作重複
      if (this._c2Queue.length >= 2 &&
          this._c2Queue[this._c2Queue.length - 1].name === this._c1LastName)
        [this._c2Queue[this._c2Queue.length - 1], this._c2Queue[this._c2Queue.length - 2]] =
        [this._c2Queue[this._c2Queue.length - 2], this._c2Queue[this._c2Queue.length - 1]];
      const { group, idx, name } = this._c2Queue.pop();
      this._c2LastName = name;
      Promise.resolve(s.model.motion(group, idx, 3)).catch(() => {});
      this._showMotionLabel('c2:' + name);
    };
    delayMs > 0 ? setTimeout(run, delayMs) : run();
  },

  /** 自動循環動作＋表情（動作兩角色同步播放；表情仍交錯播放，避免同步感）
   *  職責是唯一負責觸發動作/表情的地方；startIdleChat 只管講話泡泡+音效，不會再重複觸發這裡的東西。 */
  startIdleMotion(intervalMs = 6000) {
    this.stopIdleMotion();
    // 動作循環 — 角色一、二同步播放
    const fireMot = () => {
      this.playRandom1();
      this.playRandom2();
      this._idleMotionTimer = setTimeout(fireMot, intervalMs);
    };
    fireMot();
    // 表情循環（比動作更頻繁，錯開啟動時間）
    const exprMs = Math.max(3500, Math.round(intervalMs * 0.55));
    const fireExpr = () => {
      this.playRandomExpr1();
      setTimeout(() => this.playRandomExpr2(), 500 + Math.floor(Math.random() * 900));
      this._exprTimer = setTimeout(fireExpr, exprMs);
    };
    setTimeout(() => fireExpr(), 2000);
  },

  stopIdleMotion() {
    if (this._idleMotionTimer) { clearTimeout(this._idleMotionTimer); this._idleMotionTimer = null; }
    if (this._exprTimer)       { clearTimeout(this._exprTimer);       this._exprTimer = null; }
  },

  /**
   * 依遊戲結果播放情緒動作（兩角色同步）
   * type: 'correct' | 'wrong' | 'celebrate' | 'info'
   * 若該情緒動作不存在，退路至 playRandom
   */
  playEmotion(type = 'info') {
    const map = {
      correct:   ['happy', 'excite', 'pride', 'appeal'],
      wrong:     ['sad', 'upset', 'doubt', 'shame', 'cry'],
      celebrate: ['excite', 'pride', 'happy', 'happy2', 'happy3'],
      info:      ['wait', 'wait2', 'surprise'],
    };
    const keys = map[type] || map.info;
    // 兩角色各選不同 key（key 只有 1 個時才允許相同）
    const i1 = Math.floor(Math.random() * keys.length);
    let i2 = i1;
    if (keys.length > 1) do { i2 = Math.floor(Math.random() * keys.length); } while (i2 === i1);
    const key1 = keys[i1], key2 = keys[i2];

    const tryMotion = (state, key, fallbackFn) => {
      if (!state.ready || !state.model) return;
      const idx = state.mMap[key];
      if (idx !== undefined) {
        Promise.resolve(state.model.motion('', idx, 3)).catch(() => {});
        this._showMotionLabel(key);
        return;
      }
      for (const [group, names] of Object.entries(state.gMap || {})) {
        for (let i = 0; i < names.length; i++) {
          const clean = names[i].replace(/^\d+_/i,'').toLowerCase();
          if ((L2D_ALIASES[clean] || clean) === key) {
            Promise.resolve(state.model.motion(group, i, 3)).catch(() => {});
            this._showMotionLabel(key);
            return;
          }
        }
      }
      fallbackFn();
    };
    tryMotion(this._c1, key1, () => this.playRandom1());
    tryMotion(this._c2, key2, () => this.playRandom2());

    // 情緒動作結束後強制回到中立姿態，清除殘留的手臂/手指位置
    clearTimeout(this._emotionResetTimer);
    this._emotionResetTimer = setTimeout(() => {
      this._go(this._c1, 'wait', 0);
      this._go(this._c2, 'wait', 0);
    }, 2400);
  },

  // ── 內部 ──────────────────────────────────────────────────────────────────

  _checkDeps() {
    const hasC2 = typeof Live2D !== 'undefined';
    const hasC4 = typeof Live2DCubismCore !== 'undefined';
    if (!hasC2 && !hasC4) { console.error('[L2D] 缺少 Cubism Core（live2d.min.js 或 live2dcubismcore.min.js）'); return false; }
    if (typeof PIXI === 'undefined')   { console.error('[L2D] 缺少 pixi.min.js');        return false; }
    if (!PIXI.live2d?.Live2DModel)     { console.error('[L2D] 缺少 cubism-all.min.js');   return false; }
    console.log('[L2D] deps OK — PIXI', PIXI.VERSION, ' Cubism2=' + hasC2 + ' Cubism4=' + hasC4);
    return true;
  },

  async _load(key, cfg, side) {
    if (cfg.enabled === false || !cfg.model) return;
    const state = this['_' + key];
    try {
      try {
        const saved       = JSON.parse(localStorage.getItem(this._lsKey(key)));
        const currentSide = cfg.side || side;
        // side 相符且 model 路徑相符才還原；換模型後自動作廢舊偏移
        if (saved && saved.side === currentSide && saved.model === cfg.model) {
          cfg.offsetX = saved.x || 0;
          cfg.offsetY = saved.y || 0;
          if (saved.scale    != null) cfg.scale    = saved.scale;
          if (saved.rotation != null) cfg.rotation = saved.rotation;
        }
      } catch {}
      console.log('[L2D] 載入', key, cfg.model);
      const modelJson = await fetch(cfg.model).then(r => r.json());
      state.mMap    = this._buildMotionMap(modelJson);
      state.expList = this._buildExprList(modelJson);
      state.model   = await PIXI.live2d.Live2DModel.from(cfg.model);
      state.gMap    = this._buildGroupMap(state.model);
      state.expQueue   = [];
      state.lastExpIdx = -1;
      console.log('[L2D]', key, '動作表:', state.mMap, '群組:', state.gMap, '表情數:', state.expList.length);
      this.app.stage.addChild(state.model);
      this._fit(state, cfg, side);
      state.ready = true;
      this._go(state, 'wait', 0);
      console.log('[L2D]', key, '✓');
    } catch (err) {
      console.error('[L2D]', key, '載入失敗:', err);
    }
  },

  /** 從已載入的 model 內部資料讀取群組，回傳 { groupName: ['motion_name', ...] } */
  _buildGroupMap(model) {
    try {
      const motions = model.internalModel?.settings?.motions || {};
      const map = {};
      Object.entries(motions).forEach(([group, list]) => {
        if (Array.isArray(list) && list.length) {
          map[group] = list.map(m =>
            (m.File || m.file || '').split('/').pop().replace(/\.(motion3\.json|mtn)$/i, '')
          );
        }
      });
      return map;
    } catch { return {}; }
  },

  /** 將已解析的 model JSON 轉為動作 key → index 表 */
  _buildMotionMap(json) {
    // Cubism 3/4 用 FileReferences.Motions；Cubism 2 用 motions（小寫）
    const isCubism2 = !json.FileReferences;
    const motions = isCubism2
      ? (json.motions?.[''] || [])
      : (json.FileReferences?.Motions?.[''] || []);
    const map = {};
    motions.forEach((m, i) => {
      const file  = m.File || m.file || '';
      const base  = file.split('/').pop().replace(/\.(motion3\.json|mtn)$/i, '');
      const clean = base.replace(/^\d+_/i, '').toLowerCase();
      const key   = L2D_ALIASES[clean] || clean;
      if (map[key] === undefined) map[key] = i;
    });
    return map;
  },

  /** 從已解析的 model JSON 讀取 Expressions 清單，回傳名稱陣列（無則空陣列） */
  _buildExprList(json) {
    // Cubism 4/3
    const arr4 = json.FileReferences?.Expressions;
    if (Array.isArray(arr4) && arr4.length)
      return arr4.map(e => e.Name || e.name || '').filter(Boolean);
    // Cubism 2
    const arr2 = json.expressions;
    if (Array.isArray(arr2) && arr2.length)
      return arr2.map(e => e.name || '').filter(Boolean);
    return [];
  },

  /** 角色一隨機切換表情（洗牌輪播，不連續重複） */
  playRandomExpr1() {
    const s = this._c1;
    if (!s.ready || !s.model || !s.expList.length) return;
    if (!s.expQueue.length) {
      s.expQueue = s.expList.map((_, i) => i).sort(() => Math.random() - 0.5);
      const last = s.expQueue.length - 1;
      if (last > 0 && s.expQueue[last] === s.lastExpIdx)
        [s.expQueue[last], s.expQueue[last - 1]] = [s.expQueue[last - 1], s.expQueue[last]];
    }
    const idx = s.expQueue.pop();
    s.lastExpIdx = idx;
    Promise.resolve(s.model.expression(idx)).catch(() => {});
    this._showMotionLabel('c1:expr:' + (s.expList[idx] || idx));
  },

  /** 角色二隨機切換表情（洗牌輪播，不連續重複） */
  playRandomExpr2() {
    const s = this._c2;
    if (!s.ready || !s.model || !s.expList.length) return;
    if (!s.expQueue.length) {
      s.expQueue = s.expList.map((_, i) => i).sort(() => Math.random() - 0.5);
      const last = s.expQueue.length - 1;
      if (last > 0 && s.expQueue[last] === s.lastExpIdx)
        [s.expQueue[last], s.expQueue[last - 1]] = [s.expQueue[last - 1], s.expQueue[last]];
    }
    const idx = s.expQueue.pop();
    s.lastExpIdx = idx;
    Promise.resolve(s.model.expression(idx)).catch(() => {});
    this._showMotionLabel('c2:expr:' + (s.expList[idx] || idx));
  },

  _showMotionLabel(name) {
    let el = document.getElementById('l2d-motion-label');
    if (!el) {
      el = Object.assign(document.createElement('div'), { id: 'l2d-motion-label' });
      el.style.cssText = 'position:fixed;top:8px;right:8px;background:rgba(0,0,0,.55);' +
        'color:#fff;font:12px/1.4 monospace;padding:4px 10px;border-radius:6px;' +
        'pointer-events:none;z-index:9999;transition:opacity .4s;';
      document.body.appendChild(el);
    }
    el.textContent = '▶ ' + name;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 2500);
  },

  _go(state, name, delayMs) {
    const run = () => {
      if (!state.ready || !state.model) return;
      // 優先用 mMap（'' 空群組）
      const idx = state.mMap[name];
      if (idx !== undefined) {
        Promise.resolve(state.model.motion('', idx, 3)).catch(() => {});
        return;
      }
      // 退路：從 gMap 具名群組依別名搜尋
      for (const [group, names] of Object.entries(state.gMap || {})) {
        for (let i = 0; i < names.length; i++) {
          const clean = names[i].replace(/^\d+_/i, '').toLowerCase();
          const key   = L2D_ALIASES[clean] || clean;
          if (key === name) {
            Promise.resolve(state.model.motion(group, i, 3)).catch(() => {});
            return;
          }
        }
      }
      // 再退一步：完全找不到別名對應時，與其什麼都不播，不如播「模型第一個可用的動作」，
      // 至少角色看起來還會動——常見於動作庫很陽春（例如只有一顆沒特別命名的通用動作）的模型，
      // 這種模型的動作檔名不會剛好對到 L2D_ALIASES，導致上面兩層查找都落空。
      if (Object.keys(state.mMap).length) {
        Promise.resolve(state.model.motion('', 0, 3)).catch(() => {});
      } else {
        const firstGroup = Object.keys(state.gMap || {})[0];
        if (firstGroup !== undefined) Promise.resolve(state.model.motion(firstGroup, 0, 3)).catch(() => {});
      }
    };
    delayMs > 0 ? setTimeout(run, delayMs) : run();
  },

  _fit(state, cfg, side, silent = false) {
    if (!state.model || !this.app) return;
    const W = this.app.screen.width;
    const H = this.app.screen.height;

    state.model.scale.set(1);
    const nw = state.model.width  || 2048;
    const nh = state.model.height || 2048;

    // 計算欄位寬度（支援 vw / px）
    const colW = Math.min(this._parseSize(cfg.width, W), parseFloat(cfg.maxWidth) || Infinity);
    const s    = (colW * cfg.scale) / nw;
    state.model.scale.set(s);

    const mw = nw * s, mh = nh * s;

    const s2     = cfg.side || side;
    const colIdx = cfg.colIndex || 0;
    const colX   = (s2 === 'left')   ? colW * colIdx :
                   (s2 === 'center') ? (W - colW * 2) / 2 + colW * colIdx :
                   W - colW * (colIdx + 1);

    // 以模型視覺中心為旋轉軸（不動 pivot，用數學補償 position）
    // 旋轉 θ 後要讓中心點 (cx, cy) 保持不動：
    //   position = (cx - mw/2·cosθ + mh/2·sinθ,  cy - mw/2·sinθ - mh/2·cosθ)
    const θ    = ((cfg.rotation || 0) * Math.PI) / 180;
    const cosθ = Math.cos(θ), sinθ = Math.sin(θ);
    const cx = colX + (colW - mw) * 0.5 + this._parseSize(cfg.offsetX, W) + mw / 2;
    const cy = H    - mh               + this._parseSize(cfg.offsetY, H)  + mh / 2;
    state.model.rotation = θ;
    state.model.position.set(
      cx - (mw / 2) * cosθ + (mh / 2) * sinθ,
      cy - (mw / 2) * sinθ - (mh / 2) * cosθ
    );
    state._nw = nw;
    state._nh = nh;
    state._mw = mw;
    state._mh = mh;
    if (state === this._c1) this._updateSpeechPos();
    if (state === this._c2) this._updateSpeechPos2();
    if (!silent) console.log('[L2D] fit', side, 'scale=' + s.toFixed(3),
      'offsetX=' + cfg.offsetX + ' offsetY=' + cfg.offsetY + ' rotation=' + (cfg.rotation || 0) + '°',
      '→ canvasX=' + state.model.x.toFixed(0) + ' canvasY=' + state.model.y.toFixed(0));
  },

  _updateSpeechPos() {
    const box = document.getElementById('l2d-speech');
    if (!box || !this._c1.model || !this._c1.ready) return;
    const m   = this._c1.model;
    const hr  = L2D_CFG.char1.headRatio  ?? 0.25;
    const hxr = L2D_CFG.char1.headXRatio ?? 0.5;
    const nw  = this._c1._nw || 2048;
    const nh  = this._c1._nh || 2048;
    // 以模型原始座標換算螢幕位置，縮放/拖曳後仍精確
    const sp  = m.toGlobal(new PIXI.Point(nw * hxr, nh * hr));
    box.style.left      = (sp.x + 3) + 'px';
    box.style.top       = sp.y       + 'px';
    box.style.bottom    = '';
    box.style.transform = 'translateY(-50%)';
    // 泡泡不得超過遊戲內容左緣（paddingLeft），超出部分以換行收進安全區
    const pl     = this._parseSize(L2D_CFG.paddingLeft, window.innerWidth);
    const rightBound = pl > 60 ? pl : window.innerWidth * 0.45;
    box.style.maxWidth = Math.max(120, rightBound - sp.x - 16) + 'px';
  },

  _updateSpeechPos2() {
    const box = document.getElementById('l2d-speech2');
    if (!box || !this._c2.model || !this._c2.ready) return;
    const m   = this._c2.model;
    const hr  = L2D_CFG.char2.headRatio  ?? 0.25;
    const hxr = L2D_CFG.char2.headXRatio ?? 0.5;
    const nw  = this._c2._nw || 2048;
    const nh  = this._c2._nh || 2048;
    const sp  = m.toGlobal(new PIXI.Point(nw * hxr, nh * hr));
    box.style.right     = (window.innerWidth - sp.x + 3) + 'px';
    box.style.left      = '';
    box.style.top       = sp.y + 'px';
    box.style.bottom    = '';
    box.style.transform = 'translateY(-50%)';
    // 泡泡向左延伸，不超出畫面左緣
    box.style.maxWidth  = Math.max(120, sp.x - 16) + 'px';
  },

  _initDragButtons() {
    const S = 'position:fixed;left:6px;z-index:10000;width:45px;height:45px;' +
      'border-radius:9px;border:1px solid rgba(255,255,255,.18);' +
      'background:rgba(0,0,0,.5);color:#888;font-size:21px;cursor:pointer;padding:0;';
    const mk = (title, bottom) => {
      const b = document.createElement('button');
      b.title = title;
      b.textContent = '⠿';
      b.style.cssText = S + 'bottom:' + bottom + 'px;';
      document.body.appendChild(b);
      return b;
    };
    const b1 = mk('拖曳角色一', 8);
    const b2 = mk('拖曳角色二', 61);
    let active = null;
    const toggle = (key) => {
      active = key;
      b1.style.background = key === 'c1' ? 'rgba(0,212,255,.25)' : 'rgba(0,0,0,.5)';
      b1.style.color      = key === 'c1' ? 'var(--cyan)'         : '#888';
      b2.style.background = key === 'c2' ? 'rgba(0,212,255,.25)' : 'rgba(0,0,0,.5)';
      b2.style.color      = key === 'c2' ? 'var(--cyan)'         : '#888';
      this.stopDrag();
      if (key) this.startDrag(key);
    };
    b1.addEventListener('click', () => toggle(active === 'c1' ? null : 'c1'));
    b2.addEventListener('click', () => toggle(active === 'c2' ? null : 'c2'));
  },

  startDrag(key) {
    const state   = this['_' + key];
    const cfg     = key === 'c1' ? L2D_CFG.char1 : L2D_CFG.char2;
    const defSide = key === 'c1' ? 'left' : 'right';
    if (!state.ready || !this.app) return;
    const cv = this.app.view;
    cv.style.pointerEvents = 'auto';
    cv.style.zIndex = '9999';
    cv.style.cursor = this._rotMode ? 'ew-resize' : 'grab';

    const _saveState = (c, dSide) => {
      localStorage.setItem(this._lsKey(key), JSON.stringify({
        x: c.offsetX, y: c.offsetY, side: c.side || dSide,
        scale: c.scale, rotation: c.rotation || 0, model: c.model,
      }));
    };

    // ── 三連點偵測 ────────────────────────────────────────────────────────────
    let _tapCount = 0, _tapTimer = null, _tapX0 = 0, _tapY0 = 0, _tapT0 = 0;

    const onDown = (e) => {
      if (e.touches && e.touches.length >= 2) {
        // 雙指 → 縮放模式（距離變化）
        const t0 = e.touches[0], t1 = e.touches[1];
        this._pinching = {
          dist0:  Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY),
          scale0: cfg.scale,
        };
        this._dragging = null;
      } else {
        // 單指或滑鼠
        this._pinching = null;
        const p = (e.touches && e.touches[0]) || e;
        _tapX0 = p.clientX;
        _tapY0 = p.clientY;
        _tapT0 = Date.now();
        if (this._rotMode) {
          // 旋轉模式：水平拖曳控制角度
          this._dragging = { key, state, cfg, side: defSide,
            sx: p.clientX, sy: p.clientY,
            rotOnly: true, rot0: cfg.rotation || 0 };
          cv.style.cursor = 'ew-resize';
        } else {
          const W = this.app.screen.width, H = this.app.screen.height;
          this._dragging = { key, state, cfg, side: defSide,
            sx: p.clientX, sy: p.clientY,
            ox: this._parseSize(cfg.offsetX, W),
            oy: this._parseSize(cfg.offsetY, H) };
          cv.style.cursor = 'grabbing';
        }
      }
      e.preventDefault();
    };

    const onMove = (e) => {
      if (e.touches && e.touches.length >= 2 && this._pinching) {
        // 雙指縮放
        const pn   = this._pinching;
        const t0   = e.touches[0], t1 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        cfg.scale  = Math.max(L2D_CFG.scaleMin, Math.min(L2D_CFG.scaleMax, pn.scale0 * (dist / pn.dist0)));
        this._fit(state, cfg, cfg.side || defSide, true);
        e.preventDefault();
        return;
      }
      if (!this._dragging) return;
      const p = (e.touches && e.touches[0]) || e;
      if (this._dragging.rotOnly) {
        // 旋轉模式：水平位移 → 旋轉角度（4px = 1°）
        cfg.rotation = this._dragging.rot0 + (p.clientX - this._dragging.sx) / 4;
        this._fit(state, cfg, cfg.side || defSide, true);
      } else {
        const d = this._dragging;
        d.cfg.offsetX = d.ox + (p.clientX - d.sx);
        d.cfg.offsetY = d.oy + (p.clientY - d.sy);
        this._fit(d.state, d.cfg, d.cfg.side || d.side, true);
      }
      e.preventDefault();
    };

    const onUp = (e) => {
      // ── 三連點判斷 ─────────────────────────────────────────────────────────
      const ch = e.changedTouches ? e.changedTouches[0] : e;
      if (ch && !this._pinching) {
        const dist = Math.hypot(ch.clientX - _tapX0, ch.clientY - _tapY0);
        const dur  = Date.now() - _tapT0;
        if (dist < 12 && dur < 300) {
          _tapCount++;
          clearTimeout(_tapTimer);
          if (_tapCount >= 3) {
            _tapCount = 0;
            this._rotMode = !this._rotMode;
            cv.style.cursor = this._rotMode ? 'ew-resize' : 'grab';
            this._showRotHint(this._rotMode);
          } else {
            _tapTimer = setTimeout(() => { _tapCount = 0; }, 500);
          }
        } else {
          _tapCount = 0;
          clearTimeout(_tapTimer);
        }
      }

      if (e && e.type === 'touchend') {
        if (e.touches.length === 1 && this._pinching) {
          // 雙指→單指：儲存縮放，切回拖曳
          _saveState(cfg, defSide);
          this._pinching = null;
          const p = e.touches[0];
          this._dragging = { key, state, cfg, side: defSide,
            sx: p.clientX, sy: p.clientY, ox: cfg.offsetX, oy: cfg.offsetY };
          return;
        }
        if (e.touches.length > 0) return;
      }
      this._pinching = null;
      if (!this._dragging) return;
      const { cfg: c, side: dSide } = this._dragging;
      _saveState(c, dSide);
      this._dragging = null;
      cv.style.cursor = this._rotMode ? 'ew-resize' : 'grab';
      this.printPos();
    };

    const onWheel = (e) => {
      e.preventDefault();
      if (e.shiftKey) {
        cfg.rotation = (cfg.rotation || 0) + (e.deltaY > 0 ? -3 : 3);
      } else {
        const step = e.deltaY > 0 ? -0.08 : 0.08;
        cfg.scale = Math.max(L2D_CFG.scaleMin, Math.min(L2D_CFG.scaleMax, cfg.scale + step));
      }
      this._fit(state, cfg, cfg.side || defSide);
      _saveState(cfg, defSide);
    };

    cv._l2dDrag = { onDown, onMove, onUp, onWheel };
    cv.addEventListener('mousedown',  onDown);
    cv.addEventListener('touchstart', onDown, { passive: false });
    cv.addEventListener('wheel',      onWheel, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup',  onUp);
    document.addEventListener('touchend', onUp);
  },

  _showRotHint(active) {
    let el = document.getElementById('l2d-rot-hint');
    if (!el) {
      el = document.createElement('div');
      el.id = 'l2d-rot-hint';
      el.style.cssText =
        'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
        'background:rgba(0,0,0,.78);color:#0df;font-size:1em;font-weight:700;' +
        'padding:10px 22px;border-radius:20px;pointer-events:none;z-index:10001;' +
        'transition:opacity .4s;white-space:nowrap;';
      document.body.appendChild(el);
    }
    el.textContent = active ? '↻ 旋轉模式 — 左右滑動旋轉角色' : '↻ 旋轉模式 關閉';
    el.style.opacity = '1';
    clearTimeout(this._rotHintTimer);
    this._rotHintTimer = setTimeout(() => { el.style.opacity = '0'; }, 1800);
  },

  stopDrag() {
    if (!this.app || !this.app.view) return;
    const cv = this.app.view;
    cv.style.pointerEvents = 'none';
    cv.style.zIndex = '5';    // 還原，讓遊戲 UI 重新可互動
    cv.style.cursor = '';
    const h = cv._l2dDrag;
    if (h) {
      cv.removeEventListener('mousedown',  h.onDown);
      cv.removeEventListener('touchstart', h.onDown);
      cv.removeEventListener('wheel',      h.onWheel);
      document.removeEventListener('mousemove', h.onMove);
      document.removeEventListener('touchmove', h.onMove);
      document.removeEventListener('mouseup',   h.onUp);
      document.removeEventListener('touchend',  h.onUp);
      delete cv._l2dDrag;
    }
    this._dragging = null;
    this._pinching = null;
  },

  _lsKey(k) {
    return 'l2d_pos_' + (L2D_CFG.storageNS ? L2D_CFG.storageNS + '_' : '') + k;
  },

  /** 在瀏覽器 console 呼叫 L2D.printPos() 可取得當前座標，貼入 hostPos / playerPos */
  printPos() {
    const fmt = v => typeof v === 'number' ? v : `'${v}'`;
    const cx1 = this._c1.model ? this._c1.model.x.toFixed(0) : '?';
    const cy1 = this._c1.model ? this._c1.model.y.toFixed(0) : '?';
    const cx2 = this._c2.model ? this._c2.model.x.toFixed(0) : '?';
    const cy2 = this._c2.model ? this._c2.model.y.toFixed(0) : '?';
    console.log('%c[L2D] 座標 ─ 貼入 hostPos / playerPos', 'color:#0f6;font-weight:bold;font-size:13px');
    console.log(`  char1: { offsetX: ${fmt(L2D_CFG.char1.offsetX)}, offsetY: ${fmt(L2D_CFG.char1.offsetY)}, rotation: ${fmt(L2D_CFG.char1.rotation || 0)} }  ← 貼這個`);
    console.log(`         畫布實際位置: canvasX=${cx1} canvasY=${cy1}  (僅供參考，offsetX≠canvasX)`);
    console.log(`  char2: { offsetX: ${fmt(L2D_CFG.char2.offsetX)}, offsetY: ${fmt(L2D_CFG.char2.offsetY)}, rotation: ${fmt(L2D_CFG.char2.rotation || 0)} }  ← 貼這個`);
    console.log(`         畫布實際位置: canvasX=${cx2} canvasY=${cy2}`);
  },

  /** 清除此頁面的拖曳存檔，讓 hostPos / playerPos 程式碼設定生效（重新整理後才看到效果） */
  clearPos() {
    ['c1', 'c2'].forEach(k => {
      try { localStorage.removeItem(this._lsKey(k)); } catch {}
    });
    console.log('%c[L2D] localStorage 位置已清除，請重新整理頁面 (F5)', 'color:#fa0;font-weight:bold');
  },

  _parseSize(spec, viewportW) {
    if (typeof spec === 'number') return spec;
    if (spec.endsWith('vw')) return parseFloat(spec) * viewportW / 100;
    return parseFloat(spec);   // px 或純數字
  },

  _onResize() {
    if (!this.app) return;
    // 動態更新 DPR（視窗移到不同螢幕或瀏覽器縮放時 dpr 可能改變）
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.app.renderer.resolution = dpr;
    const w = window.innerWidth, h = window.innerHeight;
    this.app.renderer.resize(w, h);
    // autoDensity 會自動設 CSS，但這裡仍明確設定確保 position:fixed 精確
    const cv = this.app.view;
    cv.style.width  = w + 'px';
    cv.style.height = h + 'px';
    if (this._c1.model) this._fit(this._c1, L2D_CFG.char1, 'left');
    if (this._c2.model) this._fit(this._c2, L2D_CFG.char2, 'right');
  },

  _applyCSS() {
    const pl = L2D_CFG.paddingLeft, pr = L2D_CFG.paddingRight;
    const el = document.getElementById('l2d-style') ||
      document.head.appendChild(Object.assign(document.createElement('style'), { id: 'l2d-style' }));
    el.textContent = `
      body.l2d-ready #screen-intro,
      body.l2d-ready #screen-finish,
      body.l2d-ready .game-main,
      body.l2d-ready .top-bar { padding-left:${pl}; padding-right:${pr}; }
      body.l2d-ready #overlay-result,
      body.l2d-ready #overlay-expl,
      body.l2d-ready #result-overlay,
      body.l2d-ready #expl-overlay  { left:${pl}; right:${pr}; border-radius:var(--radius); }
      body.l2d-ready #expl-overlay  { background:rgba(3,10,22,.55); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); }
      body.l2d-ready #result-overlay { background:rgba(3,10,22,.55); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); }
      body.l2d-ready #p-scoreboard { left:${pl}; border-radius:8px; }
      @media (max-width:900px) {
        body.l2d-ready #screen-intro,
        body.l2d-ready #screen-finish,
        body.l2d-ready .game-main,
        body.l2d-ready .top-bar { padding-left:0; padding-right:0; }
        body.l2d-ready #overlay-result,
        body.l2d-ready #overlay-expl  { left:0; right:0; border-radius:0; }
        body.l2d-ready #result-overlay,
        body.l2d-ready #expl-overlay  { left:0; right:0; border-radius:0; background:rgba(3,10,22,.85); }
        body.l2d-ready #p-scoreboard  { left:0; border-radius:0 10px 10px 0; }
      }
      @keyframes _l2dSpeakIn  {
        0%  { opacity:0; transform:scale(.45) translateX(-8px); }
        70% { opacity:1; transform:scale(1.04) translateX(2px); }
        100%{ opacity:1; transform:scale(1)   translateX(0);    }
      }
      @keyframes _l2dSpeakOut {
        0%  { opacity:1; transform:scale(1)    translateX(0);    }
        100%{ opacity:0; transform:scale(.82)  translateX(-6px); }
      }
      @keyframes _l2dSpeakIn2  {
        0%  { opacity:0; transform:scale(.45) translateX(8px); }
        70% { opacity:1; transform:scale(1.04) translateX(-2px); }
        100%{ opacity:1; transform:scale(1)   translateX(0);   }
      }
      @keyframes _l2dSpeakOut2 {
        0%  { opacity:1; transform:scale(1)   translateX(0);   }
        100%{ opacity:0; transform:scale(.82) translateX(6px); }
      }
      @keyframes _l2dCharIn {
        0%   { opacity:0; transform:translateY(-14px) scale(.25); }
        65%  { opacity:1; transform:translateY(3px) scale(1.2); }
        100% { opacity:1; transform:translateY(0) scale(1); }
      }
      @keyframes _l2dCharPop {
        0%   { opacity:0; transform:scale(0) rotate(-20deg); }
        55%  { opacity:1; transform:scale(1.5) rotate(10deg); }
        80%  { transform:scale(.9) rotate(-4deg); }
        100% { opacity:1; transform:scale(1) rotate(0); }
      }
      @keyframes _l2dBubbleFloat {
        0%,100% { transform:translateY(0) rotate(0deg); }
        35%     { transform:translateY(-6px) rotate(.5deg); }
        70%     { transform:translateY(-2px) rotate(-.3deg); }
      }
      @keyframes _l2dBubbleShake {
        0%,100% { transform:translateX(0); }
        15%     { transform:translateX(-10px) rotate(-1.5deg); }
        30%     { transform:translateX(9px) rotate(1.5deg); }
        45%     { transform:translateX(-7px) rotate(-1deg); }
        60%     { transform:translateX(7px) rotate(1deg); }
        75%     { transform:translateX(-4px); }
        90%     { transform:translateX(4px); }
      }
      @keyframes _l2dBubbleBounce {
        0%,100% { transform:scale(1) translateY(0); }
        25%     { transform:scale(1.06) translateY(-5px); }
        50%     { transform:scale(.96) translateY(3px); }
        75%     { transform:scale(1.03) translateY(-2px); }
      }
    `;
  },

  /** 淡出並移除目前泡泡 */
  dismiss() {
    const box = document.getElementById('l2d-speech');
    if (!box || !box.firstChild) return;
    if (box._tid) { clearTimeout(box._tid); box._tid = null; }
    const bubble = box.firstChild;
    bubble.style.animation = '_l2dSpeakOut .35s ease forwards';
    box._tid = setTimeout(() => {
      box.replaceChildren();
      if (this._speechRaf) { cancelAnimationFrame(this._speechRaf); this._speechRaf = null; }
      box._tid = null;
    }, 350);
  },

  /** 答題期間隨機閒話家常（intervalMs 毫秒說一句，stopIdleChat 停止）
   *  職責只管「講話泡泡 + 音效」，動作/表情一律交給 startIdleMotion 負責，
   *  避免兩邊各自觸發 playRandom/playRandomExpr、疊加成同一件事做兩次。
   *  呼叫端請帶跟 startIdleMotion 相同的 intervalMs，讓兩個循環節奏對齊。 */
  startIdleChat(intervalMs = 6000) {
    this.stopIdleChat();
    const fire = () => {
      let idx;
      do { idx = Math.floor(Math.random() * L2D_CHAT_C1.length); }
      while (idx === this._lastChatIdx && L2D_CHAT_C1.length > 1);
      this._lastChatIdx = idx;
      this.speak(L2D_CHAT_C1[idx],  { type: 'info' });
      this.speak2(L2D_CHAT_C2[idx], { type: 'info' });
      // 隨機播放一個 chatSounds 音效
      const snds = L2D_CFG.chatSounds;
      if (snds && snds.length) {
        if (this._chatAudio) { this._chatAudio.pause(); this._chatAudio = null; }
        this._chatAudio = new Audio(snds[Math.floor(Math.random() * snds.length)]);
        this._chatAudio.play().catch(() => {});
      }
      this._idleChatTimer = setTimeout(fire, intervalMs);
    };
    this._idleChatTimer = setTimeout(fire, intervalMs);
  },

  stopIdleChat() {
    if (this._idleChatTimer) { clearTimeout(this._idleChatTimer); this._idleChatTimer = null; }
    if (this._chatAudio) { this._chatAudio.pause(); this._chatAudio.currentTime = 0; this._chatAudio = null; }
  },

  /** 角色二淡出泡泡 */
  dismiss2() {
    const box = document.getElementById('l2d-speech2');
    if (!box || !box.firstChild) return;
    if (box._tid) { clearTimeout(box._tid); box._tid = null; }
    const bubble = box.firstChild;
    bubble.style.animation = '_l2dSpeakOut2 .35s ease forwards';
    box._tid = setTimeout(() => {
      box.replaceChildren();
      if (this._speechRaf2) { cancelAnimationFrame(this._speechRaf2); this._speechRaf2 = null; }
      box._tid = null;
    }, 350);
  },

  /** 同時淡出兩角色泡泡 */
  dismissAll() { this.dismiss(); this.dismiss2(); },

  /** 兩角色輪流對話（intervalMs：每組對話間隔） */
  startDialogue(intervalMs = 9000) {
    this.stopDialogue();
    const next = () => {
      let idx;
      do { idx = Math.floor(Math.random() * L2D_DIALOGUE.length); }
      while (L2D_DIALOGUE.length > 1 && idx === this._lastDlgIdx);
      this._lastDlgIdx = idx;
      const lines = L2D_DIALOGUE[idx];
      const show = (i) => {
        if (i >= lines.length) { this._dialogueTimer = setTimeout(next, intervalMs); return; }
        const { c, t } = lines[i];
        if (c === 1) this.speak(t,  { type: 'info', duration: 2500 });
        else         this.speak2(t, { type: 'info', duration: 2500 });
        this._dialogueTimer = setTimeout(() => show(i + 1), 3200);
      };
      show(0);
    };
    this._dialogueTimer = setTimeout(next, 1500);
  },

  stopDialogue() {
    if (this._dialogueTimer) { clearTimeout(this._dialogueTimer); this._dialogueTimer = null; }
    this.dismissAll();
  },

  /** 等模型 ready 後再 speak（避免泡泡定位在 0,0） */
  speakWhenReady(text, opts = {}, maxWaitMs = 6000) {
    if (this._c1.ready) { this.speak(text, opts); return; }
    const deadline = Date.now() + maxWaitMs;
    const poll = () => {
      if (this._c1.ready) { this.speak(text, opts); return; }
      if (Date.now() < deadline) setTimeout(poll, 250);
    };
    setTimeout(poll, 250);
  },

  /**
   * 在角色旁顯示對話泡泡
   * @param {string} text
   * @param {{ type?: 'info'|'correct'|'wrong'|'celebrate', duration?: number }} opts
   */
  speak(text, { type = 'info', duration } = {}) {
    if (duration === undefined) {
      duration = ['correct', 'wrong', 'celebrate'].includes(type)
        ? L2D_CFG.speechDurationAfter
        : L2D_CFG.speechDurationBefore;
    }
    let box = document.getElementById('l2d-speech');
    if (!box) {
      box = document.createElement('div');
      box.id = 'l2d-speech';
      box.style.cssText = 'position:fixed;z-index:100;pointer-events:none;';
      document.body.appendChild(box);
    }
    if (box._tid) { clearTimeout(box._tid); box._tid = null; }
    if (this._speechRaf) { cancelAnimationFrame(this._speechRaf); this._speechRaf = null; }

    const BORDER = {
      correct:   'rgba(0,255,136,.8)',
      wrong:     'rgba(255,51,85,.8)',
      celebrate: 'rgba(255,214,0,.9)',
      info:      'rgba(0,212,255,.75)',
    }[type] || 'rgba(0,212,255,.75)';

    const GLOW = {
      correct:   'rgba(0,255,136,.35)',
      wrong:     'rgba(255,51,85,.3)',
      celebrate: 'rgba(255,214,0,.35)',
      info:      'rgba(0,212,255,.25)',
    }[type] || 'rgba(0,212,255,.25)';

    // 外殼（承載 spring 彈跳動畫）
    const bubble = document.createElement('div');
    bubble.style.cssText =
      'position:relative;transform-origin:left center;' +
      'animation:_l2dSpeakIn .5s cubic-bezier(.34,1.56,.64,1) both;';

    // 三角箭頭（指向左側角色）
    const tail = document.createElement('div');
    tail.style.cssText =
      `position:absolute;left:-9px;top:50%;transform:translateY(-50%);` +
      `width:0;height:0;` +
      `border-top:9px solid transparent;border-bottom:9px solid transparent;` +
      `border-right:9px solid ${BORDER};filter:drop-shadow(-2px 0 4px ${GLOW});`;

    // 氣泡本體（玻璃質感）
    const body = document.createElement('div');
    body.style.cssText =
      `background:rgba(4,10,22,.9);` +
      `backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);` +
      `border:2px solid ${BORDER};border-radius:14px;` +
      `padding:12px 20px;` +
      `color:#f5f5f5;` +
      `font-family:system-ui,-apple-system,'Microsoft JhengHei',sans-serif;` +
      `font-size:18px;font-weight:700;letter-spacing:.4px;line-height:1.5;` +
      `box-shadow:0 0 28px ${GLOW},0 0 8px ${GLOW},inset 0 1px 0 rgba(255,255,255,.1);` +
      `text-shadow:0 0 14px ${GLOW},0 1px 4px rgba(0,0,0,.9);` +
      `white-space:normal;word-break:keep-all;`;
    // 逐字彈入動畫
    const _esc = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    const charAnim = (type === 'correct' || type === 'celebrate') ? '_l2dCharPop' : '_l2dCharIn';
    body.style.transformOrigin = 'center';
    body.innerHTML = [...text].map((ch, i) =>
      `<span style="display:inline-block;opacity:0;will-change:transform;animation:${charAnim} .45s cubic-bezier(.34,1.56,.64,1) ${i * 52}ms forwards">${ch === ' ' ? '&nbsp;' : _esc(ch)}</span>`
    ).join('');

    bubble.append(tail, body);
    box.replaceChildren(bubble);

    // 所有字出齊後啟動泡泡持續動畫
    const postDelay = Math.max(600, text.length * 52 + 460);
    setTimeout(() => {
      if (!box.firstChild) return;
      if (type === 'wrong') {
        bubble.style.animation = '_l2dBubbleShake .75s cubic-bezier(.36,.07,.19,.97)';
        setTimeout(() => { if (box.firstChild) body.style.animation = '_l2dBubbleFloat 3.5s ease-in-out infinite'; }, 780);
      } else if (type === 'correct' || type === 'celebrate') {
        body.style.animation = '_l2dBubbleBounce .9s ease-in-out 3';
        setTimeout(() => { if (box.firstChild) body.style.animation = '_l2dBubbleFloat 3.5s ease-in-out infinite'; }, 2700);
      } else {
        body.style.animation = '_l2dBubbleFloat 3.5s ease-in-out infinite';
      }
    }, postDelay);

    // RAF 持續追蹤角色 1 頭部，泡泡存在期間每幀更新位置
    const tick = () => {
      this._updateSpeechPos();
      if (box.firstChild) this._speechRaf = requestAnimationFrame(tick);
    };
    tick();

    box._tid = setTimeout(() => {
      bubble.style.animation = '_l2dSpeakOut .45s ease forwards';
      box._tid = setTimeout(() => {
        box.replaceChildren();
        if (this._speechRaf) { cancelAnimationFrame(this._speechRaf); this._speechRaf = null; }
      }, 450);
    }, duration);
  },

  /** 角色二旁顯示對話泡泡（尾巴朝右，泡泡在左） */
  speak2(text, { type = 'info', duration } = {}) {
    if (duration === undefined) {
      duration = ['correct', 'wrong', 'celebrate'].includes(type)
        ? L2D_CFG.speechDurationAfter
        : L2D_CFG.speechDurationBefore;
    }
    let box = document.getElementById('l2d-speech2');
    if (!box) {
      box = document.createElement('div');
      box.id = 'l2d-speech2';
      box.style.cssText = 'position:fixed;z-index:100;pointer-events:none;';
      document.body.appendChild(box);
    }
    if (box._tid) { clearTimeout(box._tid); box._tid = null; }
    if (this._speechRaf2) { cancelAnimationFrame(this._speechRaf2); this._speechRaf2 = null; }

    const BORDER = {
      correct:   'rgba(0,255,136,.8)',
      wrong:     'rgba(255,51,85,.8)',
      celebrate: 'rgba(255,214,0,.9)',
      info:      'rgba(255,140,0,.75)',
    }[type] || 'rgba(255,140,0,.75)';

    const GLOW = {
      correct:   'rgba(0,255,136,.35)',
      wrong:     'rgba(255,51,85,.3)',
      celebrate: 'rgba(255,214,0,.35)',
      info:      'rgba(255,140,0,.25)',
    }[type] || 'rgba(255,140,0,.25)';

    const bubble = document.createElement('div');
    bubble.style.cssText =
      'position:relative;transform-origin:right center;' +
      'animation:_l2dSpeakIn2 .5s cubic-bezier(.34,1.56,.64,1) both;';

    const tail = document.createElement('div');
    tail.style.cssText =
      `position:absolute;right:-9px;top:50%;transform:translateY(-50%);` +
      `width:0;height:0;` +
      `border-top:9px solid transparent;border-bottom:9px solid transparent;` +
      `border-left:9px solid ${BORDER};filter:drop-shadow(2px 0 4px ${GLOW});`;

    const body = document.createElement('div');
    body.style.cssText =
      `background:rgba(4,10,22,.9);` +
      `backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);` +
      `border:2px solid ${BORDER};border-radius:14px;` +
      `padding:12px 20px;` +
      `color:#f5f5f5;` +
      `font-family:system-ui,-apple-system,'Microsoft JhengHei',sans-serif;` +
      `font-size:18px;font-weight:700;letter-spacing:.4px;line-height:1.5;` +
      `box-shadow:0 0 28px ${GLOW},0 0 8px ${GLOW},inset 0 1px 0 rgba(255,255,255,.1);` +
      `text-shadow:0 0 14px ${GLOW},0 1px 4px rgba(0,0,0,.9);` +
      `white-space:normal;word-break:keep-all;`;
    // 逐字彈入動畫
    const _esc2 = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    const charAnim2 = (type === 'correct' || type === 'celebrate') ? '_l2dCharPop' : '_l2dCharIn';
    body.style.transformOrigin = 'center';
    body.innerHTML = [...text].map((ch, i) =>
      `<span style="display:inline-block;opacity:0;will-change:transform;animation:${charAnim2} .45s cubic-bezier(.34,1.56,.64,1) ${i * 52}ms forwards">${ch === ' ' ? '&nbsp;' : _esc2(ch)}</span>`
    ).join('');

    bubble.append(body, tail);
    box.replaceChildren(bubble);

    // 所有字出齊後啟動泡泡持續動畫
    const postDelay2 = Math.max(600, text.length * 52 + 460);
    setTimeout(() => {
      if (!box.firstChild) return;
      if (type === 'wrong') {
        bubble.style.animation = '_l2dBubbleShake .75s cubic-bezier(.36,.07,.19,.97)';
        setTimeout(() => { if (box.firstChild) body.style.animation = '_l2dBubbleFloat 3.5s ease-in-out infinite'; }, 780);
      } else if (type === 'correct' || type === 'celebrate') {
        body.style.animation = '_l2dBubbleBounce .9s ease-in-out 3';
        setTimeout(() => { if (box.firstChild) body.style.animation = '_l2dBubbleFloat 3.5s ease-in-out infinite'; }, 2700);
      } else {
        body.style.animation = '_l2dBubbleFloat 3.5s ease-in-out infinite';
      }
    }, postDelay2);

    const tick = () => {
      this._updateSpeechPos2();
      if (box.firstChild) this._speechRaf2 = requestAnimationFrame(tick);
    };
    tick();

    box._tid = setTimeout(() => {
      bubble.style.animation = '_l2dSpeakOut2 .45s ease forwards';
      box._tid = setTimeout(() => {
        box.replaceChildren();
        if (this._speechRaf2) { cancelAnimationFrame(this._speechRaf2); this._speechRaf2 = null; }
      }, 450);
    }, duration);
  },
};
