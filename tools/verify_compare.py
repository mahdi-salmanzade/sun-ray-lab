"""Compare the lab's linear radiance with the Cycles reference.

  python3 tools/verify_compare.py <prefix>

Reads <prefix>_lab_{point,real}.f32 + <prefix>_lab.json (verify_lab.mjs) and
<prefix>_{point,real}.npy (verify_cycles.py). Each image is normalised by its
own fully-lit level, since the two renderers use different light units. Writes
a side-by-side PNG (lab | Cycles | difference) and prints the error figures.
"""

import json
import sys

import numpy as np
from PIL import Image

prefix = sys.argv[1]
meta = json.load(open(f"{prefix}_lab.json"))
W, H = meta["width"], meta["height"]

report = {}
rows = []
for tag in ("point", "real"):
    lab = np.fromfile(f"{prefix}_lab_{tag}.f32", dtype=np.float32).reshape(H, W)
    cyc = np.load(f"{prefix}_{tag}.npy").astype(np.float32)
    assert cyc.shape == lab.shape, (cyc.shape, lab.shape)

    def norm(img):
        lit = np.percentile(img, 99.5)
        return np.clip(img / max(lit, 1e-9), 0, 1.2)

    a, b = norm(lab), norm(cyc)
    diff = a - b
    # Ignore a 2 px border (camera jitter vs pixel-centre sampling).
    core = (slice(2, -2), slice(2, -2))
    mae = float(np.abs(diff[core]).mean())
    corr = float(np.corrcoef(a[core].ravel(), b[core].ravel())[0, 1])
    lit_frac_lab = float((a[core] > 0.5).mean())
    lit_frac_cyc = float((b[core] > 0.5).mean())
    report[tag] = {
        "mean_abs_diff": round(mae, 4),
        "correlation": round(corr, 4),
        "lit_fraction_lab": round(lit_frac_lab, 4),
        "lit_fraction_cycles": round(lit_frac_cyc, 4),
        "p99_abs_diff": round(float(np.percentile(np.abs(diff[core]), 99)), 4),
    }
    to8 = lambda x: (np.clip(x, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8)  # noqa: E731
    d8 = np.clip(128 + diff * 255, 0, 255).astype(np.uint8)
    rows.append(np.concatenate([to8(a), to8(b), d8], axis=1))

Image.fromarray(np.concatenate(rows, axis=0)).save(f"{prefix}_compare.png")
print(json.dumps(report, indent=2))
