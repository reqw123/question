// 精簡自 C:\morph-particles\src\Experience\Shaders\Particles\*.vert/*.frag。
// 原版是「卷動網站」用的 5 模型（A→B→C→D→E）用 uScroll 分段 mix，這裡只需要
// 單一模型的「散開 ⇄ 聚合」，所以砍成兩張貼圖（uTextureScatter / uTextureModel）
// + 一個 uProgress（0=散開、1=聚合）。保留原本最關鍵的手感：用 random(vUv) 讓
// 每個粒子有自己的到位時間點，整批粒子不是同時動、看起來才有「聚合感」而不是
// 死板的線性內插；也保留 additive blending 的發光外觀。
// 沒有 vite-plugin-glsl，這裡直接用 JS 樣板字串代替 .glsl 檔案。

export const simulationVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vUv = uv;
}
`;

export const simulationFragmentShader = /* glsl */ `
uniform sampler2D uTextureScatter; // 散開狀態的粒子位置（GLB 缺檔時的隨機散點，
                                    // 或聚合模型本身放大/加噪點做的「爆開前」散點）
// 聚合狀態的目標位置，拆成 A/B 兩張、用 uAnimBlend 內插，取代原本單一的
// uTextureModel——這是「動畫粒子化」用的（見 particle-effect.js 的
// advanceAnimationPlayback()／particle-sampler.js 的 sampleModelAnimationFrames()）：
// 沒開動畫粒子化的模型，A 跟 B 是同一張貼圖、uAnimBlend 恆為 0，mix(A,B,0) 在數學上
// 就等於原本只有一張 uTextureModel 的行為，不會有任何額外表現差異或效能負擔
// （GPU 端多一次 texture2D 取樣＋一次 mix，這個量級可忽略）。
uniform sampler2D uTextureModelA;
uniform sampler2D uTextureModelB;
uniform float uAnimBlend;          // 0 = 完全用 A，1 = 完全用 B，兩個相鄰關鍵幀之間的內插比例
// uAnimBlendFX：0（預設）＝原本的直線 mix()，animatedIdle／periodicAnimation
// 姿勢內插維持原本手感、不受影響；1＝模型序列播放專用的加強版轉換（見下面
// blendModels()）——每顆粒子有自己的時間偏移＋轉換中途沿位移方向外擴再收回，
// 只有 particle-effect.js 的 advanceSequencePlayback() 會把它設成 1，
// stopSequenceMode() 離開序列播放時會設回 0。
uniform float uAnimBlendFX;
uniform float uProgress;           // 0 = 完全散開，1 = 完全聚合
varying vec2 vUv;

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

float remap(float value, float inputMin, float inputMax, float outputMin, float outputMax) {
  return outputMin + ((outputMax - outputMin) / (inputMax - inputMin)) * (value - inputMin);
}

// 「兩端值歸零、兩端速度也歸零」的對稱 bump 曲線，t=0.5 時峰值剛好是 1——
// 拿來當 burst／尺寸／發光脈衝的強度包絡線。原本用 sin(t*PI) 也是兩端值為 0，
// 但 sin() 在 t=0／t=1 那兩個端點的斜率是最大值（±PI），不是 0：這代表粒子形狀
// 剛要形成的那一刻，外擴的位移其實正以最快速度收回去，視覺上就是「快要組成
// 輪廓的瞬間忽然被拉回去」的突兀感，感覺像爆炸而不是收束。這裡改用
// 16*t²*(1-t)²，兩端不只是「值」等於 0，連「變化速度」也等於 0（可以微分驗證：
// f'(t) = 32*t*(1-t)*(1-2t)，代入 t=0／t=1 都是 0），收尾會自然放緩，不會有
// 忽然被拉回去的頓挫感。
float bumpEnvelope(float t) {
  float u = 1.0 - t;
  return 16.0 * t * t * u * u;
}

// uAnimBlendFX 開著時用的加強版 A→B 內插：每顆粒子（靠 vUv 當亂數種子）自己的
// 起訖時間點稍微錯開，不是整批同步切換；轉換正中間（t=0.5）沿著「這顆粒子的
// 位置到 A/B 中點」的方向往外炸開一段距離，兩端（t=0／t=1）用 bumpEnvelope()
// 自然放緩收束，不會有忽然被拉回去的突兀感，看起來像「炸裂重組」而不是死板的
// 直線平移。uAnimBlendFX 關著（一般動畫姿勢內插）就是原本单純的 mix()，行為
// 完全不變。
vec3 blendModels(vec3 modelA, vec3 modelB, float blend) {
  if (uAnimBlendFX < 0.5) {
    return mix(modelA, modelB, blend);
  }

  float r = random(vUv) * 0.3;
  float t = clamp(remap(blend, r * 0.5, 1.0 - r * 0.5, 0.0, 1.0), 0.0, 1.0);
  t = t * t * (3.0 - 2.0 * t); // smoothstep 型緩動

  vec3 pos = mix(modelA, modelB, t);

  vec3 mid = mix(modelA, modelB, 0.5);
  vec3 burstDir = normalize(pos - mid + vec3(0.0001)); // 加一點點偏移避免 pos==mid 時 normalize(0) 出 NaN
  float burst = bumpEnvelope(t) * 0.35; // 峰值在 t=0.5，兩端值/速度都自然收斂到 0
  pos += burstDir * burst;

  return pos;
}

void main() {
  vec3 scatter = texture2D(uTextureScatter, vUv).xyz;
  vec3 modelA = texture2D(uTextureModelA, vUv).xyz;
  vec3 modelB = texture2D(uTextureModelB, vUv).xyz;
  vec3 model = blendModels(modelA, modelB, uAnimBlend);

  // 每個粒子的起跑延遲：r 越大，這個粒子要等 uProgress 推進越多才開始移動，
  // 但全部保證在 uProgress 到 1 之前抵達終點（remap 的 inputMax 固定是 1.0）。
  float r = random(vUv) * 0.5;
  float t = clamp(remap(uProgress, r, 1.0, 0.0, 1.0), 0.0, 1.0);
  t = t * t * (3.0 - 2.0 * t); // smoothstep 型緩動，比線性內插柔和

  vec3 pos = mix(scatter, model, t);

  gl_FragColor = vec4(pos, 1.0);
}
`;

export const particlesVertexShader = /* glsl */ `
uniform sampler2D uPositions; // FBO 算好的位置貼圖
uniform float uSize;
uniform vec2 uResolution;
// 跟 simulationFragmentShader 的同名 uniform 是同一組數值（particle-effect.js
// 每幀／每次狀態切換都會同步兩邊），這裡拿來在模型序列播放轉換期間做一個
// 短暫的尺寸膨脹脈衝，見下面 main() 的說明。uAnimBlendFX 關著時 sizePulse
// 恆為 1，跟原本行為完全一樣。
uniform float uAnimBlend;
uniform float uAnimBlendFX;
varying vec3 vPos;

// 跟 simulationFragmentShader 裡同名函式一樣的「兩端值/速度都歸零」bump 曲線，
// 見那邊的說明——這裡是獨立編譯的 shader 程式，GLSL 沒有跨檔案共用函式，只能
// 各自複製一份，數學公式要保持一致。
float bumpEnvelope(float t) {
  float u = 1.0 - t;
  return 16.0 * t * t * u * u;
}

void main() {
  vec3 pos = texture2D(uPositions, position.xy).xyz;

  vec4 modelPosition = modelMatrix * vec4(pos, 1.0);
  vec4 viewPosition = viewMatrix * modelPosition;
  vec4 projectionPosition = projectionMatrix * viewPosition;

  gl_Position = projectionPosition;

  // 轉換正中間（uAnimBlend=0.5）粒子尺寸稍微放大再收回，像一次短暫的閃光脈衝，
  // 兩端（0／1）用 bumpEnvelope() 自然放緩收束，不會有忽然被拉回去的頓挫感，
  // 跟 simulationFragmentShader 的 burst 峰值時間點一致。
  float sizePulse = 1.0 + step(0.5, uAnimBlendFX) * bumpEnvelope(uAnimBlend) * 0.6;
  gl_PointSize = uSize * sizePulse * uResolution.y * 0.0013;
  gl_PointSize *= (1.0 / -viewPosition.z);

  vPos = pos;
}
`;

export const particlesFragmentShader = /* glsl */ `
uniform float uProgress;
uniform vec3 uColor;
// 跟上面 particlesVertexShader 同一組，轉換中途額外加一點發光強度，讓交叉淡化
// 那幾幀看起來更像「閃光」而不是單純變暗變亮的線性過程。uAnimBlendFX 關著時
// glowBoost 恆為 0，行為跟原本完全一樣。
uniform float uAnimBlend;
uniform float uAnimBlendFX;
// 「模型序列播放」loading 佔位圖案專用的「左到右掃描顯現」效果——uLoadingActive
// 關著（0，預設值，一般模型／序列真的在播放時都是這個狀態）就完全不影響任何
// 東西，行為跟原本一樣；只有 particle-effect.js 顯示 loading 佔位圖案的那段
// 期間會打開，見下面 main() 的說明跟 particle-effect.js 的
// advanceSequenceLoadingSweep()。
uniform float uLoadingActive;
uniform float uLoadingSweep; // 世界座標 X 門檻，粒子的 vPos.x 小於等於這個值才會顯示
varying vec3 vPos;

// 跟 simulationFragmentShader 裡同名函式一樣的「兩端值/速度都歸零」bump 曲線，
// 見那邊的說明——這裡是獨立編譯的 shader 程式，GLSL 沒有跨檔案共用函式，只能
// 各自複製一份，數學公式要保持一致。
float bumpEnvelope(float t) {
  float u = 1.0 - t;
  return 16.0 * t * t * u * u;
}

// 簡單 hash，只在 loading 佔位圖案顯示期間用來隨機藏起一部分粒子，降低視覺上的
// 粒子密度（65536 顆粒子是 FBO 貼圖解析度的全域架構常數，這裡不是真的減少數量，
// 是「挑一部分不顯示」）。種子用 vPos.xz：loading 階段每顆粒子取樣到的位置在同一
// 次觸發裡是固定的，種子穩定，同一顆粒子每一幀顯示/隱藏的結果不會變、不會閃爍。
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  float distanceToCenter = distance(gl_PointCoord, vec2(0.5));
  float strength = 0.05 / distanceToCenter - 0.1;

  // uProgress 逼近 0（完全散開）時淡出，避免消散動畫結束的瞬間畫面硬切消失；
  // JS 端（particle-effect.js）在 progress 落底後才真的停掉 render loop、藏 canvas。
  float envelope = smoothstep(0.0, 0.08, uProgress);

  // 轉換中途額外加一點發光強度，讓交叉淡化那幾幀看起來更像「閃光」而不是單純
  // 變暗變亮的線性過程；兩端用 bumpEnvelope() 自然放緩收束，不會有忽然被拉回去
  // 的頓挫感。uAnimBlendFX 關著時 glowBoost 恆為 0，行為跟原本完全一樣。
  float glowBoost = 1.0 + step(0.5, uAnimBlendFX) * bumpEnvelope(uAnimBlend) * 0.8;

  // loading 佔位圖案的「左到右掃描顯現」：uLoadingSweep 是目前掃到的世界座標 X
  // 門檻，粒子的 vPos.x 超過這個門檻就還沒被掃到（隱藏，alpha 乘 0）；門檻附近
  // 一小段距離內的粒子額外加亮，模擬掃描線正在經過的效果。uLoadingActive 關著
  // 時 sweepVisible 恆為 1、sweepGlow 恆為 0，跟原本行為完全一樣。
  float sweepVisible = 1.0;
  float sweepGlow = 0.0;
  if (uLoadingActive > 0.5) {
    sweepVisible = step(vPos.x, uLoadingSweep);
    float edgeDist = uLoadingSweep - vPos.x;
    sweepGlow = sweepVisible * smoothstep(0.15, 0.0, edgeDist);
    // 數量不要那麼多：隨機只保留約 4 成粒子顯示。
    sweepVisible *= step(hash(vPos.xz), 0.4);
  }

  gl_FragColor = vec4(uColor * (1.0 + sweepGlow * 1.5), strength * envelope * glowBoost * sweepVisible);
}
`;
