import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output';
const PROGRESS_FILE = path.join(OUTPUT_DIR, '.progress.json');

let _cache = null;

function defaultProgress() {
  return {
    pendaftaran: { cursor: null, completedCount: 0, lastUpdated: null },
    kunjungan:   { cursor: null, completedCount: 0, lastUpdated: null },
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadProgress() {
  if (_cache) return _cache;

  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const raw = fs.readFileSync(PROGRESS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      _cache = { ...defaultProgress(), ...data };
      return _cache;
    }
  } catch {
    // corrupt file, reset
  }

  _cache = defaultProgress();
  return _cache;
}

export function saveProgress(data) {
  ensureDir(path.dirname(PROGRESS_FILE));

  const toSave = {
    pendaftaran: data.pendaftaran || _cache?.pendaftaran || defaultProgress().pendaftaran,
    kunjungan: data.kunjungan || _cache?.kunjungan || defaultProgress().kunjungan,
  };

  toSave.pendaftaran.lastUpdated = new Date().toISOString();
  toSave.kunjungan.lastUpdated = new Date().toISOString();

  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  _cache = toSave;
  return toSave;
}

export function updatePendaftaranProgress(year, month) {
  const prog = loadProgress();
  prog.pendaftaran.cursor = { year, month };
  prog.pendaftaran.completedCount = (prog.pendaftaran.completedCount || 0) + 1;
  return saveProgress(prog);
}

export function updateKunjunganProgress(year, month, day) {
  const prog = loadProgress();
  prog.kunjungan.cursor = { year, month, day };
  prog.kunjungan.completedCount = (prog.kunjungan.completedCount || 0) + 1;
  return saveProgress(prog);
}

export function getProgress() {
  return loadProgress();
}

export function resetProgress(mode) {
  const prog = loadProgress();
  if (mode === 'pendaftaran' || mode === 'all') {
    prog.pendaftaran = { cursor: null, completedCount: 0, lastUpdated: null };
  }
  if (mode === 'kunjungan' || mode === 'all') {
    prog.kunjungan = { cursor: null, completedCount: 0, lastUpdated: null };
  }
  return saveProgress(prog);
}
