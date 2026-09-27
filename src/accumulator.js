import * as THREE from "three";

/**
 * Progressive linear-radiance accumulator, in three channels.
 *
 * The sun is a 0.53 deg disc, not a point. Each frame traces one direction
 * inside the disc; the running mean of those frames converges to the exact
 * penumbra. Rendering into float targets with tone mapping off gives linear
 * radiance, so the mean is a mean of radiance -- the physically correct thing
 * to average. Tone mapping and sRGB encoding happen once, at display.
 *
 * The image is split so a sun change does not throw away the sky light:
 *
 *   direct  albedo/pi * E_sun * cos * V_sun   (+ specular, guides, sky dome)
 *   sky     rgb albedo/pi * [sky ray escapes]; alpha = [ray points below
 *           the horizon]                       (independent of the sun)
 *   albedo  albedo/pi, alpha = view distance   (no rays; anti-aliasing only)
 *
 *   radiance = direct + sky * E_sky + below * E_ground + blocked * E_occ
 *     below   = albedo * alpha(sky)    directions that see the courtyard
 *     blocked = albedo - sky - below   directions stopped by an occluder
 *
 * E_occ is the light an occluder sends back: next to the screen that is the
 * shaded copper, far dimmer than sunlit ground. Lighting blocked directions
 * with sunlit-ground radiance (the first version) made the umbra beside the
 * screen ~1.75x too bright.
 *
 * so E_sky and E_ground (sky fill, ground bounce) are display uniforms and
 * need no re-trace, and moving the sun only resets `direct`.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Running mean: out = mix(previous, current, 1/n)
const MERGE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tPrev;
uniform sampler2D tCurr;
uniform float uWeight;
void main() {
  gl_FragColor = mix(texture2D(tPrev, vUv), texture2D(tCurr, vUv), uWeight);
}
`;

// Compose -> exposure -> camera-like tone curve -> sRGB
const DISPLAY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDirect;
uniform sampler2D tSky;
uniform sampler2D tAlbedo;
uniform vec3 uSkyIrr;
uniform vec3 uGroundIrr;
uniform vec3 uOccIrr;
uniform float uExposure;
uniform bool uLinear;
uniform float uSkySigma;   // denoise radius in pixels; 0 = off
uniform vec2 uTexel;

// Early-frame denoiser for the sky channel only. Sky visibility is smooth, so
// an edge-aware blur (weights from the albedo and view-depth guides) removes
// the 1-sample grain without smearing across objects. The radius shrinks as
// 1/sqrt(n) and is zero long before convergence, so the final image is the
// unfiltered mean.
// Filters the DEMODULATED quantities (sky visibility = sky / albedo, and the
// below-horizon fraction) and re-modulates by the pixel's own albedo, so the
// blur never smears texture detail or unbalances blocked = albedo - sky - below.
vec4 skyFiltered(vec2 uv, vec3 a0, float d0) {
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  float step = max(1.0, uSkySigma * 0.6);
  for (int j = -3; j <= 3; j++) {
    for (int i = -3; i <= 3; i++) {
      vec2 o = vec2(float(i), float(j)) * step;
      vec2 q = uv + o * uTexel;
      vec4 g = texture2D(tAlbedo, q);
      float ws = exp(-dot(o, o) / (2.0 * uSkySigma * uSkySigma));
      vec3 da = (g.rgb - a0) / (0.02 + 0.2 * a0);
      float wa = exp(-dot(da, da));
      float dd = (g.a - d0) / max(0.01 * d0, 0.05);
      float wd = exp(-dd * dd);
      float w = ws * wa * wd;
      vec4 sk = texture2D(tSky, q);
      sum += vec4(sk.rgb / max(g.rgb, vec3(1e-4)), sk.a) * w;
      wsum += w;
    }
  }
  vec4 m = sum / max(wsum, 1e-6);
  return vec4(a0 * min(m.rgb, vec3(1.0)), m.a);
}

// Camera-like tone curve: LINEAR below 0.6 (no toe), a soft exponential
// shoulder above, applied to luminance so hue is kept. ACES (used before)
// has a strong toe that pushed sky-lit shade -- ~1/8 of sunlit ground in
// reality, sRGB ~50-60 in photographs of the site -- down to ~30, so the
// shadow read as black with harsh specks in it.
vec3 cameraCurve(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  const float k = 0.6;
  float lo = l < k ? l : k + (1.0 - k) * (1.0 - exp(-(l - k) / (1.0 - k)));
  vec3 o = c * (lo / max(l, 1e-6));
  // desaturate what still exceeds 1 so highlights roll to white, not hue
  float m = max(o.r, max(o.g, o.b));
  if (m > 1.0) o = mix(o, vec3(lo), clamp((m - 1.0) * 2.0, 0.0, 1.0));
  return clamp(o, 0.0, 1.0);
}

vec3 toSRGB(vec3 c) {
  return mix(pow(c, vec3(0.41666)) * 1.055 - 0.055, c * 12.92, step(c, vec3(0.0031308)));
}

void main() {
  vec3 d = texture2D(tDirect, vUv).rgb;
  vec4 ad = texture2D(tAlbedo, vUv);
  vec3 a = ad.rgb;
  vec4 sk = uSkySigma > 0.5 && ad.a > 0.0 ? skyFiltered(vUv, a, ad.a) : texture2D(tSky, vUv);
  vec3 s = sk.rgb;
  vec3 below = a * sk.a;
  vec3 blocked = max(a - s - below, 0.0);
  vec3 c = d + s * uSkyIrr + below * uGroundIrr + blocked * uOccIrr;
  if (uLinear) {
    // alpha marks geometry (for the exposure meter); readLinear uses rgb only
    gl_FragColor = vec4(c, ad.a > 0.0 ? 1.0 : 0.0);
    return;
  }
  gl_FragColor = vec4(toSRGB(cameraCurve(c * uExposure)), 1.0);
}
`;

export const CHANNELS = ["direct", "sky", "albedo"];

export class ProgressiveAccumulator {
  constructor(renderer, skyCap = 32) {
    this.renderer = renderer;
    this.skyCap = skyCap;
    // Full float: at n = 512 a half-float running mean drops increments
    // smaller than its 11-bit mantissa and biases the penumbra.
    const opts = {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    };
    this.frame = new THREE.WebGLRenderTarget(1, 1, { ...opts, depthBuffer: true });
    this.linear = new THREE.WebGLRenderTarget(1, 1, opts);
    this.meterTarget = new THREE.WebGLRenderTarget(96, 64, opts);
    this.meterBuf = new Float32Array(96 * 64 * 4);
    this.channels = {};
    for (const name of CHANNELS) {
      this.channels[name] = {
        targets: [new THREE.WebGLRenderTarget(1, 1, opts), new THREE.WebGLRenderTarget(1, 1, opts)],
        read: 0,
        samples: 0,
      };
    }

    this.mergeMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: MERGE_FRAG,
      uniforms: { tPrev: { value: null }, tCurr: { value: null }, uWeight: { value: 1 } },
      depthTest: false,
      depthWrite: false,
    });
    this.displayMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: DISPLAY_FRAG,
      uniforms: {
        tDirect: { value: null },
        tSky: { value: null },
        tAlbedo: { value: null },
        uSkyIrr: { value: new THREE.Color() },
        uGroundIrr: { value: new THREE.Color() },
        uOccIrr: { value: new THREE.Color() },
        uExposure: { value: 1 },
        uLinear: { value: false },
        uSkySigma: { value: 0 },
        uTexel: { value: new THREE.Vector2(1, 1) },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.quadScene = new THREE.Scene();
    this.quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mergeMaterial);
    this.quadMesh.frustumCulled = false;
    this.quadScene.add(this.quadMesh);
    this.quadCamera = new THREE.Camera();
  }

  setSize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.frame.width === w && this.frame.height === h) return;
    this.frame.setSize(w, h);
    this.linear.setSize(w, h);
    for (const ch of Object.values(this.channels)) {
      ch.targets[0].setSize(w, h);
      ch.targets[1].setSize(w, h);
    }
    this.reset();
  }

  /** Discard convergence of the named channels (all by default). */
  reset(names = CHANNELS) {
    for (const n of names) this.channels[n].samples = 0;
  }

  samples(name) {
    return this.channels[name].samples;
  }

  /** Render one sample of `name` with `renderScene` and fold it into the mean. */
  addSample(name, renderScene) {
    const r = this.renderer;
    const ch = this.channels[name];
    const prevTarget = r.getRenderTarget();

    r.setRenderTarget(this.frame);
    r.setClearColor(0x000000, 0); // alpha 0 = background in the depth guide
    r.clear();
    renderScene();

    const src = ch.targets[ch.read];
    const dst = ch.targets[1 - ch.read];
    this.quadMesh.material = this.mergeMaterial;
    this.mergeMaterial.uniforms.tPrev.value = src.texture;
    this.mergeMaterial.uniforms.tCurr.value = this.frame.texture;
    this.mergeMaterial.uniforms.uWeight.value = ch.samples === 0 ? 1 : 1 / (ch.samples + 1);
    r.setRenderTarget(dst);
    r.render(this.quadScene, this.quadCamera);
    ch.read = 1 - ch.read;
    ch.samples += 1;
    r.setRenderTarget(prevTarget);
  }

  _bindDisplay(skyIrr, groundIrr, exposure, linear, occIrr) {
    const u = this.displayMaterial.uniforms;
    const tex = (n) => this.channels[n].targets[this.channels[n].read].texture;
    u.tDirect.value = tex("direct");
    u.tSky.value = tex("sky");
    u.tAlbedo.value = tex("albedo");
    u.uSkyIrr.value.copy(skyIrr);
    u.uGroundIrr.value.copy(groundIrr);
    u.uOccIrr.value.copy(occIrr ?? groundIrr);
    u.uExposure.value = exposure;
    u.uLinear.value = linear;
    // Denoise only while the sky channel is still converging; off at the cap,
    // so the converged display is the unfiltered mean that readLinear returns.
    const n = this.channels.sky.samples;
    const sigma = n > 0 && n < this.skyCap ? 5 / Math.sqrt(n) : 0;
    u.uSkySigma.value = linear || sigma < 0.7 ? 0 : sigma;
    u.uTexel.value.set(1 / this.frame.width, 1 / this.frame.height);
    this.quadMesh.material = this.displayMaterial;
  }

  /** Compose the channels, tone map and draw to the canvas. */
  present(skyIrr, groundIrr, exposure, occIrr) {
    this._bindDisplay(skyIrr, groundIrr, exposure, false, occIrr);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /**
   * Log-average and 98th-percentile luminance of the composed image over
   * geometry pixels (a 96x64 point-sampled meter), for camera-like auto
   * exposure. Null if the frame shows no geometry.
   */
  meter(skyIrr, groundIrr, occIrr) {
    const r = this.renderer;
    this._bindDisplay(skyIrr, groundIrr, 1, true, occIrr);
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.meterTarget);
    r.render(this.quadScene, this.quadCamera);
    r.setRenderTarget(prev);
    r.readRenderTargetPixels(this.meterTarget, 0, 0, 96, 64, this.meterBuf);
    const b = this.meterBuf;
    let sum = 0;
    const lums = [];
    for (let i = 0; i < b.length; i += 4) {
      if (b[i + 3] < 0.5) continue;
      const lum = 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];
      sum += Math.log(lum + 1e-4);
      lums.push(lum);
    }
    if (lums.length <= 30) return null;
    lums.sort((x, y) => x - y);
    return { logAvg: Math.exp(sum / lums.length), p98: lums[Math.floor(lums.length * 0.98)] };
  }

  /** Composed linear radiance (before tone mapping) as RGBA floats. */
  readLinear(skyIrr, groundIrr, occIrr) {
    const r = this.renderer;
    this._bindDisplay(skyIrr, groundIrr, 1, true, occIrr);
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.linear);
    r.render(this.quadScene, this.quadCamera);
    r.setRenderTarget(prev);
    const { width, height } = this.linear;
    const out = new Float32Array(width * height * 4);
    r.readRenderTargetPixels(this.linear, 0, 0, width, height, out);
    return { width, height, data: out };
  }
}
