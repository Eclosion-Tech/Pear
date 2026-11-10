import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const target = 'wasm32-unknown-unknown';
const flags = ['build', '--locked', '--release', '--target', target];
const digest = data => createHash('sha256').update(data).digest('hex');
const moduleHeader = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const isModule = bytes => bytes.length >= 8 && bytes.subarray(0, 8).equals(moduleHeader);
const command = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });

export function fingerprint(inputs) { return digest(JSON.stringify(inputs)); }
export function toolchainFingerprint(env = process.env) {
  // Builds run in an isolated archive under tmpdir(), so only its ancestors
  // and CARGO_HOME can supply Cargo configuration. Hash contents, never log it.
  const roots = new Set([env.CARGO_HOME || join(homedir(), '.cargo')]);
  for (let dir = resolve(tmpdir()); ; dir = dirname(dir)) {
    roots.add(join(dir, '.cargo'));
    if (dir === dirname(dir)) break;
  }
  const configuration = [...roots].flatMap(root => ['config', 'config.toml'].map(name => {
    const path = join(root, name);
    return [path, existsSync(path) ? digest(readFileSync(path)) : null];
  }));
  return fingerprint({
    format: 1, platform: process.platform, arch: process.arch, flags,
    rustc: command('rustc', ['-vV'], { env }), cargo: command('cargo', ['--version'], { env }),
    environment: Object.entries(env).filter(([key]) => /^(RUST|CARGO)/.test(key) && key !== 'CARGO_TARGET_DIR').sort(([a], [b]) => a.localeCompare(b)),
    configuration, helper: digest(readFileSync(fileURLToPath(import.meta.url))),
  });
}

export function buildBaseline({ revision, output, pearRoot = '.', cacheDir = process.env.PEAR_PROTECTED_MAIL_BASELINE_CACHE, env = process.env }) {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw Error('Expected a full historical commit ID');
  const source = resolve(pearRoot);
  const destination = resolve(output);
  // Arbitrary compiler wrappers can change without their path changing. Build
  // from source rather than caching under an ambiguous compiler identity.
  if (['RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER'].some(name => env[name])) cacheDir = undefined;
  const key = fingerprint({ revision, toolchain: toolchainFingerprint(env) });
  const entry = cacheDir ? join(resolve(cacheDir), key) : undefined;
  if (entry) {
    try {
      const receipt = JSON.parse(readFileSync(join(entry, 'receipt.json'), 'utf8'));
      const bytes = readFileSync(join(entry, 'server.wasm'));
      if (receipt.key === key && receipt.revision === revision && receipt.sha256 === digest(bytes) && isModule(bytes)) {
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(entry, 'server.wasm'), destination);
        console.log(`HIT protected_mail_baseline revision=${revision}`);
        return 'hit';
      }
    } catch { /* A missing or invalid cache is a cold build, never a skipped fixture. */ }
  }
  console.log(`BUILD protected_mail_baseline revision=${revision}`);
  try { command('git', ['-C', source, 'cat-file', '-e', `${revision}:server/spacetimedb/Cargo.toml`]); }
  catch { command('git', ['-C', source, 'fetch', '--no-tags', '--depth=1', 'origin', revision]); }
  const temporary = mkdtempSync(join(tmpdir(), 'pear-mail-baseline-'));
  try {
    const archive = command('git', ['-C', source, 'archive', revision, 'server/spacetimedb'], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
    command('tar', ['-xf', '-', '-C', temporary], { input: archive, stdio: ['pipe', 'inherit', 'inherit'] });
    const crate = join(temporary, 'server/spacetimedb');
    const buildTarget = join(temporary, 'target');
    command('cargo', [...flags, '--manifest-path', join(crate, 'Cargo.toml')], {
      cwd: crate, env: { ...env, CARGO_TARGET_DIR: buildTarget }, stdio: 'inherit',
    });
    const wasm = join(buildTarget, target, 'release/server.wasm');
    const bytes = readFileSync(wasm);
    if (!isModule(bytes)) throw Error('Historical build did not produce a WASM module');
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(wasm, destination);
    if (entry) {
      mkdirSync(dirname(entry), { recursive: true });
      const staging = mkdtempSync(join(dirname(entry), '.writing-'));
      try {
        copyFileSync(wasm, join(staging, 'server.wasm'));
        writeFileSync(join(staging, 'receipt.json'), JSON.stringify({ key, revision, sha256: digest(bytes) }) + '\n');
        rmSync(entry, { recursive: true, force: true });
        renameSync(staging, entry);
      } finally { rmSync(staging, { recursive: true, force: true }); }
    }
    return 'built';
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--cache-key') console.log(toolchainFingerprint());
  else buildBaseline({ revision: process.argv[2], output: process.argv[3] });
}
