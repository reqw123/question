// =============================================================
// 鍵盤操作對照（無相機時可用鍵盤作答）
// =============================================================
//  答題按鍵
//    A  →  選項 A（👊 Rock Fist）
//    B  →  選項 B（✌️ Victory）
//    C  →  選項 C（☝️ One Finger）
//    D  →  選項 D（✋ Open Palm）
//
//  注意：僅在「答題中」階段有效，其他畫面（倒數、結果、結算）
//        按鍵不觸發，防止誤按。
// =============================================================

// ===== 題庫路徑（修改此處切換題庫）=====
const QUESTION_BANK       = '../questions/business.json';
const QUESTION_BANK_LABEL = '企管';          // 作答紀錄檔名用
// 範例：
//   const QUESTION_BANK = 'questions.json';  const QUESTION_BANK_LABEL = 'IoT程設';
//   const QUESTION_BANK = 'banks/science.json';

// ===== 相機來源設定 =====
const CAMERA_CFG = {
  // 'webcam'   — 使用電腦 USB 相機或筆電內建相機（預設）
  // 'esp32cam' — 使用 ESP32-CAM MJPEG IP 串流（固定鏡頭）
  mode:        'esp32cam',
  esp32camURL: 'http://192.168.0.120:81/stream', // MJPEG 串流 URL（含 port 和路徑）
  snapshotURL: '',   // 單張 JPEG 快照 URL（空白則自動推導：http://{host}/capture）
};

// ===== CONFIGURATION =====
const CFG = {
  GAME_Q_COUNT:      10,
  PREPARE_TIME:      3,
  ANSWER_TIME:       10,
  RESULT_SHOW_MS:    2000,
  EXPL_SHOW_MS:      3000,
  GESTURE_HOLD_MS:   1000,
  BUFFER_SIZE:       30,
  BUFFER_MIN_MATCH:  20,
  FIST_THRESH:       0.72, // tip-to-palm / scale — below = curled
};

// A = 👊 Rock Fist (changed from Thumbs Up)
const GESTURE_EMOJIS = { A: '👊', B: '✌️', C: '☝️', D: '✋' };
const GESTURE_NAMES  = { A: '👊 Rock Fist', B: '✌️ Victory', C: '☝️ One Finger', D: '✋ Open Palm' };

// ===== ALL 50 QUESTIONS (embedded so the game always has 10 questions
//       regardless of whether questions.json can be fetched) =====
const BUILTIN_QUESTIONS = [
  { question:"ESP32 屬於哪種裝置？", options:{A:"微控制器",B:"GPU 繪圖處理器",C:"伺服器 CPU",D:"固態硬碟"}, answer:"A", explanation:"ESP32 是 Espressif 開發的微控制器，內建 Wi-Fi 與藍牙，廣泛用於 IoT 開發。" },
  { question:"Arduino Uno 使用哪個微控制器晶片？", options:{A:"STM32",B:"ATmega328P",C:"ESP8266",D:"PIC16F877"}, answer:"B", explanation:"Arduino Uno 搭載 ATmega328P，運行頻率 16 MHz，具有 32 KB Flash。" },
  { question:"PWM 全稱是？", options:{A:"Pulse Width Modulation",B:"Power Wave Management",C:"Peripheral Wire Mode",D:"Parallel Width Module"}, answer:"A", explanation:"PWM（脈衝寬度調變）透過改變方波佔空比來控制平均輸出電壓，常用於馬達與 LED 亮度控制。" },
  { question:"GPIO 全稱是？", options:{A:"General Purpose Input/Output",B:"Global Peripheral Interface Operation",C:"Gate Processing I/O",D:"Ground Power Input/Output"}, answer:"A", explanation:"GPIO（通用輸入輸出）是微控制器可程式化的數位引腳，可設定為輸入或輸出模式。" },
  { question:"Raspberry Pi 通常執行哪種作業系統？", options:{A:"Linux（Raspberry Pi OS）",B:"Windows 11",C:"macOS",D:"FreeBSD"}, answer:"A", explanation:"Raspberry Pi 官方推薦使用基於 Debian 的 Raspberry Pi OS，屬於 Linux 系統。" },
  { question:"ADC 的功能是什麼？", options:{A:"數位訊號轉類比",B:"類比訊號轉數位",C:"訊號放大",D:"頻率調變"}, answer:"B", explanation:"ADC（類比數位轉換器）將連續的類比電壓訊號轉換為離散的數位值，例如感測器讀值。" },
  { question:"I2C 通訊需要幾條主要訊號線？", options:{A:"1 條",B:"2 條（SDA + SCL）",C:"3 條",D:"4 條"}, answer:"B", explanation:"I2C 只需要 SDA（資料線）和 SCL（時脈線）兩條線，支援一主多從架構。" },
  { question:"SPI 通訊標準需要幾條主要訊號線？", options:{A:"2 條",B:"3 條",C:"4 條（MOSI/MISO/SCK/CS）",D:"6 條"}, answer:"C", explanation:"SPI 使用 MOSI、MISO、SCK（時脈）、CS（片選）四條線，傳輸速度比 I2C 快。" },
  { question:"RTOS 全稱是？", options:{A:"Real-Time Operating System",B:"Remote Transmission OS",C:"Routing Table OS",D:"Redundant Task OS"}, answer:"A", explanation:"RTOS（即時作業系統）能在嚴格時間限制內完成任務，常見的有 FreeRTOS、Zephyr。" },
  { question:"UART 屬於哪種通訊類型？", options:{A:"同步並列",B:"同步串列",C:"非同步串列",D:"無線藍牙"}, answer:"C", explanation:"UART（通用非同步收發器）是非同步串列協定，不需共用時脈線，雙方以相同鮑率通訊。" },
  { question:"MQTT 採用哪種通訊架構？", options:{A:"Client-Server",B:"Publish-Subscribe",C:"Peer-to-Peer",D:"Master-Slave"}, answer:"B", explanation:"MQTT 使用 Publish-Subscribe 架構，Publisher 發送訊息至 Broker，Subscriber 向 Broker 訂閱主題。" },
  { question:"HTTP 協定預設使用哪個埠號？", options:{A:"8080",B:"443",C:"80",D:"3000"}, answer:"C", explanation:"HTTP 預設使用 80 埠，HTTPS 使用 443 埠，開發環境常用 3000 或 8080 但非標準。" },
  { question:"HTTPS 協定預設使用哪個埠號？", options:{A:"80",B:"8080",C:"8443",D:"443"}, answer:"D", explanation:"HTTPS 在 HTTP 基礎上加入 TLS/SSL 加密，預設使用 443 埠，確保傳輸安全。" },
  { question:"SSH 協定預設使用哪個埠號？", options:{A:"23",B:"22",C:"21",D:"25"}, answer:"B", explanation:"SSH（安全外殼協定）預設使用 22 埠，提供加密的遠端登入與指令執行功能。" },
  { question:"FTP 協定預設使用哪個埠號？", options:{A:"21",B:"22",C:"23",D:"25"}, answer:"A", explanation:"FTP 控制連線使用 21 埠，資料傳輸使用 20 埠，現多以 SFTP 取代。" },
  { question:"LoRa 技術最適合哪種應用場景？", options:{A:"高速影像串流",B:"短距離高頻寬傳輸",C:"家庭 Wi-Fi 分享",D:"長距離低功耗 IoT 感測"}, answer:"D", explanation:"LoRa 可傳輸數公里，功耗極低，電池可用數年，適合農業、智慧城市感測節點。" },
  { question:"Zigbee 主要運作在哪個頻段？", options:{A:"900 MHz",B:"2.4 GHz",C:"5 GHz",D:"433 MHz"}, answer:"B", explanation:"Zigbee 主要使用 2.4 GHz 頻段（全球通用），速率低但功耗極低，適合智慧家居 mesh 網路。" },
  { question:"BLE 全稱是？", options:{A:"Bluetooth Low Energy",B:"Basic Link Extension",C:"Broadband LAN Extension",D:"Binary Layer Encoding"}, answer:"A", explanation:"BLE（藍牙低功耗）是藍牙 4.0 引入的技術，針對穿戴裝置、IoT 感測器設計，省電為主要目標。" },
  { question:"CoAP 協定主要設計用於？", options:{A:"影片串流平台",B:"大型關聯式資料庫",C:"受限物聯網裝置",D:"高頻金融交易"}, answer:"C", explanation:"CoAP（受限應用協定）類似 HTTP 但更輕量，設計給記憶體與頻寬受限的 IoT 裝置使用。" },
  { question:"I2C 通訊最多可掛載幾個從設備（7-bit 位址）？", options:{A:"64 個",B:"128 個",C:"256 個",D:"32 個"}, answer:"B", explanation:"I2C 使用 7-bit 位址，理論上可連接 128 個設備（0x00~0x7F），部分位址為保留用途。" },
  { question:"IPv6 位址共有幾個位元？", options:{A:"32 位元",B:"64 位元",C:"128 位元",D:"256 位元"}, answer:"C", explanation:"IPv6 使用 128 位元位址，約提供 3.4×10³⁸ 個位址，徹底解決 IPv4 位址耗盡問題。" },
  { question:"DNS 的主要功能是？", options:{A:"加密網路流量",B:"將域名解析為 IP 位址",C:"自動分配 IP 位址",D:"建立 VPN 加密通道"}, answer:"B", explanation:"DNS（域名系統）負責將人類可讀的域名（如 google.com）轉換為機器使用的 IP 位址。" },
  { question:"DHCP 的主要功能是？", options:{A:"加密資料傳輸",B:"封包路由選擇",C:"自動分配 IP 位址",D:"解析域名"}, answer:"C", explanation:"DHCP 自動為網路上的裝置分配 IP 位址、子網路遮罩和預設閘道，免除手動設定。" },
  { question:"TCP 與 UDP 最主要的差異為何？", options:{A:"TCP 提供可靠傳輸，UDP 傳輸速度更快",B:"TCP 比 UDP 速度快",C:"UDP 具有流量控制",D:"TCP 不需要三向交握"}, answer:"A", explanation:"TCP 透過確認、重傳確保資料完整，UDP 無確認機制但延遲更低，適合串流、遊戲等即時應用。" },
  { question:"HTTP 狀態碼 200 代表？", options:{A:"重新導向",B:"找不到資源",C:"伺服器內部錯誤",D:"請求成功"}, answer:"D", explanation:"HTTP 200 OK 表示伺服器成功處理請求。2xx 成功，3xx 重導向，4xx 客戶端錯誤，5xx 伺服器錯誤。" },
  { question:"HTTP 狀態碼 404 代表？", options:{A:"伺服器內部錯誤",B:"請求成功",C:"未授權存取",D:"找不到所請求的資源"}, answer:"D", explanation:"HTTP 404 Not Found 表示伺服器找不到請求的資源，通常是 URL 錯誤或資源已被刪除。" },
  { question:"REST API 中，新增資源應使用哪種 HTTP 方法？", options:{A:"POST",B:"GET",C:"DELETE",D:"PATCH"}, answer:"A", explanation:"POST 建立新資源；GET 取得資源；PUT/PATCH 更新；DELETE 刪除。這是 RESTful 設計規範。" },
  { question:"REST API 中 PUT 方法的用途是？", options:{A:"刪除資源",B:"取得資源清單",C:"更新或替換完整資源",D:"建立新資源"}, answer:"C", explanation:"PUT 用於完整替換資源；PATCH 則是部分更新。兩者都要求客戶端提供資源的最新狀態。" },
  { question:"WebSocket 相較於 HTTP 的主要優勢是？", options:{A:"自動加密所有流量",B:"支援全雙工即時雙向通訊",C:"耗電量更低",D:"不需要伺服器端支援"}, answer:"B", explanation:"WebSocket 建立持久連線，允許伺服器主動推送資料給客戶端，適合即時聊天、儀表板、遊戲。" },
  { question:"CORS 全稱是？", options:{A:"Cross-Origin Resource Sharing",B:"Content Object Routing System",C:"Cloud Origin Request Service",D:"Cache Object Response Stream"}, answer:"A", explanation:"CORS（跨來源資源共享）是瀏覽器安全機制，透過 HTTP 標頭允許或限制跨域請求。" },
  { question:"Python 定義函式使用哪個關鍵字？", options:{A:"func",B:"function",C:"sub",D:"def"}, answer:"D", explanation:"Python 使用 def 關鍵字定義函式，例如 def greet(name): return 'Hello ' + name。" },
  { question:"Python 中取得序列長度使用哪個函式？", options:{A:"size()",B:"count()",C:"len()",D:"length()"}, answer:"C", explanation:"Python 的內建函式 len() 可取得字串、列表、元組、字典等序列的長度（元素數量）。" },
  { question:"Python 中 list 與 tuple 的關鍵差異是？", options:{A:"tuple 可以修改，list 不能",B:"list 可以修改，tuple 不可變",C:"兩者都不可修改",D:"兩者功能完全相同"}, answer:"B", explanation:"list 是可變（mutable）序列，可新增/修改元素；tuple 是不可變（immutable），建立後無法更改。" },
  { question:"JavaScript 中 typeof null 的回傳值為？", options:{A:"\"null\"",B:"\"object\"",C:"\"undefined\"",D:"\"boolean\""}, answer:"B", explanation:"這是 JavaScript 的歷史 bug。typeof null 回傳 \"object\"，已成為語言規範的一部分。" },
  { question:"Git 將暫存區變更提交至本地儲存庫的指令是？", options:{A:"git push",B:"git merge",C:"git commit",D:"git add"}, answer:"C", explanation:"git commit 將暫存區的快照永久記錄到本地儲存庫，需加 -m 參數撰寫提交訊息。" },
  { question:"JSON 全稱是？", options:{A:"Java Script Online Node",B:"JavaScript Object Notation",C:"Joint System Object Name",D:"Java Standard Option Net"}, answer:"B", explanation:"JSON（JavaScript 物件表示法）是一種輕量文字格式，是 Web API 最常用的資料交換格式。" },
  { question:"TCP/IP 模型中哪一層負責 IP 路由？", options:{A:"應用層",B:"傳輸層",C:"網路層",D:"資料鏈結層"}, answer:"C", explanation:"網路層（Internet Layer）負責 IP 定址與封包路由，主要協定為 IPv4、IPv6 與 ICMP。" },
  { question:"Docker 的主要優點是？", options:{A:"確保環境一致性、簡化部署",B:"直接替代作業系統",C:"提升 CPU 硬體性能",D:"提供無限雲端儲存空間"}, answer:"A", explanation:"Docker 容器將應用程式與其依賴打包，確保在任何環境（開發、測試、生產）中行為一致。" },
  { question:"CI/CD 中 CI 代表？", options:{A:"Code Interface",B:"Continuous Integration",C:"Cloud Infrastructure",D:"Component Inspector"}, answer:"B", explanation:"CI（持續整合）指開發者頻繁合併程式碼，並自動執行測試；CD 指持續交付或持續部署。" },
  { question:"Node-RED 是什麼工具？", options:{A:"網頁後端框架",B:"關聯式資料庫",C:"硬體驅動程式庫",D:"視覺化 IoT 流程程式設計平台"}, answer:"D", explanation:"Node-RED 是基於 Node.js 的視覺化工具，以「流程」連接各種 IoT 設備、API 與雲端服務。" },
  { question:"Git 切換或建立分支的指令是？", options:{A:"git fork",B:"git merge",C:"git branch / git checkout",D:"git rebase"}, answer:"C", explanation:"git branch <name> 建立分支；git checkout <name> 切換分支；可合用 git checkout -b 一次完成。" },
  { question:"DHT22 感測器用於偵測什麼？", options:{A:"光線強度",B:"溫度與相對濕度",C:"大氣壓力",D:"土壤水分含量"}, answer:"B", explanation:"DHT22 測量範圍 -40°C~+80°C、0~100% RH，精度優於 DHT11，廣用於環境監測。" },
  { question:"歐姆定律的正確公式是？", options:{A:"V = I × R",B:"I = V × R",C:"R = V × I",D:"P = V / I"}, answer:"A", explanation:"歐姆定律：V（電壓）= I（電流）× R（電阻）。由此可推導：I = V/R，R = V/I。" },
  { question:"電容器的主要功能是？", options:{A:"放大電流訊號",B:"轉換交直流電壓",C:"儲存電荷、濾波去雜訊",D:"產生磁場"}, answer:"C", explanation:"電容器可儲存電荷並快速釋放，常用於電源濾波（去除雜訊）、訊號耦合、計時電路等用途。" },
  { question:"HC-SR04 超音波感測器的工作原理？", options:{A:"紅外線反射計算距離",B:"發射超音波並測量回波時間",C:"磁場強度感應",D:"電容變化偵測"}, answer:"B", explanation:"HC-SR04 發射 40kHz 超音波脈衝，測量返回時間，距離 = (時間 × 聲速) / 2，量測範圍 2cm~4m。" },
  { question:"光敏電阻（LDR）的特性？", options:{A:"光線越強，電阻越低",B:"光線越強，電阻越高",C:"電阻不受光線影響",D:"只能在紅外線下工作"}, answer:"A", explanation:"LDR 在黑暗中電阻很高（可達 MΩ），光線照射後電阻大幅降低（幾百 Ω），常用於自動路燈控制。" },
  { question:"雲端服務模型中，SaaS 代表？", options:{A:"System as a Service",B:"Storage as a Service",C:"Software as a Service",D:"Security as a Service"}, answer:"C", explanation:"SaaS（軟體即服務）用戶直接使用雲端軟體，如 Gmail、Office 365；無需安裝或維護底層基礎設施。" },
  { question:"邊緣運算（Edge Computing）的主要優點是？", options:{A:"增加中央伺服器負擔",B:"需要更高頻寬連線",C:"降低延遲、節省頻寬",D:"只適用大型企業"}, answer:"C", explanation:"邊緣運算將資料處理移至靠近資料來源處，減少往返雲端的延遲，並降低網路頻寬需求。" },
  { question:"監督式學習（Supervised Learning）需要什麼資料？", options:{A:"無標記的原始資料",B:"已標記（labelled）的訓練資料",C:"強化學習的獎勵機制",D:"量子計算處理器"}, answer:"B", explanation:"監督式學習從「輸入-答案」配對中學習，如分類貓狗圖片需提供大量已標記好類別的圖片。" },
  { question:"AI 中 CNN 全稱是？", options:{A:"Computer Node Network",B:"Convolutional Neural Network",C:"Central Numerical Node",D:"Cascaded Network Neuron"}, answer:"B", explanation:"CNN（卷積神經網路）擅長處理圖像資料，透過卷積層自動提取局部特徵，廣泛用於影像辨識。" },
  { question:"在 IoT 系統中，「Broker」的角色是？", options:{A:"末端感測節點",B:"電源管理模組",C:"訊息中介伺服器",D:"本地端資料庫"}, answer:"C", explanation:"在 MQTT 架構中，Broker（如 Mosquitto、EMQX）接收 Publisher 的訊息並轉發給對應的 Subscriber。" },
  { question:"TCP 三向交握（3-way handshake）的順序是？", options:{A:"ACK → SYN → SYN-ACK",B:"SYN → SYN-ACK → ACK",C:"SYN → ACK → FIN",D:"CONNECT → ACCEPT → DATA"}, answer:"B", explanation:"客戶端送 SYN → 伺服器回 SYN-ACK → 客戶端送 ACK，完成三向交握後開始傳輸資料。" },
  { question:"下列哪個協定在傳輸層（Transport Layer）運作？", options:{A:"IP（網際網路協定）",B:"HTTP（超文字傳輸協定）",C:"TCP（傳輸控制協定）",D:"DNS（域名系統）"}, answer:"C", explanation:"TCP 和 UDP 都在傳輸層運作；IP 在網路層；HTTP、DNS 在應用層。" },
];

// ===== STATE =====
let allQuestions = [];

let state = {
  phase: 'intro',
  qIndex: 0,
  score: 0,
  questions: [],
  lastGesture: null,
  gestureHoldStart: null,
  gestureBuffer: [],
  gestureConfirmed: false,
  timerId: null,
  timerId2: null,
  gameLog: [],   // 本局作答紀錄
};

// ===== SOUND MANAGER =====
class SoundManager {
  constructor() { this.ctx = null; }

  init() {
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch(e) { this.ctx = null; }
  }

  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume(); }

  _tone(freq, dur, type = 'sine', vol = 0.28, delay = 0) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.type = type;
    osc.frequency.value = freq;
    const t = this.ctx.currentTime + delay;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  tick()      { this._tone(700, 0.12); }
  finalTick() { this._tone(1100, 0.18); }
  select()    { this._tone(880, 0.1); this._tone(1100, 0.12, 'sine', 0.2, 0.1); }

  correct() {
    this._tone(523, 0.12, 'sine', 0.35);
    this._tone(659, 0.12, 'sine', 0.35, 0.13);
    this._tone(784, 0.18, 'sine', 0.35, 0.26);
    this._tone(1047, 0.4,  'sine', 0.35, 0.40);
  }

  wrong() {
    this._tone(250, 0.16, 'sawtooth', 0.35);
    this._tone(180, 0.38, 'sawtooth', 0.30, 0.16);
  }

  swipe() {
    this._tone(400, 0.08, 'sine', 0.18);
    this._tone(600, 0.12, 'sine', 0.18, 0.08);
  }
}

const sound = new SoundManager();

// ===== GESTURE DETECTION =====

// 3-D Euclidean distance (z-coordinate optional / approximate)
function dist3(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

/*
 * Gesture A — Rock / Fist 👊
 *   Uses 3D distance so detection is direction-agnostic:
 *   works whether the fist points toward camera, sideways, up, or down.
 *
 *   Method:
 *     1. Compute "palm center" = centroid of the 4 knuckles (MCPs).
 *     2. Normalize each fingertip's distance to that center by the hand
 *        scale (wrist → middle-MCP), giving a ratio independent of how
 *        large the hand appears in the frame.
 *     3. All 5 tips (index, middle, ring, pinky, thumb) must have ratio
 *        below CFG.FIST_THRESH (default 0.72).
 *
 * Gestures B, C, D — still use y-axis extension (reliable when the
 *   hand faces the camera, which is the natural posture for ✌️☝️✋).
 */
function detectGesture(lm) {
  if (!lm || lm.length < 21) return null;

  // ── Hand scale: wrist (0) to middle-finger MCP (9) ──────────────────
  const scale = dist3(lm[0], lm[9]);
  if (scale < 0.01) return null; // hand not visible / too small

  // ── Palm center (centroid of 4 MCP knuckles) ─────────────────────────
  const palm = {
    x: (lm[5].x  + lm[9].x  + lm[13].x + lm[17].x) * 0.25,
    y: (lm[5].y  + lm[9].y  + lm[13].y + lm[17].y) * 0.25,
    z: ((lm[5].z||0) + (lm[9].z||0) + (lm[13].z||0) + (lm[17].z||0)) * 0.25,
  };

  // ── Tip-to-palm ratios (direction-independent) ───────────────────────
  const idxR = dist3(lm[8],  palm) / scale;  // index tip
  const midR = dist3(lm[12], palm) / scale;  // middle tip
  const rngR = dist3(lm[16], palm) / scale;  // ring tip
  const pkyR = dist3(lm[20], palm) / scale;  // pinky tip
  const thmR = dist3(lm[4],  palm) / scale;  // thumb tip

  const T = CFG.FIST_THRESH; // ~0.72; extended fingers score > 1.0

  // A = Rock / Fist 👊 — ALL tips within the palm sphere (any orientation)
  if (idxR < T && midR < T && rngR < T && pkyR < T && thmR < T) return 'A';

  // ── Finger extension (y-axis, hand facing camera) ────────────────────
  const idxUp = lm[8].y  < lm[6].y;
  const midUp = lm[12].y < lm[10].y;
  const rngUp = lm[16].y < lm[14].y;
  const pkyUp = lm[20].y < lm[18].y;

  // D = Open Palm ✋ — all four fingers extended upward
  if (idxUp && midUp && rngUp && pkyUp) return 'D';

  // B = Victory ✌️ — index + middle up, ring + pinky down
  if (idxUp && midUp && !rngUp && !pkyUp) return 'B';

  // C = One Finger ☝️ — only index up
  if (idxUp && !midUp && !rngUp && !pkyUp) return 'C';

  return null;
}

// ===== MEDIAPIPE SETUP =====
let mpHands             = null;
let mpCamera            = null;   // webcam 模式：Camera class handle
let _rafHandle          = null;   // esp32cam 模式：RAF loop 執行中為 true，否則 null
let _esp32LatestImg     = null;   // esp32cam：fetch loop 最新抓到的幀
let _esp32ProcessingImg = null;   // esp32cam：MediaPipe 當前正在處理的幀

function initMediaPipe() {
  const video  = el('webcam');
  const canvas = el('cam-canvas');
  const ctx    = canvas.getContext('2d');

  mpHands = new Hands({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
  });
  mpHands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.55,
  });

  mpHands.onResults(results => {
    if (CAMERA_CFG.mode === 'esp32cam') {
      const src = _esp32ProcessingImg;
      if (src && src.naturalWidth) {
        canvas.width  = src.naturalWidth;
        canvas.height = src.naturalHeight;
        ctx.drawImage(src, 0, 0, canvas.width, canvas.height); // 原始幀畫進 canvas
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    } else {
      canvas.width  = video.videoWidth  || 320;
      canvas.height = video.videoHeight || 240;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    let detected = null;

    if (results.multiHandLandmarks?.length > 0) {
      const landmarks = results.multiHandLandmarks[0];

      if (window.drawConnectors && window.HAND_CONNECTIONS) {
        drawConnectors(ctx, landmarks, HAND_CONNECTIONS,
          { color: 'rgba(0,212,255,0.9)', lineWidth: 2 });
        drawLandmarks(ctx, landmarks,
          { color: '#ff6b6b', lineWidth: 1, radius: 3 });
      }

      detected = detectGesture(landmarks);
    }

    updateGestureUI(detected);
    if (state.phase === 'answering' && !state.gestureConfirmed) {
      processGestureInput(detected);
    }
  });

  if (CAMERA_CFG.mode === 'esp32cam') {
    _startESP32Cam();
  } else {
    _startWebcam(video);
  }
}

function _startWebcam(video) {
  mpCamera = new Camera(video, {
    onFrame: async () => { await mpHands.send({ image: video }); },
    width: 320,
    height: 240,
  });

  return mpCamera.start()
    .then(() => {
      el('overlay-loading').classList.add('hidden');
      el('cam-corner').classList.remove('hidden');
      startQuestion(state.qIndex);
    })
    .catch(err => {
      console.warn('Camera unavailable:', err);
      el('overlay-loading').innerHTML = `
        <div class="loading-card">
          <div style="font-size:3em;margin-bottom:16px">⚠️</div>
          <div class="loading-text" style="color:var(--red)">無法存取相機</div>
          <div class="loading-sub">請確認瀏覽器相機權限<br>或使用鍵盤 A / B / C / D 作答</div>
        </div>`;
      setTimeout(() => {
        el('overlay-loading').classList.add('hidden');
        startQuestion(state.qIndex);
      }, 2500);
    });
}

function _startESP32Cam() {
  const img       = el('esp32cam-img');
  const streamURL = CAMERA_CFG.esp32camURL;
  const { protocol, hostname } = new URL(streamURL);
  const snapURL = CAMERA_CFG.snapshotURL || `${protocol}//${hostname}/capture`;

  let started = false;

  el('overlay-loading').innerHTML = `
    <div class="loading-card">
      <div class="loading-spinner"></div>
      <div class="loading-text">連接 ESP32-CAM 串流中...</div>
      <div class="loading-sub">${streamURL}</div>
    </div>`;

  function _onReady() {
    if (started) return;
    started = true;
    el('cam-wrap').classList.add('no-mirror');
    el('webcam').style.display = 'none';
    // img 保持隱藏；canvas 負責顯示原始幀 + 骨架
    el('overlay-loading').classList.add('hidden');
    el('cam-corner').classList.remove('hidden');
    startQuestion(state.qIndex);
  }

  // ── Phase 1：MJPEG 串流（naturalWidth 輪詢確認第一幀）────────
  const mjpegPoll = setInterval(() => {
    if (img.naturalWidth > 0) {
      clearInterval(mjpegPoll);
      clearTimeout(globalTimeout);
      _esp32LatestImg = img;
      _onReady();
      _rafHandle = true;

      // 斷線時自動重連
      img.onerror = () => {
        if (!_rafHandle) return;
        console.warn('[ESP32-CAM] MJPEG 中斷，重新連線...');
        setTimeout(() => { if (_rafHandle) img.src = streamURL; }, 500);
      };

      (async function loop() {
        if (!_rafHandle) return;
        _esp32ProcessingImg = img;
        try { await mpHands.send({ image: img }); } catch {}
        requestAnimationFrame(loop);
      })();
    }
  }, 100);

  // ── MJPEG 失敗 → Phase 2：解耦快照模式 ──────────────────────
  img.onerror = () => {
    clearInterval(mjpegPoll);
    if (started) return;
    console.warn('[ESP32-CAM] MJPEG 失敗，切換快照模式:', snapURL);
    const sub = el('overlay-loading').querySelector('.loading-sub');
    if (sub) sub.textContent = `快照模式：${snapURL}`;
    _startSnapshotLoop(snapURL, _onReady);
  };

  img.src = streamURL;

  const globalTimeout = setTimeout(() => {
    clearInterval(mjpegPoll);
    if (started) return;
    started = true;
    _rafHandle = null;
    img.onload = null; img.onerror = null; img.src = '';
    _showESP32CamError(streamURL);
  }, 15000);
}

function _startSnapshotLoop(snapURL, onReady) {
  // Fetch loop 與 MediaPipe loop 完全解耦：
  //   fetch loop  — 固定頻率抓圖，更新 _esp32LatestImg
  //   MediaPipe   — RAF 取最新幀，不受網路速度阻塞
  _rafHandle = true;

  const SNAP_MS = 150;   // 抓圖間隔（~6fps，配合 ESP32-CAM 典型上限）

  const fetchLoop = setInterval(() => {
    if (!_rafHandle) { clearInterval(fetchLoop); return; }
    const tmp = new Image();
    tmp.crossOrigin = 'anonymous';
    tmp.onload = () => { _esp32LatestImg = tmp; onReady(); };
    tmp.src = `${snapURL}?_t=${Date.now()}`;
  }, SNAP_MS);

  (async function mpLoop() {
    if (!_rafHandle) { clearInterval(fetchLoop); return; }
    if (_esp32LatestImg) {
      _esp32ProcessingImg = _esp32LatestImg;   // 捕捉當前最新幀
      try { await mpHands.send({ image: _esp32ProcessingImg }); } catch {}
    }
    requestAnimationFrame(mpLoop);
  })();
}

function _showESP32CamError(url) {
  console.warn('[ESP32-CAM] 無法連線：', url);
  el('overlay-loading').innerHTML = `
    <div class="loading-card">
      <div style="font-size:3em;margin-bottom:16px">⚠️</div>
      <div class="loading-text" style="color:var(--red)">ESP32-CAM 無法連線</div>
      <div class="loading-sub">${url} 未回應<br>可改用鍵盤 A / B / C / D 作答</div>
    </div>`;
  setTimeout(() => {
    el('overlay-loading').classList.add('hidden');
    startQuestion(state.qIndex);
  }, 2500);
}

function updateGestureUI(gesture) {
  const textEl = el('gd-text');
  const barEl  = el('gd-bar');

  textEl.textContent = gesture ? GESTURE_NAMES[gesture] : '--';

  if (gesture && gesture === state.lastGesture && state.gestureHoldStart) {
    const pct = Math.min(100, ((Date.now() - state.gestureHoldStart) / CFG.GESTURE_HOLD_MS) * 100);
    barEl.style.width      = pct + '%';
    barEl.style.background = pct >= 100 ? 'var(--green)' : 'var(--cyan)';
  } else {
    barEl.style.width = '0%';
  }
}

function processGestureInput(gesture) {
  const now = Date.now();

  if (gesture !== state.lastGesture) {
    state.lastGesture      = gesture;
    state.gestureHoldStart = gesture ? now : null;
    state.gestureBuffer    = [];
    return;
  }

  if (!gesture) return;

  state.gestureBuffer.push(gesture);
  if (state.gestureBuffer.length >= CFG.BUFFER_SIZE) state.gestureBuffer.shift();

  if ((now - state.gestureHoldStart) < CFG.GESTURE_HOLD_MS) return;

  const matchCount = state.gestureBuffer.filter(g => g === gesture).length;
  const needed = Math.min(CFG.BUFFER_MIN_MATCH, Math.floor(state.gestureBuffer.length * 0.7));
  if (matchCount >= needed) confirmAnswer(gesture);
}

// ===== RANDOM SELECTION =====
// shuffleArray() 來自 ../lib/shuffle.js（single/ 與 multi/ 共用）
function pickQuestions(pool, n) {
  return shuffleArray(pool).slice(0, Math.min(n, pool.length));
}

// ===== INIT — load questions =====
function setCamStatus(status, text) {
  const wrap = document.getElementById('cam-status-wrap');
  const txt  = document.getElementById('cam-status-text');
  if (!wrap || !txt) return;
  wrap.className    = `cam-status-wrap cam-${status}`;
  txt.textContent   = text;
}

async function init() {
  sound.init();
  L2D.init();        // non-blocking — game works even if Live2D fails
  mqttSound.init();  // non-blocking — game works even if MQTT unavailable

  el('bank-name').textContent = QUESTION_BANK;

  try {
    const resp = await fetch(QUESTION_BANK);
    if (resp.ok) {
      const data = await resp.json();
      allQuestions = Array.isArray(data) && data.length > 0 ? data : BUILTIN_QUESTIONS;
    } else {
      console.warn('[Bank] 找不到', QUESTION_BANK, '，改用內建題庫');
      allQuestions = BUILTIN_QUESTIONS;
    }
  } catch {
    console.warn('[Bank] 載入失敗，改用內建題庫');
    allQuestions = BUILTIN_QUESTIONS;
  }

  const perGame = Math.min(CFG.GAME_Q_COUNT, allQuestions.length);
  el('total-q-count').textContent = perGame;
  el('pool-q-count').textContent  = allQuestions.length;
  el('q-total').textContent       = perGame;
  el('f-total').textContent       = perGame;

  initCamSourceUI();
}

function _checkWebcam() {
  setCamStatus('checking', '偵測相機中...');
  el('btn-start').disabled = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    setCamStatus('error', '瀏覽器不支援相機（可用鍵盤作答）');
    el('btn-start').disabled = false;
    return;
  }
  navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    .then(stream => {
      stream.getTracks().forEach(t => t.stop());
      setCamStatus('ready', '相機就緒');
      el('btn-start').disabled = false;
    })
    .catch(() => {
      setCamStatus('error', '相機未連接（可用鍵盤作答）');
      el('btn-start').disabled = false;
    });
}

function _checkESP32Cam() {
  let pingURL;
  try {
    const { protocol, hostname } = new URL(CAMERA_CFG.esp32camURL.trim());
    pingURL = `${protocol}//${hostname}/`;
  } catch {
    setCamStatus('error', 'URL 格式錯誤');
    el('btn-start').disabled = false;
    return;
  }
  setCamStatus('checking', 'ESP32-CAM 確認中...');
  el('btn-start').disabled = true;
  const ctrl = new AbortController();
  const tmo  = setTimeout(() => ctrl.abort(), 3000);
  fetch(pingURL, { signal: ctrl.signal, mode: 'no-cors' })
    .then(() => { clearTimeout(tmo); setCamStatus('ready', 'ESP32-CAM 就緒');         el('btn-start').disabled = false; })
    .catch(()  => {                   setCamStatus('error', 'ESP32-CAM 無法連線（可用鍵盤）'); el('btn-start').disabled = false; });
}

function initCamSourceUI() {
  const btnWebcam = el('btn-src-webcam');
  const btnEsp32  = el('btn-src-esp32');
  const urlWrap   = el('esp32cam-url-wrap');
  const urlInput  = el('esp32cam-url-input');

  urlInput.value = CAMERA_CFG.esp32camURL;

  function setMode(mode) {
    CAMERA_CFG.mode = mode;
    const isEsp = mode === 'esp32cam';
    btnWebcam.classList.toggle('active', !isEsp);
    btnEsp32.classList.toggle('active',   isEsp);
    urlWrap.classList.toggle('hidden',   !isEsp);

    // 停止舊的相機串流，讓 startGame() 重新初始化
    if (mpCamera) { try { mpCamera.stop(); } catch {} mpCamera = null; }
    _rafHandle = null;
    _esp32LatestImg = null;
    _esp32ProcessingImg = null;
    const img = el('esp32cam-img');
    img.onload = null; img.onerror = null; img.src = '';

    if (isEsp) _checkESP32Cam(); else _checkWebcam();
  }

  btnWebcam.addEventListener('click', () => setMode('webcam'));
  btnEsp32.addEventListener('click',  () => setMode('esp32cam'));

  function applyURL() {
    CAMERA_CFG.esp32camURL = urlInput.value.trim();
    if (CAMERA_CFG.mode === 'esp32cam') _checkESP32Cam();
  }

  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyURL(); });
  el('btn-esp32cam-check').addEventListener('click', applyURL);

  // 熱插拔僅 webcam 模式有意義
  navigator.mediaDevices?.addEventListener('devicechange', async () => {
    if (CAMERA_CFG.mode !== 'webcam') return;
    try {
      const devices   = await navigator.mediaDevices.enumerateDevices();
      const hasCamera = devices.some(d => d.kind === 'videoinput');
      setCamStatus(hasCamera ? 'ready' : 'error', hasCamera ? '相機就緒' : '相機已拔除');
    } catch {}
  });

  setMode(CAMERA_CFG.mode);   // 依初始設定執行首次檢查
}

// ===== GAME FLOW =====
function startGame() {
  sound.resume();
  clearTimers();

  state.questions = pickQuestions(allQuestions, CFG.GAME_Q_COUNT);
  state.qIndex    = 0;
  state.score     = 0;
  state.gameLog   = [];
  mqttSound.resetStreak();

  const count = state.questions.length;
  el('q-total').textContent = count;
  el('f-total').textContent = count;
  updateScore();

  showScreen('screen-game');
  showOverlay('overlay-loading');
  hideEl('cam-corner');

  L2D.play('appeal');

  if (mpCamera || _rafHandle) {
    // 相機串流已在執行中，直接開始答題
    el('overlay-loading').classList.add('hidden');
    el('cam-corner').classList.remove('hidden');
    startQuestion(0);
  } else {
    initMediaPipe();
  }
}

function startQuestion(idx) {
  const q = state.questions[idx];
  state.gestureConfirmed = false;
  state.lastGesture      = null;
  state.gestureHoldStart = null;
  state.gestureBuffer    = [];

  clearTimers();
  hideAll();

  const pct = (idx / state.questions.length) * 100;
  el('progress-bar').style.width = pct + '%';
  el('q-current').textContent    = idx + 1;

  el('q-domain').textContent   = q.domain || '';
  el('q-text').textContent     = q.question;
  el('opt-A-text').textContent = q.options.A;
  el('opt-B-text').textContent = q.options.B;
  el('opt-C-text').textContent = q.options.C;
  el('opt-D-text').textContent = q.options.D;

  ['A','B','C','D'].forEach(k => { el('opt-' + k).className = 'option'; });

  const card = el('q-card');
  card.classList.remove('slide-out');
  void card.offsetWidth;

  sound.swipe();
  startPrepare();
}

function startPrepare() {
  state.phase = 'prepare';
  showOverlay('overlay-prepare');

  let count = CFG.PREPARE_TIME;
  setPrepareCount(count);
  sound.tick();

  L2D.play('puzzle');       // thinking / reading the question

  state.timerId = setInterval(() => {
    count--;
    if (count > 0) {
      setPrepareCount(count);
      sound.tick();
    } else {
      clearInterval(state.timerId);
      sound.finalTick();
      startAnswering();
    }
  }, 1000);
}

function setPrepareCount(n) {
  const e = el('prepare-count');
  e.textContent = n;
  e.classList.remove('count-anim');
  void e.offsetWidth;
  e.classList.add('count-anim');
}

function startAnswering() {
  state.phase = 'answering';
  hideOverlay('overlay-prepare');
  showEl('timer-wrap');
  L2D.play('wait');         // attentive idle while player gestures
  L2D.stopIdleChat();
  L2D.dismissAll();

  let count = CFG.ANSWER_TIME;
  const numEl = el('timer-num');
  numEl.textContent = count;
  numEl.className   = 'timer-num';

  state.timerId = setInterval(() => {
    count--;
    numEl.textContent = count;
    if (count <= 3 && count > 0) {
      numEl.className = 'timer-num urgent';
      sound.tick();
    }
    if (count <= 0) {
      clearInterval(state.timerId);
      confirmAnswer(null);
    }
  }, 1000);
}

function confirmAnswer(letter) {
  if (state.gestureConfirmed) return;
  state.gestureConfirmed = true;
  clearTimers();
  L2D.stopIdleChat();

  state.phase = 'answered';
  hideEl('timer-wrap');

  if (letter) {
    sound.select();
    el('selected-letter').textContent = letter + ' ' + GESTURE_EMOJIS[letter];
    showEl('selected-banner');
    el('opt-' + letter).classList.add('selected');
  }

  state.timerId2 = setTimeout(() => showResult(letter), 600);
}

function showResult(letter) {
  state.phase = 'result';
  hideEl('selected-banner');

  const q       = state.questions[state.qIndex];
  const correct = letter === q.answer;

  // 記錄本題作答
  state.gameLog.push({
    no:        state.qIndex + 1,
    domain:    q.domain || '未分類',
    question:  q.question,
    options:   q.options,
    chosen:    letter,
    correct:   q.answer,
    isCorrect: correct,
  });
  mqttSound.onResult(correct);

  if (correct) {
    state.score++;
    sound.correct();
    L2D.play('happy');
    L2D.play('boundx2', 900);
    L2D.playRandom2(0, ['idle', 'home', 'login', 'mission', 'mail']);
  } else if (letter) {
    sound.wrong();
    L2D.play('sad');
    L2D.play('sad_e', 600);
    L2D.playRandom2(0, ['idle', 'home', 'login', 'mission', 'mail']);
  } else {
    // timeout — no answer
    sound.wrong();
    L2D.play('shame');
    L2D.playRandom2(0, ['idle', 'home', 'login', 'mission', 'mail']);
  }
  updateScore();

  if (letter) {
    el('opt-' + letter).classList.remove('selected');
    el('opt-' + letter).classList.add(correct ? 'correct' : 'wrong');
  }
  el('opt-' + q.answer).classList.add('correct');

  const iconEl = el('result-icon');
  const textEl = el('result-text');
  const subEl  = el('result-sub');

  if (correct) {
    iconEl.textContent = '⭕';
    textEl.textContent = '正確！';
    textEl.className   = 'result-text is-correct';
    subEl.textContent  = '';
  } else if (letter) {
    iconEl.textContent = '❌';
    textEl.textContent = '錯誤';
    textEl.className   = 'result-text is-wrong';
    subEl.textContent  = '你的答案：' + letter;
  } else {
    iconEl.textContent = '⏰';
    textEl.textContent = '時間到！';
    textEl.className   = 'result-text is-wrong';
    subEl.textContent  = '未作答';
  }
  showOverlay('overlay-result');

  state.timerId2 = setTimeout(() => showExplanation(q), CFG.RESULT_SHOW_MS);
}

function showExplanation(q) {
  state.phase = 'explanation';
  hideOverlay('overlay-result');

  L2D.play('serious');          // teacher mode — calm, explaining
  el('expl-answer').textContent = q.answer + '.  ' + q.options[q.answer];
  el('expl-text').textContent   = q.explanation;
  showOverlay('overlay-expl');

  state.timerId2 = setTimeout(nextQuestion, CFG.EXPL_SHOW_MS);
}

function nextQuestion() {
  hideOverlay('overlay-expl');
  state.qIndex++;

  if (state.qIndex >= state.questions.length) {
    endGame();
    return;
  }

  L2D.play('appeal');           // "next one — you've got this!"
  const card = el('q-card');
  card.classList.add('slide-out');
  state.timerId2 = setTimeout(() => startQuestion(state.qIndex), 320);
}

function endGame() {
  el('progress-bar').style.width = '100%';
  const total   = state.questions.length;
  const correct = state.score;
  const wrong   = total - correct;
  const rate    = Math.round((correct / total) * 100);

  el('f-total').textContent   = total;
  el('f-correct').textContent = correct;
  el('f-wrong').textContent   = wrong;
  el('f-rate').textContent    = rate + '%';
  el('finish-emoji').textContent =
    rate >= 90 ? '🏆' : rate >= 70 ? '🎉' : rate >= 50 ? '👍' : '📚';

  // Character reacts to final score
  if (rate >= 90) {
    L2D.play('excite');
    L2D.play('boundx2', 800);
  } else if (rate >= 70) {
    L2D.play('happy2');
    L2D.play('bound', 700);
  } else if (rate >= 50) {
    L2D.play('appeal');
  } else {
    L2D.play('cry');
    L2D.play('sad', 1200);
  }

  showScreen('screen-finish');
  mqttSound.onFinish(correct, total);
  downloadGameLog();
}

// ===== GAME LOG DOWNLOAD =====
function downloadGameLog() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const filename = `${dateStr}_${timeStr}_${QUESTION_BANK_LABEL}.txt`;

  const total   = state.gameLog.length;
  const correct = state.gameLog.filter(e => e.isCorrect).length;
  const wrong   = total - correct;
  const rate    = total > 0 ? Math.round(correct / total * 100) : 0;

  const SEP  = '══════════════════════════════════════════════';
  const LINE = '──────────────────────────────────────────────';
  const lines = [];

  lines.push(SEP);
  lines.push('  手勢互動問答遊戲  作答紀錄');
  lines.push(`  日期時間：${dateStr.replace(/-/g,'/')}  ${timeStr.replace(/-/g,':')}`);
  lines.push(`  題庫：${QUESTION_BANK_LABEL}（${QUESTION_BANK}）`);
  lines.push(`  成績：${correct} / ${total}（${rate}%）`);
  lines.push(SEP);
  lines.push('');

  state.gameLog.forEach(e => {
    lines.push(`[第 ${e.no} 題]  ${e.domain}`);
    lines.push(`  題目：${e.question}`);
    lines.push(`  A. ${e.options.A}`);
    lines.push(`  B. ${e.options.B}`);
    lines.push(`  C. ${e.options.C}`);
    lines.push(`  D. ${e.options.D}`);
    lines.push(LINE);
    const chosenLabel = e.chosen ? e.chosen : '超時（未作答）';
    const mark        = e.isCorrect ? '✓ 答對' : '✗ 答錯';
    lines.push(`  你的答案：${chosenLabel}　正確答案：${e.correct}　${mark}`);
    lines.push('');
  });

  lines.push(LINE);
  lines.push(`  答對 ${correct} 題 ／ 答錯 ${wrong} 題 ／ 正確率 ${rate}%`);
  lines.push(SEP);

  // '﻿' = UTF-8 BOM，確保 Windows 記事本正確顯示中文
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ===== UI HELPERS =====
function el(id)          { return document.getElementById(id); }
function showScreen(id)  { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); el(id).classList.add('active'); }
function showOverlay(id) { el(id).classList.remove('hidden'); }
function hideOverlay(id) { el(id).classList.add('hidden'); }
function showEl(id)      { el(id).classList.remove('hidden'); }
function hideEl(id)      { el(id).classList.add('hidden'); }
function updateScore()   { el('score-val').textContent = state.score; }
function clearTimers()   { clearInterval(state.timerId); clearTimeout(state.timerId2); }

function hideAll() {
  ['overlay-prepare','overlay-result','overlay-expl',
   'timer-wrap','selected-banner','overlay-loading'].forEach(hideEl);
}

function toggleFullscreen() {
  if (!document.fullscreenElement)
    document.documentElement.requestFullscreen().catch(() => {});
  else
    document.exitFullscreen().catch(() => {});
}

// ===== KEYBOARD FALLBACK (A/B/C/D) =====
document.addEventListener('keydown', e => {
  if (state.phase !== 'answering') return;
  const k = e.key.toUpperCase();
  if (['A','B','C','D'].includes(k)) confirmAnswer(k);
});

// ===== EVENT LISTENERS =====
document.getElementById('btn-start').addEventListener('click',      () => { sound.resume(); startGame(); });
document.getElementById('btn-restart').addEventListener('click',    () => { sound.resume(); startGame(); });
document.getElementById('btn-fullscreen').addEventListener('click',  toggleFullscreen);
document.getElementById('btn-fullscreen2').addEventListener('click', toggleFullscreen);
document.addEventListener('click', () => { if (sound.ctx) sound.resume(); });

// ===== STARTUP =====
init();
