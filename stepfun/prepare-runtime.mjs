import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const source = dirname(require.resolve('@huggingface/transformers'));
await mkdir(new URL('./public/runtime/', import.meta.url), { recursive: true });
for (const file of await readdir(source)) {
  if (/^ort-wasm.*\.(mjs|wasm)$/.test(file)) await copyFile(resolve(source, file), new URL('./public/runtime/' + file, import.meta.url));
}
