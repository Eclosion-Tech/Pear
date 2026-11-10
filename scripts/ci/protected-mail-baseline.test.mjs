import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildBaseline, toolchainFingerprint } from './build-protected-mail-baseline.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pear-baseline-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const executable = (name, source) => writeFileSync(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  executable('rustc', 'console.log(process.env.FAKE_RUSTC_VERSION || "fixture rustc 1");');
  executable('cargo', `
    const fs = require('node:fs'), path = require('node:path');
    if (process.argv.includes('--version')) { console.log('fixture cargo 1'); process.exit(0); }
    fs.appendFileSync(process.env.FAKE_BUILD_LOG, process.env.CARGO_TARGET_DIR + '\\n');
    if (process.env.FAKE_BUILD_FAIL) process.exit(1);
    const manifest = process.argv[process.argv.indexOf('--manifest-path') + 1];
    const dir = path.join(process.env.CARGO_TARGET_DIR, 'wasm32-unknown-unknown/release');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'server.wasm'), Buffer.concat([Buffer.from([0,97,115,109,1,0,0,0]), fs.readFileSync(manifest)]));
  `);
  const pearRoot = join(root, 'pear'); mkdirSync(join(pearRoot, 'server/spacetimedb'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', pearRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'CI test'); git('config', 'user.email', 'ci@example.invalid'); git('config', 'commit.gpgsign', 'false');
  const revision = content => {
    writeFileSync(join(pearRoot, 'server/spacetimedb/Cargo.toml'), content);
    git('add', '-A'); git('commit', '-qm', 'historical fixture'); return git('rev-parse', 'HEAD');
  };
  const first = revision('first historical source');
  const second = revision('second historical source');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CARGO_HOME: join(root, 'cargo-home'), FAKE_BUILD_LOG: join(root, 'builds') };
  for (const key of ['RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS']) delete env[key];
  const cacheDir = join(root, 'cache');
  return { root, env, first, second, cacheDir,
    options: { revision: first, output: join(root, 'result.wasm'), pearRoot, cacheDir, env },
    builds: () => existsSync(env.FAKE_BUILD_LOG) ? readFileSync(env.FAKE_BUILD_LOG, 'utf8').trim().split('\n') : [],
  };
}

test('cold build then warm hit avoids compilation and preserves exact bytes', t => {
  const f = fixture(t);
  assert.equal(buildBaseline(f.options), 'built');
  const cold = readFileSync(f.options.output);
  rmSync(f.options.output);
  assert.equal(buildBaseline(f.options), 'hit');
  assert.deepEqual(readFileSync(f.options.output), cold);
  assert.equal(f.builds().length, 1);
  assert.equal(existsSync(f.builds()[0]), false, 'isolated build directory is removed');
});
test('different historical commits never share a build directory or artifact', t => {
  const f = fixture(t);
  buildBaseline(f.options); const first = readFileSync(f.options.output);
  assert.equal(buildBaseline({ ...f.options, revision: f.second }), 'built');
  assert.notDeepEqual(readFileSync(f.options.output), first);
  assert.equal(new Set(f.builds()).size, 2);
});
test('compiler version, flags and Cargo configuration changes invalidate cache', t => {
  const f = fixture(t); buildBaseline(f.options);
  assert.equal(buildBaseline({ ...f.options, env: { ...f.env, FAKE_RUSTC_VERSION: 'fixture rustc 2' } }), 'built');
  assert.equal(buildBaseline({ ...f.options, env: { ...f.env, RUSTFLAGS: '-C opt-level=2' } }), 'built');
  mkdirSync(f.env.CARGO_HOME);
  const before = toolchainFingerprint(f.env);
  writeFileSync(join(f.env.CARGO_HOME, 'config.toml'), '[net]\noffline = true\n');
  assert.notEqual(toolchainFingerprint(f.env), before);
  assert.equal(buildBaseline(f.options), 'built');
  assert.equal(f.builds().length, 4);
});
test('corrupt module or receipt rebuilds rather than using stale bytes', t => {
  const f = fixture(t); buildBaseline(f.options);
  const entry = join(f.cacheDir, readdirSync(f.cacheDir)[0]);
  writeFileSync(join(entry, 'server.wasm'), 'corrupt');
  assert.equal(buildBaseline(f.options), 'built');
  writeFileSync(join(entry, 'receipt.json'), '{}');
  assert.equal(buildBaseline(f.options), 'built');
  assert.equal(buildBaseline(f.options), 'hit');
  assert.equal(f.builds().length, 3);
});
test('no cache or custom compiler wrapper always builds independently', t => {
  const f = fixture(t);
  buildBaseline({ ...f.options, cacheDir: null });
  buildBaseline({ ...f.options, cacheDir: null });
  const env = { ...f.env, RUSTC_WRAPPER: '/custom/compiler-wrapper' };
  buildBaseline({ ...f.options, env }); buildBaseline({ ...f.options, env });
  assert.equal(f.builds().length, 4);
  assert.equal(existsSync(f.cacheDir), false);
});
test('failed build publishes no output or cache entry and cleans its target', t => {
  const f = fixture(t);
  assert.throws(() => buildBaseline({ ...f.options, env: { ...f.env, FAKE_BUILD_FAIL: '1' } }));
  assert.equal(existsSync(f.options.output), false);
  assert.equal(existsSync(f.cacheDir), false);
  assert.equal(existsSync(f.builds()[0]), false);
});
