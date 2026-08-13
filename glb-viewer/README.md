# glb-viewer

獨立測試用資料夾，跟 `desktop-pet-web`（PIXI + Live2D/Spine）完全分開，不共用程式碼、
不共用依賴。唯一目的：驗證 `D:\至臻_腥红之月_亚托克斯.glb` 這份 glTF 2.0 3D 模型能不能
正常載入、播放骨架動畫——這是「能不能用」的可行性測試，還沒有回答「要怎麼整合進
desktop-pet-web 的卡片輪播」，那是下一步的問題。

## 為什麼另外開資料夾

`.glb` 是真正的 3D 網格模型（骨架蒙皮動畫），跟 desktop-pet-web 現有的 Live2D／Spine
（2D 貼圖＋骨架變形，都在同一個 PIXI 共用畫布上）是完全不同的渲染技術，需要 Three.js
這種 3D 引擎才能顯示，沒辦法塞進現有的 PIXI stage。

## 執行方式

```
cd glb-viewer
npm install
npm run dev
```

打開瀏覽器後可以用滑鼠拖曳旋轉視角（OrbitControls）、滾輪縮放，左上角下拉選單可以切換
97 個具名動畫（Idle1、Attack1~3、Death、Q1~Q3 技能、ULT、Recall、Dance、Taunt…）。

## 已知資訊（見排查記錄）

- glTF 2.0，`glTF-Transform v4.2.1` 產生
- 1 個 mesh、1 組骨架（skin）、4 個材質、2 張貼圖、97 個動畫
- 用了 `KHR_materials_unlit` 擴充（材質不吃光照，顏色直接來自貼圖，相容性風險低）
- 檔案 16MB，比目前用的 Spine 資產（雅絲娜 ~2.1MB、亞托克斯機甲 ~3.1MB）大上好幾倍，
  真的要整合進網頁得考慮載入時間
