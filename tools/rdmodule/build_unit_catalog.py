"""One catalog of what every unit and spell has: its bodies (rigs), each body's abilities with the animation clips,
effects and sounds they play, and the rest of its animations, effects and sounds by kind.
Run: python -I build_unit_catalog.py [unit key regex]
Needs animations, effects and sounds (their index.json) and asset_index.json (build_indexes.py).
Out: unit_catalog.json, units.<key> = {name, slug, collectible, bodies, effects, sounds}.

Abilities come from the unit records (AspectAbility in Unit.m_aspects and its talent slots). Each names an Animator
parameter (m_animParamName); the body's AnimatorController (AspectModel.m_animatorController, by asset GUID) has
states entered by transitions on that parameter (or <param>_Start); the clips are those states' motions plus the
states they flow into without a condition (Start -> Channel)."""
import os, re, sys, json, UnityPy

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ["RUMBLE_WORK"]  # the working folder: exports, indexes, the tables read
ONLY = re.compile(sys.argv[1]) if len(sys.argv) > 1 else None
_argv = sys.argv; sys.argv = sys.argv[:1]; sys.path.insert(0, HERE)  # (-I leaves the script folder off the path)
import export_models as em
sys.argv = _argv
R = ROOT
OUT = os.path.join(R, "unit_catalog.json")
ABILITY = re.compile(r"_((?:Ability|Talent)[A-Za-z0-9]+)")
KINDS = [("deploy", r"Deploy|Spawn|Emerge|Birth|Entrance"), ("death", r"Death|Die"), ("celebration", r"Celebrat|Victory"),
         ("movement", r"Walk|Run|Move|Fly|Turn|Jump|Charge"), ("idle", r"Ready|Stand|Idle|Pose|Hover|Sleep|Statue"),
         ("hit", r"Hit|Wound|Stun|Knock")]

def kind(name):
    for k, rx in KINDS:
        if re.search(rx, name, re.I): return k
    return "other"

def bare(n): return re.sub(r"^(Ability|Talent)", "", n or "")  # GreaterHeal == AbilityGreaterHeal

def clip_name(n): return n.split("@", 1)[-1]  # bundle clips are <Model>@<Clip>; the glTF files keep the part after @

# ---- Animator controllers ---------------------------------------------------------------------------------------
_env_cache = {}
def load_asset(assets, g):
    bundle = assets[g][0]
    if bundle not in _env_cache:
        if len(_env_cache) > 1: _env_cache.clear()  # (each holds dozens of bundles in memory)
        _env_cache[bundle] = em.load_lazy(bundle)
    env = _env_cache[bundle]
    for o in env.objects:
        if o.type.name == "AssetBundle":
            for k, v in o.read().m_Container:
                if k == g: return v.asset.read()
    return None

def controller(c):
    """{states: [{name, clips, next: [(state, [params])]}], any: [(state, [params])]} with override clips applied."""
    overrides = {}
    if not hasattr(c, "m_TOS") and hasattr(c, "m_Controller"):  # AnimatorOverrideController
        for pair in getattr(c, "m_Clips", []):
            try: overrides[pair.m_OriginalClip.read().m_Name] = pair.m_OverrideClip.read().m_Name
            except Exception: pass
        c = c.m_Controller.read()
    tos = dict(c.m_TOS)
    clips = []
    for x in c.m_AnimationClips:
        try: n = x.read().m_Name
        except Exception: n = None
        clips.append(overrides.get(n, n))
    states, anys = [], []
    for smp in c.m_Controller.m_StateMachineArray:
        sm = smp.data
        sts = [s.data for s in sm.m_StateConstantArray]
        sel = [x.data for x in getattr(sm, "m_SelectorStateConstantArray", [])]
        base = len(states)
        names = [tos.get(s.m_NameID, str(s.m_NameID)) for s in sts]
        def cond_names(t):
            out = []
            for cd in t.m_ConditionConstantArray:
                d = cd.data
                out.append(tos.get(getattr(d, "m_ConditionEvent", None) or getattr(d, "m_EventID", None)))
            return [x for x in out if x]
        def dests(dst, depth=0):
            """State indices a destination reaches: a state, or a selector (30000 + i, a sub-state machine's entry,
            picking among states) followed to its states."""
            if dst < len(sts): return [base + dst]
            if dst >= 30000 and dst - 30000 < len(sel) and depth < 4:
                out = []
                for st in sel[dst - 30000].m_TransitionConstantArray:
                    st = st.data if hasattr(st, "data") else st
                    out += dests(st.m_Destination, depth + 1)
                return out
            return []
        def trans(t):
            t = t.data
            return (dests(t.m_DestinationState), cond_names(t))
        for s, n in zip(sts, names):
            motion = []
            for bt in s.m_BlendTreeConstantArray:
                for node in bt.data.m_NodeArray:
                    cid = node.data.m_ClipID
                    if cid < len(clips) and clips[cid]: motion.append(clips[cid])
            states.append({"name": n, "clips": list(dict.fromkeys(motion)), "next": [trans(t) for t in s.m_TransitionConstantArray]})
        anys += [trans(t) for t in sm.m_AnyStateTransitionConstantArray]
    for s in states: s["next"] = [(d, conds) for ds, conds in s["next"] for d in ds]
    anys = [(d, conds) for ds, conds in anys for d in ds]
    return {"name": c.m_Name, "states": states, "any": anys}

def ability_states(ctrl, param):
    """States an ability parameter starts (transitions on <param> or <param>_Start; <param>_End leads back to idle),
    then the states they flow into without a condition, stopping at idle and movement."""
    if not param: return []
    hit = lambda conds: any(x in (param, param + "_Start") for x in conds)
    start = {d for d, conds in ctrl["any"] if d is not None and hit(conds)}
    for s in ctrl["states"]:
        start |= {d for d, conds in s["next"] if d is not None and hit(conds)}
    start |= {i for i, s in enumerate(ctrl["states"]) if clip_name(s["name"]).startswith(param)}  # (states named after it)
    seen, todo = set(), sorted(start)
    while todo:
        i = todo.pop(0)
        if i in seen: continue
        seen.add(i)
        for d, conds in ctrl["states"][i]["next"]:
            if d is not None and not conds and d not in seen and kind(ctrl["states"][d]["name"]) not in ("idle", "movement"): todo.append(d)
    return [ctrl["states"][i] for i in sorted(seen)]

# ---- catalog ----------------------------------------------------------------------------------------------------
def main():
    assets = json.load(open(os.path.join(ROOT, "asset_index.json")))
    anim = json.load(open(os.path.join(R, "animations", "index.json"), encoding="utf8"))
    fx = json.load(open(os.path.join(R, "effects", "index.json"), encoding="utf8"))
    models = json.load(open(os.path.join(R, "models", "index.json"), encoding="utf8"))
    recs, by_key = em.unit_records()
    talent_names = {}
    for r in recs.values():
        if em.typ(r) == "Talent": talent_names[r["guid"]] = re.sub(r"^.*?_(Talent)", r"\1", r["name"])
    catalog = {}
    units = catalog.setdefault("units", {})
    for key, own in sorted(by_key.items()):
        if ONLY and not ONLY.search(key): continue
        print(key, flush=True)
        a_unit = anim["units"].get(key, {})
        rigs = [c for c in [a_unit] + a_unit.get("others", []) if c.get("file")]
        def rig_for(clip):
            for c in rigs:
                if clip in [x["name"] for x in c.get("clips", [])]: return c["file"]
            return None
        fx_rows = fx["units"].get(key, [])
        snd_rows = fx.get("sounds", {}).get(key, [])
        def effects_for(ability):
            return [{"role": r["role"], "prefab": r["prefab"], "file": r["file"] and "effects/" + r["file"], "record": r["record"]}
                    for r in fx_rows if r["ability"] and bare(r["ability"]) == bare(ability) and r["role"] != "body"]
        def sounds_for(ability):
            return [{"event": s["event"], "trigger": s["trigger"], "activity": s.get("activity"), "files": s["files"]}
                    for s in snd_rows if s["ability"] and bare(s["ability"]) == bare(ability)]
        bodies, used_abilities = [], set()
        for u in (r for r in own if em.typ(r) == "Unit"):
            flags = u.get("m_unitFlags") or ""
            slots = [(None, u.get("m_aspects", []))] + [(t.get("m_talent"), t.get("m_aspects", [])) for t in u.get("m_talents", [])]
            aspects = [(talent, recs[a]) for talent, ids in slots for a in ids if a in recs]
            model = next((a for t, a in aspects if em.typ(a) == "AspectModel" and t is None), None) \
                or next((a for t, a in aspects if em.typ(a) == "AspectModel"), None)
            abilities = [(t, a) for t, a in aspects if em.typ(a) == "AspectAbility"]
            if not model or not ("Creature" in flags or abilities): continue
            ctrl = None
            g = model.get("m_animatorController")
            if g in assets:
                try:
                    c = load_asset(assets, g)
                    if c is not None: ctrl = controller(c)
                except Exception as e: print("   controller failed", u["name"], e)
            body = {"unit": re.sub(r"_Unit$", "", u["name"]), "flags": flags, "prefab": assets.get(model.get("m_model"), [None, None, None])[2],
                    "controller": ctrl and ctrl["name"], "abilities": [], "animations": {}}
            ability_clips = set()
            seen = set()
            for talent, a in abilities:
                name = (ABILITY.search(a["name"]) or [None, None])[1] or a.get("m_animParamName")                     or re.sub(r"_AspectAbility$", "", re.sub(r"^[^_]+_", "", a["name"]))
                if (name, talent) in seen: continue
                seen.add((name, talent))
                param = a.get("m_animParamName")
                states = ability_states(ctrl, param) if ctrl else []
                clips = []
                for s in states:
                    for cl in s["clips"]:
                        ability_clips.add(cl)
                        clips.append({"state": s["name"], "clip": clip_name(cl), "file": rig_for(clip_name(cl))})
                num = lambda k: float(a[k]) if isinstance(a.get(k), (str, int, float)) and re.fullmatch(r"-?[\d.]+", str(a[k])) else None
                body["abilities"].append({
                    "name": name, "record": a["name"], "talent": talent_names.get(talent) if talent else None, "animParam": param,
                    "range": num("m_range"), "acquireRadius": num("m_acquireRadius"), "time": num("m_totalAbilityTime"),
                    "period": num("m_periodSeconds"), "clips": clips, "effects": effects_for(name), "sounds": sounds_for(name)})
                used_abilities.add(bare(name))
            # the rest of the body's states by kind (idle, movement, deploy, death, celebration, hit, other)
            for s in (ctrl["states"] if ctrl else []):
                for cl in s["clips"]:
                    if cl in ability_clips: continue
                    body["animations"].setdefault(kind(s["name"] + " " + cl), []).append(
                        {"state": s["name"], "clip": clip_name(cl), "file": rig_for(clip_name(cl))})
            bodies.append(body)
        # clips in the rigs that no controller state plays (statue poses, celebration, talent props)
        played = {(c["file"], c["clip"]) for b in bodies for lst in [x["clips"] for x in b["abilities"]] + list(b["animations"].values()) for c in lst}
        def unplayed(c):
            out = {}
            for x in c.get("clips", []):
                if (c["file"], clip_name(x["name"])) not in played: out.setdefault(kind(x["name"]), []).append(x["name"])
            return out
        rig_list = [{"file": c["file"], "avatar": c.get("avatar"), "clipsFrom": c.get("clipsFrom"),
                     "clips": [x["name"] for x in c.get("clips", [])], "notInController": unplayed(c)} for c in rigs]
        m_unit = models["units"].get(key, {})
        units[key] = {
            "name": m_unit.get("name") or a_unit.get("name") or key, "slug": m_unit.get("slug") or a_unit.get("slug"), "collectible": m_unit.get("collectible", a_unit.get("collectible", False)),
            "model": m_unit.get("model"), "size": m_unit.get("size") or a_unit.get("size"), "rigs": rig_list, "bodies": bodies,
            "effects": [{"ability": r["ability"], "role": r["role"], "prefab": r["prefab"], "file": r["file"] and "effects/" + r["file"]}
                        for r in fx_rows if bare(r["ability"]) not in used_abilities or not r["ability"]],
            "sounds": [{"event": s["event"], "trigger": s["trigger"], "ability": s["ability"], "activity": s.get("activity"), "files": s["files"]}
                       for s in snd_rows if bare(s["ability"]) not in used_abilities or not s["ability"]],
        }
    catalog["source"] = ("Warcraft Rumble game files: unit records (abilities, models, sounds), AnimatorControllers (ability -> "
                         "states -> clips); files are relative to  (animations/, effects/, sounds/)")
    catalog["units"] = dict(sorted(units.items()))
    json.dump(catalog, open(OUT, "w", encoding="utf8"), indent=1, ensure_ascii=False)
    n_ab = sum(len(b["abilities"]) for u in units.values() for b in u["bodies"])
    n_cl = sum(1 for u in units.values() for b in u["bodies"] for a in b["abilities"] if a["clips"])
    print(len(units), "units,", n_ab, "abilities,", n_cl, "with clips")

main()
