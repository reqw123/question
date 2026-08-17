
(async function () {
  const cc = window.controlCenter;
  if (!cc) {
    document.body.innerHTML = '<div style="padding:24px;color:#ff6b6b;">控制中心的 preload 沒有正確載入，這個視窗無法使用；請關閉這個視窗，桌寵/host-app/網頁模式都不受影響，照 launchers/*.bat 原本的方式一樣能用。</div>';
    return;
  }
  const { SCHEMA, TABS, APPLIES_AT_LABEL } = await cc.getSchema();

  // ── 分頁定義：行程管理放第一個（這個 app 的主要定位），其餘沿用桌寵設定那幾頁 ──
  const TAB_ORDER = [
    { id: 'process', label: '行程管理' },
    { id: 'chat', label: TABS.chat },
    { id: 'voice', label: TABS.voice },
    { id: 'display', label: TABS.display },
    { id: 'cli', label: TABS.cli },
    { id: 'manage', label: '設定檔管理' },
    { id: 'diagnostics', label: '診斷與日誌' },
  ];

  let activeTab = 'process';
  let lastLoadedValues = {};
  let lastLoadedSources = {};

  // ── 日誌面板（控制中心操作日誌，跟行程輸出面板分開） ──
  const logOutput = () => document.getElementById('logOutput');
  function log(text, cls) {
    const el = logOutput();
    if (!el) return;
    const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = `[${time}] ${text}`;
    el.appendChild(line);
    if (document.getElementById('logAutoscroll') && document.getElementById('logAutoscroll').checked) {
      el.scrollTop = el.scrollHeight;
    }
  }

  // ── 版面骨架 ──
  function buildChrome() {
    const tabbar = document.getElementById('tabbar');
    TAB_ORDER.forEach(({ id, label }) => {
      const btn = document.createElement('button');
      btn.className = 'tab-btn' + (id === activeTab ? ' active' : '');
      btn.textContent = label;
      btn.dataset.tab = id;
      btn.addEventListener('click', () => switchTab(id));
      tabbar.appendChild(btn);
    });

    const content = document.getElementById('content');
    TAB_ORDER.forEach(({ id }) => {
      const panel = document.createElement('div');
      panel.className = 'tab-panel' + (id === activeTab ? ' active' : '');
      panel.id = `panel-${id}`;
      content.appendChild(panel);
    });

    buildProcessTab();
    buildDataTabs();
    buildCliTab();
    buildManageTab();
    buildDiagnosticsTab();
  }

  function switchTab(id) {
    activeTab = id;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${id}`));
  }

  // ── 行程管理分頁：桌寵模式／App 模式／網頁模式的啟動/關閉/現況 ──
  const PROCESS_MODES = [
    { id: 'desktop-pet', label: '🐾 桌寵模式（desktop-pet）', desc: 'Live2D 桌面透明背景掛件，含 CLI 模式、即時對話、語音輸入等功能。' },
    { id: 'host-app', label: '🖥️ App 模式（host-app）', desc: '多人搶答「主持人畫面」的桌面殼層，載入 5500 埠的 multi/host.html（有現成伺服器就沿用，沒有就自動用內建 Node 靜態伺服器頂上）。' },
    { id: 'web', label: '🌐 網頁模式（multi/，8080 埠）', desc: '多人搶答的網頁版靜態伺服器——有 caddy.exe 就用它（支援 ngrok 對外開放），沒有就用內建的 launchers/serve-lan.js（純區網）。' },
  ];
  const procLogOutput = () => document.getElementById('procLogOutput');
  function procLog(modeId, text) {
    const el = procLogOutput();
    if (!el) return;
    const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    const line = document.createElement('div');
    const tag = document.createElement('span');
    tag.className = `proc-tag-${modeId}`;
    tag.textContent = `[${modeId}] `;
    line.appendChild(tag);
    line.appendChild(document.createTextNode(`${time} ${text}`));
    el.appendChild(line);
    if (document.getElementById('procLogAutoscroll') && document.getElementById('procLogAutoscroll').checked) {
      el.scrollTop = el.scrollHeight;
    }
  }

  function buildProcessTab() {
    const panel = document.getElementById('panel-process');
    PROCESS_MODES.forEach(({ id, label, desc }) => {
      const card = document.createElement('div');
      card.className = 'field-card';
      card.dataset.modeId = id;

      const head = document.createElement('div');
      head.className = 'field-head';
      const l = document.createElement('div');
      l.className = 'field-label'; l.textContent = label;
      const statusBadge = document.createElement('span');
      statusBadge.className = 'badge badge-stopped';
      statusBadge.id = `proc-status-${id}`;
      statusBadge.textContent = '未執行';
      head.appendChild(l); head.appendChild(statusBadge);

      const d = document.createElement('div');
      d.className = 'field-desc'; d.textContent = desc;

      const row = document.createElement('div');
      row.className = 'btn-row';
      const startBtn = document.createElement('button');
      startBtn.className = 'btn-primary'; startBtn.textContent = '▶ 啟動';
      startBtn.id = `proc-start-${id}`;
      startBtn.addEventListener('click', async () => {
        procLog(id, '— 啟動中... —');
        const result = await cc.startProcess(id);
        if (!result.ok) { procLog(id, `啟動失敗：${result.error}`); }
        else { procLog(id, `已啟動（PID ${result.pid}）`); }
        await refreshProcessStatus();
      });
      const stopBtn = document.createElement('button');
      stopBtn.className = 'btn-danger'; stopBtn.textContent = '⏹ 停止';
      stopBtn.id = `proc-stop-${id}`;
      stopBtn.addEventListener('click', async () => {
        procLog(id, '— 停止中... —');
        const result = await cc.stopProcess(id);
        if (!result.ok) { procLog(id, `停止失敗或本來就沒在跑：${result.error || ''}`); }
        else { procLog(id, result.forced ? '已強制停止' : '已停止'); }
        await refreshProcessStatus();
      });
      row.appendChild(startBtn); row.appendChild(stopBtn);
      if (id === 'web') {
        const openBtn = document.createElement('button');
        openBtn.className = 'btn-secondary'; openBtn.textContent = '開啟瀏覽器';
        openBtn.addEventListener('click', () => cc.openExternal('http://localhost:8080/multi/host.html'));
        row.appendChild(openBtn);
      }

      card.appendChild(head); card.appendChild(d); card.appendChild(row);
      panel.appendChild(card);
    });

    const logBox = document.createElement('div');
    logBox.className = 'field-card';
    logBox.innerHTML = `
      <div class="field-label" style="margin-bottom:8px;">行程輸出（三種模式共用同一個面板，用顏色/前綴區分來源）</div>
      <div id="procLogPanel">
        <div id="procLogToolbar">
          <label><input type="checkbox" id="procLogAutoscroll" checked> 自動捲動</label>
          <div class="spacer"></div>
          <button id="btn-clear-proc-log" class="btn-secondary" style="padding:4px 10px;font-size:.8em;">清除</button>
        </div>
        <div id="procLogOutput"></div>
      </div>`;
    panel.appendChild(logBox);
    document.getElementById('btn-clear-proc-log').addEventListener('click', () => { procLogOutput().innerHTML = ''; });

    cc.onProcessLog(({ modeId, text, streamName }) => {
      text.split(/\r?\n/).filter((l) => l.length).forEach((l) => procLog(modeId, streamName === 'meta' ? l : l));
    });
  }

  async function refreshProcessStatus() {
    try {
      const status = await cc.getProcessStatus();
      Object.entries(status).forEach(([id, info]) => {
        const badge = document.getElementById(`proc-status-${id}`);
        const startBtn = document.getElementById(`proc-start-${id}`);
        const stopBtn = document.getElementById(`proc-stop-${id}`);
        if (!badge) return;
        badge.className = 'badge ' + (info.running ? 'badge-running' : 'badge-stopped');
        badge.textContent = info.running ? `執行中（PID ${info.pid}）` : '未執行';
        if (startBtn) startBtn.disabled = !!info.running;
        if (stopBtn) stopBtn.disabled = !info.running;
      });
    } catch { /* 忽略單次輪詢失敗，下一次 2 秒後會再試 */ }
  }

  // ── 欄位控制項產生（schema 驅動，chat/voice/display 三個分頁共用） ──
  function fieldInputId(key) { return `field-${key}`; }

  function renderFieldControl(field) {
    const wrap = document.createElement('div');
    wrap.className = 'field-control';
    if (field.type === 'boolean') {
      const row = document.createElement('div');
      row.className = 'btn-row';
      const offBtn = document.createElement('button');
      offBtn.type = 'button'; offBtn.className = 'btn-toggle'; offBtn.textContent = '關閉';
      const onBtn = document.createElement('button');
      onBtn.type = 'button'; onBtn.className = 'btn-toggle'; onBtn.textContent = '開啟';
      const hidden = document.createElement('input');
      hidden.type = 'hidden'; hidden.id = fieldInputId(field.key);
      function setVal(v) {
        hidden.value = v ? 'true' : 'false';
        offBtn.classList.toggle('active', !v);
        onBtn.classList.toggle('active', v);
      }
      offBtn.addEventListener('click', () => setVal(false));
      onBtn.addEventListener('click', () => setVal(true));
      hidden.dataset.setVal = 'true';
      hidden._setVal = setVal;
      row.appendChild(offBtn); row.appendChild(onBtn);
      wrap.appendChild(row); wrap.appendChild(hidden);
    } else if (field.type === 'select') {
      const sel = document.createElement('select');
      sel.id = fieldInputId(field.key);
      (field.choices || []).forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.value; opt.textContent = c.label;
        sel.appendChild(opt);
      });
      wrap.appendChild(sel);
    } else if (field.type === 'number') {
      const input = document.createElement('input');
      input.type = 'number'; input.id = fieldInputId(field.key);
      if (typeof field.min === 'number') input.min = field.min;
      if (typeof field.max === 'number') input.max = field.max;
      if (typeof field.step === 'number') input.step = field.step;
      wrap.appendChild(input);
      const hint = document.createElement('div');
      hint.className = 'field-range-hint';
      hint.textContent = `可接受範圍：${field.min} ～ ${field.max}（預設 ${field.defaultValue}）`;
      wrap.appendChild(hint);
    } else if (field.type === 'text') {
      const input = document.createElement('input');
      input.type = 'text'; input.id = fieldInputId(field.key);
      wrap.appendChild(input);
    } else if (field.type === 'password') {
      const status = document.createElement('div');
      status.id = 'apiKeyStatus';
      status.style.marginBottom = '8px';
      status.textContent = '讀取中...';
      const input = document.createElement('input');
      input.type = 'password'; input.id = fieldInputId(field.key);
      input.placeholder = '輸入新的 API Key 以覆蓋（留空表示不變更）';
      input.autocomplete = 'off';
      const row = document.createElement('div');
      row.className = 'btn-row'; row.style.marginTop = '8px';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button'; saveBtn.className = 'btn-primary'; saveBtn.textContent = '儲存新 Key';
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button'; clearBtn.className = 'btn-danger'; clearBtn.textContent = '清除';
      const msg = document.createElement('div');
      msg.className = 'msg'; msg.id = 'apiKeyMsg';
      saveBtn.addEventListener('click', async () => {
        msg.className = 'msg'; msg.textContent = '儲存中...';
        const result = await cc.saveApiKey(input.value);
        if (result.ok) {
          input.value = '';
          status.textContent = '目前已設定過 API key（輸入新的並儲存即可覆蓋）';
          msg.className = 'msg ok'; msg.textContent = '✅ 已儲存';
          log('API key 已更新', 'ok');
        } else {
          msg.className = 'msg error'; msg.textContent = '❌ ' + result.error;
          log('API key 儲存失敗：' + result.error, 'err');
        }
      });
      clearBtn.addEventListener('click', async () => {
        const result = await cc.clearApiKey();
        if (result.cancelled) return;
        if (result.ok) {
          status.textContent = '目前尚未設定 API key';
          msg.className = 'msg ok'; msg.textContent = '✅ 已清除';
          log('API key 已清除', 'ok');
        } else {
          msg.className = 'msg error'; msg.textContent = '❌ ' + result.error;
          log('API key 清除失敗：' + result.error, 'err');
        }
      });
      row.appendChild(saveBtn); row.appendChild(clearBtn);
      wrap.appendChild(status); wrap.appendChild(input); wrap.appendChild(row); wrap.appendChild(msg);
    }
    return wrap;
  }

  function renderFieldCard(field) {
    const card = document.createElement('div');
    card.className = 'field-card';
    card.dataset.key = field.key;

    const head = document.createElement('div');
    head.className = 'field-head';
    const label = document.createElement('div');
    label.className = 'field-label'; label.textContent = field.label;
    const badges = document.createElement('div');
    badges.className = 'field-badges';
    if (field.type !== 'password') {
      const sourceBadge = document.createElement('span');
      sourceBadge.className = 'badge badge-default';
      sourceBadge.id = `source-${field.key}`;
      sourceBadge.textContent = '預設值';
      badges.appendChild(sourceBadge);
    }
    const appliesBadge = document.createElement('span');
    appliesBadge.className = 'badge badge-applies';
    appliesBadge.textContent = APPLIES_AT_LABEL[field.appliesAt] || field.appliesAt;
    badges.appendChild(appliesBadge);
    head.appendChild(label); head.appendChild(badges);

    const desc = document.createElement('div');
    desc.className = 'field-desc'; desc.textContent = field.description;

    const err = document.createElement('div');
    err.className = 'field-error'; err.id = `error-${field.key}`;

    card.appendChild(head);
    card.appendChild(desc);
    card.appendChild(renderFieldControl(field));
    card.appendChild(err);
    return card;
  }

  function buildDataTabs() {
    ['chat', 'voice', 'display'].forEach((tabId) => {
      const panel = document.getElementById(`panel-${tabId}`);
      const fields = SCHEMA.filter((f) => f.tab === tabId);
      if (!fields.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-hint'; empty.textContent = '目前尚無可調整項目';
        panel.appendChild(empty);
        return;
      }
      fields.forEach((f) => panel.appendChild(renderFieldCard(f)));

      const saveRow = document.createElement('div');
      saveRow.className = 'btn-row'; saveRow.style.marginTop = '4px';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button'; saveBtn.className = 'btn-primary';
      saveBtn.textContent = '儲存這個分頁的變更';
      saveBtn.addEventListener('click', () => saveFields(fields.map((f) => f.key)));
      const msg = document.createElement('div');
      msg.className = 'msg'; msg.id = `save-msg-${tabId}`;
      panel.appendChild(saveRow); saveRow.appendChild(saveBtn); panel.appendChild(msg);
    });
  }

  // CLI 分頁只有 cliFreePermissionMode 這一個欄位，而且 requiresNativeConfirm——不走
  // renderFieldCard()/saveFields() 那套一般批次儲存，直接呼叫 cc.setCliFreeMode()（main.js
  // 那邊會跳主程序原生二次確認），控制中心無法略過這個確認。
  function buildCliTab() {
    const panel = document.getElementById('panel-cli');
    const field = SCHEMA.find((f) => f.key === 'cliFreePermissionMode');
    const banner = document.createElement('div');
    banner.className = 'risk-banner';
    banner.textContent = '⚠️ ' + field.description;
    panel.appendChild(banner);

    const row = document.createElement('div');
    row.className = 'btn-row';
    const offBtn = document.createElement('button');
    offBtn.type = 'button'; offBtn.className = 'btn-toggle'; offBtn.textContent = '🔒 關閉（預設，安全）';
    const onBtn = document.createElement('button');
    onBtn.type = 'button'; onBtn.className = 'btn-toggle risk'; onBtn.textContent = '⚡ 開啟（風險，需二次確認）';
    const msg = document.createElement('div');
    msg.className = 'msg';
    function setUI(enabled) {
      offBtn.classList.toggle('active', !enabled);
      onBtn.classList.toggle('active', enabled);
    }
    offBtn.addEventListener('click', async () => {
      const result = await cc.setCliFreeMode(false);
      if (result.ok) { setUI(false); msg.className = 'msg ok'; msg.textContent = '✅ 已關閉，CLI 模式恢復逐步確認'; log('CLI 免確認模式：已關閉', 'ok'); }
      else { msg.className = 'msg error'; msg.textContent = '❌ ' + result.error; }
    });
    onBtn.addEventListener('click', async () => {
      const result = await cc.setCliFreeMode(true);
      if (result.cancelled) { log('CLI 免確認模式：使用者在主程序確認對話框取消'); return; }
      if (result.ok) { setUI(true); msg.className = 'msg ok'; msg.textContent = '⚡ 已開啟，CLI 模式的風險操作不會再等你確認'; log('CLI 免確認模式：已開啟', 'ok'); }
      else { msg.className = 'msg error'; msg.textContent = '❌ ' + result.error; }
    });
    row.appendChild(offBtn); row.appendChild(onBtn);
    panel.appendChild(row); panel.appendChild(msg);
    panel._setCliUI = setUI;
  }

  // ── 收集/套用表單值 ──
  function readFieldValue(key) {
    const field = SCHEMA.find((f) => f.key === key);
    const el = document.getElementById(fieldInputId(key));
    if (!el) return undefined;
    if (field.type === 'boolean') return el.value === 'true';
    if (field.type === 'number') return Number(el.value);
    return el.value;
  }

  function applyFieldValue(key, value) {
    const field = SCHEMA.find((f) => f.key === key);
    const el = document.getElementById(fieldInputId(key));
    if (!el || !field) return;
    if (field.type === 'boolean') {
      if (el._setVal) el._setVal(!!value);
    } else {
      el.value = value;
    }
  }

  function setFieldSource(key, source) {
    const badge = document.getElementById(`source-${key}`);
    if (!badge) return;
    badge.className = 'badge ' + (source === 'user' ? 'badge-user' : 'badge-default');
    badge.textContent = source === 'user' ? '使用者設定' : '預設值';
  }

  function clearFieldErrors(keys) {
    keys.forEach((key) => {
      const card = document.querySelector(`.field-card[data-key="${key}"]`);
      const err = document.getElementById(`error-${key}`);
      if (card) card.classList.remove('has-error');
      if (err) err.textContent = '';
    });
  }

  function showFieldErrors(errors) {
    (errors || []).forEach(({ key, message }) => {
      if (!key) return;
      const card = document.querySelector(`.field-card[data-key="${key}"]`);
      const err = document.getElementById(`error-${key}`);
      if (card) card.classList.add('has-error');
      if (err) err.textContent = message;
    });
  }

  async function saveFields(keys) {
    clearFieldErrors(keys);
    const payload = {};
    keys.forEach((key) => { payload[key] = readFieldValue(key); });
    const result = await cc.saveSettings(payload);
    const tabId = SCHEMA.find((f) => f.key === keys[0]).tab;
    const msgEl = document.getElementById(`save-msg-${tabId}`);
    if (result.ok) {
      keys.forEach((key) => setFieldSource(key, 'user'));
      const appliesTexts = [...new Set(keys.map((k) => APPLIES_AT_LABEL[SCHEMA.find((f) => f.key === k).appliesAt]))];
      if (msgEl) { msgEl.className = 'msg ok'; msgEl.textContent = `✅ 已儲存，${appliesTexts.join('、')}`; }
      log(`已儲存：${keys.join('、')}`, 'ok');
    } else {
      showFieldErrors(result.errors);
      const summary = (result.errors || []).map((e) => `${e.label || e.key || ''}：${e.message}`).join('\n');
      if (msgEl) { msgEl.className = 'msg error'; msgEl.textContent = '❌ 驗證未通過，未儲存：\n' + summary; }
      log('儲存驗證失敗：' + summary.replace(/\n/g, '；'), 'err');
    }
  }

  // ── 設定檔管理分頁：載入 / 儲存全部 / 恢復預設 / 匯出 / 匯入 ──
  function buildManageTab() {
    const panel = document.getElementById('panel-manage');

    const section = (title, desc) => {
      const box = document.createElement('div');
      box.className = 'field-card';
      const h = document.createElement('div');
      h.className = 'field-label'; h.textContent = title; h.style.marginBottom = '6px';
      box.appendChild(h);
      if (desc) {
        const d = document.createElement('div');
        d.className = 'field-desc'; d.textContent = desc;
        box.appendChild(d);
      }
      panel.appendChild(box);
      return box;
    };

    const loadBox = section('載入目前有效設定', '重新從桌寵的 settings.json 讀取，套用到上面各分頁的表單。');
    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn-secondary'; loadBtn.textContent = '重新載入';
    const loadMsg = document.createElement('div'); loadMsg.className = 'msg';
    loadBtn.addEventListener('click', async () => { await loadAllSettings(); loadMsg.className = 'msg ok'; loadMsg.textContent = '✅ 已重新載入'; log('已重新載入目前設定', 'ok'); });
    loadBox.appendChild(loadBtn); loadBox.appendChild(loadMsg);

    const saveAllBox = section('儲存所有變更', '把「聊天與 AI」「語音輸入」「桌寵顯示」三個分頁目前表單上的值一次全部儲存（CLI 免確認模式是獨立的即時開關，不包含在這裡）。');
    const saveAllBtn = document.createElement('button');
    saveAllBtn.className = 'btn-primary'; saveAllBtn.textContent = '儲存所有變更';
    const saveAllMsg = document.createElement('div'); saveAllMsg.className = 'msg';
    saveAllBtn.addEventListener('click', async () => {
      const keys = SCHEMA.filter((f) => !f.sensitive && !f.requiresNativeConfirm).map((f) => f.key);
      clearFieldErrors(keys);
      const payload = {};
      keys.forEach((key) => { payload[key] = readFieldValue(key); });
      const result = await cc.saveSettings(payload);
      if (result.ok) {
        keys.forEach((key) => setFieldSource(key, 'user'));
        saveAllMsg.className = 'msg ok'; saveAllMsg.textContent = '✅ 全部已儲存';
        log('已儲存所有分頁的變更', 'ok');
      } else {
        showFieldErrors(result.errors);
        const summary = (result.errors || []).map((e) => `${e.label || e.key || ''}：${e.message}`).join('\n');
        saveAllMsg.className = 'msg error'; saveAllMsg.textContent = '❌ 驗證未通過，未儲存：\n' + summary;
        log('儲存全部失敗：' + summary.replace(/\n/g, '；'), 'err');
      }
    });
    saveAllBox.appendChild(saveAllBtn); saveAllBox.appendChild(saveAllMsg);

    const resetBox = section('恢復各欄位預設值', '把可管理的欄位重設回內建預設值（不含 API Key／CLI 免確認模式，這兩個各自有專屬的清除/關閉操作）。');
    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn-danger'; resetBtn.textContent = '恢復預設值';
    const resetMsg = document.createElement('div'); resetMsg.className = 'msg';
    resetBtn.addEventListener('click', async () => {
      const keys = SCHEMA.filter((f) => !f.sensitive && !f.requiresNativeConfirm).map((f) => f.key);
      const labels = keys.map((k) => SCHEMA.find((f) => f.key === k).label);
      if (!window.confirm(`即將把以下欄位恢復成內建預設值：\n\n${labels.join('、')}\n\n是否繼續？`)) return;
      const result = await cc.resetSettings(keys);
      if (result.ok) {
        await loadAllSettings();
        resetMsg.className = 'msg ok'; resetMsg.textContent = '✅ 已恢復預設值';
        log('已恢復預設值：' + keys.join('、'), 'ok');
      } else {
        resetMsg.className = 'msg error'; resetMsg.textContent = '❌ ' + (result.error || '恢復失敗');
        log('恢復預設值失敗：' + (result.error || ''), 'err');
      }
    });
    resetBox.appendChild(resetBtn); resetBox.appendChild(resetMsg);

    const exportBox = section('匯出設定', '匯出控制中心可管理的非敏感設定成 JSON 檔（不含 API Key、不含 CLI 免確認狀態）。');
    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn-secondary'; exportBtn.textContent = '匯出設定...';
    const exportMsg = document.createElement('div'); exportMsg.className = 'msg';
    exportBtn.addEventListener('click', async () => {
      const result = await cc.exportSettings();
      if (result.cancelled) return;
      if (result.ok) { exportMsg.className = 'msg ok'; exportMsg.textContent = `✅ 已匯出到：${result.path}`; log('已匯出設定到：' + result.path, 'ok'); }
      else { exportMsg.className = 'msg error'; exportMsg.textContent = '❌ ' + result.error; log('匯出失敗：' + result.error, 'err'); }
    });
    exportBox.appendChild(exportBtn); exportBox.appendChild(exportMsg);

    const importBox = section('匯入設定', '選擇之前匯出的 JSON 檔案，會先顯示變更差異，確認後才會真正寫入。API Key／CLI 免確認狀態不會被匯入檔案影響。');
    const importBtn = document.createElement('button');
    importBtn.className = 'btn-secondary'; importBtn.textContent = '匯入設定...';
    const importMsg = document.createElement('div'); importMsg.className = 'msg';
    let pendingImportValues = null;
    importBtn.addEventListener('click', async () => {
      importMsg.className = 'msg'; importMsg.textContent = '';
      const result = await cc.importPreview();
      if (result.cancelled) return;
      if (!result.ok) {
        const summary = (result.errors || []).map((e) => e.message).join('\n');
        importMsg.className = 'msg error'; importMsg.textContent = '❌ 檔案驗證失敗，未套用：\n' + summary;
        log('匯入驗證失敗：' + summary.replace(/\n/g, '；'), 'err');
        return;
      }
      if (!result.changes || !result.changes.length) {
        importMsg.className = 'msg ok'; importMsg.textContent = '與目前設定相同，沒有變更。';
        log('匯入：內容與目前設定相同，沒有變更');
        return;
      }
      pendingImportValues = result.values;
      showDiffDialog(result.changes);
    });
    importBox.appendChild(importBtn); importBox.appendChild(importMsg);

    document.getElementById('btn-diff-cancel').addEventListener('click', () => {
      hideDiffDialog();
      pendingImportValues = null;
      log('匯入：使用者取消，未套用任何變更');
    });
    document.getElementById('btn-diff-apply').addEventListener('click', async () => {
      if (!pendingImportValues) return;
      const result = await cc.importApply(pendingImportValues);
      hideDiffDialog();
      if (result.ok) {
        await loadAllSettings();
        importMsg.className = 'msg ok'; importMsg.textContent = '✅ 已套用匯入的設定';
        log('已套用匯入的設定', 'ok');
      } else {
        const summary = (result.errors || []).map((e) => `${e.label || e.key || ''}：${e.message}`).join('\n');
        importMsg.className = 'msg error'; importMsg.textContent = '❌ 匯入套用失敗：\n' + summary;
        log('匯入套用失敗：' + summary.replace(/\n/g, '；'), 'err');
      }
      pendingImportValues = null;
    });
  }

  function showDiffDialog(changes) {
    const list = document.getElementById('diffList');
    list.innerHTML = '';
    document.getElementById('diffTitle').textContent = `匯入設定變更預覽（共 ${changes.length} 項）`;
    changes.forEach(({ label, oldValue, newValue }) => {
      const item = document.createElement('div');
      item.className = 'diff-item';
      item.innerHTML = `<div>${label}</div><div class="diff-old">舊：${String(oldValue)}</div><div class="diff-new">新：${String(newValue)}</div>`;
      list.appendChild(item);
    });
    document.getElementById('diffOverlay').classList.add('active');
  }
  function hideDiffDialog() { document.getElementById('diffOverlay').classList.remove('active'); }

  // ── 診斷與日誌分頁 ──
  function buildDiagnosticsTab() {
    const panel = document.getElementById('panel-diagnostics');
    const diagBox = document.createElement('div');
    diagBox.className = 'field-card';
    diagBox.id = 'diagBox';
    diagBox.innerHTML = '<div class="field-label" style="margin-bottom:8px;">設定檔狀態</div><div id="diagBody">讀取中...</div>';
    panel.appendChild(diagBox);

    const logBox = document.createElement('div');
    logBox.className = 'field-card';
    logBox.innerHTML = `
      <div class="field-label" style="margin-bottom:8px;">控制中心操作日誌</div>
      <div id="logPanel">
        <div id="logToolbar">
          <label><input type="checkbox" id="logAutoscroll" checked> 自動捲動</label>
          <div class="spacer"></div>
          <button id="btn-clear-log" class="btn-secondary" style="padding:4px 10px;font-size:.8em;">清除</button>
        </div>
        <div id="logOutput"></div>
      </div>`;
    panel.appendChild(logBox);
    document.getElementById('btn-clear-log').addEventListener('click', () => { logOutput().innerHTML = ''; });
  }

  function renderDiagnostics(diagnostics) {
    const body = document.getElementById('diagBody');
    if (!body) return;
    body.innerHTML = '';
    const rows = [
      ['設定檔路徑', diagnostics.path, false],
      ['是否存在', diagnostics.exists ? '是' : '否（尚未建立，桌寵仍會用內建預設值正常運作）', !diagnostics.exists],
      ['JSON 是否可解析', diagnostics.exists ? (diagnostics.parseOk ? '是' : `否：${diagnostics.parseError}`) : '（檔案不存在，不適用）', diagnostics.exists && !diagnostics.parseOk],
      ['最後修改時間', diagnostics.lastModified || '（無）', false],
    ];
    rows.forEach(([k, v, bad]) => {
      const row = document.createElement('div');
      row.className = 'diag-row';
      row.innerHTML = `<div class="diag-key">${k}</div><div class="${bad ? 'diag-bad' : ''}">${v}</div>`;
      body.appendChild(row);
    });
    const pathBox = document.createElement('div');
    pathBox.className = 'path-box';
    pathBox.textContent = diagnostics.path;
    body.appendChild(pathBox);
    if (diagnostics.exists && !diagnostics.parseOk) {
      log('警告：settings.json 目前無法解析（' + diagnostics.parseError + '），桌寵核心已自動退回內建預設值繼續運作，這裡不會自動覆蓋或清空這個檔案', 'err');
    }
  }

  // ── 載入全部設定並套用到表單 ──
  async function loadAllSettings() {
    try {
      const { values, apiKeyStatus, sources, diagnostics } = await cc.loadSettings();
      lastLoadedValues = values; lastLoadedSources = sources;
      Object.keys(values).forEach((key) => {
        applyFieldValue(key, values[key]);
        setFieldSource(key, sources[key] || 'default');
      });
      const cliPanel = document.getElementById('panel-cli');
      if (cliPanel && cliPanel._setCliUI) cliPanel._setCliUI(!!values.cliFreePermissionMode);
      const statusEl = document.getElementById('apiKeyStatus');
      if (statusEl) statusEl.textContent = apiKeyStatus ? '目前已設定過 API key（輸入新的並儲存即可覆蓋）' : '目前尚未設定 API key';
      renderDiagnostics(diagnostics);
      log('已載入目前設定');
    } catch (err) {
      log('載入設定失敗：' + err.message, 'err');
    }
  }

  buildChrome();
  loadAllSettings();
  refreshProcessStatus();
  setInterval(refreshProcessStatus, 2000);
})();
