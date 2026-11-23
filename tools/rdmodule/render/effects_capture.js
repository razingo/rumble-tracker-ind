// Capture for the rdmodule's effect sprites. The render server (extract.mjs) adds this to the end of the effects viewer's own
// script (effects.html, served as /fx/effects.html with a black background and no grid), so it uses that
// page's simulation as it is: loadEffect, step, restart, fitCamera, camera, controls, renderer, scene, effect, ui.
// /fx/effects.html?capture renders every effect in sprites.json ("effects": key -> { unit, prefab, and optionally
// seconds, from, frames, yaw, pitch, zoom, tint }), ?capture=a,b only those; each is saved as sprites/fx-<key>.png, a sheet
// of frames on black (the game adds them onto the scene), and sprites/fx.json says how to cut them:
// { cell: [w, h], cols, frames, seconds, at: [x, y] (the effect's own origin, within a cell), unit (pixels per game unit) }.
const FX_OUT = 256; // the longer side of a frame
const FX_RATE = 24; // frames a second

// The particles' random numbers come from the effect's name, so an effect is drawn the same on every run, whichever
// effects are drawn before it.
function seedRandom(text) {
  let a = 2166136261;
  for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 16777619);
  Math.random = () => { // (mulberry32)
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function captureEffect(spec) {
  ui('unit').value = spec.unit;
  fillEffects();
  const row = rowFor(spec.prefab);
  if (!row) throw new Error(`no ${spec.prefab} under ${spec.unit}`);
  ui('loop').checked = false; paused = true;
  await loadEffect(row);
  // the textures load on their own: until they are all here, a frame may be drawn without one (a minute at most,
  // for a PC busy with the other exports)
  for (let i = 0; i < 3000 && texturesLoading > 0; i++) await new Promise((r) => setTimeout(r, 20));
  const dt = 1 / 60, from = spec.from || 0, total = Math.min(spec.seconds ? from + spec.seconds : effect.duration, effect.duration);
  // once through, so the viewer frames how far it spreads; then the camera moves to the game's side and stays put
  for (let x = 0; x < total; x += dt) step(dt);
  if (!effect.fitted) fitCamera();
  const mid = controls.target.clone(), dist = camera.position.distanceTo(mid) * (spec.zoom || 1);
  const yaw = THREE.MathUtils.degToRad(spec.yaw ?? 28), pitch = THREE.MathUtils.degToRad(spec.pitch ?? 12);
  camera.position.set(mid.x - Math.cos(yaw) * Math.cos(pitch) * dist, mid.y + Math.sin(pitch) * dist, mid.z + Math.sin(yaw) * Math.cos(pitch) * dist);
  controls.update();
  camera.updateMatrixWorld(true);
  restart();
  const n = spec.frames || Math.max(8, Math.min(30, Math.round((total - from) * FX_RATE)));
  const W = renderer.domElement.width, H = renderer.domElement.height, shots = [];
  let time = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let i = 0; i < n; i++) {
    const until = from + (total - from) * (i + 0.5) / n;
    while (time < until) { step(dt); time += dt; }
    renderer.render(scene, camera);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(renderer.domElement, 0, 0);
    const px = g.getImageData(0, 0, W, H).data;
    let lit = 0; // pixels with anything in them, the faint glow too
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const k = (y * W + x) * 4;
      if (Math.max(px[k], px[k + 1], px[k + 2]) > 5) { lit++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    shots.push({ c, lit });
  }
  while (shots.length > 4 && shots[shots.length - 1].lit < 8) shots.pop(); // the empty end
  if (x1 < 0) throw new Error('nothing drawn');
  // room around it for the glow to die away in
  const room = Math.round(Math.max(x1 - x0, y1 - y0) * 0.08) + 6;
  x0 = Math.max(0, x0 - room); y0 = Math.max(0, y0 - room); x1 = Math.min(W - 1, x1 + room); y1 = Math.min(H - 1, y1 + room);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, k = Math.min(1, FX_OUT / Math.max(bw, bh));
  const cw = Math.round(bw * k), ch = Math.round(bh * k);
  const cols = Math.min(shots.length, Math.max(1, Math.ceil(Math.sqrt(shots.length * ch / cw))));
  const sheet = document.createElement('canvas');
  sheet.width = cw * cols; sheet.height = ch * Math.ceil(shots.length / cols);
  const sg = sheet.getContext('2d');
  sg.fillStyle = '#000'; sg.fillRect(0, 0, sheet.width, sheet.height);
  sg.imageSmoothingQuality = 'high';
  // every frame fades to black toward the edges of its cell, so nothing ends in a hard line when it is added on
  const edge = Math.round(Math.min(cw, ch) * 0.16);
  const fade = (x, y, w, h, x0g, y0g, x1g, y1g) => {
    const g = sg.createLinearGradient(x0g, y0g, x1g, y1g);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    sg.fillStyle = g; sg.fillRect(x, y, w, h);
  };
  shots.forEach((f, i) => {
    const ox = (i % cols) * cw, oy = Math.floor(i / cols) * ch;
    sg.drawImage(f.c, x0, y0, bw, bh, ox, oy, cw, ch);
    fade(ox, oy, edge, ch, ox, 0, ox + edge, 0); fade(ox + cw - edge, oy, edge, ch, ox + cw, 0, ox + cw - edge, 0);
    fade(ox, oy, cw, edge, 0, oy, 0, oy + edge); fade(ox, oy + ch - edge, cw, edge, 0, oy + ch, 0, oy + ch - edge);
  });
  // tint: the viewer's shader gets some effects' colors wrong (poison comes out red, ice orange), so those keep their
  // light and dark and take one color
  if (spec.tint) {
    sg.globalCompositeOperation = 'saturation'; sg.fillStyle = '#808080'; sg.fillRect(0, 0, sheet.width, sheet.height);
    sg.globalCompositeOperation = 'multiply'; sg.fillStyle = spec.tint; sg.fillRect(0, 0, sheet.width, sheet.height);
    sg.globalCompositeOperation = 'source-over';
  }
  // where the effect's own origin is in a cell, and how many pixels a game unit takes there
  const screen = (v) => { const p = v.clone().project(camera); return [(p.x + 1) / 2 * W, (1 - p.y) / 2 * H]; };
  const origin = effect.root.getWorldPosition(new THREE.Vector3()), o = screen(origin), up = screen(origin.clone().add(new THREE.Vector3(0, 1, 0)));
  return { sheet, info: { cell: [cw, ch], cols, frames: shots.length, seconds: Math.round((total - from) * shots.length / n * 1000) / 1000,
    at: [Math.round((o[0] - x0) * k), Math.round((o[1] - y0) * k)], unit: Math.round(Math.hypot(up[0] - o[0], up[1] - o[1]) * k * 10) / 10 } };
}

if (params.has('capture')) {
  const say = (line) => { window.__log = (window.__log || '') + line + '\n'; ui('info').textContent = window.__log; };
  const wanted = (await (await fetch('/sprites.json')).json()).effects || {};
  const only = params.get('capture') ? params.get('capture').split(',') : null;
  const infos = only ? await fetch('/sprites/fx.json').then((r) => (r.ok ? r.json() : {}), () => ({})) : {};
  for (const [key, spec] of Object.entries(wanted)) {
    if (only && !only.includes(key)) continue;
    try {
      // (an effect whose textures were not loaded yet comes out empty: it gets two more tries)
      let out = null;
      for (let tries = 0; !out; tries++) {
        seedRandom(key);
        try { out = await captureEffect(spec); } catch (e) { if (tries >= 2 || e.message !== 'nothing drawn') throw e; await new Promise((r) => setTimeout(r, 300)); }
      }
      const blob = await new Promise((r) => out.sheet.toBlob(r, 'image/png'));
      await fetch(`/save/fx-${key}.png`, { method: 'POST', body: blob });
      infos[key] = out.info;
      say(`${key}: ${out.sheet.width}x${out.sheet.height} ${JSON.stringify(out.info)}`);
    } catch (e) { say(`${key}: FAILED ${e.message}`); }
  }
  await fetch('/save/fx.json', { method: 'POST', body: JSON.stringify(infos) });
  say('DONE');
  window.__done = true;
}
