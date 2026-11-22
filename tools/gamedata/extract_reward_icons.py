"""Extract sprites listed in a JSON file to <out_dir>/<name>.webp. Read-only on the game files.

usage: python -I extract_reward_icons.py [out_dir] [list.json] [max_size]
  default: event reward icons (event_reward_sprites.json, written by build_events.mjs) -> gamedata/rewards, 96 px
  shop art: python -I extract_reward_icons.py ../../gamedata/store store_sprites.json 160
  mini art: python -I extract_reward_icons.py ../../gamedata/art mini_art_sprites.json 256 (likewise talents, icons)
The list is either ["Sprite", ...] (saved under the sprite's name) or {"file": "Sprite", ...} (saved as file.webp).
A file named with .png is saved as a PNG at the sprite's own size (the icons the tracker asks for by that name).
"""
import json
import os
import re
import sys

import UnityPy
from PIL import ImageFilter

BUNDLES = os.environ["RUMBLE_BUNDLES"]
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "gamedata", "rewards")
LIST = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "event_reward_sprites.json")
SIZE = int(sys.argv[3]) if len(sys.argv) > 3 else 96
# where these sprites usually live: atlases, UI, store, cosmetics (skins/avatars), tomes, icons
WHERE = re.compile(r"^(sprite_atlas|ui_|store|cosmetics_|feature_|shared|statue|reward|unitui_|seasonalevent_|gryphongame_embedded|iconsglobal)", re.I)


# optional 4th argument: bundles to search first (a regex). Mini portraits need ^unitui_: ui_avatars has sprites of
# the same name cropped round for player avatars.
PREFER = re.compile(sys.argv[4], re.I) if len(sys.argv) > 4 else None


def bundles():
    """Preferred bundles, the usual ones, then all the others (only reached while something is still missing)."""
    allb = sorted(os.path.join(r, f) for r, _, fs in os.walk(BUNDLES) for f in fs if f.endswith(".bundle"))
    rank = lambda p: 0 if PREFER and PREFER.search(os.path.basename(p)) else 1 if WHERE.search(os.path.basename(p)) else 2
    return sorted(allb, key=rank)


def square(img, crop):
    """A square from a tall banner portrait (leaders): starts squareTop of the height down; zoomOut > 1 makes the
    square wider than the art, the sides filled with a blurred stretch of the same strip."""
    w, h = img.size
    side = int(w * crop.get("zoomOut", 1))
    y = int(h * crop["squareTop"])
    strip = img.crop((0, y, w, min(h, y + side)))
    if side == w:
        return strip
    out = strip.resize((side, side)).filter(ImageFilter.GaussianBlur(side / 18))
    out.paste(strip, ((side - w) // 2, 0), strip)
    return out


def main():
    raw = json.load(open(os.path.join(HERE, LIST) if not os.path.isabs(LIST) else LIST, encoding="utf-8"))
    files_of = {}  # sprite -> [(file, crop spec or None)]
    for file, spec in (raw.items() if isinstance(raw, dict) else ((s, s) for s in raw)):
        sprite, crop = (spec["sprite"], spec) if isinstance(spec, dict) else (spec, None)
        files_of.setdefault(sprite, []).append((file, crop))
    os.makedirs(OUT, exist_ok=True)
    have = {f[:-5] for f in os.listdir(OUT) if f.endswith(".webp")} | {f for f in os.listdir(OUT) if f.endswith(".png")}
    todo = {s for s, fs in files_of.items() if any(x not in have for x, _ in fs)}
    print(f"{len(files_of)} sprites, {len(todo)} to extract")
    for path in bundles():
        if not todo:
            break
        try:
            env = UnityPy.load(path)
        except Exception:
            continue
        for obj in env.objects:
            # sprites mostly; some portraits only exist as a plain texture
            if obj.type.name not in ("Sprite", "Texture2D"):
                continue
            try:
                name = obj.peek_name()
            except Exception:
                continue
            if name not in todo:
                continue
            try:
                img = obj.read().image.convert("RGBA")
            except Exception as e:
                print(f"failed {name}: {e}")
                continue
            bbox = img.getchannel("A").getbbox()
            if bbox:
                img = img.crop(bbox)
            for file, crop in files_of[name]:
                out = square(img, crop) if crop and "squareTop" in crop else img
                if file.endswith(".png"):
                    out.save(os.path.join(OUT, file), "PNG")
                    continue
                out = out.copy()
                out.thumbnail((SIZE, SIZE))
                out.save(os.path.join(OUT, f"{file}.webp"), "WEBP", quality=88)
            todo.discard(name)
            print(f"saved {name} from {os.path.basename(path)}")
    for name in sorted(todo):
        print(f"NOT FOUND: {name}")


if __name__ == "__main__":
    main()
