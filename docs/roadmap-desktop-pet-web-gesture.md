# desktop-pet-web 手勢功能開發清單（手勢拖曳 + 手勢動作觸發）

> 這是backlog/規劃清單，不是單一功能的 spec——每一項真的要動工時，請對照 `docs/agents/domain.md` 的流程另外走一輪 grilling，視需要產出獨立的 `docs/specs/00XX-*.md` / `docs/adr/00XX-*.md`，不要直接照這份清單的描述動工。

**現況**（2026-08-18）：Hero 卡片有「手勢拖曳」（移動模型位置，`docs/adr/0011`），Aatrox 3D 展示卡片有「手勢動作觸發」（比 👍 觸發選定動作，`docs/adr/0013`）。兩者都刻意收斂成單一互動、跟真桌寵（`control-server.js`）解耦。

## 🟢 小補強（不牽涉任何既有 ADR 邊界，隨時可以單獨動工）

- [ ] **手勢模式首次開啟的引導提示**：PIP 剛出現時疊一行「比個 👍 試試看」，幾秒後自動淡出。
- [ ] **信心分數視覺化**：`GestureRecognizer` 回傳的 `gestures[0][0].score` 目前沒用到，可以加一個小進度條。
- [ ] **行動裝置 RWD 檢查**：PIP 目前固定 `w-32 sm:w-36` 疊在右上角，需要實機/裝置模擬確認沒有蓋住操控按鈕或跑出卡片邊界；前鏡頭在手機上預設自拍鏡頭，鏡像邏輯要重新確認。
- [ ] **Playwright 迴歸測試**：不需要真鏡頭，mock `GestureRecognizer.createFromOptions` 回傳假結果，驗證按鈕互斥 disable／PIP 掛載卸載／捲出視窗自動關閉這幾個目前只能手動測的行為。

## 🟡 中型擴充（會碰到 ADR-0013 明確排除的範圍，動工前先開一輪 grilling 重新確認取捨）

- [ ] **第二種手勢對應第二個固定動作**（例如 ✌️ Victory → 另一個固定招式）。
- [ ] **手勢對應可自訂**：使用者自己設定「哪個手勢對應下拉選單裡的哪個動作」，存 localStorage。
- [ ] **操控模式＋手勢模式並存**：目前互斥（避免打字/WASD 被鏡頭誤判），要並存需先解決這個誤判問題。
- [ ] **手勢功能延伸到 Hero 區塊角色**：目前 Hero 只有手勢拖曳、Aatrox 展示卡只有觸發，要不要讓兩邊能力對齊。

## 🔴 大型/長期方向（規模超出單一晚間項目，需要重新走一輪完整 spec+ADR 流程）

- [ ] **雙手手勢／組合手勢**：`numHands: 1` 目前寫死只認一隻手。
- [ ] **手勢縮放/旋轉 3D 模型**：會跟現有滑鼠 `OrbitControls` 搶輸入，需要新的座標映射。
- [ ] **效能分級降級策略**：低階裝置上 WASM+GPU delegate 可能拖垮 FPS，目前只有「GPU 失敗 retry CPU」這個二元判斷。
- [ ] **無障礙替代路徑盤點**：手勢功能天生排除視障/行動不便的使用者，需要 `aria-live` 宣告手勢模式的狀態變化。
- [x] **手勢 PK 對戰模式**（2026-08-18 新增並實作完成，含區網存取＋QR code＋自動偵測 IP＋擂台端本人即玩家一的架構修訂，見下方；手動雙裝置驗證尚未執行，`getUserMedia()` 在區網 `http://` 環境能否使用是目前最大的未知數，見 `docs/specs/0013` 的「已知風險」）。

## ⚙️ 治理

- [ ] 每次真的動工，先確認要不要修訂既有 ADR（如果動到它明確排除的範圍）或另開新 ADR。
- [ ] `CONTEXT.md` 詞彙隨每次擴充同步更新。
- [ ] 這台機器沒有 `gh` CLI，之後裝好並登入，可以把這份清單裡確定要做的項目建成 GitHub Issue（`ready-for-agent` 標籤）。

---

## 手勢 PK 對戰模式（2026-08-18，需求訪談中）

使用者決定的下一個大項目：新增「手勢 PK 模式」——全螢幕兩個 3D 模型對決，兩位玩家各自用手勢控制攻擊/防禦/跳躍等動作，透過區網連線對戰。第二個模型已確認存在：`public/characters/models/菁英計畫_魔鬥凱薩.glb`（Mordekaiser，跟現有 Aatrox 同樣是 League of Legends 角色模型，含 `KHR_materials_unlit` 材質、單一 mesh，動畫命名慣例與 Aatrox 模型一致）。

**已查證的關鍵事實**（影響需求訪談的技術限制）：
- 兩個模型都**沒有原生「跳躍」動畫**——LoL 角色本身遊戲內不會跳躍，`Idle`/`Attack1-2(-3)`/`Spell1-4`/`Death`/`Respawn`/`Taunt`/`Dance` 這類是兩邊都有的動畫類別，但沒有 Jump/Hop 這種東西。
- 兩個角色的技能動畫**不對稱**：Aatrox 有 Attack1/2/3 三種普攻、Mordekaiser 只有 Attack1/2 兩種；Mordekaiser 有明確的護盾類動畫（`Spell2_Consume_Shield.anm`），Aatrox 沒有對應的防禦類動畫。
- 兩者都有 `Death`／`Respawn`（可以撐起「被打死→重生」的回合制邏輯）、`Crit`（可以當作重擊/大招的候選動畫）。

**訪談結論**：一個擂台端（全螢幕顯示＋判定）＋兩支手機遙控器（純手勢輸入，不渲染 3D）；複用 `multi/` 現有 MQTT broker，新開 `pk/*` topic 命名空間；單一場次、無房間碼，先連上的是 Aatrox、第二個是 Mordekaiser；攻擊＝✊邊緣觸發、跳躍＝✌️邊緣觸發（程序化位移模擬，兩模型都沒有原生跳躍動畫）、防禦＝🖐️持續狀態；命中判定看「攻擊當下對方是否在防禦」；血量條＋`Death`/`Respawn`；3-2-1 倒數才開打；真正的 Fullscreen API，ESC 直接結束整場 PK；斷線暫停等重連（沿用 `multi/` 的心跳/離線門檻）；這次範圍不含音效／再來一場按鈕。完整規格見 `docs/specs/0013-desktop-pet-web-gesture-pk-mode.md`，取捨理由見 `docs/adr/0014-desktop-pet-web-gesture-pk-mode-scope.md`。
