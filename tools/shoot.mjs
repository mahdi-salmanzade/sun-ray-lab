// Drive the real Chrome against the dev server and capture what actually renders.
// Usage: node tools/shoot.mjs <url> <outdir>
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const out = process.argv[3] ?? "/tmp/sunlab";
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: [
    ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    "--window-size=1600,1000",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: "networkidle0", timeout: 120000 });

await page
  .waitForFunction(() => window.sunLab?.ready(), { timeout: 120000 })
  .catch(() => logs.push("[warn] model never became ready"));

// The renderer is progressive: wait for the solar-disc accumulation to
// converge rather than guessing a delay.
const settle = async () => {
  await new Promise((r) => setTimeout(r, 300));
  await page
    .waitForFunction(() => window.sunLab.converged(), { timeout: 120000, polling: 200 })
    .catch(() => logs.push("[warn] never converged"));
};
await settle();

const shots = [
  ["01-perspective", null],
  ["02-top", "#view-top"],
  ["03-read", "#view-readable"],
];
for (const [name, sel] of shots) {
  if (sel) {
    await page.click(sel);
    await settle();
  }
  await page.screenshot({ path: `${out}/${name}.png` });
}

// Zoom the read window down to letter scale and shoot again.
for (const w of [30, 12]) {
  await page.evaluate((v) => window.sunLab.set({ window: v }), w);
  await settle();
  await page.screenshot({ path: `${out}/04-read-window-${w}.png` });
}

const diag = await page.evaluate(() => {
  const c = document.querySelector("#viewport canvas");
  const gl = c?.getContext("webgl2") || c?.getContext("webgl");
  return {
    probe: document.querySelector("#probe-body")?.textContent.replace(/\s+/g, " ").trim(),
    canvas: c ? `${c.width}x${c.height}` : "none",
    maxTexture: gl?.getParameter(gl.MAX_TEXTURE_SIZE),
    renderer: gl?.getExtension("WEBGL_debug_renderer_info")
      ? gl.getParameter(
          gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL,
        )
      : "n/a",
    glErrors: gl ? gl.getError() : "no gl",
  };
});

console.log(JSON.stringify({ diag, logs }, null, 2));
await browser.close();
