// Animated unit figures, drawn in code: jointed 2D toys with a walk (or flight), an attack and a death.
// Figures.draw(ctx, kind, x, y, size, pose): x is the figure's middle, y its feet (or the bottom of its flight box),
// size its height in pixels. pose: { t: seconds, action: 'walk' | 'idle' | 'attack' | 'death', p: 0..1 through the
// attack or death, flash: true while hit }. Figures face right. Returns false for a kind it doesn't know.
'use strict';
(() => {
  const INK = '#2a2233';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (p) => p * p * (3 - 2 * p);
  let c; // the context being drawn on

  const paint = (fill, line = 2.5) => {
    c.fillStyle = fill; c.fill();
    if (line) { c.lineWidth = line; c.strokeStyle = INK; c.lineJoin = 'round'; c.stroke(); }
  };
  const circle = (x, y, r, fill, line) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); paint(fill, line); };
  const oval = (x, y, rx, ry, fill, rot = 0, line) => { c.beginPath(); c.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); paint(fill, line); };
  const box = (x, y, w, h, r, fill, line) => { c.beginPath(); c.roundRect(x, y, w, h, r); paint(fill, line); };
  const poly = (pts, fill, line) => {
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
    paint(fill, line);
  };
  // A limb hangs down from (x, y); a negative angle swings it forward.
  const limb = (x, y, len, ang, w, fill) => {
    c.save(); c.translate(x, y); c.rotate(ang);
    box(-w / 2, -w / 2, w, len + w / 2, w / 2, fill);
    c.restore();
  };

  function soldier(t, action, p) {
    const walking = action === 'walk';
    const step = walking ? Math.sin(t * 10) : 0;
    limb(-7, -32, 28, step * 0.55, 11, '#5a4634');
    limb(7, -32, 28, -step * 0.55, 11, '#6b5540');
    c.translate(0, walking ? -Math.abs(step) * 3 : 0);
    // mace arm, behind the body
    let arm = 0.35 + step * 0.25;
    if (action === 'attack') arm = p < 0.6 ? lerp(2.5, -1.2, ease(p / 0.6)) : lerp(-1.2, 0.35, (p - 0.6) / 0.4);
    c.save();
    c.translate(-6, -62); c.rotate(arm);
    box(-2.5, 14, 5, 30, 2, '#7a5a3a');
    circle(0, 46, 8, '#8d96a3');
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; poly([[Math.cos(a) * 7, 46 + Math.sin(a) * 7], [Math.cos(a + 0.25) * 12, 46 + Math.sin(a + 0.25) * 12], [Math.cos(a + 0.5) * 7, 46 + Math.sin(a + 0.5) * 7]], '#c9d0da', 1.5); }
    box(-5, -5, 10, 24, 5, '#3f8f6b');
    c.restore();
    // tabard
    box(-17, -70, 34, 42, 9, '#3f8f6b');
    box(-5, -69, 10, 40, 2, '#efe6c8', 0);
    box(-17, -42, 34, 6, 2, '#6b4a2b', 1.5);
    // head and kettle hat
    circle(2, -85, 17, '#f0c9a0');
    circle(10, -85, 2.4, INK, 0);
    oval(12, -78, 3.5, 2, '#e79a8a', 0, 0);
    c.beginPath(); c.ellipse(2, -93, 16, 13, 0, Math.PI, 0); c.closePath(); paint('#aeb6c2');
    oval(2, -93, 23, 5, '#8d96a3');
    // round shield, in front
    circle(17, -52, 17, '#a8733f');
    c.lineWidth = 1.5; c.strokeStyle = 'rgba(42,34,51,0.45)';
    for (const dx of [-7, 0, 7]) { c.beginPath(); c.moveTo(17 + dx, -68); c.lineTo(17 + dx, -36); c.stroke(); }
    c.beginPath(); c.arc(17, -52, 15, 0, Math.PI * 2); c.lineWidth = 3.5; c.strokeStyle = '#c9d0da'; c.stroke();
    circle(17, -52, 5.5, '#c9d0da', 2);
  }

  const featherWing = (x, y, ang, fill) => {
    c.save(); c.translate(x, y); c.rotate(ang);
    poly([[0, 0], [-8, -36], [-30, -42], [-48, -26], [-36, -24], [-44, -12], [-30, -12], [-34, 0], [-18, -4]], fill);
    c.restore();
  };

  function gryphon(t, action, p) {
    const flap = Math.sin(t * 12);
    const strike = action === 'attack' ? Math.sin(p * Math.PI) : 0;
    c.translate(strike * 12, Math.sin(t * 4) * 3);
    featherWing(-2, -60, -0.3 - flap * 0.6, '#9a6a2a');
    // tail with a tuft
    c.beginPath(); c.moveTo(-28, -50); c.quadraticCurveTo(-52, -58 + Math.sin(t * 6) * 4, -62, -44);
    c.lineWidth = 8; c.lineCap = 'round'; c.strokeStyle = INK; c.stroke();
    c.lineWidth = 4.5; c.strokeStyle = '#c58a3a'; c.stroke();
    circle(-62, -44, 6, '#6b4a2b');
    limb(-18, -42, 16, 0.5, 10, '#b07a30');
    limb(14, -42, 14, -0.5 - strike * 0.5, 7, '#e9a63a');
    oval(0, -50, 32, 17, '#c58a3a');
    oval(24, -60, 15, 13, '#f4efe2', -0.5);
    circle(32, -70, 12, '#f4efe2');
    poly([[41, -75], [57, -68], [42, -63]], '#f2a51e');
    circle(36, -73, 2.3, INK, 0);
    // rider
    poly([[-12, -82], [-32, -86 + Math.sin(t * 9) * 3], [-14, -74]], '#d0413a');
    box(-13, -82, 17, 24, 6, '#4a5f8a');
    circle(-4, -90, 9.5, '#f0c9a0');
    c.beginPath(); c.arc(-4, -92, 9.5, Math.PI * 1.05, Math.PI * 1.95); c.closePath(); paint('#6b4a2b', 2);
    box(-13, -93, 18, 4, 1, '#6b4a2b', 0);
    circle(1, -91, 3.4, '#bfe6ff', 1.5);
    // lance
    const thrust = strike * 16;
    c.beginPath(); c.moveTo(-10 + thrust, -74); c.lineTo(46 + thrust, -58);
    c.lineWidth = 5.5; c.lineCap = 'round'; c.strokeStyle = INK; c.stroke();
    c.lineWidth = 3; c.strokeStyle = '#8a6a44'; c.stroke();
    poly([[44 + thrust, -62], [60 + thrust, -54], [46 + thrust, -54]], '#c9d0da', 1.5);
    featherWing(2, -58, -0.05 + flap * 0.7, '#d9a04a');
  }

  const batWing = (x, y, ang, fill) => {
    c.save(); c.translate(x, y); c.rotate(ang);
    c.beginPath();
    c.moveTo(0, 0); c.lineTo(-8, -44);
    c.quadraticCurveTo(-22, -30, -38, -36);
    c.quadraticCurveTo(-36, -20, -54, -18);
    c.quadraticCurveTo(-42, -8, -40, 2);
    c.closePath();
    paint(fill);
    c.lineWidth = 2; c.strokeStyle = 'rgba(42,34,51,0.55)';
    for (const [tx, ty] of [[-38, -36], [-54, -18]]) { c.beginPath(); c.moveTo(0, 0); c.lineTo(tx, ty); c.stroke(); }
    c.restore();
  };

  function drake(t, action, p) {
    const flap = Math.sin(t * 9);
    const blast = action === 'attack' ? Math.sin(p * Math.PI) : 0;
    c.translate(blast * 5, Math.sin(t * 3.5) * 3);
    batWing(-4, -58, -0.25 - flap * 0.5, '#1f6f6a');
    // tail with a spade tip
    const tip = -50 + Math.sin(t * 5) * 6;
    c.beginPath(); c.moveTo(-26, -48); c.bezierCurveTo(-48, -38, -60, -60, -74, tip);
    c.lineWidth = 12; c.lineCap = 'round'; c.strokeStyle = INK; c.stroke();
    c.lineWidth = 8; c.strokeStyle = '#2aa198'; c.stroke();
    poly([[-72, tip - 8], [-88, tip - 2], [-74, tip + 8]], '#f08a3c');
    limb(-12, -38, 13, 0.3, 9, '#238a80');
    limb(10, -38, 13, -0.3, 9, '#238a80');
    oval(0, -50, 34, 19, '#2aa198');
    oval(2, -42, 23, 8, '#f3c98b', 0, 0);
    // neck and head
    c.beginPath(); c.moveTo(22, -56); c.quadraticCurveTo(36, -66, 40, -76);
    c.lineWidth = 18; c.lineCap = 'round'; c.strokeStyle = INK; c.stroke();
    c.lineWidth = 13.5; c.strokeStyle = '#2aa198'; c.stroke();
    poly([[36, -86], [26, -102], [44, -90]], '#f3e2b0', 2);
    poly([[44, -88], [40, -104], [52, -90]], '#f3e2b0', 2);
    c.save(); c.translate(48, -72); c.rotate(blast * 0.45);
    box(0, -2, 20, 7, 3, '#238a80');
    c.restore();
    oval(46, -80, 15, 11, '#2aa198');
    box(50, -84, 19, 10, 5, '#2aa198');
    circle(65, -81, 1.3, INK, 0);
    circle(47, -83, 3.6, '#ffd84d', 1.5);
    box(46.4, -86, 1.4, 6, 0.7, INK, 0);
    if (blast > 0) {
      for (let i = 0; i < 6; i++) {
        c.globalAlpha *= 0.9;
        circle(74 + i * 13 * blast, -72 + i * 2.5 + Math.sin(t * 40 + i) * 2, (5 + i * 2.2) * blast, i % 2 ? '#ffd84d' : '#ff7a2b', 0);
      }
    }
    batWing(4, -58, 0.05 + flap * 0.6, '#2fb5aa');
  }

  // A leader archetype: an orc storm-caller with a totem staff.
  function warchief(t, action, p) {
    const walking = action === 'walk';
    const step = walking ? Math.sin(t * 9) : 0;
    const cast = action === 'attack' ? Math.sin(p * Math.PI) : 0;
    limb(-9, -34, 30, step * 0.5, 13, '#5a4030');
    limb(9, -34, 30, -step * 0.5, 13, '#6b4c38');
    c.translate(0, walking ? -Math.abs(step) * 3 : 0);
    // back arm
    limb(-16, -66, 24, 0.3 + step * 0.3, 11, '#5f9a4a');
    // torso: leather harness under a fur mantle
    box(-21, -74, 42, 44, 10, '#7a3b2e');
    box(-21, -46, 42, 7, 2, '#3a2a22', 1.5);
    circle(0, -43, 4.5, '#e2b23a', 1.5);
    for (const x of [-18, -6, 6, 18]) oval(x, -72, 9, 7, '#b9b3a8');
    // head: tusks, war paint, topknot
    c.beginPath(); c.moveTo(-6, -104); c.quadraticCurveTo(-30, -112 + Math.sin(t * 7) * 3, -34, -92);
    c.lineWidth = 9; c.lineCap = 'round'; c.strokeStyle = INK; c.stroke();
    c.lineWidth = 5.5; c.strokeStyle = '#1d1a22'; c.stroke();
    circle(2, -90, 18, '#6aa852');
    box(-9, -108, 12, 7, 3, '#efe6c8', 1.5);
    box(-14, -96, 30, 4, 1, '#c8352b', 0);
    circle(10, -91, 2.5, INK, 0);
    box(4, -97, 13, 3, 1, INK, 0);
    box(4, -81, 14, 3, 1, INK, 0);
    poly([[6, -80], [8, -90], [11, -80]], '#f4efe2', 1.5);
    poly([[14, -80], [16, -88], [18, -80]], '#f4efe2', 1.5);
    // totem staff in the front hand, raised to cast
    c.save();
    c.translate(18, -62 - cast * 10); c.rotate(0.12 - cast * 0.25);
    box(-2.5, -52, 5, 96, 2, '#7a5a3a');
    box(-9, -70, 18, 22, 4, '#a8733f');
    circle(-4, -62, 2, cast ? '#ffe98a' : INK, 0);
    circle(4, -62, 2, cast ? '#ffe98a' : INK, 0);
    box(-5, -55, 10, 3, 1, INK, 0);
    poly([[-9, -68], [-20, -82], [-9, -60]], '#d0413a', 1.5);
    poly([[9, -68], [20, -82], [9, -60]], '#3f78e0', 1.5);
    if (cast > 0) {
      // lightning from the totem
      c.beginPath(); c.moveTo(10, -60);
      for (let i = 1; i <= 6; i++) c.lineTo(10 + i * 14 * cast, -60 + (i % 2 ? -9 : 7) + Math.sin(t * 50 + i) * 3);
      c.lineWidth = 6; c.lineJoin = 'round'; c.strokeStyle = 'rgba(120,190,255,0.8)'; c.stroke();
      c.lineWidth = 2.5; c.strokeStyle = '#fffbe0'; c.stroke();
    }
    c.restore();
    limb(14, -66, 16, -0.9 - cast * 0.6, 11, '#6aa852');
  }

  const FIGURES = { warchief: { draw: warchief }, footmen: { draw: soldier }, 'gryphon-rider': { draw: gryphon, air: true }, drake: { draw: drake, air: true } };

  window.Figures = {
    has: (kind) => !!FIGURES[kind],
    draw(ctx, kind, x, y, size, pose = {}) {
      const f = FIGURES[kind];
      if (!f) return false;
      const p = clamp(pose.p || 0, 0, 1), action = pose.action || 'walk';
      c = ctx;
      c.save();
      c.translate(x, y);
      c.scale(size / 100, size / 100);
      if (pose.flash) c.globalAlpha *= 0.6;
      if (action === 'death') {
        // tips over backward (fliers drop) and fades
        c.globalAlpha *= 1 - p * p;
        c.translate(-12 * p, f.air ? 50 * p * p : 0);
        c.translate(0, -30); c.rotate(-1.45 * ease(p)); c.translate(0, 30);
      }
      f.draw(pose.t || 0, action === 'death' ? 'idle' : action, p);
      c.restore();
      return true;
    },
  };
})();
