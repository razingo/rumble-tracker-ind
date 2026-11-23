# Exports battle maps from the game's bundles: the painted ground texture, the whole scene as glTF (.glb, with its
# baked lightmap) and an index tying each map/version to its files. Only the maps whose names match the filter
# (extract.mjs gives the ones the backdrops are drawn from).
# usage: python -I export_maps.py [out_dir] [map filter regex]
#   out_dir defaults to maps in the working folder
#
# How a map is stored:
#   mission_<map>.bundle                  the map's own art library (terrain prefab, props, ground textures)
#   mission_<map>_<version>.bundle        one playable version: its terrain plane, collision, baked lightmap
#   mission_<map>_<version>_propsets.bundle   the scene of that version: everything under PropSetInfo, most props
#                                         merged ("static batched") into large meshes already in world space
#   zone_<zone>.bundle, shared_*.bundle   props and materials shared by a zone / the whole game
# Units, towers and bases are placed by the game at run time and are not part of the scene.
import os, re, sys, json, glob, math, struct, UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

ROOT = os.environ["RUMBLE_WORK"]  # the working folder: exports, indexes, the tables read
B = os.environ["RUMBLE_BUNDLES"].replace("\\", "/")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "maps")
ONLY = re.compile(sys.argv[2]) if len(sys.argv) > 2 else None
TEX_DIR = os.path.join(OUT, "textures")

# bundle -> the bundles it refers to (build_indexes.py)
EXT = json.load(open(os.path.join(ROOT, "ext_index.json")))

def closure(bundles, depth=4):
    seen, todo = set(bundles), list(bundles)
    for _ in range(depth):
        nxt = []
        for b in todo:
            for e in EXT.get(b, ()):
                if e not in seen and not e.startswith(("shaders", "shared_shaders")): seen.add(e); nxt.append(e)
        todo = nxt
    return seen

# ---- small matrix helpers (row-major 4x4) ------------------------------------------------------------------------
def mat_trs(t, q, s):
    x, y, z, w = q.x, q.y, q.z, q.w
    r = [[1 - 2*(y*y + z*z), 2*(x*y - z*w), 2*(x*z + y*w)],
         [2*(x*y + z*w), 1 - 2*(x*x + z*z), 2*(y*z - x*w)],
         [2*(x*z - y*w), 2*(y*z + x*w), 1 - 2*(x*x + y*y)]]
    return [[r[0][0]*s.x, r[0][1]*s.y, r[0][2]*s.z, t.x],
            [r[1][0]*s.x, r[1][1]*s.y, r[1][2]*s.z, t.y],
            [r[2][0]*s.x, r[2][1]*s.y, r[2][2]*s.z, t.z], [0, 0, 0, 1]]
def mul(a, b): return [[sum(a[i][k]*b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]
IDENT = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]

def world(tr):
    m = mat_trs(tr.m_LocalPosition, tr.m_LocalRotation, tr.m_LocalScale)
    f = tr.m_Father
    if f and f.path_id:
        try: m = mul(world(f.read()), m)
        except Exception: pass
    return m

def active(go, tr):
    """A GameObject is drawn only if it and all its parents are active."""
    while True:
        if not go.m_IsActive: return False
        f = tr.m_Father
        if not (f and f.path_id): return True
        tr = f.read(); go = tr.m_GameObject.read()

def safe(s): return re.sub(r"[^A-Za-z0-9_.-]+", "_", s).strip("_") or "unnamed"

# ---- textures: one shared folder, so maps of the same zone share files ------------------------------------------
SAVED = {}
def save_tex(t):
    key = (t.m_Name, t.m_Width, t.m_Height)
    if key in SAVED: return SAVED[key]
    fn = safe(t.m_Name) + ".png"
    n = 1
    while fn in SAVED.values(): n += 1; fn = f"{safe(t.m_Name)}_{n}.png"
    path = os.path.join(TEX_DIR, fn)
    if not os.path.exists(path):
        try: t.image.save(path)
        except Exception as e: print("   texture failed", t.m_Name, e); SAVED[key] = None; return None
    SAVED[key] = fn
    return fn

def save_lightmap(t):
    """Baked lightmaps are RGBM (light = rgb * alpha * 5, gamma space). Saved decoded as light / 2, so mid-grey is
    'unchanged' and up to 2x brightening fits: multiply the base colour by 2 * this texture."""
    key = ("lightmap", t.m_Name, t.m_Width, t.m_Height)
    if key in SAVED: return SAVED[key]
    from PIL import Image
    fn = f"{safe(t.m_Name)}_light.png"; n = 1
    while fn in SAVED.values(): n += 1; fn = f"{safe(t.m_Name)}_{n}_light.png"
    path = os.path.join(TEX_DIR, fn)
    if not os.path.exists(path):
        im = t.image.convert("RGBA")
        # per pixel: out = min(255, c * a * 5 / 2 / 255)
        px = [(min(255, cr * ca * 5 // 510), min(255, cg * ca * 5 // 510), min(255, cb * ca * 5 // 510))
              for cr, cg, cb, ca in im.getdata()]
        out = Image.new("RGB", im.size); out.putdata(px); out.save(path)
    SAVED[key] = fn
    return fn

COLOR_PROPS = ("_BaseMap", "_MainTex", "_BaseColorMap", "_ColorMap", "_Albedo", "_Diffuse")
def material_info(mat):
    texs = {}
    for name, te in mat.m_SavedProperties.m_TexEnvs:
        if te.m_Texture and te.m_Texture.path_id:
            try: texs[name] = te.m_Texture.read()
            except Exception: pass
    color = next((texs[p] for p in COLOR_PROPS if p in texs), None) or \
        next((t for t in texs.values() if re.search("color|diffuse|albedo", t.m_Name, re.I)), None)
    cols = dict(mat.m_SavedProperties.m_Colors)
    floats = dict(mat.m_SavedProperties.m_Floats)
    tint = cols.get("_BaseColor") or cols.get("_Color")
    kw = " ".join(getattr(mat, "m_ValidKeywords", None) or []) + " " + (getattr(mat, "m_ShaderKeywords", "") or "")
    cutout = "_ALPHATEST_ON" in kw or floats.get("_AlphaClip", 0) > 0.5
    transparent = floats.get("_Surface", 0) > 0.5
    return {"name": mat.m_Name, "color": save_tex(color) if color else None,
            "tint": [tint.r, tint.g, tint.b, tint.a] if tint else [1, 1, 1, 1],
            "cutoff": floats.get("_Cutoff", 0.5) if cutout else None, "transparent": transparent}

# ---- glTF writer -------------------------------------------------------------------------------------------------
class Gltf:
    def __init__(self):
        self.bin = bytearray(); self.views = []; self.accs = []; self.meshes = []; self.nodes = []
        self.mats = []; self.mat_index = {}; self.images = []; self.img_index = {}; self.textures = []
    def view(self, data, target=None):
        while len(self.bin) % 4: self.bin += b"\0"
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target: v["target"] = target
        self.bin += data; self.views.append(v); return len(self.views) - 1
    def acc(self, values, comp, typ, target, minmax=False):
        n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[typ]
        fmt = {5126: "f", 5125: "I"}[comp]
        flat = [c for v in values for c in (v if n > 1 else (v,))]
        a = {"bufferView": self.view(struct.pack(f"<{len(flat)}{fmt}", *flat), target), "componentType": comp,
             "count": len(values), "type": typ}
        if minmax:
            a["min"] = [min(v[i] for v in values) for i in range(n)]; a["max"] = [max(v[i] for v in values) for i in range(n)]
        self.accs.append(a); return len(self.accs) - 1
    def image(self, fn):
        if fn not in self.img_index:
            self.images.append({"uri": f"../textures/{fn}"}); self.textures.append({"source": len(self.images) - 1})
            self.img_index[fn] = len(self.textures) - 1
        return self.img_index[fn]
    def material(self, info, lightmap):
        key = (info["name"], info["color"], lightmap)
        if key in self.mat_index: return self.mat_index[key]
        m = {"name": info["name"], "pbrMetallicRoughness": {"baseColorFactor": info["tint"], "metallicFactor": 0,
                                                             "roughnessFactor": 1}}
        if info["color"]: m["pbrMetallicRoughness"]["baseColorTexture"] = {"index": self.image(info["color"])}
        if info["cutoff"] is not None: m["alphaMode"] = "MASK"; m["alphaCutoff"] = info["cutoff"]; m["doubleSided"] = True
        elif info["transparent"]: m["alphaMode"] = "BLEND"
        if lightmap:  # baked light: kept as the occlusion slot (2nd UV set) and named in extras
            m["occlusionTexture"] = {"index": self.image(lightmap), "texCoord": 1}
            m["extras"] = {"lightmap": f"../textures/{lightmap}", "lightmapScale": 2}
        self.mats.append(m); self.mat_index[key] = len(self.mats) - 1
        return self.mat_index[key]
    def add(self, name, pos, nrm, uv0, uv1, prims):
        """prims: [(indices, material index)]; vertex data already in glTF space."""
        attrs = {"POSITION": self.acc(pos, 5126, "VEC3", 34962, True)}
        if nrm: attrs["NORMAL"] = self.acc(nrm, 5126, "VEC3", 34962)
        if uv0: attrs["TEXCOORD_0"] = self.acc(uv0, 5126, "VEC2", 34962)
        if uv1: attrs["TEXCOORD_1"] = self.acc(uv1, 5126, "VEC2", 34962)
        ps = [{"attributes": attrs, "indices": self.acc(ix, 5125, "SCALAR", 34963), "material": mi} for ix, mi in prims if ix]
        if not ps: return
        self.meshes.append({"name": name, "primitives": ps}); self.nodes.append({"name": name, "mesh": len(self.meshes) - 1})
    def save(self, path):
        doc = {"asset": {"version": "2.0", "generator": "rumble tracker export_maps.py"},
               "scene": 0, "scenes": [{"nodes": list(range(len(self.nodes)))}], "nodes": self.nodes,
               "meshes": self.meshes, "materials": self.mats, "accessors": self.accs, "bufferViews": self.views,
               "buffers": [{"byteLength": len(self.bin)}]}
        if self.images: doc["images"] = self.images; doc["textures"] = self.textures; doc["samplers"] = [{}]
        for t in self.textures: t["sampler"] = 0
        js = json.dumps(doc, separators=(",", ":")).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        while len(self.bin) % 4: self.bin += b"\0"
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(self.bin)))
            f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
            f.write(struct.pack("<II", len(self.bin), 0x004E4942)); f.write(self.bin)

# ---- one map version ---------------------------------------------------------------------------------------------
MESH_CACHE = {}
def mesh_data(mesh, key):
    if key not in MESH_CACHE:
        h = MeshHandler(mesh); h.process()
        ib = h.m_IndexBuffer
        subs = []
        for sm in mesh.m_SubMeshes:
            first = sm.firstByte // (2 if h.m_Use16BitIndices else 4)
            base = getattr(sm, "baseVertex", 0) or 0
            subs.append([i + base for i in ib[first:first + sm.indexCount]] if sm.topology in (0, None) else [])
        MESH_CACHE[key] = (h.m_Vertices, h.m_Normals, h.m_UV0, h.m_UV1, subs)
    return MESH_CACHE[key]

def export_version(base, version, propsets, out_glb):
    env = UnityPy.load(*[os.path.join(B, b) for b in sorted(closure([propsets, version] + ([base] if base else [])))])
    MESH_CACHE.clear()
    scene_files = {propsets, version}
    lightmaps, ground, stats = [], None, {"renderers": 0, "vertices": 0, "triangles": 0}
    for o in env.objects:
        if o.type.name == "LightmapSettings" and o.assets_file.parent and os.path.basename(o.assets_file.parent.name) == propsets:
            for lm in o.read().m_Lightmaps:
                try: lightmaps.append(save_lightmap(lm.m_Lightmap.read()))
                except Exception: lightmaps.append(None)
    g = Gltf()
    for o in env.objects:
        if o.type.name != "MeshRenderer": continue
        bname = os.path.basename(o.assets_file.parent.name) if o.assets_file.parent else ""
        if bname not in scene_files: continue
        try:
            r = o.read()
            if not r.m_Enabled: continue
            go = r.m_GameObject.read()
            comps = [getattr(x, "component", x) for x in go.m_Component]
            tr = next(c.read() for c in comps if c.type.name in ("Transform", "RectTransform"))
            if not active(go, tr): continue
            mf = next((c.read() for c in comps if c.type.name == "MeshFilter"), None)
            if not mf or not mf.m_Mesh.path_id: continue
            mesh = mf.m_Mesh.read()
            mats = []
            for mp in r.m_Materials:
                try: mats.append(material_info(mp.read()))
                except Exception: mats.append(None)
        except Exception as e:
            if "default resources" not in str(e): print("   skipped:", e)
            continue
        if any(m and re.search(r"(^|_)FX(_|$)|Shadow|Water_Caustic", m["name"], re.I) for m in mats) and not any(m and m["color"] for m in mats):
            continue
        # (keyed by where the mesh lives: id() of a freed object can come back for another mesh)
        V, N, U0, U1, subs = mesh_data(mesh, (mesh.assets_file.name, mf.m_Mesh.path_id))
        sb = r.m_StaticBatchInfo
        if sb.subMeshCount > 0: sub_ids, M = list(range(sb.firstSubMesh, sb.firstSubMesh + sb.subMeshCount)), IDENT
        else: sub_ids, M = list(range(len(subs))), world(tr)
        used = sorted({i for s in sub_ids if s < len(subs) for i in subs[s]})
        if not used: continue
        remap = {v: k for k, v in enumerate(used)}
        def P(i):
            x, y, z = V[i][:3]
            return (-(M[0][0]*x + M[0][1]*y + M[0][2]*z + M[0][3]), M[1][0]*x + M[1][1]*y + M[1][2]*z + M[1][3],
                    M[2][0]*x + M[2][1]*y + M[2][2]*z + M[2][3])
        pos = [P(i) for i in used]
        nrm = None
        if N:
            nrm = []
            for i in used:
                x, y, z = N[i][:3]
                a = (M[0][0]*x + M[0][1]*y + M[0][2]*z, M[1][0]*x + M[1][1]*y + M[1][2]*z, M[2][0]*x + M[2][1]*y + M[2][2]*z)
                l = math.sqrt(a[0]**2 + a[1]**2 + a[2]**2) or 1
                nrm.append((-a[0]/l, a[1]/l, a[2]/l))
        uv0 = [(U0[i][0], 1 - U0[i][1]) for i in used] if U0 else None
        lm_idx = r.m_LightmapIndex
        lm = lightmaps[lm_idx] if 0 <= lm_idx < len(lightmaps) else None
        uv1 = None
        if lm:
            src = U1 or U0
            so = r.m_LightmapTilingOffset
            uv1 = [(src[i][0]*so.x + so.z, 1 - (src[i][1]*so.y + so.w)) for i in used]
        prims = []
        for k, s in enumerate(sub_ids):
            if s >= len(subs): continue
            info = mats[k] if k < len(mats) else (mats[-1] if mats else None)
            info = info or {"name": "missing", "color": None, "tint": [0.6, 0.6, 0.6, 1], "cutoff": None, "transparent": False}
            idx = subs[s]
            tri = []
            for t in range(0, len(idx) - 2, 3):  # mirrored on x: flip the winding
                tri += [remap[idx[t]], remap[idx[t+2]], remap[idx[t+1]]]
            prims.append((tri, g.material(info, lm)))
            stats["triangles"] += len(tri) // 3
            if info["color"] and re.search("terrain", info["name"] + info["color"], re.I) and not ground:
                ground = info["color"]
        g.add(go.m_Name, pos, nrm, uv0, uv1, prims)
        stats["renderers"] += 1; stats["vertices"] += len(pos)
    if not g.nodes: return None
    g.save(out_glb)
    return {"lightmaps": [l for l in lightmaps if l], "ground": ground, **stats}

# ---- all maps ----------------------------------------------------------------------------------------------------
def main():
    os.makedirs(TEX_DIR, exist_ok=True); os.makedirs(os.path.join(OUT, "scenes"), exist_ok=True)
    bases = {os.path.basename(p)[len("mission_"):-len(".bundle")] for p in glob.glob(B + "/mission_*.bundle")
             if not p.endswith("_propsets.bundle")}
    index_path = os.path.join(OUT, "index.json")
    index = json.load(open(index_path, encoding="utf8")) if ONLY and os.path.exists(index_path) else {"maps": {}}
    maps = index["maps"]
    for p in sorted(glob.glob(B + "/mission_*_propsets.bundle")):
        propsets = os.path.basename(p)
        vname = propsets[len("mission_"):-len("_propsets.bundle")]
        version = f"mission_{vname}.bundle"
        # the map is the longest bundle name that is a prefix of the version ("hogger" for "hogger_v13")
        mname = max((b for b in bases if vname.startswith(b + "_") and b != vname), key=len, default=None) or vname
        if ONLY and not ONLY.search(vname): continue
        base = f"mission_{mname}.bundle" if mname != vname and os.path.exists(f"{B}/mission_{mname}.bundle") else None
        print(propsets, flush=True)
        try: res = export_version(base, version if os.path.exists(f"{B}/{version}") else propsets, propsets,
                                  os.path.join(OUT, "scenes", vname + ".glb"))
        except Exception as e: print("   FAILED", e); res = None
        m = maps.setdefault(mname, {"versions": {}})
        if base: m["bundle"] = base
        if res:
            m["versions"][vname] = {"scene": f"scenes/{vname}.glb", "bundles": [b for b in (version, propsets)],
                                    "ground": f"textures/{res['ground']}" if res["ground"] else None,
                                    "lightmaps": [f"textures/{l}" for l in res["lightmaps"]],
                                    "renderers": res["renderers"], "vertices": res["vertices"], "triangles": res["triangles"]}
        else: m["versions"].pop(vname, None)
    # ground textures of each map's own bundle (all versions' terrain art, also older ones)
    for mname, m in maps.items():
        if ONLY and not any(ONLY.search(v) for v in m["versions"]) and not ONLY.search(mname): continue
        if not m.get("bundle"): continue
        gl = []
        for o in UnityPy.load(os.path.join(B, m["bundle"])).objects:
            if o.type.name == "Texture2D" and re.search(r"Terrain.*Color|Ground.*Color", o.peek_name() or "", re.I):
                fn = save_tex(o.read())
                if fn: gl.append(f"textures/{fn}")
        m["groundTextures"] = gl
    index["source"] = "Warcraft Rumble game files (mission_* bundles); scenes as glTF, x mirrored from Unity's left-handed space"
    index["maps"] = dict(sorted(maps.items()))
    json.dump(index, open(index_path, "w", encoding="utf8"), indent=1, ensure_ascii=False)
    print(len(maps), "maps,", sum(len(m["versions"]) for m in maps.values()), "versions")

main()
