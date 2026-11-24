# Exports units as rigged, animated glTF (.glb): skeleton, skinned body, color texture and all the animation clips
# (walk, attack, death, deploy, celebration...), playable in three.js. Only the units whose names match the filter
# (extract.mjs gives the ones the sprite list names).
# usage: python -I export_animations.py [out_dir] [unit filter regex]
#   out_dir defaults to animations in the working folder
#
# Clips are Unity "Mecanim" generic clips: keyframes split into a streamed block (Hermite cubic keys), a dense block
# (sampled frames) and a constant block, in that curve order. m_ClipBindingConstant.genericBindings says which bone
# (CRC32 of its path below the Animator) and which property (1 position xyz, 2 rotation quaternion xyzw, 3 scale
# xyz, 4 euler xyz) each run of curves drives. Unity is left-handed: x is mirrored for glTF.
import os, re, sys, json, glob, math, struct, zlib
from UnityPy.helpers.MeshHelper import MeshHandler

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ["RUMBLE_WORK"]  # the working folder: exports, indexes, the tables read
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "animations")
ONLY = re.compile(sys.argv[2]) if len(sys.argv) > 2 else None
_argv = sys.argv; sys.argv = sys.argv[:1]; sys.path.insert(0, HERE)  # (-I leaves the script folder off the path)
import export_models as em  # bundle closure, names (its main() only runs as a script)
sys.argv = _argv
B = em.B
FX = re.compile(r"(^|_)FX(_|$)|_Fx_|Swoosh", re.I)

# ---- clip decoding ---------------------------------------------------------------------------------------------------
CURVES = {1: 3, 2: 4, 3: 3, 4: 3}
def streamed_keys(data):
    """[(time, [(curve, (c0, c1, c2, c3))...])...] from the packed uint32 list."""
    raw = struct.pack(f"<{len(data)}I", *data); pos = 0; frames = []
    while pos + 8 <= len(raw):
        t, n = struct.unpack_from("<fI", raw, pos); pos += 8
        keys = []
        for _ in range(n):
            i, c0, c1, c2, c3 = struct.unpack_from("<i4f", raw, pos); pos += 20
            keys.append((i, (c0, c1, c2, c3)))
        frames.append((t, keys))
    return frames

def decode_clip(clip):
    """{curve index: function(t) -> value}, plus duration and sample rate."""
    mc = clip.m_MuscleClip.m_Clip.data
    sc = mc.m_StreamedClip.curveCount; dense = mc.m_DenseClip; dc = dense.m_CurveCount
    per = {}  # streamed curve -> [(t0, coeffs)]
    for t, keys in streamed_keys(mc.m_StreamedClip.data):
        for i, co in keys: per.setdefault(i, []).append((t, co))
    def streamed(i):
        ks = per.get(i, [])
        def f(t):
            if not ks: return 0.0
            k = ks[0]
            for kk in ks:
                if kk[0] <= t + 1e-6: k = kk
                else: break
            d = max(0.0, t - k[0]) if k[0] > -1e30 else 0.0
            c0, c1, c2, c3 = k[1]
            return ((c0 * d + c1) * d + c2) * d + c3
        return f
    def densef(i):
        def f(t):
            if dense.m_FrameCount == 0: return 0.0
            x = (t - dense.m_BeginTime) * dense.m_SampleRate
            a = max(0, min(dense.m_FrameCount - 1, int(math.floor(x)))); b = min(dense.m_FrameCount - 1, a + 1)
            w = min(1.0, max(0.0, x - a))
            va = dense.m_SampleArray[a * dc + i]; vb = dense.m_SampleArray[b * dc + i]
            return va + (vb - va) * w
        return f
    const = mc.m_ConstantClip.data
    def curve(g):
        if g < sc: return streamed(g)
        if g < sc + dc: return densef(g - sc)
        v = const[g - sc - dc] if g - sc - dc < len(const) else 0.0
        return lambda t, v=v: v
    out, g = [], 0
    for b in clip.m_ClipBindingConstant.genericBindings:
        n = CURVES.get(b.attribute, 1) if b.typeID == 4 else 1
        out.append((b, [curve(g + k) for k in range(n)])); g += n
    return out, max(clip.m_MuscleClip.m_StopTime - clip.m_MuscleClip.m_StartTime, 1 / 30), clip.m_SampleRate or 30

def euler_to_quat(x, y, z):  # Unity order: Z, then X, then Y (degrees)
    x, y, z = (math.radians(v) / 2 for v in (x, y, z))
    cx, sx, cy, sy, cz, sz = math.cos(x), math.sin(x), math.cos(y), math.sin(y), math.cos(z), math.sin(z)
    return (sx*cy*cz + cx*sy*sz, cx*sy*cz - sx*cy*sz, cx*cy*sz - sx*sy*cz, cx*cy*cz + sx*sy*sz)

# ---- glTF ------------------------------------------------------------------------------------------------------------
class Glb:
    def __init__(self): self.bin = bytearray(); self.views = []; self.accs = []; self.doc = {"asset": {"version": "2.0", "generator": "rumble tracker export_animations.py"}}
    def view(self, data, target=None):
        while len(self.bin) % 4: self.bin += b"\0"
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target: v["target"] = target
        self.bin += data; self.views.append(v); return len(self.views) - 1
    def acc(self, values, typ, comp=5126, target=None, minmax=False):
        n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[typ]
        fmt = {5126: "f", 5125: "I", 5121: "B", 5123: "H"}[comp]
        flat = [c for v in values for c in (v if n > 1 else (v,))]
        a = {"bufferView": self.view(struct.pack(f"<{len(flat)}{fmt}", *flat), target), "componentType": comp, "count": len(values), "type": typ}
        if minmax:
            vals = [v if n > 1 else (v,) for v in values]
            a["min"] = [min(v[i] for v in vals) for i in range(n)]; a["max"] = [max(v[i] for v in vals) for i in range(n)]
        self.accs.append(a); return len(self.accs) - 1
    def save(self, path):
        self.doc.update({"accessors": self.accs, "bufferViews": self.views, "buffers": [{"byteLength": len(self.bin)}]})
        js = json.dumps(self.doc, separators=(",", ":")).encode(); js += b" " * ((4 - len(js) % 4) % 4)
        while len(self.bin) % 4: self.bin += b"\0"
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, 28 + len(js) + len(self.bin)))
            f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
            f.write(struct.pack("<II", len(self.bin), 0x004E4942)); f.write(self.bin)

def mirror_mat(m):  # Unity Matrix4x4f (column fields eRC) -> glTF column-major list, with x mirrored (S M S)
    r = [[getattr(m, f"e{i}{j}") for j in range(4)] for i in range(4)]
    s = [-1, 1, 1, 1]
    r = [[r[i][j] * s[i] * s[j] for j in range(4)] for i in range(4)]
    return [r[i][j] for j in range(4) for i in range(4)]

def comps(go): return [getattr(x, "component", x) for x in go.m_Component]

def avatar_of(smr):
    """The Avatar of the nearest Animator above a renderer (riders and mounts share one)."""
    t = next(c.read() for c in comps(smr.m_GameObject.read()) if c.type.name == "Transform")
    while True:
        an = next((c.read() for c in comps(t.m_GameObject.read()) if c.type.name == "Animator"), None)
        if an and an.m_Avatar.path_id:
            try: return an.m_Avatar.read()
            except Exception: pass
        if not (t.m_Father and t.m_Father.path_id): return None
        t = t.m_Father.read()

def color_texture(smr):
    for mp in smr.m_Materials:
        try:
            for name, te in mp.read().m_SavedProperties.m_TexEnvs:
                if name in ("_BaseMap", "_MainTex") and te.m_Texture.path_id: return te.m_Texture.read()
        except Exception: pass
    return None

def m4(m): return [[getattr(m, f"e{i}{j}") for j in range(4)] for i in range(4)]
def inv4(a):
    n = 4; m = [row[:] + [1.0 if i == j else 0.0 for j in range(n)] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c])); m[c], m[p] = m[p], m[c]
        d = m[c][c] or 1e-12; m[c] = [v / d for v in m[c]]
        for r in range(n):
            if r != c and m[r][c]: f = m[r][c]; m[r] = [v - f * w for v, w in zip(m[r], m[c])]
    return [row[n:] for row in m]
def mm4(a, b): return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]
def trs4(t, q, s):
    x, y, z, w = q.x, q.y, q.z, q.w
    r = [[1 - 2*(y*y + z*z), 2*(x*y - z*w), 2*(x*z + y*w)], [2*(x*y + z*w), 1 - 2*(x*x + z*z), 2*(y*z - x*w)],
         [2*(x*z - y*w), 2*(y*z + x*w), 1 - 2*(x*x + y*y)]]
    return [[r[i][0]*s.x, r[i][1]*s.y, r[i][2]*s.z, (t.x, t.y, t.z)[i]] for i in range(3)] + [[0, 0, 0, 1]]
def decompose(m):
    t = (m[0][3], m[1][3], m[2][3])
    sc = [math.sqrt(sum(m[i][j] ** 2 for i in range(3))) or 1 for j in range(3)]
    r = [[m[i][j] / sc[j] for j in range(3)] for i in range(3)]
    tr = r[0][0] + r[1][1] + r[2][2]
    if tr > 0: s = math.sqrt(tr + 1) * 2; q = ((r[2][1] - r[1][2]) / s, (r[0][2] - r[2][0]) / s, (r[1][0] - r[0][1]) / s, s / 4)
    elif r[0][0] > r[1][1] and r[0][0] > r[2][2]: s = math.sqrt(1 + r[0][0] - r[1][1] - r[2][2]) * 2; q = (s / 4, (r[0][1] + r[1][0]) / s, (r[0][2] + r[2][0]) / s, (r[2][1] - r[1][2]) / s)
    elif r[1][1] > r[2][2]: s = math.sqrt(1 + r[1][1] - r[0][0] - r[2][2]) * 2; q = ((r[0][1] + r[1][0]) / s, s / 4, (r[1][2] + r[2][1]) / s, (r[0][2] - r[2][0]) / s)
    else: s = math.sqrt(1 + r[2][2] - r[0][0] - r[1][1]) * 2; q = ((r[0][2] + r[2][0]) / s, (r[1][2] + r[2][1]) / s, s / 4, (r[1][0] - r[0][1]) / s)
    return t, q, sc

def write_character(avatar, parts, clips, out_glb):
    """One skeleton (Avatar) with every skinned part on it, and the clips that drive it."""
    import io
    av = avatar.m_Avatar
    sk = av.m_AvatarSkeleton.data; pose = av.m_AvatarSkeletonPose.data.m_X; tos = dict(avatar.m_TOS)
    nodes, paths = [], {}
    for i, (node, nid) in enumerate(zip(sk.m_Node, sk.m_ID)):
        x = pose[i]
        name = (tos.get(nid) or "").rsplit("/", 1)[-1] or ("root" if i == 0 else f"node{i}")
        nodes.append({"name": name, "translation": [-x.t.x, x.t.y, x.t.z], "rotation": [x.q.x, -x.q.y, -x.q.z, x.q.w],
                      "scale": [x.s.x, x.s.y, x.s.z]})
        paths[nid] = i
        if node.m_ParentId >= 0: nodes[node.m_ParentId].setdefault("children", []).append(i)
    if not clips:
        # nothing animates it: pose the bones as the meshes were bound (the avatar's default pose can differ)
        world = {}; parent = {i: n.m_ParentId for i, n in enumerate(sk.m_Node)}
        bind = {}
        for _, mesh in parts:
            for hsh, bp in zip(mesh.m_BoneNameHashes, mesh.m_BindPose):
                if hsh in paths and paths[hsh] not in bind: bind[paths[hsh]] = inv4(m4(bp))
        for i in range(len(nodes)):
            x = pose[i]; local = trs4(x.t, x.q, x.s)
            pw = world.get(parent[i]) if parent[i] >= 0 else None
            if i in bind:
                world[i] = bind[i]
                local = mm4(inv4(pw), bind[i]) if pw else bind[i]
                t, q, sc = decompose(local)
                nodes[i].update({"translation": [-t[0], t[1], t[2]], "rotation": [q[0], -q[1], -q[2], q[3]], "scale": list(sc)})
            else:
                world[i] = mm4(pw, local) if pw else local
    g = Glb(); meshes, skins, mats, images, textures, tex_index = [], [], [], [], [], {}
    roots = [0]; vertices = 0; part_names = []
    for smr, mesh in parts:
        joints = [paths.get(hsh) for hsh in mesh.m_BoneNameHashes]
        if not joints or any(j is None for j in joints): continue
        h = MeshHandler(mesh); h.process()
        V = [(-v[0], v[1], v[2]) for v in h.m_Vertices]
        N = [(-n[0], n[1], n[2]) for n in h.m_Normals] if h.m_Normals else None
        U = [(u[0], 1 - u[1]) for u in h.m_UV0] if h.m_UV0 else None
        J = [tuple(int(x) for x in j[:4]) + (0,) * (4 - len(j[:4])) for j in h.m_BoneIndices] if h.m_BoneIndices else None
        W = [tuple(w[:4]) + (0.0,) * (4 - len(w[:4])) for w in h.m_BoneWeights] if h.m_BoneWeights else None
        attrs = {"POSITION": g.acc(V, "VEC3", target=34962, minmax=True)}
        if N: attrs["NORMAL"] = g.acc(N, "VEC3", target=34962)
        if U: attrs["TEXCOORD_0"] = g.acc(U, "VEC2", target=34962)
        if not (J and W):  # a rigid part (weapon) on one bone: bind every vertex to it
            J = [(0, 0, 0, 0)] * len(V); W = [(1.0, 0.0, 0.0, 0.0)] * len(V)
        attrs["JOINTS_0"] = g.acc(J, "VEC4", comp=5123, target=34962)
        attrs["WEIGHTS_0"] = g.acc([tuple(x / (sum(w) or 1) for x in w) for w in W], "VEC4", target=34962)
        tex = color_texture(smr)
        mat = {"name": tex.m_Name if tex else mesh.m_Name, "pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1}}
        if tex:
            if tex.m_Name not in tex_index:
                buf = io.BytesIO(); tex.image.save(buf, "PNG")
                images.append({"bufferView": g.view(buf.getvalue()), "mimeType": "image/png", "name": tex.m_Name})
                textures.append({"source": len(images) - 1}); tex_index[tex.m_Name] = len(textures) - 1
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": tex_index[tex.m_Name]}
        mats.append(mat)
        ib = h.m_IndexBuffer; per = 2 if h.m_Use16BitIndices else 4
        prims = []
        for sm in mesh.m_SubMeshes:
            first = sm.firstByte // per; base = getattr(sm, "baseVertex", 0) or 0
            idx = [i + base for i in ib[first:first + sm.indexCount]]
            tri = [v for k in range(0, len(idx) - 2, 3) for v in (idx[k], idx[k + 2], idx[k + 1])]
            if tri: prims.append({"attributes": attrs, "indices": g.acc(tri, "SCALAR", comp=5125, target=34963), "material": len(mats) - 1})
        if not prims: continue
        meshes.append({"name": mesh.m_Name, "primitives": prims})
        skins.append({"joints": joints, "inverseBindMatrices": g.acc([mirror_mat(m) for m in mesh.m_BindPose], "MAT4"), "skeleton": 0})
        nodes.append({"name": mesh.m_Name, "mesh": len(meshes) - 1, "skin": len(skins) - 1}); roots.append(len(nodes) - 1)
        vertices += len(V); part_names.append(mesh.m_Name)
    if not meshes: return None
    g.doc.update({"nodes": nodes, "meshes": meshes, "skins": skins, "materials": mats, "scene": 0, "scenes": [{"nodes": roots}]})
    if images: g.doc["images"] = images; g.doc["textures"] = textures
    anims, names = [], []
    for nm, (bind, dur, rate) in clips:
        frames = max(2, int(round(dur * rate)) + 1)
        times = [min(dur, k / rate) for k in range(frames)]
        tacc = g.acc(times, "SCALAR", minmax=True)
        samplers, channels = [], []
        for b, fs in bind:
            if b.typeID != 4 or b.path not in paths: continue
            node = paths[b.path]
            if b.attribute == 1: vals = [(-fs[0](t), fs[1](t), fs[2](t)) for t in times]; path = "translation"; typ = "VEC3"
            elif b.attribute == 2:
                vals = []
                for t in times:
                    x, y, z, w = (f(t) for f in fs); l = math.sqrt(x*x + y*y + z*z + w*w) or 1
                    vals.append((x / l, -y / l, -z / l, w / l))
                path = "rotation"; typ = "VEC4"
            elif b.attribute == 4:
                vals = [(lambda q: (q[0], -q[1], -q[2], q[3]))(euler_to_quat(*(f(t) for f in fs))) for t in times]; path = "rotation"; typ = "VEC4"
            elif b.attribute == 3: vals = [tuple(f(t) for f in fs) for t in times]; path = "scale"; typ = "VEC3"
            else: continue
            samplers.append({"input": tacc, "output": g.acc(vals, typ), "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers) - 1, "target": {"node": node, "path": path}})
        if channels:
            clean = nm.split("@", 1)[1] if "@" in nm else nm
            if any(x["name"] == clean for x in names): clean = nm  # same clip name from the statue: keep the full name
            k = 2
            while any(x["name"] == clean for x in names): clean = f"{nm} {k}"; k += 1
            anims.append({"name": clean, "samplers": samplers, "channels": channels}); names.append({"name": clean, "duration": round(dur, 3)})
    if anims: g.doc["animations"] = anims
    g.save(out_glb)
    return {"avatar": avatar.m_Name, "parts": part_names, "clips": names, "bones": len(sk.m_Node), "vertices": vertices,
            "textures": list(tex_index)}

def own_objects(bundles):
    env = em.load_lazy(*bundles)
    return env, [o for f in env.files.values() if os.path.basename(getattr(f, "name", "") or "") in bundles
                 for sf in f.files.values() if hasattr(sf, "objects") for o in sf.objects.values()]

def fitting_clips(own, ids):
    """The clips in these objects for each skeleton (name -> bone hash set) they fit."""
    clips = {n: [] for n in ids}; seen = set()
    for o in own:
        if o.type.name != "AnimationClip": continue
        nm = o.peek_name() or ""
        if FX.search(nm) or nm in seen: continue
        seen.add(nm)
        try: dec = decode_clip(o.read())
        except Exception as e: print("   clip failed", nm, e); continue
        hs = {b.path for b, _ in dec[0] if b.typeID == 4}
        if not hs: continue
        # every skeleton the clip fits (variants such as murloc colors share one rig and its clips)
        top = max(len(hs & ids[n]) for n in ids)
        for n in ids:
            hit = len(hs & ids[n])
            if hit >= max(1, len(hs) // 3) and hit >= 0.6 * top: clips[n].append((nm, dec))
    return clips

POSE = re.compile(r"^(Pose|DeployPose|Celebration|Statue|Sleep|Stand|Idle|Ready)", re.I)
def poses_only(names):
    """No movement or attack clips: statue and idle poses only, or nothing (the base unit's bundle holds the rest)."""
    return all(POSE.match(n.split("@", 1)[-1]) for n in names)

def skeleton_sig(ids): return "%08x" % zlib.crc32(struct.pack(f"<{len(ids)}I", *sorted(ids)))

def export_set(key, bundles, out_dir, borrow=None):
    """Every character (skeleton) in these bundles: <key>.glb for the biggest, <key>__<name>.glb for the others.
    borrow: {skeleton sig: bundles} of another set whose clips drive a skeleton that has none of its own here."""
    env, own = own_objects(bundles)
    groups = {}  # avatar name -> {avatar, parts: {(mesh name, vertex count): (smr, mesh)}}
    for o in own:
        if o.type.name != "SkinnedMeshRenderer": continue
        try:
            r = o.read(); mesh = r.m_Mesh.read()
            if FX.search(mesh.m_Name) or not mesh.m_BoneNameHashes: continue
            avatar = avatar_of(r)
        except Exception: continue
        if not avatar: continue
        grp = groups.setdefault(avatar.m_Name, {"avatar": avatar, "parts": {}})
        grp["parts"].setdefault((mesh.m_Name, mesh.m_VertexData.m_VertexCount), (r, mesh))
    if not groups: return []
    ids = {n: set(gr["avatar"].m_Avatar.m_AvatarSkeleton.data.m_ID) for n, gr in groups.items()}
    clips = fitting_clips(own, ids)
    sigs = {n: skeleton_sig(ids[n]) for n in groups}
    # a skeleton with no clips, or only poses, here (the collectible Emperor Thaurissan, gold tower skins, Emerald
    # Drake/Whelp) takes the missing ones from another unit or structure with the very same skeleton
    borrowed = {}
    for n in groups:
        if poses_only(nm for nm, _ in clips[n]) and borrow and sigs[n] in borrow:
            donor = borrow[sigs[n]]
            have = {nm.split("@", 1)[-1] for nm, _ in clips[n]}
            extra = [c for c in fitting_clips(own_objects(donor["bundles"])[1], {n: ids[n]})[n] if c[0].split("@", 1)[-1] not in have]
            if extra: clips[n] += extra; borrowed[n] = donor["file"]
    order = sorted(groups, key=lambda n: -sum(m.m_VertexData.m_VertexCount for _, m in groups[n]["parts"].values()))
    out = []
    for k, n in enumerate(order):
        sub = "" if k == 0 else "__" + em.safe(re.sub("Avatar$", "", n))
        fn = f"{key}{sub}.glb"
        res = write_character(groups[n]["avatar"], list(groups[n]["parts"].values()), clips[n], os.path.join(out_dir, fn))
        if res: out.append({"file": fn, **res, "skeleton": sigs[n], **({"clipsFrom": borrowed[n]} if n in borrowed else {})})
    return out

def jobs():
    """(index section, key, bundles): units and spells (+ their statue), statue-only units, towers and structures."""
    units = {re.match(r"unitassets_(?:unit|spell)_(.+)\.bundle$", os.path.basename(p)).group(1) for p in glob.glob(B + "/unitassets_unit_*.bundle")}
    for p in sorted(glob.glob(B + "/unitassets_unit_*.bundle") + glob.glob(B + "/unitassets_spell_*.bundle")):
        bundle = os.path.basename(p); cat, x = re.match(r"unitassets_(unit|spell)_(.+)\.bundle$", bundle).groups()
        statue = f"unitstatue_{x}.bundle"
        yield "units", (x if cat == "unit" else f"spell_{x}"), [bundle] + ([statue] if os.path.exists(f"{B}/{statue}") else []), cat, x
    for p in sorted(glob.glob(B + "/unitstatue_*.bundle")):
        x = re.match(r"unitstatue_(.+)\.bundle$", os.path.basename(p)).group(1)
        if x not in units and not os.path.exists(f"{B}/unitassets_spell_{x}.bundle"): yield "units", x, [os.path.basename(p)], "unit", x
    for p in sorted(glob.glob(B + "/unitassets_poi_*.bundle") + glob.glob(B + "/cosmetics_skins_structure_*.bundle")):
        bundle = os.path.basename(p)
        x = re.sub(r"^(unitassets_poi_|cosmetics_skins_structure_)(structure)?|\.bundle$", "", bundle)
        if "template" in x or x == "default": continue
        yield "structures", (f"skin_{x}" if bundle.startswith("cosmetics_") else x), [bundle], "structure", x
    yield "structures", "arclightguard", ["shared_ftue.bundle", "shared_ftue_embedded.bundle"], "structure", "arclightguard"

PROJECTILE = re.compile(r"Missile|^BatRiderBomb")

# RUMBLE_SHARD splits the work over several processes started side by side: "i/n" does every n-th piece and leaves its
# part of the index in parts/<i>.json; "merge", run after them, puts the parts together into the index.
SHARD = os.environ.get("RUMBLE_SHARD", "")
MINE = (lambda i: True) if "/" not in SHARD else (lambda i, k=int(SHARD.split("/")[0]), n=int(SHARD.split("/")[1]): i % n == k)
def parts_dir(out): d = os.path.join(out, "parts"); os.makedirs(d, exist_ok=True); return d
def load_parts(out): return [json.load(open(os.path.join(parts_dir(out), f), encoding="utf8")) for f in sorted(os.listdir(parts_dir(out)))]
def save_part(out, data): json.dump(data, open(os.path.join(parts_dir(out), SHARD.split("/")[0] + ".json"), "w", encoding="utf8"))

def main():
    os.makedirs(OUT, exist_ok=True)
    index_path = os.path.join(OUT, "index.json")
    # (split over processes, each starts empty: an index from an earlier run would put its old entries in every part)
    index = json.load(open(index_path, encoding="utf8")) if ONLY and not SHARD and os.path.exists(index_path) else {}
    def run(sec, key, bundles, cat, x, borrow=None):
        try: chars = export_set(key, bundles, OUT, borrow)
        except Exception as e: print("   FAILED", e); chars = []
        section = index.setdefault(sec, {})
        if not chars: section.pop(key, None); return
        main_char = {k: v for k, v in chars[0].items() if k != "avatar"}
        entry = {**main_char, "bundles": bundles}
        if len(chars) > 1: entry["others"] = chars[1:]
        if sec == "units":
            d = em.by_bundle.get(f"{cat}_{x}") or em.by_bundle.get(f"unit_{x}")
            mini = em.minis.get(d["slug"]) if d and d.get("slug") else None
            entry = {"name": mini["name"] if mini else (d["internal"] if d else x.capitalize()), "slug": d.get("slug") if d else None,
                     "collectible": bool(mini), **entry}
        else:
            entry = {"name": x.replace("_", " ").title(), **entry}
        section[key] = entry

    todo = [j for j in jobs() if not ONLY or ONLY.search(j[1])]
    for part in (load_parts(OUT) if SHARD == "merge" else []):
        for sec, entries in part.items(): index.setdefault(sec, {}).update(entries)
    for i, job in enumerate(todo):
        if SHARD == "merge" or not MINE(i): continue
        print(job[1], flush=True); run(*job)
    if "/" in SHARD: save_part(OUT, {s: index.get(s, {}) for s in ("units", "structures")}); return
    # second pass: skeletons without clips take them from a unit or structure with the same skeleton that has its own
    donors = {}
    for s in ("units", "structures"):
        for u in index.get(s, {}).values():
            for c in [u] + u.get("others", []):
                names = [x["name"] for x in c.get("clips", [])]
                if not poses_only(names) and not c.get("clipsFrom") and c.get("skeleton"):
                    best = donors.get(c["skeleton"])
                    if not best or len(c["clips"]) > best["n"]:
                        donors[c["skeleton"]] = {"file": c["file"], "bundles": u["bundles"], "n": len(c["clips"])}
    for sec, key, bundles, cat, x in todo:
        u = index.get(sec, {}).get(key)
        if u and any(poses_only(x["name"] for x in c.get("clips", [])) and c.get("skeleton") in donors
                     and donors[c["skeleton"]]["file"] != c["file"] for c in [u] + u.get("others", [])):
            print(key, "(borrowing clips)", flush=True); run(sec, key, bundles, cat, x, donors)
    # projectiles: the missiles a unit or tower fires, named after its file's character (bombs a unit drops count too,
    # walking and flying bombs are summoned units); tower ones also name the tower type they belong to
    for s in ("units", "structures"):
        for u in index.get(s, {}).values():
            u.pop("projectiles", None)
            for c in u.get("others", []):
                c.pop("role", None); c.pop("tower", None)
                if not PROJECTILE.search(c.get("avatar", "")): continue
                c["role"] = "projectile"
                t = re.search(r"Top(Guard|Rocket|Dragon)", c["avatar"])
                if s == "structures" and t: c["tower"] = t.group(1).lower()
                u.setdefault("projectiles", []).append(c["file"])
    for k, sz in em.unit_sizes().items():
        if k in index.get("units", {}): index["units"][k]["size"] = sz
    index["source"] = "Warcraft Rumble game files; one rigged glTF per skeleton (riders and mounts share one) with its clips, x mirrored"
    index["units"] = dict(sorted(index.get("units", {}).items()))
    index["structures"] = dict(sorted(index.get("structures", {}).items()))
    index["bySlug"] = {u["slug"]: k for k, u in index["units"].items() if u.get("slug")}
    json.dump(index, open(index_path, "w", encoding="utf8"), indent=1, ensure_ascii=False)
    print(len(index["units"]), "units,", len(index["structures"]), "structures,",
          sum(1 + len(u.get("others", [])) for s in ("units", "structures") for u in index[s].values()), "files")

if __name__ == "__main__": main()
