import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import store from './model-config-store.js';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-config-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('pruneEmpty', () => {
  it('drops blank strings, empty arrays and empty objects recursively but keeps 0 and false', () => {
    expect(
      store.pruneEmpty({
        file: 'a.glb',
        particle: { scale: [], rotationY: 0, animatedIdle: false, periodicAnimation: { name: '', intervalSeconds: '' } },
        color: undefined,
        idleMotion: { type: '', speed: null },
      })
    ).toEqual({ file: 'a.glb', particle: { rotationY: 0, animatedIdle: false } });
  });
});

describe('validateParticleEntry', () => {
  it('accepts a minimal entry', () => {
    expect(store.validateParticleEntry('aModel', { file: 'a.glb' })).toEqual({ errors: [], warnings: [] });
  });

  it('rejects keys that are not identifiers, missing files and partial vectors', () => {
    const { errors } = store.validateParticleEntry('1 bad', { particle: { scale: [1, 1] } });
    expect(errors).toHaveLength(3);
  });

  it('rejects periodicAnimation without a name, and colors outside 0~1', () => {
    const { errors } = store.validateParticleEntry('aModel', {
      file: 'a.glb',
      particle: { periodicAnimation: { intervalSeconds: 10 } },
      color: [2, 0, 0],
    });
    expect(errors).toHaveLength(2);
  });

  it('only warns when animatedIdle and periodicAnimation are both set', () => {
    const r = store.validateParticleEntry('aModel', {
      file: 'a.glb',
      particle: { animation: ['Idle'], animatedIdle: true, periodicAnimation: { name: ['Atk'] } },
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
});

describe('saveParticleConfig', () => {
  it('prunes empty fields and writes the file', () => {
    const file = path.join(tmp, 'sources.json');
    const r = store.saveParticleConfig(
      { models: { aModel: { file: 'a.glb', particle: { scale: [] }, note: '' } }, sequenceHoldSeconds: 3, sequenceTransitionSeconds: 1 },
      file
    );
    expect(r.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).models).toEqual({ aModel: { file: 'a.glb' } });
  });

  it('refuses to write when a sequence entry points at a deleted model', () => {
    const file = path.join(tmp, 'sources.json');
    const r = store.saveParticleConfig({ models: { aModel: { file: 'a.glb' } }, sequenceModels: ['gone'] }, file);
    expect(r.ok).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('accepts the real sources.json as-is', () => {
    const real = store.readParticleConfig();
    expect(store.validateParticleConfig(real).errors).toEqual([]);
  });
});

describe('suggestModelKey', () => {
  it('builds a camelCase key from ascii file names and avoids existing keys', () => {
    expect(store.suggestModelKey('kaido_dragon_form.glb')).toBe('kaidoDragonFormModel');
    expect(store.suggestModelKey('4.glb')).toBe('m4Model');
    expect(store.suggestModelKey('going.glb', ['goingModel'])).toBe('goingModel2');
  });

  it('falls back to modelN when the file name has no ascii letters', () => {
    expect(store.suggestModelKey('亞托克斯.glb', ['model1'])).toBe('model2');
  });
});

describe('listGlbAnimations', () => {
  function writeGlb(file, json) {
    const body = Buffer.from(JSON.stringify(json));
    const padded = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(20);
    header.write('glTF', 0, 'latin1');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(20 + padded.length, 8);
    header.writeUInt32LE(padded.length, 12);
    header.write('JSON', 16, 'latin1');
    fs.writeFileSync(file, Buffer.concat([header, padded]));
  }

  it('reads animation names from the GLB JSON chunk', () => {
    const file = path.join(tmp, 'a.glb');
    writeGlb(file, { asset: { version: '2.0' }, animations: [{ name: 'Idle' }, {}, { name: 'Attack' }] });
    expect(store.listGlbAnimations(file)).toEqual(['Idle', 'animation_1', 'Attack']);
  });

  it('returns an empty list for static models', () => {
    const file = path.join(tmp, 'b.glb');
    writeGlb(file, { asset: { version: '2.0' } });
    expect(store.listGlbAnimations(file)).toEqual([]);
  });
});

describe('importFile', () => {
  it('copies into the destination folder and refuses to overwrite a different file with the same name', () => {
    const src = path.join(tmp, 'src', 'a.glb');
    fs.mkdirSync(path.dirname(src));
    fs.writeFileSync(src, 'x');
    const dest = path.join(tmp, 'models');
    expect(store.importFile(src, dest)).toBe('a.glb');
    expect(fs.readFileSync(path.join(dest, 'a.glb'), 'utf8')).toBe('x');
    expect(store.importFile(path.join(dest, 'a.glb'), dest)).toBe('a.glb'); // 已經在裡面
    expect(() => store.importFile(src, dest)).toThrow(/同名/);
  });
});

describe('importLive2DFolder', () => {
  it('copies the folder and returns manifest-style paths', () => {
    const src = path.join(tmp, 'incoming', 'cat');
    fs.mkdirSync(path.join(src, 'textures'), { recursive: true });
    fs.writeFileSync(path.join(src, 'cat.model3.json'), '{}');
    const modelsDir = path.join(tmp, 'live2d', 'models');
    fs.mkdirSync(modelsDir, { recursive: true });
    expect(store.importLive2DFolder(src, 'cat', modelsDir)).toEqual(['models/cat/cat.model3.json']);
    expect(() => store.importLive2DFolder(src, 'cat', modelsDir)).toThrow(/已經有/);
  });

  it('rejects folders without a model json', () => {
    const src = path.join(tmp, 'empty');
    fs.mkdirSync(src);
    expect(() => store.importLive2DFolder(src, 'x', tmp)).toThrow(/找不到/);
  });
});

describe('normalizeLive2DPatch', () => {
  it('keeps blank layout fields as empty strings and converts override rows to objects', () => {
    const { errors, value } = store.normalizeLive2DPatch({
      layout: { offsetX: '-20', scale: '', headRatio: 0.3, bubbleGrow: 'left' },
      chatSounds: ['  ../a.mp3 ', ''],
      partOverrides: [{ id: 'Part6', value: '0' }, { id: '', value: '1' }],
      paramOverrides: [{ id: 'PARAM_X', value: '-1.5' }],
    });
    expect(errors).toEqual([]);
    expect(value).toEqual({
      layout: { offsetX: -20, offsetY: '', scale: '', headRatio: 0.3, headXRatio: '', bubbleGrow: 'left' },
      chatSounds: ['../a.mp3'],
      partOverrides: { Part6: 0 },
      paramOverrides: { PARAM_X: -1.5 },
    });
  });

  it('reports non-numbers, out-of-range part opacity and duplicates', () => {
    const { errors } = store.normalizeLive2DPatch({
      layout: { scale: 'abc' },
      partOverrides: [{ id: 'P', value: 2 }, { id: 'Q', value: 0 }, { id: 'Q', value: 1 }],
    });
    expect(errors).toHaveLength(3);
  });
});

describe('saveLive2DEntry', () => {
  it('updates only the editable fields and the display name', () => {
    fs.writeFileSync(
      path.join(tmp, 'manifest.json'),
      JSON.stringify([{ id: 3, path: 'models/a/a.model3.json', character: 'a', cubism: 4, layout: {}, chatSounds: [] }])
    );
    fs.writeFileSync(path.join(tmp, 'names.json'), JSON.stringify({ 'models/a/a.model3.json': 'a' }));
    const r = store.saveLive2DEntry('models/a/a.model3.json', { name: '小A', layout: { scale: 1.2 } }, tmp);
    expect(r.ok).toBe(true);
    const [entry] = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
    expect(entry.id).toBe(3);
    expect(entry.layout.scale).toBe(1.2);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'names.json'), 'utf8'))['models/a/a.model3.json']).toBe('小A');
    // generate-manifest.js 寫的檔案沒有檔尾換行，存回去也維持沒有
    expect(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8').endsWith(']')).toBe(true);
  });
});

describe('addLive2DGitignoreException', () => {
  const text = [
    '/live2d_my_like/models/*',
    '',
    '# 例外允許：076',
    '!/live2d_my_like/models/076/',
    '!/live2d_my_like/models/076/**',
    '',
    '# 其他',
    'node_modules/',
    '',
  ].join('\n');

  it('inserts the exception right after the last existing Live2D exception', () => {
    const out = store.addLive2DGitignoreException(text, 'cat');
    const lines = out.split('\n');
    const at = lines.indexOf('!/live2d_my_like/models/cat/');
    expect(at).toBeGreaterThan(lines.indexOf('!/live2d_my_like/models/076/**'));
    expect(at).toBeLessThan(lines.indexOf('# 其他'));
    expect(lines[at + 1]).toBe('!/live2d_my_like/models/cat/**');
    expect(store.gitignoreHasLive2DException(out, 'cat')).toBe(true);
    // 前後都空一行，不跟上下段落黏在一起
    expect(lines[lines.indexOf('!/live2d_my_like/models/076/**') + 1]).toBe('');
    expect(lines[at + 2]).toBe('');
    expect(lines[at + 3]).toBe('# 其他');
  });

  it('appends at the end when there is no Live2D exception yet', () => {
    expect(store.addLive2DGitignoreException('node_modules/\n', 'cat')).toBe(
      'node_modules/\n\n# ==================================================\n# 例外允許：cat\n# ==================================================\n!/live2d_my_like/models/cat/\n!/live2d_my_like/models/cat/**\n'
    );
  });

  it('does nothing when the exception already exists, and keeps CRLF line endings', () => {
    expect(store.addLive2DGitignoreException(text, '076')).toBe(text);
    const crlf = text.replace(/\n/g, '\r\n');
    expect(store.addLive2DGitignoreException(crlf, 'cat')).not.toMatch(/[^\r]\n/);
  });
});
