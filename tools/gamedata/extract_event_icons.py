"""Extract each event family's ticket/currency icon to gamedata/events/<family>.webp (read-only on the game files).

usage: python -I extract_event_icons.py [out_dir]
event_icon_sprites.json lists them: family -> [bundle file, texture name]. Names repeat across bundles
(e.g. SeasonalEvents_Tex_TicketIcon), so each icon is taken from a specific bundle. build_events.mjs reads the same
list to name each event's icon.
"""
import json
import os
import sys

import UnityPy

BUNDLES = os.environ["RUMBLE_BUNDLES"]
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "gamedata", "events")
SIZE = 96

with open(os.path.join(HERE, "event_icon_sprites.json"), encoding="utf-8") as f:
    WANT = json.load(f)  # family -> [bundle file, texture name]


def find(bundle):
    for root, _, files in os.walk(BUNDLES):
        if bundle in files:
            return os.path.join(root, bundle)
    return None


def main():
    os.makedirs(OUT, exist_ok=True)
    for fam, (bundle, name) in WANT.items():
        path = find(bundle)
        img = None
        if path:
            env = UnityPy.load(path)
            # prefer the Texture2D (whole image); fall back to the Sprite
            for kind in ("Texture2D", "Sprite"):
                for obj in env.objects:
                    if obj.type.name == kind and obj.peek_name() == name:
                        img = obj.read().image
                        break
                if img:
                    break
        if not img:
            print(f"NOT FOUND: {fam} ({bundle} / {name})")
            continue
        img = img.convert("RGBA")
        bbox = img.getchannel("A").getbbox()
        if bbox:
            img = img.crop(bbox)
        img.thumbnail((SIZE, SIZE))
        out = os.path.join(OUT, f"{fam}.webp")
        img.save(out, "WEBP", quality=90)
        print(f"saved {fam}: {name} {img.size}")


if __name__ == "__main__":
    main()
