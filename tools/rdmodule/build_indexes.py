"""The indexes of the game's files that the exports read, built by several processes side by side:
  cab_index.json    CAB name -> bundle file (what export_models.cab_index builds on its own)
  asset_index.json  asset GUID -> [bundle, type, name] (what export_effects.asset_index builds on its own)
  ext_index.json    bundle -> the bundles its files refer to (what export_models.externals finds by opening it)
Run: python -I build_indexes.py <i>/<n>   every n-th bundle, its part left in index_parts/<i>.json
     python -I build_indexes.py merge     after them: the two files, in the working folder (RUMBLE_WORK)
Each bundle is opened once for all three."""
import os, sys, json, glob, UnityPy

ROOT = os.environ["RUMBLE_WORK"]
B = os.environ["RUMBLE_BUNDLES"].replace("\\", "/")
PARTS = os.path.join(ROOT, "index_parts")
os.makedirs(PARTS, exist_ok=True)

def part(k, n):
    cab, assets, ext = {}, [], {}
    for i, p in enumerate(sorted(glob.glob(B + "/*.bundle"))):
        if i % n != k: continue
        name = os.path.basename(p)
        try: env = UnityPy.load(p)
        except Exception: continue
        refs = set()  # the CAB names its files point into
        for f in env.files.values():
            for c in getattr(f, "files", {}):
                if not c.endswith((".resS", ".resource")): cab[c.lower()] = name
            for sf in getattr(f, "files", {}).values():
                for e in getattr(sf, "externals", []): refs.add(e.path.rsplit("/", 1)[-1].lower())
        ext[name] = sorted(refs)
        ab = next((o.read() for o in env.objects if o.type.name == "AssetBundle"), None)
        for guid, v in (ab.m_Container if ab else []):
            if len(guid) != 32: continue
            try: a = v.asset.read(); row = [name, a.type.name if hasattr(a, "type") else type(a).__name__, getattr(a, "m_Name", "")]
            except Exception: row = [name, "?", ""]
            assets.append([guid, row])
    json.dump({"cab": cab, "assets": assets, "ext": ext}, open(os.path.join(PARTS, f"{k}.json"), "w"))

def merge():
    parts = [json.load(open(os.path.join(PARTS, f))) for f in sorted(os.listdir(PARTS))]
    # as one process going through the bundles by name would have it: the last bundle's CAB, the first bundle's asset
    cab = {}
    for c, name in sorted(((c, name) for p in parts for c, name in p["cab"].items()), key=lambda x: x[1]): cab[c] = name
    assets = {}
    for guid, row in sorted((a for p in parts for a in p["assets"]), key=lambda x: x[1][0]): assets.setdefault(guid, row)
    json.dump(cab, open(os.path.join(ROOT, "cab_index.json"), "w"))
    json.dump(assets, open(os.path.join(ROOT, "asset_index.json"), "w"))
    # a bundle's references, as bundle names (a CAB no bundle has is left out, as export_models.externals does)
    ext = {b: sorted({cab[c] for c in refs if c in cab}) for p in parts for b, refs in p["ext"].items()}
    json.dump(ext, open(os.path.join(ROOT, "ext_index.json"), "w"))
    print(len(cab), "CABs,", len(assets), "assets,", len(ext), "bundles' references")

if sys.argv[1] == "merge": merge()
else: part(*map(int, sys.argv[1].split("/")))
