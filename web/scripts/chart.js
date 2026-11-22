// The parts the Progress and PvP charts share. A chart is W wide; its plot is H high above the baseline, starting `pad`
// from the left, where the y labels go.
import { esc } from './lib/format.js';

/** The SVG with the baseline and the first and last date under it; `body` is drawn in between. */
export const chartFrame = ({ W, H, pad, label, from, to, cls = 'chart' }, body) => `<svg class="${cls}"
    viewBox="0 0 ${W} ${H + 18}" role="img" aria-label="${esc(label)}">
    <line x1="${pad}" y1="${H}" x2="${W}" y2="${H}" class="axis"/>
    ${body}
    <text x="${pad}" y="${H + 14}" class="tick">${esc(from)}</text>
    <text x="${W}" y="${H + 14}" class="tick" text-anchor="end">${esc(to)}</text>
  </svg>`;

/** A y label, right-aligned against the plot. */
export const yLabel = (pad, y, text) => `<text x="${pad - 4}" y="${y}" class="tick" text-anchor="end">${esc(text)}</text>`;

/** A line through [x, y] points. */
export const linePath = (points, color) => `<path d="${points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`)
  .join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;

/** Maps a time between t0 and t1 to x. */
export const timeScale = ({ W, pad }, t0, t1) => (t) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad - 8);
