# Exports 3D models (OBJ, rest pose) and their textures (PNG) from the game's bundles, plus an index that ties each
# to its files: the ones whose names match the filter (extract.mjs gives the towers the sprite list names).
# usage: python -I export_models.py [out_dir] [name filter regex]
#   out_dir defaults to models in the working folder
#
# Where the models are:
#   unitassets_unit_<x>.bundle   the unit as it appears in battle; its renderers usually point at a mesh and textures
#                                kept in another bundle (often unitstatue_<x>), found through the CAB index
#   unitassets_spell_<x>.bundle  spells; only the ones that summon something have real models
#   unitstatue_<x>.bundle        the pose/statue version used in menus (higher-resolution textures)
# Meshes come out in their bind (rest) pose: skeletons and animations are not exported.
import os, re, sys, json, glob, UnityPy

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ["RUMBLE_WORK"]  # the working folder: exports, indexes, the tables read
B = os.environ["RUMBLE_BUNDLES"].replace("\\", "/")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "models")
ONLY = re.compile(sys.argv[2]) if len(sys.argv) > 2 else None
FX = re.compile(r"(^|_)FX(_|$)|_Fx_|Swoosh|Terrain", re.I)

# ---- the indexes build_indexes.py made --------------------------------------------------------------------------------
# CAB name -> bundle file (renderers reference meshes and materials in other bundles by CAB name)
CABS = json.load(open(os.path.join(ROOT, "cab_index.json")))
# bundle -> the bundles it refers to
EXT = {b: set(v) for b, v in json.load(open(os.path.join(ROOT, "ext_index.json"))).items()}
def closure(bundle, depth=3):
    """The bundle plus the bundles it refers to (a few levels: renderer -> material -> texture)."""
    seen, todo = {bundle}, [bundle]
    for _ in range(depth):
        nxt = []
        for b in todo:
            for e in EXT.get(b, ()):
                # shared shader/default bundles are big and hold no unit models
                if e not in seen and not e.startswith(("shared_shaders", "shaders")): seen.add(e); nxt.append(e)
        todo = nxt
    return seen

def load_lazy(*bundles):
    """These bundles alone, in name order; a bundle they refer to is loaded when a pointer into it is first followed.
    Only the bundles closure() gives for them are, so a pointer resolves exactly when it would with all of those loaded
    at once, which is what this replaces: dozens of bundles held in memory for the few that are read."""
    allowed = set().union(*[closure(b) for b in bundles])
    env = UnityPy.load(*[os.path.join(B, b) for b in sorted(bundles)])
    loaded = set(bundles)
    def find_file(name, is_dependency=True):
        cab = env.get_cab(name)
        if cab: return cab
        b = CABS.get(os.path.basename(name).lower())
        if b and b in allowed and b not in loaded:
            loaded.add(b)
            env.load_file(os.path.join(B, b), is_dependency=True)
            cab = env.get_cab(name)
            if cab: return cab
        raise FileNotFoundError(f"File {name} not found")
    env.find_file = find_file  # what PPtr.deref asks when a pointer leads out of its own bundle
    return env

# ---- names: minis from the game-built tables, everything else by its bundle name ----------------------------------
minis = {m["slug"]: m for m in json.load(open(os.path.join(ROOT, "gamedata", "minis.json"), encoding="utf8"))["minis"]}
defs = json.load(open(os.path.join(ROOT, "all_mini_definitions.json"), encoding="utf8"))
by_bundle = {}
for d in defs:
    key = d["bundle"].replace("unitdata_", "").replace(".bundle", "")  # unit_footmen / spell_blizzard
    # several definitions can share a bundle (Anub'arak and his scarabs): the collectible mini wins
    if key not in by_bundle or (d.get("slug") in minis and by_bundle[key].get("slug") not in minis): by_bundle[key] = d

def safe(s): return re.sub(r"[^A-Za-z0-9_.-]+", "_", s).strip("_") or "unnamed"

def tex_props(mat):
    out = {}
    for name, te in mat.m_SavedProperties.m_TexEnvs:
        if not te.m_Texture or not te.m_Texture.path_id: continue
        try: out[name] = te.m_Texture.read()
        except Exception: pass
    return out

def export_bundle(bundle, out_dir):
    env = load_lazy(bundle)
    own = [f for f in env.files.values() if os.path.basename(getattr(f, "name", "") or "") == bundle]
    own_objs = [o for f in own for sf in f.files.values() if hasattr(sf, "objects") for o in sf.objects.values()]
    meshes, textures, done = [], {}, set()
    os.makedirs(out_dir, exist_ok=True)

    def save_tex(t):
        fn = safe(t.m_Name) + ".png"
        if fn not in textures:
            try: t.image.save(os.path.join(out_dir, fn)); textures[fn] = [t.m_Width, t.m_Height]
            except Exception as e: print("   texture failed", t.m_Name, e); return None
        return fn

    for o in own_objs:
        t = o.type.name
        if t not in ("SkinnedMeshRenderer", "MeshRenderer"): continue
        try:
            r = o.read()
            go = r.m_GameObject.read()
            if t == "SkinnedMeshRenderer": mesh_ptr = r.m_Mesh
            else:
                mf = next((c for c in (p.read() for p in (getattr(x, "component", x) for x in go.m_Component)) if type(c).__name__ == "MeshFilter"), None)
                mesh_ptr = mf.m_Mesh if mf else None
            if not mesh_ptr or not mesh_ptr.path_id: continue
            mesh = mesh_ptr.read()
        except Exception as e:
            if "default resources" not in str(e): print("   renderer skipped:", e)
            continue  # (Unity's built-in quads and spheres: effects, not models)
        if FX.search(mesh.m_Name) or FX.search(go.m_Name): continue
        key = (mesh_ptr.file_id and getattr(mesh_ptr, "external_name", None) or "", mesh_ptr.path_id, mesh.m_Name)
        mats = []
        for mp in r.m_Materials:
            try: mats.append(mp.read())
            except Exception: pass
        # effect meshes (icicles, glows); a skinned body can still use an "FX" material (Core Hounds' glowing skin)
        if mats and t != "SkinnedMeshRenderer" and all(FX.search(m.m_Name) for m in mats): continue
        texs = {}
        for m in mats:
            for prop, tx in tex_props(m).items():
                fn = save_tex(tx)
                if fn: texs.setdefault(prop, fn)
        if key in done:
            continue
        done.add(key)
        fn = safe(mesh.m_Name)
        while any(x["obj"] == fn + ".obj" for x in meshes): fn += "_"
        try: data = mesh.export()
        except Exception as e: print("   mesh failed", mesh.m_Name, e); continue
        color = next((texs[p] for p in ("_BaseMap", "_MainTex", "_BaseColorMap", "_ColorMap", "_Albedo") if p in texs), None) \
            or next((v for v in texs.values() if re.search("color|diffuse|albedo", v, re.I)), None)
        if color:
            open(os.path.join(out_dir, fn + ".mtl"), "w").write(f"newmtl {fn}\nKd 1 1 1\nmap_Kd {color}\n")
            data = f"mtllib {fn}.mtl\nusemtl {fn}\n" + data
        open(os.path.join(out_dir, fn + ".obj"), "w").write(data)
        meshes.append({"mesh": mesh.m_Name, "gameObject": go.m_Name, "obj": fn + ".obj",
                       "renderer": "skinned" if t == "SkinnedMeshRenderer" else "static",
                       "materials": [m.m_Name for m in mats], "textures": texs, "color": color,
                       "vertices": data.count("\nv ")})
    # textures in the unit's own bundle that no renderer picked up (e.g. a model drawn by a shared material)
    for o in own_objs:
        if o.type.name == "Texture2D":
            n = o.peek_name() or ""
            if re.search(r"_Tex_(Color|Normal|Metal)", n) and not FX.search(n): save_tex(o.read())
    if not meshes and not textures:
        os.rmdir(out_dir) if not os.listdir(out_dir) else None
        return None
    return {"meshes": meshes, "textures": textures}

def typ(r): return r.get("$type", "").split(",")[0].rsplit(".", 1)[-1]  # Gryphon.Data record type

_records = None
def unit_records():
    """Every Gryphon.Data record (JSON TextAssets) in unitdata_*, talentdata_* and shared_*: ({guid: record},
    {unit key: [its bundle's records]}), unit key = <x> for unitdata_unit_<x>, spell_<x> for unitdata_spell_<x>."""
    global _records
    if _records: return _records
    recs, by_key = {}, {}
    for p in sorted(glob.glob(B + "/unitdata_*.bundle")) + sorted(glob.glob(B + "/talentdata_*.bundle")) + sorted(glob.glob(B + "/shared_*.bundle")):
        m = re.match(r"unitdata_(unit|spell)_(.+)\.bundle$", os.path.basename(p))
        mine = by_key.setdefault((m[2] if m[1] == "unit" else f"spell_{m[2]}") if m else None, [])
        for o in UnityPy.load(p).objects:
            if o.type.name != "TextAsset": continue
            s = o.read().m_Script
            try: j = json.loads(s if isinstance(s, str) else s.decode("utf8", "replace"))
            except ValueError: continue
            if isinstance(j, dict) and j.get("guid"): recs[j["guid"]] = j; mine.append(j)
    by_key.pop(None, None)
    _records = recs, by_key
    return _records

def unit_sizes():
    """In-game size of each unit, from the unitdata_* bundles (Gryphon.Data JSON in TextAssets): the collision
    cylinder (radius and height in world units; flyers have a negative heightOffset) and the model scale of the
    units its card spawns, with how many it spawns (only the collectible card; indirect spawns are followed).
    Bundles without a card (NPCs) list all their creatures.
    Records are looked up across all bundles: squads like Warsong Grunts use another unit's collider."""
    recs, by_key = unit_records()
    collectible_cards = {d["guid"] for d in defs}
    num = lambda v: round(float(v), 2)
    name = lambda u: re.sub(r"_Unit$", "", u["name"])
    def size(u):
        # the unit's aspects plus its default talent slot (the one without a talent; Warsong Grunts keep the collider there)
        base = [a for t in u.get("m_talents", []) if not t.get("m_talent") for a in t.get("m_aspects", [])]
        asp = [recs[a] for a in u.get("m_aspects", []) + base if a in recs]
        # (spawners have a non-colliding placeholder; eggs leave the radius at its default, written as null)
        col = next((a for a in asp if typ(a) == "AspectColliderCylinder" and a.get("m_worldLayer") == "Unit"), None)
        flags = u.get("m_unitFlags") or ""
        # stationary leaders (Ragnaros, Ysera) have no collider: listed with the collider values empty
        if not col and not ("Creature" in flags and "Stationary" in flags or "LargeGroundUnit" in flags): return None
        col = col or {}
        model = next((a for a in asp if typ(a) == "AspectModel"), None)
        return {"unit": name(u), "radius": num(col["m_radius"]) if "m_radius" in col else None,
                "height": num(col["m_height"]) if "m_height" in col else None, "heightOffset": num(col.get("m_heightOffset", 0)) if col else None,
                "scale": num(model.get("m_scale", "1").split(",")[0]) if model else None,
                "pushWeight": col.get("m_pushWeight"), "flying": "FlyingUnit" in flags, "stationary": "Stationary" in flags}
    out = {}
    for key, mine in by_key.items():
        sizes = {}
        # only the collectible card when there is one: bundles also hold raid-boss and AI-only cards (Ragnaros, Gnomish
        # Flying Machine)
        cards = [r for r in mine if typ(r) == "Mini"]
        cards = [r for r in cards if r["guid"] in collectible_cards] or cards
        for card in cards:  # a card's spawn list has one entry per copy
            spawned = [recs[sp["m_assetReference"]] for sp in card.get("m_spawns", []) if sp.get("m_assetReference") in recs]
            for u in spawned:
                if (x := size(u)): sizes.setdefault(x["unit"], {**x, "count": 0})
            for n in {name(u) for u in spawned} & sizes.keys():  # the same unit on two cards (talent variants) counts once
                sizes[n]["count"] = max(sizes[n]["count"], sum(name(u) == n for u in spawned))
        if not sizes:  # spawned indirectly (Ragnaros rises from a lava puddle, the Flying Machine drops its pilot):
            # follow the records the spawned units reference, nearest first, to the first creatures with a collider
            seen = set(); level = [sp["m_assetReference"] for c in cards for sp in c.get("m_spawns", []) if sp.get("m_assetReference") in recs]
            for _ in range(8):
                found = [x for g in level if typ(recs[g]) == "Unit" and (x := size(recs[g])) and "Creature" in (recs[g].get("m_unitFlags") or "")]
                if found:
                    for x in found: sizes.setdefault(x["unit"], x)
                    break
                seen.update(level)
                refs = lambda r: json.dumps({k: v for k, v in r.items() if k not in ("guid", "m_talents")}) + json.dumps(
                    [t for t in r.get("m_talents", []) if not t.get("m_talent")])  # the default talent slot, not the talents
                level = list(dict.fromkeys(g for p in level for g in re.findall(r"[0-9a-f]{32}", refs(recs[p])) if g in recs and g not in seen))
        if not sizes and not cards:  # no card (NPCs): every creature in the bundle
            for u in mine:
                if typ(u) == "Unit" and "Creature" in (u.get("m_unitFlags") or "") and (x := size(u)): sizes.setdefault(x["unit"], x)
        natural = lambda x: [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", x["unit"])]
        if sizes: out[key] = sorted(sizes.values(), key=natural)
    return out

def main():
    files = sorted(glob.glob(B + "/unitassets_unit_*.bundle") + glob.glob(B + "/unitassets_spell_*.bundle")
                   + glob.glob(B + "/unitstatue_*.bundle"))
    index_path = os.path.join(OUT, "index.json")
    index = json.load(open(index_path, encoding="utf8")) if ONLY and os.path.exists(index_path) else {"units": {}}
    units = index["units"]
    for p in files:
        bundle = os.path.basename(p)
        m = re.match(r"unit(assets|statue)_(?:(unit|spell)_)?(.+)\.bundle$", bundle)
        kind, cat, x = m.group(1), m.group(2) or "unit", m.group(3)
        if ONLY and not ONLY.search(x): continue
        ukey = x if cat == "unit" else f"spell_{x}"
        # statues of spells don't exist; statue bundles are named like the unit bundle
        if kind == "statue" and x not in {k for k in units} and os.path.exists(f"{B}/unitassets_spell_{x}.bundle"): ukey = f"spell_{x}"
        print(bundle)
        part = "statue" if kind == "statue" else "battle"
        res = export_bundle(bundle, os.path.join(OUT, ukey, part))
        u = units.setdefault(ukey, {})
        d = by_bundle.get(f"{cat}_{x}") or by_bundle.get(f"unit_{x}")
        mini = minis.get(d["slug"]) if d and d.get("slug") else None
        u.update({"name": mini["name"] if mini else (d["internal"] if d else x.capitalize()), "slug": d.get("slug") if d else None,
                  "internal": d["internal"] if d else x, "collectible": bool(mini),
                  "category": mini.get("category") if mini else cat})
        u.setdefault("bundles", {})[part] = bundle
        # a statue with the same model as the battle unit: point at the battle files instead of a second copy
        if res and part == "statue" and u.get("battle"):
            same = {(m["mesh"], m["vertices"]) for m in u["battle"]["meshes"]}
            if all((m["mesh"], m["vertices"]) in same for m in res["meshes"]) and res["meshes"]:
                import shutil; shutil.rmtree(os.path.join(OUT, ukey, part)); u["statue"] = "same as battle"; continue
        if res:
            for mm in res["meshes"]: mm["obj"] = f"{ukey}/{part}/{mm['obj']}"
            u[part] = {"meshes": res["meshes"], "textures": {f"{ukey}/{part}/{k}": v for k, v in res["textures"].items()}}
        else: u.pop(part, None)
    # towers and other map structures: the base game's (unitassets_poi_*: guard/rocket/dragon towers, player base,
    # town hall, gold mine, chests...; their default Arclight meshes live in shared_ftue) and every tower skin
    # (cosmetics_skins_structure_*: tower body, barracks and the guard/rocket/dragon toppers of each skin)
    structures = index.setdefault("structures", {})
    sfiles = sorted(glob.glob(B + "/unitassets_poi_*.bundle") + glob.glob(B + "/cosmetics_skins_structure_*.bundle")
                    + [B + "/shared_ftue.bundle", B + "/shared_ftue_embedded.bundle"])
    for p in sfiles:
        bundle = os.path.basename(p)
        skin = bundle.startswith("cosmetics_")
        x = re.sub(r"^(unitassets_poi_|cosmetics_skins_structure_)(structure)?|\.bundle$", "", bundle)
        if "template" in x or x == "default": continue  # unused template / no models
        key = f"skin_{x}" if skin else x
        if bundle.startswith("shared_ftue"):  # the default guard tower: body + guard topper, and its barracks
            skin, key, x = False, "arclightguard", "arclightguard"
        if ONLY and not ONLY.search(key): continue
        print(bundle)
        res = export_bundle(bundle, os.path.join(OUT, "structures", key))
        if not res:
            if not bundle.startswith("shared_ftue"): structures.pop(key, None)
            continue
        merge = bundle == "shared_ftue_embedded.bundle" and key in structures  # second half of the guard tower
        for mm in res["meshes"]:
            mm["obj"] = f"structures/{key}/{mm['obj']}"
            n = mm["mesh"]
            mm["piece"] = ("barracks" if re.search("Barracks", n) else "missile" if re.search("Missi?le", n)
                           else "topper" if re.search(r"Top(Guard|Rocket|Dragon|Puffer)|ArclightTop", n)
                           else "tower" if re.search("Tower", n) else "other")
        texs = {f"structures/{key}/{k}": v for k, v in res["textures"].items()}
        if merge:
            st = structures[key]; have = {m["obj"] for m in st["meshes"]}
            st["meshes"] += [m for m in res["meshes"] if m["obj"] not in have]; st["textures"].update(texs)
            st["bundle"] = [st["bundle"], bundle] if isinstance(st["bundle"], str) else st["bundle"] + [bundle]
            continue
        structures[key] = {"name": x.replace("_", " ").title(), "kind": "tower skin" if skin else "structure",
                           "bundle": bundle, "meshes": res["meshes"], "textures": texs}
    index["structures"] = dict(sorted(structures.items()))
    index["towers"] = {k: [m["obj"] for m in s["meshes"] if m["piece"] in ("tower", "topper", "barracks")]
                       for k, s in index["structures"].items()
                       if any(m["piece"] in ("tower", "topper", "barracks") for m in s["meshes"])}

    for ukey, u in units.items():
        cat = "spell" if ukey.startswith("spell_") else "unit"
        x = ukey[len("spell_"):] if cat == "spell" else ukey
        d = by_bundle.get(f"{cat}_{x}") or by_bundle.get(f"unit_{x}")
        mini = minis.get(d["slug"]) if d and d.get("slug") else None
        u.update({"name": mini["name"] if mini else (d["internal"] if d else x.capitalize()),
                  "slug": d.get("slug") if d else None, "internal": d["internal"] if d else x,
                  "collectible": bool(mini), "category": mini.get("category") if mini else cat})

    # the main model for quick lookups: the battle unit's biggest skinned mesh (the body, not a weapon, hair or
    # missile skinned to the same rig), else the statue's. A body named after the unit wins over a bigger second
    # form (Pyrewood Villager before its worgen). Some battle bundles hold only props and missiles while the body
    # is in the statue (Allison, Crowd Pummeler): then the statue's body is used.
    for u in units.values():
        best = {}
        for part in ("battle", "statue"):
            sk = [m for m in (u.get(part) if isinstance(u.get(part), dict) else {}).get("meshes", []) if m["renderer"] == "skinned"]
            big = max((m["vertices"] for m in sk), default=0)
            own = lambda m: u["internal"].lower() in m["mesh"].lower().replace("_", "") and m["vertices"] >= big / 2
            sk.sort(key=lambda m: (not own(m), -m["vertices"]))
            if sk: best[part] = sk[0]
        if best:
            m = best.get("battle")
            if not m or ("statue" in best and m["vertices"] < best["statue"]["vertices"] / 2): m = best["statue"]
            u["model"] = m["obj"]; u["texture"] = m["color"] and f"{m['obj'].rsplit('/', 1)[0]}/{m['color']}"
        else:  # no skinned body (props, spells): the biggest static mesh
            st = sorted((m for part in ("battle", "statue") for m in (u.get(part) if isinstance(u.get(part), dict) else {}).get("meshes", [])),
                        key=lambda m: -m["vertices"])
            if st: u["model"] = st[0]["obj"]; u["texture"] = st[0]["color"] and f"{st[0]['obj'].rsplit('/', 1)[0]}/{st[0]['color']}"
            else: u.pop("model", None); u.pop("texture", None)
    for k, sz in unit_sizes().items():
        if k in units: units[k]["size"] = sz
    index["source"] = "Warcraft Rumble game files (unitassets_*/unitstatue_* bundles); models in their rest pose"
    index["bySlug"] = {u["slug"]: k for k, u in sorted(units.items()) if u.get("slug")}
    index["units"] = dict(sorted(units.items()))
    os.makedirs(OUT, exist_ok=True)
    json.dump(index, open(index_path, "w", encoding="utf8"), indent=1, ensure_ascii=False)
    have = sum(1 for u in units.values() if u.get("model"))
    print(f"{len(units)} units, {have} with a model; index: {index_path}")

if __name__ == "__main__":
    main()
