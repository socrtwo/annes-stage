/**
 * Preset shape geometry. Names follow the OOXML preset names (prstGeom) so .pptx files round-trip;
 * the drawings are original constructions. Each preset returns an SVG path in a w × h box. Adjustment
 * values use the file's units: 1/100000 of the shorter side (or of the width/height where noted).
 */

export interface GeomDef {
  label: string;
  group: 'Lines' | 'Rectangles' | 'Basic Shapes' | 'Block Arrows' | 'Equation Shapes' | 'Flowchart' | 'Stars and Banners' | 'Callouts' | 'Action Buttons';
  adj?: Record<string, number>;
  path: (w: number, h: number, a: Record<string, number>) => string;
  /** Open path (lines, arcs): no fill. */
  open?: boolean;
  /** Text rectangle as fractions [l, t, r, b] of the box. */
  text?: [number, number, number, number];
}

const f = (n: number) => +n.toFixed(2);
const P = (pts: [number, number][]) => 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L') + ' Z';
const ell = (cx: number, cy: number, rx: number, ry: number) => `M${f(cx - rx)} ${f(cy)} A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)} A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)} Z`;

function star(n: number, w: number, h: number, inner: number): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < n * 2; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 ? inner : 1;
    pts.push([w / 2 + (Math.cos(ang) * w / 2) * r, h / 2 + (Math.sin(ang) * h / 2) * r]);
  }
  return P(pts);
}

function polygon(n: number, w: number, h: number, start = -Math.PI / 2): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) { const a = start + (i * 2 * Math.PI) / n; pts.push([w / 2 + Math.cos(a) * w / 2, h / 2 + Math.sin(a) * h / 2]); }
  return P(pts);
}

function roundRect(w: number, h: number, r: number): string {
  r = Math.min(r, w / 2, h / 2);
  return `M${f(r)} 0 H${f(w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)} V${f(h - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w - r)} ${f(h)} H${f(r)} A${f(r)} ${f(r)} 0 0 1 0 ${f(h - r)} V${f(r)} A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0 Z`;
}

const ss = (w: number, h: number) => Math.min(w, h);

export const GEOMETRY: Record<string, GeomDef> = {
  line: { label: 'Line', group: 'Lines', open: true, path: (w, h) => `M0 0 L${f(w)} ${f(h)}` },
  straightConnector1: { label: 'Arrow', group: 'Lines', open: true, path: (w, h) => `M0 0 L${f(w)} ${f(h)}` },
  bentConnector3: { label: 'Elbow Connector', group: 'Lines', open: true, adj: { adj1: 50000 }, path: (w, h, a) => `M0 0 H${f(w * a.adj1 / 100000)} V${f(h)} H${f(w)}` },
  curvedConnector3: { label: 'Curved Connector', group: 'Lines', open: true, path: (w, h) => `M0 0 C${f(w / 2)} 0 ${f(w / 2)} ${f(h)} ${f(w)} ${f(h)}` },
  arc: { label: 'Arc', group: 'Basic Shapes', open: true, path: (w, h) => `M${f(w / 2)} 0 A${f(w / 2)} ${f(h / 2)} 0 0 1 ${f(w)} ${f(h / 2)}` },

  rect: { label: 'Rectangle', group: 'Rectangles', path: (w, h) => `M0 0 H${f(w)} V${f(h)} H0 Z` },
  roundRect: { label: 'Rounded Rectangle', group: 'Rectangles', adj: { adj: 16667 }, path: (w, h, a) => roundRect(w, h, ss(w, h) * a.adj / 100000), text: [0.05, 0.05, 0.95, 0.95] },
  snip1Rect: { label: 'Snipped Corner Rectangle', group: 'Rectangles', adj: { adj: 16667 }, path: (w, h, a) => { const d = ss(w, h) * a.adj / 100000; return P([[0, 0], [w - d, 0], [w, d], [w, h], [0, h]]); } },
  snip2SameRect: { label: 'Snip Same Side Corners', group: 'Rectangles', adj: { adj1: 16667 }, path: (w, h, a) => { const d = ss(w, h) * a.adj1 / 100000; return P([[d, 0], [w - d, 0], [w, d], [w, h], [0, h], [0, d]]); } },
  round1Rect: { label: 'Round Single Corner', group: 'Rectangles', adj: { adj: 16667 }, path: (w, h, a) => { const r = ss(w, h) * a.adj / 100000; return `M0 0 H${f(w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)} V${f(h)} H0 Z`; } },
  round2SameRect: { label: 'Round Same Side Corners', group: 'Rectangles', adj: { adj1: 16667 }, path: (w, h, a) => { const r = ss(w, h) * a.adj1 / 100000; return `M${f(r)} 0 H${f(w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)} V${f(h)} H0 V${f(r)} A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0 Z`; } },
  frame: { label: 'Frame', group: 'Basic Shapes', adj: { adj1: 12500 }, path: (w, h, a) => { const t = ss(w, h) * a.adj1 / 100000; return `M0 0 H${f(w)} V${f(h)} H0 Z M${f(t)} ${f(t)} V${f(h - t)} H${f(w - t)} V${f(t)} Z`; } },

  ellipse: { label: 'Oval', group: 'Basic Shapes', path: (w, h) => ell(w / 2, h / 2, w / 2, h / 2), text: [0.146, 0.146, 0.854, 0.854] },
  triangle: { label: 'Isosceles Triangle', group: 'Basic Shapes', adj: { adj: 50000 }, path: (w, h, a) => P([[w * a.adj / 100000, 0], [w, h], [0, h]]), text: [0.25, 0.5, 0.75, 1] },
  rtTriangle: { label: 'Right Triangle', group: 'Basic Shapes', path: (w, h) => P([[0, 0], [w, h], [0, h]]), text: [0.08, 0.5, 0.5, 0.92] },
  parallelogram: { label: 'Parallelogram', group: 'Basic Shapes', adj: { adj: 25000 }, path: (w, h, a) => { const d = ss(w, h) * a.adj / 100000; return P([[d, 0], [w, 0], [w - d, h], [0, h]]); } },
  trapezoid: { label: 'Trapezoid', group: 'Basic Shapes', adj: { adj: 25000 }, path: (w, h, a) => { const d = ss(w, h) * a.adj / 100000; return P([[d, 0], [w - d, 0], [w, h], [0, h]]); } },
  diamond: { label: 'Diamond', group: 'Basic Shapes', path: (w, h) => P([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]), text: [0.25, 0.25, 0.75, 0.75] },
  pentagon: { label: 'Regular Pentagon', group: 'Basic Shapes', path: (w, h) => polygon(5, w, h) },
  hexagon: { label: 'Hexagon', group: 'Basic Shapes', adj: { adj: 25000 }, path: (w, h, a) => { const d = ss(w, h) * a.adj / 100000; return P([[d, 0], [w - d, 0], [w, h / 2], [w - d, h], [d, h], [0, h / 2]]); } },
  heptagon: { label: 'Heptagon', group: 'Basic Shapes', path: (w, h) => polygon(7, w, h) },
  octagon: { label: 'Octagon', group: 'Basic Shapes', adj: { adj: 29289 }, path: (w, h, a) => { const d = ss(w, h) * a.adj / 100000; return P([[d, 0], [w - d, 0], [w, d], [w, h - d], [w - d, h], [d, h], [0, h - d], [0, d]]); } },
  decagon: { label: 'Decagon', group: 'Basic Shapes', path: (w, h) => polygon(10, w, h, 0) },
  dodecagon: { label: 'Dodecagon', group: 'Basic Shapes', path: (w, h) => polygon(12, w, h, 0) },
  pie: { label: 'Partial Circle', group: 'Basic Shapes', path: (w, h) => `M${f(w / 2)} ${f(h / 2)} L${f(w)} ${f(h / 2)} A${f(w / 2)} ${f(h / 2)} 0 1 1 ${f(w / 2)} 0 Z` },
  chord: { label: 'Chord', group: 'Basic Shapes', path: (w, h) => `M${f(w)} ${f(h / 2)} A${f(w / 2)} ${f(h / 2)} 0 1 1 ${f(w / 2)} 0 Z` },
  teardrop: { label: 'Teardrop', group: 'Basic Shapes', path: (w, h) => `M${f(w / 2)} 0 H${f(w)} V${f(h / 2)} A${f(w / 2)} ${f(h / 2)} 0 1 1 ${f(w / 2)} 0 Z` },
  donut: { label: 'Circle: Hollow', group: 'Basic Shapes', adj: { adj: 25000 }, path: (w, h, a) => { const t = ss(w, h) * a.adj / 100000; return ell(w / 2, h / 2, w / 2, h / 2) + ' ' + ell(w / 2, h / 2, w / 2 - t, h / 2 - t); } },
  noSmoking: { label: '"Not Allowed" Symbol', group: 'Basic Shapes', adj: { adj: 18750 }, path: (w, h, a) => { const t = ss(w, h) * a.adj / 100000; return ell(w / 2, h / 2, w / 2, h / 2) + ' ' + ell(w / 2, h / 2, w / 2 - t, h / 2 - t) + ` M${f(w * 0.2)} ${f(h * 0.2)} L${f(w * 0.8)} ${f(h * 0.8)}`; } },
  can: { label: 'Cylinder', group: 'Basic Shapes', adj: { adj: 25000 }, path: (w, h, a) => { const ry = ss(w, h) * a.adj / 200000; return `M0 ${f(ry)} A${f(w / 2)} ${f(ry)} 0 0 1 ${f(w)} ${f(ry)} V${f(h - ry)} A${f(w / 2)} ${f(ry)} 0 0 1 0 ${f(h - ry)} Z M0 ${f(ry)} A${f(w / 2)} ${f(ry)} 0 0 0 ${f(w)} ${f(ry)}`; }, text: [0, 0.25, 1, 0.9] },
  cube: { label: 'Cube', group: 'Basic Shapes', adj: { adj: 25000 }, path: (w, h, a) => { const d = ss(w, h) * a.adj / 100000; return P([[0, d], [d, 0], [w, 0], [w, h - d], [w - d, h], [0, h]]) + ` M0 ${f(d)} H${f(w - d)} L${f(w)} 0 M${f(w - d)} ${f(d)} V${f(h)}`; }, text: [0, 0.25, 0.75, 1] },
  bevel: { label: 'Bevel', group: 'Basic Shapes', adj: { adj: 12500 }, path: (w, h, a) => { const d = ss(w, h) * a.adj / 100000; return `M0 0 H${f(w)} V${f(h)} H0 Z M${f(d)} ${f(d)} H${f(w - d)} V${f(h - d)} H${f(d)} Z M0 0 L${f(d)} ${f(d)} M${f(w)} 0 L${f(w - d)} ${f(d)} M${f(w)} ${f(h)} L${f(w - d)} ${f(h - d)} M0 ${f(h)} L${f(d)} ${f(h - d)}`; } },
  foldedCorner: { label: 'Folded Corner', group: 'Basic Shapes', adj: { adj: 16667 }, path: (w, h, a) => { const d = ss(w, h) * a.adj / 100000; return P([[0, 0], [w, 0], [w, h - d], [w - d, h], [0, h]]) + ` M${f(w - d)} ${f(h)} L${f(w - d * 0.8)} ${f(h - d * 0.8)} L${f(w)} ${f(h - d)}`; } },
  smileyFace: { label: 'Smiley Face', group: 'Basic Shapes', path: (w, h) => ell(w / 2, h / 2, w / 2, h / 2) + ' ' + ell(w * 0.35, h * 0.38, w * 0.05, h * 0.05) + ' ' + ell(w * 0.65, h * 0.38, w * 0.05, h * 0.05) + ` M${f(w * 0.3)} ${f(h * 0.65)} Q${f(w / 2)} ${f(h * 0.82)} ${f(w * 0.7)} ${f(h * 0.65)}` },
  heart: { label: 'Heart', group: 'Basic Shapes', path: (w, h) => `M${f(w / 2)} ${f(h * 0.25)} C${f(w * 0.5)} 0 0 0 0 ${f(h * 0.3)} C0 ${f(h * 0.6)} ${f(w * 0.4)} ${f(h * 0.8)} ${f(w / 2)} ${f(h)} C${f(w * 0.6)} ${f(h * 0.8)} ${f(w)} ${f(h * 0.6)} ${f(w)} ${f(h * 0.3)} C${f(w)} 0 ${f(w * 0.5)} 0 ${f(w / 2)} ${f(h * 0.25)} Z` },
  lightningBolt: { label: 'Lightning Bolt', group: 'Basic Shapes', path: (w, h) => P([[0.39, 0], [0.62, 0.3], [0.53, 0.34], [0.8, 0.6], [0.72, 0.63], [1, 1], [0.48, 0.7], [0.58, 0.66], [0.25, 0.42], [0.36, 0.37], [0, 0.17]].map(([x, y]) => [x * w, y * h])) },
  sun: { label: 'Sun', group: 'Basic Shapes', path: (w, h) => { let d = ell(w / 2, h / 2, w * 0.25, h * 0.25); for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; const c = Math.cos(a), s = Math.sin(a); d += ' ' + P([[w / 2 + c * w * 0.32 - s * w * 0.05, h / 2 + s * h * 0.32 + c * h * 0.05], [w / 2 + c * w * 0.5, h / 2 + s * h * 0.5], [w / 2 + c * w * 0.32 + s * w * 0.05, h / 2 + s * h * 0.32 - c * h * 0.05]]); } return d; } },
  moon: { label: 'Moon', group: 'Basic Shapes', path: (w, h) => `M${f(w)} 0 A${f(w)} ${f(h / 2)} 0 0 0 ${f(w)} ${f(h)} A${f(w / 2)} ${f(h / 2)} 0 0 1 ${f(w)} 0 Z` },
  cloud: { label: 'Cloud', group: 'Basic Shapes', path: (w, h) => `M${f(w * 0.25)} ${f(h * 0.85)} C${f(w * 0.02)} ${f(h * 0.85)} 0 ${f(h * 0.55)} ${f(w * 0.17)} ${f(h * 0.5)} C${f(w * 0.08)} ${f(h * 0.25)} ${f(w * 0.3)} ${f(h * 0.12)} ${f(w * 0.42)} ${f(h * 0.25)} C${f(w * 0.5)} ${f(h * 0.02)} ${f(w * 0.8)} ${f(h * 0.05)} ${f(w * 0.8)} ${f(h * 0.3)} C${f(w)} ${f(h * 0.3)} ${f(w)} ${f(h * 0.65)} ${f(w * 0.85)} ${f(h * 0.72)} C${f(w * 0.88)} ${f(h * 0.95)} ${f(w * 0.55)} ${f(h)} ${f(w * 0.5)} ${f(h * 0.85)} C${f(w * 0.42)} ${f(h)} ${f(w * 0.28)} ${f(h)} ${f(w * 0.25)} ${f(h * 0.85)} Z`, text: [0.15, 0.25, 0.85, 0.8] },
  plaque: { label: 'Plaque', group: 'Basic Shapes', adj: { adj: 16667 }, path: (w, h, a) => { const r = ss(w, h) * a.adj / 100000; return `M${f(r)} 0 H${f(w - r)} A${f(r)} ${f(r)} 0 0 0 ${f(w)} ${f(r)} V${f(h - r)} A${f(r)} ${f(r)} 0 0 0 ${f(w - r)} ${f(h)} H${f(r)} A${f(r)} ${f(r)} 0 0 0 0 ${f(h - r)} V${f(r)} A${f(r)} ${f(r)} 0 0 0 ${f(r)} 0 Z`; } },
  bracketPair: { label: 'Double Bracket', group: 'Basic Shapes', open: true, path: (w, h) => { const r = ss(w, h) * 0.16; return `M${f(r)} ${f(h)} A${f(r)} ${f(r)} 0 0 1 0 ${f(h - r)} V${f(r)} A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0 M${f(w - r)} 0 A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)} V${f(h - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w - r)} ${f(h)}`; } },
  bracePair: { label: 'Double Brace', group: 'Basic Shapes', open: true, path: (w, h) => { const r = ss(w, h) * 0.08; return `M${f(2 * r)} ${f(h)} Q${f(r)} ${f(h)} ${f(r)} ${f(h - r)} V${f(h / 2 + r)} Q${f(r)} ${f(h / 2)} 0 ${f(h / 2)} Q${f(r)} ${f(h / 2)} ${f(r)} ${f(h / 2 - r)} V${f(r)} Q${f(r)} 0 ${f(2 * r)} 0 M${f(w - 2 * r)} 0 Q${f(w - r)} 0 ${f(w - r)} ${f(r)} V${f(h / 2 - r)} Q${f(w - r)} ${f(h / 2)} ${f(w)} ${f(h / 2)} Q${f(w - r)} ${f(h / 2)} ${f(w - r)} ${f(h / 2 + r)} V${f(h - r)} Q${f(w - r)} ${f(h)} ${f(w - 2 * r)} ${f(h)}`; } },
  plus: { label: 'Cross', group: 'Basic Shapes', adj: { adj: 25000 }, path: (w, h, a) => { const d = ss(w, h) * a.adj / 100000; return P([[d, 0], [w - d, 0], [w - d, d], [w, d], [w, h - d], [w - d, h - d], [w - d, h], [d, h], [d, h - d], [0, h - d], [0, d], [d, d]]); } },

  rightArrow: { label: 'Arrow: Right', group: 'Block Arrows', adj: { adj1: 50000, adj2: 50000 }, path: (w, h, a) => { const t = h * a.adj1 / 200000, hd = ss(w, h) * a.adj2 / 100000; return P([[0, h / 2 - t], [w - hd, h / 2 - t], [w - hd, 0], [w, h / 2], [w - hd, h], [w - hd, h / 2 + t], [0, h / 2 + t]]); } },
  leftArrow: { label: 'Arrow: Left', group: 'Block Arrows', adj: { adj1: 50000, adj2: 50000 }, path: (w, h, a) => { const t = h * a.adj1 / 200000, hd = ss(w, h) * a.adj2 / 100000; return P([[w, h / 2 - t], [hd, h / 2 - t], [hd, 0], [0, h / 2], [hd, h], [hd, h / 2 + t], [w, h / 2 + t]]); } },
  upArrow: { label: 'Arrow: Up', group: 'Block Arrows', adj: { adj1: 50000, adj2: 50000 }, path: (w, h, a) => { const t = w * a.adj1 / 200000, hd = ss(w, h) * a.adj2 / 100000; return P([[w / 2 - t, h], [w / 2 - t, hd], [0, hd], [w / 2, 0], [w, hd], [w / 2 + t, hd], [w / 2 + t, h]]); } },
  downArrow: { label: 'Arrow: Down', group: 'Block Arrows', adj: { adj1: 50000, adj2: 50000 }, path: (w, h, a) => { const t = w * a.adj1 / 200000, hd = ss(w, h) * a.adj2 / 100000; return P([[w / 2 - t, 0], [w / 2 - t, h - hd], [0, h - hd], [w / 2, h], [w, h - hd], [w / 2 + t, h - hd], [w / 2 + t, 0]]); } },
  leftRightArrow: { label: 'Arrow: Left-Right', group: 'Block Arrows', adj: { adj1: 50000, adj2: 50000 }, path: (w, h, a) => { const t = h * a.adj1 / 200000, hd = ss(w, h) * a.adj2 / 100000; return P([[0, h / 2], [hd, 0], [hd, h / 2 - t], [w - hd, h / 2 - t], [w - hd, 0], [w, h / 2], [w - hd, h], [w - hd, h / 2 + t], [hd, h / 2 + t], [hd, h]]); } },
  upDownArrow: { label: 'Arrow: Up-Down', group: 'Block Arrows', adj: { adj1: 50000, adj2: 50000 }, path: (w, h, a) => { const t = w * a.adj1 / 200000, hd = ss(w, h) * a.adj2 / 100000; return P([[w / 2, 0], [w, hd], [w / 2 + t, hd], [w / 2 + t, h - hd], [w, h - hd], [w / 2, h], [0, h - hd], [w / 2 - t, h - hd], [w / 2 - t, hd], [0, hd]]); } },
  quadArrow: { label: 'Arrow: Quad', group: 'Block Arrows', path: (w, h) => { const t = ss(w, h) * 0.1, hd = ss(w, h) * 0.2; const cx = w / 2, cy = h / 2; return P([[cx, 0], [cx + hd, hd], [cx + t, hd], [cx + t, cy - t], [w - hd, cy - t], [w - hd, cy - hd], [w, cy], [w - hd, cy + hd], [w - hd, cy + t], [cx + t, cy + t], [cx + t, h - hd], [cx + hd, h - hd], [cx, h], [cx - hd, h - hd], [cx - t, h - hd], [cx - t, cy + t], [hd, cy + t], [hd, cy + hd], [0, cy], [hd, cy - hd], [hd, cy - t], [cx - t, cy - t], [cx - t, hd], [cx - hd, hd]]); } },
  chevron: { label: 'Arrow: Chevron', group: 'Block Arrows', adj: { adj: 50000 }, path: (w, h, a) => { const d = ss(w, h) * a.adj / 100000; return P([[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h], [d, h / 2]]); } },
  homePlate: { label: 'Arrow: Pentagon', group: 'Block Arrows', adj: { adj: 50000 }, path: (w, h, a) => { const d = ss(w, h) * a.adj / 100000; return P([[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h]]); } },
  notchedRightArrow: { label: 'Arrow: Notched Right', group: 'Block Arrows', path: (w, h) => { const t = h / 4, hd = ss(w, h) / 2; return P([[0, h / 2 - t], [w - hd, h / 2 - t], [w - hd, 0], [w, h / 2], [w - hd, h], [w - hd, h / 2 + t], [0, h / 2 + t], [hd / 2, h / 2]]); } },
  stripedRightArrow: { label: 'Arrow: Striped Right', group: 'Block Arrows', path: (w, h) => { const t = h / 4, hd = ss(w, h) / 2, u = ss(w, h) / 32; return `M0 ${f(h / 2 - t)} H${f(u)} V${f(h / 2 + t)} H0 Z M${f(2 * u)} ${f(h / 2 - t)} H${f(4 * u)} V${f(h / 2 + t)} H${f(2 * u)} Z ` + P([[5 * u, h / 2 - t], [w - hd, h / 2 - t], [w - hd, 0], [w, h / 2], [w - hd, h], [w - hd, h / 2 + t], [5 * u, h / 2 + t]]); } },
  uturnArrow: { label: 'Arrow: U-Turn', group: 'Block Arrows', path: (w, h) => { const t = ss(w, h) * 0.25, r = w * 0.35; return `M0 ${f(h)} V${f(r)} A${f(r)} ${f(r)} 0 0 1 ${f(2 * r)} ${f(r)} V${f(h * 0.6)} H${f(w)} L${f(2 * r - t / 2)} ${f(h)} L${f(2 * r - 2 * t)} ${f(h * 0.6)} H${f(2 * r - t)} V${f(r)} A${f(r - t)} ${f(r - t)} 0 0 0 ${f(t)} ${f(r)} V${f(h)} Z`; } },
  circularArrow: { label: 'Arrow: Circular', group: 'Block Arrows', path: (w, h) => `M${f(w * 0.1)} ${f(h / 2)} A${f(w * 0.4)} ${f(h * 0.4)} 0 1 1 ${f(w * 0.75)} ${f(h * 0.85)} L${f(w * 0.68)} ${f(h)} L${f(w * 0.98)} ${f(h * 0.95)} L${f(w * 0.85)} ${f(h * 0.68)} L${f(w * 0.78)} ${f(h * 0.75)} A${f(w * 0.28)} ${f(h * 0.28)} 0 1 0 ${f(w * 0.22)} ${f(h / 2)} Z` },

  mathPlus: { label: 'Plus Sign', group: 'Equation Shapes', path: (w, h) => { const t = ss(w, h) * 0.12; return P([[w / 2 - t, h * 0.1], [w / 2 + t, h * 0.1], [w / 2 + t, h / 2 - t], [w * 0.9, h / 2 - t], [w * 0.9, h / 2 + t], [w / 2 + t, h / 2 + t], [w / 2 + t, h * 0.9], [w / 2 - t, h * 0.9], [w / 2 - t, h / 2 + t], [w * 0.1, h / 2 + t], [w * 0.1, h / 2 - t], [w / 2 - t, h / 2 - t]]); } },
  mathMinus: { label: 'Minus Sign', group: 'Equation Shapes', path: (w, h) => { const t = ss(w, h) * 0.12; return P([[w * 0.1, h / 2 - t], [w * 0.9, h / 2 - t], [w * 0.9, h / 2 + t], [w * 0.1, h / 2 + t]]); } },
  mathMultiply: { label: 'Multiplication Sign', group: 'Equation Shapes', path: (w, h) => { const t = 0.09; return P([[0.2, 0.2 - t], [0.5, 0.5 - t], [0.8, 0.2 - t], [0.8 + t, 0.2], [0.5 + t, 0.5], [0.8 + t, 0.8], [0.8, 0.8 + t], [0.5, 0.5 + t], [0.2, 0.8 + t], [0.2 - t, 0.8], [0.5 - t, 0.5], [0.2 - t, 0.2]].map(([x, y]) => [x * w, y * h])); } },
  mathDivide: { label: 'Division Sign', group: 'Equation Shapes', path: (w, h) => { const t = ss(w, h) * 0.08; return P([[w * 0.1, h / 2 - t], [w * 0.9, h / 2 - t], [w * 0.9, h / 2 + t], [w * 0.1, h / 2 + t]]) + ' ' + ell(w / 2, h * 0.22, t * 1.2, t * 1.2) + ' ' + ell(w / 2, h * 0.78, t * 1.2, t * 1.2); } },
  mathEqual: { label: 'Equal', group: 'Equation Shapes', path: (w, h) => { const t = ss(w, h) * 0.1; return P([[w * 0.1, h * 0.38 - t], [w * 0.9, h * 0.38 - t], [w * 0.9, h * 0.38 + t], [w * 0.1, h * 0.38 + t]]) + ' ' + P([[w * 0.1, h * 0.62 - t], [w * 0.9, h * 0.62 - t], [w * 0.9, h * 0.62 + t], [w * 0.1, h * 0.62 + t]]); } },
  mathNotEqual: { label: 'Not Equal', group: 'Equation Shapes', path: (w, h) => { const t = ss(w, h) * 0.08; return P([[w * 0.1, h * 0.38 - t], [w * 0.9, h * 0.38 - t], [w * 0.9, h * 0.38 + t], [w * 0.1, h * 0.38 + t]]) + ' ' + P([[w * 0.1, h * 0.62 - t], [w * 0.9, h * 0.62 - t], [w * 0.9, h * 0.62 + t], [w * 0.1, h * 0.62 + t]]) + ' ' + P([[w * 0.6, h * 0.08], [w * 0.68, h * 0.12], [w * 0.4, h * 0.92], [w * 0.32, h * 0.88]]); } },

  flowChartProcess: { label: 'Flowchart: Process', group: 'Flowchart', path: (w, h) => `M0 0 H${f(w)} V${f(h)} H0 Z` },
  flowChartAlternateProcess: { label: 'Flowchart: Alternate Process', group: 'Flowchart', path: (w, h) => roundRect(w, h, ss(w, h) * 0.17) },
  flowChartDecision: { label: 'Flowchart: Decision', group: 'Flowchart', path: (w, h) => P([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]), text: [0.25, 0.25, 0.75, 0.75] },
  flowChartInputOutput: { label: 'Flowchart: Data', group: 'Flowchart', path: (w, h) => P([[w * 0.2, 0], [w, 0], [w * 0.8, h], [0, h]]) },
  flowChartPredefinedProcess: { label: 'Flowchart: Predefined Process', group: 'Flowchart', path: (w, h) => `M0 0 H${f(w)} V${f(h)} H0 Z M${f(w * 0.125)} 0 V${f(h)} M${f(w * 0.875)} 0 V${f(h)}` },
  flowChartDocument: { label: 'Flowchart: Document', group: 'Flowchart', path: (w, h) => `M0 0 H${f(w)} V${f(h * 0.8)} C${f(w * 0.7)} ${f(h * 0.6)} ${f(w * 0.4)} ${f(h * 1.05)} 0 ${f(h * 0.88)} Z` },
  flowChartTerminator: { label: 'Flowchart: Terminator', group: 'Flowchart', path: (w, h) => roundRect(w, h, h / 2) },
  flowChartPreparation: { label: 'Flowchart: Preparation', group: 'Flowchart', path: (w, h) => P([[w * 0.2, 0], [w * 0.8, 0], [w, h / 2], [w * 0.8, h], [w * 0.2, h], [0, h / 2]]) },
  flowChartManualInput: { label: 'Flowchart: Manual Input', group: 'Flowchart', path: (w, h) => P([[0, h * 0.2], [w, 0], [w, h], [0, h]]) },
  flowChartManualOperation: { label: 'Flowchart: Manual Operation', group: 'Flowchart', path: (w, h) => P([[0, 0], [w, 0], [w * 0.8, h], [w * 0.2, h]]) },
  flowChartConnector: { label: 'Flowchart: Connector', group: 'Flowchart', path: (w, h) => ell(w / 2, h / 2, w / 2, h / 2) },
  flowChartOffpageConnector: { label: 'Flowchart: Off-page Connector', group: 'Flowchart', path: (w, h) => P([[0, 0], [w, 0], [w, h * 0.8], [w / 2, h], [0, h * 0.8]]) },
  flowChartMerge: { label: 'Flowchart: Merge', group: 'Flowchart', path: (w, h) => P([[0, 0], [w, 0], [w / 2, h]]) },
  flowChartExtract: { label: 'Flowchart: Extract', group: 'Flowchart', path: (w, h) => P([[w / 2, 0], [w, h], [0, h]]) },
  flowChartMagneticDisk: { label: 'Flowchart: Magnetic Disk', group: 'Flowchart', path: (w, h) => { const ry = h / 6; return `M0 ${f(ry)} A${f(w / 2)} ${f(ry)} 0 0 1 ${f(w)} ${f(ry)} V${f(h - ry)} A${f(w / 2)} ${f(ry)} 0 0 1 0 ${f(h - ry)} Z M0 ${f(ry)} A${f(w / 2)} ${f(ry)} 0 0 0 ${f(w)} ${f(ry)}`; } },
  flowChartPunchedCard: { label: 'Flowchart: Card', group: 'Flowchart', path: (w, h) => P([[w * 0.2, 0], [w, 0], [w, h], [0, h], [0, h * 0.2]]) },
  flowChartSort: { label: 'Flowchart: Sort', group: 'Flowchart', path: (w, h) => P([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) + ` M0 ${f(h / 2)} H${f(w)}` },
  flowChartDelay: { label: 'Flowchart: Delay', group: 'Flowchart', path: (w, h) => `M0 0 H${f(w / 2)} A${f(w / 2)} ${f(h / 2)} 0 0 1 ${f(w / 2)} ${f(h)} H0 Z` },

  star4: { label: 'Star: 4 Points', group: 'Stars and Banners', path: (w, h) => star(4, w, h, 0.25) },
  star5: { label: 'Star: 5 Points', group: 'Stars and Banners', path: (w, h) => star(5, w, h, 0.4), text: [0.3, 0.35, 0.7, 0.75] },
  star6: { label: 'Star: 6 Points', group: 'Stars and Banners', path: (w, h) => star(6, w, h, 0.58) },
  star7: { label: 'Star: 7 Points', group: 'Stars and Banners', path: (w, h) => star(7, w, h, 0.6) },
  star8: { label: 'Star: 8 Points', group: 'Stars and Banners', path: (w, h) => star(8, w, h, 0.7) },
  star10: { label: 'Star: 10 Points', group: 'Stars and Banners', path: (w, h) => star(10, w, h, 0.75) },
  star12: { label: 'Star: 12 Points', group: 'Stars and Banners', path: (w, h) => star(12, w, h, 0.75) },
  star16: { label: 'Star: 16 Points', group: 'Stars and Banners', path: (w, h) => star(16, w, h, 0.8) },
  star24: { label: 'Star: 24 Points', group: 'Stars and Banners', path: (w, h) => star(24, w, h, 0.85) },
  irregularSeal1: { label: 'Explosion: 8 Points', group: 'Stars and Banners', path: (w, h) => P([[0.43, 0.3], [0.58, 0], [0.62, 0.25], [0.89, 0.06], [0.78, 0.33], [1, 0.42], [0.79, 0.56], [0.92, 0.84], [0.62, 0.7], [0.55, 1], [0.42, 0.75], [0.2, 0.92], [0.24, 0.66], [0, 0.6], [0.17, 0.43], [0.03, 0.2], [0.3, 0.28]].map(([x, y]) => [x * w, y * h])) },
  ribbon2: { label: 'Ribbon: Tilted Up', group: 'Stars and Banners', path: (w, h) => P([[w * 0.2, 0], [w * 0.8, 0], [w * 0.8, h * 0.7], [w * 0.2, h * 0.7]]) + ' ' + P([[w * 0.2, h * 0.2], [0, h * 0.2], [w * 0.1, h * 0.55], [0, h * 0.9], [w * 0.2, h * 0.9]]) + ' ' + P([[w * 0.8, h * 0.2], [w, h * 0.2], [w * 0.9, h * 0.55], [w, h * 0.9], [w * 0.8, h * 0.9]]) },
  wave: { label: 'Wave', group: 'Stars and Banners', path: (w, h) => `M0 ${f(h * 0.15)} C${f(w * 0.33)} ${f(-h * 0.1)} ${f(w * 0.66)} ${f(h * 0.4)} ${f(w)} ${f(h * 0.15)} V${f(h * 0.85)} C${f(w * 0.66)} ${f(h * 1.1)} ${f(w * 0.33)} ${f(h * 0.6)} 0 ${f(h * 0.85)} Z` },
  verticalScroll: { label: 'Scroll: Vertical', group: 'Stars and Banners', path: (w, h) => { const r = ss(w, h) * 0.06; return `M${f(r * 2)} ${f(r)} H${f(w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w - r)} ${f(r * 3)} H${f(w - 2 * r)} V${f(h - r)} H${f(r)} A${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(h - 3 * r)} H${f(2 * r)} Z`; } },
  horizontalScroll: { label: 'Scroll: Horizontal', group: 'Stars and Banners', path: (w, h) => { const r = ss(w, h) * 0.06; return `M${f(r)} ${f(2 * r)} V${f(h - r)} A${f(r)} ${f(r)} 0 0 0 ${f(3 * r)} ${f(h - r)} V${f(h - 2 * r)} H${f(w - r)} V${f(r)} A${f(r)} ${f(r)} 0 0 0 ${f(w - 3 * r)} ${f(r)} V${f(2 * r)} Z`; } },

  wedgeRectCallout: { label: 'Speech Bubble: Rectangle', group: 'Callouts', adj: { adj1: -20833, adj2: 62500 }, path: (w, h, a) => { const tx = w / 2 + w * a.adj1 / 100000, ty = h / 2 + h * a.adj2 / 100000; return `M0 0 H${f(w)} V${f(h)} H${f(w * 0.58)} L${f(tx)} ${f(ty)} L${f(w * 0.42)} ${f(h)} H0 Z`; } },
  wedgeRoundRectCallout: { label: 'Speech Bubble: Rounded Rectangle', group: 'Callouts', adj: { adj1: -20833, adj2: 62500 }, path: (w, h, a) => { const r = ss(w, h) * 0.17, tx = w / 2 + w * a.adj1 / 100000, ty = h / 2 + h * a.adj2 / 100000; return `M${f(r)} 0 H${f(w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)} V${f(h - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w - r)} ${f(h)} H${f(w * 0.58)} L${f(tx)} ${f(ty)} L${f(w * 0.42)} ${f(h)} H${f(r)} A${f(r)} ${f(r)} 0 0 1 0 ${f(h - r)} V${f(r)} A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0 Z`; } },
  wedgeEllipseCallout: { label: 'Speech Bubble: Oval', group: 'Callouts', adj: { adj1: -20833, adj2: 62500 }, path: (w, h, a) => { const tx = w / 2 + w * a.adj1 / 100000, ty = h / 2 + h * a.adj2 / 100000; return `M${f(w * 0.35)} ${f(h * 0.97)} L${f(tx)} ${f(ty)} L${f(w * 0.22)} ${f(h * 0.88)} A${f(w / 2)} ${f(h / 2)} 0 1 1 ${f(w * 0.35)} ${f(h * 0.97)} Z`; } },
  cloudCallout: { label: 'Thought Bubble: Cloud', group: 'Callouts', path: (w, h) => GEOMETRY.cloud.path(w, h * 0.8, {}) + ' ' + ell(w * 0.25, h * 0.88, w * 0.05, h * 0.04) + ' ' + ell(w * 0.15, h * 0.96, w * 0.03, h * 0.025) },
  borderCallout1: { label: 'Callout: Line', group: 'Callouts', path: (w, h) => `M0 0 H${f(w)} V${f(h)} H0 Z M0 ${f(h / 2)} L${f(-w * 0.3)} ${f(h * 1.3)}` },

  actionButtonBlank: { label: 'Action Button: Blank', group: 'Action Buttons', path: (w, h) => `M0 0 H${f(w)} V${f(h)} H0 Z` },
  actionButtonForwardNext: { label: 'Action Button: Next', group: 'Action Buttons', path: (w, h) => `M0 0 H${f(w)} V${f(h)} H0 Z ` + P([[w * 0.3, h * 0.25], [w * 0.75, h / 2], [w * 0.3, h * 0.75]]) },
  actionButtonBackPrevious: { label: 'Action Button: Back', group: 'Action Buttons', path: (w, h) => `M0 0 H${f(w)} V${f(h)} H0 Z ` + P([[w * 0.7, h * 0.25], [w * 0.25, h / 2], [w * 0.7, h * 0.75]]) },
  actionButtonBeginning: { label: 'Action Button: Beginning', group: 'Action Buttons', path: (w, h) => `M0 0 H${f(w)} V${f(h)} H0 Z ` + P([[w * 0.72, h * 0.25], [w * 0.35, h / 2], [w * 0.72, h * 0.75]]) + ` M${f(w * 0.28)} ${f(h * 0.25)} H${f(w * 0.33)} V${f(h * 0.75)} H${f(w * 0.28)} Z` },
  actionButtonEnd: { label: 'Action Button: End', group: 'Action Buttons', path: (w, h) => `M0 0 H${f(w)} V${f(h)} H0 Z ` + P([[w * 0.28, h * 0.25], [w * 0.65, h / 2], [w * 0.28, h * 0.75]]) + ` M${f(w * 0.67)} ${f(h * 0.25)} H${f(w * 0.72)} V${f(h * 0.75)} H${f(w * 0.67)} Z` },
  actionButtonHome: { label: 'Action Button: Home', group: 'Action Buttons', path: (w, h) => `M0 0 H${f(w)} V${f(h)} H0 Z ` + P([[w / 2, h * 0.2], [w * 0.8, h * 0.5], [w * 0.7, h * 0.5], [w * 0.7, h * 0.8], [w * 0.3, h * 0.8], [w * 0.3, h * 0.5], [w * 0.2, h * 0.5]]) },
  actionButtonReturn: { label: 'Action Button: Return', group: 'Action Buttons', path: (w, h) => `M0 0 H${f(w)} V${f(h)} H0 Z M${f(w * 0.7)} ${f(h * 0.3)} V${f(h * 0.6)} A${f(w * 0.12)} ${f(h * 0.12)} 0 0 1 ${f(w * 0.46)} ${f(h * 0.6)} V${f(h * 0.35)} H${f(w * 0.38)} L${f(w * 0.5)} ${f(h * 0.22)} L${f(w * 0.62)} ${f(h * 0.35)} H${f(w * 0.54)} V${f(h * 0.6)} A${f(w * 0.04)} ${f(h * 0.04)} 0 0 0 ${f(w * 0.62)} ${f(h * 0.6)} V${f(h * 0.3)} Z` },
};

/** Builds the SVG path of an element's geometry in its own w × h box. */
export function geometryPath(geom: string, w: number, h: number, adj?: Record<string, number>, custom?: { d: string; w: number; h: number }[]): { d: string; open: boolean } {
  if (geom === 'custom' && custom?.length) {
    // Scale each custom path from its own coordinate space to the box.
    const d = custom.map((p) => scalePath(p.d, p.w ? w / p.w : 1, p.h ? h / p.h : 1)).join(' ');
    return { d, open: !/[Zz]\s*$/.test(String(custom[custom.length - 1].d ?? '').trim()) };
  }
  const def = GEOMETRY[geom] || GEOMETRY.rect;
  const a = { ...(def.adj || {}), ...(adj || {}) };
  return { d: def.path(Math.max(0, w), Math.max(0, h), a), open: !!def.open };
}

/** Text rectangle of a preset inside a w × h box: [x, y, w, h]. */
export function textRect(geom: string, w: number, h: number): [number, number, number, number] {
  const t = GEOMETRY[geom]?.text;
  if (!t) return [0, 0, w, h];
  return [t[0] * w, t[1] * h, (t[2] - t[0]) * w, (t[3] - t[1]) * h];
}

/** Scales an absolute SVG path (M, L, H, V, C, Q, A, Z commands). */
export function scalePath(d: string, sx: number, sy: number): string {
  if (typeof d !== 'string') return '';
  // Path data comes from files and is interpolated into markup: keep only path-data characters.
  if (sx === 1 && sy === 1) return d.replace(/[^MmLlHhVvCcSsQqTtAaZz0-9.,eE+\-\s]/g, '');
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  let out = '';
  let cmd = '';
  let idx = 0;
  for (const t of tokens) {
    if (/[a-zA-Z]/.test(t)) { cmd = t; idx = 0; out += t; continue; }
    const n = parseFloat(t);
    let v = n;
    const C = cmd.toUpperCase();
    if (C === 'H') v = n * sx;
    else if (C === 'V') v = n * sy;
    else if (C === 'A') { const k = idx % 7; v = k === 0 || k === 5 ? n * sx : k === 1 || k === 6 ? n * sy : n; }
    else v = idx % 2 === 0 ? n * sx : n * sy;
    out += ` ${f(v)}`;
    idx++;
  }
  return out;
}

export const SHAPE_GROUPS = ['Lines', 'Rectangles', 'Basic Shapes', 'Block Arrows', 'Equation Shapes', 'Flowchart', 'Stars and Banners', 'Callouts', 'Action Buttons'] as const;
