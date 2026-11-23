# Export the game's sounds (Wwise) to WAV, named after their original files, plus an index tying units, spells,
# bosses, music and UI to their sound events.
# usage: python -I export_sounds.py [out_dir] [bank filter regex]
#   out_dir defaults to sounds in the working folder
# Needs vgmstream-cli (RUMBLE_VGMSTREAM): Wwise Vorbis/Opus can't be decoded by anything else here.
#
# How the audio is stored (Data/StreamingAssets/Audio/GeneratedSoundBanks/Windows):
#   *.bnk                  sound banks (Unit_X, DX_Unit_X = voice, Spell_X, Boss_X, MX_ = music, UI_, Ambience_...)
#   Media/<id>.wem         sound effects; Media/<language>/<id>.wem voice lines (English(US), jaJP, koKR, zhCN, zhTW)
#   SoundbanksInfo.xml     every bank's events and media files, with the original .wav names
import os, re, sys, json, subprocess, xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ["RUMBLE_WORK"]  # the working folder: exports, indexes, the tables read
AUDIO = os.environ["RUMBLE_AUDIO"].replace("\\", "/")
VGM = os.environ["RUMBLE_VGMSTREAM"]
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "sounds")
ONLY = re.compile(sys.argv[2], re.I) if len(sys.argv) > 2 else None
KEEP = set(filter(None, os.environ.get("RUMBLE_SOUND_LANGUAGES", "").split(",")))  # e.g. "sfx,en-US": only these; empty: all
LANG = {"SFX": "sfx", "English(US)": "en-US", "jaJP": "ja-JP", "koKR": "ko-KR", "zhCN": "zh-CN", "zhTW": "zh-TW"}

def clean(part): return re.sub(r'[<>:"|?*]+', "_", part).strip(" .") or "_"

root = ET.parse(os.path.join(AUDIO, "SoundbanksInfo.xml")).getroot()
files = {}   # wem path -> {out, name, language}
banks = {}
for sb in root.iter("SoundBank"):
    name = sb.findtext("ShortName")
    lang = LANG.get(sb.get("Language"), sb.get("Language"))
    if ONLY and not ONLY.search(name): continue
    if KEEP and lang not in KEEP: continue
    media = {}
    for f in sb.iter("File"):
        src = f.findtext("Path")
        short = f.findtext("ShortName") or f.get("Id")
        flang = LANG.get(f.get("Language"), f.get("Language"))
        parts = [clean(p) for p in re.split(r"[\\/]", os.path.splitext(short)[0])]
        out = "/".join([flang] + parts) + ".wav"
        files.setdefault(src, {"out": out, "language": flang, "id": f.get("Id")})
        media[f.get("Id")] = out
    events = {}
    for ev in sb.iter("Event"):
        refs = [media[r.get("Id")] for r in ev.iter("MediaRef") if r.get("Id") in media]
        if refs or ev.get("Name"): events[ev.get("Name")] = refs
    b = banks.setdefault(name, {"languages": {}, "events": {}})
    b["languages"][lang] = sorted(set(media.values()))
    for k, v in events.items():
        b["events"].setdefault(k, {})[lang] = v

# ---- convert --------------------------------------------------------------------------------------------------------
def convert(item):
    src, f = item
    dst = os.path.join(OUT, *f["out"].split("/"))
    if os.path.exists(dst): return None
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    r = subprocess.run([VGM, "-o", dst, os.path.join(AUDIO, src)], capture_output=True, text=True)
    return None if r.returncode == 0 and os.path.exists(dst) else f"{src}: {r.stderr.strip()[:200] or r.stdout.strip()[-200:]}"

items = [(s, f) for s, f in files.items() if os.path.exists(os.path.join(AUDIO, s))]
# Several of the game's files can carry one name. The first of them is the one converted, so the same one every run
# (converted side by side, whichever finished first would have been kept).
taken = set()
items = [(s, f) for s, f in items if not (f["out"] in taken or taken.add(f["out"]))]
# RUMBLE_SOUND_FILES: "none" writes only the index; a JSON file lists the files to convert (as the index names them)
WANTED = os.environ.get("RUMBLE_SOUND_FILES", "")
if WANTED == "none": items = []
elif WANTED:
    wanted = set(json.load(open(WANTED, encoding="utf8")))
    items = [(s, f) for s, f in items if f["out"] in wanted]
missing = [s for s in files if not os.path.exists(os.path.join(AUDIO, s))]
print(f"{len(banks)} banks, {len(items)} files to convert ({len(missing)} listed but not on disk)", flush=True)
errors = []
with ThreadPoolExecutor(max_workers=max(2, min(4, (os.cpu_count() or 4) - 1))) as pool:  # a few decoders at a time
    for k, err in enumerate(pool.map(convert, items)):
        if err: errors.append(err)
        if k % 1000 == 999: print(f"  {k + 1}/{len(items)}", flush=True)

# ---- tie banks to minis --------------------------------------------------------------------------------------------
norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
defs = json.load(open(os.path.join(ROOT, "all_mini_definitions.json"), encoding="utf8"))
minis = {m["slug"]: m for m in json.load(open(os.path.join(ROOT, "gamedata", "minis.json"), encoding="utf8"))["minis"]}
keys = {}  # normalised name -> slug
for d in defs:
    if d.get("slug") not in minis: continue
    for n in (d["internal"], re.sub("Leader$", "", d["internal"]), d["slug"], minis[d["slug"]]["name"],
              re.sub(r"^unitdata_(unit|spell)_|\.bundle$", "", d["bundle"])):
        keys.setdefault(norm(n), d["slug"]); keys.setdefault(norm(n).rstrip("s"), d["slug"])
keys["whelps"] = "whelp-eggs"  # the eggs hatch whelps; their sounds are in Unit_Whelps
keys.update({"murkeye": "old-murk-eye", "gobblinsapper": "goblin-sapper"})  # spelled differently in the banks
by_slug = {}
for bname in banks:
    m = re.match(r"^(DX_)?(Unit|Spell|Boss)_(.+)$", bname)
    if not m: continue
    # "QuillBoar_GRY", "Corehound", "WarsongGrunt": try the whole name, then without trailing _parts, singular/plural
    parts = m.group(3).split("_")
    slug = next((keys[k] for n in range(len(parts), 0, -1) for k in (norm("".join(parts[:n])), norm("".join(parts[:n])).rstrip("s"))
                 if k in keys), None)
    if not slug: continue
    by_slug.setdefault(slug, {"name": minis[slug]["name"], "banks": []})["banks"].append(bname)

index = {"source": "Warcraft Rumble game files (Wwise sound banks, SoundbanksInfo.xml); WAV via vgmstream",
         "languages": sorted({f["language"] for f in files.values()}),
         "bySlug": dict(sorted(by_slug.items())), "banks": dict(sorted(banks.items()))}
os.makedirs(OUT, exist_ok=True)
json.dump(index, open(os.path.join(OUT, "index.json"), "w", encoding="utf8"), indent=1, ensure_ascii=False)
if errors:
    open(os.path.join(OUT, "errors.txt"), "w", encoding="utf8").write("\n".join(errors))
print(f"done: {len(items) - len(errors)} converted, {len(errors)} failed; {len(by_slug)} minis with sounds")
