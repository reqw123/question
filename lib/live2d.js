'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// 換模型只需改 char1.manifestId 或 char2.manifestId（對應 live2d_my_like/config/manifest.json
// 裡的 id），路徑由 L2D.init() 動態解析；若要暫時蓋掉 manifest 的結果，直接設 char1.model /
// char2.model 字串即可（host.html / player.html / desktop-pet 的角色選單即是用這個 override）。
//
// 每個模型畫布裡的留白、頭部相對位置都不一樣，同一組 offsetX/offsetY/scale/headRatio/
// headXRatio 套到不同模型上容易錯位，所以這五個欄位可以改成「跟著模型走」而不是「跟著槽位
// 走」：在 manifest.json 對應的模型項目上加一個 layout 物件（例如
// "layout": { "offsetX": 0, "offsetY": 0, "scale": 0.7, "headRatio": 0.25, "headXRatio": 0.5 }），
// L2D.init() 載入該模型時會自動把這幾個值蓋到槽位的 cfg 上（沒寫的欄位維持槽位原本的值）。
// 用瀏覽器 console 呼叫 L2D.printPos() 可以印出目前這五個值，微調好之後貼回 manifest.json。
//
// 同樣道理，如果某個模型有貼圖修不掉、只能靠調整 Part 透明度處理的殘留物（或多套材質
// 各自需要不同的 Part 顯隱組合，見 live2d_my_like/config/076-納茲.md 第六節），在
// manifest.json 該模型項目加一個 partOverrides 物件（key＝Part ID，value＝要設定的透明度
// 0~1，例如 "partOverrides": { "Part6": 0, "Part8": 0.5 }），L2D.init() 載入完該模型後
// 會自動把物件裡每個 Part 的透明度設成指定值。value 是空字串 "" 代表「這個 Part 不覆蓋、
// 維持原樣」——跟上面 layout 五個欄位同一套空字串＝未設定的慣例，方便之後如果做編輯介面、
// 清空某格但沒刪 key 時不會誤套用成 0。刻意不寫死在程式碼裡（例如直接在 _load() 裡固定
// 呼叫 setPartOpacityById）——那樣任何模型只要剛好有同名 Part 都會被一起改掉，沒辦法限定
// 只影響特定模型；放進 manifest.json 才能保證只有清單裡指定的那個模型會受影響。
//
// Parameter（驅動變形的連續數值，例如 ParamAngleX、Param17）跟 Part（整組 Drawable 的
// 透明度開關）是 Cubism 裡兩種獨立資料結構，所以另外有一個 paramOverrides 物件（key＝
// Parameter ID，value＝要設定的數值，例如 "paramOverrides": { "ParamAngleX": 15 }），
// 套用時機、空字串＝維持原樣、只影響指定模型這幾條規則都跟 partOverrides 一模一樣，
// 差別只在呼叫的 API（setParameterValueById／Cubism 2 的 setParamFloat）跟比對用的
// ID 清單來源不同。
// ══════════════════════════════════════════════════════════════════════════════
const L2D_CFG = {
  // manifest.json 路徑（見 live2d_my_like/config/manifest.json）
  manifestUrl: '../live2d_my_like/config/manifest.json',
  // 重要設定：實際載入幾個角色的總開關，範圍 1~4（對應下面 char1~char4 這四組設定）。
  // L2D.init() 的 allSlots.slice(0, maxChars) 會依這個數字裁切，多於這個數字的 charN
  // 設定就算 enabled 也不會載入。host.html/player.html 這裡維持預設 2（雙人搶答遊戲），
  // 各自另有「角色數」選單可以覆蓋成 3/4（見 host.html/player.html 的 char-count-select）；
  // desktop-pet 則直接設成 Infinity，讓它自動吃掉這裡定義的所有角色。
  maxChars: 2,
  // ── 角色一（左側）────────────────────────────────────────────────────────
  char1: {
    enabled:  true,    // false → 不載入角色一
    // 修正：原本這裡寫 2，跟自己的註解對不上（會解析成 id:2 露西，跟 char2 撞成同一個模型）。
    // c1/c2 是 speak()/speak2()、startIdleChat()/startDialogue() 寫死綁定的兩個角色，對話台詞
    // （L2D_CHAT_C1/C2、L2D_DIALOGUE）是照納茲/露西的人設寫的，manifestId 對不對直接影響
    // 「講話的是不是那個人設」，所以修正；c3/c4 沒有接這套對話系統，同樣的問題先不動。
    manifestId: 1,     // 對應 manifest.json 裡 id:1（models/076/c_7001.model3.json，納茲）
    width:    '30vw',    // 佔畫面寬度百分比（vw）或像素（px）
    maxWidth: '500px',   // 最大寬度上限
    scale:     0.7,     // 模型本體大小（1.0 = 填滿欄位寬）
    offsetX:  270,      // 水平微調（host 頁面）正 → 右；負 → 左
    offsetY:  86,      // 垂直微調（host 頁面）正 → 下；負 → 上
    rotation:  0,      // 旋轉角度（度數，正 → 順時針；負 → 逆時針）
    headRatio:  0.1,   // 泡泡 Y：頭部距  模型頂端比例（0=頂；調大往下移）
    headXRatio: 0.65,  // 泡泡 X：距模型左緣比例（0.5=中心；調大往右移）
    // 泡泡生長方向：跟 side（畫面位置）是兩件事——side 決定角色站在畫面哪裡，
    // bubbleGrow 決定泡泡往哪邊長。'right' = 泡泡靠左錨定、向右長（尾巴朝左）。
    bubbleGrow: 'right',
    // 泡泡的識別色（框線/發光/尾巴/文字都跟著這組 RGB 走，見 speakFor()），跟角色「是誰」
    // 綁在一起，不是跟 bubbleGrow（泡泡往哪邊長，純粹是版面方向）綁在一起——桌寵的情境
    // 編輯器可以讓使用者自己切換 bubbleGrow 方向，如果顏色也綁在 bubbleGrow 上，兩個角色
    // 剛好切成同一個方向時顏色就會撞在一起，分不出是誰在講話。青色。
    bubbleColor: '0,212,255',
  },
  // ── 角色二（左側第二欄，緊靠角色一右側）────────────────────────────────
  char2: {
    enabled:  true,    // false → 不載入角色二
    manifestId: 2,     // 對應 manifest.json 裡 id:2（models/077/c_7002.model3.json，露西）
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
    // 'left' = 泡泡靠右錨定、向左長（尾巴朝右）——跟 char1 相反方向，
    // 兩人泡泡才不會疊在一起長到對方臉上
    bubbleGrow: 'left',
    bubbleColor: '255,140,0', // 橙色，跟角色一的青色明顯區分
  },
  // ── 角色三（左側第三欄）──────────────────────────────────────────────────
  char3: {
    enabled:  true,
    manifestId: 1,     // 對應 manifest.json 裡 id:3（models/1009109/1009109.model3.json）
                        // 這個模型是 SCREAMING_SNAKE_CASE 參數命名、有完整手臂/肩膀骨架，
                        // 跟 multi/L2DGesturePlayer.js 的 GESTURES 字典相容（納茲/露西沒有這些參數）
    width:    '30vw',
    maxWidth: '500px',
    scale:      0.7,
    offsetX:    0,       // 未調整，載入後用 L2D.printPos() 手動微調
    offsetY:    0,
    rotation:   0,
    side:       'left',
    colIndex:   2,
    headRatio:  0.25,
    headXRatio: 0.5,
    bubbleGrow: 'right',
    bubbleColor: '190,120,255', // 紫色，三/四人模式時跟角色一/二再拉開區分
  },
  // ── 角色四（左側第四欄）──────────────────────────────────────────────────
  char4: {
    enabled:  true,
    manifestId: 2,     // 對應 manifest.json 裡 id:4（models/1014107/1014107.model3.json），理由同 char3
    width:    '30vw',
    maxWidth: '500px',
    scale:      0.8,
    offsetX:    -120,       // 未調整，載入後用 L2D.printPos() 手動微調
    offsetY:    0,
    rotation:   0,
    side:       'left',
    colIndex:   3,
    headRatio:  0.25,
    headXRatio: 0.5,
    bubbleGrow: 'left',
    bubbleColor: '255,110,190', // 粉色
  },
  // ── 文字泡泡顯示時間 ──────────────────────────────────────────────────────
  speechDurationBefore: 3000,  // 答題前泡泡顯示時間 ms（type:'info'）
  speechDurationAfter:  2000,  // 答題後泡泡顯示時間 ms（type:'correct'/'wrong'/'celebrate'，比答題前少一秒）
  // ── 閒話家常隨機音效（與文字泡泡同步播放，留空陣列即靜音）────────────────
  // 保留理由：manifest.json 每個模型可以自己填 chatSounds 專屬音效，但目前只有 home_cat
  // 填了，其他角色（含 char1/char2 預設的納茲/露西）都還是空的——這組全域池是它們的保底，
  // 拿掉會讓還沒補音效的角色答題閒置時直接靜音，等之後陸續補齊模型專屬音效再考慮拿掉。
  chatSounds: [
    //'../特定角色語音/zc1y2-bculs.mp3',
    //'../live2d-master/live2d-master/model/Violet/sound/tap_Lhand.mp3',
   // '../live2d-master/live2d-master/model/Violet/sound/tap_Rhand.mp3',
   // '../live2d-master/live2d-master/model/Violet/sound/tap_body.mp3',
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
    char2: { offsetX:  -354, offsetY:  70,  rotation: 0 },
    char3: { offsetX:  0,     offsetY: 0,   rotation: 0 },   // 未調整，載入後手動微調
    char4: { offsetX:  0,     offsetY: 0,   rotation: 0 },
  },
  // ── VFX 特效模式 ─────────────────────────────────────────────────────────
  // 'full' = 完整版（MagicShotVFX.js）| 'simple' = 備用版 | 'off' = 停用
  // 手機自動停用：/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'off' : 'full'
  vfxMode: 'simple',
  // ── 答題手勢（L2DGesturePlayer）套用範圍 ────────────────────────────────
  // null = 目前啟用的角色都動 | 'c1'~'c4' 只讓該角色動
  answerGestureChar: null,
  // ── MagicShotVFX（vfxMode:'simple' 時，multi/MagicShotVFX_simple.js 讀這個）─
  // 決定連擊魔法球特效從哪個角色身上發射，跟 answerGestureChar 是同一套慣例：
  // null = 目前每個啟用且 ready 的角色各自發射一整套連擊，同時進行
  // 'c1'~'c4' = 固定只從指定角色發射（該角色還沒 ready 時退回第一個 ready 的角色）
  vfxFireFrom: null,
  // ── 手機端專屬設定（player.html 套用，可獨立調整）───────────────────────
  mobile: {
    char1: { scale: 2.2, width: '20vw', side: 'center', offsetX:5, offsetY: 60,
             rotation: 0, headRatio: 0.13, headXRatio: 0.48 },
    char2: { scale: 2.2, width: '20vw', side: 'center', offsetX: 20, offsetY: 80,
             rotation: 0 },
    char3: { scale: 2.2, width: '20vw', side: 'center', offsetX: 0, offsetY: 0,
             rotation: 0 },   // 未調整，載入後手動微調
    char4: { scale: 1.8, width: '20vw', side: 'center', offsetX: 0, offsetY: 0,
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

// 每個角色的執行期狀態物件用同一個工廠函式產生（避免 4 份手寫字面量互相漂移）。
// key/cfg 兩個欄位在 _load() 裡才會真正填值（工廠函式建立當下還不知道要對應哪個 cfg），
// 存在 state 本身上之後，_fit()/_onResize()/printPos() 等泛型函式都能直接讀
// state.key/state.cfg，不用各自重新用字串拼接 L2D_CFG['char' + key.slice(1)]。
// seqIdx（c1 專用的輪流播放游標）/queue+lastName（c2~c4 用的洗牌佇列防重複）
// 原本是散落在 L2D 頂層的 _c1SeqIdx/_c2Queue/_c1LastName/_c2LastName，
// 收進 state 物件本身之後 c3/c4 自動就有一份，不用再手動新增對應的頂層變數。
function _mkCharState() {
  return { model: null, gMap: {}, expList: [], expQueue: [], lastExpIdx: -1, ready: false,
           seqIdx: -1, queue: [], lastName: null, key: null, cfg: null };
}

const L2D = {
  app: null,
  // setTopLayer() 用：canvas / 對話泡泡的預設層級 vs 拉到最上層時的層級
  _Z_CANVAS: 5,
  _Z_BUBBLE: 100,
  _Z_TOP:    150,   // 高於 multi/player.html 的 .screen（z-index:110），join 畫面才會被角色蓋過去
  _zBoosted: false,
  _c1: _mkCharState(),
  _c2: _mkCharState(),
  _c3: _mkCharState(),
  _c4: _mkCharState(),
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
  _speechRaf3:  null,
  _speechRaf4:  null,
  _dialogueTimer: null,
  _lastDlgIdx:    -1,

  // ── 公開 API ──────────────────────────────────────────────────────────────

  async init() {
    this._applyCSS();
    if (!this._checkDeps()) return;

    // ── manifest.json 動態解析：把 slots 需要的 model 路徑補上（若消費端已透過
    // char1.model / char2.model 設定 override，manifest 的結果不會蓋掉它）──────
    const manifest = await fetch(L2D_CFG.manifestUrl, { cache: 'no-store' }).then(r => r.json()).catch(err => {
      console.error('[L2D] manifest.json 讀取失敗，Live2D 角色無法載入:', err);
      return [];
    });
    const byId   = Object.fromEntries(manifest.map(e => [e.id, e]));
    const byPath = Object.fromEntries(manifest.map(e => [e.path, e]));

    const allSlots = ['c1', 'c2', 'c3', 'c4']
      .map(key => {
        const cfg = L2D_CFG['char' + key.slice(1)];
        return cfg ? { key, cfg, side: cfg.side || 'left' } : null;
      })
      .filter(Boolean);
    const cap   = L2D_CFG.maxChars ?? 2;
    const slots = allSlots.slice(0, cap);
    if (allSlots.length > cap) {
      console.warn(`[L2D] slots(${allSlots.length}) 超過 maxChars(${cap})，只載入前 ${cap} 個`);
    }
    // 之後所有泛型方法（playRandom/speak/_fit/_onResize/printPos...）共用的
    // 「目前真正啟用哪幾個角色」清單，是整個多角色系統的中樞
    this._activeSlotKeys = slots.map(s => s.key);
    for (const { key, cfg } of slots) {
      if (cfg.model) {
        // 已有 override（host.html/player.html 的角色選單、desktop-pet 的模型挑選器都是直接
        // 設 cfg.model，不會更新 cfg.manifestId），manifest 解析結果不蓋掉 model 路徑，
        // 但改用路徑反查對應的 manifest entry，把該模型的 layout 微調值套進來——
        // 不然換模型只換了外觀，offsetX/offsetY/scale/headRatio/headXRatio 還是沿用舊模型的值，
        // 那組數字通常對不上新模型的比例，看起來就會錯位（見 layout 欄位說明）。
        const rel   = cfg.model.replace(/^.*live2d_my_like\//, '');
        const entry = byPath[rel];
        if (entry) {
          this._mergeLayout(cfg, entry.layout);
          this._mergeChatSounds(cfg, entry.chatSounds);
          this._mergePartOverrides(cfg, entry.partOverrides);
          this._mergeParamOverrides(cfg, entry.paramOverrides);
        }
        continue;
      }
      const entry = byId[cfg.manifestId];
      if (!entry) {
        console.warn(`[L2D] "${key}" 的 manifestId=${cfg.manifestId} 在 manifest.json 中不存在，已跳過`);
        continue;
      }
      cfg.model = '../live2d_my_like/' + entry.path;
      this._mergeLayout(cfg, entry.layout);
      this._mergeChatSounds(cfg, entry.chatSounds);
      this._mergePartOverrides(cfg, entry.partOverrides);
      this._mergeParamOverrides(cfg, entry.paramOverrides);
    }

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
                       `pointer-events:none;z-index:${this._zBoosted ? this._Z_TOP : this._Z_CANVAS};`;
    document.body.appendChild(cv);
    this._initDragButtons();

    // 依序載入，避免 pixi-live2d-display 初始化競爭（只載入 maxChars 裁切後的 slots）
    for (const { key, cfg, side } of slots) {
      await this._load(key, cfg, side);
    }

    if (this._activeSlotKeys.some(k => this['_' + k].ready)) {
      document.body.classList.add('l2d-ready');
      console.log('[L2D] ✓ ready  ' + this._activeSlotKeys.map(k => k + '=' + this['_' + k].ready).join('  '));
      setTimeout(() => this.printPos(), 300);
    }
    // 防抖 150 ms：連發 resize 事件只執行最後一次，防止頻繁 _fit() 破壞渲染
    let _resizeTid = null;
    window.addEventListener('resize', () => {
      clearTimeout(_resizeTid);
      _resizeTid = setTimeout(() => this._onResize(), 150);
    });
  },

  /** 把角色 canvas + 對話泡泡的層級拉到最上層（on=true，高於 .screen），或恢復預設層級
   *  （on=false，canvas z-index:5、泡泡 z-index:100）。給 player.html 在手機端「加入遊戲前」
   *  讓角色蓋在 join 畫面之上、加入後恢復原本層級（角色退到遊戲 UI 之後）用。 */
  setTopLayer(on) {
    this._zBoosted = !!on;
    if (this.app?.view) this.app.view.style.zIndex = String(on ? this._Z_TOP : this._Z_CANVAS);
    ['l2d-speech', 'l2d-speech2', 'l2d-speech3', 'l2d-speech4'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.zIndex = String(on ? this._Z_TOP : this._Z_BUBBLE);
    });
  },

  /** 播放一個動作，套用到目前所有啟用角色 */
  play(name, delayMs = 0) {
    this._activeSlotKeys.forEach(k => this._go(this['_' + k], name, delayMs));
  },

  /** 角色隨機動作：c1 依序輪流播放（不是隨機洗牌），其他角色洗牌輪播。
   *  這個不對稱是刻意保留、不統一——c1（納茲/076）目前掛的是固定的「idle → skill」
   *  兩顆動作，用依序輪流才可預期、可控制何時觸發技能；c1 本身不比對其他角色（維持現狀）。
   *  其他角色的洗牌輪播會跟「目前所有其他啟用角色」剛播放的動作名稱比對，撞名就把
   *  佇列頂端往後挪一位，避免兩人（或更多人）同時做出一樣的動作。 */
  playRandom(key, delayMs = 0, exclude = []) {
    const run = () => {
      const s = this['_' + key];
      if (!s.ready || !s.model) return;
      const all = [];
      Object.entries(s.gMap).forEach(([group, names]) => {
        if (!exclude.includes(group))
          names.forEach((name, idx) => all.push({ group, idx, name }));
      });
      if (!all.length) return;

      let group, idx, name;
      if (key === 'c1') {
        s.seqIdx = (s.seqIdx + 1) % all.length;
        ({ group, idx, name } = all[s.seqIdx]);
      } else {
        if (!s.queue.length) {
          s.queue = [...all].sort(() => Math.random() - 0.5);
          const last = s.queue.length - 1;
          if (last > 0 && s.queue[last].name === s.lastName)
            [s.queue[last], s.queue[last - 1]] = [s.queue[last - 1], s.queue[last]];
        }
        const others = this._activeSlotKeys.filter(k => k !== key).map(k => this['_' + k].lastName);
        if (s.queue.length >= 2 && others.includes(s.queue[s.queue.length - 1].name))
          [s.queue[s.queue.length - 1], s.queue[s.queue.length - 2]] =
          [s.queue[s.queue.length - 2], s.queue[s.queue.length - 1]];
        ({ group, idx, name } = s.queue.pop());
      }
      s.lastName = name;
      Promise.resolve(s.model.motion(group, idx, 3)).catch(() => {});
      this._showMotionLabel(key + ':' + name);
    };
    delayMs > 0 ? setTimeout(run, delayMs) : run();
  },
  playRandom1(delayMs = 0, exclude = []) { this.playRandom('c1', delayMs, exclude); },
  playRandom2(delayMs = 0, exclude = []) { this.playRandom('c2', delayMs, exclude); },

  /** 自動循環動作＋表情（動作所有啟用角色同步播放；表情仍交錯播放，避免同步感）
   *  職責是唯一負責觸發動作/表情的地方；startIdleChat 只管講話泡泡+音效，不會再重複觸發這裡的東西。 */
  startIdleMotion(intervalMs = 6000) {
    this.stopIdleMotion();
    // 動作循環 — 所有啟用角色同步播放
    const fireMot = () => {
      this._activeSlotKeys.forEach(key => this.playRandom(key));
      this._idleMotionTimer = setTimeout(fireMot, intervalMs);
    };
    fireMot();
    // 表情循環（比動作更頻繁，錯開啟動時間：第一個角色立刻播，之後每個角色再疊加
    // 一段隨機 500-900ms 的間隔，跟原本兩角色版「c2 比 c1 晚 500-1400ms」是同一套邏輯）
    const exprMs = Math.max(3500, Math.round(intervalMs * 0.55));
    const fireExpr = () => {
      let stagger = 0;
      this._activeSlotKeys.forEach((key, i) => {
        if (i === 0) { this.playRandomExpr(key); return; }
        stagger += 500 + Math.floor(Math.random() * 900);
        setTimeout(() => this.playRandomExpr(key), stagger);
      });
      this._exprTimer = setTimeout(fireExpr, exprMs);
    };
    setTimeout(() => fireExpr(), 2000);
  },

  stopIdleMotion() {
    if (this._idleMotionTimer) { clearTimeout(this._idleMotionTimer); this._idleMotionTimer = null; }
    if (this._exprTimer)       { clearTimeout(this._exprTimer);       this._exprTimer = null; }
  },

  /**
   * 依遊戲結果播放情緒動作（所有啟用角色同步）
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
    const keysArr = map[type] || map.info;
    const activeKeys = this._activeSlotKeys;
    // 每個角色盡量各選不同 key（keysArr 長度不夠涵蓋所有啟用角色時才允許重複）
    const picked = [];
    activeKeys.forEach(() => {
      let idx;
      if (keysArr.length > picked.length) {
        do { idx = Math.floor(Math.random() * keysArr.length); } while (picked.includes(idx));
      } else {
        idx = Math.floor(Math.random() * keysArr.length);
      }
      picked.push(idx);
    });

    const tryMotion = (state, key, fallbackFn) => {
      if (!state.ready || !state.model) return;
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
    activeKeys.forEach((k, i) => {
      tryMotion(this['_' + k], keysArr[picked[i]], () => this.playRandom(k));
    });

    // 情緒動作結束後強制回到中立姿態，清除殘留的手臂/手指位置
    clearTimeout(this._emotionResetTimer);
    this._emotionResetTimer = setTimeout(() => {
      activeKeys.forEach(k => this._go(this['_' + k], 'wait', 0));
    }, 2400);
  },

  // ── 內部 ──────────────────────────────────────────────────────────────────

  // manifest entry 上的 layout（可選）：{ offsetX, offsetY, scale, headRatio, headXRatio }
  // 是「這個模型自己」的微調值，跟 cfg 原本的槽位預設值（width/side/colIndex 等版面設定）
  // 疊在一起。generate-manifest.js 幫還沒調過的模型佔位時，每個欄位都填空字串（不是 0 或
  // null——0 對 offsetX/scale 是合法的真實值，沒辦法當「還沒填」的記號），這裡合併時要把
  // 空字串當「還沒填」跳過，只套用真的填了值的欄位，沒寫的沿用槽位預設。
  // 拆成獨立方法（不是 init() 裡的區域函式）是因為 _load() 載入失敗要退回預設模型時
  // 也要用同一套合併邏輯，兩處共用同一份實作。
  _mergeLayout(cfg, layout) {
    if (!layout) return;
    for (const [k, v] of Object.entries(layout)) {
      if (v !== '' && v !== undefined && v !== null) cfg[k] = v;
    }
  },

  // manifest entry 上的 chatSounds（可選，字串陣列）：這個模型自己專屬的閒話音效池，
  // 跟 layout 同一套「模型帶著走」的精神——換模型時聲音跟著換，不用回頭改 L2D_CFG。
  // 陣列裡的空字串（還沒填的佔位）一律跳過；整個陣列過濾完是空的就不套用 cfg.chatSounds，
  // 讓 startIdleChat() 那邊退回 L2D_CFG.chatSounds 這個全域預設池。
  _mergeChatSounds(cfg, chatSounds) {
    if (!Array.isArray(chatSounds)) return;
    const real = chatSounds.filter(s => s !== '' && s != null);
    if (real.length) cfg.chatSounds = real;
  },

  // manifest entry 上的 partOverrides（可選，物件，key＝Part ID、value＝透明度 0~1）：
  // 這個模型專屬「載入時套用」的 Part 透明度覆蓋值，只作用在這個模型身上，見檔案開頭的說明。
  // value 是空字串 "" 的 key 一律跳過（＝未設定，維持原樣），跟 layout 同一套慣例。
  _mergePartOverrides(cfg, partOverrides) {
    if (!partOverrides || typeof partOverrides !== 'object') return;
    const real = {};
    let hasReal = false;
    for (const [id, v] of Object.entries(partOverrides)) {
      if (v === '' || v == null) continue;
      real[id] = v;
      hasReal = true;
    }
    if (hasReal) cfg.partOverrides = real;
  },

  // manifest entry 上的 paramOverrides（可選，物件，key＝Parameter ID、value＝要設定的
  // 數值）：這個模型專屬「載入時套用」的 Parameter 覆蓋值，只作用在這個模型身上，見檔案
  // 開頭的說明。value 是空字串 "" 的 key 一律跳過（＝未設定，維持原樣），跟 partOverrides/
  // layout 同一套慣例。邏輯上跟 _mergePartOverrides 是同一套，分開寫只是因為兩者是獨立
  // 欄位、獨立語意，混在一起反而讓人搞不清楚哪個 key 是 Part、哪個是 Parameter。
  _mergeParamOverrides(cfg, paramOverrides) {
    if (!paramOverrides || typeof paramOverrides !== 'object') return;
    const real = {};
    let hasReal = false;
    for (const [id, v] of Object.entries(paramOverrides)) {
      if (v === '' || v == null) continue;
      real[id] = v;
      hasReal = true;
    }
    if (hasReal) cfg.paramOverrides = real;
  },

  _checkDeps() {
    const hasC2 = typeof Live2D !== 'undefined';
    const hasC4 = typeof Live2DCubismCore !== 'undefined';
    if (!hasC2 && !hasC4) { console.error('[L2D] 缺少 Cubism Core（live2d.min.js 或 live2dcubismcore.min.js）'); return false; }
    if (typeof PIXI === 'undefined')   { console.error('[L2D] 缺少 pixi.min.js');        return false; }
    if (!PIXI.live2d?.Live2DModel)     { console.error('[L2D] 缺少 cubism-all.min.js');   return false; }
    console.log('[L2D] deps OK — PIXI', PIXI.VERSION, ' Cubism2=' + hasC2 + ' Cubism4=' + hasC4);
    return true;
  },

  // 保護機制：某個角色的模型路徑讀取失敗時（資料夾被刪掉、路徑打錯、暫時性網路問題），
  // 只有「這個角色」不顯示，不做任何替換／退回其他模型——換成別的模型只是換一種方式壞掉
  // （版面對不上、對話台詞人設不對、使用者也搞不清楚自己看到的是誰），不如讓它單純消失，
  // 至少狀態清楚。其他已經載入/還沒載入的角色完全不受影響：init() 的載入迴圈本來就是
  // 每個角色各自獨立 try/catch（見下面 _load() 外層），一個失敗不會擋到其他人繼續載入。
  // 這裡只是把 fetch 失敗的判斷做確實（原本 r.ok 是 false 時直接呼叫 .json() 對某些
  // 伺服器可能不會拋錯、會拿到一坨不是模型資料的內容），讓錯誤訊息更清楚好排查。
  async _fetchModelJson(cfg) {
    const r = await fetch(cfg.model);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },

  async _load(key, cfg, side) {
    if (cfg.enabled === false || !cfg.model) return;
    const state = this['_' + key];
    state.key = key;
    state.cfg = cfg;
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
      const modelJson = await this._fetchModelJson(cfg);
      state.expList = this._buildExprList(modelJson);
      state.model   = await PIXI.live2d.Live2DModel.from(cfg.model);
      state.gMap    = this._buildGroupMap(state.model);
      state.expQueue   = [];
      state.lastExpIdx = -1;
      state.visibilitySync = this._attachVisibilitySync(state.model);
      this._applyPartOverrides(state.model, cfg.partOverrides);
      this._applyParamOverrides(state.model, cfg.paramOverrides);
      // ⚠️ 專為特定角色收藏庫模型（furina）加的相容性補丁，見該函式定義處的完整說明
      // 跟 live2d_my_like/config/furina-顯示異常除錯筆記.md——對其他正常模型無副作用。
      this._patchClippingMaskOverflow(state.model);
      console.log('[L2D]', key, '群組:', state.gMap, '表情數:', state.expList.length);
      this.app.stage.addChild(state.model);
      this._fit(state, cfg, side);
      state.ready = true;
      this._go(state, 'wait', 0);
      console.log('[L2D]', key, '✓');
    } catch (err) {
      console.error('[L2D]', key, '載入失敗:', err);
    }
  },

  // ── VISIBLE 參數 → Part 透明度 同步（修補 pixi-live2d-display 的 Cubism 2 缺陷）──────
  // Cubism 2 的 .mtn 動作檔用 `VISIBLE:PARTS_xxx` 這種命名的「Parameter」描述 Part 淡入淡出，
  // 動作播放時這個 Parameter 的數值本身會正確跑，但 pixi-live2d-display 官方只有在
  // model.json 宣告 parts_visible 群組時才會把它接到 setPartsOpacity，而且那套語意是給
  // 「互斥選項淡入淡出」用的（全部歸零時反而會拉回 1），跟我們要的「淡出後保持透明」不合，
  // 所以不能靠 parts_visible 解決。這裡改成每一幀直接把每個 VISIBLE:<PartID> Parameter
  // 的即時值蓋回同名 Part 的透明度，繞過官方那條有問題的路徑。詳細除錯過程見
  // live2d_my_like/Cubism2參數與透明度除錯筆記.md 第五節（`viewer.html` 裡的 attachVisibilitySync 是同一套邏輯，
  // 這裡搬進共用的 lib/live2d.js，host.html/player.html/桌寵都透過 L2D._load() 載入角色，
  // 不用在每個頁面各自複製一份）。Cubism 3/4 模型走官方 setParameterValueById 沒這個坑，
  // 下面的偵測條件只有 Cubism 2 模型才會通過。
  _attachVisibilitySync(model) {
    const cm = model.internalModel && model.internalModel.coreModel;
    if (!cm || typeof cm.getParamIndex !== 'function' || !cm._$5S || !Array.isArray(cm._$5S._$F2)) {
      return null;
    }
    const partsArr = cm._$5S._$F2;
    const mappings = [];
    partsArr.forEach((p, partIdx) => {
      let id;
      try { id = p.getPartsID().id; } catch { return; }
      const paramIdx = cm.getParamIndex('VISIBLE:' + id);
      if (paramIdx >= 0) mappings.push({ paramIdx, partIdx });
    });
    if (!mappings.length) return null;

    const sync = () => {
      mappings.forEach(({ paramIdx, partIdx }) => {
        cm.setPartsOpacity(partIdx, cm.getParamFloat(paramIdx));
      });
    };
    // 優先度必須嚴格夾在 NORMAL(0，pixi-live2d-display 用來跑 model.update() 更新 Parameter
    // 曲線) 和 LOW(-25，PIXI.Application 自己的 render 用這個) 之間：PIXI Ticker 對「相同
    // 優先度」的節點是照註冊順序排在後面，直接用 LOW 會排在 render 後面而不是前面，等於慢一幀
    // 才生效，所以用 LOW+1，確保「更新 Parameter → 同步 Part 透明度 → 渲染」這個順序在同一幀
    // 內嚴格成立（同一個踩雷紀錄見 live2d_my_like/Cubism2參數與透明度除錯筆記.md 第五節陷阱 1）。
    PIXI.Ticker.shared.add(sync, null, PIXI.UPDATE_PRIORITY.LOW + 1);
    return sync;
  },

  // manifest.json 的 partOverrides 物件套用：模型載入完成時，把物件裡每個 Part 的透明度
  // 設成指定值，一次性設定（不是每幀同步），符合「預設值」的語意。Cubism 3/4 用官方
  // setPartOpacityById；Cubism 2 沒有這個 API，改用 setPartsOpacity（同一套 wrapper，
  // 確認過可以直接吃 ID 字串，見 live2d_my_like/config/live2d角色指令說明.md）。value 用
  // Number() 轉型，避免 manifest.json 手動編輯時不小心打成字串（例如 "0"）導致底層 API
  // 吃到非數字。
  //
  // 🚨 為什麼要先手動比對 ID 清單、不能只靠 try/catch：反解 lib/cubism4.min.js 確認過，
  // Cubism 3/4 的 setPartOpacityById(id, v) 內部呼叫 getPartIndex(id)，這個函式**永遠不會
  // 回傳 -1**——找不到對應 Part 時會配一個假索引、寫進一個跟畫面完全無關的幽靈陣列
  // （_notExistPartOpacities），呼叫本身不會 throw、也不會有任何副作用或警告，try/catch
  // 完全抓不到。這跟 live2d_my_like/config/live2d角色指令說明.md 已經記錄過的
  // getParameterIndex() 陷阱是同一套設計，只是這裡是 Part 版本。所以打錯 ID／抄錯模型時，
  // 畫面上什麼事都不會發生，也不會有任何錯誤訊息——必須在呼叫 setPartOpacityById 之前，
  // 自己先跟這個模型真實擁有的 Part ID 清單比對，才抓得到「這個 ID 根本不存在」。
  //
  // ⚠️ 這裡設的值也可能被動作蓋掉：motion3.json 的曲線目標除了 Parameter，也可以是
  // PartOpacity（反解 cubism4.min.js 確認過 CubismMotionCurveTarget 有這三種：Model／
  // Parameter／PartOpacity），如果目前播放的動作剛好對這個 Part 烤了曲線，這裡設的值
  // 一樣會在下一幀被蓋掉，詳見 _applyParamOverrides() 的完整說明。
  _applyPartOverrides(model, partOverrides) {
    if (!partOverrides) return;
    const cm = model.internalModel && model.internalModel.coreModel;
    if (!cm) return;
    const knownIds = this._getPartIds(cm);
    Object.entries(partOverrides).forEach(([id, raw]) => {
      if (raw === '' || raw == null) return;   // 空字串／未設定＝維持原樣，不覆蓋
      const value = Number(raw);
      if (Number.isNaN(value)) {
        console.warn(`[L2D] partOverrides: "${id}" 的值 "${raw}" 不是合法數字，已跳過`);
        return;
      }
      if (knownIds && !knownIds.has(id)) {
        console.warn(`[L2D] partOverrides: 這個模型沒有 Part "${id}"（打錯字或抄錯模型？），` +
          `底層 API 不會報錯但也完全沒效果，已主動跳過。目前這個模型的 Part ID 清單：`, [...knownIds]);
        return;
      }
      try {
        if (typeof cm.setPartOpacityById === 'function') {
          cm.setPartOpacityById(id, value);
        } else if (typeof cm.setPartsOpacity === 'function') {
          cm.setPartsOpacity(id, value);
        } else {
          console.warn(`[L2D] partOverrides: 這個模型的 coreModel 沒有可用的 Part 透明度 API，"${id}" 沒套用`);
        }
      } catch (err) {
        console.warn(`[L2D] partOverrides: 設定 Part "${id}" 失敗`, err);
      }
    });
  },

  // 列出這個模型真實擁有的 Part ID 清單（Set，方便用 .has() 比對）。Cubism 3/4 用
  // getPartCount()+_partIds；Cubism 2 用 _$5S._$F2（見 live2d角色指令說明.md 附錄速查表）。
  // 兩邊都拿不到就回傳 null（呼叫端要把 null 當「沒辦法驗證，別擋」處理，不能當「清單是空的」）。
  _getPartIds(cm) {
    try {
      if (typeof cm.getPartCount === 'function' && cm._partIds) {
        const n = cm.getPartCount();
        return new Set(Array.from({ length: n }, (_, i) => cm._partIds[i]));
      }
      if (cm._$5S && Array.isArray(cm._$5S._$F2)) {
        const arr = cm._$5S._$F2;
        return new Set(arr.map(p => { try { return p.getPartsID().id; } catch { return null; } }).filter(Boolean));
      }
    } catch (err) {
      console.warn('[L2D] partOverrides: 讀取 Part ID 清單失敗，這次跳過驗證', err);
    }
    return null;
  },

  // manifest.json 的 paramOverrides 物件套用：模型載入完成時，把物件裡每個 Parameter 的
  // 數值設成指定值，一次性設定（不是每幀同步——如果目前播放的動作剛好有驅動這個 ID，
  // 下一幀就會被動作曲線蓋掉，見下方註解）。Cubism 3/4 用官方 setParameterValueById；
  // Cubism 2 沒有這個 API，改用 setParamFloat（同一套 wrapper，反解 lib/live2d.min.js
  // 確認過可以直接吃 ID 字串：aa.prototype.setParamFloat 內部一樣是
  // `typeof aH != "number"` 就先轉成 index 再呼叫，跟 setPartsOpacity 同一套設計）。
  //
  // 🚨 陷阱同 partOverrides：setParameterValueById(id, v) 內部呼叫的 getParameterIndex(id)
  // 永遠不會回傳 -1（見 live2d_my_like/config/live2d角色指令說明.md 第一節「陷阱」），
  // 打錯 ID 不會報錯、也不會有任何效果，所以一樣要先跟這個模型真實擁有的 Parameter ID
  // 清單比對過，比對不到才印警告並跳過。
  //
  // ⚠️ **跟 partOverrides 共同的隱藏風險，不是 Part／Parameter 的分野**：反解
  // cubism4.min.js 確認過，motion3.json 的曲線目標（CubismMotionCurveTarget）其實有三種：
  // `Model`、`Parameter`、**`PartOpacity`**——也就是說 Part 透明度**一樣可以**被 motion 曲線
  // 每幀持續驅動，不是只有 Parameter 才會被蓋掉；真正的判斷標準是「目前正在播放的那個
  // motion3.json 裡，有沒有對這個 ID（不管是 Parameter 還是 Part）烤曲線」，不是看它是
  // Parameter 還是 Part。076 這次 Part6/8/9 之所以設完會一直維持，是因為 `c_7001.motion3.json`
  // 剛好沒有對這三個 Part 烤曲線，不是「Part 天生比 Parameter 穩定」——之後任何一個模型，
  // 只要它的動作檔真的有驅動某個 ID，paramOverrides／partOverrides 設的初始值都只在模型
  // 剛載入、動作還沒開始播放前的那一瞬間生效，動作一播放，下一幀就會被曲線蓋掉。
  // 想確認某個 ID 會不會被蓋掉，得實際去看那個模型正在播放的 motion3.json 裡有沒有列到
  // 這個 ID 的曲線，不能靠猜。
  _applyParamOverrides(model, paramOverrides) {
    if (!paramOverrides) return;
    const cm = model.internalModel && model.internalModel.coreModel;
    if (!cm) return;
    const knownIds = this._getParamIds(cm);
    Object.entries(paramOverrides).forEach(([id, raw]) => {
      if (raw === '' || raw == null) return;   // 空字串／未設定＝維持原樣，不覆蓋
      const value = Number(raw);
      if (Number.isNaN(value)) {
        console.warn(`[L2D] paramOverrides: "${id}" 的值 "${raw}" 不是合法數字，已跳過`);
        return;
      }
      if (knownIds && !knownIds.has(id)) {
        console.warn(`[L2D] paramOverrides: 這個模型沒有 Parameter "${id}"（打錯字或抄錯模型？），` +
          `底層 API 不會報錯但也完全沒效果，已主動跳過。目前這個模型的 Parameter ID 清單：`, [...knownIds]);
        return;
      }
      try {
        if (typeof cm.setParameterValueById === 'function') {
          cm.setParameterValueById(id, value);   // Cubism 3/4
        } else if (typeof cm.setParamFloat === 'function') {
          cm.setParamFloat(id, value);            // Cubism 2
        } else {
          console.warn(`[L2D] paramOverrides: 這個模型的 coreModel 沒有可用的 Parameter 設值 API，"${id}" 沒套用`);
        }
      } catch (err) {
        console.warn(`[L2D] paramOverrides: 設定 Parameter "${id}" 失敗`, err);
      }
    });
  },

  // 列出這個模型真實擁有的 Parameter ID 清單（Set）。Cubism 3/4 用 cm._model.parameters.ids；
  // Cubism 2 用 cm._$5S._$pb.map(p => p.id)（見 live2d角色指令說明.md 附錄速查表，已實測
  // 確認過）。兩邊都拿不到就回傳 null（跟 _getPartIds 同一套「別擋」原則）。
  _getParamIds(cm) {
    try {
      if (cm._model && cm._model.parameters && cm._model.parameters.ids) {
        return new Set([...cm._model.parameters.ids]);
      }
      if (cm._$5S && Array.isArray(cm._$5S._$pb)) {
        return new Set(cm._$5S._$pb.map(p => p.id).filter(Boolean));
      }
    } catch (err) {
      console.warn('[L2D] paramOverrides: 讀取 Parameter ID 清單失敗，這次跳過驗證', err);
    }
    return null;
  },

  // ════════════════════════════════════════════════════════════════════════════════
  // ⚠️⚠️⚠️ 特定角色模型相容性補丁 —— 不是通用框架邏輯，是為了讓「furina」這個角色收藏庫
  // 模型能正常顯示才加的。修改/移除前請先看 live2d_my_like/config/furina-顯示異常除錯筆記.md
  // 的完整診斷過程。對其他所有正常模型（裁切遮罩數量沒超標的）完全沒有副作用，可以安心
  // 保留在共用的 lib/live2d.js 裡，不會影響納茲/露西/1009109 等其他角色的渲染行為。
  // ════════════════════════════════════════════════════════════════════════════════
  // 裁切遮罩「超額」防呆 + 更好的色版分配（修補 pixi-live2d-display / Cubism 4 原生
  // 渲染器的邊界情況）────────────────────────────────────────────────────────────
  // Cubism 4 的裁切遮罩系統把所有需要遮罩的 drawable 塞進一張遮罩貼圖的 4 個色版
  // （R/G/B/A），每個色版最多再切 16 塊（原始碼 setupLayoutBounds 裡 t<=16 那個分支），
  // 也就是總量上限 4×16=64。
  //
  // 🚨 官方原始碼的分配方式是「總數平均除以 4」（e=~~(usingClipCount/4)），不是「先填滿
  // 一個色版到 16 再填下一個」。這代表只要 usingClipCount/4 本身就超過 16（例如這次的
  // furina 模型：85 組遮罩 ÷ 4 ≈ 21，每個色版都超標），**全部 4 個色版都會落入「數量
  // 超過上限」的分支**，這個分支只呼叫 Tt("not supported mask count")印警告，完全沒有
  // 迴圈把 drawable 排進色版——不是只有「超出 64 的那一小部分」壞掉，是這個模型全部
  // 85 組遮罩、共 226 個 drawable 全部沒被分配到色版（實測確認）。這些 drawable 的
  // _layoutChannelNo 留著 undefined，之後 setupShaderProgram 拿 undefined 去查
  // getChannelFlagAsColor(undefined)，查到 undefined 再讀 .R 屬性，整段 drawModel()
  // 當場丟出 TypeError，一整個模型從此每一幀渲染都失敗、畫面完全空白，但不會讓
  // Live2DModel.from() 的 Promise reject，狀態看起來像「載入成功」。
  //
  // 這是模型本身遮罩數量超出 Cubism 4 官方硬性上限時的邊界案例（見
  // live2d_my_like/config/furina-顯示異常除錯筆記.md），不是修 lib/all.min.js 本身的
  // bug（官方就是設計成超標時優雅降級），但降級的「優雅」程度可以做得更好——這裡用
  // 兩層修補，故意不改 lib/all.min.js 本身，保留原始檔案，用「執行期補丁」疊加在外面：
  //
  // 1. setupLayoutBounds 整段換成「貪婪填滿」版本：色版 0 先填到 16 個上限，滿了才輪到
  //    色版 1，依此類推，最多 4×16=64 組能拿到真正有效的色版／佈局（跟官方分支邏輯
  //    完全一樣，只是分配策略從「平均分攤、動輒全滅」改成「盡量填滿」）。furina 的 85
  //    組會有 64 組正確顯示，只剩真正超過 64 上限的 21 組維持不準確（比全部 85 組都
  //    不準確好得多）。
  // 2. getChannelFlagAsColor 保留防呆：真正超過 64 上限、拿不到色版的那一小批，
  //    查不到色版時回傳全 0 的假色版，而不是讓呼叫端對 undefined 取屬性炸掉。
  //
  // 只 patch 一次（掛旗標在 prototype 上，同一個 class 的所有模型共用）。對遮罩數量
  // 沒超標的正常模型完全沒有影響——usingClipCount 不到 64 時，貪婪填滿跟原本的平均分攤
  // 對「有沒有拿到色版」這件事結果相同（都是全部分配成功），只是佈局分佈可能不同。
  _patchClippingMaskOverflow(model) {
    const cmgr = model.internalModel?.renderer?._clippingManager;
    if (!cmgr) return;
    const proto = Object.getPrototypeOf(cmgr);
    if (!proto || proto.__l2dClipOverflowPatched) return;
    proto.__l2dClipOverflowPatched = true;

    const originalGetColor = proto.getChannelFlagAsColor;
    proto.getChannelFlagAsColor = function (idx) {
      return originalGetColor.call(this, idx) || { R: 0, G: 0, B: 0, A: 0 };
    };

    const MAX_PER_CHANNEL = 16;
    proto.setupLayoutBounds = function (usingClipCount) {
      const list = this._clippingContextListForMask;
      let s = 0;
      for (let r = 0; r < 4 && s < usingClipCount; r++) {
        const t = Math.min(usingClipCount - s, MAX_PER_CHANNEL);
        if (t === 0) continue;
        if (t === 1) {
          const ctx = list[s++];
          ctx._layoutChannelNo = r;
          ctx._layoutBounds.x = 0; ctx._layoutBounds.y = 0;
          ctx._layoutBounds.width = 1; ctx._layoutBounds.height = 1;
        } else if (t === 2) {
          for (let e = 0; e < t; e++) {
            const col = e % 2;
            const ctx = list[s++];
            ctx._layoutChannelNo = r;
            ctx._layoutBounds.x = 0.5 * col; ctx._layoutBounds.y = 0;
            ctx._layoutBounds.width = 0.5; ctx._layoutBounds.height = 1;
          }
        } else if (t <= 4) {
          for (let e = 0; e < t; e++) {
            const col = e % 2, row = Math.floor(e / 2);
            const ctx = list[s++];
            ctx._layoutChannelNo = r;
            ctx._layoutBounds.x = 0.5 * col; ctx._layoutBounds.y = 0.5 * row;
            ctx._layoutBounds.width = 0.5; ctx._layoutBounds.height = 0.5;
          }
        } else if (t <= 9) {
          for (let e = 0; e < t; e++) {
            const col = e % 3, row = Math.floor(e / 3);
            const ctx = list[s++];
            ctx._layoutChannelNo = r;
            ctx._layoutBounds.x = col / 3; ctx._layoutBounds.y = row / 3;
            ctx._layoutBounds.width = 1 / 3; ctx._layoutBounds.height = 1 / 3;
          }
        } else {
          for (let e = 0; e < t; e++) {
            const col = e % 4, row = Math.floor(e / 4);
            const ctx = list[s++];
            ctx._layoutChannelNo = r;
            ctx._layoutBounds.x = col / 4; ctx._layoutBounds.y = row / 4;
            ctx._layoutBounds.width = 1 / 4; ctx._layoutBounds.height = 1 / 4;
          }
        }
      }
      // s..usingClipCount-1（真正超過 4×16=64 上限的部分）故意不指定 _layoutChannelNo，
      // 交給上面 patch 過的 getChannelFlagAsColor 防呆處理，不會讓渲染崩潰。
    };
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

  /** 角色隨機切換表情（洗牌輪播，不連續重複） */
  playRandomExpr(key) {
    const s = this['_' + key];
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
    this._showMotionLabel(key + ':expr:' + (s.expList[idx] || idx));
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
      // 從 gMap 具名群組（含 '' 空群組）依別名搜尋
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
      // 完全找不到別名對應時，與其什麼都不播，不如播「模型第一個可用的動作」，
      // 至少角色看起來還會動——常見於動作庫很陽春（例如只有一顆沒特別命名的通用動作）的模型，
      // 這種模型的動作檔名不會剛好對到 L2D_ALIASES，導致上面的查找落空。
      const firstGroup = Object.keys(state.gMap || {})[0];
      if (firstGroup !== undefined) Promise.resolve(state.model.motion(firstGroup, 0, 3)).catch(() => {});
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
    // 置中欄位數不寫死 2——動態算「目前有幾個啟用角色 side==='center'」
    // （目前唯一會用到 center 的地方是 L2D_CFG.mobile.char1/char2，兩者都設 side:'center'，
    // 這正是舊版寫死 2 湊巧正確的原因；c3/c4 之後也用 mobile.center 的話這裡就會自動算對）
    const centerCount = Math.max(1, this._activeSlotKeys.filter(k => {
      const c = L2D_CFG['char' + k.slice(1)];
      return (c.side || 'left') === 'center';
    }).length);
    const colX   = (s2 === 'left')   ? colW * colIdx :
                   (s2 === 'center') ? (W - colW * centerCount) / 2 + colW * colIdx :
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
    if (state.key) this._updateSpeechPosFor(state.key);
    if (!silent) console.log('[L2D] fit', side, 'scale=' + s.toFixed(3),
      'offsetX=' + cfg.offsetX + ' offsetY=' + cfg.offsetY + ' rotation=' + (cfg.rotation || 0) + '°',
      '→ canvasX=' + state.model.x.toFixed(0) + ' canvasY=' + state.model.y.toFixed(0));
  },

  /** 更新某角色的泡泡位置——泡泡靠左/右錨定＋生長方向依 cfg.bubbleGrow 決定
   *  （不是 cfg.side：side 是角色站在畫面哪裡，跟泡泡要往哪邊長是兩件事，
   *  char1/char2 現在 side 都是 'left' 但泡泡生長方向相反，就是這個原因）。
   *
   *  寬度／位置分兩個獨立階段算，刻意不讓兩者互相牽扯：
   *  第一階段只決定「往哪邊長、寬度多少」——寬度固定用一個跟螢幕總寬度掛勾的
   *  「看起來像正常段落」的值（不低於 READABLE_MIN_WIDTH），完全不看角色錨點到
   *  螢幕邊緣還剩多少距離。這是有意的：舊版曾經用「錨點到邊緣的剩餘距離」去縮
   *  maxWidth，角色一站到邊角，剩餘距離變小，泡泡就會被硬擠成很窄的欄位（可讀性
   *  很差），等於用犧牲可讀性的方式去換「不超出螢幕」，但其實不需要這樣換——
   *  用固定寬度＋下面第二階段的位置校正就能兩者兼顧。
   *  第二階段等這一幀排版完成後，量出泡泡實際佔用的螢幕範圍
   *  （getBoundingClientRect），只要有任何一邊超出視窗邊界（不管是角色站在邊角、
   *  還是固定寬度本身就比可用空間寬），就整塊平移拉回來——校正的是「位置」，
   *  不是「把內容擠更窄」，所以不管角色站在畫面哪裡，泡泡都維持一致、好讀的寬度，
   *  同時整個框仍然完整留在螢幕內。 */
  _updateSpeechPosFor(key) {
    const n     = key.slice(1);
    const state = this['_' + key];
    const cfg   = state.cfg || L2D_CFG['char' + n];
    const box   = document.getElementById('l2d-speech' + (n === '1' ? '' : n));
    if (!box || !state.model || !state.ready) return;
    const m   = state.model;
    const hr  = cfg.headRatio  ?? 0.25;
    const hxr = cfg.headXRatio ?? 0.5;
    const nw  = state._nw || 2048;
    const nh  = state._nh || 2048;
    // 以模型原始座標換算螢幕位置，縮放/拖曳後仍精確
    const sp   = m.toGlobal(new PIXI.Point(nw * hxr, nh * hr));
    const grow = cfg.bubbleGrow || 'right';
    // 泡泡跟螢幕邊緣至少留這麼多像素，不要貼死邊界。故意留比視覺上需要的更多一點緩衝：
    // 進場動畫（_l2dSpeakIn／_l2dSpeakIn2）在 70% 那格會 scale(1.04) 短暫過衝再回彈到 1，
    // getBoundingClientRect() 量到的是版面尺寸（transform 造成的視覺過衝不會反映在這裡），
    // 那段時間的實際視覺大小會比量到的大一點；MARGIN 留寬鬆一點，這段過衝才不會真的
    // 貼出螢幕邊緣。
    const MARGIN = 16;
    // 寬度上/下限跟角色一/二（跟 c3/c4）共用同一組數字、同一條公式——這裡完全不看
    // key/grow，寬度計算方式對每個角色都一致，不會有誰的容器比較窄的情況。
    const PREFERRED_MAX_WIDTH = 600; // 看起來像正常段落的寬度上限，螢幕更寬也不用撐滿整排
    const READABLE_MIN_WIDTH  = 260; // 可讀性下限，不因為角色站在邊角就被擠得更窄
    const bubbleWidth = Math.max(READABLE_MIN_WIDTH, Math.min(PREFERRED_MAX_WIDTH, window.innerWidth - MARGIN * 2));

    box.style.top       = sp.y + 'px';
    box.style.bottom    = '';
    box.style.transform = 'translateY(-50%)';
    box.style.maxWidth  = bubbleWidth + 'px';
    if (grow === 'left') {
      // 靠右錨定、向左長
      box.style.right = (window.innerWidth - sp.x + 3) + 'px';
      box.style.left  = '';
    } else {
      // 靠左錨定、向右長
      box.style.left  = (sp.x + 3) + 'px';
      box.style.right = '';
    }

    // 第二階段：量實際排版結果，整塊平移拉回螢幕範圍內。角色站在畫面中間時 dx/dy
    // 通常是 0，不影響原本位置；角色站在邊角時，固定寬度的泡泡本來就可能比剩餘空間
    // 寬，這裡的位移就是負責把它拉回螢幕內的主要機制（故意用「移位置」取代「縮寬度」，
    // 見上面函式註解）。
    const rect = box.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      if (rect.left < MARGIN) {
        const shift = MARGIN - rect.left;
        if (grow === 'left') box.style.right = (parseFloat(box.style.right) - shift) + 'px';
        else box.style.left = (parseFloat(box.style.left) + shift) + 'px';
      } else if (rect.right > window.innerWidth - MARGIN) {
        const shift = rect.right - (window.innerWidth - MARGIN);
        if (grow === 'left') box.style.right = (parseFloat(box.style.right) + shift) + 'px';
        else box.style.left = (parseFloat(box.style.left) - shift) + 'px';
      }
      let dy = 0;
      if (rect.top < MARGIN) dy = MARGIN - rect.top;
      else if (rect.bottom > window.innerHeight - MARGIN) dy = (window.innerHeight - MARGIN) - rect.bottom;
      if (dy) box.style.transform = `translateY(calc(-50% + ${dy}px))`;
    }
  },

  // 角色數 3/4 時，原本疊 3~4 顆獨立按鈕會往上蓋到 bottom:114/167/270px 這些固定位置的
  // 音效/BGM/VFX 按鈕（host.html、player.html 共用的版位慣例）。改成「收合式選單」：
  // 平時只顯示一顆主按鈕（bottom:8px，跟角色一原本的位置一樣，不佔額外空間），點下去才往
  // 右橫向展開出各角色的按鈕（bottom 維持 8px，只往右加 left），選完角色自動收合回主按鈕，
  // 所以不管展開或收合都不會碰到上方那排垂直堆疊的固定按鈕。用 click 事件，手機點擊
  // 一樣觸發，不需要另外處理觸控事件。
  // 四顆角色子按鈕要畫出「真的骰子臉」（白底方塊 + 黑點，1~4 點對應角色一~四），
  // 不用 Unicode 骰子字元（⚀⚁⚂⚃ 這種文字符號在不同系統/字型下粗細差很多，看起來不像
  // 實際骰子），改用 CSS Grid 手畫 3x3 九宮格，點數位置照真實骰子的標準排法，這樣不管
  // 哪個瀏覽器/字型都保證長一樣。主按鈕本身不用表示點數，直接用 🎲 emoji（見下方
  // mainBtn.textContent）。
  _DICE_LAYOUT: {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  },
  _diceFaceHTML(pips) {
    const active = new Set(this._DICE_LAYOUT[pips] || []);
    let cells = '';
    for (let i = 0; i < 9; i++) {
      cells += '<i style="border-radius:50%;' +
        (active.has(i) ? 'background:#222;' : 'background:transparent;') + '"></i>';
    }
    return '<div style="display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);' +
      'width:22px;height:22px;gap:2px;background:#eee;border-radius:4px;padding:3px;">' + cells + '</div>';
  },

  _initDragButtons() {
    const S = 'position:fixed;bottom:8px;z-index:10000;width:45px;height:45px;' +
      'border-radius:9px;border:1px solid rgba(255,255,255,.18);' +
      'background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;' +
      'cursor:pointer;padding:0;';
    const CN = ['一', '二', '三', '四'];

    const mainBtn = document.createElement('button');
    mainBtn.title = '選擇要拖曳的角色';
    mainBtn.textContent = '🎲'; // 主按鈕是純入口，不用表示點數，直接用骰子 emoji
    mainBtn.style.cssText = S + 'left:6px;font-size:22px;';
    document.body.appendChild(mainBtn);

    const buttons = this._activeSlotKeys.map((key, i) => {
      const b = document.createElement('button');
      b.title = '拖曳角色' + CN[i];
      b.innerHTML = this._diceFaceHTML(i + 1); // 理論上角色數上限是4，用 1~4 點對應角色一~四
      b.style.cssText = S + 'left:' + (6 + 53 * (i + 1)) + 'px;display:none;';
      document.body.appendChild(b);
      return { key, btn: b };
    });

    let expanded = false;
    let active = null;

    const setExpanded = (v) => {
      expanded = v;
      buttons.forEach(({ btn }) => { btn.style.display = v ? 'flex' : 'none'; });
    };

    const setActive = (key) => {
      active = key;
      buttons.forEach(({ key: k, btn }) => {
        btn.style.background = k === active ? 'rgba(0,212,255,.25)' : 'rgba(0,0,0,.5)';
      });
      // 主按鈕反映「目前有沒有角色在拖曳模式」，收合後也看得出狀態
      mainBtn.style.background = active ? 'rgba(0,212,255,.25)' : 'rgba(0,0,0,.5)';
      this.stopDrag();
      if (key) this.startDrag(key);
    };

    mainBtn.addEventListener('click', () => setExpanded(!expanded));
    buttons.forEach(({ key, btn }) => {
      btn.addEventListener('click', () => {
        setActive(active === key ? null : key);
        setExpanded(false); // 選完自動收合，畫面盡量保持乾淨
      });
    });
  },

  startDrag(key) {
    const state   = this['_' + key];
    const cfg     = state.cfg || L2D_CFG['char' + key.slice(1)];
    const defSide = cfg.side || 'left';
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
    // 還原成目前該有的層級——不能寫死 5，否則會蓋掉 setTopLayer(true) 拉高的層級
    // （手機端加入遊戲前，角色要蓋在 join 畫面之上；拖曳結束後如果硬蓋回 5，
    // 層級就會變得比 .screen（z-index:110）還低，跟表單設定區的疊放順序就錯了）
    cv.style.zIndex = String(this._zBoosted ? this._Z_TOP : this._Z_CANVAS);
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
    console.log('%c[L2D] 座標 ─ 貼入 hostPos / playerPos', 'color:#0f6;font-weight:bold;font-size:13px');
    this._activeSlotKeys.forEach(k => {
      const n     = k.slice(1);
      const cfg   = L2D_CFG['char' + n];
      const state = this['_' + k];
      const cx = state.model ? state.model.x.toFixed(0) : '?';
      const cy = state.model ? state.model.y.toFixed(0) : '?';
      console.log(`  char${n}: { offsetX: ${fmt(cfg.offsetX)}, offsetY: ${fmt(cfg.offsetY)}, rotation: ${fmt(cfg.rotation || 0)} }  ← 貼這個`);
      console.log(`         畫布實際位置: canvasX=${cx} canvasY=${cy}  (僅供參考，offsetX≠canvasX)`);
      console.log(`         manifest.json layout: "layout": { "offsetX": ${cfg.offsetX}, "offsetY": ${cfg.offsetY}, `
        + `"scale": ${cfg.scale}, "headRatio": ${cfg.headRatio}, "headXRatio": ${cfg.headXRatio} }  ← 這個模型微調好了就貼這個`);
    });
  },

  /** 清除此頁面的拖曳存檔，讓 hostPos / playerPos 程式碼設定生效（重新整理後才看到效果） */
  clearPos() {
    ['c1', 'c2', 'c3', 'c4'].forEach(k => {
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
    this._activeSlotKeys.forEach(k => {
      const state = this['_' + k];
      if (state.model) this._fit(state, state.cfg || L2D_CFG['char' + k.slice(1)], state.cfg?.side || 'left');
    });
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

  /** 淡出並移除某角色目前的泡泡 */
  dismissFor(key) {
    const n      = key.slice(1);
    const domId  = 'l2d-speech' + (n === '1' ? '' : n);
    const rafKey = '_speechRaf' + (n === '1' ? '' : n);
    const outAnim = (this['_' + key].cfg?.bubbleGrow || 'right') === 'left' ? '_l2dSpeakOut2' : '_l2dSpeakOut';
    const box = document.getElementById(domId);
    if (!box || !box.firstChild) return;
    if (box._tid) { clearTimeout(box._tid); box._tid = null; }
    const bubble = box.firstChild;
    bubble.style.animation = `${outAnim} .35s ease forwards`;
    box._tid = setTimeout(() => {
      box.replaceChildren();
      if (this[rafKey]) { cancelAnimationFrame(this[rafKey]); this[rafKey] = null; }
      box._tid = null;
    }, 350);
  },

  /** 覆寫「閒話家常」要說的內容——預設用內建的 L2D_CHAT_C1/C2（網頁模式測驗情境專用的
   *  50 句陪伴台詞），桌寵這種跟「使用者在答題」完全無關的使用情境，不用共用那份內容，
   *  呼叫這個方法蓋掉即可，網頁模式（host.html/player.html）沒呼叫過，行為完全不受影響。
   *  c1Lines/c2Lines 索引互相對應（跟 L2D_CHAT_C1/C2 同一種慣例），長度不必完全一致，
   *  c2 缺的索引 fire() 那邊會自動跳過、只讓角色一說。傳空陣列或不傳 = 恢復用內建預設。 */
  setIdleChatLines(c1Lines, c2Lines) {
    this._idleChatC1 = (Array.isArray(c1Lines) && c1Lines.length) ? c1Lines : null;
    this._idleChatC2 = Array.isArray(c2Lines) ? c2Lines : [];
  },

  /** 答題期間隨機閒話家常（intervalMs 毫秒說一句，stopIdleChat 停止）
   *  職責只管「講話泡泡 + 音效」，動作/表情一律交給 startIdleMotion 負責，
   *  避免兩邊各自觸發 playRandom/playRandomExpr、疊加成同一件事做兩次。
   *  呼叫端請帶跟 startIdleMotion 相同的 intervalMs，讓兩個循環節奏對齊。 */
  startIdleChat(intervalMs = 6000) {
    this.stopIdleChat();
    const fire = () => {
      // 預設用內建的 L2D_CHAT_C1/C2（原本是為網頁模式測驗情境寫的 50 句陪伴台詞）；
      // 呼叫端（例如桌寵）可以先呼叫 setIdleChatLines() 蓋掉，講自己的內容，不用動這支
      // 共用引擎檔案——每次 fire() 都重新讀 this._idleChatC1/C2，中途呼叫
      // setIdleChatLines() 換內容也會在下一次 fire() 立刻生效，不用重開循環。
      const pool1 = this._idleChatC1 || L2D_CHAT_C1;
      const pool2 = this._idleChatC2 || L2D_CHAT_C2;
      let idx;
      do { idx = Math.floor(Math.random() * pool1.length); }
      while (idx === this._lastChatIdx && pool1.length > 1);
      this._lastChatIdx = idx;
      this.speak(pool1[idx], { type: 'info' });
      if (pool2[idx] != null) this.speak2(pool2[idx], { type: 'info' });
      // 每個啟用角色各自觸發自己的閒話音效（見 playChatSound()）——舊版是把所有啟用
      // 角色的 chatSounds 合併成同一個池子、每次只挑一個播，四個角色共用一個 Audio
      // 物件，聽起來永遠只有其中一個角色在出聲；現在每個角色有自己獨立的 Audio
      // 物件（存在各自的 state.chatAudio），彼此互不干擾，可以同時各自出聲。
      this._activeSlotKeys.forEach(key => this.playChatSound(key));
      this._idleChatTimer = setTimeout(fire, intervalMs);
    };
    this._idleChatTimer = setTimeout(fire, intervalMs);
  },

  stopIdleChat() {
    if (this._idleChatTimer) { clearTimeout(this._idleChatTimer); this._idleChatTimer = null; }
    ['c1', 'c2', 'c3', 'c4'].forEach(key => this._stopChatSound(key));
  },

  /** 播放單一角色自己的閒話音效：優先用該角色 manifest.json 的 chatSounds（跟著模型走，
   *  換模型音效池就跟著換），沒設定才退回 L2D_CFG.chatSounds 這個全域預設池。音效物件存在
   *  該角色自己的 state.chatAudio 上（不是共用的 this._chatAudio），四個角色互不覆蓋，
   *  可以同時各自出聲——這是取代舊版「合併全部角色音效池、只播一個」做法的核心改動。
   *  startIdleChat() 內部走 _activeSlotKeys.forEach 直接呼叫這個帶 key 的版本（跟
   *  startIdleMotion() 呼叫 playRandom(key) 同一套模式）；下面 playChatSound1~4 是給手動
   *  單獨測試某一個角色用的固定捷徑，兩者不衝突。 */
  playChatSound(key) {
    const state = this['_' + key];
    if (!state) return;
    const cfg = state.cfg || L2D_CFG['char' + key.slice(1)];
    if (!cfg) return;
    const pool = (cfg.chatSounds && cfg.chatSounds.length)
      ? cfg.chatSounds
      : (L2D_CFG.chatSounds || []).filter(s => s !== '' && s != null);
    if (!pool.length) return;
    if (state.chatAudio) { state.chatAudio.pause(); state.chatAudio = null; }
    state.chatAudio = new Audio(pool[Math.floor(Math.random() * pool.length)]);
    state.chatAudio.play().catch(() => {});
  },
  playChatSound1() { this.playChatSound('c1'); },
  playChatSound2() { this.playChatSound('c2'); },
  playChatSound3() { this.playChatSound('c3'); },
  playChatSound4() { this.playChatSound('c4'); },

  // 停止單一角色的閒話音效。.pause() 不會觸發 'ended'——host.html/player.html
  // （multi/SoundSystem.js）跟桌寵都攔截了 Audio 建構子，靠 'ended' 事件把播放完的
  // 物件從追蹤集合裡移除；被這裡提前打斷的音效永遠等不到那個事件，物件會一直留著出不去。
  // 手動補發一次讓它們用同一套機制被清掉，這裡不用知道追蹤集合實際叫什麼名字、定義在
  // 哪個檔案。跟 playChatSound() 裡「換下一句就直接 pause 蓋過去」不同，這裡是「真的要
  // 停了」才補發 'ended'，語意上一個是接力、一個是收尾。
  _stopChatSound(key) {
    const state = this['_' + key];
    if (!state || !state.chatAudio) return;
    state.chatAudio.pause();
    state.chatAudio.currentTime = 0;
    state.chatAudio.dispatchEvent(new Event('ended'));
    state.chatAudio = null;
  },

  /** 同時淡出所有啟用角色的泡泡 */
  dismissAll() { this._activeSlotKeys.forEach(k => this.dismissFor(k)); },

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
   * 在角色旁顯示對話泡泡。泡泡生長方向依 cfg.bubbleGrow 決定（不是 cfg.side——
   * side 是角色站在畫面哪裡，跟泡泡要往哪邊長是兩件事）：
   * 'right' = 靠左錨定、向右長、尾巴朝左（跟原本 speak() 一致）；
   * 'left'  = 靠右錨定、向左長、尾巴朝右（跟原本 speak2() 一致）；
   * 'center' 目前借用 'right' 的視覺（尾巴朝左），供之後手動調整。
   * @param {'c1'|'c2'|'c3'|'c4'} key
   * @param {string} text
   * @param {{ type?: 'info'|'correct'|'wrong'|'celebrate', duration?: number }} opts
   */
  speakFor(key, text, { type = 'info', duration } = {}) {
    if (duration === undefined) {
      duration = ['correct', 'wrong', 'celebrate'].includes(type)
        ? L2D_CFG.speechDurationAfter
        : L2D_CFG.speechDurationBefore;
    }
    const n      = key.slice(1);
    const cfg    = this['_' + key].cfg || L2D_CFG['char' + n];
    const grow   = cfg.bubbleGrow || 'right';
    const isLeft = grow === 'left';
    const domId  = 'l2d-speech' + (n === '1' ? '' : n);
    const rafKey = '_speechRaf' + (n === '1' ? '' : n);

    let box = document.getElementById(domId);
    if (!box) {
      box = document.createElement('div');
      box.id = domId;
      box.style.cssText = `position:fixed;z-index:${this._zBoosted ? this._Z_TOP : this._Z_BUBBLE};pointer-events:none;`;
      document.body.appendChild(box);
    }
    if (box._tid) { clearTimeout(box._tid); box._tid = null; }
    if (this[rafKey]) { cancelAnimationFrame(this[rafKey]); this[rafKey] = null; }

    // 'info' 類型（閒話/情境台詞/答題前提示，桌寵幾乎都是這種）用角色自己的識別色
    // （cfg.bubbleColor，見 L2D_CFG.char1~char4 定義），跟「是誰在講話」綁在一起，
    // 不是跟 bubbleGrow（泡泡往哪邊長，純版面方向）綁在一起，避免兩個角色剛好切到
    // 同一個生長方向時顏色也跟著撞在一起、分不出是誰講的。correct/wrong/celebrate
    // 這三種是「答對/答錯/慶祝」的語意色（綠/紅/金），跟誰講話無關，維持原樣不受影響。
    const infoRGB = cfg.bubbleColor || (isLeft ? '255,140,0' : '0,212,255');
    const BORDER = {
      correct:   'rgba(0,255,136,.8)',
      wrong:     'rgba(255,51,85,.8)',
      celebrate: 'rgba(255,214,0,.9)',
      info:      `rgba(${infoRGB},.75)`,
    }[type] || `rgba(${infoRGB},.75)`;

    const GLOW = {
      correct:   'rgba(0,255,136,.35)',
      wrong:     'rgba(255,51,85,.3)',
      celebrate: 'rgba(255,214,0,.35)',
      info:      `rgba(${infoRGB},.25)`,
    }[type] || `rgba(${infoRGB},.25)`;

    // 文字顏色：'info' 類型混一點點角色識別色進純白裡（維持高對比可讀性，只是隱約
    // 帶點角色色調，跟框線/發光呼應），其他語意色類型維持原本的純白，不跟綠/紅/金搶戲。
    const TEXT_RGB = (() => {
      if (type !== 'info') return '245,245,245';
      const [r, g, b] = infoRGB.split(',').map(Number);
      const tint = (c) => Math.round(c * 0.22 + 255 * 0.78);
      return `${tint(r)},${tint(g)},${tint(b)}`;
    })();

    // 外殼（承載 spring 彈跳動畫）
    const inAnim  = isLeft ? '_l2dSpeakIn2'  : '_l2dSpeakIn';
    const outAnim = isLeft ? '_l2dSpeakOut2' : '_l2dSpeakOut';
    const bubble = document.createElement('div');
    bubble.style.cssText =
      `position:relative;transform-origin:${isLeft ? 'right' : 'left'} center;` +
      `animation:${inAnim} .5s cubic-bezier(.34,1.56,.64,1) both;`;

    // 三角箭頭
    const tail = document.createElement('div');
    tail.style.cssText = isLeft
      ? `position:absolute;right:-9px;top:50%;transform:translateY(-50%);` +
        `width:0;height:0;` +
        `border-top:9px solid transparent;border-bottom:9px solid transparent;` +
        `border-left:9px solid ${BORDER};filter:drop-shadow(2px 0 4px ${GLOW});`
      : `position:absolute;left:-9px;top:50%;transform:translateY(-50%);` +
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
      `color:rgb(${TEXT_RGB});` +
      `font-family:system-ui,-apple-system,'Microsoft JhengHei',sans-serif;` +
      `font-size:18px;font-weight:700;letter-spacing:.4px;line-height:1.5;` +
      `box-shadow:0 0 28px ${GLOW},0 0 8px ${GLOW},inset 0 1px 0 rgba(255,255,255,.1);` +
      `text-shadow:0 0 14px ${GLOW},0 1px 4px rgba(0,0,0,.9);` +
      // word-break:keep-all 對沒有空白分隔的連續中文句子會找不到斷行點，整句直接
      // 橫向撐破 maxWidth（不是「顯示不出來」，是溢出跑版）——改回 normal（CJK 逐字
      // 斷行是瀏覽器內建的行為，不需要 break-all）＋ overflow-wrap:break-word 兜底
      // 處理超長的連續非 CJK 字串（例如網址），確保文字一定是左到右、上到下正常換行，
      // 不會撐破泡泡框。
      `white-space:normal;word-break:normal;overflow-wrap:break-word;`;
    // 逐字彈入動畫
    const _esc = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    const charAnim = (type === 'correct' || type === 'celebrate') ? '_l2dCharPop' : '_l2dCharIn';
    body.style.transformOrigin = 'center';
    body.innerHTML = [...text].map((ch, i) =>
      `<span style="display:inline-block;opacity:0;will-change:transform;animation:${charAnim} .45s cubic-bezier(.34,1.56,.64,1) ${i * 52}ms forwards">${ch === ' ' ? '&nbsp;' : _esc(ch)}</span>`
    ).join('');

    if (isLeft) bubble.append(body, tail);
    else        bubble.append(tail, body);
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

    // RAF 持續追蹤角色頭部，泡泡存在期間每幀更新位置
    const tick = () => {
      this._updateSpeechPosFor(key);
      if (box.firstChild) this[rafKey] = requestAnimationFrame(tick);
    };
    tick();

    box._tid = setTimeout(() => {
      bubble.style.animation = `${outAnim} .45s ease forwards`;
      box._tid = setTimeout(() => {
        box.replaceChildren();
        if (this[rafKey]) { cancelAnimationFrame(this[rafKey]); this[rafKey] = null; }
      }, 450);
    }, duration);
  },
  speak(text, opts)  { this.speakFor('c1', text, opts); },
  speak2(text, opts) { this.speakFor('c2', text, opts); },
};
