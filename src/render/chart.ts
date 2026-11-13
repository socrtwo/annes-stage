/** Chart renderer for slide charts (column, bar, line, area, pie, doughnut, scatter, radar) as SVG. */
import type { ChartElement, Color } from '../model/types';

type Chart = ChartElement['chart'];
import { escXml as esc } from '../util/sanitize';

const n = (v: number) => (Number.isFinite(v) ? +v.toFixed(2) : 0);
/** A data value as a finite number, or null for blanks and junk. */
const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const SERIES: Color[] = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function renderChart(c: Chart, w: number, h: number, color: (c: Color) => string, id: string): string {
  const out: string[] = [];
  const font = 'font-family="Carlito, Arimo, sans-serif"';
  const txt = color('tx1');
  out.push(`<rect width="${n(w)}" height="${n(h)}" fill="none"/>`);
  let top = 8;
  if (c.title) { out.push(`<text x="${n(w / 2)}" y="${n(22)}" text-anchor="middle" font-size="16" ${font} fill="${txt}">${esc(c.title)}</text>`); top = 34; }
  const legend = c.legend ?? 'b';
  const seriesColor = (i: number) => color(c.series[i]?.color || SERIES[i % SERIES.length]);
  const isPie = c.type === 'pie' || c.type === 'doughnut';
  const legendItems = isPie ? c.categories : c.series.map((s) => s.name);
  let bottom = h - 8, right = w - 8;
  if (legend === 'b' && legendItems.length) {
    bottom -= 22;
    let x = 0;
    const widths = legendItems.map((t) => 16 + String(t ?? '').length * 6.5 + 12);
    const total = widths.reduce((a, b) => a + b, 0);
    x = Math.max(4, (w - total) / 2);
    legendItems.forEach((t, i) => {
      out.push(`<rect x="${n(x)}" y="${n(h - 22)}" width="10" height="10" fill="${isPie ? color(SERIES[i % 6]) : seriesColor(i)}"/><text x="${n(x + 14)}" y="${n(h - 13)}" font-size="11" ${font} fill="${txt}">${esc(t)}</text>`);
      x += widths[i];
    });
  } else if (legend === 'r' && legendItems.length) {
    right -= 110;
    legendItems.forEach((t, i) => out.push(`<rect x="${n(right + 14)}" y="${n(top + 8 + i * 18)}" width="10" height="10" fill="${isPie ? color(SERIES[i % 6]) : seriesColor(i)}"/><text x="${n(right + 28)}" y="${n(top + 17 + i * 18)}" font-size="11" ${font} fill="${txt}">${esc(t)}</text>`));
  }
  const pw = right - 8, ph = bottom - top;
  if (isPie) {
    const vals = (c.series[0]?.values || []).map((v) => Math.max(0, num(v) ?? 0));
    const sum = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = 8 + pw / 2, cy = top + ph / 2, r = Math.max(4, Math.min(pw, ph) / 2 - 4);
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      const a1 = a0 + (v / sum) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = vals.length === 1 || v === sum ? `M${n(cx - r)} ${n(cy)} A${n(r)} ${n(r)} 0 1 0 ${n(cx + r)} ${n(cy)} A${n(r)} ${n(r)} 0 1 0 ${n(cx - r)} ${n(cy)} Z` : `M${n(cx)} ${n(cy)} L${n(cx + r * Math.cos(a0))} ${n(cy + r * Math.sin(a0))} A${n(r)} ${n(r)} 0 ${large} 1 ${n(cx + r * Math.cos(a1))} ${n(cy + r * Math.sin(a1))} Z`;
      out.push(`<path d="${p}" fill="${color(SERIES[i % 6])}" stroke="${color('bg1')}" stroke-width="1"/>`);
      if (c.labels) { const m = (a0 + a1) / 2; out.push(`<text x="${n(cx + r * 0.65 * Math.cos(m))}" y="${n(cy + r * 0.65 * Math.sin(m))}" text-anchor="middle" font-size="11" ${font} fill="${color('bg1')}">${Math.round((v / sum) * 100)}%</text>`); }
      a0 = a1;
    });
    if (c.type === 'doughnut') out.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.5)}" fill="${color('bg1')}"/>`);
    return out.join('');
  }
  // Value of each point and the base it stands on. Stacked charts (column, bar, line, area) stack
  // positives and negatives separately; 100% stacked divides by the category's total magnitude.
  const nc = Math.max(1, c.categories.length);
  const stackable = c.type === 'column' || c.type === 'bar' || c.type === 'line' || c.type === 'area';
  const stacked = stackable ? c.stacked : undefined;
  const raw = c.series.map((s) => (s.values || []).map(num));
  const pts: ({ from: number; to: number; raw: number } | null)[][] = raw.map((vals) => vals.map((v) => (v == null ? null : { from: 0, to: v, raw: v })));
  if (stacked) {
    for (let i = 0; i < nc; i++) {
      const tot = raw.reduce((a, vals) => a + Math.abs(vals[i] ?? 0), 0) || 1;
      let pos = 0, neg = 0;
      raw.forEach((vals, si) => {
        const v0 = vals[i];
        if (v0 == null) return;
        const v = stacked === 'percent' ? v0 / tot : v0;
        if (v >= 0) { pts[si][i] = { from: pos, to: pos + v, raw: v0 }; pos += v; }
        else { pts[si][i] = { from: neg, to: neg + v, raw: v0 }; neg += v; }
      });
    }
  }
  const ends = pts.flatMap((row) => row.flatMap((p) => (p ? [p.from, p.to] : [])));
  let maxV = Math.max(0, ...ends), minV = Math.min(0, ...ends);
  if (stacked === 'percent') { maxV = maxV > 1e-9 ? 1 : 0; minV = minV < -1e-9 ? -1 : 0; if (!maxV && !minV) maxV = 1; }
  else { maxV = maxV > 0 || minV >= 0 ? niceMax(maxV) : 0; if (minV < 0) minV = -niceMax(-minV); }
  const left = 8 + 40;
  const plotW = pw - 40, plotH = ph - 18;
  const horizontal = c.type === 'bar';
  const scale = (v: number) => (horizontal ? ((v - minV) / (maxV - minV)) * plotW : plotH - ((v - minV) / (maxV - minV)) * plotH);
  // Gridlines and value axis
  for (let k = 0; k <= 4; k++) {
    const v = minV + ((maxV - minV) * k) / 4;
    const label = stacked === 'percent' ? `${Math.round(v * 100)}%` : Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${+v.toFixed(2)}`;
    if (horizontal) { const x = left + scale(v); out.push(`<path d="M${n(x)} ${n(top)} V${n(top + plotH)}" stroke="#ccc" stroke-width="0.5"/><text x="${n(x)}" y="${n(top + plotH + 13)}" text-anchor="middle" font-size="10" ${font} fill="${txt}">${label}</text>`); }
    else { const y = top + scale(v); out.push(`<path d="M${n(left)} ${n(y)} H${n(left + plotW)}" stroke="#ccc" stroke-width="0.5"/><text x="${n(left - 4)}" y="${n(y + 3)}" text-anchor="end" font-size="10" ${font} fill="${txt}">${label}</text>`); }
  }
  const band = (horizontal ? plotH : plotW) / nc;
  c.categories.forEach((cat, i) => {
    if (horizontal) out.push(`<text x="${n(left - 4)}" y="${n(top + band * (i + 0.5) + 3)}" text-anchor="end" font-size="10" ${font} fill="${txt}">${esc(cat)}</text>`);
    else out.push(`<text x="${n(left + band * (i + 0.5))}" y="${n(top + plotH + 13)}" text-anchor="middle" font-size="10" ${font} fill="${txt}">${esc(cat)}</text>`);
  });
  if (c.type === 'column' || c.type === 'bar') {
    const ns = c.series.length || 1;
    const gap = band * 0.2;
    const bw = stacked ? band - 2 * gap : (band - 2 * gap) / ns;
    pts.forEach((row, si) => {
      row.forEach((p, i) => {
        if (!p || i >= nc) return;
        const { from, to } = p;
        const off = band * i + gap + (stacked ? 0 : bw * si);
        if (horizontal) { const x0 = left + scale(Math.min(from, to)), x1 = left + scale(Math.max(from, to)); out.push(`<rect x="${n(x0)}" y="${n(top + off)}" width="${n(x1 - x0)}" height="${n(bw)}" fill="${seriesColor(si)}"/>`); }
        else { const y0 = top + scale(Math.max(from, to)), y1 = top + scale(Math.min(from, to)); out.push(`<rect x="${n(left + off)}" y="${n(y0)}" width="${n(bw)}" height="${n(y1 - y0)}" fill="${seriesColor(si)}"/>`); }
        if (c.labels) out.push(`<text x="${n(horizontal ? left + scale(to) + 3 : left + off + bw / 2)}" y="${n(horizontal ? top + off + bw / 2 + 3 : top + scale(to) - 3)}" text-anchor="${horizontal ? 'start' : 'middle'}" font-size="10" ${font} fill="${txt}">${+p.raw.toFixed(2)}</text>`);
      });
    });
  } else if (c.type === 'line' || c.type === 'area' || c.type === 'radar') {
    const X = (i: number) => left + band * (i + 0.5);
    const zero = top + scale(Math.max(0, minV));
    pts.forEach((row, si) => {
      // Blank values break the line (and the area) into runs.
      const runs: { i: number; p: { from: number; to: number } }[][] = [];
      let cur: { i: number; p: { from: number; to: number } }[] = [];
      row.forEach((p, i) => { if (i >= nc) return; if (p) cur.push({ i, p }); else if (cur.length) { runs.push(cur); cur = []; } });
      if (cur.length) runs.push(cur);
      for (const run of runs) {
        const d = 'M' + run.map(({ i, p }) => `${n(X(i))} ${n(top + scale(p.to))}`).join(' L');
        if (c.type === 'area') {
          const back = stacked ? run.slice().reverse().map(({ i, p }) => `L${n(X(i))} ${n(top + scale(p.from))}`).join(' ') : `L${n(X(run[run.length - 1].i))} ${n(zero)} L${n(X(run[0].i))} ${n(zero)}`;
          out.push(`<path d="${d} ${back} Z" fill="${seriesColor(si)}" opacity="0.7"/>`);
        }
        out.push(`<path d="${d}" fill="none" stroke="${seriesColor(si)}" stroke-width="2.25"/>`);
        for (const { i, p } of run) out.push(`<circle cx="${n(X(i))}" cy="${n(top + scale(p.to))}" r="2.5" fill="${seriesColor(si)}"/>`);
      }
    });
  } else if (c.type === 'scatter') {
    const xs = c.categories.map((t, i) => (t !== '' && Number.isFinite(+t) ? +t : i + 1));
    const xmax = niceMax(Math.max(...xs, 1)), xmin = Math.min(0, ...xs);
    raw.forEach((vals, si) => vals.forEach((v, i) => {
      if (v == null) return;
      out.push(`<circle cx="${n(left + ((xs[i] - xmin) / (xmax - xmin)) * plotW)}" cy="${n(top + scale(v))}" r="3.5" fill="${seriesColor(si)}"/>`);
    }));
  }
  void id;
  return out.join('');
}
