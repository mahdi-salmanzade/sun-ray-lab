import { copyFile, mkdir, access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicDir = path.join(root, 'public');
const exists = async (file) => access(file).then(() => true, () => false);
await mkdir(path.join(publicDir, 'draco'), { recursive: true });
await mkdir(path.join(publicDir, 'licenses'), { recursive: true });
for (const name of ['three', 'three-mesh-bvh', 'draco']) {
  await copyFile(path.join(root, 'docs/licenses', `${name}.txt`), path.join(publicDir, 'licenses', `${name}.txt`));
}
await copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(publicDir, 'licenses/THIRD_PARTY_NOTICES.md'));
for (const name of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']) {
  await copyFile(path.join(root, 'node_modules/three/examples/jsm/libs/draco/gltf', name), path.join(publicDir, 'draco', name));
}
// Always emit a manifest, including on a fresh clone. No absent-asset requests
// or fallback HTML can be mistaken for a GLB.
const screens = [];
for (const [key, name] of [['rebuilt','kryptos_screen.glb'], ['thin','kryptos_thin.glb'], ['original','kryptos.glb']]) {
  if (await exists(path.join(publicDir, name))) screens.push(key);
}
await writeFile(path.join(publicDir, 'local-assets.json'), JSON.stringify({
  screens,
  layout: await exists(path.join(publicDir, 'kryptos_screen_layout.json')),
  referencePhoto: await exists(path.join(publicDir, 'reference/highsmith_kryptos_loc2011631531.jpg')),
}, null, 2) + '\n');
console.log(`Assets ready: open demo${screens.length ? ` + ${screens.join(', ')}` : ''}.`);
