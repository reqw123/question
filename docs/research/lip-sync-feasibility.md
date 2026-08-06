# Lip-sync feasibility research — desktop-pet

Status: research only, no code changed. Scope: answer whether/how to add mouth movement synced
to the existing OpenAI TTS playback in `desktop-pet` (see `docs/specs/0001-desktop-pet-tts-playback.md`,
which explicitly scoped lip sync **out**: *"嘴型同步（lip sync）——已明確排除（前次 grilling
session 決策），角色講話時維持原本待機動畫。"* — `docs/specs/0001-desktop-pet-tts-playback.md:75`).

`single/` was not consulted, per this repo's `CLAUDE.md`.

---

## 1. Summary / TL;DR

`desktop-pet` renders Live2D characters through **`pixi-live2d-display` v0.4.0** (the original
`guansss/pixi-live2d-display`, bundled as `lib/all.min.js`), running on **PixiJS 6.5.10**
(`lib/pixi.min.js`) and Cubism Core (`lib/live2d.min.js` = Cubism 2, `lib/live2dcubismcore.min.js`
= Cubism 4). This exact version has **no built-in, usable lip-sync feature**: the underlying
Cubism Motion framework carries dead scaffolding for blending a "lip sync value" onto declared
`LipSync` parameters, but v0.4.0 exposes no API to ever set that value, no `AnalyserNode` usage,
no `model.speak()` helper, and no `mouthSync`/`lipSyncIds` config. Those things exist only in a
**separate, unmerged community fork** (`pixi-live2d-display-lipsyncpatch` / `RaSan147/pixi-live2d-display`,
currently `v0.5.0-ls-8`), which was never merged upstream (PR #117, still open).

Of the two models `desktop-pet` actually loads by default (角色一 = `076`/`c_7001.model3.json`,
角色二 = `077`/`c_7002.model3.json`), **neither model3.json declares a `LipSync` parameter group**
(`"Groups": []` in both) — a real per-model gap, separate from the library gap.

**Top recommendation:** hand-roll a small `AnalyserNode`-driven volume loop inside `desktop-pet`'s
own `index.html`, hooked into `PIXI.Ticker.shared` (the same ticker pixi-live2d-display's
`Live2DModel.autoUpdate` and `lib/live2d.js`'s own `_attachVisibilitySync` already use), pushing
values via `model.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', v)` — a public
method `lib/live2d.js` itself already calls (`_applyParamOverrides`). This requires **zero changes**
to any shared/read-only file. The missing piece is that `076`/`077` need a mouth-open parameter ID
confirmed live (see §4) before this can be wired up with confidence.

---

## 2. What library/version this project actually uses

### 2.1 Load order (confirmed from source, not assumed)

`desktop-pet/index.html:90-94` (paths are relative to `desktop-pet/`, so they resolve to the repo
root `lib/`, **not** a `desktop-pet/lib/` — confirmed no such directory exists):

```html
<script src="../lib/live2d.min.js"></script>
<script src="../lib/live2dcubismcore.min.js"></script>
<script src="../lib/pixi.min.js"></script>
<script src="../lib/all.min.js"></script>
<script src="../lib/live2d.js"></script>
```

`C:\question\lib\` contents (sizes via `Get-ChildItem`): `live2d.js` (98,086 B, the project's own
wrapper), `live2d.min.js` (129,056 B), `live2dcubismcore.min.js` (207,155 B), `pixi.min.js`
(460,333 B), `all.min.js` (126,855 B), plus an unrelated/unused `cubism4.min.js` (119,922 B) and
`shuffle.js`/`style.css` not referenced by `desktop-pet/index.html`'s script tags.

### 2.2 Identifying each file

- **`lib/pixi.min.js` = PixiJS 6.5.10.** Grep hit: `VERSION="6.5.10"` next to `pixi.js` string
  literals and `@pixi/utils`, `@pixi/math`, `@pixi/core`, `@pixi/display` package-name fragments.
- **`lib/live2d.min.js` / `lib/live2dcubismcore.min.js` = Cubism 2 / Cubism 4 core runtimes.**
  Confirmed by how `lib/live2d.js` itself detects them, `_checkDeps()`
  (`C:\question\lib\live2d.js:655-663`):
  ```js
  _checkDeps() {
    const hasC2 = typeof Live2D !== 'undefined';
    const hasC4 = typeof Live2DCubismCore !== 'undefined';
    if (!hasC2 && !hasC4) { console.error('[L2D] 缺少 Cubism Core（live2d.min.js 或 live2dcubismcore.min.js）'); return false; }
    ...
  }
  ```
- **`lib/all.min.js` = `pixi-live2d-display`, version `0.4.0`.** The bundle's own export tail
  (found via string search, single-line minified file) reads:
  ```
  t.Live2DFactory=N,t.Live2DLoader=E,t.Live2DModel=H,t.Live2DPhysics=lt,t.Live2DPose=dt,
  t.Live2DTransform=X,t.ModelSettings=x,t.MotionManager=C,t.MotionPreloadStrategy=P,
  t.MotionPriority=y,t.MotionState=M,t.SoundManager=v,t.VERSION="0.4.0",t.XHRLoader=T,
  t.ZipLoader=J,...
  ```
  This is the exact named-export surface of `guansss/pixi-live2d-display` — confirmed against the
  live GitHub README (`https://github.com/guansss/pixi-live2d-display`, fetched during this
  research; current `master`/npm `package.json` reports `"version": "v0.5.0-beta"`, i.e. this
  project is running an older `0.4.0` build, not current upstream).

### 2.3 What `lib/live2d.js` actually calls (API fingerprint)

- `PIXI.live2d.Live2DModel.from(cfg.model)` — model loading (`lib/live2d.js:698`).
- `model.internalModel.settings.motions` — reading the motion group table (`lib/live2d.js:1005`,
  and again directly in `desktop-pet/index.html:671` for extra pets).
- `model.internalModel.coreModel` — reached directly for parameter/part manipulation, e.g.
  `cm.setParameterValueById(id, value)` (Cubism 3/4) / `cm.setParamFloat(id, value)` (Cubism 2) in
  `_applyParamOverrides` (`lib/live2d.js:852-881`), and `cm.setPartOpacityById` /
  `cm.setPartsOpacity` in `_applyPartOverrides` (`lib/live2d.js:779-808`).
- `model.motion(group, index, priority)` — motion playback, used pervasively (e.g. `lib/live2d.js:508`,
  `:1071`, `:1080`).
- `model.expression(idx)` — expression playback (`lib/live2d.js:1043`).
- `PIXI.Ticker.shared.add(sync, null, PIXI.UPDATE_PRIORITY.LOW + 1)` — a manual per-frame hook
  registered directly on the shared ticker (`lib/live2d.js:755`), i.e. this codebase already has a
  precedent for driving Cubism parameters every frame from application code without touching the
  library itself.
- `model.internalModel.renderer._clippingManager` — a private-API monkeypatch for a Cubism 4
  clipping-mask bug, applied at runtime without modifying `lib/all.min.js` (`lib/live2d.js:939-1000`),
  i.e. this project's own precedent for "patch by wrapping/overriding after load, don't edit the
  vendored file."

None of this touches `speak()`, `AnalyserNode`, `mouthSync`, or `lipSyncIds` — because v0.4.0
doesn't have them (§3).

---

## 3. Built-in lip sync in `pixi-live2d-display` v0.4.0 — **No**

### 3.1 What exists in the bundle (Cubism Core Framework scaffolding — present but inert)

`all.min.js` does contain `lipSyncIds`/`_lipSyncParameterIds` — these belong to the vendored
Cubism Core Framework's `CubismMotion` class (the official Live2D SDK's motion-blending code,
which `pixi-live2d-display` bundles verbatim), not to `pixi-live2d-display` itself:

```
class ee extends Et{constructor(){super(),this._eyeBlinkParameterIds=[],this._lipSyncParameterIds=[], ...
```
```
setEffectIds(t,e){this._eyeBlinkParameterIds=t,this._lipSyncParameterIds=e}
```
```
this._lipSyncParameterIds.length>l&&bt("too many lip sync targets : {0}",...)
```

This machinery lets a `.motion3.json` curve be *blended* with an externally supplied "lip sync
value" on top of whatever parameters are listed in a model's `Groups` entry named `"LipSync"`
(confirmed live-model examples in §4). **However**, a full-text search of `all.min.js` for the
setter that would ever assign that blend value (`lipSyncValue`, `setSoundValue`, an
`IParameterID`-style setter) returned **no matches** — the only method that touches
`_lipSyncParameterIds` besides the constructor is `setEffectIds(eyeBlinkIds, lipSyncIds)`
(`all.min.js`, `Cubism4MotionManager`, called from `getMotionOverrideParameters`-style code at
offset ~67639), which only assigns the **ID list**, never a magnitude. That means the blend
comparison inside `updateParameters` (`o` in
`this._lipSyncParameterIds[t]==f[m].id){g+=o,h|=1<<t}`) is effectively always comparing against
`Number.MAX_VALUE`'s default, i.e. **this code path is dead in v0.4.0** — the scaffolding exists
because it was copied from the official Cubism SDK, but `pixi-live2d-display` v0.4.0 never wires
an audio-driven (or any) value into it.

### 3.2 What's absent (confirmed by direct search, not inference)

Full-text search of `all.min.js` for each of: `AnalyserNode`, `analyze`, `getRMS`,
`createAnalyser`, `mouthOpen`, `ParamMouthOpenY`, `speak(` — **zero matches for all of them.**
The only audio-related class present is a `SoundManager` (`all.min.js`, exported as
`t.SoundManager=v`) that just wraps `new Audio(url)` for motion-attached `.Sound` files
(play/volume/dispose) — no analysis, no lip sync.

There is a `config.motionSync` flag (`n.motionSync=!0` in the bundle's config object,
default `true`) — this is **unrelated to mouth movement**; it only makes `MotionManager` await the
motion-attached sound file's playback promise before starting the motion clip, i.e. "sync motion
timing to sound duration," not "sync mouth shape to sound volume."

### 3.3 Where lip sync actually lives: an unmerged fork

- **Upstream `guansss/pixi-live2d-display`** (fetched live): its README documents `model.motion()`,
  focusing/hit-testing, and enhanced motion-reserving — **no `speak()`, no lip-sync section**. Its
  current `package.json` on `master` reports version `v0.5.0-beta`, still without lipsync.
- **PR #117** ("Live2D with Lipsync (Seperated)", `github.com/guansss/pixi-live2d-display/pull/117`,
  by RaSan147) added exactly this feature, and **was never merged** — it remains open.
- Instead it lives on as a **separate published fork**: **`pixi-live2d-display-lipsyncpatch`**
  (npm, currently `v0.5.0-ls-8`, MIT, repo `github.com/RaSan147/pixi-live2d-display`). Its
  `model.speak()` API (quoted from the fork's own README, fetched live):

  ```js
  model.speak(audio_link, {
    volume,           // 0.0 – 1.0
    expression,       // index | name of expression
    resetExpression,  // default true — reset expression after the line finishes
    crossOrigin,      // e.g. "anonymous", for non-same-origin audio
    onFinish,         // callback when the voice line ends
    onError,          // callback on error
  });
  ```
  Per the PR discussion, the mouth-sync mechanism **internally uses the Web Audio API's
  `AnalyserNode`** to read audio amplitude and drives the mouth via
  `addParameterValueById(idParamMouthForm, mouthForm)` — i.e. functionally the same technique
  recommended independently in §5/§7 below, just already wired into the model class.
- **Distribution:** the fork ships a UMD bundle exporting to the global `PIXI.live2d` namespace
  (confirmed by fetching `https://cdn.jsdelivr.net/npm/pixi-live2d-display-lipsyncpatch/dist/index.min.js`
  — a `!function(t,e){...}(this,...)` UMD wrapper supporting CJS/AMD/global, same shape as this
  project's existing `all.min.js`), installable via `npm install pixi-live2d-display-lipsyncpatch`
  or a plain `<script src="https://cdn.jsdelivr.net/gh/RaSan147/pixi-live2d-display@v0.5.0-ls-8/dist/index.min.js">`
  tag — i.e. it *could* be dropped in as a straight replacement for `lib/all.min.js` with no
  bundler. But swapping the vendored library file is explicitly against this project's "read-only
  shared files" principle (see hard constraints, §7) and would need to be re-verified for
  compatibility with every model/feature already built on top of the current v0.4.0 API surface
  (`_attachVisibilitySync`'s Cubism-2 internals, the clipping-mask patch, etc.) — a non-trivial,
  higher-risk option, not a drop-in in practice even though it's technically UMD-compatible.

---

## 4. This project's actual models' mouth-open parameters

`live2d_my_like/config/manifest.json` — the models `desktop-pet` actually wires up by default are
`char1.manifestId: 1` and `char2.manifestId: 2` (`lib/live2d.js:48,69`), which the manifest maps to:

| id | path | character |
|---|---|---|
| 1 | `models/076/c_7001.model3.json` | 076 (角色一, 納茲) |
| 2 | `models/077/c_7002.model3.json` | 077 (角色二, 露西) |

### 4.1 角色一 — `076` / `c_7001.model3.json`

```json
{
  "Version": 3,
  "FileReferences": { "Moc": "c_7001.moc3", ... },
  "Groups": []
}
```
**No `Groups` entries at all** — no `LipSync`, no `EyeBlink`. A search of every `.motion3.json`
under `live2d_my_like/models/076/` for `Mouth` (case-insensitive) also returned **zero matches**,
meaning none of this model's baked motion curves ever animate a mouth parameter either.

### 4.2 角色二 — `077` / `c_7002.model3.json`

```json
{
  "Version": 3,
  "FileReferences": { "Moc": "c_7002.moc3", ... },
  "Groups": []
}
```
Identical situation: **empty `Groups`**, and no `Mouth`-named target found in its motion files.

### 4.3 A model that *does* declare LipSync — `1009109` (id 4, one of the 3rd/4th-slot models;
`desktop-pet` disables char3/char4 via `L2D_CFG.char3.enabled = false` /
`L2D_CFG.char4.enabled = false` in `desktop-pet/index.html:137-138`, so this model isn't loaded by
default, but it's in the same manifest users can pick from via `name-manager.html`):

```json
"Groups": [
  { "Target": "Parameter", "Name": "EyeBlink", "Ids": ["PARAM_EYE_R_OPEN", "PARAM_EYE_L_OPEN"] },
  { "Target": "Parameter", "Name": "LipSync",  "Ids": ["PARAM_MOUTH_OPEN_Y"] }
]
```
Note the **`SCREAMING_SNAKE_CASE`** parameter ID (`PARAM_MOUTH_OPEN_Y`), matching this project's
own comment about this model family in `lib/live2d.js:90`
(*"這個模型是 SCREAMING_SNAKE_CASE 參數命名"*). `1064100` (manifest id 7) has the identical
`Groups` shape with the same `PARAM_MOUTH_OPEN_Y` id.

### 4.4 A model with the "standard" camelCase id — `home_cat` (id 15, user-selectable, and the
only model with a `chatSounds` entry filled in — i.e. actively customized by this project's user):

```json
"Groups": [
  { "Target": "Parameter", "Name": "LipSync",  "Ids": ["ParamMouthOpenY"] },
  { "Target": "Parameter", "Name": "EyeBlink", "Ids": ["ParamEyeLOpen", "ParamEyeROpen"] }
]
```
Standard Cubism camelCase `ParamMouthOpenY`. `furina` (id 13) is similar but with **two** LipSync
ids: `["ParamMouthForm", "ParamMouthOpenY"]`.

### 4.5 Conclusion — real per-model inconsistency, not uniform

Confirmed findings across the checked models:
- **`076`/`077` (the actual default char1/char2)**: no declared LipSync group, no mouth-targeting
  motion curves found anywhere in their motion files — statically, there's no evidence they even
  *have* an animatable mouth parameter, let alone which ID it would use.
- **`1009109`/`1064100`**: `PARAM_MOUTH_OPEN_Y` (SCREAMING_SNAKE_CASE).
- **`home_cat`**: `ParamMouthOpenY` (camelCase) — the standard Cubism 4 sample-model convention.
- **`furina`**: `ParamMouthOpenY` + `ParamMouthForm` (two ids).

**What can't be determined statically:** whether `076`/`077`'s underlying `.moc3` binary actually
contains a `ParamMouthOpenY`-equivalent parameter that's simply undeclared in `Groups` (very
common — many Cubism model authors never fill in the `Groups` section even when the parameter
exists and is riggable), or whether the parameter genuinely doesn't exist on these models. This
requires checking **live**, in the running app, e.g. from the DevTools console:
```js
L2D._c1.model.internalModel.coreModel.getParameterIds()   // Cubism 3/4 models
```
(`getParameterIds()` is the same class of introspection this project's own code already performs —
see `_getParamIds()` in `lib/live2d.js:886-898`, which for Cubism 3/4 reads
`cm._model.parameters.ids`) — and visually confirming in Live2D Cubism Viewer / the model's
source files whether a mouth-open parameter exists and is rigged to actually deform the mouth mesh
(a parameter can exist in the ID list without any deformer being bound to it).

---

## 5. Real-time audio analysis approach

### 5.1 Current playback code (`desktop-pet/index.html:69-83`)

```js
var _currentTtsAudio = null;
function playTtsAudio(audioBase64) {
  if (_currentTtsAudio) {
    try { _currentTtsAudio.pause(); } catch {}
    _currentTtsAudio = null;
  }
  _creatingTtsAudio = true;
  const a = new Audio('data:audio/mpeg;base64,' + audioBase64);
  _creatingTtsAudio = false;
  _currentTtsAudio = a;
  a.addEventListener('ended', () => { if (_currentTtsAudio === a) _currentTtsAudio = null; });
  a.play().catch((err) => console.error('[desktop-pet] 語音播放失敗：', err));
}
```
Key facts for lip-sync design: **a brand-new `Audio` element is created per utterance**
(`new Audio(dataUrl)`, line 76), not reused; the previous one is only `pause()`d, not destroyed, so
old elements are garbage-collected once dereferenced. This element also passes through a global
`window.Audio` constructor interceptor (`desktop-pet/index.html:50-61`) that tags it `_isTts` and
applies mute state — any lip-sync hookup should happen *after* this wrapping (i.e. inside
`playTtsAudio`, operating on `a`), not by re-patching the constructor again.

### 5.2 Web Audio API wiring (MDN, primary source)

- `AudioContext.createMediaElementSource(audioElement)` creates a `MediaElementAudioSourceNode`
  and, per MDN, **"audio playback from the `HTMLMediaElement` will be re-routed into the
  processing graph of the AudioContext"** — meaning after calling this, the element's sound is
  **no longer audible on its own**; the graph must be explicitly wired
  `source → analyser → audioContext.destination` for the speaker to still hear it. This is a real
  gotcha for `playTtsAudio`: skipping the final `.connect(audioContext.destination)` call would
  silence TTS playback entirely.
- Per the W3C Web Audio spec and confirmed Chromium bug reports (`issues.chromium.org/issues/41140654`,
  chromium bug 429204), **`createMediaElementSource()` can only be called once per
  `HTMLMediaElement`** — a second call throws `InvalidStateError: "HTMLMediaElement already
  connected previously to a different MediaElementSourceNode"`. This is favorable here specifically
  *because* `playTtsAudio` already creates a **fresh** `Audio` element per utterance (§5.1) — so a
  lip-sync implementation that does `createMediaElementSource(a)` once per `new Audio(...)` call
  never hits this restriction. (Had `desktop-pet` reused one long-lived `<audio>` element, this
  would have forced creating the `MediaElementAudioSourceNode` exactly once, up front, outside
  `playTtsAudio`.)
- The typical analysis loop: `analyser.fftSize = 256` (or similar small size),
  `analyser.getByteTimeDomainData(dataArray)` or `getByteFrequencyData(dataArray)` polled once per
  animation frame (via `requestAnimationFrame` or a `PIXI.Ticker` callback, §5.3), reducing the
  byte array to a single 0–1 "openness" value (e.g. average deviation from 128 for time-domain
  data), then feeding that into `setParameterValueById`.

### 5.3 Electron / Chromium-specific notes

- **Autoplay policy:** Electron's `webPreferences.autoplayPolicy` defaults to
  `no-user-gesture-required` per the official docs (`electronjs.org/docs/latest/api/structures/web-preferences`).
  `desktop-pet/main.js`'s main window (`main.js:1024-1037`) does not override this — its
  `webPreferences` only sets `contextIsolation: true` and `preload`. This is consistent with
  `playTtsAudio` already calling `a.play()` unconditionally today without any user-gesture
  workaround, and it means creating an `AudioContext` and calling `.resume()` on it (needed in some
  Chromium autoplay-gated contexts) is very likely a non-issue here — but this specific claim (that
  `AudioContext` starts in `"running"` state rather than `"suspended"` in this Electron build) is
  **not verified statically** and should be confirmed by logging `audioContext.state` in the
  running app.
- **One `AudioContext` for the app**, not one per utterance — `AudioContext` creation has a
  per-page limit and is not meant to be repeatedly instantiated; create it once (lazily, on first
  `playTtsAudio` call) and reuse it, creating a fresh `MediaElementAudioSourceNode` +
  `AnalyserNode` per new `Audio` element (cheap) while reusing the single `AudioContext` (heavier).

### 5.4 How this coexists with the existing PIXI ticker / RAF loop

`lib/live2d.js` already establishes the precedent of driving a Cubism parameter every frame via
`PIXI.Ticker.shared`, not a separate `requestAnimationFrame` loop:

```js
// lib/live2d.js:750-756
// 優先度必須嚴格夾在 NORMAL(0，pixi-live2d-display 用來跑 model.update() 更新 Parameter
// 曲線) 和 LOW(-25，PIXI.Application 自己的 render 用這個) 之間: ...
PIXI.Ticker.shared.add(sync, null, PIXI.UPDATE_PRIORITY.LOW + 1);
```
This comment also documents (from the codebase's own prior reverse-engineering) that
`pixi-live2d-display`'s `Live2DModel.autoUpdate` setter hooks each model's own
`onTickerUpdate` into `PIXI.Ticker.shared` at `UPDATE_PRIORITY.NORMAL` (confirmed independently
in `all.min.js`: `set autoUpdate(t){...Y.shared.add(this.onTickerUpdate,this)...}`, where `Y` is
`window.PIXI.Ticker`). Consequently, a per-frame `setParameterValueById` write for lip sync must
run **after** the model's own curve update (`NORMAL`, priority `0`) but **before**
`PIXI.Application`'s render (`LOW`, priority `-25`) — i.e. registered at a priority between the
two, exactly the slot `_attachVisibilitySync` already claims (`LOW + 1`). A lip-sync `sync()`
callback should use the same `PIXI.Ticker.shared.add(fn, null, PIXI.UPDATE_PRIORITY.LOW + 1)`
pattern (or a dedicated priority just above it) rather than a separate, uncoordinated
`requestAnimationFrame` loop — otherwise the parameter write risks being overwritten by the
model's own curve update on the same frame, the same class of bug `_attachVisibilitySync`'s
comments describe fighting in `live2d_my_like/Cubism2參數與透明度除錯筆記.md`.

---

## 6. Existing solutions survey + build-vs-use recommendation

### 6.1 What's already "for this stack"

- **`pixi-live2d-display-lipsyncpatch`** (§3.3) is the closest fit — same `PIXI.live2d` global,
  UMD, drop-in shape. But it means replacing the vendored `lib/all.min.js`, which this project
  treats as read-only, and re-validating every existing feature built against v0.4.0's exact
  behavior (Cubism-2 `_attachVisibilitySync` internals, the clipping-mask overflow patch, part/param
  override plumbing) against a different fork/version. Higher risk, not a small change.

### 6.2 Standalone/general options surveyed

- **`lip-sync-engine`** (WASM port of Rhubarb Lip Sync, phoneme/viseme-based) — TypeScript-first,
  designed for React/Vue/Svelte component trees, WASM payload; total overkill for "move the mouth
  roughly with volume," and not a plain-`<script>`-friendly shape.
- **`lipsync-engine` (Beer Digital / Amoner)** — zero-dependency, `AudioWorklet`-based viseme
  detection, ships an `SVGMouthRenderer`; built for SVG/DOM mouths, not Cubism parameters — would
  need a custom adapter layer regardless, at which point it adds little over hand-rolling.
  `AudioWorklet` also has stricter Autoplay/secure-context requirements than a basic `AnalyserNode`.
- **`wLipSync`** (MFCC-based, WASM) — much heavier signal processing (phoneme classification) than
  this use case needs; not documented as a plain browser `<script>` include.
- **`TalkingHead` / `HeadTTS`** — 3D full-avatar viseme systems (`met4citizen`), aimed at RPM/3D
  face rigs, not 2D Cubism; wrong shape entirely.

None of the standalone options are meaningfully easier to wire to a single Cubism `ParamMouthOpenY`
float than a hand-rolled `AnalyserNode` loop, and all of them are TS/bundler-oriented or bring in
disproportionate machinery (phoneme detection, `AudioWorklet`, 3D rigging) for a "mouth opens with
volume" effect.

### 6.3 Build-vs-use recommendation

**Build (hand-roll), don't pull in a dependency.** Reasoning:
- The actual requirement — reduce an audio stream to a 0–1 "openness" float, ~30–60 times a second
  — is a genuinely small amount of code (`AnalyserNode` + `getByteTimeDomainData` + one averaging
  reduction + one `setParameterValueById` call), well inside "a few dozen lines, no external
  dependency" territory.
- `desktop-pet` has **no bundler and no TypeScript** (`desktop-pet/package.json` — only
  `electron`/`vitest` devDependencies, `"main": "main.js"`, plain `require`/`<script>` throughout).
  Every surveyed standalone package other than the lipsyncpatch fork is TS-authored and/or
  npm/ESM-oriented without a confirmed plain-`<script>` UMD build; adopting one would mean either
  hand-bundling it (defeating the "no build step" property this project maintains) or vendoring a
  large, pre-built file — a real bundle-size cost for a capability this project could write directly.
- This exact project already has the precedent (`_attachVisibilitySync`, the clipping-mask patch)
  of solving "drive a Cubism parameter every frame, from application code, without editing the
  vendored library" — a hand-rolled `AnalyserNode` loop living in `desktop-pet/index.html` is the
  same shape of solution, just with audio as the input instead of another Cubism parameter.

---

## 7. Recommended implementation approach(es)

### Primary recommendation: hand-rolled `AnalyserNode` + `PIXI.Ticker.shared` volume loop, entirely inside `desktop-pet`

**Architecture:**
- One `AudioContext`, created lazily on first `playTtsAudio()` call, stored at module scope in
  `desktop-pet/index.html` (not in `lib/live2d.js`).
- Inside `playTtsAudio(audioBase64)`, after constructing `a = new Audio(dataUrl)`: call
  `audioContext.createMediaElementSource(a)` once, connect
  `source → analyser → audioContext.destination` (required for audio to remain audible, §5.2), and
  create a fresh small `AnalyserNode` (or reuse one analyser + reconnect the new source into it
  each utterance — simpler to just make a new analyser per utterance given elements are already
  per-utterance).
- Register (once, at `L2D.init()` completion — `Promise.all([L2D.init(), _loadIdleChat()])` already
  in `index.html:185`) a `PIXI.Ticker.shared.add(fn, null, PIXI.UPDATE_PRIORITY.LOW + 1)` callback
  (same priority slot `_attachVisibilitySync` uses) that: if a TTS audio is currently playing,
  reads `analyser.getByteTimeDomainData(...)`, reduces to a 0–1 value, and calls
  `L2D._c1.model.internalModel.coreModel.setParameterValueById(<mouthParamId>, value)` (and same
  for `_c2` if that character is the one speaking) — else writes `0`/closed, or simply stops
  writing so the idle animation regains control. Guard on `state.ready` the same way the rest of
  `index.html`'s helpers already do (e.g. `getCharPositions()`, `L2D._c1?.ready`).
- The per-character mouth parameter ID (`ParamMouthOpenY` vs `PARAM_MOUTH_OPEN_Y` vs none found —
  §4) should be resolved the same way `manifest.json`'s `layout`/`partOverrides`/`paramOverrides`
  already resolve per-model quirks: **add a new per-model manifest field** (e.g.
  `"lipSyncParam": "ParamMouthOpenY"`), read by `desktop-pet`'s own code, not by `lib/live2d.js` —
  keeping the read-only boundary intact while still being data-driven per model.

**Effort estimate:** small — roughly the same order of magnitude as the existing
`_attachVisibilitySync` function (~30 lines) plus the `AudioContext`/`AnalyserNode` setup in
`playTtsAudio` (~15–20 lines), plus resolving §4's open question live for `076`/`077` (or falling
back to "lip sync only works for models with a confirmed mouth parameter, others silently keep
idle animation" — a graceful degradation this project's own patterns favor, e.g. `_getPartIds`
returning `null` and callers treating that as "can't verify, don't block").

**Risks / gotchas:**
- `076`/`077` (the actual default characters) may have **no usable mouth parameter at all**
  (§4.5) — this is the single biggest open risk and blocks a fully working demo on the two
  characters that matter most until checked live.
- Must not skip `analyser.connect(audioContext.destination)` or TTS audio goes silent (§5.2).
- Ticker priority must stay between the model's own `NORMAL` curve update and PIXI's `LOW` render,
  or the write gets clobbered same-frame (§5.4) — same trap this codebase already documented once.
- `motion3.json` curves can drive `PartOpacity` **and** `Parameter` targets each frame
  (`lib/live2d.js:841-849` already documents this exact trap for `paramOverrides`) — if the
  character's idle motion happens to animate the mouth parameter too, the lip-sync write and the
  idle motion write will fight every frame; whichever runs later in the same ticker tick wins.
  Needs live testing per model/motion, not just per model.

**Does this touch any shared/read-only file? No.** Everything above is implemented as new code in
`desktop-pet/index.html` (plus an additive, optional field in `live2d_my_like/config/manifest.json`,
which is already treated as a data file `lib/live2d.js` reads at runtime, not "code"), calling only
already-public methods (`model.internalModel.coreModel.setParameterValueById`,
`PIXI.Ticker.shared.add`) that `lib/live2d.js` itself calls today. No edits to `lib/live2d.js`,
`lib/*.min.js`, or anything under `live2d_my_like/models/`.

### Secondary option (not recommended, documented for completeness): adopt `pixi-live2d-display-lipsyncpatch`

Swap `lib/all.min.js` for the lipsyncpatch fork's UMD build and use its built-in `model.speak()`.
Pros: less code to write, `AnalyserNode` wiring handled internally, `volume`/`expression`/
`onFinish` options out of the box. Cons/risk: **this is a fork/version swap of a file this project
explicitly treats as a vendored, read-only dependency** — even though it's a drop-in UMD
replacement mechanically, it changes the exact `pixi-live2d-display` build every other feature in
`lib/live2d.js` was built and reverse-engineered against (the Cubism-2 `_attachVisibilitySync`
internals reach into private fields like `cm._$5S._$F2`, and the clipping-mask patch reaches into
`model.internalModel.renderer._clippingManager`'s prototype — both fragile to exact-version
internals that could differ between `0.4.0` and `0.5.0-ls-8`). Would require re-validating every
existing model/feature, not just adding lip sync. **This does require touching a shared/read-only
file** (`lib/all.min.js` itself, or at minimum adding a second, parallel `all.min.js`-equivalent
purely for this feature) — the reason it's ranked below the primary recommendation given this
project's stated hard constraint.

---

## 8. Open questions for a follow-up spec/prototype

1. **Do `076`/`077` have a mouth-open parameter at all**, and if so what ID? Requires running the
   app and calling `L2D._c1.model.internalModel.coreModel.getParameterIds()` /
   `L2D._c2.model.internalModel.coreModel.getParameterIds()` in DevTools, then visually testing
   candidate IDs with `setParameterValueById` to confirm they actually deform the mouth mesh (an
   ID existing doesn't guarantee it's rigged to anything visible).
2. **Does any currently-playing idle/wait motion for `076`/`077` drive a mouth-adjacent parameter**
   (e.g. via an expression or a generic "talk" curve). If so, lip sync will need to either happen
   on a parameter target the idle animation doesn't already touch, or explicitly pause/override the
   idle motion's mouth-curve contribution while speaking (same class of fight the codebase already
   solved once for Part transparency).
3. **Does `AudioContext` start `"running"` immediately in this Electron build, or `"suspended"`**
   requiring an explicit `.resume()` on first use? Needs a live `console.log(audioContext.state)`
   check; §5.3's Electron autoplay-policy finding suggests it's likely fine but is not itself proof
   of `AudioContext` state.
4. **Should lip sync degrade gracefully per-model** (only activate if a `lipSyncParam` is
   configured for the active model in `manifest.json`, silently no-op otherwise) — this seems like
   the right default given §4's confirmed per-model inconsistency, but should be an explicit
   decision in the follow-up spec, not an implicit fallback.
5. **Extra pets** (`loadExtraPet` in `desktop-pet/index.html`) never speak today — should the
   `lipSyncParam` manifest field also apply to them for future-proofing, or is lip sync scoped to
   char1/char2 only (the only characters `playTtsAudio`/live chat currently address)?
6. Whether a simple time-domain RMS/amplitude value "reads" as convincing mouth movement, or
   whether some minimal smoothing/attack-decay envelope is needed to avoid jittery, unnatural
   mouth flapping — this is a tuning question best answered with a quick throwaway prototype
   against real TTS audio, not by static analysis.
