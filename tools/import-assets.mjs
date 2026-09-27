import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = process.argv[2];
if (!directory) {
  console.error('Usage: npm run assets:import -- /path/to/existing/sun-ray-lab/public');
  process.exit(1);
}
const source = path.resolve(directory);
const destination = fileURLToPath(new URL('../public/', import.meta.url));
if (source === path.resolve(destination)) throw new Error('Choose an external source directory.');
if (!(await stat(source)).isDirectory()) throw new Error('Source must be a directory.');
const names = ['kryptos_screen.glb', 'kryptos_thin.glb', 'kryptos.glb', 'kryptos_screen_layout.json', 'reference/highsmith_kryptos_loc2011631531.jpg'];
let copied = 0;
for (const name of names) {
  const from = path.join(source, name);
  const present = await stat(from).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!present?.isFile()) continue;
  if (name.endsWith('.glb')) {
    const bytes = await readFile(from);
    if (bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${name} is not a GLB.`);
  } else if (name.endsWith('.json')) {
    const layout = JSON.parse(await readFile(from, 'utf8'));
    if (!Array.isArray(layout.glyphs) || !Array.isArray(layout.curve?.s)) throw new Error('Invalid screen layout.');
  }
  const to = path.join(destination, name);
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
  console.log(`Imported locally: ${name}`);
  copied++;
}
if (!copied) throw new Error('No supported model assets found in that directory.');
await import('./prepare-assets.mjs');
console.log('These assets remain local and git-ignored. Their original redistribution terms still apply.');
