"""Check an optional imported Kryptos screen with independent Blender triangle rays.

Run from sun-ray-lab (Blender needs no browser or JavaScript renderer):

    blender -b --python tools/verify_apertures.py -- /tmp/apertures.json

Omit the output argument for a concise stdout summary only. For automated
runs, add ``--python-exit-code 1`` before ``--python`` so a failed check also
sets Blender's process exit code.

The bounded audit samples 24 x 24 positions in every bottom-row glyph, at
four cardinal suns with model yaw 0/45 degrees and two high-sun directions.
It traces through the imported GLB triangles toward the sun from an ideal
horizontal receiver at Blender Z=14, and checks adjacent copper as a blocked
control. Independent angular cases use all available CPU worker capacity.

Scope: aperture transmission and copper occlusion for these sampled rays.
This does not validate GPU rendering, finite-sun penumbrae, word legibility,
sky light, materials, the courtyard's pool cutout, or real-site accuracy.
Other scene objects are deliberately outside this screen-only audit. The
original exploratory audit's approximate context check is not a claim of
full-scene visibility and is not included here.
"""

import bisect
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


LAB = Path(__file__).resolve().parents[1]
MODEL = LAB / "public" / "kryptos_screen.glb"
LAYOUT = LAB / "public" / "kryptos_screen_layout.json"
GRID = 24
GROUND_Z = 14.0
CASES = [
    (azimuth, 30, yaw)
    for azimuth in (0, 90, 180, 270)
    for yaw in (0, 45)
] + [(90, 69, 0), (180, 69, 0)]
COUNTS = (
    "local_segment_clear",
    "local_segment_blocked",
    "screen_clear_to_ground",
    "copper_control_blocked",
    "copper_control_open",
)


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(args) > 1:
        raise ValueError("Expected at most one argument: optional output JSON path")
    output = Path(args[0]).expanduser() if args else None

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(MODEL))
    screen_object = bpy.data.objects.get("Kryptos.Part.CopperSheet")
    if screen_object is None:
        raise ValueError("GLB is missing Kryptos.Part.CopperSheet")
    # Import and construct the BVH on the main thread. Workers only read it.
    screen = BVHTree.FromObject(
        screen_object, bpy.context.evaluated_depsgraph_get()
    )
    layout = json.loads(LAYOUT.read_text())
    curve_s = layout["curve"]["s"]
    curve_xy = layout["curve"]["xy"]
    last_row = max(glyph["row"] for glyph in layout["glyphs"])
    glyphs = [g for g in layout["glyphs"] if g["row"] == last_row]

    def at(s, z):
        index = min(
            len(curve_s) - 2,
            max(0, bisect.bisect_right(curve_s, s) - 1),
        )
        fraction = (s - curve_s[index]) / (curve_s[index + 1] - curve_s[index])
        a, b = curve_xy[index : index + 2]
        return Vector(
            (a[0] + fraction * (b[0] - a[0]),
             a[1] + fraction * (b[1] - a[1]), z)
        )

    def blocked(origin, direction, distance=10000):
        return screen.ray_cast(origin, direction, distance)[0] is not None

    def ground_point(point, sun):
        return point - sun * ((point.z - GROUND_Z) / sun.z)

    def one_case(config):
        azimuth, elevation, yaw = config
        # Three.js +Y yaw maps to Blender +Z. Transform the world sun into
        # the unrotated model frame; its compass azimuth increases by yaw.
        az = math.radians(azimuth + yaw)
        el = math.radians(elevation)
        sun = Vector(
            (math.sin(az) * math.cos(el),
             math.cos(az) * math.cos(el), math.sin(el))
        )
        cells = []
        for glyph in glyphs:
            cell = {
                "field": glyph["field"],
                "letter": glyph["c"],
                "index": glyph["i"],
                **dict.fromkeys(COUNTS, 0),
                "example": None,
            }
            for iz in range(GRID):
                z = glyph["z0"] + (iz + 0.5) * (glyph["z1"] - glyph["z0"]) / GRID
                for ix in range(GRID):
                    s = glyph["s0"] + (ix + 0.5) * (glyph["s1"] - glyph["s0"]) / GRID
                    point = at(s, z)
                    # This short segment is only an inexpensive prefilter.
                    # At grazing incidence it can lie inside copper without
                    # crossing a boundary; it never establishes transmission.
                    if blocked(point - sun * 2, sun, 4):
                        cell["local_segment_blocked"] += 1
                        continue
                    cell["local_segment_clear"] += 1
                    ground = ground_point(point, sun)
                    if blocked(ground + sun * 1e-4, sun):
                        continue
                    cell["screen_clear_to_ground"] += 1
                    if cell["example"] is None:
                        cell["example"] = {
                            "point": list(point),
                            "ground_plane_point": list(ground),
                        }

            # The gap above each glyph is copper. Use complete ground-to-sun
            # rays here too, avoiding the grazing finite-segment ambiguity.
            for ix in range(GRID):
                s = glyph["s0"] + (ix + 0.5) * (glyph["s1"] - glyph["s0"]) / GRID
                point = at(s, glyph["z1"] + 0.35)
                ground = ground_point(point, sun)
                key = (
                    "copper_control_blocked"
                    if blocked(ground + sun * 1e-4, sun)
                    else "copper_control_open"
                )
                cell[key] += 1
            cells.append(cell)

        totals = {key: sum(cell[key] for cell in cells) for key in COUNTS}
        return {
            "azimuth": azimuth,
            "elevation": elevation,
            "yaw": yaw,
            "sum": totals,
            "passed": totals["screen_clear_to_ground"] > 0
            and totals["copper_control_open"] == 0,
            "cells": cells,
        }

    workers = max(1, (os.cpu_count() or 2) - 1)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(one_case, CASES))
    report = {
        "method": "Actual GLB triangle BVH; bottom-row glyph samples and adjacent-copper controls",
        "scope": "Screen-only point-sun visibility to an ideal horizontal receiver; no context or shading validation",
        "model": MODEL.name,
        "model_sha256": hashlib.sha256(MODEL.read_bytes()).hexdigest(),
        "layout_sha256": hashlib.sha256(LAYOUT.read_bytes()).hexdigest(),
        "workers": workers,
        "grid": GRID,
        "glyphs_per_case": len(glyphs),
        "ground_z": GROUND_Z,
        "passed": all(result["passed"] for result in results),
        "results": results,
    }
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n")

    print("\nScreen aperture audit (screen-only, point sun)")
    print("  az   el  yaw  ground-clear / samples   copper blocked / controls")
    for result in results:
        totals = result["sum"]
        print(
            f"{result['azimuth']:4} {result['elevation']:4} {result['yaw']:4}"
            f"  {totals['screen_clear_to_ground']:8} / {len(glyphs) * GRID * GRID:<7}"
            f"  {totals['copper_control_blocked']:8} / {len(glyphs) * GRID}"
        )
    print("PASS" if report["passed"] else "FAIL")
    if output is not None:
        print(f"Full report: {output}")
    if not report["passed"]:
        raise RuntimeError("A case transmitted no sampled letter rays or leaked a copper control")


if __name__ == "__main__":
    main()
