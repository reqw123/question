'use strict';

/* ── VoiceBroadcastModule ──────────────────────────────────────────────────
 * 任意玩家皆可廣播語音，多人同時廣播，WebRTC 一對多（MQTT 僅用於 Signaling）
 *
 * 公開 API：
 *   VoiceBroadcastModule.initHost({ mqttClient, myId, name, getPlayers })
 *   VoiceBroadcastModule.initPlayer({ mqttClient, myId, name, getPlayers })
 *   VoiceBroadcastModule.start()
 *   VoiceBroadcastModule.stop()        ← 靜音 GainNode，保留連線
 *   VoiceBroadcastModule.toggle()
 *   VoiceBroadcastModule.isBroadcasting() → boolean
 *   VoiceBroadcastModule.destroy()
 */
const VoiceBroadcastModule = (() => {

  const SIG_PREFIX = 'quiz/voice/signal/';
  const CTRL_TOPIC = 'quiz/voice/ctrl';
  const ICE_CFG    = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const MIC_GAIN   = 2.0;   // 麥克風放大倍數（1.0 = 原始音量）

  let _role       = null;
  let _getClient  = null;
  let _getMyId    = null;
  let _getName    = null;
  let _getPlayers = null;

  // Outbound
  let _rawStream   = null;   // 直接來自 getUserMedia 的原始 stream
  let _myStream    = null;   // 經 GainNode 放大後的 stream，加入 RTCPeerConnection
  let _audioCtx    = null;   // Web Audio API context
  let _gainNode    = null;   // 音量控制節點；值=0 靜音，值=MIC_GAIN 播出
  let _outPeers    = {};
  let _broadcasting = false;

  // Inbound
  let _inPeers      = {};
  let _inAudios     = {};
  let _speakerNames = {};
  let _activeSpeakers = new Set();

  let _onConnectRef = null;
  let _onMsgRef     = null;

  // ── MQTT ──────────────────────────────────────────────────────────────────

  const _c  = () => _getClient?.();
  const _me = () => _getMyId?.();

  function _pub(targetId, payload) {
    _c()?.publish(SIG_PREFIX + targetId, JSON.stringify(payload), { qos: 0 });
  }

  function _pubCtrl(payload) {
    _c()?.publish(CTRL_TOPIC, JSON.stringify(payload), { qos: 0 });
  }

  function _subscribe() {
    const c = _c();
    if (!c) return;
    const topics = [SIG_PREFIX + _me(), CTRL_TOPIC];
    if (_onConnectRef) c.removeListener('connect', _onConnectRef);
    if (_onMsgRef)     c.removeListener('message', _onMsgRef);
    _onConnectRef = () => c.subscribe(topics, { qos: 0 });
    _onMsgRef     = _onMessage;
    c.on('connect', _onConnectRef);
    c.on('message', _onMsgRef);
    if (c.connected) c.subscribe(topics, { qos: 0 });
  }

  // ── Message routing ───────────────────────────────────────────────────────

  function _onMessage(topic, buf) {
    if (topic !== SIG_PREFIX + _me() && topic !== CTRL_TOPIC) return;
    let data;
    try { data = JSON.parse(buf.toString()); } catch { return; }
    if (topic === CTRL_TOPIC) { _onCtrl(data); return; }
    _onSignal(data);
  }

  function _onCtrl({ type, from, name }) {
    if (type === 'voice-on') {
      if (from && from !== _me()) {
        if (name) _speakerNames[from] = name;
        _activeSpeakers.add(from);
        _updateSpeakersUI();
        // 主動回報給廣播者，讓它建立 outPeer（解決 host 不在 PS.players 的問題）
        _pub(from, { from: _me(), type: 'voice-pull' });
      }
    } else if (type === 'voice-off') {
      if (from) {
        _activeSpeakers.delete(from);
        delete _speakerNames[from];
        _updateSpeakersUI();
      }
    }
  }

  async function _onSignal(msg) {
    try {
      if      (msg.type === 'offer')      await _handleOffer(msg);
      else if (msg.type === 'answer')     await _handleAnswer(msg);
      else if (msg.type === 'ice')        await _handleIce(msg);
      else if (msg.type === 'voice-pull') await _handlePull(msg);
    } catch (e) {
      console.warn('[VoiceBroadcast] signal error:', e);
    }
  }

  async function _handlePull({ from }) {
    // 對方要求接收我的音訊 → 建立 outPeer（若已存在則略過）
    if (!_broadcasting || !_myStream) return;
    if (_outPeers[from]) return;
    await _createOutPeer(from);
  }

  // ── Outbound (broadcasting) ───────────────────────────────────────────────

  async function _initStream() {
    if (_myStream) return true;   // 已初始化過

    if (!navigator.mediaDevices?.getUserMedia) {
      // API 不存在：HTTP 環境被瀏覽器完全封鎖，或極舊版本
      _setVoiceState(location.protocol !== 'https:' ? 'http' : 'denied');
      return false;
    }

    try {
      _rawStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
        video: false,
      });
    } catch (err) {
      const isDenied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
      _setVoiceState('denied');
      if (isDenied) _showPermissionGuide();
      return false;
    }

    // Web Audio 放大鏈：rawStream → GainNode(×MIC_GAIN) → MediaStreamDestination
    try {
      _audioCtx  = new AudioContext();
      await _audioCtx.resume();   // Chrome 有時建立後處於 suspended，需手動 resume
      const src  = _audioCtx.createMediaStreamSource(_rawStream);
      _gainNode  = _audioCtx.createGain();
      _gainNode.gain.value = 0;   // 先靜音，start() 時再開
      const dst  = _audioCtx.createMediaStreamDestination();
      src.connect(_gainNode);
      _gainNode.connect(dst);
      _myStream = dst.stream;
      // Android Chrome 在畫面熄滅/背景時可能自動 suspend；廣播中自動恢復
      _audioCtx.onstatechange = () => {
        if (_audioCtx?.state === 'suspended' && _broadcasting) {
          _audioCtx.resume().catch(() => {});
        }
      };
    } catch {
      // 降級：直接用原始 stream，改用 track.enabled 控制靜音
      _myStream = _rawStream;
      _rawStream.getAudioTracks().forEach(t => { t.enabled = false; });
    }
    return true;
  }

  async function start() {
    if (_broadcasting) return;
    const ok = await _initStream();
    if (!ok) return;

    if (_gainNode) {
      // 確保 AudioContext 處於 running（Android 可能在 initStream 後又被 suspend）
      if (_audioCtx.state !== 'running') {
        try { await _audioCtx.resume(); } catch {}
      }
      _gainNode.gain.value = MIC_GAIN;
    } else {
      // Fallback 路徑：無 GainNode，用 track.enabled 開啟傳輸
      _rawStream?.getAudioTracks().forEach(t => { t.enabled = true; });
    }
    _broadcasting = true;
    _setVoiceState('on');
    _pubCtrl({ type: 'voice-on', from: _me(), name: _getName?.() || _me() });

    const players = _getPlayers?.() ?? [];
    await Promise.allSettled(players.map(pid => _createOutPeer(pid)));
  }

  function stop() {
    if (!_broadcasting) return;
    _broadcasting = false;
    if (_gainNode) {
      // GainNode 靜音 — 連線保持，下次 start() 即時恢復
      _gainNode.gain.value = 0;
    } else {
      // Fallback 路徑：停止傳輸
      _rawStream?.getAudioTracks().forEach(t => { t.enabled = false; });
    }
    _setVoiceState('off');
    _pubCtrl({ type: 'voice-off', from: _me() });
  }

  function toggle() {
    if (_broadcasting) stop(); else start();
  }

  async function _createOutPeer(targetId) {
    if (_outPeers[targetId]) return;
    const pc = new RTCPeerConnection(ICE_CFG);
    _outPeers[targetId] = pc;

    _myStream.getAudioTracks().forEach(t => pc.addTrack(t, _myStream));

    pc.onicecandidate = ({ candidate }) => {
      if (candidate)
        _pub(targetId, { from: _me(), type: 'ice', role: 'sender', candidate: candidate.toJSON() });
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState))
        if (_outPeers[targetId] === pc) delete _outPeers[targetId];
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    _pub(targetId, { from: _me(), type: 'offer', sdp: pc.localDescription });
  }

  // ── Inbound (receiving) ───────────────────────────────────────────────────

  async function _handleOffer({ from, sdp }) {
    if (_inPeers[from]) { _inPeers[from].close(); delete _inPeers[from]; }
    const pc = new RTCPeerConnection(ICE_CFG);
    _inPeers[from] = pc;

    pc.ontrack = ({ streams: [s] }) => _playIncoming(from, s);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate)
        _pub(from, { from: _me(), type: 'ice', role: 'receiver', candidate: candidate.toJSON() });
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        if (_inPeers[from] === pc) { delete _inPeers[from]; _removeIncoming(from); }
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    _pub(from, { from: _me(), type: 'answer', sdp: pc.localDescription });
  }

  async function _handleAnswer({ from, sdp }) {
    const pc = _outPeers[from];
    if (!pc || pc.signalingState !== 'have-local-offer') return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }

  async function _handleIce({ from, candidate, role }) {
    const pc = role === 'sender' ? _inPeers[from] : _outPeers[from];
    if (!pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  }

  function _playIncoming(senderId, stream) {
    let a = _inAudios[senderId];
    if (!a) {
      a = document.createElement('audio');
      a.autoplay = true;
      a.style.display = 'none';
      // 跟隨當前靜音狀態（soundEnabled 定義於 multiplay.js）
      a.muted = (typeof soundEnabled !== 'undefined' && !soundEnabled);
      document.body.appendChild(a);
      _inAudios[senderId] = a;
    }
    a.srcObject = stream;
  }

  function _setAllAudioMuted(muted) {
    Object.values(_inAudios).forEach(a => { a.muted = muted; });
  }

  function _removeIncoming(senderId) {
    const a = _inAudios[senderId];
    if (a) { a.srcObject = null; a.remove(); delete _inAudios[senderId]; }
    _activeSpeakers.delete(senderId);
    delete _speakerNames[senderId];
    _updateSpeakersUI();
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  function _createStyle() {
    if (document.getElementById('_vb-style')) return;
    const s = document.createElement('style');
    s.id = '_vb-style';
    s.textContent =
      '@keyframes _vbGlow{' +
        '0%,100%{box-shadow:0 0 8px rgba(0,255,80,.55)}' +
        '50%{box-shadow:0 0 24px rgba(0,255,80,.95)}' +
      '}' +
      '@keyframes _vbPulse{0%,100%{opacity:1}50%{opacity:.65}}' +
      '#_vb-btn.vb-on{' +
        'background:rgba(0,160,60,.35)!important;' +
        'border-color:rgba(0,255,80,.85)!important;' +
        'color:#0f5!important;' +
        'animation:_vbGlow .9s ease-in-out infinite;' +
      '}' +
      '#_vb-btn.vb-denied{' +
        'border-color:rgba(255,60,60,.85)!important;' +
        'color:#f44!important;' +
      '}' +
      '#_vb-speakers{' +
        'position:fixed;top:58px;left:50%;transform:translateX(-50%);' +
        'z-index:600;display:none;' +
        'background:rgba(0,36,14,.92);' +
        'border:1px solid rgba(0,255,100,.55);border-radius:24px;' +
        'padding:5px 20px;font-size:.8em;color:#0f8;' +
        'pointer-events:none;white-space:nowrap;' +
        'animation:_vbPulse 1.2s ease-in-out infinite;' +
      '}';
    document.head.appendChild(s);
  }

  function _createSpeakersUI() {
    if (document.getElementById('_vb-speakers')) return;
    const el = document.createElement('div');
    el.id = '_vb-speakers';
    document.body.appendChild(el);
  }

  function _createHostUI() {
    _createStyle();
    const btn = document.createElement('button');
    btn.id        = '_vb-btn';
    btn.className = 'btn-ctrl';
    btn.style.cssText = 'border-color:rgba(255,100,100,.45);color:#f88;cursor:pointer;';
    btn.innerHTML = '🎤 OFF';
    btn.title     = '點擊開啟 / 關閉語音廣播';
    btn.addEventListener('click', toggle);
    const skip = document.getElementById('btn-skip');
    const bar  = document.querySelector('.host-ctrl-bar');
    if (bar && skip) bar.insertBefore(btn, skip);
    else            document.body.appendChild(btn);
    _createSpeakersUI();
  }

  function _createPlayerUI() {
    _createStyle();
    const btn = document.createElement('button');
    btn.id = '_vb-btn';
    btn.textContent = '🎤';
    btn.title = '點擊開啟 / 關閉語音廣播';
    btn.style.cssText =
      'position:fixed;bottom:90px;right:52px;z-index:201;' +
      'width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:18px;' +
      'background:rgba(10,20,40,.9);border:1px solid rgba(255,100,100,.45);' +
      'color:#f88;display:none;padding:0;' +
      'user-select:none;-webkit-user-select:none;';
    btn.addEventListener('click', toggle);
    document.body.appendChild(btn);
    _createSpeakersUI();

    document.getElementById('btn-join')?.addEventListener('click', () => {
      setTimeout(() => { const b = document.getElementById('_vb-btn'); if (b) b.style.display = 'block'; }, 80);
    });
    document.getElementById('btn-back')?.addEventListener('click', () => {
      const b = document.getElementById('_vb-btn');
      if (b) b.style.display = 'none';
    });
  }

  function _setVoiceState(state) {
    const btn = document.getElementById('_vb-btn');
    if (!btn) return;
    btn.classList.remove('vb-on', 'vb-denied');
    if (state === 'on') {
      btn.classList.add('vb-on');
      btn.textContent = '🟢';
      btn.title = '語音廣播中（點擊停止）';
    } else if (state === 'denied') {
      btn.classList.add('vb-denied');
      btn.textContent = '❌';
      btn.title = '麥克風權限被拒絕，請在瀏覽器設定中允許';
      setTimeout(() => _setVoiceState('off'), 3000);
    } else if (state === 'http') {
      btn.classList.add('vb-denied');
      btn.textContent = '🔒';
      btn.title = '語音需要 HTTPS 連線，請改用 https:// 開啟此頁面';
      setTimeout(() => _setVoiceState('off'), 4000);
    } else {
      btn.textContent = '🎤';
      btn.title = '點擊開啟 / 關閉語音廣播';
    }
  }

  function _updateSpeakersUI() {
    const el = document.getElementById('_vb-speakers');
    if (!el) return;
    if (_activeSpeakers.size === 0) { el.style.display = 'none'; return; }
    const names = [..._activeSpeakers].map(id => _speakerNames[id] || id).join('、');
    el.textContent = `🔊 ${names} 說話中...`;
    el.style.display = 'block';
  }

  function _showPermissionGuide() {
    if (document.getElementById('_vb-guide')) return;
    const overlay = document.createElement('div');
    overlay.id = '_vb-guide';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;';

    const box = document.createElement('div');
    box.style.cssText =
      'background:#1a2035;border:1px solid rgba(255,150,50,.65);border-radius:16px;' +
      'padding:24px;max-width:320px;width:100%;color:#fff;font-size:14px;line-height:1.65;' +
      'box-shadow:0 8px 32px rgba(0,0,0,.6);';
    box.innerHTML =
      '<div style="font-size:30px;text-align:center;margin-bottom:10px">🎤🔒</div>' +
      '<div style="font-weight:bold;margin-bottom:10px;color:#ffa040;font-size:16px">麥克風權限被封鎖</div>' +
      '<div style="color:#bbb;margin-bottom:18px">' +
        '請依以下步驟在 Chrome 解除封鎖：<br><br>' +
        '<span style="color:#fff">①</span> 點擊網址列左側的 🔒 圖示<br>' +
        '<span style="color:#fff">②</span> 選擇「<b>網站設定</b>」<br>' +
        '<span style="color:#fff">③</span> 找到「<b>麥克風</b>」→ 改為「<b>允許</b>」<br>' +
        '<span style="color:#fff">④</span> <b>重新整理頁面</b>後再試' +
      '</div>' +
      '<button id="_vb-guide-ok" style="' +
        'width:100%;padding:10px;border-radius:8px;border:none;cursor:pointer;' +
        'background:rgba(255,150,50,.85);color:#fff;font-size:15px;font-weight:bold;">我知道了</button>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.getElementById('_vb-guide-ok')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  function destroy() {
    if (_broadcasting) {
      if (_gainNode) _gainNode.gain.value = 0;
      _broadcasting = false;
      _pubCtrl({ type: 'voice-off', from: _me() });
    }
    _rawStream?.getTracks().forEach(t => t.stop());
    _rawStream = null;
    _myStream  = null;
    _audioCtx?.close();
    _audioCtx = null;
    _gainNode = null;

    Object.values(_outPeers).forEach(pc => pc.close());
    _outPeers = {};
    Object.keys(_inPeers).forEach(id => { _inPeers[id].close(); _removeIncoming(id); });
    _inPeers = {};

    const c = _c();
    if (c) {
      if (_onConnectRef) c.removeListener('connect', _onConnectRef);
      if (_onMsgRef)     c.removeListener('message', _onMsgRef);
      try { c.unsubscribe([SIG_PREFIX + _me(), CTRL_TOPIC]); } catch {}
    }
    ['_vb-btn', '_vb-speakers', '_vb-style'].forEach(id => {
      document.getElementById(id)?.remove();
    });
    _role = _getClient = _getMyId = _getName = _getPlayers = null;
    _onConnectRef = _onMsgRef = null;
    _activeSpeakers = new Set();
    _speakerNames = {};
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    initHost(cfg) {
      _role       = 'host';
      _getClient  = cfg.mqttClient;
      _getMyId    = cfg.myId;
      _getName    = cfg.name;
      _getPlayers = cfg.getPlayers;
      _createHostUI();
      _subscribe();
    },
    initPlayer(cfg) {
      _role       = 'player';
      _getClient  = cfg.mqttClient;
      _getMyId    = cfg.myId;
      _getName    = cfg.name;
      _getPlayers = cfg.getPlayers;
      _createPlayerUI();
      _subscribe();
    },
    start,
    stop,
    toggle,
    isBroadcasting: () => _broadcasting,
    setMuted: _setAllAudioMuted,
    destroy,
  };
})();
