import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATA_DIR_MARKER } from '@/lib/data-dir';
import { initDataFolder } from '@/lib/data-folder';

const temps: string[] = [];

function tempParent(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'examify-data-folder-'));
  temps.push(dir);
  return dir;
}

const mode = (file: string) => statSync(file).mode & 0o777;

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('initDataFolder', () => {
  it('creates the folder 0700 with a .gitignore and a 0600 marker', () => {
    const dataDir = path.join(tempParent(), 'family', 'data');
    const now = new Date('2026-01-02T03:04:05.000Z');
    expect(initDataFolder({ dataDir }, { now: () => now })).toEqual({ created: true });
    expect(mode(dataDir)).toBe(0o700);
    expect(readFileSync(path.join(dataDir, '.gitignore'), 'utf8')).toBe('*\n');
    const markerPath = path.join(dataDir, DATA_DIR_MARKER);
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual({
      layout: 1,
      createdAt: '2026-01-02T03:04:05.000Z',
      migrations: [],
    });
    expect(mode(markerPath)).toBe(0o600);
  });

  it('is idempotent and never clobbers an existing marker or .gitignore', () => {
    const dataDir = path.join(tempParent(), 'data');
    mkdirSync(dataDir);
    const marker = JSON.stringify({ layout: 1, createdAt: 'earlier', migrations: [{ id: 'x' }] });
    writeFileSync(path.join(dataDir, DATA_DIR_MARKER), marker);
    writeFileSync(path.join(dataDir, '.gitignore'), '*\n!keep\n');
    expect(initDataFolder({ dataDir })).toEqual({ created: false });
    expect(initDataFolder({ dataDir })).toEqual({ created: false });
    expect(readFileSync(path.join(dataDir, DATA_DIR_MARKER), 'utf8')).toBe(marker);
    expect(readFileSync(path.join(dataDir, '.gitignore'), 'utf8')).toBe('*\n!keep\n');
  });

  it('tightens an existing folder this user owns to 0700', () => {
    const dataDir = path.join(tempParent(), 'data');
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o755);
    initDataFolder({ dataDir });
    expect(mode(dataDir)).toBe(0o700);
  });

  it.runIf(typeof process.getuid === 'function')(
    'warns (without the path) and leaves permissions alone when another user owns it',
    () => {
      const dataDir = path.join(tempParent(), 'data');
      mkdirSync(dataDir);
      chmodSync(dataDir, 0o755);
      const owner = statSync(dataDir).uid;
      vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
      const warnings: string[] = [];
      initDataFolder({ dataDir }, { warn: (line) => warnings.push(line) });
      expect(mode(dataDir)).toBe(0o755);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('another user');
      expect(warnings[0]).not.toContain(dataDir);
    },
  );

  it('fails when the data folder path is a file', () => {
    const file = path.join(tempParent(), 'data');
    writeFileSync(file, 'not a folder');
    expect(() => initDataFolder({ dataDir: file })).toThrow();
  });
});
