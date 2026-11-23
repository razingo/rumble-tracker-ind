"""Maps and extracts each unit's effects: ability casts, heals, impacts, projectiles, beams, deploy markers.
Run: python -I export_effects.py [out_dir] [unit key regex]

Unit data names the prefabs it shows by asset GUID (AspectModel/AspectModelAttachment.m_model, ImpactVFX.m_impactPrefab,
AspectBeam.m_beamPrefab, m_modelVariants); bundles list their prefabs by that GUID in AssetBundle.m_Container
(asset_index.json, from build_indexes.py). Effects shared between units (heals, burns, death poofs) live in
shared_data/talentdata records, so each unit's own records are followed through what they reference.
Out (<out_dir>):
  index.json         units.<key> = [{record, type, ability, role, prefab, bundle, file}], prefabs.<name> = summary
                     sounds.<key> = [{event, bank, record, trigger, ability, files}] (Wwise events the data plays)
  prefabs/<name>.json  hierarchy: transforms, particle systems (settings per module, texture, mesh, material),
                     meshes, Timeline tracks (bound object, clip start/duration), and the effect's animation
                     clips (Timeline AnimationTracks, Animators) sampled per animated property
  textures/<name>.png, meshes/<name>.obj  what the particles draw
Particles are simulated by the page that draws them (render/effects.html): the JSON has the settings, not baked frames."""
import os, re, sys, json, math, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ["RUMBLE_WORK"]  # the working folder: exports, indexes, the tables read
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "effects")
ONLY = re.compile(sys.argv[2]) if len(sys.argv) > 2 else None
_argv = sys.argv; sys.argv = sys.argv[:1]; sys.path.insert(0, HERE)  # (-I leaves the script folder off the path)
import export_models as em
import export_animations as ea  # clip decoding
sys.argv = _argv
B = em.B
SKIP = {"Mini", "Talent", "Statue", "Family"}  # records that lead to other cards, not to this unit's effects
MODULES = ("InitialModule", "ShapeModule", "EmissionModule", "SizeModule", "RotationModule", "ColorModule", "UVModule",
           "VelocityModule", "LimitVelocityModule", "ClampVelocityModule", "ForceModule", "NoiseModule", "TrailModule", "SubModule")

def prefab_refs(r):
    """(field, guid) for every prefab a record shows."""
    t = em.typ(r)
    out = []
    if t in ("AspectModel", "AspectModelAttachment", "SkinAspectModelOverride", "SkinAspectModelAttachmentOverride"):
        out += [("m_model", r.get("m_model"))] + [("m_modelVariants", v) for v in r.get("m_modelVariants", []) if isinstance(v, str)]
    if t == "ImpactVFX": out.append(("m_impactPrefab", r.get("m_impactPrefab")))
    if t == "AspectBeam": out.append(("m_beamPrefab", r.get("m_beamPrefab")))
    return [(f, g[:32]) for f, g in out if isinstance(g, str) and g]

# --- compact particle settings -----------------------------------------------------------------------------------
def curve(c):
    return [[round(k["time"], 3), round(k["value"], 3)] for k in c.get("m_Curve", [])]

def minmax(v):
    """MinMaxCurve (mode 0 constant, 1 curve, 2 two curves, 3 two constants) -> {const} / {curve, mul} /
    {minCurve, maxCurve, mul} / {min, max}."""
    s = v.get("minMaxState", 0)
    if s == 0: return {"const": round(v["scalar"], 4)}
    if s == 1: return {"curve": curve(v["maxCurve"]), "mul": round(v["scalar"], 4)}
    if s == 2: return {"minCurve": curve(v["minCurve"]), "maxCurve": curve(v["maxCurve"]), "mul": round(v["scalar"], 4)}
    return {"min": round(v["minScalar"], 4), "max": round(v["scalar"], 4)}

def color(c): return [round(c[k], 3) for k in ("r", "g", "b", "a")]

def gradient(g):
    cols = [[round(g[f"ctime{i}"] / 65535, 3), *color(g[f"key{i}"])[:3]] for i in range(g.get("m_NumColorKeys", 0))]
    alph = [[round(g[f"atime{i}"] / 65535, 3), round(g[f"key{i}"]["a"], 3)] for i in range(g.get("m_NumAlphaKeys", 0))]
    return {"colors": cols, "alphas": alph}

def minmax_gradient(v):
    s = v.get("minMaxState", 0)
    if s == 0: return {"color": color(v["maxColor"])}
    if s == 1: return {"gradient": gradient(v["maxGradient"])}
    if s == 2: return {"min": color(v["minColor"]), "max": color(v["maxColor"])}
    if s == 3: return {"minGradient": gradient(v["minGradient"]), "maxGradient": gradient(v["maxGradient"])}
    return {"randomColor": gradient(v["maxGradient"])}

def compact(o):
    """Particle module typetree -> plain values: curves and gradients folded, empty/disabled parts dropped."""
    if isinstance(o, dict):
        if "minMaxState" in o and "scalar" in o: return minmax(o)
        if "minMaxState" in o and "maxColor" in o: return minmax_gradient(o)
        if "m_FileID" in o and "m_PathID" in o: return None
        out = {k: compact(v) for k, v in o.items()}
        return {k: v for k, v in out.items() if v not in (None, [], {})}
    if isinstance(o, list): return [compact(v) for v in o]
    if isinstance(o, float): return round(o, 4)
    return o

# --- prefab extraction ---------------------------------------------------------------------------------------------
def component(c):
    ptr = c.component if hasattr(c, "component") else c[1]
    return ptr.deref()

SHARD, MINE, load_parts, save_part = ea.SHARD, ea.MINE, ea.load_parts, ea.save_part  # the work split over processes

def place(tmp, p):
    """Puts a finished file in its place; another process may have written the same one meanwhile, which is as good."""
    try: os.replace(tmp, p)
    except OSError:
        if os.path.exists(p): os.remove(tmp)
        else: raise

safe = em.safe

def named(o):
    """A file name for a texture or mesh: its name and a number for which object it is. The game has different ones
    under one name, and by the name alone whichever was written first would stand for all of them: another on every
    run, as the processes of a split export write side by side."""
    r = o.object_reader
    return f"{safe(o.m_Name)}.{zlib.crc32(f'{r.assets_file.name}/{r.path_id}'.encode()):08x}"

def save_texture(tex):
    name = named(tex)
    p = os.path.join(OUT, "textures", name + ".png")
    if not os.path.exists(p):
        try: tmp = f"{p}.{os.getpid()}.tmp"; tex.image.save(tmp, "PNG"); place(tmp, p)
        except Exception as e: print("   texture failed", tex.m_Name, e); return None
    return name + ".png"

def save_mesh(mesh):
    name = named(mesh)
    p = os.path.join(OUT, "meshes", name + ".obj")
    if not os.path.exists(p):
        try:
            tmp = f"{p}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf8") as f: f.write(mesh.export())
            place(tmp, p)
        except Exception as e: print("   mesh failed", mesh.m_Name, e); return None
    return name + ".obj"

def material(m):
    mat = m.read()
    sp = mat.m_SavedProperties
    out = {"name": mat.m_Name, "shader": None, "textures": {}, "colors": {}, "floats": {}}
    try: out["shader"] = mat.m_Shader.read().m_ParsedForm.m_Name
    except Exception:
        try: out["shader"] = mat.m_Shader.read().m_Name
        except Exception: pass
    for k, t in em.tex_props(mat).items():
        f = save_texture(t)
        if f: out["textures"][k] = f
    # (a few materials hold an infinite number, which JSON has no way to write: 0 stands for it)
    num = lambda x, places: round(x, places) if math.isfinite(x) else 0
    for k, c in sp.m_Colors: out["colors"][k] = [num(x, 3) for x in (c.r, c.g, c.b, c.a)]
    for k, f in sp.m_Floats: out["floats"][k] = num(f, 4)
    return out

def timeline(director_obj, anim_clips):
    """Tracks of a PlayableDirector's TimelineAsset: type, bound object, clips (start, duration). AnimationTrack clips
    are added to anim_clips as (AnimationClip, start)."""
    pd = director_obj.read_typetree()
    af = director_obj.assets_file
    bind = {}
    for b in pd.get("m_SceneBindings", []):
        try: bind[b["key"]["m_PathID"]] = af.objects[b["value"]["m_PathID"]].read()
        except Exception: pass
    tl = af.objects[pd["m_PlayableAsset"]["m_PathID"]].read_typetree()
    out = {"name": tl.get("m_Name"), "tracks": []}
    def track(pid):
        o = af.objects[pid]; t = o.read_typetree()
        try: cls = af.objects[t["m_Script"]["m_PathID"]].read().m_ClassName if t["m_Script"]["m_FileID"] == 0 else o.read().m_Script.read().m_ClassName
        except Exception: cls = None
        target = bind.get(pid)
        tname = getattr(target, "m_Name", None)
        if tname is None and target is not None:
            try: tname = target.m_GameObject.read().m_Name
            except Exception: pass
        clips = [{"start": round(c.get("m_Start", 0), 3), "duration": round(c.get("m_Duration", 0), 3), "name": c.get("m_DisplayName")}
                 for c in t.get("m_Clips", [])]
        if cls == "AnimationTrack":
            for c in t.get("m_Clips", []):
                try:
                    pa = af.objects[c["m_Asset"]["m_PathID"]].read_typetree()
                    anim_clips.append((af.objects[pa["m_Clip"]["m_PathID"]].read(), round(c.get("m_Start", 0), 3)))
                except Exception: pass
            ic = t.get("m_InfiniteClip", {})
            if ic.get("m_PathID") and not ic.get("m_FileID"):
                try: anim_clips.append((af.objects[ic["m_PathID"]].read(), 0))
                except Exception: pass
        out["tracks"].append({"name": t.get("m_Name"), "type": cls, "target": tname, "clips": clips})
        for ch in t.get("m_Children", []): track(ch["m_PathID"])
    for tr in tl.get("m_Tracks", []):
        try: track(tr["m_PathID"])
        except Exception as e: out["tracks"].append({"error": str(e)})
    out["duration"] = max((c["start"] + c["duration"] for t in out["tracks"] for c in t.get("clips", [])), default=0)
    return out

def extract(go):
    """Prefab -> nested nodes {name, position, rotation, scale, particles?, renderer?, mesh?, timeline?, children}."""
    summary = {"particles": 0, "meshes": 0, "timeline": False, "skinned": False, "clips": 0}
    anim_clips, paths, props, tos = [], [], set(), {}
    def node(g, path=()):
        path = path + (g.m_Name,); paths.append(path)
        n = {"name": g.m_Name}
        if not g.m_IsActive: n["active"] = False  # switched on later by a Timeline or the game
        tr = None
        comps = [component(c) for c in g.m_Component]
        for o in comps:
            t = o.type.name
            if t == "Transform":
                tr = o.read()
                n["position"] = [round(tr.m_LocalPosition.x, 4), round(tr.m_LocalPosition.y, 4), round(tr.m_LocalPosition.z, 4)]
                n["rotation"] = [round(getattr(tr.m_LocalRotation, a), 4) for a in "xyzw"]
                n["scale"] = [round(tr.m_LocalScale.x, 4), round(tr.m_LocalScale.y, 4), round(tr.m_LocalScale.z, 4)]
            elif t == "ParticleSystem":
                ps = o.read_typetree(); summary["particles"] += 1
                n["particles"] = {"length": round(ps["lengthInSec"], 3), "looping": bool(ps["looping"]), "prewarm": bool(ps["prewarm"]),
                                  "startDelay": minmax(ps["startDelay"]), "simulationSpeed": round(ps["simulationSpeed"], 3),
                                  "space": ps["moveWithTransform"], "scalingMode": ps["scalingMode"], "playOnAwake": bool(ps["playOnAwake"]),
                                  **{m: compact(ps[m]) for m in MODULES if ps.get(m, {}).get("enabled")}}
            elif t == "ParticleSystemRenderer":
                r = o.read()
                if not r.m_Enabled: n["enabled"] = False
                n["renderer"] = {"mode": ["billboard", "stretched", "horizontal", "vertical", "mesh"][r.m_RenderMode] if r.m_RenderMode < 5 else r.m_RenderMode,
                                 "materials": [material(m) for m in r.m_Materials if m.path_id]}
                if r.m_RenderMode == 4 and r.m_Mesh.path_id:
                    try: n["renderer"]["mesh"] = save_mesh(r.m_Mesh.read())
                    except Exception: pass
            elif t in ("MeshRenderer", "SkinnedMeshRenderer"):
                r = o.read(); summary["meshes"] += 1; summary["skinned"] |= t == "SkinnedMeshRenderer"
                if not r.m_Enabled: n["enabled"] = False
                n["meshRenderer"] = {"skinned": t == "SkinnedMeshRenderer", "materials": [material(m) for m in r.m_Materials if m.path_id]}
                try:
                    mesh = r.m_Mesh.read() if t == "SkinnedMeshRenderer" else next(component(c).read() for c in g.m_Component if component(c).type.name == "MeshFilter").m_Mesh.read()
                    n["meshRenderer"]["mesh"] = save_mesh(mesh) if t == "MeshRenderer" else mesh.m_Name  # skinned bodies are in models
                except Exception: pass
            elif t == "PlayableDirector":
                summary["timeline"] = True
                try: n["timeline"] = timeline(o, anim_clips)
                except Exception as e: n["timeline"] = {"error": str(e)}
            elif t in ("TrailRenderer", "LineRenderer"):
                r = o.read()
                n["lineRenderer"] = {"type": t, "materials": [material(m) for m in r.m_Materials if m.path_id]}
            elif t in ("Animator", "Animation"):
                n["animator"] = True
                try: tos.update({h: p for h, p in o.read().m_Avatar.read().m_TOS})  # bone paths of optimized rigs
                except Exception: pass
                try:
                    ctrl = o.read().m_Controller.read()
                    if hasattr(ctrl, "m_Controller"): ctrl = ctrl.m_Controller.read()  # override controller -> base
                    for c in ctrl.m_AnimationClips: anim_clips.append((c.read(), None))
                except Exception: pass
        for key in ("renderer", "meshRenderer", "lineRenderer"):
            for m in n.get(key, {}).get("materials", []):
                props.update(m["colors"]); props.update(m["floats"]); props.update(m["textures"])
        n["children"] = [node(ch.read().m_GameObject.read(), path) for ch in (tr.m_Children if tr else [])]
        if not n["children"]: del n["children"]
        return n
    tree = node(go)
    clips, done = [], set()
    for clip, start in anim_clips:
        if clip.m_Name in done: continue
        done.add(clip.m_Name)
        try: clips.append({**sample_clip(clip, paths, props, tos), "timelineStart": start})
        except Exception as e: clips.append({"name": clip.m_Name, "error": str(e)})
    summary["clips"] = len(clips)
    return tree, summary, clips

COMPONENTS = {1: "GameObject", 4: "Transform", 23: "MeshRenderer", 108: "Light", 114: "MonoBehaviour", 137: "SkinnedMeshRenderer",
              198: "ParticleSystem", 199: "ParticleSystemRenderer", 212: "SpriteRenderer", 96: "TrailRenderer", 120: "LineRenderer"}
TRANSFORM = {1: "position", 2: "rotation", 3: "scale", 4: "euler"}
COMMON = ["m_IsActive", "m_Enabled", "m_Color.r", "m_Color.g", "m_Color.b", "m_Color.a", "m_Intensity", "m_Range",
          "EmissionModule.enabled", "EmissionModule.rateOverTime.scalar", "InitialModule.startSize.scalar",
          "InitialModule.startColor.maxColor.r", "InitialModule.startColor.maxColor.g", "InitialModule.startColor.maxColor.b",
          "InitialModule.startColor.maxColor.a", "InitialModule.startLifetime.scalar", "InitialModule.startSpeed.scalar"]

def crc(s): return zlib.crc32(s.encode()) & 0xffffffff

def sample_clip(clip, paths, props, tos):
    """An effect clip sampled at its own rate: per animated property {path, component, property, values | const}.
    Binding paths and property names are CRC32 hashes, resolved against the prefab's own hierarchy (from whichever
    object resolves most of them: the Animator's) and its material properties."""
    curves, duration, rate = ea.decode_clip(clip)
    names = {crc(p): p for p in COMMON}
    mat_names = {crc(p) & 0x0FFFFFFF: p for p in props}
    roots = set(paths)
    def rel_map(root):
        return {crc("/".join(p[len(root):])): "/".join(p[len(root):]) for p in paths if p[:len(root)] == root}
    want = {b.path for b, _ in curves}
    best = max((rel_map(r) for r in roots), key=lambda m: len(want & m.keys()), default={})
    best = {**tos, **best}  # skinned effect copies animate avatar bones that have no objects
    frames = min(int(round(duration * rate)) + 1, 600)
    out = []
    for b, fs in curves:
        comp = COMPONENTS.get(b.typeID, b.typeID)
        if b.typeID == 4: prop = TRANSFORM.get(b.attribute)
        elif b.customType == 22:  # material property: low 28 bits = CRC32 of its name, bits 28-29 = channel, bit 31 = float
            n = mat_names.get(b.attribute & 0x0FFFFFFF) or "#%07x" % (b.attribute & 0x0FFFFFFF)  # (name not in its materials)
            prop = "material." + n + ("" if b.attribute >> 31 else "." + "rgba"[(b.attribute >> 28) & 3])
        else: prop = names.get(b.attribute, b.attribute)
        if getattr(b, "isPPtrCurve", 0):
            out.append({"path": best.get(b.path, b.path), "component": comp, "property": prop, "pptr": True}); continue
        vals = [[round(f(i / rate), 4) for f in fs] for i in range(frames)]
        flat = [v[0] if len(v) == 1 else v for v in vals]
        row = {"path": best.get(b.path, b.path), "component": comp, "property": prop}
        if all(v == flat[0] for v in flat): row["const"] = flat[0]
        else: row["values"] = flat
        out.append(row)
    return {"name": clip.m_Name, "duration": round(duration, 3), "rate": rate, "loop": bool(getattr(clip.m_MuscleClip, "m_LoopTime", False)),
            "curves": out}

# --- mapping -------------------------------------------------------------------------------------------------------
def role(rec, field, users):
    t = em.typ(rec)
    if t == "ImpactVFX": return "impact"
    if t == "AspectBeam": return "beam"
    flags = ",".join(u.get("m_unitFlags") or "" for u in users)
    if "Missile" in flags: return "projectile"
    if t == "AspectModel" and "Creature" in flags: return "body"
    if t == "AspectModel" and "Spell" in flags: return "spell"
    if "Effect" in flags: return "effect"
    return "attachment" if t == "AspectModelAttachment" else "model"

def sound_events(r):
    """(field, event, bank) for every Wwise event a record plays (reactors' m_wwiseEvent, ImpactSound per surface,
    the card's celebration line)."""
    out = []
    def walk(o, field):
        if isinstance(o, dict):
            if o.get("m_eventName"): out.append((field, o["m_eventName"], o.get("m_bankName")))
            for k, v in o.items(): walk(v, k)
        elif isinstance(o, list):
            for v in o: walk(v, field)
    walk(r, None)
    return out

ABILITY = re.compile(r"_((?:Ability|Talent)[A-Za-z0-9]+)|^[^_]+_([A-Za-z0-9]+)_Operation")

def unit_effects(key, own, recs, owner):
    """Records with a prefab or a sound reachable from this unit's own records (own first, then shared ones they reference),
    with the ability they belong to (from their name or the own record that led to them)."""
    found = {}
    own_ids = {r["guid"] for r in own}
    seen = {r["guid"]: r["name"] for r in own}
    level = [(r["guid"], r["name"]) for r in own]
    for _ in range(7):
        nxt = []
        for g, origin in level:
            r = recs[g]
            if (prefab_refs(r) or sound_events(r)) and g not in found: found[g] = origin
            for h in re.findall(r"[0-9a-f]{32}", json.dumps({k: v for k, v in r.items() if k != "guid"})):
                if h in seen or h not in recs: continue
                if em.typ(recs[h]) in SKIP or owner.get(h, key) != key: continue  # other cards, other units
                if em.typ(recs[h]) == "Unit" and h not in own_ids and set((recs[h].get("m_unitFlags") or "").split(",")) - {"", "Missile", "Effect", "Spell"}:
                    continue  # creatures and buildings outside its bundle (towers, gold mines a search looks for)
                seen[h] = origin; nxt.append((h, origin))
        level = nxt
    def ability(name):
        m = ABILITY.search(name)
        return m and (m[1] or m[2])
    return [(recs[g], ability(recs[g]["name"]) or ability(origin)) for g, origin in found.items()]

def main():
    assets = json.load(open(os.path.join(ROOT, "asset_index.json")))  # asset GUID -> [bundle, type, name]
    recs, by_key = em.unit_records()
    owner = {r["guid"]: k for k, rs in by_key.items() for r in rs}
    users = {}
    for u in recs.values():
        if em.typ(u) != "Unit": continue
        for a in u.get("m_aspects", []) + [a for t in u.get("m_talents", []) for a in t.get("m_aspects", [])]: users.setdefault(a, []).append(u)
    sounds_path = os.path.join(ROOT, "sounds", "index.json")
    banks = json.load(open(sounds_path, encoding="utf8"))["banks"] if os.path.exists(sounds_path) else {}
    todo, sounds = {}, {}
    for key, own in by_key.items():
        if ONLY and not ONLY.search(key): continue
        rows, snd = [], {}
        for r, ability in unit_effects(key, own, recs, owner):
            for field, g in prefab_refs(r):
                if g in assets and assets[g][1] == "GameObject": rows.append((r, field, g, ability))
            for field, ev, bank in sound_events(r):
                row = snd.get((r["name"], ev))
                if row: row["fields"].append(field); continue
                abl = recs.get(r.get("m_ability"), {}).get("name")
                snd[(r["name"], ev)] = {"event": ev, "bank": bank, "record": r["name"], "trigger": em.typ(r), "fields": [field],
                                        "ability": (ABILITY.search(abl) and ABILITY.search(abl)[1]) if abl else ability,
                                        **({"activity": r["m_activity"]} if r.get("m_activity") else {}),
                                        "files": banks.get(bank, {}).get("events", {}).get(ev)}
        if rows: todo[key] = rows
        if snd: sounds[key] = sorted(snd.values(), key=lambda x: (x["ability"] or "~", x["trigger"], x["event"]))
    by_bundle = {}
    for rows in todo.values():
        for r, f, g, a in rows: by_bundle.setdefault(assets[g][0], set()).add(g)
    for d in ("prefabs", "textures", "meshes"): os.makedirs(os.path.join(OUT, d), exist_ok=True)
    # every prefab's file name, settled before the work is split, so each process gives the same prefab the same name
    names = {}
    for bundle, guids in sorted(by_bundle.items()):
        for g in sorted(guids):
            fn = safe(assets[g][2]) + ".json"
            names[g] = f"{safe(assets[g][2])}_{g[:6]}.json" if fn in names.values() else fn
    # RUMBLE_PREFABS: "none" extracts nothing and writes only the index (every prefab under the name it would get);
    # a JSON file lists the prefabs to extract, by name; empty: all of them
    only = os.environ.get("RUMBLE_PREFABS", "")
    wanted = set(json.load(open(only, encoding="utf8"))) if only not in ("", "none") else None
    summaries, files = {}, (dict(names) if only == "none" else {})
    for part in (load_parts(OUT) if SHARD == "merge" else []): files.update(part["files"]); summaries.update(part["summaries"])
    for i, (bundle, guids) in enumerate(sorted(by_bundle.items())):
        if SHARD == "merge" or only == "none" or not MINE(i): continue
        if wanted is not None:
            guids = {g for g in guids if assets[g][2] in wanted}
            if not guids: continue
        print(bundle, len(guids), flush=True)
        env = em.load_lazy(bundle)
        cont = {}
        for o in env.objects:
            if o.type.name == "AssetBundle":
                for k, v in o.read().m_Container:
                    if k in guids: cont.setdefault(k, v.asset)
        for g, ptr in cont.items():
            name = assets[g][2]
            fn = names[g]
            try: tree, summary, clips = extract(ptr.read())
            except Exception as e: print("   FAILED", name, e); continue
            json.dump({"prefab": name, "bundle": bundle, "guid": g, **summary, "root": tree, "clips": clips},
                      open(os.path.join(OUT, "prefabs", fn), "w", encoding="utf8"), indent=1, ensure_ascii=False)
            files[g] = fn; summaries[g] = summary
    if "/" in SHARD: save_part(OUT, {"files": files, "summaries": summaries}); return
    index_path = os.path.join(OUT, "index.json")
    index = json.load(open(index_path, encoding="utf8")) if ONLY and os.path.exists(index_path) else {}
    units = index.setdefault("units", {})
    for key, rows in sorted(todo.items()):
        out = []
        for r, field, g, ability in sorted(rows, key=lambda x: (x[3] or "~", x[0]["name"])):
            out.append({"record": r["name"], "type": em.typ(r), "ability": ability, "role": role(r, field, users.get(r["guid"], [])),
                        "prefab": assets[g][2], "bundle": assets[g][0], "file": files.get(g) and "prefabs/" + files[g],
                        **summaries.get(g, {})})
        units[key] = out
    index.setdefault("sounds", {}).update(sounds)
    index["sounds"] = dict(sorted(index["sounds"].items()))
    index["source"] = ("Warcraft Rumble game files: unit data records (AspectModel, AspectModelAttachment, ImpactVFX, AspectBeam) "
                       "-> prefab by asset GUID; particle settings, textures and meshes extracted")
    index["units"] = dict(sorted(units.items()))
    json.dump(index, open(index_path, "w", encoding="utf8"), indent=1, ensure_ascii=False)
    print(len(units), "units,", sum(len(v) for v in units.values()), "models and effects,", len(files), "prefabs")

main()
