"""Hornless card frames: cut a rounded-rectangle window into each faction frame (same thickness on all
sides), add a soft dark bevel along the cut, and write one matching fill mask.
usage: python make_card_frames.py <cand_dir> <out_dir>"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter, ImageChops

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
S = 4                      # supersampling for clean anti-aliased curves
SIDE, TOP, BOTTOM, R = 26, 30, 26, 18   # frame thickness (source px) and inner corner radius

def window(w, h, grow=0):
    m = Image.new('L', (w * S, h * S), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        ((SIDE - grow) * S, (TOP - grow) * S, (w - SIDE + grow) * S - 1, (h - BOTTOM + grow) * S - 1),
        radius=(R + grow) * S, fill=255)
    return m

def smooth_alpha(a, radius):
    a = a.filter(ImageFilter.GaussianBlur(radius))
    return a.point(lambda v: max(0, min(255, round((v - 128) * 2.2 + 128))))

def make(name, img):
    w, h = img.size
    big = img.resize((w * S, h * S), Image.LANCZOS)
    win = window(w, h)
    # bevel: darken the frame just outside the window (fades over ~4px)
    ring = win.filter(ImageFilter.MaxFilter(4 * S + 1)).filter(ImageFilter.GaussianBlur(2 * S))
    shade = Image.eval(ring, lambda v: 255 - round(v * 0.55))       # 255 = untouched, lower = darker
    rgb = ImageChops.multiply(big.convert('RGB'), Image.merge('RGB', (shade, shade, shade)))
    alpha = smooth_alpha(big.getchannel('A'), 2 * S)
    alpha = ImageChops.multiply(alpha, Image.eval(win, lambda v: 255 - v))
    rgb.putalpha(alpha)
    rgb.resize((w, h), Image.LANCZOS).save(os.path.join(out, f'frame-{name}.webp'), 'WEBP', quality=90)

fams = {'alliance': 'Alliance', 'horde': 'Horde', 'undead': 'Scourge', 'beast': 'Beast', 'blackrock': 'Blackrock', 'neutral': 'Neutral'}
for k, v in fams.items():
    make(k, Image.open(os.path.join(src, f'Inventory_SlotBG_{v}.png')).convert('RGBA'))

al = Image.open(os.path.join(src, 'Inventory_SlotBG_Alliance.png')).convert('RGBA')
r, g, b, a = al.split()
H, Sat, V = Image.merge('RGB', (r, g, b)).convert('HSV').split()
green = Image.merge('HSV', (H.point(lambda x: (x - 60) % 256), Sat, V)).convert('RGB')
green.putalpha(a)
make('cenarion', green)

# shared fill: the same window grown 5px so it tucks under every frame
w, h = 270, 408
fill = window(w, h, grow=5).resize((w, h), Image.LANCZOS)
fm = Image.new('RGBA', (w, h), (255, 255, 255, 0)); fm.putalpha(fill)
fm.save(os.path.join(out, 'fill-mask.png'), optimize=True)
print('ok')
