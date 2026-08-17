import { describe, it, expect } from 'vitest';
import {
  SCHEMA, BATCH_WRITABLE_KEYS, findField,
  validateFieldValue, validatePayload, diffSettings, buildSafeExport,
} from './settings-schema.js';

describe('SCHEMA', () => {
  it('every field has the required descriptor properties', () => {
    for (const field of SCHEMA) {
      expect(field.key).toBeTruthy();
      expect(field.tab).toBeTruthy();
      expect(field.label).toBeTruthy();
      expect(['boolean', 'number', 'text', 'password', 'select']).toContain(field.type);
      expect(field.existingSetting).toBe(true); // 這次改動沒有新增任何桌寵原本沒有的設定
      expect(['restart', 'nextChatSend', 'nextRecording', 'immediate']).toContain(field.appliesAt);
    }
  });

  it('does not contain any duplicate keys', () => {
    const keys = SCHEMA.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // sensitive 的欄位（API key）跟 requiresNativeConfirm 的欄位（CLI 免確認）不能出現在
  // 一般批次寫入白名單裡——見 settings-schema.js 開頭說明，這是防止繞過既有二次確認/
  // 誤把明文金鑰寫進批次流程的關鍵不變式。
  it('excludes sensitive and requiresNativeConfirm fields from BATCH_WRITABLE_KEYS', () => {
    expect(BATCH_WRITABLE_KEYS).not.toContain('openaiApiKey');
    expect(BATCH_WRITABLE_KEYS).not.toContain('cliFreePermissionMode');
    expect(BATCH_WRITABLE_KEYS).toContain('chatProvider');
    expect(BATCH_WRITABLE_KEYS).toContain('micRmsThreshold');
  });
});

describe('validateFieldValue', () => {
  it('coerces boolean fields to actual booleans', () => {
    const field = findField('showLive2DOnStartup');
    expect(validateFieldValue(field, 1)).toEqual({ ok: true, value: true });
    expect(validateFieldValue(field, 0)).toEqual({ ok: true, value: false });
    expect(validateFieldValue(field, 'anything-truthy')).toEqual({ ok: true, value: true });
  });

  it('rejects non-numeric input for number fields', () => {
    const field = findField('micRmsThreshold');
    const result = validateFieldValue(field, 'not-a-number');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('數字');
  });

  it('rejects numbers outside min/max for number fields', () => {
    const field = findField('micRmsThreshold'); // min 0.005, max 1
    expect(validateFieldValue(field, 0).ok).toBe(false);
    expect(validateFieldValue(field, 1.5).ok).toBe(false);
    expect(validateFieldValue(field, 0.04).ok).toBe(true);
  });

  it('accepts boundary values for number fields (inclusive min/max)', () => {
    const field = findField('micMinSpeechDurationMs'); // min 0, max 60000
    expect(validateFieldValue(field, 0)).toEqual({ ok: true, value: 0 });
    expect(validateFieldValue(field, 60000)).toEqual({ ok: true, value: 60000 });
  });

  it('rejects an unknown provider for the select field', () => {
    const field = findField('chatProvider');
    const result = validateFieldValue(field, 'anthropic');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('openai');
  });

  it('accepts a known choice for the select field', () => {
    const field = findField('chatProvider');
    expect(validateFieldValue(field, 'ollama')).toEqual({ ok: true, value: 'ollama' });
  });

  it('trims text fields but does not reject blank text at the field-validation level', () => {
    // 空白 Ollama URL 的「不能是空白」規則是 provider 選 ollama 時才成立的跨欄位規則，
    // 屬於 settings-store.js saveChatProviderSettings() 既有邏輯的層級，不是單一欄位
    // 的型別驗證——這裡只驗證單欄位的 trim 行為本身。
    const field = findField('ollamaBaseUrl');
    expect(validateFieldValue(field, '  http://localhost:11434  ')).toEqual({
      ok: true, value: 'http://localhost:11434',
    });
  });

  it('returns an error for an unknown field', () => {
    expect(validateFieldValue(undefined, 'x').ok).toBe(false);
  });
});

describe('validatePayload', () => {
  it('accepts a payload with only whitelisted, valid fields', () => {
    const result = validatePayload({ chatProvider: 'ollama', micRmsThreshold: 0.1 });
    expect(result.ok).toBe(true);
    expect(result.values).toEqual({ chatProvider: 'ollama', micRmsThreshold: 0.1 });
    expect(result.errors).toEqual([]);
  });

  it('silently drops keys that are not in the schema (no arbitrary key can be written)', () => {
    const result = validatePayload({ chatProvider: 'openai', __proto__: 'x', notARealSetting: 'evil' });
    expect(result.values).not.toHaveProperty('notARealSetting');
    expect(Object.keys(result.values)).toEqual(['chatProvider']);
  });

  it('silently drops sensitive and requiresNativeConfirm keys even if present in the payload', () => {
    const result = validatePayload({ openaiApiKey: 'sk-leaked', cliFreePermissionMode: true, chatProvider: 'openai' });
    expect(result.values).not.toHaveProperty('openaiApiKey');
    expect(result.values).not.toHaveProperty('cliFreePermissionMode');
    expect(Object.keys(result.values)).toEqual(['chatProvider']);
  });

  it('reports a per-field error and does not include that field in values, while still validating the rest', () => {
    const result = validatePayload({ chatProvider: 'openai', micRmsThreshold: 999 });
    expect(result.ok).toBe(false);
    expect(result.values).toEqual({ chatProvider: 'openai' });
    expect(result.errors).toEqual([{ key: 'micRmsThreshold', label: '聲音最低門檻（RMS）', message: expect.stringContaining('1') }]);
  });

  it('rejects a non-object payload without throwing', () => {
    expect(validatePayload(null).ok).toBe(false);
    expect(validatePayload('a string').ok).toBe(false);
  });
});

describe('diffSettings', () => {
  it('lists only the fields that actually changed', () => {
    const current = { chatProvider: 'openai', micRmsThreshold: 0.04 };
    const incoming = { chatProvider: 'ollama', micRmsThreshold: 0.04 };
    const changes = diffSettings(current, incoming);
    expect(changes).toEqual([{ key: 'chatProvider', label: '即時對話 AI 提供者', oldValue: 'openai', newValue: 'ollama' }]);
  });

  it('falls back to the schema default when a key is absent from current (never-saved field)', () => {
    const changes = diffSettings({}, { micRmsThreshold: 0.1 });
    expect(changes).toEqual([{ key: 'micRmsThreshold', label: '聲音最低門檻（RMS）', oldValue: 0.04, newValue: 0.1 }]);
  });

  it('returns an empty array when nothing differs', () => {
    expect(diffSettings({ chatProvider: 'openai' }, { chatProvider: 'openai' })).toEqual([]);
  });

  it('ignores sensitive/requiresNativeConfirm keys even if present in the incoming object', () => {
    const changes = diffSettings({}, { openaiApiKey: 'sk-x', cliFreePermissionMode: true });
    expect(changes).toEqual([]);
  });
});

describe('buildSafeExport', () => {
  it('never includes sensitive or requiresNativeConfirm fields, even when present in the source values', () => {
    const exported = buildSafeExport({
      chatProvider: 'ollama', openaiApiKey: 'sk-should-never-appear', cliFreePermissionMode: true,
    });
    expect(exported).not.toHaveProperty('openaiApiKey');
    expect(exported).not.toHaveProperty('cliFreePermissionMode');
    expect(JSON.stringify(exported)).not.toContain('sk-should-never-appear');
  });

  it('includes every batch-writable field, filling in defaults for anything unset', () => {
    const exported = buildSafeExport({ chatProvider: 'ollama' });
    for (const key of BATCH_WRITABLE_KEYS) {
      expect(exported).toHaveProperty(key);
    }
    expect(exported.micRmsThreshold).toBe(0.04); // 沒帶值，退回 schema 預設值
  });
});
