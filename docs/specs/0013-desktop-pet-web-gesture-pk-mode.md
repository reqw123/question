# desktop-pet-web：手勢 PK 對戰模式（雙人區網對戰，MQTT + MediaPipe GestureRecognizer）

> **狀態**：已實作（2026-08-18）。程式碼＋單元測試已完成，`tsc -b`／`oxlint`／`vitest run`／`vite build` 均已跑過且全過，**手動瀏覽器/雙手機驗證（Acceptance Criteria）尚未執行**，且有一項已知風險尚未驗證會不會直接擋死功能（見文末「實作備註」跟新增的「已知風險」段落）。
> **打算套用的 triage 標籤**：`ready-for-agent`。
> **依賴**：`docs/adr/0014-desktop-pet-web-gesture-pk-mode-scope.md`（為什麼選「一個擂台端＋兩支遙控器」而不是雙端各自完整同步、為什麼不做房間碼、為什麼防禦是持續狀態而不是邊緣觸發，務必先讀）、`CONTEXT.md`（「手勢 PK 對戰模式」「擂台端」「操控端」跟「手勢動作觸發」「手勢拖曳」的用詞區分）、`src/pages/desktop-pet/components/Aatrox3DShowcase.tsx`（PK 模式的進入按鈕、three.js 渲染/動畫混合的既有寫法都沿用這裡）、`src/pages/desktop-pet/components/aatrox-gesture/`（手勢辨識載入慣例、`gestureTriggerState.ts` 的邊緣觸發模式，這次的防禦手勢要另外寫一個持續狀態版本）、`multi/multiplay.js`（`MP_TOPICS`／`MP_CFG` 的 MQTT topic/心跳/斷線判定慣例，這次直接沿用同一套心智模型，只是換一個 topic 命名空間）。

## Problem Statement (Goal)

desktop-pet-web 已經有兩個 3D 角色模型可用（Aatrox、`菁英計畫_魔鬥凱薩.glb`／Mordekaiser），也已經有手勢辨識的基礎設施（`gesture-drag/`、`aatrox-gesture/`）。使用者想要一個更大型、更有展示性的功能：**兩位玩家在同一個區網下，一台裝置開全螢幕擂台畫面顯示兩個角色對打，兩人各自拿自己的手機比手勢操控攻擊／防禦／跳躍**，藉此把「手勢」「3D 模型」「區網多人」這幾個已經分別驗證過的技術兜成一個完整的娛樂功能。

## Solution

### 角色分工：擂台端 vs 操控端

跟現有 `multi/` 的 host/player 架構是同一種心智模型（`docs/adr/0014` 有完整理由），**2026-08-18 修訂**：擂台端本人就是玩家一，不是中立的第三方顯示器，只有玩家二需要另一支手機（見 ADR-0014 修訂記錄）：

- **擂台端＝玩家一**：一台裝置（通常是桌機瀏覽器）點擊 Aatrox3DShowcase 卡片裡新增的「PK 對戰模式」按鈕，進入全螢幕，實際渲染兩個 3D 角色、做碰撞/命中判定、播動畫、顯示血量，是這場對戰唯一的「真相來源」——同時這台裝置**自己也要開鏡頭**，操作者本人就是玩家一（Aatrox），鏡頭/手勢辨識邏輯跟操控端是同一套（`gestureTriggerState.ts`／`pkDefenseState.ts`），差別只在觸發後直接呼叫本機的比賽狀態機，不繞 MQTT。
- **操控端＝玩家二**：另一位玩家在自己的手機瀏覽器開同一個 desktop-pet-web 網址、路徑換成 `/pk`（`PK_CONTROLLER_PATH`，見 `pkJoinUrl.ts`；2026-08-18 從 `?role=controller` query string 改成短路徑，見文末實作備註），開鏡頭比手勢，**不做任何 3D 渲染**，只負責把手勢辨識結果變成離散事件發布到 MQTT，同時訂閱 `pk/state` 顯示自己的連線/血量狀態。

### 連線與配對

- 複用現有 Mosquitto broker（見 `multi/multiplay.js` 的 `mpMqttUrl()`：區網 `ws://IP:9001`、公網走 Caddy `wss://.../mqtt`），這次的訊息走全新的 `pk/*` 命名空間，不會跟 `multi/` 既有的 `quiz/multi/*` 撞名，兩套系統可以同時獨立運作。
- **單一場次假設**：擂台端啟動時，`pk/state`（retained）視為「目前這場對戰」的唯一真相，不做房間碼。擂台端自己的鏡頭一授權成功，立刻用固定的本機 `playerId`（`LOCAL_PLAYER_ID`）呼叫 `applyJoin()` 佔走玩家一（Aatrox）；操控端連上時發布 `pk/join`（payload 帶一個 `playerId`，第一次進頁面時用 `Math.random()` 產生、存進 `localStorage`，重新整理頁面也是同一個 id——不用 `crypto.randomUUID()`，見文末實作備註），落在玩家二（Mordekaiser）。第三個以上的裝置嘗試加入會被擂台端忽略（`pk/state` 裡兩個角色都已經有 `playerId` 就不再接受新的 join）。
- 同一個 `playerId` 重新 join（例如手機重新整理）視為**重新連線**，沿用原本的角色跟血量，不是新玩家。

### 訊息協定（`pk/*`）

跟 `multi/multiplay.js` 的 `MP_TOPICS` 同一種寫法，定義在新檔案 `pkProtocol.ts`：

```ts
export const PK_TOPICS = {
  JOIN:      'pk/join',       // controller → arena, { playerId }
  STATE:     'pk/state',      // arena → all (retained), 完整比賽狀態
  INPUT:     'pk/input',      // controller → arena, 手勢事件（見下方 payload）
  HEARTBEAT: 'pk/heartbeat',  // controller → arena, { playerId, defending }
}
```

`pk/input` 的 payload 是一個 union type：

```ts
type PkInputMessage =
  | { playerId: string; type: 'attack' | 'jump' }              // 邊緣觸發的單次事件
  | { playerId: string; type: 'defense'; defending: boolean }  // 持續狀態的變化（進入/離開防禦都送一次）
  | { playerId: string; type: 'move'; value: number }          // 連續數值 -1..1，2026-08-18 新增
```

`pk/state`（arena 端維護、每次狀態變化就重新發布一次 retained 訊息，操控端純訂閱顯示用）：

```ts
type PkMatchState = {
  phase: 'waiting' | 'countdown' | 'battle' | 'paused' | 'finished'
  countdown?: number          // phase==='countdown' 時，3→2→1
  player1: PkPlayerState | null  // Aatrox
  player2: PkPlayerState | null  // Mordekaiser
  winner?: 'player1' | 'player2'
}
type PkPlayerState = {
  playerId: string
  connected: boolean   // 心跳是否在 OFFLINE_MS 門檻內
  hp: number            // 0-100
  defending: boolean
}
```

`pk/heartbeat` 沿用 `multi/` 的 `HEARTBEAT_MS=3000`／`OFFLINE_MS=10000` 這組數字（見 `MP_CFG`），操控端每 3 秒送一次，payload 順手帶上目前的 `defending` 狀態——這是防禦狀態的**保底同步**：就算某一次 `pk/input` 的 defense 事件因為網路問題沒送到，最多 3 秒後下一次心跳就會自我修正，不會卡在「明明放手了、擂台端還以為在防禦」的狀態。

### 流程

1. 擂台端點擊「PK 對戰模式」→ `document.documentElement.requestFullscreen()` → 卸載整個 `DesktopPetPage` 的其餘內容，改渲染 `PkArenaView`（見 Implementation Decisions「資源釋放」）→ 訂閱 `pk/join`／`pk/input`／`pk/heartbeat`，`phase` 設為 `'waiting'`，同時擂台端自己要求鏡頭權限（畫面左下角 PIP，見下方「攝影機授權」）。
2. 擂台端鏡頭授權成功 → 自動 join 成為玩家一 → 畫面顯示「等待對手加入」＋一個可以掃碼/複製的操控頁網址（`{協定}//{host}:{port}/pk`）。操控頁玩家（玩家二）開啟該網址 → 要求鏡頭權限 → 發布 `pk/join` → 擂台端分配 `player2`，發布更新後的 `pk/state`。
3. 兩人都連上（`player1`/`player2` 皆非 null）→ `phase` 轉成 `'countdown'`，倒數 3 秒（`pk/state` 每秒更新 `countdown` 欄位），倒數期間收到的手勢事件擂台端一律忽略（不處理攻擊/防禦/跳躍）。
4. 倒數結束 → `phase` 轉成 `'battle'`，開始接受手勢事件、做命中判定（見下方）。
5. 任一方 `hp` 歸零 → `phase` 轉成 `'finished'`，播放該方的 `Death` 動畫、`pk/state` 帶上 `winner`，畫面顯示勝負結果。
6. 擂台端離開全螢幕（按 ESC 或畫面上的退出鈕）→ `fullscreenchange` 事件觸發 → 結束整場 PK（不保留對戰狀態）、卸載 `PkArenaView`、`DesktopPetPage` 恢復原本內容。

### 手勢輸入與命中判定

- **移動**（2026-08-18 新增）＝手在鏡頭畫面裡的左右位置**連續**控制前進/後退，跟下面三個「手勢分類」不同，這裡讀的是 MediaPipe 回報的 landmark 座標（連續數值），跟手的形狀無關，可以跟任何手勢同時發生（例如邊移動邊防禦）。純函式在 `pkMovement.ts`（`handToMoveValue()`），死區內（畫面正中央附近）不動，死區外線性映射到 -1..1，正值前進（靠近對手）、負值後退（遠離對手）。純視覺位置效果，不進 `pkMatchState.ts` 的比賽狀態機，見下面「移動與攻擊距離」。
- **攻擊**＝✊ `Closed_Fist`，邊緣觸發（複用 `gestureTriggerState.ts` 的邊緣觸發模式，`TRIGGER_GESTURE` 換成 `Closed_Fist`）。**2026-08-18 修訂**：現在還要求距離夠近才會真的命中，見下面「移動與攻擊距離」。
- **跳躍**＝✌️ `Victory`，邊緣觸發，觸發後擂台端讓該角色的 `position.y` 疊加一段 `Math.sin` 拋物線位移（不換動畫，跟目前正在播的動畫無關），跳躍期間不影響攻擊/防禦判定，也不影響前後移動（Y 軸位移跟 X 軸移動是獨立的兩件事）。
- **防禦**＝🖐️ `Open_Palm`，**持續狀態**，需要新的狀態機（`pkDefenseState.ts`）：跟 `gestureTriggerState.ts` 一樣有 `STABLE_FRAMES` 防手震門檻，但雙向都要回報「狀態真的改變了」（進入防禦、離開防禦都要通知），不是只偵測單向的邊緣。
- 命中判定：擂台端收到 `type: 'attack'` 事件時，**先檢查距離**（見下面「移動與攻擊距離」）——搆不到直接算揮空，不繼續判定；搆得到才檢查**對方**目前的 `defending` 是不是 `true`——是→格擋（不扣血，可以加一個格擋視覺回饋，例如攻擊方武器揮空的音效/特效留到之後迭代）；不是→命中，`hp -= ATTACK_DAMAGE`（預設 `ATTACK_DAMAGE=20`，5 次命中致死，這個數字是可調的實作細節，不是本次要鎖死的規格）。

### 移動與攻擊距離（2026-08-18 新增，見 `docs/adr/0014` 修訂記錄）

原始設計「命中判定跟角色 3D 位置完全無關」被部分推翻——使用者要求更接近真實格鬥遊戲的手感：手控制前進/後退，攻擊要真的靠近對方身體才會命中。

- 每個角色只能沿著「面對面那條軸」移動（一個自由度，不能左右閃避/繞背），移動範圍限制兩端：**不能退得比出生點還遠**（`rig.baseX`），**不能貼到/穿過對方**（`clampMutualGap()`，依兩個角色身高換算出最小距離，兩人一起算，不是各自獨立判定）。
- 移動速度／最小距離／攻擊距離都是「依角色身高換算的比例常數」（`MOVE_SPEED_HEIGHT_RATIO`／`MIN_GAP_HEIGHT_RATIO`／`ATTACK_RANGE_HEIGHT_RATIO`，見 `pkProtocol.ts`／`PkArenaView.tsx`），不是寫死的絕對世界座標數字——兩個角色的模型大小不保證完全一致。
- 位置狀態**只存在擂台端**（`CharacterRig.root.position`），不透過 wire protocol 同步給操控端——操控端本來就不做 3D 渲染，不需要知道位置，這保留了 ADR-0014 決定 1 的核心精神（不用處理雙端位置同步/誤差校正）。
- 攻擊距離判定在擂台端本機做（`isWithinAttackRange()`），**不進 `pkMatchState.ts` 的 reducer**——`applyInput()` 完全不知道「距離」這個概念，範圍檢查在呼叫 `applyInput()` 之前先做，搆不到就直接不呼叫，動作照樣揮出去（有視覺回饋）但不會觸發命中判定。維持 reducer 只管規則（血量/回合/連線）、不沾染空間座標概念，是刻意的分工。

### 攝影機授權（玩家一／擂台端本人）

`PkArenaView` 掛載時就要求玩家一（本人）的鏡頭權限，跟操控端走同一套 `requesting`／`active`／`error` 狀態：

- `requesting`：畫面左下角 PIP 顯示「等待鏡頭權限…」，這個階段還沒 join，`pk/state` 的 `player1` 仍是 `null`。
- `active`：授權成功，PIP 顯示鏡頭畫面＋骨架疊圖＋目前偵測到的手勢文字（跟操控端一致），**這時候才呼叫 `applyJoin()` 讓玩家一正式加入比賽**——不是掛載當下就 join，避免比賽開始了玩家一卻因為還沒授權完全沒辦法出手。
- `error`（權限被拒絕、瀏覽器不支援等）：PIP 顯示錯誤訊息＋「重試」按鈕，按下去只重新跑鏡頭/手勢這一小段（不影響 MQTT 連線、不重新載入 3D 模型、不影響玩家二已經連上的狀態），實作上是獨立的 React effect、用一個 retry counter 當依賴項觸發重跑，見 Implementation Decisions。

## User Stories (Requirements)

1. As 擂台端使用者（玩家一），I want 點一顆按鈕就能進入全螢幕 PK 模式、給自己的鏡頭權限後自動變成玩家一，so that 不需要額外的設定流程、不用另一支手機就能開始邀朋友對戰。
2. As 操控端玩家（玩家二），I want 開啟一個網址、給鏡頭權限，就能加入對戰，so that 不用安裝 App、不用輸入房間碼——加入的當下遊戲就自動開始倒數，不用再等第三個人。
3. As 操控端玩家，I want 比出攻擊/防禦/跳躍手勢時，擂台畫面上「我的角色」立刻有對應反應，so that 我清楚知道自己的手勢有沒有生效。
4. As 兩位玩家之一，I want 舉着防禦手勢時真的能擋下對方的攻擊，放下就沒有這個效果，so that 這是一個需要抓時機的互動，不是單純比一次就過關。
5. As 玩家，I want 對戰開始前有倒數，so that 不會在還沒準備好的時候就被打。
6. As 玩家，I want 手機斷線/黑屏時對戰會暫停等我重連，而不是直接輸掉，so that 意外的網路問題不會毀掉整場對戰。
7. As 擂台端使用者，I want 按 ESC 能直接結束整場 PK 回到原本的頁面，so that 這個行為跟這個專案其他地方的 ESC 一致、可預測。
8. As 開發者（未來的我），I want 擂台端的比賽狀態機、命中判定、防禦邊緣偵測都是純函式，so that 不需要真的開兩支手機就能寫單元測試驗證核心規則。

## Implementation Decisions

### 檔案清單（建議實作順序，每一步都能獨立驗證）

1. `src/pages/desktop-pet/pk-mode/pkProtocol.ts`——topic 常數 + payload 型別（見上方協定），純型別/常數，沒有邏輯。
2. `src/pages/desktop-pet/pk-mode/pkMatchState.ts`——純函式的比賽狀態 reducer：`join(state, playerId)`、`applyInput(state, message)`、`tickCountdown(state)`、`applyHeartbeat(state, playerId, defending, now)`、`markOffline(state, now, offlineMs)`。不碰 MQTT/three.js，方便直接單元測試命中判定/血量/勝負這些核心規則。
3. `src/pages/desktop-pet/pk-mode/pkDefenseState.ts`——防禦手勢的持續狀態邊緣偵測（進出都要回報），純函式，比照 `aatrox-gesture/gestureTriggerState.ts` 的風格但雙向。
4. `src/pages/desktop-pet/pk-mode/pkAnimationMap.ts`——兩個角色的動作對照表（見下方「動畫對照表」），純資料。
5. `src/pages/desktop-pet/pk-mode/PkControllerView.tsx`——操控端頁面：複用 `AatroxGestureTrigger.tsx` 的鏡頭/`GestureRecognizer` 載入寫法，換成同時判斷三種手勢（攻擊/跳躍走 `gestureTriggerState.ts` 邊緣觸發、防禦走 `pkDefenseState.ts`），用 `mqtt` 套件發布 `pk/join`／`pk/input`／`pk/heartbeat`，訂閱 `pk/state` 顯示自己的連線/血量。**可以獨立於擂台端先做完**：訂閱端隨便寫一個假的 MQTT 訂閱腳本印訊息，就能驗證操控端本身有沒有正確發布事件。
6. `src/pages/desktop-pet/pk-mode/PkArenaView.tsx`——擂台端：three.js 場景（兩個角色面對面、固定鏡頭，不像 Aatrox3DShowcase 那樣給使用者 `OrbitControls` 自由轉視角）、訂閱 `pk/join`／`pk/input`／`pk/heartbeat`、跑 `pkMatchState.ts` 的 reducer、渲染血量條/倒數/勝負畫面、`requestFullscreen()`／`fullscreenchange` 監聽。
7. `Aatrox3DShowcase.tsx` 新增第三顆「PK 對戰模式」按鈕；`DesktopPetPage.tsx` 新增 `pkArenaActive` state，`onEnterPkArena` 往下傳給 Aatrox3DShowcase，`pkArenaActive` 為 true 時整個 `<main>` 提早 return `<PkArenaView onExit={() => setPkArenaActive(false)} />`，不渲染 Hero/ControlPanel/Features/…（見下方「資源釋放」）。
8. `App.tsx` 讀 `new URLSearchParams(window.location.search).get('role')`，`'controller'` 時渲染 `<PkControllerView />`，否則照舊渲染 `<DesktopPetPage />`。

### 資源釋放：靠 React unmount，不用額外手動清理清單

Q（訪談時使用者提到「進入 PK 模式期間釋放其他無關資源」）的答案不是另外寫一份「進入 PK 模式時要關掉哪些東西」的清單，而是架構上讓它自動發生：`pkArenaActive===true` 時 `DesktopPetPage` 整個 `<main>` 提早 return，Hero（PIXI 畫布＋手勢拖曳鏡頭）、Aatrox3DShowcase（three.js WebGLRenderer＋自己的鏡頭）全部隨著 unmount 觸發各自既有的 cleanup（`renderer.dispose()`／`recognizer.close()`／`stream.getTracks().forEach(t=>t.stop())`……這些都已經寫好了，不需要新寫）。回到原本頁面時這些元件重新 mount，跟第一次載入頁面走的是同一條路徑，不需要額外的「恢復」邏輯。

### 動畫對照表（`pkAnimationMap.ts`）

查證過兩個模型的動畫清單（`aatrox-crimson-moon.glb`／`菁英計畫_魔鬥凱薩.glb`），這幾個 clip 名稱兩邊都有：`Attack1`／`Attack2`／`Crit`／`Death`／`Respawn`／`Recall`／`Recall_Winddown`／`Taunt_loop`／`Joke`／`Laugh`／`Dance_Loop`／`Channel_Wndup`。防禦動畫兩邊不對稱（Mordekaiser 有明確的護盾動畫，Aatrox 沒有對應物），idle 動畫也各自選最貼切的：

```ts
export const PK_ANIMATION_MAP = {
  player1: { // Aatrox
    idle: 'Idle_in_sheath',   // 跟 Aatrox3DShowcase 既有 DEFAULT_ANIMATION 一致
    attack: 'Attack2',        // 跟 Aatrox3DShowcase 既有 ATTACK_CLIP_NAME 一致
    defense: 'Channel_Wndup', // 沒有真正的護盾/格擋動畫，用蓄力/戒備姿勢代打，最接近「防禦」的語感
    death: 'Death',
  },
  player2: { // Mordekaiser
    idle: 'Battle_Idle',              // 比純 Idle.anm 更有「在對戰」的語感
    attack: 'Attack2',
    defense: 'Spell2_Consume_Shield.anm', // 他本來的技能就是護盾，語意上完全對應
    death: 'Death',
  },
}
```

命中但沒有格擋成功時的「受擊反饋」刻意不綁定特定動畫 clip（兩邊都沒有通用的「被打」動畫），改用材質短暫變紅＋輕微鏡頭震動（three.js 直接改 `material.emissive` 幾幀後恢復，跟動畫播放無關，兩個角色可以共用同一段程式碼）。

### 防禦持續狀態（`pkDefenseState.ts`）

跟 `gestureTriggerState.ts` 用同一種 `STABLE_FRAMES` 防手震門檻，差別是這裡沒有「armed」這個單向鎖，是單純的雙態穩定判定：

```ts
export type DefenseState = { defending: boolean; matchStreak: number; missStreak: number }
export const INITIAL_DEFENSE_STATE: DefenseState = { defending: false, matchStreak: 0, missStreak: 0 }
export type DefenseResult = { state: DefenseState; changed: boolean } // changed=true 代表這一幀 defending 的值真的翻轉了，呼叫端才需要發 MQTT 訊息
```

### 全螢幕與 ESC

`PkArenaView` 掛載時呼叫 `document.documentElement.requestFullscreen()`；同時註冊 `document.addEventListener('fullscreenchange', handler)`，`handler` 檢查 `document.fullscreenElement` 是否變成 `null`（不管是使用者按 ESC、還是呼叫端自己呼叫 `document.exitFullscreen()`）就呼叫 `onExit()`——ESC 退出全螢幕跟按畫面上的退出鈕，最終走的是同一條路徑，不用分開處理兩套邏輯。

### 心跳與離線判定

沿用 `multi/multiplay.js` 的 `MP_CFG.HEARTBEAT_MS=3000`／`OFFLINE_MS=10000` 這兩個數字（操控端每 3 秒送一次心跳，擂台端超過 10 秒沒收到某個 `playerId` 的心跳就判定離線），不重新發明一套門檻。離線時 `phase` 轉成 `'paused'`，畫面顯示「等待 OO 重新連線」；該 `playerId` 重新送出心跳/join 就恢復 `'battle'`（如果離線前是戰鬥中）或 `'countdown'`（如果離線發生在倒數階段，重新開始倒數，避免其中一秒偷跑）。

## Testing Decisions

- **會寫單元測試（純函式）**：`pkMatchState.ts`（join 分配角色、命中判定含格擋、血量歸零判勝負、離線標記、倒數遞減）、`pkDefenseState.ts`（雙向邊緣偵測+防手震）。這兩個是這個功能的核心規則，用假的輸入序列就能測完，不需要真的 MQTT/鏡頭。
- **刻意不寫自動測試**：`PkArenaView.tsx`／`PkControllerView.tsx` 本身（鏡頭、`GestureRecognizer`、MQTT 連線、three.js 渲染、Fullscreen API），跟本 repo 一貫的「碰真實瀏覽器 API 的薄膠水層不寫自動測試」慣例一致，手動驗證見下方 Acceptance Criteria。

## Acceptance Criteria

1. Aatrox3DShowcase 卡片上看得到「PK 對戰模式」按鈕；點下去進入全螢幕，擂台端自己跳出鏡頭權限請求（畫面左下角 PIP），允許後自動變成玩家一，畫面顯示「等待對手加入」＋可複製/掃描的操控頁網址。
2. 拒絕擂台端自己的鏡頭權限 → PIP 顯示清楚的錯誤訊息＋「重試」按鈕，不會卡死整個畫面；按「重試」能重新跳出權限請求。
3. 用手機瀏覽器掃 QR code 或開啟該網址（路徑是 `/pk`）→ 跳出鏡頭權限請求 → 允許後畫面顯示「已加入，你是 Mordekaiser」，擂台端畫面立刻轉成 3-2-1 倒數，不需要第三支裝置，倒數期間比手勢不會有任何反應。
4. 倒數結束後，玩家一（擂台端本人）比 ✊ → 擂台端 Aatrox 立刻播攻擊動畫；如果玩家二當下正舉着 🖐️，攻擊被擋下（不扣血）；沒有舉着則命中扣血，血量條即時更新。玩家二透過手機比出的手勢同樣要能正確反應在 Mordekaiser 身上。
5. 舉起 🖐️ 之後放下 → 擂台端的「玩家二正在防禦」狀態確實跟着解除，不會卡在防禦中。
6. 任一方比 ✌️ → 該角色在擂台畫面上做出跳躍位移（角色本身的動畫不中斷）。
7. 其中一方血量歸零 → 播放 `Death` 動畫、擂台畫面顯示勝負結果。
8. 拔掉玩家二手機的網路 → 10 秒內擂台端顯示「等待重新連線」、對戰暫停；恢復網路/重新整理該操控頁 → 沿用原本角色跟血量繼續。
9. 擂台端按 ESC → 全螢幕退出、PK 模式結束，回到正常的 desktop-pet-web 首頁，Hero／其他區塊恢復正常運作（可以用瀏覽器 DevTools 確認沒有殘留的鏡頭/WebGL context）。
10. 全程只需要區網連線（跟 `multi/` 系統一樣的假設），不需要對外網路。

## Edge Cases

- **兩支手機同時比出攻擊**：兩則 `pk/input` 訊息各自獨立處理，各自檢查對方當下是否在防禦，不需要特殊的「誰先誰後」仲裁邏輯——MQTT 訊息到達順序本來就有先後，先到的先處理，這是可接受的行為（不是格鬥遊戲等級的幀級精確判定）。
- **同一個 `playerId` 在兩台裝置同時開着**（例如手機沒關又用平板開了同一個操控頁）：後開的視為同一個玩家的重新連線，沿用同一份狀態，兩邊都能送出手勢事件（沒有特別擋，屬於使用者自己操作失誤，不特別處理）。
- **擂台端整個重新整理頁面**：`pk/state` 是 retained 訊息，但擂台端本身是「真相來源」，重新整理後它自己的記憶體狀態會歸零——這代表擂台端重整＝整場比賽重來，操控端會發現連線但角色/血量都被清空，需要重新走一次加入流程。這是可接受的行為，不特別做「擂台端也能無縫恢復」的機制（複雜度不對稱：操控端斷線復原很常見且成本低，擂台端斷線復原的情境少見且成本高）。
- **倒數期間玩家離線**：離線判定/畫面提示照樣運作，倒數暫停、等重連後重新從 3 開始（見上方「心跳與離線判定」）。
- **玩家一（擂台端本人）鏡頭授權失敗或被拒絕**：不影響 MQTT 連線／玩家二能不能加入——`phase` 停在 `'waiting'`（因為玩家一還沒 join，`player1` 是 `null`），玩家二就算先掃 QR code 加入了也只會停在 `player2` 已填、`player1` 還是 `null` 的狀態，不會開始倒數（`maybeStartCountdown()` 要求兩個 slot 都非 null）。玩家一按「重試」授權成功後，才會自動 join、湊齊兩人開始倒數。
- **`pk/join` 訊息在擂台端訂閱生效前送出**（2026-08-18 實測踩過）：`pk/join` 沒有 retain，如果操控端連上 broker、發布 `pk/join`的時機搶在擂台端 `client.subscribe(PK_TOPICS.JOIN)` 生效之前（兩邊各自的連線握手時間沒有保證誰先完成），這則訊息會直接遺失、擂台端永遠不知道這個玩家存在——症狀是兩邊裝置都顯示「已加入/鏡頭已就緒」，但擂台端卡在等待對手，不會開始倒數。修法：`PkControllerView.tsx` 的心跳 interval 每次順便檢查「目前有沒有被分配到 slot」（`assignedSlotRef`，從收到的 `pk/state` 更新），還沒有的話就跟著重發一次 `pk/join`，最多 `HEARTBEAT_MS`（3 秒）內會自動補上，不需要使用者手動重新整理頁面。
- **玩家二比玩家一先 join，會被誤塞進玩家一的位置**（2026-08-18 實測踩過，真正的設計 bug，不是時機問題）：`applyJoin()` 原本的邏輯是「哪個 slot 空就填哪個」，如果遠端操控端的 `pk/join` 剛好在擂台端本人的本機 join（`joinAsPlayer1Ref`，鏡頭授權成功那一刻才會呼叫，可能因為要等使用者按下權限請求彈窗而延遲）之前抵達，`player1` 這個 slot 當下還是空的，遠端玩家就會被塞進去——等擂台端操作者終於授權完成，`player1` 已經被占走，自己反而被塞進 `player2`。症狀是操控端明明是遠端手機/另一台裝置，卻顯示自己是玩家一（Aatrox）。**已修正**：`applyJoin()` 新增 `targetSlot` 參數，由呼叫端明確指定要塞哪個 slot，不再是「哪個空就填哪個」——`PkArenaView.tsx` 的本機呼叫永遠傳 `'player1'`、MQTT `pk/join` 收到的訊息永遠傳 `'player2'`，跟訊息到達的先後順序完全無關。`pkMatchState.test.ts` 新增測試鎖住這個規則（玩家二先 join 也不會占走玩家一的位置）。

## 已知風險：`getUserMedia()` 在區網 `http://` 環境可能直接不可用

操控端要開鏡頭辨識手勢，`navigator.mediaDevices.getUserMedia()` 只在 **secure context**（`https://` 或 `localhost`）可用——這是瀏覽器層級的硬限制，不是這個功能自己能繞過的邏輯問題。這次的設計前提是「兩位玩家手機直連區網 `http://<桌機IP>:5173`」（跟 `pkMqttUrl.ts` 的 `ws://IP:9001` 是同一種「純區網直連」假設），手機瀏覽器很可能連鏡頭權限請求都不會跳出來，直接在 `getUserMedia()` 這一步就丟例外（會被現有的 `describeError()` 接住顯示成一般錯誤訊息，不會整個當掉，但功能等於不能用）。

跟 `playerId` 生成刻意不用 `crypto.randomUUID()`（見 `PkControllerView.tsx` 的 `getOrCreatePlayerId()`）不同，這裡沒有「換一個不需要 secure context 的 API」這種簡單解法可以繞開。可能的方向（都不在這次範圍內，先記錄不展開）：

- 比照 `multi/` 現有的 Caddy 反向代理（`wss://.../mqtt` 那條路），架一份 LAN 適用的 HTTPS（例如 `mkcert` 簽一張區網 IP 用的憑證，讓手機瀏覽器願意信任），操控端網址改成 `https://<桌機IP>:port/pk`。**2026-08-18 曾經動工過這個方向**（裝了 `vite-plugin-mkcert`），後來使用者表示已經自行解決授權問題，這批改動已經撤回（`vite.config.ts`／`package.json` 都復原），沒有留下任何殘留程式碼——如果之後要再走這條路，是從頭開始，不是接續當時的半成品。
- 退而求其次：手機瀏覽器有「不安全來源當作安全來源」的開發者旗標（例如 Chrome 的 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`），但這需要每支手機手動設定，不是「開網址就能玩」的體驗，不適合當正式方案。

這台機器沒辦法用真的手機瀏覽器測試，**這個風險目前還沒有被驗證會不會真的擋下來**（不同瀏覽器/OS 對「區網 IP」的 secure context 認定可能有差異），需要使用者自己拿手機連一次 `http://<桌機IP>:5173/pk` 才會知道實際卡在哪一步——如果真的被擋，這會是動工這個功能後第一個要解決的後續項目。

**2026-08-18 追加：已在玩家一（擂台端本人）這邊實測重現**——使用者用區網 IP 開啟擂台端頁面（不是 `localhost`），錯誤是 `TypeError: Cannot read properties of undefined (reading 'getUserMedia')`，代表 `navigator.mediaDevices`整個是 `undefined`（不是 `getUserMedia()` 呼叫失敗丟例外），證實了上面推測的「secure context 限制」是真的會擋下來，不是理論風險。已修正兩處：
1. `PkArenaView.tsx`／`PkControllerView.tsx`／`aatrox-gesture/AatroxGestureTrigger.tsx`／`gesture-drag/GestureDragControl.tsx` 這四個檔案的 `setup()` 開頭都加一道 `if (!navigator.mediaDevices?.getUserMedia) throw new Error('insecure-context')` 檢查，先攔下來丟出好懂的訊息，不要讓後面 `.getUserMedia()` 直接對 `undefined` 取屬性炸出看不懂的 `TypeError`。
2. 對應的錯誤文案新增專屬分支：玩家一（擂台端）／`AatroxGestureTrigger`／`GestureDragControl` 這三個「通常跟 dev server 同一台機器」的情境，直接建議「改用 `http://localhost:<port>`（不要用區網 IP）」——這對玩家一是真正可行的解法，因為擂台端操作者本來就在同一台機器上，換成 `localhost` 網址就能繞過這個限制；操控端（玩家二，手機）沒有這個退路，錯誤文案改成誠實說明「目前已知、還沒解決的限制」。

## 已知風險：外接 USB 攝影機在部分機種上會直接無法取得畫面（2026-08-18 追加）

使用者實測回報：操控端鏡頭「無法使用」，但同一台裝置的 Windows 相機 App 開得起來、看得到畫面——代表硬體/驅動沒問題，是瀏覽器 `getUserMedia()` 這一層失敗。查出兩個成因並已修正：

1. **`facingMode: 'user'` 約束**：原本 `getUserMedia({ video: { facingMode: 'user' } })` 的 `facingMode` 是手機前/後鏡頭的概念，外接 USB 攝影機沒有「朝向」，部分廠牌驅動回報的方式會讓瀏覽器（尤其 Chromium 系）直接判定不滿足約束、丟 `OverconstrainedError`，整個 `getUserMedia()` 失敗。**已修正**：`pk-mode/PkArenaView.tsx`、`pk-mode/PkControllerView.tsx`，以及既有的 `aatrox-gesture/AatroxGestureTrigger.tsx`、`gesture-drag/GestureDragControl.tsx`（同樣的 call pattern，同樣的潛在風險，一併修掉）全部改成 `getUserMedia({ video: true })`，不帶任何約束。
2. **錯誤訊息只顯示「權限被拒絕」，掩蓋了真正的原因**：原本的 `describeError()`／`describeCameraError()` 只挑 `NotAllowedError` 給專屬文案，其餘一律「請確認瀏覽器支援鏡頭存取」，使用者看到這句話會去檢查瀏覽器權限設定，但如果真正的錯誤是 `OverconstrainedError` 或 `NotReadableError`（鏡頭被 Windows 相機 App／視訊會議軟體占用），檢查權限設定完全找不到問題。**已修正**：這四個檔案的錯誤文案都改成顯示瀏覽器回報的實際 `err.name`／`err.message`，並依常見的 `NotReadableError`／`TrackStartError`（鏡頭被占用）、`NotFoundError`／`OverconstrainedError`（找不到符合條件的鏡頭）分開給對應的排查建議。

**還沒驗證**：這台機器沒有真的 USB 攝影機可以測，上面兩點是根據 `getUserMedia()` 的公開行為/已知的 Chromium 相容性問題推斷的合理修法，不是已經在使用者的實際環境重現過、確認修好的。如果拿掉 `facingMode` 之後鏡頭還是連不上，下一步要看的是瀏覽器 DevTools console 印出來的實際 `err.name`（現在畫面上的錯誤訊息也會直接顯示這個），或是不是 Windows 系統設定（設定 → 隱私權與安全性 → 相機 → 「讓應用程式存取您的相機」／「讓傳統型應用程式存取您的相機」）擋掉了瀏覽器。

## Out of Scope

- **不做音效**——攻擊/格擋/勝負的音效留到之後迭代（見 `docs/roadmap-desktop-pet-web-gesture.md`）。
- ~~不做「再來一場」按鈕~~——**2026-08-18 已新增**，見文末實作備註。
- **不做房間碼／多場對戰同時進行**——見 `docs/adr/0014`，整個區網同時只有一場 PK。
- **不做選角畫面**——角色由連線順序決定，玩家不能自己選 Aatrox 或 Mordekaiser。
- **不做真正的空間碰撞/距離判定**——命中判定只看「攻擊當下對方是否在防禦」，跟兩個角色的 3D 位置無關。
- **不做觀眾/第三方裝置的旁觀模式**——只有擂台端（顯示）跟兩個操控端（輸入），沒有第三種角色。
- **不支援公網對戰**——跟 `multi/` 現有假設一致，兩位玩家跟擂台端要在同一個區網。

## Further Notes

- 相關文件：`docs/adr/0014`（架構取捨的完整理由）、`CONTEXT.md`（「手勢 PK 對戰模式」「擂台端」「操控端」詞彙）、`docs/roadmap-desktop-pet-web-gesture.md`（音效／再來一場等後續迭代項目）。
- `mqtt` 是這次新增的 npm 依賴，瀏覽器端用 WebSocket transport連到跟 `multi/` 相同的 broker，但這次是**兩個獨立的訂閱端**（一個在 `PkArenaView`、一個在 `PkControllerView`），不要嘗試共用同一個 `mqtt.connect()` 實例——擂台端跟操控端是不同裝置上的不同瀏覽器分頁，本來就是兩個獨立的連線。

## 實作備註（2026-08-18）

- **架構修訂：擂台端本人變成玩家一**（使用者需求：「主持人同樣為玩家1，當有人連線後就視為玩家2，遊戲隨即開始」＋「確保有攝影機授權功能」，完整理由見 `docs/adr/0014` 修訂記錄）。`PkArenaView.tsx` 新增一組跟 `PkControllerView.tsx` 對稱的鏡頭/手勢辨識邏輯，做法：
  1. 新增 `LOCAL_PLAYER_ID` 固定常數（不像玩家二需要 `Math.random()` 產生跨次持久化 id——擂台端重整頁面本來就等於整場重來，見 Edge Cases）。
  2. 玩家一的鏡頭/手勢辨識是**獨立的 React effect**（依賴 `cameraRetryToken`），不是塞進原本處理 MQTT／three.js 場景的那個大 effect——鏡頭權限可能被拒絕、使用者要能單獨重試，不需要因此重新連 MQTT、重新載入兩個 3D 模型、把已經連上的玩家二狀態也弄丟。
  3. 兩個 effect 之間用 `handleInputEventRef`／`joinAsPlayer1Ref` 兩個 ref 橋接（跟 `Aatrox3DShowcase.tsx` 的 `triggerSelectedActionRef` 同一種「平行掛載的 effect 只透過 ref 溝通」模式）：主 effect 把「套用輸入到比賽狀態機＋觸發攻擊/跳躍視覺」跟「把自己 join 成玩家一」這兩個函式賦值給 ref，鏡頭 effect 偵測到手勢/授權成功時透過 ref 呼叫，不繞 MQTT 自己發訊息給自己。
  4. **鏡頭真的授權成功才 join**，不是 effect 掛載當下就 join——避免比賽因為玩家二先連上而開始倒數，玩家一卻還卡在鏡頭權限請求、完全沒辦法出手的破圖狀態（見新增的 Edge Cases 那條）。
  5. `pkMatchState.ts` 的比賽狀態機**完全沒有改動**——`applyJoin()` 本來就是「先到先填 player1、後到填 player2」，不管 join 訊息是從本機 ref 呼叫還是從 MQTT `pk/join` 收到的，用的是同一個函式、同一份規則，這也是這次改動能夠只動 `PkArenaView.tsx` 一個檔案就完成、不用碰任何一個已經有測試覆蓋的純函式模組的原因。
- **UI 調整**：「等待玩家加入」畫面文案改成反映只需要等一位對手；移除原本「玩家一已加入／玩家二已加入」的雙狀態列，改成「你（玩家一）已就緒／等待你允許鏡頭權限」＋「對手已加入／等待對手掃 QR code」；新增左下角玩家一專用的鏡頭 PIP（跟操控端同款：requesting/active 顯示手勢文字/error 顯示錯誤訊息＋重試按鈕），全程顯示（不只在等待畫面），讓玩家一在對戰中也看得到自己的手勢辨識狀態。
- **驗證狀態**：`tsc -b`／`oxlint`／`vitest run`（69/69，`pkMatchState.test.ts` 完全沒改也全過，印證上面第 5 點「狀態機沒有改動」的說法）／`vite build` 均已跑過且全過。**這項改動的手動驗證還沒執行**，尤其要注意：擂台端自己的鏡頭 PIP 有沒有正確跟操控端的鏡頭 PIP 同時運作而不互相干擾（兩個獨立的 `getUserMedia()` 呼叫，理論上瀏覽器允許同一個分頁只開自己的鏡頭、不影響另一支手機的鏡頭，但沒有實機測過）、鏡頭授權失敗時的「重試」按鈕實際點下去體感如何。

- **新增檔案**（照建議順序全部完成）：`pkProtocol.ts`（topic/payload 型別）、`pkMatchState.ts`＋23 個測試（比賽狀態機：join 分配角色、命中判定含格擋、血量/勝負、離線暫停/重連恢復倒數）、`pkDefenseState.ts`＋7 個測試（防禦持續狀態雙向邊緣偵測）、`pkEdgeTriggerState.ts`＋4 個測試（攻擊/跳躍邊緣觸發，刻意跟 `aatrox-gesture/gestureTriggerState.ts` 分開一份，不共用/不參數化那個已經有自己 ADR 的模組，見該檔案開頭說明）、`pkAnimationMap.ts`（角色動作對照表）、`pkMqttUrl.ts`＋2 個測試（沿用 `multi/multiplay.js` 的 `mpMqttUrl()` 規則）、`PkControllerView.tsx`（操控端）、`PkArenaView.tsx`（擂台端）。`Aatrox3DShowcase.tsx` 新增第三顆「PK 對戰模式」按鈕、`DesktopPetPage.tsx` 新增 `pkArenaActive` state 提早 return、`App.tsx` 新增 `?role=controller` 判斷。
- **新增 npm 依賴**：`mqtt`（瀏覽器 WebSocket transport）。
- **意外的連帶修復**：新增 `mqtt` 依賴後，它的依賴鏈（`@types/ws`／`@types/readable-stream`）間接透過 `/// <reference types="node" />` 把 `@types/node` 的全域宣告拉進整個專案的編譯範圍，導致既有的 `ReturnType<typeof window.setTimeout>` 這種型別寫法被誤判成 `NodeJS.Timeout`（跟瀏覽器 `window.setTimeout()` 呼叫端實際回傳的 `number` 對不上，`tsc` 直接報錯）。這不是這次新寫的程式碼本身的問題，是新增這個依賴對既有程式碼的副作用，順手修正了 `Aatrox3DShowcase.tsx`、`HeroLive2DStage.tsx`、`gesture-drag/GestureDragControl.tsx` 三處計時器變數的型別註記（改成直接寫死 `number`，或用 `window.setTimeout`/`window.clearTimeout` 明確指定瀏覽器版本），純型別修正，沒有改變任何執行期行為。
- **實作時發現、原訪談沒討論到的技術限制**：
  1. **`crypto.randomUUID()` 需要 secure context**：`PkControllerView.tsx` 產生 `playerId` 原本想用 `crypto.randomUUID()`，但這個功能立足於區網 `http://` 直連，這個 API 在非 secure context 會直接不存在。改用 `multi/player.html` 現有 `quiz_pid` 的同一招（`Math.random().toString(16)` 取幾碼），已修正。
  2. **`getUserMedia()` 同樣需要 secure context，但沒有等價的簡單解法**：跟上一點不同，這個沒辦法換一個 API 解決，是真的架構風險，已經記錄成新的一節「已知風險」（見上方），需要使用者實測才會知道會不會擋死操控端。
- **雙角色朝向未經視覺驗證**：`PkArenaView.tsx` 裡兩個角色的 `rotation.y`（讓角色轉向面對面）是合理猜測，跟 Aatrox3DShowcase 的 WASD 移動假設模型預設朝 `-Z` 同一種未經視覺確認的假設，如果實際站起來背對背或側對側，只需要調整這兩個常數，不影響其他邏輯。
- **命中反饋效能**：受擊材質變紅（`applyHitFlash`）一開始寫成每幀都對兩個角色各自做一次完整的 mesh/material 樹遍歷，實作中途發現這在 60fps 雙角色場景下是不必要的浪費，改成只在「開始閃紅」/「結束閃紅」這兩個邊緣才真的遍歷（`flashPainted` 旗標），持續閃紅期間跟平常沒被打的幀數都直接跳過。
- **全螢幕呼叫時機**：`requestFullscreen()` 原本寫在 `PkArenaView.tsx` 掛載時的 `useEffect` 裡，實作中途意識到這樣經過 React 排程的非同步空檔，部分瀏覽器可能不再認可是「使用者觸發」而拒絕全螢幕請求。改成在 `DesktopPetPage.tsx` 按鈕的 `onClick`（`enterPkArena()`）裡跟使用者手勢同步呼叫，`PkArenaView` 只負責監聽 `fullscreenchange`。
- **2026-08-18 追加：區網存取＋QR code**（使用者實測發現 `http://localhost:5173/?role=controller` 手機連不上）：
  1. `vite.config.ts` 新增 `server: { host: true }`——Vite dev server 預設只監聽 localhost，這個沒開的話就算網址帶對了 IP，連線本身還是會被拒絕。
  2. 新增 `pkJoinUrl.ts`＋6 個測試：瀏覽器 JS 沒有標準 API 能可靠得知「自己這台機器的區網 IP」，跟 `multi/host.html` 的 `buildPlayerUrl()` 用同一招——`location.hostname` 是 `localhost`/`127.0.0.1` 時，讓使用者手動輸入一次自己的區網 IP（存 `localStorage`，同一台機器下次不用再輸入），不是 localhost 開的就直接沿用現有 hostname，不用問。
  3. 新增 `qrcode`／`@types/qrcode` npm 依賴，`PkArenaView.tsx` 的「等待玩家加入」畫面改成用 `QRCode.toDataURL()` 產生真的可掃描 QR code 圖片（跟 `multi/host.html` 用 CDN 版 `qrcodejs`不同，這裡是 desktop-pet-web 既有的 npm/Vite 依賴慣例，不用 CDN `<script>`，理由跟 ADR-0011 對 MediaPipe 的態度一致）。
  4. Mosquitto broker 本身不用改——`listener 9001`／`listener 1883` 沒有指定 bind address，預設就是監聽所有網路介面，`multi/` 現有的區網連線已經證實這條路可行。
  5. **自動帶入偵測到的 IP，不用逼使用者對照終端機輸出手動打**（使用者實測後回報「終端機都印出來了，應該也能直接顯示在畫面上」）：`vite.config.ts` 用 Node 的 `os.networkInterfaces()`（Vite 自己印「Network: http://...」用的同一招）在設定檔算一次第一張非 loopback 網卡的 IPv4 位址，透過 `define` 注入成 `__PK_LAN_IP__` 編譯期常數（型別宣告在新增的 `src/vite-env.d.ts`）。`PkArenaView.tsx` 的 `lanIp` 初始值改成「`localStorage` 有存過的手動覆寫優先，沒有才退回 `__PK_LAN_IP__`」，多數情況下完全不用手動輸入，QR code 一進畫面就是對的；手動輸入欄位保留當覆寫用（多網卡環境自動偵測可能撿錯張卡），「IP 錯了？重新輸入」改成清空時整個移除 `localStorage` 那個 key（不是存空字串），下次開 PK 模式才會重新退回自動偵測，不會卡在「曾經手動清空過」的狀態。已用 `grep` 對照 `vite build` 產物確認注入的 IP 字串確實在裡面、跟終端機印的一致。
  6. **已知限制**：`vite build` 產物會把「打包當下那台機器」的 IP 寫死進去，如果之後真的是先 build 再把靜態檔案搬去別台機器跑（不是 `npm run dev`），這個自動偵測值會是錯的——目前這個功能的實際跑法是 `npm run dev`（見 `control-center/process-manager.js`），這個限制暫時不影響實際使用，但如果之後改成走 build 產物部署，記得回來處理。
- **驗證狀態**：`tsc -b`／`oxlint`／`vitest run`（69/69，PK 模式相關累計 42 個：初版 36 個＋這次區網/QR code 追加的 `pkJoinUrl.test.ts` 6 個）／`vite build` 均已跑過且全過（`vision_bundle` 確認還是同一份 code-split chunk，沒有因為 `PkControllerView.tsx` 也動態 `import('@mediapipe/tasks-vision')` 而變成兩份）。**Acceptance Criteria 列的 10 項手動雙裝置驗證完全沒有執行過**，這台機器沒有真的鏡頭/手機可以測，需要使用者自己拿桌機＋兩支手機照 Acceptance Criteria 逐項測過一輪——尤其優先確認上方「已知風險」那節的 `getUserMedia()` 在區網 `http://` 環境到底能不能用，這會決定這個功能整個能不能如期運作。

- **2026-08-18 追加：加入網址從 query string 改成短路徑、修正玩家一/玩家二搶 slot 的真實 bug、新增移動＋攻擊距離**：
  1. **加入網址簡化**：`?role=controller` 改成固定短路徑 `/pk`（`PK_CONTROLLER_PATH`，見 `pkJoinUrl.ts`）——使用者實測手動輸入網址時忘記帶 query string，連到擂台端首頁又點了 PK 按鈕，變成自己那一場的擂台端（下一點詳述）。`App.tsx` 改成比對 `window.location.pathname`，不再解析 query string。`pkJoinUrl.test.ts`／`pkJoinUrl.ts` 同步簡化（`buildJoinUrl()` 拿掉不再需要的 `pathname` 參數）。
  2. **修正真實 bug：`applyJoin()` 原本「哪個 slot 空就填哪個」，不管訊息到達順序**——玩家二（遠端 MQTT join）如果搶在玩家一（本機呼叫，要等使用者真的點鏡頭權限彈窗，可能比較慢）之前抵達，`player1` 這個 slot 當下還是空的，玩家二就直接填進去了，等玩家一終於 join，`player1` 已經被占走，自己反而變成玩家二——跟操作者的直覺完全相反。使用者實測換一台裝置連線，那台裝置卻顯示自己是玩家一，正是這個 bug。**已修正**：`applyJoin()` 新增 `targetSlot: PlayerSlot` 參數，呼叫端明確指定要塞哪個 slot（本機呼叫永遠 `'player1'`、MQTT `pk/join` 永遠 `'player2'`），不再靠訊息到達順序猜。`pkMatchState.test.ts` 新增 2 個測試鎖住這個規則。詳細分析見 `docs/adr/0014` 修訂記錄。
  3. **新增移動＋攻擊距離**（使用者需求：「手指姿勢:控制移動、拳頭:攻擊」＋「攻擊判定距離太遠，靠近敵人身體才能攻擊到」，完整理由見 `docs/adr/0014` 修訂記錄，不重複展開）：新增 `pkMovement.ts`（純函式 `handToMoveValue()`＋6 個測試）、`pkProtocol.ts` 的 `PkInputMessage` 新增 `'move'` 型別、`pkMatchState.ts` 的 `applyInput()` 把 `'move'` 跟 `'jump'` 一樣當純視覺 no-op（+1 個測試）。`PkArenaView.tsx` 新增 `CharacterRig.moveInput`／`baseX`、`updateMovement()`／`clampMutualGap()`（移動範圍雙重限制：不能退得比出生點遠、兩個角色一起算不能貼到/穿過對方）、`isWithinAttackRange()`（攻擊距離判定，依角色身高換算，不是寫死絕對數字）。玩家一（本機）每幀直接呼叫 `handleInputEventRef.current({type:'move',...})`；玩家二（`PkControllerView.tsx`）節流到 `MOVE_PUBLISH_MS`（100ms/10Hz）才真的發布，避免連續數值每幀（60fps）都送 MQTT 訊息。操控端 UI 提示文案同步更新（新增「手放左/右移動」的說明）。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（79/79，這次新增 10 個：`pkMovement.test.ts` 7 個＋`pkMatchState.test.ts` 新增 3 個）／`vite build` 均已跑過且全過。**移動的手感（速度、死區大小、最小距離、攻擊距離）完全沒有實機測過**，這幾個常數都是合理猜測，跟先前的攻擊/防禦動畫選擇一樣，很可能要在使用者實測後回頭調整；`ADVANCE_DIRECTION` 依賴的角色朝向假設（`rotation.y`）也還沒視覺驗證過，如果角色移動方向感覺反了，只需要把 `ADVANCE_DIRECTION` 兩個值對調即可，不影響其他邏輯。

- **2026-08-18 追加：修正攻擊動畫跟扣血時機沒對上、修正移動有時鬆不開**（使用者實測回報）：
  1. **攻擊動畫跟扣血時機沒對上**：根因有兩個，一起修。(a) 命中判定原本是「攻擊事件一到就立刻扣血」，完全不管揮擊動畫播到哪——已改成延後到動畫播到 `ATTACK_IMPACT_FRACTION`（0.35，依角色實際攻擊 clip 的 `duration` 換算延遲毫秒數，不是寫死絕對值）那個時間點才真的判定命中，用 `attackToken` 序號讓「這拳的命中判定」在使用者緊接著出下一拳時能正確作廢（不會「動畫只看得到最新那拳，卻扣到上一拳的血」）。(b) `playClip()` 原本「已經在播同一個 clip 就不重新觸發」的去重邏輯，讓連續出拳時揮擊動畫根本沒有真的重播，但命中判定照樣每次都算——新增 `force` 參數，攻擊呼叫時帶 `force:true`，每一拳保證有對應的一次完整揮擊動畫。
  2. **移動有時候鬆不開**：新增 `pkMovement.ts` 的 `smoothHandX()`（EMA 指數移動平均，`SMOOTHING_ALPHA=0.35`，+5 個測試），每一幀都對 landmark 座標平滑，不是只在（節流後的）發布那一刻才平滑——單靠死區沒辦法完全解決，landmark 座標本身逐幀就有雜訊，剛好卡在死區邊界時會一下進一下出、角色斷斷續續地動，平滑把這種高頻雜訊濾掉。順便把 `DEAD_ZONE` 從 0.15 調大到 0.2，雙管齊下。手離開畫面時平滑值重置回 `null`，不留舊位置的殘留。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（84/84，這次新增 5 個：`pkMovement.test.ts` 的 `smoothHandX` 測試）／`vite build` 均已跑過且全過。**兩項修復都還沒實機驗證**——`ATTACK_IMPACT_FRACTION`／`SMOOTHING_ALPHA`／`DEAD_ZONE=0.2` 都是合理猜測的數字，不是量出來的，使用者實測後手感不對可以直接調這幾個常數。

- **2026-08-18 追加：操控端同步看擂台端畫面（WebRTC 視訊串流）**（使用者需求，完整取捨理由見 `docs/adr/0014` 修訂記錄，這裡只記實作）：
  1. `pkProtocol.ts` 新增 `LOCAL_PLAYER_ID`（從 `PkArenaView.tsx` 搬過來變共用常數）、`PK_WEBRTC_SIGNAL_PREFIX`（`pk/webrtc/signal/` + 目標 playerId）、`WEBRTC_ICE_SERVERS`（公開 STUN，跟 `multi/` 的 `MP_CFG.VOICE_ICE_SERVERS` 同一顆）、`PkWebrtcSignalMessage`（`pull`/`offer`/`answer`/`ice`）。
  2. `PkArenaView.tsx`（廣播端）：`renderer.domElement.captureStream(WEBRTC_FPS)`（20fps）取得畫面串流，收到操控端的 `pull` 才建立 `RTCPeerConnection`、送 offer（不是玩家二一 join 就主動推，用「操控端主動要」這個模式同時涵蓋第一次加入跟斷線重連兩種情境，不用分開處理）。永遠只維護一條 `outPeerConnection`（PK 模式一對一，不需要 `multi/VoiceBroadcastModule.js` 那套多對多的 peer 字典）。
  3. `PkControllerView.tsx`（觀看端）：新增 `hostVideoRef`／`hostVideoStatus`（`connecting`/`connected`/`unavailable`）、收到 offer 才建立 `inPeerConnection`、回 answer，`ontrack` 把收到的 stream 接到 `<video muted>`（沒有聲音軌，但 muted 確保跨瀏覽器都能穩定自動播放）。畫面用 `object-contain`，不是滿版裁切，保留完整構圖。
  4. **`pull` 訊息一樣有訂閱時機競態**（跟 `pk/join` 同一種坑，這次寫程式的時候直接照抄那個坑的解法，不用等使用者踩過一次才修）：`pull` 沒有 retain，如果操控端連上就送出、但擂台端還沒訂閱到，會直接遺失。心跳 interval 比照 `pk/join` 的重試邏輯，`hostVideoStatus` 還不是 `'connected'` 就順便重發一次 `pull`（用 `hostVideoStatusRef` 讓 interval 讀到最新值，跟 `assignedSlotRef` 是同一個理由）。
  5. **失效隔離**：WebRTC 建立不起來（NAT/防火牆等）只會讓畫面顯示「暫時無法顯示」，不影響操控端其餘功能（手勢辨識/血量顯示/加入流程完全獨立），跟這個 repo 一貫「附加功能失效不能拖累核心功能」的態度一致。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（84/84，這次沒有新增純函式，WebRTC 這段是瀏覽器 API 的薄膠水層，跟既有的鏡頭/MQTT 連線邏輯一樣刻意不寫自動測試）／`vite build` 均已跑過且全過。**這整段完全沒有實機驗證過**——這台機器沒有兩台真的裝置可以測 WebRTC P2P 連線，需要使用者自己拿桌機＋手機在同一區網測過，尤其留意：手機瀏覽器能不能正常自動播放收到的視訊（各家瀏覽器的自動播放政策不完全一樣）、NAT/路由器設定是否會擋掉 P2P 直連（家用 Wi-Fi 通常沒問題，但公司/學校網路可能因為防火牆政策擋掉）。

- **2026-08-18 追加：玩家端畫面放大成跟擂台端一樣全螢幕、新增「再來一局」按鈕**（使用者需求）：
  1. **`PkControllerView.tsx` 整個 JSX 重排**：原本是一般網頁的置中窄欄排版（`max-w-sm` 的一個區塊裝擂台畫面），改成跟 `PkArenaView.tsx` 同一種「`fixed inset-0` 全螢幕背景＋其餘資訊疊在上面」呈現方式——擂台畫面 `<video>` 變成鋪滿整個畫面的背景（`object-contain`，不裁切），角色/血量資訊疊在頂部用漸層黑底確保可讀性，階段訊息（等待/倒數/暫停/結束）置中疊加，自己的鏡頭 PIP 跟手勢提示縮小移到右下/左下角落，退居輔助資訊的角色。這樣兩邊看到的擂台畫面才是真的同樣大小，不是操控端把它擠成頁面裡一個普通區塊。
  2. **`pkMatchState.ts` 新增 `resetMatch(state, now)`＋5 個測試**：只能在 `finished` 階段呼叫，血量/防禦重置，**沿用原本的玩家身分／連線**（不用重新掃 QR code、不用重新走 join 流程）——這是「再來一局」相對於「整場重來」（重新整理擂台端頁面）的核心差異。兩人都還連線中的話會直接接上 `maybeStartCountdown()` 轉成 `'countdown'`，體感是「按一下馬上重新倒數開打」；有人斷線了則停在 `'waiting'`，等對方重新連上會自動接續（沿用既有的離線恢復邏輯，不需要另外處理）。
  3. **`PkArenaView.tsx` 新增 `rematchRef`＋「再來一局」按鈕**（`finished` 階段疊加畫面，勝負公告旁邊）：跟 `joinAsPlayer1Ref`／`handleInputEventRef` 同一種 ref 橋接模式。按下去做兩件事：(a) 把兩個角色的視覺狀態歸位——位置回到 `baseX`/`baseY`、`moveInput`/`jumpStartedAt`/`hitFlashUntil` 都清空、動畫強制重播回 idle（`playClip(..., force:true)`，因為角色可能還定格在死亡姿勢）；(b) 呼叫 `resetMatch()`。視覺歸位是 `PkArenaView.tsx` 自己的責任，`pkMatchState.ts` 的 reducer 完全不知道角色位置這件事，跟攻擊距離判定同一種分工原則（見上面「移動與攻擊距離」）。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（89/89，這次新增 5 個：`pkMatchState.test.ts` 的 `resetMatch` 測試）／`vite build` 均已跑過且全過。**這兩項都還沒實機驗證**——玩家端全螢幕排版在真手機瀏覽器（含瀏海/安全區域）上有沒有元素互相蓋到、「再來一局」按下去角色歸位的視覺有沒有違和感（例如從死亡姿勢瞬間跳回待機姿勢，中間沒有任何過場），都需要使用者實測後才會知道。

- **2026-08-18 追加：玩家端畫質模糊、確認鏡頭 PIP 沒有在改版中遺失**（使用者實測回報）：
  1. **畫質模糊**：根因是 WebRTC 預設把 `canvas.captureStream()` 這類來源當一般視訊通話處理，編碼器優先顧「動態流暢度」犧牲清晰度——這份畫面是 3D 場景＋血量文字 UI，清晰度比流暢度重要得多。修法：`PkArenaView.tsx` 的 `startBroadcastTo()` 幫視訊軌設定 `track.contentHint = 'detail'`（明確告訴瀏覽器優先顧清晰度），並透過 `sender.setParameters()` 把 `maxBitrate` 拉高到 3Mbps（預設值是為了一般視訊通話調的，明顯不夠）。`setParameters()` 失敗（少數瀏覽器在協商完成前呼叫會拒絕）不影響功能，用 `.catch()` 吞掉，最多是退回預設畫質，不會整個壞掉。
  2. **確認鏡頭 PIP 沒有遺失**：上一輪把 `PkControllerView.tsx` 整個 JSX 重排成全螢幕疊加式版面時，鏡頭 PIP（`videoRef`／`overlayRef`）跟背後的手勢辨識 effect 完全沒有被動到，只是從「頁面排版流裡的一個區塊」改成「絕對定位疊在右下角」——程式碼審閱過一次確認邏輯沒有被破壞。**順手修掉一個排版過程中沒注意到的疊圖問題**：`cameraError` 錯誤訊息原本是貫穿畫面底部的一整條，會跟右下角鏡頭 PIP、左下角手勢提示疊在一起看不清楚——改成一個獨立的深紅底色提示框，疊在鏡頭 PIP／手勢提示那一排的正上方，不再互相遮擋。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（89/89，沒有新增純函式，這兩項都是瀏覽器 API 參數調整跟 CSS 排版修正）／`vite build` 均已跑過且全過。**畫質修正沒有實機驗證過**——`maxBitrate=3Mbps`、`contentHint='detail'` 是根據 WebRTC 已知的行為模式推斷的合理修法，不是量出來的最佳值，使用者實測後如果還是不夠清楚，可以再往上調 `maxBitrate`（例如 5Mbps），或者降低 `WEBRTC_FPS` 讓每一幀分到的位元率更多。

- **2026-08-18 追加：修正玩家二移動方向反了、擴大後退邊界讓角色退得到畫面邊緣**（使用者實測回報：「記得玩家2他是在畫面右邊，所以她的移動控制要反向，然後兩個角色目前都沒辦法退到畫面邊界的位置」）：
  1. **玩家二移動方向反了**：先前「移動與攻擊距離」那次追加時，`ADVANCE_DIRECTION`（`{ player1: 1, player2: -1 }`）是依角色朝向（`rotation.y`）反推的合理猜測，當時就已經在文末標註「沒有視覺驗證過，如果方向感覺反了只需要把兩個值對調」——使用者實機測試後回報玩家二（站在畫面右側）方向確實反了。**已修正**：把 `ADVANCE_DIRECTION.player2` 從 `-1` 改成 `1`，兩個 slot 現在同號。這次直接採信使用者對即時畫面的第一手觀察，不再回頭重新用幾何去反推對錯——只有使用者看得到實際跑起來的畫面。
  2. **兩個角色都退不到畫面邊界**：原本 `updateMovement()` 的後退邊界就是出生點 `baseX` 本身，但固定鏡頭實際框到的可視範圍比出生點寬，導致畫面兩側各留了一截角色永遠到不了的空白。**已修正**：`CharacterRig` 新增 `retreatLimitX` 欄位（＝`baseX * RETREAT_LIMIT_FACTOR`，`RETREAT_LIMIT_FACTOR=1.6`，肉眼估的比例，不是從 camera FOV／位置精算出的每像素可視邊界），`updateMovement()` 的後退夾限改成用 `retreatLimitX` 而不是 `baseX`。**`baseX` 保留原本用途不變**——「再來一局」時的角色歸位（`rematchRef`）仍然用 `baseX`，只有「這一局戰鬥中能退多遠」這個判定換成新欄位，兩者職責分開，不共用同一個數字。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（89/89，沒有新增純函式——兩項都是 `PkArenaView.tsx` 內部的角色位置/方向常數調整，跟既有的三維渲染邏輯一樣不寫自動測試）／`vite build` 均已跑過且全過。**`RETREAT_LIMIT_FACTOR=1.6` 沒有實機驗證過**，是合理猜測的倍率，不是從鏡頭實際可視範圍精算出來的；使用者實測如果角色退到邊界時還是有落差（太少或太多），可以直接調整這個常數，不影響其他邏輯。

- **2026-08-18 追加：移動控制從「手在畫面裡的絕對位置」改成「手腕傾斜角度」**（使用者實測回報：「移動控制如果是靠手指尖端這樣指向，反轉手指時非常吃力且難操作，請幫我想新的方法」）。原設計（見前面「新增移動＋攻擊距離」那次追加）要往右移動就得把整隻手臂橫向擺到畫面右邊、往左移動又要整隻手臂拉回左邊，大幅度橫向擺動很吃力。跟使用者確認過三個候選方案（手腕傾斜角度／靜態手勢形狀當步伐／前進後退各一個點按手勢）後，選擇**手腕傾斜角度**（`AskUserQuestion` 推薦選項，理由：手不用移動位置，只要小幅度側傾，且能沿用既有死區/平滑架構，不像另外兩個方案要重新分配手勢類別、可能跟攻擊/防禦的既有手勢衝突）：
  1. **`pkMovement.ts` 整個換掉輸入源**：新增 `handTiltAngle(wrist, middleMcp)`（讀 `landmarks[0]`→`landmarks[9]`，手腕到中指根部的向量夾角，用 `Math.atan2` 算相對垂直向上的傾斜弧度）取代原本直接讀 `landmarks[0].x`；`mirrorAngle()` 取代 `mirrorX()`（鏡像顯示時角度也要反相）；`tiltToMoveValue()` 取代 `handToMoveValue()`（`ANGLE_DEAD_ZONE=0.14` 弧度死區、`ANGLE_MAX_TILT=0.7` 弧度滿刻度，都是合理猜測的手腕舒適活動範圍，不是量出來的）；`smoothValue()`（原 `smoothHandX()` 改通用名字，EMA 平滑公式本身沒變）。方向慣例沿用舊版「手勢對應前進的那一側＝前進」，改成「手腕左傾＝前進、右傾＝後退」。
  2. **`PkArenaView.tsx`／`PkControllerView.tsx` 呼叫處同步改**：`smoothedHandX` 改名 `smoothedTiltAngle`，讀 `landmarks[0]`（手腕）跟 `landmarks[9]`（中指根部）兩個點算角度，其餘節流/平滑/重置為 null 的邏輯不變。`PkControllerView.tsx` 的手勢提示文案從「👈👉 手放左/右移動」改成「🤙 手腕左/右傾斜移動」。
  3. `pkMovement.test.ts` 全部重寫（92 個測試，原本 12 個移動相關測試換成 15 個：`handTiltAngle`／`mirrorAngle`／`tiltToMoveValue`／`smoothValue`）。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（92/92）／`vite build` 均已跑過且全過。**這次改動完全沒有實機驗證過**——`ANGLE_DEAD_ZONE`／`ANGLE_MAX_TILT` 是合理猜測的弧度值，不是量出來的手腕舒適活動範圍，使用者實測後如果覺得太靈敏/太遲鈍，可以直接調這兩個常數；「左傾＝前進」的方向慣例也還沒實測過，如果感覺反了，比照之前 `ADVANCE_DIRECTION` 的教訓，直接在 `tiltToMoveValue()` 裡把 `tilt = -angle` 的負號拿掉即可。

- **2026-08-18 追加：單人測試模式，主持人可跳過等待玩家二直接進入 battle（除錯用）**（使用者需求：「現在支援單人也可直接進入遊戲(為主持人排除問題所用)」）。動機：每次要確認鏡頭/手勢辨識/移動/攻擊動畫（尤其是這次連續修的移動方向、後退邊界、傾斜控制這幾項）都得真的抓一支手機當玩家二才能讓 `phase` 離開 `'waiting'`，`handleInputEvent()` 的 `move`／`attack` 分支都卡在 `wasBattling`（`phase === 'battle'`）才處理——沒有玩家二，主持人自己怎麼比手勢都不會有任何反應，沒辦法自己驗證前面那幾次修復。
  1. **`pkMatchState.ts` 新增 `startSoloBattle(state)`＋6 個測試**：只在 `phase === 'waiting'`、玩家一已加入、玩家二還是 `null` 時生效，直接把 `phase` 設成 `'battle'`（**跳過 `countdown`**——除錯用途不需要儀式感的倒數），玩家二欄位維持 `null`。刻意不特別處理「沒有對手」的情況，因為既有邏輯已經天然安全：`applyInput()` 攻擊分支的 `if (!target) return state` 對著空 target no-op，不會誤判勝負；之後玩家二真的用手機掃 QR code 加入時，`applyJoin()` 照樣把她塞進 `player2`，直接併入這場已經在打的 battle（`maybeStartCountdown()` 只在 `'waiting'`/`'paused'` 才觸發，不會因為半路加入而重新倒數）。
  2. **`PkArenaView.tsx`**：新增 `soloDebugRef`（跟 `joinAsPlayer1Ref`／`rematchRef` 同一種 ref 橋接模式），waiting 畫面新增「單人測試模式（跳過等待，直接進入除錯）」按鈕，只在玩家一已就緒、玩家二還沒加入時顯示。血條區塊原本要兩人都加入才顯示（`uiState.player1 && uiState.player2`），新增一個單人測試模式專用的版本，只在單人測試中顯示玩家一自己的血條，讓主持人看得到基本回饋畫面，不用等湊到兩人才有任何 UI。
  3. **沒有改到 `PkControllerView.tsx`**：這是擂台端（主持人）專屬的除錯捷徑，操控端（玩家二）的加入流程完全不受影響，玩家二隨時可以正常掃碼加入。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（98/98，新增 6 個 `startSoloBattle` 測試）／`vite build` 均已跑過且全過。**沒有實機驗證過**——邏輯本身很單純（純狀態機分支＋既有安全機制天然覆蓋), 主要風險是 UI 呈現（按鈕位置、單人血條版面）有沒有跟其他 waiting 畫面元素（QR code、IP 輸入框）打架，需要使用者實測確認。

- **2026-08-18 追加：修正手腕傾斜移動控制方向反了（玩家一、玩家二都反）**（使用者實測回報：「玩家一 玩家二的移動控制方向都要對調過來」）。上一次追加（改成手腕傾斜角度控制）文末已經預留這個修法：「左傾＝前進」的方向慣例當時完全沒實機驗證過，只是合理猜測；使用者實機測試後，兩位玩家都回報方向是反的——因為兩人共用同一套「鏡像修正後角度 → 前進意圖」的轉換（`tiltToMoveValue()`），不是各自 slot 的世界座標方向問題（那個在更早之前已經用 `ADVANCE_DIRECTION` 修過，兩個 slot 現在同號），所以兩人同時反了，只需要修一個地方。**已修正**：`pkMovement.ts` 的 `tiltToMoveValue()` 把 `const tilt = -angle` 改成 `const tilt = angle`，方向慣例從「左傾＝前進」改成「右傾＝前進」。`pkMovement.test.ts` 對應的方向測試（角度正負與前進/後退的對應）跟著對調。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（98/98，測試數量不變，只是把既有測試的期望值對調，不是新增）／`vite build` 均已跑過且全過。**沒有再次實機驗證過**——這是根據使用者第一手觀察直接對調方向，跟之前修正 `ADVANCE_DIRECTION` 同一個處理原則（相信操作者對即時畫面的回報，不回頭用幾何重新論證對錯）；如果這次調過頭變成真的反過來（不太可能，但保險起見寫下來），復原方式一樣是把 `tiltToMoveValue()` 的 `const tilt = angle` 改回 `const tilt = -angle`。

- **2026-08-18 追加：血量調成 3 倍**（使用者需求：「將雙方血量乘3倍」）。`pkProtocol.ts` 的 `HP_MAX` 從 `100` 改成 `300`，`ATTACK_DAMAGE`（20）沒有動——單純拉長對戰時間（原本 5 拳分勝負，現在 15 拳），命中判定/防禦/攻擊距離/血條 UI 完全不受影響。整個 codebase 沒有任何地方寫死 `100` 這個數字，所有血量相關的邏輯跟測試都是引用 `HP_MAX` 這個常數算出來的（例如 `Math.ceil(HP_MAX / ATTACK_DAMAGE)` 動態算需要幾拳分出勝負），所以只需要改這一行常數。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（98/98，測試數量不變，既有測試透過 `HP_MAX` 常數自動跟著調整，不用手動改期望值）／`vite build` 均已跑過且全過。純數值常數調整，沒有額外風險，不需要實機驗證。

- **2026-08-18 追加：移動控制的量測起點從「手腕」改成「食指自己」**（使用者需求：「單純手腕傾斜可能會誤判 改由 手指傾斜角度 方向與現在一致」）。前一次把移動控制從絕對位置改成手腕傾斜角度（`wrist→middleMcp`，`landmarks[0]→landmarks[9]`）時，向量起點在手腕，會同時受整隻手掌的位置/朝向影響——使用者只是自然轉動或移動手掌（不是刻意要控制移動，例如順手調整鏡頭角度、或做攻擊/防禦手勢時手掌本來就會轉動）也可能被誤判成移動意圖。**已修正**：改成量測食指自己的傾斜角度，向量起點/終點都在食指這一節上（`indexMcp→indexTip`，`landmarks[5]→landmarks[8]`），不經過手腕——手掌整體怎麼移動/轉動都不影響這個角度，只有食指自己刻意的指向/彎曲角度才會被讀到。
  1. `pkMovement.ts` 只改了 `handTiltAngle()` 的參數語意（`wrist/middleMcp` 改成 `fingerBase/fingerTip`）跟檔頭/其餘常數的說明文字，**公式本身沒變**（一樣是 `atan2(dx, -dy)`），`mirrorAngle()`／`tiltToMoveValue()`／`smoothValue()` 三個函式完全沒動——「方向與現在一致」这个要求因此自動滿足，不用額外處理，因為方向慣例只跟公式與 `tiltToMoveValue()` 的正負號有關，跟量測起點選在手腕還是食指無關（食指伸直朝上時，指尖一樣在指根「上方」，跟手腕→中指根部同一個上下關係，不會翻轉）。
  2. `PkArenaView.tsx`／`PkControllerView.tsx` 呼叫處：`landmarks[0], landmarks[9]` 改成 `landmarks[5], landmarks[8]`（MediaPipe 手部 21 點模型：5＝食指根部 INDEX_FINGER_MCP、8＝食指指尖 INDEX_FINGER_TIP）。`PkControllerView.tsx` 手勢提示文案從「🤙 手腕左/右傾斜移動」改成「☝️ 食指左/右傾斜移動」。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（98/98，只改了兩則測試描述文字，斷言本身不變——`handTiltAngle()` 是純幾何函式，不管兩個點實際代表手腕/食指的哪個關節，測試邏輯完全通用）／`vite build` 均已跑過且全過。**沒有實機驗證過**——食指伸直時 landmark 追蹤穩不穩定、握拳/防禦手勢進行中食指彎曲時角度會不會變得不穩定（食指節本身比手掌短，量測噪訊的絕對影響理論上比手腕版更大，但誤判來源改善了，兩者的淨效果要實測才知道），都需要使用者實測後回饋。

- **2026-08-18 追加：攻擊時鎖住移動控制＋順手抓出並修掉一個鏡頭疊圖對不準的 bug**（使用者需求：「進行空白件攻擊時 讓移動控制指令失效 且你額外檢查玩家二畫面渲染有沒有問題」——「空白件」判讀為語音輸入誤植，依上下文理解為「攻擊時」）。
  1. **攻擊時移動控制失效**：`CharacterRig` 新增 `attackLockedUntil: number`（`performance.now()` 的鎖定截止時間戳，0＝沒鎖）。`handleInputEvent()` 的攻擊分支出拳當下立刻 `moveInput = 0`（角色定住）並把 `attackLockedUntil` 設成「現在＋整段揮擊動畫的長度」（不是只鎖到命中判定那一刻——命中判定的 `impactDelayMs` 只決定「什麼時候扣血」，跟「動畫播完前不能動」是兩件事，這次刻意分開兩個時間量）；`move` 分支在鎖定期間直接忽略輸入。`rematchRef` 的視覺歸位也順手清掉這個欄位，避免上一局的鎖定殘留到新的一局。跟大部分格鬥遊戲「出招中不能位移」是同一個直覺。這段是 three.js 場景內部的純狀態調整，跟既有的移動/攻擊邏輯一樣屬於「薄膠水層」，沒有寫新的單元測試。
  2. **額外檢查玩家二（`PkControllerView.tsx`）畫面渲染，抓到一個真的 bug**：自己鏡頭 PIP 裡的手勢骨架疊圖（`overlayRef` 的 `<canvas>`）用 `absolute inset-0 h-full w-full` 定位，理論上應該精準貼合 `<video>` 的實際渲染尺寸；但顯示手勢文字（例如「Closed_Fist」）的 `<p>` 原本**不是** absolute，是一般文件流裡的元素，會把外層 `w-28`／`w-32` 那個 PIP 容器的高度撐高（video 本身高度 + 這行文字的高度）。`<canvas>` 的 `h-full` 吃到的是撐高後的總高度，不是 video 自己的高度，導致骨架疊圖的畫布被垂直拉伸、跟鏡頭畫面裡實際的手對不準（愈往下愈明顯）——**這個情況剛好發生在 `cameraStatus === 'active'` 的正常遊玩狀態**（手勢文字顯示的時候），不是邊角情境。**已修正**：把這個 `<p>` 改成 `absolute inset-x-0 bottom-0`，疊在 video 底部而不是撐開容器，PIP 容器的高度就只由 video 自己的渲染高度決定，疊圖能精準對齊。同一個 bug、同一個成因，也存在於 `PkArenaView.tsx` 玩家一自己的鏡頭 PIP（兩邊是同一份骨架複製過去的，見兩檔案的說明註解），**一併修正**，不是只修玩家二那邊。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（98/98，這兩項都是 UI/three.js 場景內部的純狀態或版面調整，跟既有慣例一樣不寫自動測試）／`vite build` 均已跑過且全過。**都沒有實機驗證過**——攻擊鎖定的時長（整段揮擊動畫）手感是否太長／太短需要實測；疊圖對齊修正是純 CSS 定位邏輯推導出來的（外層容器高度來源分析），理論上正確，但沒有在真的瀏覽器裡開鏡頭肉眼確認過骨架線是不是真的貼上手了。

- **2026-08-18 追加：攻擊移動鎖定時長改成只鎖 60%，不鎖整段動畫**（使用者需求：「攻擊的後半段動作可能要截掉 否則會停留過長的僵直時間 你評估一夏」——評估結論：這個疑慮成立，見下方理由，已直接採用建議修正）。上一次追加把 `attackLockedUntil` 設成「命中判定當下＋整段揮擊動畫的長度」，但命中判定本身在動畫播到 `ATTACK_IMPACT_FRACTION`（0.35）就發生了，命中之後到動畫真正播完之間的「收拳/回防」尾段，通常是整段揮擊動畫裡最長的一截，鎖滿全長會讓角色打完一拳後有一段明顯僵住的空窗——現在血量調到 3 倍（見前面「血量調成 3 倍」那次追加）要打更多拳，這個空窗感會被放大很多次，值得先修掉。
  1. 新增 `ATTACK_LOCK_FRACTION = 0.6`（跟 `ATTACK_IMPACT_FRACTION` 一樣是合理猜測，沒有實機對過影格）：`attackLockedUntil` 改成 `performance.now() + attackDurationMs * ATTACK_LOCK_FRACTION`，鎖定時長蓋過命中那一刻（0.35）但砍掉大半收拳尾段（不鎖到 1.0）。
  2. **刻意不裁切動畫本身**：`playClip()` 的播放沒有被截斷，揮擊動畫依然完整播到底——「後半段動作截掉」字面上是裁切 clip，這裡改成只提早解鎖移動控制，達到同樣的操作手感目的（打完立刻能動），但實作成本小很多，不用碰 three.js `AnimationAction` 的淡出/中斷邏輯。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（98/98，純數值常數＋既有欄位的用法調整，沒有新增邏輯分支，跟前一次一樣不寫自動測試）／`vite build` 均已跑過且全過。**沒有實機驗證過**——`ATTACK_LOCK_FRACTION=0.6` 是合理猜測的比例，不是量出來的最佳值，使用者實測後如果還是覺得僵直太長/太短，可以直接調這個數字（範圍是 `(ATTACK_IMPACT_FRACTION, 1.0)` 之間才合理：太小會在動畫播到看起來還沒揮完就能亂動，太大等於沒修）。

- **2026-08-18 追加：攻擊移動鎖定改成命中特效觸發當下就解鎖，取消 `ATTACK_LOCK_FRACTION`**（使用者需求：「攻擊特效觸發後馬上解除移動鎖定 不再像之前一樣全程鎖定 讓攻擊與移動銜接更流暢」）。上一輪把鎖定時長從整段動畫（1.0）砍到動畫長度的 0.6，這次使用者進一步要求鎖定時長直接對齊命中判定的時間點（`ATTACK_IMPACT_FRACTION`＝0.35），不要再用一個獨立的比例常數。**已修正**：拿掉 `ATTACK_LOCK_FRACTION` 這個常數，`attackLockedUntil` 改成 `performance.now() + impactDelayMs`——`impactDelayMs` 本來就是命中判定/扣血用的延遲時間，現在移動鎖定的解鎖時機直接沿用同一個數字，不是另外算一個比例。命中特效一觸發（不論這拳實際上有沒有打中在攻擊距離內的對手——鎖定時長只跟動畫播放時機有關，跟命中判定結果無關），移動控制立刻恢復。動畫本身依然完整播到底，沒有被截斷。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（98/98，拿掉一個常數＋改一行賦值，沒有新增邏輯分支）／`vite build` 均已跑過且全過。**沒有實機驗證過**——命中判定延遲（`ATTACK_IMPACT_FRACTION=0.35`）本身也還沒實機對過影格，使用者實測後如果覺得移動解鎖得太早/太晚，可以回頭調整 `ATTACK_IMPACT_FRACTION` 這一個數字（現在移動鎖定跟命中判定共用同一個時間點，兩者會一起變動，不用分開調）。

- **2026-08-18 追加：命中特效觸發時直接把揮擊動畫剪到待機動畫，不等它自然播完**（使用者需求：「攻擊動作後半段還是太長了」）。前一輪只解決了「移動控制」被鎖太久的問題，但揮擊動畫本身（`Attack2` clip）的收拳/回防尾段依然完整播放到底，視覺上還是拖得太長——移動控制解鎖了，但角色看起來還在慢動作收拳。**已修正**：`handleInputEvent()` 攻擊分支延後判定命中的 `setTimeout` 回呼裡，通過 `attackToken` 檢查後，立刻呼叫 `playClip(attackRig, PK_ANIMATION_MAP[attackSlot].idle, false)` 淡出切回待機動畫，不等 `Attack2` clip 自然播完，真的把後半段剪掉（不是只解鎖控制而已）。這段判斷放在距離/命中檢查**之前**——不管這拳有沒有真的打中對手，動畫該收就收，跟戰鬥結果無關；如果使用者緊接著又出下一拳，`attackToken` 已經不符，這個 timeout 直接提早 return，不會執行到，不會跟下一拳 `force:true` 的新揮擊動畫互搶（新一拳的 `playClip` 呼叫本來就會蓋過去）。
- **驗證狀態（這次追加）**：`tsc -b`／`oxlint`／`vitest run`（98/98，只是在既有的 `setTimeout` 回呼裡多一行 `playClip` 呼叫，沒有新增狀態欄位或邏輯分支）／`vite build` 均已跑過且全過。**沒有實機驗證過**——`playClip()` 用的淡出時間是預設值（0.15 秒），沒有針對「攻擊收得夠不夠俐落」這個新情境特別調過，如果使用者實測覺得從揮擊切回待機的過渡還是不夠俐落（或太生硬），可以調這裡呼叫時的 `fadeSec` 參數。

## 待辦：補建 GitHub Issue

跟前幾份 spec 一樣，如果這台機器沒有 `gh` CLI 或尚未登入，日後補建：

```bash
gh issue create \
  --repo reqw123/question \
  --title "desktop-pet-web：手勢 PK 對戰模式（雙人區網對戰）" \
  --body-file docs/specs/0013-desktop-pet-web-gesture-pk-mode.md \
  --label ready-for-agent
```
