// 候選 GLB 模型清單 + 各自的粒子取樣校正參數。particle-effect.js 只要改 ACTIVE_MODEL
// 這一個 key 就能換模型，不用碰其他程式碼或重新試校正數字。
//
// 每個項目的欄位：
//   file:     models/ 底下的實際檔名
//   particle: 取樣校正，對應 particle-sampler.js 的 sampleModelToParticles(resource, config, ...)
//
//     scale / position / rotationX/Y/Z
//       套用順序：先 scale，再 rotate，最後 translate。scale/position 兩個都不填時交給
//       particle-sampler.js 自動置中縮放（見該檔案 computeBounds()）——算包圍盒只採計
//       有實際三角形面積的頂點，不會被沒有面積的「幽靈頂點」灌水縮放基準，多數模型
//       可以放心不填。rotationY 沒有自動偵測（GLB 沒有「正面朝哪」的語義），朝向不對
//       只能手動填這個欄位微調，或靠 idleMotion 的 spin 自轉遲早轉到鏡頭前。
//
//     animation / animationTime
//       取樣前先把模型 pose 定格在哪個動畫的第幾秒，不填就用 bind/rest pose。也可以是
//       陣列，但只有搭配 animatedIdle:true 才有意義——沒開 animatedIdle 時陣列只會取
//       第一個字串當單幀定格，其餘元素被忽略。
//
//     animatedIdle / animationFrames
//       「動畫粒子化」：粒子形狀跟著 animation 指定的那段（或那幾段，依序接成一條循環
//       播放的序列）動畫持續播放，不是定格單一姿勢。animationFrames 是整條序列要烘幾
//       張關鍵幀貼圖的總預算，依每段動畫長度比例分配；不填就依總秒數自動算（目標每秒
//       3 張，最少 8 張、最多 64 張，見 particle-sampler.js 的 ANIM_AUTO_FPS）。載入
//       時間/GPU 記憶體跟這個數字成正比，播起來不夠平滑或想省記憶體再手動覆寫。詳見
//       particle-sampler.js 的 sampleModelAnimationFrames()。
//
//     animationSpeed
//       animatedIdle 開著時整條序列的播放速度倍率：1（預設）＝原始秒數、2＝兩倍速、
//       0.5＝半速、0＝凍結在目前這一幀。負數會被強制拉回 0。跟 animationFrames 互不
//       影響——animationFrames 決定烘幾張貼圖，animationSpeed 決定播多快。
//
//     periodicAnimation
//       「定時動作」：平常維持定格姿勢不動，閒置滿 intervalSeconds 秒才觸發播一次
//       name 指定的動畫，播完自動退回定格姿勢（不循環）。跟 animatedIdle 互斥，一個
//       模型只能挑一種。欄位：
//         name:            要播哪一段（或哪幾段，陣列）動畫
//         intervalSeconds: 閒置幾秒觸發一次，不填預設用 DEFAULT_PERIODIC_INTERVAL_SECONDS（60）
//         frameCount:      關鍵幀貼圖張數，分配方式同 animationFrames
//         speed:           播放速度倍率，用法同 animationSpeed，但 ⚠️ 0 會讓觸發動作
//                          卡在播放中、永遠退不回定格姿勢，不確定要不要這個效果別填 0
//       閒置計時只在完全聚合、沒有轉場、使用者沒在拖鏡頭時累加；觸發動作播放中途拖
//       鏡頭不會中斷。詳見 particle-effect.js 的 advancePeriodicAnimation()。
//
//     sequenceAction
//       只有「模型序列播放」（見檔案最下面的 sequenceModels）會讀，平常單獨顯示這個
//       模型不受影響。序列播放到這個模型、進入停留段時會播放這段動作，不填就單純定格
//       在 animation/animationTime 那個姿勢。欄位：
//         name:       要播哪一段（或哪幾段，陣列）動畫
//         frameCount: 關鍵幀貼圖張數，不填依總秒數自動算
//       動作比停留時間短就自然循環播滿；比停留時間長就在停留時間結束時截斷，不會等
//       播完，也不會拉長停留時間配合。詳見 particle-effect.js 的 advanceSequencePlayback()。
//
//     sequenceVoice
//       只有「模型序列播放」會讀，平常單獨顯示這個模型不受影響。序列播放到這個
//       模型、轉場淡入完成、進入停留段那一刻起算，滿 0.3 秒後播放一次這個檔名
//       （particle-effect/audio/voice/ 底下的實際檔名，1~2 秒短語音，跟 file 欄位
//       同一種「只填檔名、資料夾固定」寫法）。不填或填空字串都跳過，不會出聲——
//       兩者視為同一件事，沒有「填空字串」跟「完全不填」的行為差異。每次序列播放
//       重新繞回這個模型的停留段都會再播一次，不是只有第一次生效。詳見
//       particle-effect.js 的 advanceSequencePlayback()。
//
//   color: 粒子顏色 [r, g, b]（0-1）。不填的話 loadModelTexture() 會用
//     sampleAverageMaterialColor() 從材質（優先貼圖平均色，沒有貼圖才用 baseColorFactor）
//     自動取色，取不到才退回預設淡藍色。想要自動效果就整欄不填，填 undefined/空陣列
//     仍算「有填」、不會觸發自動取色。
//
//   idleMotion: 完全聚合後、沒有拖鏡頭時的閒置動畫，不填預設是繞 Y 軸連續自轉。欄位：
//     type:      'spin'（預設，連續自轉）/ 'bob'（來回位移）/ 'swing'（來回擺動，跟
//                spin 差在有擺角上限會轉回去）
//     axis:      'x'/'y'/'z'，不填預設 'y'
//     amplitude: bob 是位移量、swing 是擺角（rad），不填各自有預設值（見
//                particle-effect.js 的 IDLE_BOB_AMPLITUDE / IDLE_SWING_AMPLITUDE）
//     speed:     動畫節奏，不填用預設值，數字越大動作越快
//
// 下面每個模型的 particle 區塊統一按「— 標籤 —」分組排版：1. 縮放/位置/旋轉
// 2. 動畫定格/循環 3. 定時觸發動作。用不到的欄位用註解列出欄位名＋預設值，完全不
// 適用的（通常是無骨架/動畫的靜態模型）用一行寫「為什麼不適用」。color/idleMotion
// 在 particle 區塊外，空一行分開。
export default {
  // ----------------------------------------------------------------------
  // 1
  // ----------------------------------------------------------------------
  aatroxModel: {
    file: '至臻_腥红之月_亚托克斯.glb',
    particle: {
      // — 縮放/位置/旋轉 —
      // scale / position 故意都不填，交給 particle-sampler.js 自動置中縮放
      // rotationX: 0,   // 不填預設 0
      // rotationY: 0,   // 不填——朝向沒特別校過
      // rotationZ: 0,   // 不填預設 0
      sequenceAction: { name: 'Channel_Wndup' },
      sequenceVoice: '亞托克斯.mp3',

      // — 動畫定格/循環（單幀定格，animatedIdle 沒開）—
      // animation: undefined,   // 不填 = 定格在 bind/rest pose
      // animationTime: 0,       // 沒填 animation，這欄位用不到
      // animatedIdle: false,    // 不填預設 false
      // animationFrames: 24,    // 只有 animatedIdle:true 才有意義，這裡沒用到

      // — 定時觸發動作 —
      // periodicAnimation: 不適用——這顆平常定格 bind pose，只靠 sequenceAction
      // 在「模型序列播放」播到這一站時額外播放 Attack1
    },

    color: [1.0, 0.5, 0.0], // 原站點的橘黃色
    idleMotion: { type: 'bob', axis: 'z', amplitude: 0.15, speed: 1.2 }, // 前後短距離來回（往鏡頭靠近/遠離，不是上下）——這是整團粒子的位移，跟 sequenceAction 的 Attack1 是疊加的兩件事
  },

  // ----------------------------------------------------------------------
  // 2
  // ----------------------------------------------------------------------
  virgoModel: {
    file: '殺五社異音_維爾戈.glb',
    particle: {
      // — 縮放/位置/旋轉 —
      scale: [1.1, 1.1, 1.1],
      position: [0, -1.43, 0],
      // rotationX: 0,   // 不填預設 0
      rotationY: Math.PI,
      // rotationZ: 0,   // 不填預設 0
      sequenceAction: { name: 'Spell1_Torun_-180' },
      sequenceVoice: '維爾戈.mp3',

      // — 動畫定格/循環（animatedIdle 開著）—
      // 完整動畫清單（陣列）——animatedIdle:true 開著，全部 84 段都會依序接成一條
      // 連續播放的序列、播完自動跳回第一個，一直循環（見 sources.js 開頭大註解）：
      animation: [
        'Attack1', // 1
        'Attack2', // 2
        'Attack1_Towalk', // 40
        'Viego_Spell1_towalk.anm', // 52
        'Run_Homeguard', // 76
        'Viego_IdleIn_INTO_Homeguard.anm', // 77
        'Spell1_ToIdle', // 78
        'Stunned', // 79
      ],
      animationTime: 1, // 只有 animatedIdle:false 的單幀定格路徑才會讀到這個值；animatedIdle:true 時這欄位其實沒用到，留著沒有壞處
      animatedIdle: true,
      animationFrames: 60,

      // — 定時觸發動作 —
      // periodicAnimation: 不適用——已經用 animatedIdle 做「一直循環播放」，兩者是互斥
      // 機制（共用同一組 shader uniform），一個模型只能挑一種，見 sources.js 開頭說明
    },

    color: [1.0, 0.1, 0.0], // 暗紅色
    idleMotion: { type: 'swing', amplitude: Math.PI / 10, speed: 0.8 }, // 水平短距離轉動，像左右擺尾
    // ↑ axis 不填預設 'y'
  },

  // ----------------------------------------------------------------------
  // 3
  // ----------------------------------------------------------------------
  yasuoModel: {
    // 跟 aatroxModel/kaidoDragonModel 同一套「定時動作」邏輯：平常維持 bind/rest
    // pose 定格（沒帶 animation，跟原本一樣），閒置滿 60 秒觸發播一次 Spell4（風牆，
    // 犽宿的 E 技能），約 1.97 秒，播完自動退回定格姿勢。這顆時間短，用預設的 24
    // 張關鍵幀就夠平滑。scale/position 都是明確填的值，不會有 auto-fit 兩邊算出不同
    // 包圍盒、觸發時忽然跳一下的疑慮（那個疑慮只有沒填 scale/position、靠自動置中
    // 縮放的模型才需要擔心）。
    file: '闇夜使者_犽宿.glb',
    particle: {
      // — 縮放/位置/旋轉 —
      scale: [1.4, 1.4, 1.4],
      position: [0.85, -1.54, 1.24],
      // rotationX: 0,   // 不填預設 0
      rotationY: Math.PI,
      // rotationZ: 0,   // 不填預設 0
      sequenceAction: { name: 'Joke' },
      sequenceVoice: '犽宿.mp3',
       
      // — 動畫定格/循環（這顆用 periodicAnimation，這裡不開）—
      // animation: undefined,   // 不填 = 定格在 bind/rest pose（跟 aatroxModel 同款用法）
      // animationTime: 0,        // 沒填 animation，這欄位用不到
      // animatedIdle: false,     // 不填預設 false；這顆用 periodicAnimation，不跟 animatedIdle 同時開
      // animationFrames: 24,     // 只有 animatedIdle:true 才有意義，這裡沒用到

      // — 定時觸發動作 —
      periodicAnimation: {
        name: [
          'Spell4', // 1
          // 'TODO_動畫名稱', // 2 — 想接第二段動作：取消這行註解、把 TODO_動畫名稱
          // 換成真的動畫標籤，會接在 Spell4 播完之後再播，兩段都播完才退回定格姿勢。
        ],
        intervalSeconds: 10,
        // frameCount: 不填就自動算——Spell4 約 1.97 秒，套公式會落在最低保底的 8 張，
        //             時間短、動作簡單，夠平滑，不用覆寫
      },
    },

    color: [0.1, 0.85, 0.9], // 風系青色
    // idleMotion: 不填 = 預設 spin（繞 Y 軸連續 360 度自轉），這顆沒特別想換閒置動畫風格
  },

  // ----------------------------------------------------------------------
  // 4
  // ----------------------------------------------------------------------
  mordekaiserModel: {
    // file 是死灰墓騎・魔鬥凱薩（Mordekaiser 的骷髏騎士皮膚 Skin42）。用
    // npm run inspect-model 量過：3 個 SkinnedMesh、12486 個三角形、69 段動畫；
    // 動畫清單裡有一個節點名稱 Mordekaiser_Skin42_HeadBuffBone.anm，印證這正是
    // Skin42。Idle_In（1.13 秒）當平常定格姿勢，Skin42_Recall.anm（8.67 秒）是
    // 這顆皮膚專屬的回城動畫。
    file: '死灰墓騎_魔鬥凱薩.glb',
    particle: {
      // — 縮放/位置/旋轉 —
      // scale / position 故意都不填，交給 particle-sampler.js 自動置中縮放
      // rotationX: 0,   // 不填預設 0
      // rotationY: 0,   // 不填——朝向沒特別校過，開特效看一次再微調
      // rotationZ: 0,   // 不填預設 0
      sequenceVoice: '魔鬥凱薩.mp3',

      // — 動畫定格/循環（單幀定格，animatedIdle 沒開）—
      animation: 'Idle_In',
      animationTime: 0,

      // — 定時觸發動作 —
      // 跟 aatroxModel 同一套邏輯：平常維持 Idle_In 定格，閒置滿 intervalSeconds
      // 秒觸發播一次 Skin42_Recall.anm（回城動畫），播完自動退回 Idle_In 定格姿勢。
      periodicAnimation: {
        name: ['Skin42_Recall.anm'],
        intervalSeconds: 45,
        // frameCount: 不填就依 Skin42_Recall.anm 的總秒數（8.67s）自動算，套公式
        //             約 26 張，夠平滑，沒特別覆寫
      },
    },

    color: [0.3, 0.9, 0.35], // 病態鐵灰綠
    idleMotion: { type: 'swing', amplitude: Math.PI / 14, speed: 0.5 },
    // ↑ axis 不填預設 'y'
  },

  // ----------------------------------------------------------------------
  // 5
  // ----------------------------------------------------------------------
  urshanModel: {
    file: '遠古霸者_厄薩斯.glb',
    particle: {
      // — 縮放/位置/旋轉 —
      // scale / position 故意都不填，交給 particle-sampler.js 自動置中縮放（見上面說明）
      // rotationX: 0,   // 不填預設 0
      // rotationY: 0,   // 不填——朝向未知，開特效看一次實際效果，覺得角度不對再加這行微調
      // rotationZ: 0,   // 不填預設 0
      // sequenceVoice: '',   // 不填 = 這一站沒有語音

      // — 動畫定格/循環（animatedIdle 開著）—
      animation: [
        'Idle1', // 1
        'Attack2', // 2
        'Attack3', // 3
        'Crit', // 4
      ],
      animationTime: 0,     // animatedIdle:true 時這欄位不會被讀到，留著沒差
      animatedIdle: true,   // 開著：上面 4 段動畫（如果都存在）會接成一條序列一直循環播放
      animationFrames: 60,  // animatedIdle:true 時有效——整條序列的關鍵幀總預算

      // — 定時觸發動作 —
      // periodicAnimation: 不適用——已經用 animatedIdle，兩者互斥（見 sources.js 開頭說明）
    },

    color: [0.8, 0.2, 0.9], // 暫定的紫色，可自行改
    // idleMotion: 不填 = 預設 spin（繞 Y 軸連續 360 度自轉）
  },

  // ----------------------------------------------------------------------
  // 6
  // ----------------------------------------------------------------------
  kaidoDragonModel: {
    // asset.extras.title: "Kaido (Dragon form)"（One Piece 凱多·龍形態），
    // Sketchfab 作者 Cyrone。有骨架、25 段動畫（idle_a/down/stun/skill_d/
    // skill_e/metamorphosis_*...），用 idle_a 定格取樣站姿。
    // 這顆是「換臉/換手」那種手遊角色 rig 常見結構的簡化版（body/coat/face/hair/
    // 左右火焰特效各自一個 mesh），沒有明顯的替代部位重複網格，取樣出來的形狀
    // 應該乾淨；如果之後遇到臉/手部位有疊影，通常就是同一顆骨架底下混了多個
    // 「同一部位不同狀態」的 mesh 節點（下面 kaidoModel 那顆就有這狀況，見那邊
    // 的註解），traverse() 沒有分辨哪個是「目前該顯示的」，全部都會被取樣進去。
    //
    // 跟 aatroxModel 同一套「定時動作」邏輯：閒置滿 60 秒觸發播一次動畫清單裡第
    // 10 個——pl_kaido_orig02_bs01_skill_e_1，播完自動退回上面 idle_a 定格姿勢。
    // 這段動畫長達 25 秒（比 aatrox 的 Recall 8.67 秒長很多），關鍵幀數用預設 24
    // 張的話等於一張貼圖要撐超過 1 秒，動作會比較跳，所以拉高到 48 張讓內插更
    // 平滑（載入時間/GPU 記憶體也會跟著變兩倍，但只有這顆 model swap 的時候才會
    // 感覺到，不影響其他模型）。實測過 default（idle_a）跟 periodic（skill_e_1）
    // 兩邊算出來的自動置中縮放包圍盒剛好一樣，觸發時不會有大小跳動的問題。
    file: 'kaido_dragon_form.glb',
    particle: {
      // — 縮放/位置/旋轉 —
      // scale / position 故意都不填，交給 particle-sampler.js 自動置中縮放——上面已經
      // 實測過 default（idle_a）跟 periodic（skill_e_1）兩邊算出來的包圍盒剛好一樣，
      // 觸發時不會有大小跳動，所以沒必要手動填死
      // rotationX: 0,   // 不填預設 0
      // rotationY: 0,   // 不填——朝向沒特別校過，看效果需要再加
      // rotationZ: 0,   // 不填預設 0
      // sequenceVoice: '',   // 不填 = 這一站沒有語音

      // — 動畫定格/循環（目前單幀定格，animatedIdle 沒開）—
      // 這裡是單幀定格用（沒開 animatedIdle），陣列只有第一個字串會生效，後面的
      // 元素會被忽略——先留著佔位符方便之後想升級成「動畫粒子化」（一直循環播放，
      // 這顆有 idle_a/idle_a_1/idle_a_2/idle_a_3 四個變體可以接成一個循環，實測過
      // 可以用）時直接補：取消註解、把佔位符換成真的動畫標籤、再加一行
      // animatedIdle: true,     。
      animation: [
        'pl_kaido_orig02_bs01_idle_a', // 1
        'pl_kaido_orig02_bs01_metamorphosis_b', // 6 — 沒開 animatedIdle 之前這行不會生效，純佔位
        // 'pl_kaido_orig02_bs01_idle_a_2', // 14
        // 'pl_kaido_orig02_bs01_idle_a_3', // 21
      ],
      animationTime: 1,
      // animatedIdle: true,       // 想升級成「動畫粒子化」時取消這行註解（見上面說明）
      // animationFrames: 24,      // 只有開了 animatedIdle 才有意義，不填預設 24

      // — 定時觸發動作 —
      periodicAnimation: {
        name: [
          'pl_kaido_orig02_bs01_skill_e_1', // 10
          // 'TODO_動畫名稱', // 2 — 想接第二段動作：取消這行註解、把 TODO_動畫名稱
          // 換成真的動畫標籤，會接在 skill_e_1 播完之後再播，兩段都播完才退回上面
          // idle_a 定格姿勢。
        ],
        intervalSeconds: 50,
        frameCount: 48, // 覆寫預設 24——skill_e_1 長達 25 秒，24 張會太跳，拉高到 48 張讓內插平滑
      },
    },

    color: [0.85, 0.1, 0.05], // 龍形態的烈焰紅黑
    idleMotion: { type: 'swing', amplitude: Math.PI / 12, speed: 0.4 }, // 擺角比較大、速度慢，走巨龍緩慢搖晃的沉重感
    // ↑ axis 不填預設 'y'
  },

  // ----------------------------------------------------------------------
  // 7
  // ----------------------------------------------------------------------
  goingMerryModel: {
    // asset.extras.title: "Going Merry (One Piece)"，Sketchfab 作者 RadhruinT。
    // 17 個 mesh、沒有骨架也沒有動畫（掃描/建模出來的靜態船體模型，甲板/船帆/
    // 羊頭裝飾等各自獨立成 mesh），讓 particle-sampler.js 自動置中縮放，不手動假設。
    file: 'going_merry_one_piece.glb',
    particle: {
      // — 縮放/位置/旋轉 —
      // scale / position 故意都不填，交給 particle-sampler.js 自動置中縮放（見上面說明）
      // rotationX: 0,   // 不填預設 0
      // rotationY: 0,   // 不填——沒特別校過朝向
      // rotationZ: 0,   // 不填預設 0
      // sequenceVoice: '',   // 不填 = 這一站沒有語音

      // — 動畫定格/循環／定時觸發動作 —
      // animation / animationTime / animatedIdle / animationFrames / periodicAnimation：
      // 全部不適用——這顆單一船體模型、沒有骨架也沒有動畫（見上面說明）
    },

    color: [1.0, 0.92, 0.6], // 金白色（沿用舊值，換成船體後可能想改成木頭色調）
    idleMotion: { type: 'bob', amplitude: 0.12, speed: 1.0 }, // 船身輕輕上下浮動，像漂在海面上
    // ↑ axis 不填預設 'y'
  },

  // ----------------------------------------------------------------------
  // 8
  // ----------------------------------------------------------------------
  kaidoModel: {
    // asset.extras.title: "one piece bounty rush kaido"（手遊 One Piece
    // Bounty Rush 的凱多，人形/持棍狀態），Sketchfab 作者 primalfrom12。有骨架、
    // 30 段動畫（idle_a/skill_a/victory/run/combo_*...），用 idle_a 定格。
    // 這顆是典型手遊角色 rig：face_normal/face_attack/face_damage 三張臉、
    // l_hand_open/l_hand_close/l_hand_par（右手同理）三種手勢都是各自獨立的
    // mesh 節點，遊戲裡是靠程式邏輯切換顯示哪一個，但靜態 GLB 沒有把「目前該藏起來
    // 的」那幾個 mesh 標記掉，particle-sampler.js 的 collectMeshes() 用 traverse()
    // 掃全部 Mesh、不看 visible，所以這幾組替代部位全部都會一起被取樣進去，臉部/
    // 手部附近的粒子可能會比其他部位厚一點（多張臉、多隻手疊在同一個位置）。
    // 不是校正錯誤，是這顆 GLB 本身的結構限制，先接受這個小瑕疵，真的介意的話
    // 之後可以幫 particle-sampler.js 加一個依 mesh 名稱排除清單的欄位。
    file: '4.glb',
    particle: {
      // — 縮放/位置/旋轉 —
      scale: [0.3, 0.3, 0.3],
      position: [1.50, -1.250, 0.000],
      // rotationX: 0,   // 不填預設 0
      rotationY: -1.4,   // 朝向沒特別校過，肉眼看效果調出來的值
      // rotationZ: 0,   // 不填預設 0
      // sequenceVoice: '',   // 不填 = 這一站沒有語音

      // — 動畫定格/循環（animatedIdle 開著）—
      animation: [
        'pl_kaido_orig01_boost', // 5
        'pl_kaido_orig01_victory', // 17
        'pl_kaido_orig01_lose', // 18
      ],
      animationTime: 1,       // animatedIdle:true 時這欄位不會被讀到，留著沒差
      animatedIdle: true,     // 開著：上面 3 段動畫會接成一條序列一直循環播放
      animationFrames: 60,    // animatedIdle:true 時有效——整條序列的關鍵幀總預算

      // — 定時觸發動作 —
      periodicAnimation: {
        name: [
          'pl_kaido_orig01_combo_a', // 26
          'pl_kaido_orig01_combo_b', // 27
          'pl_kaido_orig01_combo_c', // 28
          // 'TODO_動畫名稱', // 想接第四段動作：取消這行註解、把 TODO_動畫名稱
          // 換成真的動畫標籤，會接在 combo_c 播完之後再播，全部播完才退回定格姿勢。
        ],
        intervalSeconds: 15,
        // frameCount: 不填就依 combo_a/b/c 的總秒數自動算，時長沒特別量過，先用自動值
      },
    },

    color: [0.75, 0.55, 0.15], // 老者武將的琥珀棕
    idleMotion: { type: 'swing', amplitude: Math.PI / 16, speed: 0.6 },
    // ↑ axis 不填預設 'y'
  },

  // ----------------------------------------------------------------------
  // 9
  // ----------------------------------------------------------------------
  superheroSculptModel: {
    // asset.extras.title: "SculptJanuary Day 28 : Superhero"，Sketchfab 作者
    // aunpyz。沒有骨架也沒有動畫，84 個 mesh、material 全部叫 "None"——典型
    // ZBrush 多 subtool 雕塑匯出（每個身體部位/配件各自一個 mesh，靠幾何形狀
    // 分開而不是靠材質分開），取樣起來是一整尊完整人形，不會有 kaidoModel 那種
    // 部位重複問題。檔案 142MB，是這幾顆裡最大的，GLTFLoader 讀取／
    // MeshSurfaceSampler build() 這兩步會比其他模型明顯慢一點，屬預期行為。
    //
    // 這顆刻意示範「能省的全部省掉」長怎樣，跟上面其他顆的寫法互相對照：particle/
    // idleMotion 兩個 key 整個拿掉不寫（color 補回來了，見下面），因為 resolveModel()
    // （particle-effect.js:169-190）在這些 key 缺席時全部有安全預設，被省略掉的是：
    //   particle:   缺省 = {}（source.particle || {}）——等同 scale/position 用
    //               auto-fit 自動置中縮放、rotationX/Y/Z 全部 0、沒有 animation
    //               （反正這顆也沒骨架/動畫可用）、animatedIdle 關閉、沒有
    //               periodicAnimation 定時動作。
    //   idleMotion: 缺省 = normalizeIdleMotion(undefined) 算出來的
    //               { type:'spin', axis:'y', speed: IDLE_ROTATE_SPEED(0.15) }
    //               （particle-effect.js:148-164），也就是最原始的「繞 Y 軸連續
    //               360 度自轉」，不是原本這顆的 bob 上下浮動。
    // 換句話說，跟省略之前比，這顆現在會自轉而不是浮動——這是刻意示範省略的必然
    // 結果，不是漏改；想拿回原本的 bob 浮動效果，把 idleMotion（連同一個空的
    // particle: {}）加回來即可。
    file: '5.glb',
    color: [0.25, 0.45, 0.95], // 英雄主題的正義藍——省略示範只留這顆，color 補回原值
  },

  // ----------------------------------------------------------------------
  // 10
  // ----------------------------------------------------------------------
  bearModel: {
    // 檔名「尊爵不凡_雙相古龍_弗力貝爾」是這顆 LoL 角色模型 Volibear（弗力貝爾）
    // 尊爵版皮膚的中文標題。用 npm run inspect-model 量過確認無誤：4 個 SkinnedMesh
    // （內容重複，等同 1 份幾何體疊 4 份，跟 kaidoModel 的重複部位問題同類但不影響
    // 輪廓）、11323 個三角形、90 段動畫，動畫名稱大量帶 Volibear_ 前綴可互相印證。
    //
    // ⚠️ 這顆模型的 vertex position buffer 裡混了一批不屬於任何三角形（或只屬於
    // 面積趨近 0 的退化三角形）的「幽靈頂點」——疑似綁在某條沒有實際網格覆蓋的
    // 尾部/物理輔助骨骼上、匯出時沒清乾淨。這批幽靈頂點在 Idle_Base 姿勢下把
    // z 座標一路拉到 -3.26（真正有面積、看得到的網格其實只到 z≈-1.0），如果讓
    // particle-sampler.js 用預設的自動置中縮放（算 bounds 是掃全部頂點座標，不分
    // 有沒有三角形面積），會把這批幽靈頂點也算進包圍盒，導致縮放基準的「最長邊」
    // 被灌水到 3.84，實際看得到的模型反而縮小到只有目標尺寸的 6-7 成、比其他顆
    // 模型明顯小一圈——這正是「粒子沒有確實呈現模型輪廓」的成因，跟 mordekaiserModel
    // 當年遇到的「auto-fit 包圍盒對不上看得見的網格」是同一類問題，处理方式一樣：
    // 手動量測「只算有實際面積的三角形」的真實包圍盒，改成手動填 scale/position。
    //
    // 量測方法：把每個三角形的世界座標面積算出來，過濾掉面積 < 1e-5 的退化三角形
    // 後再取包圍盒（9111 個三角形裡只有 22 個是退化的，其餘 9089 個才是量測依據），
    // 量出來的真實包圍盒（Idle_Base 姿勢）：
    //   min [-0.903, -0.002, -1.003]　max [0.953, 2.450, 0.587]
    //   size [1.855, 2.452, 1.590]　center [0.025, 1.224, -0.208]
    // 最長邊是 Y（2.452），縮放成 3 個單位：scale = 3 / 2.452 ≈ 1.2237。
    // rotationY 抄跟 aatroxModel/virgoModel/yasuoModel 同一顆匯出管線常見的
    // Math.PI（預設朝向背對鏡頭，轉半圈才會正面朝鏡頭）——因為套了旋轉，position
    // 要用「先縮放、再繞 Y 轉 180 度」之後的中心點回推：中心 [0.025,1.224,-0.208]
    // 縮放後 [0.031,1.498,-0.255]，繞 Y 轉 180 度變成 [-0.031,1.498,0.255]，取負
    // 平移回原點 = [0.031,-1.498,-0.255]。
    file: '尊爵不凡_雙相古龍_弗力貝爾.glb',
    particle: {
      // — 縮放/位置/旋轉 —
      // scale: [1.2237, 1.2237, 1.2237],
      // position: [0.031, -1.498, -0.255],
      // rotationX: 0,   // 不填預設 0
      rotationY: -0.1,   // 跟 aatroxModel/virgoModel/yasuoModel 同一套匯出管線的預設朝向校正
      // rotationZ: 0,   // 不填預設 0
      // sequenceVoice: '',   // 不填 = 這一站沒有語音

      // — 動畫定格/循環（單幀定格，animatedIdle 沒開）—
      animation: 'Idle_Base', // 90 段動畫裡明確存在、時長 3 秒的站定姿勢，適合當平常定格
      animationTime: 0,

      // — 定時觸發動作 —
      // 跟 aatroxModel 同一套邏輯：平常維持 Idle_Base 定格，閒置滿 intervalSeconds
      // 秒觸發播一次 Recall（回城動畫，8.67 秒），播完自動退回 Idle_Base 定格姿勢。
      periodicAnimation: {
        name: ['Recall'],
        intervalSeconds: 45,
        // frameCount: 不填就依 Recall 的總秒數（8.67s）自動算，套公式約 26 張，
        //             夠平滑，沒特別覆寫
      },
    },

    color: [0.08, 0.16, 0.55], // 深藍色
    idleMotion: { type: 'swing', amplitude: Math.PI / 12, speed: 0.5 }, // 走巨龍緩慢搖晃的沉重感，跟 kaidoDragonModel 同款風格
    // ↑ axis 不填預設 'y'
  },
};

// 「模型序列播放」用的順序清單——跟上面 export default 的單一模型設定是不同層級的
// 東西：上面是「每個模型自己的取樣校正」，這裡是「一鍵觸發後依序在哪些模型之間
// 連續變形、順序為何」的跨模型清單，見 particle-effect.js 的 loadSequenceStages()／
// advanceSequencePlayback()。每一站固定用該模型的靜態預設形狀（不管那個模型自己
// 有沒有設定 animatedIdle/periodicAnimation，序列本身就是動畫了，不疊加）——除非
// 那個模型另外填了 sequenceAction（見上面「每個項目」那段的說明），這種情況下
// 「停留段」會播放那段動作，不是單純定格。
//
// 空陣列＝退回 Object.keys(sources) 的順序，等於目前定義的全部模型都播一輪，
// 不用每加一個新模型就手動維護第二份清單。目前是空的，也就是全部 10 顆都會
// 播到——之前這裡曾經明確排除過兩顆（依 npm run inspect-model 量過的三角形數：
// superheroSculptModel(file: 5.glb) 約 180 萬個、當時的 mordekaiserModel(file:
// 1.glb) 約 33 萬個，都遠高於其餘幾顆的 8000~23000 量級，MeshSurfaceSampler.
// build() 的成本直接跟三角形數成正比、且不能中途讓出主執行緒，會在畫面上造成
// 明顯頓挫），但 mordekaiserModel 後來改回真正對應的 死灰墓騎_魔鬥凱薩.glb
// （只有 12486 個三角形，跟其餘幾顆同一量級，不再是離群值），1.glb 目前沒有
// 任何 entry 在用。superheroSculptModel（5.glb，仍是 180 萬個三角形）如果放進
// 序列播放，大機率還是會卡——真的要重新排除，先用 npm run inspect-model 重新
// 量一輪目前清單裡每一顆的三角形數再決定，不要光憑印象猜。
export const sequenceModels = [

];

// 每一站的節奏，拆成兩段（見 particle-effect.js 的 advanceSequencePlayback()）：
//   sequenceHoldSeconds：完全變成某個模型之後，定格停留幾秒（這段 uAnimBlend
//     恆為 0，完全靜止顯示那個模型，不是還在慢慢變形）才開始下一次轉換。
//   sequenceTransitionSeconds：跟下一個模型交叉淡化（uAnimBlend 從 0 線性跑到 1）
//     要花幾秒，數字越小切換越快。
// 每一站總長度＝兩者相加，整個序列繞一圈的秒數＝這個總長度 × 模型站數。兩個都是
// 全域單一數字（不支援每個模型分開設定），改這裡對序列裡全部模型一視同仁。
// sequenceTransitionSeconds 允許填 0（等同硬切，不會漸變，但為了避免除以 0，
// particle-effect.js 內部會夾在一個很小的正數之上）；sequenceHoldSeconds 填 0
// 就是完全沒有停留、一直在轉換，等於這個功能最早的版本。
export const sequenceHoldSeconds = 3;
export const sequenceTransitionSeconds = 1.5;

// 「模型序列播放」整段期間唯一的一首背景音樂——跟每個模型自己的 sequenceVoice
// （見檔案開頭欄位說明）不是同一件事：sequenceVoice 是「這一站顯示時播一次的短
// 語音」，這個是「整個序列播放 session 期間持續播放、跨模型不中斷」的背景音樂，
// 不會因為換到下一個模型就跟著換曲或重播。intervalSeconds/particle 那些跟單一
// 模型綁定的欄位放在上面 export default 裡，這個是全域設定，所以獨立成自己的
// export，位置比照 sequenceHoldSeconds/sequenceTransitionSeconds。
//
// 填法：particle-effect/audio/bgm/ 底下的實際檔名（跟 sequenceVoice 同一種「只填
// 檔名、資料夾固定」寫法）。不是使用者一觸發「模型序列播放」就播——loading 佔位
// 圖案掃描顯現期間還沒看到真的模型，這時候先出背景音樂會讓聽覺跟視覺對不起來，
// 改成從 loading 結束、真的開始播放第一個模型那一刻起播，自動 loop，直到使用者
// 關掉「模型序列播放」才停止；不填或填空字串都跳過，序列播放期間完全靜音（不會
// 播放任何背景音樂）。詳見 particle-effect.js 的 advanceSequencePlayback()。
export const sequenceBgm = 'season.mp3';
