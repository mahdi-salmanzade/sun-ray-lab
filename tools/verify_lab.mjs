// Drive the lab headlessly and dump its linear-radiance buffer for one
// Read-mode window, point sun and true sun. Pairs with verify_cycles.py.
//
//   node tools/verify_lab.mjs <url> <outprefix> <az> <el> [window] [cx cz]
//
// Prints the Blender-space centre and span to hand to verify_cycles.py.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const [url, out, az, el, win = "30", cx, cz] = process.argv.slice(2);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: [...(process.platform === "darwin" ? ["--use-angle=metal"] : []), "--ignore-gpu-blocklist", "--window-size=1600,1000"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto(url, { waitUntil: "networkidle0", timeout: 120000 });
await page.waitForFunction(() => window.sunLab?.ready(), { timeout: 120000 });

const meta = {};
for (const trueSun of [false, true]) {
  await page.evaluate(
    (o) => window.sunLab.set(o),
    {
      view: "readable",
      azimuth: Number(az),
      elevation: Number(el),
      trueSun,
      skyFill: 0,
      bounce: false,
      isolate: true,
      window: Number(win),
      ...(cx !== undefined ? { center: { x: Number(cx), z: Number(cz) } } : {}),
    },
  );
  await page.waitForFunction(() => window.sunLab.converged(), { timeout: 300000, polling: 200 });
  const res = await page.evaluate(() => {
    const { width, height, data } = window.sunLab.readLinear();
    const lum = new Float32Array(width * height);
    // Flip: GL rows are bottom-up.
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = ((height - 1 - y) * width + x) * 4;
        lum[y * width + x] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      }
    const bytes = new Uint8Array(lum.buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const s = window.sunLab.state;
    return {
      width,
      height,
      b64: btoa(bin),
      center: s.center,
      window: s.window,
      offset: window.sunLab.modelOffset(),
      samples: window.sunLab.samples(),
    };
  });
  const tag = trueSun ? "real" : "point";
  writeFileSync(`${out}_lab_${tag}.f32`, Buffer.from(res.b64, "base64"));
  Object.assign(meta, { width: res.width, height: res.height, center: res.center, window: res.window, offset: res.offset });
  meta[`samples_${tag}`] = res.samples;
}

// Lab world (yaw 0) -> gltf -> Blender: blender = (x - ox, -(z - oz), y - oy)
const [ox, , oz] = meta.offset;
meta.blender = { cx: meta.center.x - ox, cy: -(meta.center.z - oz) };
writeFileSync(`${out}_lab.json`, JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta));
await browser.close();
