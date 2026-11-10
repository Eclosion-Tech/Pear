import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function assertMatchingBindings(left, right) {
  const names = async directory => (await readdir(directory)).filter(name => name.endsWith('.ts')).sort();
  const files = await names(left);
  assert.ok(files.length, 'No generated bindings found');
  assert.deepEqual(await names(right), files, 'Web/worker generated binding file sets differ');
  for (const file of files) assert.deepEqual(await readFile(resolve(left, file)), await readFile(resolve(right, file)), `Binding differs: ${file}`);
  return files.length;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const count = await assertMatchingBindings(resolve(root, 'web/src/module_bindings'), resolve(root, 'worker/src/module_bindings'));
  console.log(`PASS matching_bindings files=${count}`);
}
