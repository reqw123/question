import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  findMissingModelFiles,
  formatMissingReport,
  live2dReferencedFiles,
  checkLive2DEntry,
  formatLive2DReport,
} from './asset-check.js';

const MODELS_DIR = path.join('X:', 'models');
const sources = {
  aModel: { file: 'a.glb' },
  bModel: { file: 'b.glb' },
  cModel: { file: 'c.glb' },
};
const existsOnly = (...files) => (p) => files.some((f) => p === path.join(MODELS_DIR, f));

describe('findMissingModelFiles', () => {
  it('lists the sources whose GLB is not on disk, in sources.json order', () => {
    const missing = findMissingModelFiles(sources, MODELS_DIR, existsOnly('b.glb'));

    expect(missing).toEqual([
      { key: 'aModel', file: 'a.glb' },
      { key: 'cModel', file: 'c.glb' },
    ]);
  });

  it('returns an empty list when every file exists', () => {
    expect(findMissingModelFiles(sources, MODELS_DIR, () => true)).toEqual([]);
  });

  it('ignores entries without a file field and tolerates missing sources', () => {
    expect(findMissingModelFiles({ broken: {}, nothing: null }, MODELS_DIR, () => false)).toEqual([]);
    expect(findMissingModelFiles(undefined, MODELS_DIR, () => false)).toEqual([]);
  });
});

describe('formatMissingReport', () => {
  it('is empty when nothing is missing', () => {
    expect(formatMissingReport([], 3, MODELS_DIR)).toBe('');
  });

  it('names each missing file and where to put it', () => {
    const report = formatMissingReport([{ key: 'aModel', file: 'a.glb' }], 3, MODELS_DIR);

    expect(report).toContain('1/3');
    expect(report).toContain('a.glb');
    expect(report).toContain('aModel');
    expect(report).toContain(MODELS_DIR);
  });

  it('says none were found when every model is missing', () => {
    const missing = Object.entries(sources).map(([key, s]) => ({ key, file: s.file }));

    expect(formatMissingReport(missing, 3, MODELS_DIR)).toContain('一個都找不到');
  });
});

const L2D_ROOT = path.join('X:', 'live2d');
const model3 = {
  FileReferences: {
    Moc: 'm.moc3',
    Textures: ['t/0.png', 't/1.png'],
    Physics: 'm.physics3.json',
    Motions: { Idle: [{ File: 'mo/idle.motion3.json', Sound: 's/idle.wav' }] },
    Expressions: [{ Name: 'smile', File: 'ex/smile.exp3.json' }],
  },
};
const fakeFs = (files, json = model3) => ({
  exists: (p) => files.includes(path.relative(L2D_ROOT, p).split(path.sep).join('/')),
  readJson: () => json,
});
const entry = { id: 3, path: 'models/m/m.model3.json', character: 'm' };
const allFiles = [
  'models/m/m.model3.json', 'models/m/m.moc3', 'models/m/t/0.png', 'models/m/t/1.png',
  'models/m/m.physics3.json', 'models/m/mo/idle.motion3.json', 'models/m/s/idle.wav', 'models/m/ex/smile.exp3.json',
];

describe('live2dReferencedFiles', () => {
  it('splits Cubism 3/4 references into required (moc, textures) and optional', () => {
    expect(live2dReferencedFiles(model3)).toEqual({
      required: ['m.moc3', 't/0.png', 't/1.png'],
      optional: ['m.physics3.json', 'mo/idle.motion3.json', 's/idle.wav', 'ex/smile.exp3.json'],
    });
  });

  it('understands the Cubism 2 model.json layout', () => {
    const cubism2 = { model: 'm.moc', textures: ['t.png'], physics: 'p.json', motions: { idle: [{ file: 'a.mtn' }] } };

    expect(live2dReferencedFiles(cubism2)).toEqual({ required: ['m.moc', 't.png'], optional: ['p.json', 'a.mtn'] });
  });
});

describe('checkLive2DEntry', () => {
  it('reports nothing wrong when every referenced file exists', () => {
    const r = checkLive2DEntry(entry, L2D_ROOT, fakeFs(allFiles));

    expect(r.fatal).toBeNull();
    expect(r.missingRequired).toEqual([]);
    expect(r.missingOptional).toEqual([]);
    expect(r.files).toHaveLength(allFiles.length);
  });

  it('is fatal when the model json itself is missing (whole model not in the repo)', () => {
    expect(checkLive2DEntry(entry, L2D_ROOT, fakeFs([])).fatal).toBe('model-json');
  });

  it('is fatal when a texture is missing, because the model cannot load at all', () => {
    const r = checkLive2DEntry(entry, L2D_ROOT, fakeFs(allFiles.filter((f) => !f.endsWith('1.png'))));

    expect(r.fatal).toBe('required');
    expect(r.missingRequired).toEqual(['t/1.png']);
  });

  it('only warns when motions or physics are missing, the model still shows', () => {
    const r = checkLive2DEntry(entry, L2D_ROOT, fakeFs(allFiles.filter((f) => !f.includes('motion'))));

    expect(r.fatal).toBeNull();
    expect(r.missingOptional).toEqual(['mo/idle.motion3.json']);
  });

  it('is fatal when the model json cannot be parsed', () => {
    const broken = { exists: () => true, readJson: () => { throw new SyntaxError('bad'); } };

    expect(checkLive2DEntry(entry, L2D_ROOT, broken).fatal).toBe('bad-json');
  });
});

describe('formatLive2DReport', () => {
  it('is empty when every character is complete', () => {
    expect(formatLive2DReport([checkLive2DEntry(entry, L2D_ROOT, fakeFs(allFiles))], {}, L2D_ROOT)).toBe('');
  });

  it('uses the display name and separates broken from partially missing characters', () => {
    const broken = checkLive2DEntry(entry, L2D_ROOT, fakeFs([]));
    const partial = checkLive2DEntry({ ...entry, id: 4 }, L2D_ROOT, fakeFs(allFiles.filter((f) => !f.includes('motion'))));
    const report = formatLive2DReport([broken, partial], { [entry.path]: '小明' }, L2D_ROOT);

    expect(report).toContain('2/2');
    expect(report).toContain('其中 1 個無法顯示');
    expect(report).toContain('✖ #3 小明');
    expect(report).toContain('△ #4 小明');
  });
});
