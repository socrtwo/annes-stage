/** Table Design and Table Layout: style options, styles, shading, borders, rows and columns, merge, sort, conversion. */
import { def } from './registry';
import type { App } from '../app';
import type { Color, Line, ShapeElement, TableCell, TableElement } from '../model/types';
import { clone, newId } from '../model/deck';
import { boxOf, edit, textTargets } from '../edit/ops';
import { openDialog, toast } from '../ui/dialog';
import { h } from '../ui/dom';
import { cssColor } from '../model/theme';
import { paraText } from '../edit/textEdit';

const tables = (app: App) => app.selected.filter((e): e is TableElement => e.kind === 'table');
const hasTable = (app: App) => tables(app).length > 0;
const emptyCell = (): TableCell => ({ text: { paras: [{ level: 0, runs: [] }] } });
const cellText = (c: TableCell) => c.text.paras.map(paraText).join('\n');
const setText = (c: TableCell, t: string) => { c.text = { ...c.text, paras: t.split('\n').map((l) => ({ level: 0, runs: l ? [{ text: l }] : [] })) }; };

/** The table cell commands act on: set by the table editor; defaults to the last row and column. */
export function currentCell(app: App, t: TableElement): { r: number; c: number; r2: number; c2: number } {
  const tc = (app.tab as any)?.tableCell as { id: string; r: number; c: number; r2?: number; c2?: number } | undefined;
  if (tc && tc.id === t.id && tc.r < t.rows.length && tc.c < t.cols.length) return { r: tc.r, c: tc.c, r2: Math.min(tc.r2 ?? tc.r, t.rows.length - 1), c2: Math.min(tc.c2 ?? tc.c, t.cols.length - 1) };
  return { r: t.rows.length - 1, c: t.cols.length - 1, r2: t.rows.length - 1, c2: t.cols.length - 1 };
}

// ------------------------------------------------------------------------------------------
// Pure table operations

export function insertRow(t: TableElement, at: number): void {
  const ref = t.rows[Math.min(Math.max(0, at - 1), t.rows.length - 1)] || { h: 30, cells: [] };
  t.rows.splice(at, 0, { h: ref.h, cells: t.cols.map(() => emptyCell()) });
  t.h = t.rows.reduce((a, r) => a + r.h, 0);
}
export function insertCol(t: TableElement, at: number): void {
  const w = t.cols[Math.min(Math.max(0, at - 1), t.cols.length - 1)] ?? 100;
  const total = t.cols.reduce((a, b) => a + b, 0);
  t.cols.splice(at, 0, w);
  // Keep the table's width: shrink all columns proportionally.
  const s = total / (total + w);
  t.cols = t.cols.map((c) => c * s);
  for (const r of t.rows) r.cells.splice(at, 0, emptyCell());
}
export function deleteRow(t: TableElement, r: number): void { if (t.rows.length > 1) { t.rows.splice(r, 1); t.h = t.rows.reduce((a, x) => a + x.h, 0); } }
export function deleteCol(t: TableElement, c: number): void {
  if (t.cols.length < 2) return;
  const total = t.cols.reduce((a, b) => a + b, 0);
  t.cols.splice(c, 1);
  const s = total / t.cols.reduce((a, b) => a + b, 0);
  t.cols = t.cols.map((x) => x * s);
  for (const r of t.rows) r.cells.splice(c, 1);
}
export function mergeCells(t: TableElement, r1: number, c1: number, r2: number, c2: number): void {
  const [ra, rb] = [Math.min(r1, r2), Math.max(r1, r2)], [ca, cb] = [Math.min(c1, c2), Math.max(c1, c2)];
  const texts: string[] = [];
  for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) { const cell = t.rows[r].cells[c]; const s = cellText(cell).trim(); if (s) texts.push(s); if (r !== ra || c !== ca) { t.rows[r].cells[c] = { ...emptyCell(), merged: true }; } }
  const top = t.rows[ra].cells[ca];
  top.rowSpan = rb - ra + 1 > 1 ? rb - ra + 1 : undefined;
  top.colSpan = cb - ca + 1 > 1 ? cb - ca + 1 : undefined;
  top.merged = undefined;
  setText(top, texts.join('\n'));
}
export function splitCell(t: TableElement, r: number, c: number): void {
  // Find the merge origin covering (r, c).
  for (let rr = 0; rr <= r; rr++) for (let cc = 0; cc <= c; cc++) {
    const cell = t.rows[rr].cells[cc];
    if (cell.merged) continue;
    const rs = cell.rowSpan || 1, cs = cell.colSpan || 1;
    if (rr + rs > r && cc + cs > c && (rs > 1 || cs > 1)) {
      for (let a = rr; a < rr + rs; a++) for (let b = cc; b < cc + cs; b++) if (a !== rr || b !== cc) t.rows[a].cells[b] = emptyCell();
      delete cell.rowSpan; delete cell.colSpan;
      return;
    }
  }
}

function withTable(app: App, label: string, fn: (t: TableElement, cur: ReturnType<typeof currentCell>) => void): void {
  const t0 = tables(app)[0];
  if (!t0) { toast('Select a table first.'); return; }
  const cur = currentCell(app, t0);
  edit(app, label, (o) => { const t = o.elements.find((e) => e.id === t0.id) as TableElement; fn(t, cur); });
}

const styleFlag = (key: keyof NonNullable<TableElement['style']>, id: string, label: string, icon: string) => ({
  id, label, icon, tab: 'Table Design', group: 'Table Style Options', kind: 'toggle' as const, edits: true, isEnabled: hasTable,
  isActive: (app: App) => !!(tables(app)[0]?.style as any)?.[key],
  run: (app: App) => withTable(app, label, (t) => { t.style = { ...(t.style || {}) }; (t.style as any)[key] = !(t.style as any)[key] || undefined; }),
});

// ------------------------------------------------------------------------------------------
// Table editor

async function editCells(app: App): Promise<void> {
  const t0 = tables(app)[0];
  if (!t0) { toast('Select a table first.'); return; }
  const work = clone(t0);
  let cur = currentCell(app, work);
  const host = h('div', { style: 'overflow:auto;max-height:55vh' });
  // Touch has no Shift key: with this on, tapping a cell extends the range instead of moving to it.
  const extendBox = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const extendRow = h('label', { class: 'ql-check', style: 'display:flex;align-items:center;gap:6px;margin:0 0 6px' }, extendBox, 'Extend selection (tap cells to select a range for Merge)');
  const draw = () => {
    host.textContent = '';
    const tbl = h('table', { style: 'border-collapse:collapse' });
    work.rows.forEach((row, r) => {
      const tr = h('tr');
      row.cells.forEach((cell, c) => {
        if (cell.merged) return;
        const inRange = r >= Math.min(cur.r, cur.r2) && r <= Math.max(cur.r, cur.r2) && c >= Math.min(cur.c, cur.c2) && c <= Math.max(cur.c, cur.c2);
        const ta = h('textarea', { rows: String(Math.max(1, cell.rowSpan || 1)), style: `width:${Math.max(70, (cell.colSpan || 1) * 110)}px;resize:vertical;${inRange ? 'outline:2px solid #4285f4' : ''}` }) as HTMLTextAreaElement;
        ta.value = cellText(cell);
        ta.addEventListener('input', () => setText(cell, ta.value));
        ta.addEventListener('focus', () => { cur = { r, c, r2: r, c2: c }; for (const x of host.querySelectorAll('textarea')) (x as HTMLElement).style.outline = ''; ta.style.outline = '2px solid #4285f4'; });
        // mousedown also arrives for a finger tap; cancelling it keeps focus (and the phone keyboard) where it is.
        ta.addEventListener('mousedown', (e) => { if (e.shiftKey || extendBox.checked) { e.preventDefault(); cur = { ...cur, r2: r, c2: c }; draw(); } });
        ta.addEventListener('keydown', (e) => e.stopPropagation());
        tr.appendChild(h('td', { rowspan: String(cell.rowSpan || 1), colspan: String(cell.colSpan || 1), style: 'padding:2px;vertical-align:top' }, ta));
      });
      tbl.appendChild(tr);
    });
    host.appendChild(tbl);
  };
  draw();
  const act = (fn: () => void) => () => { fn(); draw(); };
  const r = await openDialog({
    title: 'Edit Table', wide: true, content: h('div', null, extendRow, host), ok: 'Apply',
    help: 'Click a cell to make it current; Shift+click another cell (or turn on Extend selection and tap it) to select a range for Merge.',
    buttons: [
      { label: 'Row Above', onClick: act(() => { insertRow(work, cur.r); cur.r++; cur.r2 = cur.r; }) },
      { label: 'Row Below', onClick: act(() => insertRow(work, cur.r + 1)) },
      { label: 'Column Left', onClick: act(() => { insertCol(work, cur.c); cur.c++; cur.c2 = cur.c; }) },
      { label: 'Column Right', onClick: act(() => insertCol(work, cur.c + 1)) },
      { label: 'Delete Row', onClick: act(() => { deleteRow(work, cur.r); cur = { r: Math.min(cur.r, work.rows.length - 1), c: cur.c, r2: Math.min(cur.r, work.rows.length - 1), c2: cur.c }; }) },
      { label: 'Delete Column', onClick: act(() => { deleteCol(work, cur.c); cur = { r: cur.r, c: Math.min(cur.c, work.cols.length - 1), r2: cur.r, c2: Math.min(cur.c, work.cols.length - 1) }; }) },
      { label: 'Merge', onClick: act(() => { mergeCells(work, cur.r, cur.c, cur.r2, cur.c2); extendBox.checked = false; }) },
      { label: 'Split', onClick: act(() => splitCell(work, cur.r, cur.c)) },
    ],
  });
  (app.tab as any).tableCell = { id: t0.id, ...cur };
  if (!r) return;
  edit(app, 'Edit Table', (o) => { const i = o.elements.findIndex((e) => e.id === t0.id); if (i >= 0) o.elements[i] = work; });
}

const TABLE_STYLES = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'tx1'] as const;

def([
  styleFlag('firstRow', 'table.headerRow', 'Header Row', 'table_rows'),
  styleFlag('lastRow', 'table.totalRow', 'Total Row', 'functions'),
  styleFlag('bandRow', 'table.bandedRows', 'Banded Rows', 'reorder'),
  styleFlag('firstCol', 'table.firstColumn', 'First Column', 'view_column'),
  styleFlag('lastCol', 'table.lastColumn', 'Last Column', 'view_column'),
  styleFlag('bandCol', 'table.bandedColumns', 'Banded Columns', 'view_week'),
  {
    id: 'table.style', label: 'Table Styles', icon: 'table_view', tab: 'Table Design', group: 'Table Styles', kind: 'gallery', edits: true, isEnabled: hasTable,
    run: (app, a?: string) => { if (a) withTable(app, 'Table Style', (t) => { t.style = { firstRow: true, bandRow: true, ...(t.style || {}), accent: a }; for (const r of t.rows) for (const c of r.cells) delete c.fill; }); },
    menu: (app) => { const ctx = { theme: app.deck.themeOf((app.owner || app.deck.data.masters[0]) as any) }; return TABLE_STYLES.map((a, i) => ({ id: 'table.style', arg: a, label: a === 'tx1' ? 'Dark' : `Accent ${i + 1}`, checked: tables(app)[0]?.style?.accent === a, preview: `background:${cssColor(a, ctx)};color:#fff;padding:0 6px` })); },
  },
  {
    id: 'table.clearStyle', label: 'Clear Table', icon: 'format_clear', tab: 'Table Design', group: 'Table Styles', edits: true, isEnabled: hasTable,
    tip: 'Remove the table style, shading and borders', run: (app) => withTable(app, 'Clear Table', (t) => { t.style = {}; for (const r of t.rows) for (const c of r.cells) { delete c.fill; c.borders = [0, 1, 2, 3].map(() => ({ fill: { type: 'solid', color: 'tx1' }, width: 0.75 })) as any; } }),
  },
  {
    id: 'table.shading', label: 'Shading', icon: 'format_color_fill', tab: 'Table Design', group: 'Table Styles', kind: 'color', edits: true, isEnabled: hasTable,
    tip: 'Fill color of the current cells (set in Edit Table), or of the whole table',
    run: async (app, arg?: any) => {
      let c: Color | null | undefined = arg && arg !== 'menu' ? arg : undefined;
      if (c === undefined) { const { themeColorMenu } = await import('../ui/themeColors'); c = await themeColorMenu(app, app.ui.anchorFor('table.shading'), { none: 'No Fill' }); }
      if (c === undefined) return;
      const hasCur = !!(app.tab as any).tableCell;
      withTable(app, 'Shading', (t, cur) => {
        const [ra, rb, ca, cb] = hasCur ? [Math.min(cur.r, cur.r2), Math.max(cur.r, cur.r2), Math.min(cur.c, cur.c2), Math.max(cur.c, cur.c2)] : [0, t.rows.length - 1, 0, t.cols.length - 1];
        for (let r = ra; r <= rb; r++) for (let k = ca; k <= cb; k++) t.rows[r].cells[k].fill = c === null ? { type: 'none' } : { type: 'solid', color: c! };
      });
    },
  },
  {
    id: 'table.borders', label: 'Borders', icon: 'border_all', tab: 'Table Design', group: 'Table Styles', kind: 'menu', edits: true, isEnabled: hasTable,
    run: (app, kind?: 'all' | 'outside' | 'inside' | 'none') => {
      if (!kind) return;
      const ln: Line = { fill: { type: 'solid', color: 'tx1' }, width: 1 };
      const none: Line = { fill: { type: 'none' } };
      withTable(app, 'Borders', (t) => {
        const R = t.rows.length, C = t.cols.length;
        t.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
          const edge = [c === 0, r === 0, c === C - 1, r === R - 1];
          cell.borders = edge.map((isEdge) => (kind === 'all' ? ln : kind === 'none' ? none : kind === 'outside' ? (isEdge ? ln : none) : isEdge ? none : ln)) as any;
        }));
      });
    },
    menu: () => [['all', 'All Borders'], ['outside', 'Outside Borders'], ['inside', 'Inside Borders'], ['none', 'No Border']].map(([v, l]) => ({ id: 'table.borders', arg: v, label: l })),
  },
  { id: 'table.editCells', label: 'Edit Table', icon: 'edit_note', tab: 'Table Layout', group: 'Data', edits: true, isEnabled: hasTable, tip: 'Edit cell text, add and delete rows and columns, merge and split cells', run: (app) => editCells(app) },
  { id: 'table.insertAbove', label: 'Insert Above', icon: 'vertical_align_top', tab: 'Table Layout', group: 'Rows & Columns', edits: true, isEnabled: hasTable, run: (app) => withTable(app, 'Insert Row', (t, c) => insertRow(t, c.r)) },
  { id: 'table.insertBelow', label: 'Insert Below', icon: 'vertical_align_bottom', tab: 'Table Layout', group: 'Rows & Columns', edits: true, isEnabled: hasTable, run: (app) => withTable(app, 'Insert Row', (t, c) => insertRow(t, Math.max(c.r, c.r2) + 1)) },
  { id: 'table.insertLeft', label: 'Insert Left', icon: 'align_horizontal_left', tab: 'Table Layout', group: 'Rows & Columns', edits: true, isEnabled: hasTable, run: (app) => withTable(app, 'Insert Column', (t, c) => insertCol(t, c.c)) },
  { id: 'table.insertRight', label: 'Insert Right', icon: 'align_horizontal_right', tab: 'Table Layout', group: 'Rows & Columns', edits: true, isEnabled: hasTable, run: (app) => withTable(app, 'Insert Column', (t, c) => insertCol(t, Math.max(c.c, c.c2) + 1)) },
  { id: 'table.deleteRows', label: 'Delete Rows', icon: 'remove', tab: 'Table Layout', group: 'Rows & Columns', edits: true, isEnabled: hasTable, run: (app) => withTable(app, 'Delete Rows', (t, c) => { for (let r = Math.max(c.r, c.r2); r >= Math.min(c.r, c.r2); r--) deleteRow(t, r); }) },
  { id: 'table.deleteColumns', label: 'Delete Columns', icon: 'remove', tab: 'Table Layout', group: 'Rows & Columns', edits: true, isEnabled: hasTable, run: (app) => withTable(app, 'Delete Columns', (t, c) => { for (let k = Math.max(c.c, c.c2); k >= Math.min(c.c, c.c2); k--) deleteCol(t, k); }) },
  { id: 'table.delete', label: 'Delete Table', icon: 'delete', tab: 'Table Layout', group: 'Rows & Columns', edits: true, isEnabled: hasTable, run: (app) => { const ids = new Set(tables(app).map((t) => t.id)); edit(app, 'Delete Table', (o) => { o.elements = o.elements.filter((e) => !ids.has(e.id)); }); app.tab.ui.select([]); } },
  {
    id: 'table.deleteMenu', label: 'Delete', icon: 'delete', tab: 'Table Layout', group: 'Rows & Columns', kind: 'menu', edits: true, isEnabled: hasTable,
    run: (app, id?: string) => { if (id) app.exec(id); },
    menu: () => [{ id: 'table.deleteColumns', label: 'Delete Columns' }, { id: 'table.deleteRows', label: 'Delete Rows' }, { id: 'table.delete', label: 'Delete Table' }],
  },
  { id: 'table.merge', label: 'Merge Cells', icon: 'call_merge', tab: 'Table Layout', group: 'Merge', edits: true, isEnabled: (app) => { const t = tables(app)[0]; if (!t) return false; const c = currentCell(app, t); return c.r !== c.r2 || c.c !== c.c2; }, tip: 'Merge the cells selected in Edit Table', run: (app) => withTable(app, 'Merge Cells', (t, c) => mergeCells(t, c.r, c.c, c.r2, c.c2)) },
  { id: 'table.split', label: 'Split Cells', icon: 'call_split', tab: 'Table Layout', group: 'Merge', edits: true, isEnabled: hasTable, tip: 'Split the current merged cell', run: (app) => withTable(app, 'Split Cells', (t, c) => splitCell(t, c.r, c.c)) },
  { id: 'table.distributeRows', label: 'Distribute Rows', icon: 'table_rows', tab: 'Table Layout', group: 'Cell Size', edits: true, isEnabled: hasTable, run: (app) => withTable(app, 'Distribute Rows', (t) => { const avg = t.rows.reduce((a, r) => a + r.h, 0) / t.rows.length; for (const r of t.rows) r.h = avg; }) },
  { id: 'table.distributeColumns', label: 'Distribute Columns', icon: 'view_column', tab: 'Table Layout', group: 'Cell Size', edits: true, isEnabled: hasTable, run: (app) => withTable(app, 'Distribute Columns', (t) => { const avg = t.cols.reduce((a, b) => a + b, 0) / t.cols.length; t.cols = t.cols.map(() => avg); }) },
  {
    id: 'table.sort', label: 'Sort Rows', icon: 'sort', tab: 'Table Layout', group: 'Data', edits: true, isEnabled: hasTable,
    run: async (app) => {
      const t = tables(app)[0];
      if (t.rows.some((r) => r.cells.some((c) => c.merged || (c.rowSpan || 1) > 1))) { toast('Split merged cells before sorting.'); return; }
      const r = await openDialog({ title: 'Sort Rows', fields: [{ key: 'col', label: 'Sort by column', type: 'select', options: t.cols.map((_, i) => ({ value: i, label: `Column ${i + 1}${t.style?.firstRow ? `: ${cellText(t.rows[0].cells[i]).slice(0, 30)}` : ''}` })) }, { key: 'desc', label: 'Descending', type: 'checkbox', value: false }, { key: 'head', label: 'Keep the first row as a header', type: 'checkbox', value: !!t.style?.firstRow }] });
      if (!r) return;
      withTable(app, 'Sort Rows', (tt) => {
        const head = r.head ? tt.rows.slice(0, 1) : [];
        const body = tt.rows.slice(head.length);
        const k = +r.col;
        body.sort((a, b) => { const x = cellText(a.cells[k]), y = cellText(b.cells[k]); const nx = parseFloat(x.replace(/[^\d.-]/g, '')), ny = parseFloat(y.replace(/[^\d.-]/g, '')); const v = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }); return r.desc ? -v : v; });
        tt.rows = [...head, ...body];
      });
    },
  },
  {
    id: 'table.toText', label: 'Convert to Text', icon: 'notes', tab: 'Table Layout', group: 'Data', edits: true, isEnabled: hasTable,
    tip: 'Replace the table with a text box (cells separated by tabs)',
    run: (app) => {
      const t = tables(app)[0];
      const b = boxOf(app, t);
      const text = t.rows.map((r) => r.cells.filter((c) => !c.merged).map((c) => cellText(c).replace(/\n/g, ' ')).join('\t')).join('\n');
      const tb: ShapeElement = { id: newId('sp'), kind: 'shape', geom: 'rect', textbox: true, name: 'Text', ...b, text: { autofit: 'resize', paras: text.split('\n').map((l) => ({ level: 0, runs: [{ text: l, size: 18 }] })) } };
      edit(app, 'Convert to Text', (o) => { const i = o.elements.findIndex((e) => e.id === t.id); o.elements.splice(i, 1, tb); });
      app.tab.ui.select([tb.id]);
    },
  },
  {
    id: 'table.fromText', label: 'Convert Text to Table', icon: 'table', tab: 'Table Layout', group: 'Data', edits: true, isEnabled: (app) => textTargets(app).length === 1,
    tip: 'Turn the selected text box into a table: lines become rows, tabs or commas separate cells',
    run: (app) => {
      const s = textTargets(app)[0];
      const lines = (s.text?.paras || []).map(paraText).filter((l) => l.trim());
      if (!lines.length) return;
      const sep = lines.some((l) => l.includes('\t')) ? '\t' : lines.some((l) => l.includes(';')) ? ';' : ',';
      const rows = lines.map((l) => l.split(sep).map((c) => c.trim()));
      const cols = Math.max(...rows.map((r) => r.length));
      const b = boxOf(app, s);
      const box = { x: b.x, y: b.y, w: Math.max(b.w, cols * 90), h: rows.length * 32 };
      const t: TableElement = { id: newId('tbl'), kind: 'table', name: 'Table', ...box, cols: Array(cols).fill(box.w / cols), rows: rows.map((r) => ({ h: 32, cells: Array.from({ length: cols }, (_, i) => ({ text: { paras: [{ level: 0, runs: r[i] ? [{ text: r[i] }] : [] }] } })) })), style: { firstRow: true, bandRow: true, accent: 'accent1' } };
      edit(app, 'Convert Text to Table', (o) => { const i = o.elements.findIndex((e) => e.id === s.id); o.elements.splice(i, 1, t); });
      app.tab.ui.select([t.id]);
    },
  },
  {
    id: 'table.align', label: 'Cell Alignment', icon: 'vertical_align_center', tab: 'Table Layout', group: 'Alignment', kind: 'menu', edits: true, isEnabled: hasTable,
    tip: 'Vertical alignment of text in the current cells (or all cells)',
    run: (app, a?: 't' | 'ctr' | 'b') => {
      if (!a) return;
      const hasCur = !!(app.tab as any).tableCell;
      withTable(app, 'Cell Alignment', (t, cur) => { t.rows.forEach((row, r) => row.cells.forEach((cell, c) => { if (!hasCur || (r >= Math.min(cur.r, cur.r2) && r <= Math.max(cur.r, cur.r2) && c >= Math.min(cur.c, cur.c2) && c <= Math.max(cur.c, cur.c2))) cell.anchor = a; })); });
    },
    menu: () => [['t', 'Align Top'], ['ctr', 'Center Vertically'], ['b', 'Align Bottom']].map(([v, l]) => ({ id: 'table.align', arg: v, label: l })),
  },
]);

