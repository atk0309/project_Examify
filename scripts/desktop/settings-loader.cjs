// Fail closed before reading configuration, including when loaded independently.
require('./worker-guard.cjs');
// Load only user-selected AI settings after exec, so env-store can rotate them.
// Never import the shell's provider credentials or runtime security settings.
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const keys = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'EXAMIFY_ANTHROPIC_MODEL',
  'EXAMIFY_OPENAI_MODEL',
  'EXAMIFY_LLM_BASE_URL',
  'EXAMIFY_LLM_MODEL',
  'EXAMIFY_CLAUDE_MODEL',
  'EXAMIFY_CODEX_MODEL',
]);
if (process.env.EXAMIFY_MODE !== 'solo' || !path.isAbsolute(process.env.EXAMIFY_CONFIG_DIR || '')) {
  throw new Error('The solo settings loader requires its launcher.');
}
const saved = {};
for (const name of ['.env', '.env.local']) {
  const file = path.join(process.env.EXAMIFY_CONFIG_DIR, name);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error('Unsafe solo settings file.');
    if (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077))
      throw new Error('Solo settings must be private to their owner.');
    for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) {
      if (keys.has(key)) saved[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not safely load private solo settings.');
  }
}

for (const [key, value] of Object.entries(saved)) {
  if (process.env[key] === undefined) process.env[key] = value;
}
