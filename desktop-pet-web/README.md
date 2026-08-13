# desktop-pet-web

「桌寵陪伴」的介紹網頁，獨立靜態網站，跟 `../desktop-pet/`（Electron App 本體）是**不同專案**、不共用前端程式碼，但頁面裡的「本機控制面板」會即時呼叫 `desktop-pet/` 新增的本機控制伺服器，操作正在跑的桌寵。

## 技術棧

React + TypeScript + Vite + Tailwind CSS v4，動畫用 `motion`，圖示用 `lucide-react`，class name 用 `cn()`（`clsx` + `tailwind-merge`，見 `src/lib/utils.ts`）。

從 `C:\web` 專案的多頁範本抽出來的單頁版本，原專案的規範/流程見 `C:\web\.claude\CLAUDE.md`、`C:\web\PROMPT_TEMPLATE.md`。

## 執行

```bash
npm install
npm run dev
```

## 本機控制面板

`src/pages/desktop-pet/components/ControlPanel.tsx` 會每 4 秒輪詢 `http://127.0.0.1:47821/status`，判斷桌寵有沒有在跑；有的話可以按按鈕遙控：讓牠出現/躲起來、切互動/穿透模式、觸發隨機動作、還原位置。

**先決條件**：`../desktop-pet/` 要先 `npm start` 跑著，這個面板才叫得動——控制伺服器（`../desktop-pet/control-server.js`）只綁定 `127.0.0.1`，只接受同一台電腦、Origin 是 `localhost`/`127.0.0.1` 的請求，沒辦法從別的電腦或公開架設的版本操控。API 定義見 `src/lib/petControl.ts`。

**互動模式安全網**：桌寵視窗蓋滿整個主螢幕，切成互動模式後會攔截整個螢幕的滑鼠事件（包含這個網頁本身），所以透過這個面板切換時，10 秒沒人再手動切一次會自動跳回穿透模式，避免卡死；面板上會顯示倒數。用 F9／系統匣選單切換則不受影響（原本就不會被卡住）。

## Hero 區塊的 Live2D 即時展示

`src/pages/desktop-pet/components/Live2DCard.tsx` 會直接在瀏覽器裡渲染真正的 Live2D 角色（目前先固定顯示模型 077），取代原本的星星圖示佔位。

- **執行環境**：`public/lib/` 底下的 `pixi.min.js`／`live2dcubismcore.min.js`／`all.min.js` 是 `C:\question\lib\` 的唯讀複製，不是另外裝 npm 版本——確保跟 `live2d_my_like/models/` 裡的資源相容性一致。載入方式參考 `live2d_my_like/viewer.html` 已驗證過的最小流程：`new PIXI.Application` → `PIXI.live2d.Live2DModel.from(model3.json)` → `app.stage.addChild`。
- **模型資源**：`public/live2d/077/` 是 `live2d_my_like/models/077/` 的唯讀複製（`.moc3`／`.model3.json`／動作/材質檔），Vite 開發伺服器不能直接讀專案外的檔案，所以複製進來自成一份，換角色要手動複製新的模型資料夾進來、改 `Live2DCard.tsx` 的 `MODEL_URL`。
- **a11y**：卡片本身標成 `role="img"` + `aria-label`（不是 `aria-hidden`），因為現在是有意義的視覺內容，不再是純裝飾圖示；`prefers-reduced-motion` 時會凍結待機動作循環（角色停在目前姿勢），不會整個消失。
- ⚠️ 這一版只驗證了資源都能被正確請求到（200）、`tsc`/`lint`/`build` 全過，本機沒有瀏覽器自動化工具，實際 WebGL 渲染畫面**還沒有人眼確認過**，請自行開 `npm run dev` 產生的網址看一下 Hero 區塊右邊是否真的顯示出角色。

## 待確認

- `src/pages/desktop-pet/components/CTA.tsx` 的聯絡信箱是佔位用的 `hello@example.com`，正式使用前請換成真實信箱。
