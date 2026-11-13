/**
 * Presentation model. It follows PresentationML's concepts (masters, layouts, placeholders with
 * inheritance, theme-relative colors, a timing list per slide) so .pptx round trips keep their
 * structure; OpenDocument and Markdown are mapped onto it.
 *
 * Units: all positions and sizes are in points (1/72 inch). The default slide is 960 × 540 pt (16:9,
 * 13.333 × 7.5 in). Angles are in degrees, clockwise. Durations are in milliseconds.
 */

/** Theme color slots. */
export type SchemeColor = 'dk1' | 'lt1' | 'dk2' | 'lt2' | 'accent1' | 'accent2' | 'accent3' | 'accent4' | 'accent5' | 'accent6' | 'hlink' | 'folHlink';
/** Aliases used by slides: tx1/bg1/tx2/bg2 map to dk1/lt1/dk2/lt2 (through the master's color map). */
export type SchemeAlias = SchemeColor | 'tx1' | 'bg1' | 'tx2' | 'bg2' | 'phClr';

/**
 * A color: '#rrggbb' or a scheme name ('accent1', 'tx1'), or an object with modifiers.
 * lum: -1..1, negative darkens (shade), positive lightens (tint). alpha: 0..1.
 */
export type Color = string | { s: SchemeAlias | string; lum?: number; alpha?: number };

export type Fill =
  | { type: 'none' }
  | { type: 'solid'; color: Color }
  | { type: 'gradient'; stops: { pos: number; color: Color }[]; angle?: number; path?: 'linear' | 'radial' }
  | { type: 'image'; media: string; mode?: 'stretch' | 'tile'; alpha?: number }
  | { type: 'pattern'; fg: Color; bg: Color; preset?: string };

export type Dash = 'solid' | 'dash' | 'dot' | 'dashDot' | 'longDash' | 'longDashDot' | 'sysDash' | 'sysDot';
export type ArrowEnd = 'none' | 'triangle' | 'arrow' | 'stealth' | 'diamond' | 'oval';

export interface Line {
  /** Undefined = inherit; a 'none' fill means no outline. */
  fill?: Fill;
  width?: number;
  dash?: Dash;
  head?: ArrowEnd;
  tail?: ArrowEnd;
  cap?: 'flat' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
}

export interface Effects {
  shadow?: { color: Color; blur: number; dist: number; dir: number; alpha?: number };
  glow?: { color: Color; rad: number };
  softEdge?: number;
  reflection?: boolean;
}

// ------------------------------------------------------------------------------------------
// Text

export interface RunProps {
  b?: boolean;
  i?: boolean;
  u?: boolean | 'dbl' | 'wavy';
  strike?: boolean | 'dbl';
  /** Points. */
  size?: number;
  font?: string;
  color?: Color;
  highlight?: Color;
  /** Percent of the font size: positive superscript, negative subscript. */
  baseline?: number;
  caps?: 'all' | 'small' | 'none';
  /** Character spacing in points. */
  spc?: number;
  link?: string;
  /** Language tag for proofing. */
  lang?: string;
}

export interface Run extends RunProps {
  text: string;
  /** A field: slide number, date or time. The text holds the last displayed value. */
  field?: 'slidenum' | 'datetime' | 'date' | 'time' | 'title';
  /** A line break inside the paragraph. */
  br?: boolean;
}

export type BulletKind = 'none' | 'char' | 'num' | 'pic';
export type NumScheme = 'arabicPeriod' | 'arabicParenR' | 'arabicPlain' | 'alphaLcPeriod' | 'alphaUcPeriod' | 'alphaLcParenR' | 'romanLcPeriod' | 'romanUcPeriod';

export interface Bullet {
  kind: BulletKind;
  char?: string;
  font?: string;
  scheme?: NumScheme;
  startAt?: number;
  color?: Color;
  /** Percent of the text size. */
  size?: number;
}

export interface ParaProps {
  align?: 'l' | 'ctr' | 'r' | 'just' | 'dist';
  /** Left margin in points. */
  marL?: number;
  /** First-line indent in points (negative for hanging). */
  indent?: number;
  /** Percent (100 = single) or points when lineSpacingPt is set. */
  lineSpacing?: number;
  lineSpacingPt?: boolean;
  spaceBefore?: number;
  spaceAfter?: number;
  bullet?: Bullet;
  rtl?: boolean;
}

/** Style for one outline level, as in a master's text styles or a placeholder's list style. */
export interface LevelStyle extends ParaProps { run?: RunProps }

export interface Paragraph extends ParaProps {
  /** Outline level, 0–8. */
  level: number;
  runs: Run[];
  /** Properties for the end-of-paragraph mark (size of an empty line). */
  end?: RunProps;
}

export interface TextBody {
  paras: Paragraph[];
  anchor?: 't' | 'ctr' | 'b';
  /** Insets in points: left, top, right, bottom. */
  insets?: [number, number, number, number];
  autofit?: 'none' | 'shrink' | 'resize';
  /** Shrink-to-fit scale (0–1), as computed by the renderer or read from the file. */
  fontScale?: number;
  lineReduction?: number;
  wrap?: boolean;
  vert?: 'horz' | 'vert' | 'vert270' | 'stacked';
  columns?: number;
  /** Per-level list style overrides of this shape. */
  levels?: LevelStyle[];
}

// ------------------------------------------------------------------------------------------
// Elements on a slide

export type PlaceholderType = 'title' | 'ctrTitle' | 'subTitle' | 'body' | 'obj' | 'dt' | 'ftr' | 'sldNum' | 'pic' | 'chart' | 'tbl' | 'media' | 'clipArt' | 'dgm' | 'sldImg' | 'hdr';

export interface Placeholder { type: PlaceholderType; idx?: number }

export interface Hyperlink { url?: string; slide?: string; action?: 'next' | 'prev' | 'first' | 'last' | 'end' | 'zoom'; tip?: string }

interface ElementBase {
  id: string;
  name?: string;
  /** Undefined geometry on a placeholder inherits the layout's. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rot?: number;
  flipH?: boolean;
  flipV?: boolean;
  hidden?: boolean;
  locked?: boolean;
  alt?: string;
  title?: string;
  /** Decorative: skipped by screen readers and accessibility checks. */
  decorative?: boolean;
  ph?: Placeholder;
  link?: Hyperlink;
  /** Unknown XML kept for round trips (.pptx extension lists and the like). */
  keep?: Record<string, string>;
}

export interface ShapeElement extends ElementBase {
  kind: 'shape';
  /** Preset geometry name (OOXML prstGeom names) or 'custom'. */
  geom: string;
  /** Adjustment values by name (OOXML units: 1/100000 of a dimension or 60000ths of a degree as in the file). */
  adj?: Record<string, number>;
  /** Custom geometry as an SVG path in a w×h box (when geom is 'custom'). */
  path?: { d: string; w: number; h: number }[];
  fill?: Fill;
  line?: Line;
  effects?: Effects;
  text?: TextBody;
  /** Connector glue: shape ids and connection-site indices. */
  conn?: { start?: { id: string; idx: number }; end?: { id: string; idx: number } };
  /** A text box (no fill and no line by default, auto size). */
  textbox?: boolean;
}

export interface PictureElement extends ElementBase {
  kind: 'picture';
  media: string;
  /** Crop fractions: left, top, right, bottom (0–1). */
  crop?: [number, number, number, number];
  /** Shape the picture is cropped to. */
  geom?: string;
  line?: Line;
  effects?: Effects;
  /** Simple corrections. */
  adjust?: { brightness?: number; contrast?: number; saturation?: number; grayscale?: boolean; transparency?: number };
}

export interface TableCell {
  text: TextBody;
  fill?: Fill;
  /** Borders: left, top, right, bottom. */
  borders?: [Line | undefined, Line | undefined, Line | undefined, Line | undefined];
  rowSpan?: number;
  colSpan?: number;
  /** Covered by a merge. */
  merged?: boolean;
  anchor?: 't' | 'ctr' | 'b';
}

export interface TableElement extends ElementBase {
  kind: 'table';
  cols: number[];
  rows: { h: number; cells: TableCell[] }[];
  style?: { firstRow?: boolean; lastRow?: boolean; firstCol?: boolean; lastCol?: boolean; bandRow?: boolean; bandCol?: boolean; accent?: Color };
}

export type ChartType = 'bar' | 'column' | 'line' | 'pie' | 'doughnut' | 'area' | 'scatter' | 'radar';

export interface ChartElement extends ElementBase {
  kind: 'chart';
  chart: {
    type: ChartType;
    title?: string;
    categories: string[];
    series: { name: string; values: (number | null)[]; color?: Color }[];
    legend?: 'r' | 'b' | 't' | 'l' | 'none';
    stacked?: boolean | 'percent';
    labels?: boolean;
  };
  /** Original chart part, kept to write back unchanged when the data is unedited. */
  rawXml?: string;
}

export interface MediaElement extends ElementBase {
  kind: 'media';
  media: string;
  mediaKind: 'video' | 'audio';
  poster?: string;
  autoplay?: boolean;
  loop?: boolean;
  /** Trim in ms. */
  start?: number;
  end?: number;
  volume?: number;
}

export interface GroupElement extends ElementBase {
  kind: 'group';
  children: Element[];
}

export type Element = ShapeElement | PictureElement | TableElement | ChartElement | MediaElement | GroupElement;
export type ElementKind = Element['kind'];

// ------------------------------------------------------------------------------------------
// Motion

export type TransitionType =
  | 'none' | 'cut' | 'fade' | 'push' | 'wipe' | 'split' | 'reveal' | 'cover' | 'uncover' | 'pull'
  | 'zoom' | 'randomBars' | 'shape' | 'circle' | 'diamond' | 'plus' | 'dissolve' | 'blinds' | 'checker' | 'comb'
  | 'clock' | 'wedge' | 'flip' | 'cube' | 'gallery' | 'morph';

export interface Transition {
  type: TransitionType;
  dir?: 'l' | 'r' | 'u' | 'd' | 'in' | 'out' | 'horz' | 'vert' | 'lu' | 'ru' | 'ld' | 'rd';
  /** Split transitions: whether the halves move in or out (dir then holds horz/vert). */
  inOut?: 'in' | 'out';
  /** Duration in ms. */
  dur?: number;
  /** Advance on click (default true). */
  advClick?: boolean;
  /** Advance automatically after this many ms. */
  advAfter?: number;
  /** Through black (fade). */
  thruBlk?: boolean;
  sound?: string;
}

export type AnimClass = 'entr' | 'exit' | 'emph' | 'path';
export type AnimEffect =
  | 'appear' | 'fade' | 'fly' | 'float' | 'wipe' | 'split' | 'zoom' | 'grow' | 'swivel' | 'bounce' | 'wheel' | 'randomBars' | 'shape' | 'peek'
  | 'pulse' | 'spin' | 'growShrink' | 'teeter' | 'transparency' | 'colorPulse' | 'boldFlash' | 'desaturate'
  | 'line' | 'arc' | 'circle';

export interface Animation {
  id: string;
  target: string;
  cls: AnimClass;
  effect: AnimEffect;
  trigger: 'click' | 'with' | 'after';
  /** Ms. */
  delay?: number;
  dur?: number;
  dir?: 'l' | 'r' | 'u' | 'd' | 'in' | 'out';
  /** Animate text paragraph by paragraph. */
  byPara?: boolean;
  repeat?: number;
  /** Interactive trigger: start when this shape is clicked. */
  onShape?: string;
  /** Emphasis amount (spin degrees, grow percent). */
  amount?: number;
  /** Motion path (SVG path in slide fractions) for 'path' effects. */
  path?: string;
}

// ------------------------------------------------------------------------------------------
// Slides, layouts, masters, theme

export interface Comment { id: string; author: string; initials?: string; time: number; text: string; x?: number; y?: number; target?: string; replies?: Comment[]; resolved?: boolean }

export interface Slide {
  id: string;
  layout: string;
  elements: Element[];
  notes: Paragraph[];
  bg?: Fill;
  hidden?: boolean;
  transition?: Transition;
  anims: Animation[];
  comments?: Comment[];
  name?: string;
  /** Hide the master's own graphics (not placeholders) on this slide. */
  hideMasterShapes?: boolean;
  /** Free-form tags (assignee, status, keywords). */
  tags?: Record<string, string>;
  /** Ink strokes: SVG paths in slide points. */
  ink?: { d: string; color: string; width: number; highlighter?: boolean }[];
  keep?: Record<string, string>;
}

export interface Layout {
  id: string;
  name: string;
  master: string;
  /** OOXML layout type (title, obj, twoObj, secHead, titleOnly, blank, …). */
  type?: string;
  elements: Element[];
  bg?: Fill;
  hideMasterShapes?: boolean;
  keep?: Record<string, string>;
}

export interface TextStyles {
  title: LevelStyle[];
  body: LevelStyle[];
  other: LevelStyle[];
}

export interface Master {
  id: string;
  name: string;
  elements: Element[];
  bg?: Fill;
  styles: TextStyles;
  theme: string;
  /** Color map: tx1 → dk1, … */
  clrMap?: Partial<Record<'bg1' | 'tx1' | 'bg2' | 'tx2', SchemeColor>>;
  keep?: Record<string, string>;
}

export interface Theme {
  id: string;
  name: string;
  colors: Record<SchemeColor, string>;
  fonts: { major: string; minor: string };
  /** Theme fill/line/effect style lists, kept for round trips. */
  keep?: Record<string, string>;
}

export interface Section { id: string; name: string; slides: string[]; collapsed?: boolean }
export interface CustomShow { id: string; name: string; slides: string[] }

export interface MediaItem {
  mime: string;
  /** Base64 data. */
  b64: string;
  name?: string;
}

export interface DeckProps {
  title?: string;
  subject?: string;
  author?: string;
  keywords?: string;
  description?: string;
  category?: string;
  company?: string;
  created?: number;
  modified?: number;
  lastModifiedBy?: string;
  custom?: Record<string, string>;
}

export interface ShowSettings {
  loop?: boolean;
  kiosk?: boolean;
  useTimings?: boolean;
  showNarration?: boolean;
  showAnimation?: boolean;
  customShow?: string;
  from?: number;
  to?: number;
  penColor?: string;
  laserColor?: string;
}

export interface DeckData {
  size: { w: number; h: number };
  slides: Slide[];
  layouts: Layout[];
  masters: Master[];
  themes: Theme[];
  sections: Section[];
  customShows: CustomShow[];
  props: DeckProps;
  show: ShowSettings;
  /** Header and footer settings applied to placeholders. */
  hf?: { date?: boolean; dateText?: string; dateFixed?: boolean; slideNum?: boolean; footer?: boolean; footerText?: string; hideOnTitle?: boolean };
  /** First slide number. */
  firstNumber?: number;
  /** VBA project (.pptm), kept byte-for-byte as base64. */
  vba?: string;
  /** Parts of the original package Anne's Stage does not model, written back when still valid. */
  keep?: Record<string, string>;
  finalMarked?: boolean;
}
