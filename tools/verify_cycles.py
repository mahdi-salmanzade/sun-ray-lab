"""Independent reference for the lab: Blender Cycles on the SAME GLB.

Renders the top-down receiver window the lab shows in Read mode, direct sun
only (no sky, no bounces), copper invisible to the camera but casting, tree
and rocks removed. Writes linear luminance as .npy for verify_compare.py.

  blender -b --python tools/verify_cycles.py -- \
      <glb> <az> <el> <cx> <cy> <span> <width> <height> <samples> <out_prefix>

cx, cy are Blender coordinates (Z-up, +Y north, +X east); span is the window
width in model units. Two renders: real sun (0.533 deg) and point sun.
"""

import math
import sys

import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
GLB, AZ, EL, CX, CY, SPAN, W, H, SAMPLES, OUT = (
    argv[0],
    float(argv[1]),
    float(argv[2]),
    float(argv[3]),
    float(argv[4]),
    float(argv[5]),
    int(argv[6]),
    int(argv[7]),
    int(argv[8]),
    argv[9],
)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
scene = bpy.context.scene


def diffuse(name, value):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (value, value, value, 1)
    b.inputs["Roughness"].default_value = 1.0
    b.inputs["Specular IOR Level"].default_value = 0.0
    return m


receiver = diffuse("Receiver", 0.7)
for obj in list(scene.objects):
    if obj.type != "MESH":
        continue
    n = obj.name.lower()
    if "copper" in n:
        obj.visible_camera = False  # hidden from the camera, still casts
    elif "platform" in n:
        obj.data.materials.clear()
        obj.data.materials.append(receiver)
    else:
        obj.hide_render = True  # tree and rocks: "only the screen casts"

# The lab's courtyard ground sits at paving level, lab y = 14.0 (blender z
# = lab y - modelOffset.y, and that offset is ~0), and is cut away over the
# platform's pool basin exactly as src/main.js buildPoolMask() does: a
# 256-cell grid over the platform bounds, "low" cells (no platform top above
# 13.95) flood-filled from the border are outside and keep the floor; the
# enclosed low cells (the basin), dilated 2 cells into the platform top, are
# cut out.
from mathutils.bvhtree import BVHTree  # noqa: E402

plat = next(o for o in scene.objects if o.type == "MESH" and "platform" in o.name.lower())
dg = bpy.context.evaluated_depsgraph_get()
pbvh = BVHTree.FromObject(plat, dg)
pts = [plat.matrix_world @ v.co for v in plat.data.vertices]
minX, maxX = min(p.x for p in pts), max(p.x for p in pts)
minY, maxY = min(p.y for p in pts), max(p.y for p in pts)
N = 256
sx, sy = (maxX - minX) / N, (maxY - minY) / N
low = [[False] * N for _ in range(N)]
for j in range(N):  # j runs along lab +z, i.e. Blender -y
    for i in range(N):
        x = minX + (i + 0.5) * sx
        y = maxY - (j + 0.5) * sy
        hit = pbvh.ray_cast(Vector((x, y, 1000.0)), Vector((0, 0, -1)))
        low[j][i] = hit[0] is None or hit[0].z < 13.95
outside = [[False] * N for _ in range(N)]
stack = [(j, i) for i in range(N) for j in (0, N - 1)] + [(j, i) for j in range(N) for i in (0, N - 1)]
while stack:
    j, i = stack.pop()
    if outside[j][i] or not low[j][i]:
        continue
    outside[j][i] = True
    for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        if 0 <= j + dj < N and 0 <= i + di < N:
            stack.append((j + dj, i + di))
basin = [[low[j][i] and not outside[j][i] for i in range(N)] for j in range(N)]
cut = [[False] * N for _ in range(N)]
for j in range(N):
    for i in range(N):
        if outside[j][i]:
            continue
        cut[j][i] = any(
            basin[jj][ii]
            for jj in range(max(0, j - 2), min(N, j + 3))
            for ii in range(max(0, i - 2), min(N, i + 3))
        )
import bmesh  # noqa: E402

bm = bmesh.new()
z0 = 14.0
BIG = 10000.0


def quad(x0, y0, x1, y1):
    vs = [bm.verts.new((x0, y0, z0)), bm.verts.new((x1, y0, z0)),
          bm.verts.new((x1, y1, z0)), bm.verts.new((x0, y1, z0))]
    bm.faces.new(vs)


# around the platform bounds
quad(-BIG, -BIG, BIG, minY)
quad(-BIG, maxY, BIG, BIG)
quad(-BIG, minY, minX, maxY)
quad(maxX, minY, BIG, maxY)
for j in range(N):
    for i in range(N):
        if not cut[j][i]:
            x = minX + i * sx
            y = maxY - (j + 1) * sy
            quad(x, y, x + sx, y + sy)
me = bpy.data.meshes.new("Floor")
bm.to_mesh(me)
bm.free()
floor = bpy.data.objects.new("Floor", me)
scene.collection.objects.link(floor)
floor.data.materials.append(receiver)
print(f"floor: {sum(map(sum, cut))} of {N * N} cells cut over the pool basin")

a, e = math.radians(AZ), math.radians(EL)
d = (math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e))
sun_data = bpy.data.lights.new("Sun", type="SUN")
sun_data.energy = 1.0
sun = bpy.data.objects.new("Sun", sun_data)
scene.collection.objects.link(sun)

sun.rotation_mode = "QUATERNION"
sun.rotation_quaternion = (-Vector(d)).to_track_quat("-Z", "Y")

world = bpy.data.worlds.new("Black")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0, 0, 0, 1)
scene.world = world

cam_data = bpy.data.cameras.new("Top")
cam_data.type = "ORTHO"
cam_data.ortho_scale = SPAN  # applies to the wider axis (width)
cam = bpy.data.objects.new("Top", cam_data)
scene.collection.objects.link(cam)
cam.location = (CX, CY, 600)
cam.rotation_euler = (0, 0, 0)
cam_data.clip_end = 2000
scene.camera = cam

scene.render.engine = "CYCLES"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = False
scene.cycles.max_bounces = 0  # direct light only, like the lab with sky = 0
scene.cycles.use_adaptive_sampling = False
scene.render.resolution_x = W
scene.render.resolution_y = H
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.view_settings.view_transform = "Standard"
scene.render.image_settings.file_format = "OPEN_EXR"
scene.render.image_settings.color_depth = "32"
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for dev in prefs.devices:
        dev.use = True
    scene.cycles.device = "GPU"
except Exception as exc:  # noqa: BLE001
    print(f"GPU unavailable ({exc}); CPU")

for tag, angle in (("real", 0.533), ("point", 0.0)):
    sun_data.angle = math.radians(angle)
    path = f"{OUT}_{tag}.exr"
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    px = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, img.channels)
    lum = 0.2126 * px[..., 0] + 0.7152 * px[..., 1] + 0.0722 * px[..., 2]
    np.save(f"{OUT}_{tag}.npy", lum[::-1])  # Blender rows are bottom-up
    print(f"WROTE {OUT}_{tag}.npy")
