// Regression shots of the "Where to stand" and documented-sighting presets,
// clicked through the real UI and captured once converged. Compare
// 04-highsmith.png with the Library of Congress photo shown in its inset.
//   node tools/shoot_presets.mjs <outdir>        (dev server on :5173)
import puppeteer from "puppeteer-core";
const SP = process.argv[2];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: [...(process.platform === "darwin" ? ["--use-angle=metal"] : [])] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
const logs = []; page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning" || m.text().includes("BVH")) logs.push(m.type() + " " + m.text()); }); page.on("pageerror", (e) => logs.push("pageerror " + e.message));
await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.sunLab?.ready(), { timeout: 120000 });
const conv = () => page.waitForFunction(() => window.sunLab.converged(), { timeout: 240000, polling: 250 });
const shots = [
  ["01-default", null],
  ["02-front", '.camera-preset[data-camera="front"]'],
  ["03-pocket", '.camera-preset[data-camera="pocket"]'],
  ["03b-overview", '.camera-preset[data-camera="overview"]'],
  ["04-highsmith", '.preset[data-photo="1"]'],
  ["05-elonka", '.preset[data-date="2002-10-18"]'],
  ["06-top", '.camera-preset[data-camera="top"]'],
];
for (const [name, sel] of shots) {
  if (sel) { await page.click(sel); await new Promise((r) => setTimeout(r, 300)); }
  await conv();
  await page.screenshot({ path: `${SP}/${name}.png` });
}
// stencil close-up (front, low on the ciphertext)
await page.evaluate(() => window.sunLab.set({ view: "perspective", camera: { position: [60, 40, 75], target: [20, 35, 25] } }));
await conv(); await page.screenshot({ path: `${SP}/07-closeup.png` });
console.log(logs.join("\n"));
console.log("exposure at end:", await page.evaluate(() => window.sunLab.exposure()));
await browser.close();
