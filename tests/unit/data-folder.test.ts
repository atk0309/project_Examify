import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATA_DIR_MARKER, UnsafeDataDirError } from '@/lib/data-dir';
import {
  initDataFolder,
  isDedicatedDataFolder,
  SharedDataFolderError,
  UNREADABLE_DATA_FOLDER_MESSAGE,
} from '@/lib/data-folder';

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

  it('adopts an older unmarked ./data that holds only Examify files', () => {
    const dataDir = path.join(tempParent(), 'data');
    mkdirSync(path.join(dataDir, 'outbox'), { recursive: true });
    for (const name of ['app.db', 'app.db-wal', 'app.db-shm', '.DS_Store']) {
      writeFileSync(path.join(dataDir, name), '');
    }
    expect(initDataFolder({ dataDir })).toEqual({ created: false });
    expect(mode(dataDir)).toBe(0o700);
  });

  it('accepts a custom database file name from DATABASE_URL in the folder', () => {
    const dataDir = path.join(tempParent(), 'volume');
    mkdirSync(dataDir);
    writeFileSync(path.join(dataDir, 'examify.sqlite'), '');
    writeFileSync(path.join(dataDir, 'examify.sqlite-wal'), '');
    expect(initDataFolder({ dataDir, dbPath: path.join(dataDir, 'examify.sqlite') })).toEqual({
      created: false,
    });
  });

  it('refuses a shared folder without chmodding or writing anything', () => {
    const dataDir = path.join(tempParent(), 'lib');
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o755);
    writeFileSync(path.join(dataDir, 'app.db'), '');
    writeFileSync(path.join(dataDir, 'dpkg.status'), 'someone else');
    expect(() => initDataFolder({ dataDir, dbPath: path.join(dataDir, 'app.db') })).toThrow(
      SharedDataFolderError,
    );
    expect(mode(dataDir)).toBe(0o755);
    expect(() => statSync(path.join(dataDir, DATA_DIR_MARKER))).toThrow();
    expect(() => statSync(path.join(dataDir, '.gitignore'))).toThrow();
  });

  it('trusts a marked folder whatever else it holds', () => {
    const dataDir = path.join(tempParent(), 'data');
    mkdirSync(dataDir);
    writeFileSync(path.join(dataDir, DATA_DIR_MARKER), '{"layout":1}');
    writeFileSync(path.join(dataDir, 'notes.txt'), 'mine');
    expect(initDataFolder({ dataDir })).toEqual({ created: false });
  });

  function unusable(run: () => unknown): UnsafeDataDirError {
    try {
      run();
    } catch (error) {
      if (error instanceof UnsafeDataDirError) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  }

  it('refuses a data folder path that is a file, without naming it', () => {
    const file = path.join(tempParent(), 'secret-family-file');
    writeFileSync(file, 'not a folder');
    for (const run of [
      () => initDataFolder({ dataDir: file }),
      () => isDedicatedDataFolder(file),
      // A DATABASE_URL-derived folder: the "folder" of <file>/app.db is the file.
      () => isDedicatedDataFolder(file, path.join(file, 'app.db')),
    ]) {
      const error = unusable(run);
      expect(error.reason).toBe('unreadable');
      expect(error.message).toBe(UNREADABLE_DATA_FOLDER_MESSAGE);
      expect(error.message).not.toContain('secret-family-file');
    }
    expect(readFileSync(file, 'utf8')).toBe('not a folder');
  });

  it('refuses a folder it cannot reach instead of treating it as not created yet', () => {
    // existsSync() says false for ELOOP / ENOTDIR (and EACCES), exactly as for ENOENT.
    const parent = tempParent();
    const loop = path.join(parent, 'loop');
    symlinkSync(loop, loop);
    const file = path.join(parent, 'secret-family-file');
    writeFileSync(file, 'not a folder');
    for (const dataDir of [loop, path.join(loop, 'data'), path.join(file, 'data')]) {
      for (const run of [() => isDedicatedDataFolder(dataDir), () => initDataFolder({ dataDir })]) {
        const error = unusable(run);
        expect(error.reason).toBe('unreadable');
        expect(error.message).not.toContain(parent);
      }
    }
    // A folder that simply does not exist yet is still fine.
    expect(isDedicatedDataFolder(path.join(parent, 'not-yet', 'data'))).toBe(true);
  });

  // Permissions don't bite root (the sandbox and CI containers often run as root).
  it.skipIf(process.getuid?.() === 0)('refuses a folder below a parent it cannot enter', () => {
    const parent = path.join(tempParent(), 'locked');
    mkdirSync(parent);
    chmodSync(parent, 0o000);
    try {
      const error = unusable(() => isDedicatedDataFolder(path.join(parent, 'data')));
      expect(error.reason).toBe('unreadable');
      expect(error.message).not.toContain(parent);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  it.skipIf(process.getuid?.() === 0)('refuses a folder this user cannot read', () => {
    const dataDir = path.join(tempParent(), 'locked');
    mkdirSync(dataDir);
    writeFileSync(path.join(dataDir, 'someone.txt'), 'x');
    chmodSync(dataDir, 0o000);
    try {
      const error = unusable(() => isDedicatedDataFolder(dataDir));
      expect(error.reason).toBe('unreadable');
      expect(error.message).not.toContain(dataDir);
    } finally {
      chmodSync(dataDir, 0o700);
    }
  });
});
