# Contributing

Use Node.js 22.12 or later. Install dependencies with `npm ci` and start the app with `npm run dev`.

For a bug report, include your browser and operating system, the selected model, the sun azimuth/elevation and model yaw, and steps to reproduce the result. A screenshot helps explain a rendering issue. Use the included demo when possible so others can reproduce it without optional assets.

Before opening a pull request:

1. Run `npm test` and `npm run build`.
2. Check rendering changes in a WebGL 2 browser, including changes to the light angle and model yaw.
3. For changes to visibility or projection, use `?verify=1` to compare GPU and CPU results and describe what you checked.

Keep changes focused and explain the behavior they improve. Add regression tests when they capture a meaningful failure. Contributions to original project code and the procedural demo are provided under the [MIT license](LICENSE).

Do not contribute credentials, imported Kryptos models, third-party photographs, or generated captures containing assets you do not have permission to redistribute. Optional local assets are deliberately ignored by Git.
