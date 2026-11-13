/** Prompts and output parsing for the presentation AI features. */

export const SLIDES_SYSTEM = 'You are a presentation assistant inside Anne\'s Stage, an offline-first presentation app. Follow the format instructions exactly. Do not add commentary before or after the requested output.';

export interface OutlineSlide { title: string; bullets: string[]; notes?: string }

export const OUTLINE_FORMAT = 'Reply with JSON only: an array of slides, each {"title": string, "bullets": [string, …] (at most 6 short bullets; indent a sub-point by starting it with two spaces), "notes": string (speaker notes, 1–3 sentences)}.';

export function draftDeckPrompt(topic: string, n: number, audience: string, tone: string): string {
  return `Write a presentation outline of about ${n} slides about: ${topic}\nAudience: ${audience || 'general'}\nTone: ${tone || 'clear and professional'}\nStart with a title slide (its "bullets" holds one subtitle line) and end with a summary or next-steps slide.\n${OUTLINE_FORMAT}`;
}

export function docToDeckPrompt(text: string, n: number): string {
  return `Turn this document into a presentation of about ${n} slides. Keep its facts; do not invent numbers.\n${OUTLINE_FORMAT}\n\nDocument:\n"""\n${text}\n"""`;
}

export function outlineToSlidesPrompt(text: string): string {
  return `Turn these notes or outline into presentation slides. Group related points; one idea per slide.\n${OUTLINE_FORMAT}\n\nNotes:\n"""\n${text}\n"""`;
}

export function addSlidePrompt(topic: string, context: string): string {
  return `Write ONE slide about: ${topic}\nIt goes into this presentation (other slide titles for context): ${context}\n${OUTLINE_FORMAT.replace('an array of slides', 'an array with exactly one slide')}`;
}

export const TEXT_TASKS: Record<string, { label: string; prompt: (t: string, arg?: string) => string }> = {
  rewrite: { label: 'Rewrite', prompt: (t) => `Rewrite this slide text to be clearer and more direct. Keep the same number of lines (one per line) and the meaning.\n"""\n${t}\n"""` },
  shorten: { label: 'Shorten', prompt: (t) => `Shorten this slide text to about half its length, keeping the key points. One line per bullet, no bullet characters.\n"""\n${t}\n"""` },
  expand: { label: 'Expand', prompt: (t) => `Expand this slide text slightly with concrete detail (at most 6 lines, one per line, no bullet characters).\n"""\n${t}\n"""` },
  tone: { label: 'Change Tone', prompt: (t, tone) => `Rewrite this slide text in a ${tone || 'more formal'} tone. One line per line of input.\n"""\n${t}\n"""` },
  assertionHeadline: { label: 'Bullets to Sentence Headline', prompt: (t) => `Write one complete-sentence headline (an assertion, at most 15 words) that states the main point these bullets support. Reply with the sentence only.\n"""\n${t}\n"""` },
  proofread: { label: 'Proofread', prompt: (t) => `Correct spelling, grammar and punctuation in this text. Change nothing else; keep line breaks.\n"""\n${t}\n"""` },
  translate: { label: 'Translate', prompt: (t, lang) => `Translate into ${lang || 'English'}. Keep line breaks; reply with the translation only.\n"""\n${t}\n"""` },
  writeNotes: { label: 'Write Speaker Notes', prompt: (t) => `Write speaker notes (what to say, 60–120 words, natural spoken language) for a slide with this content.\n"""\n${t}\n"""` },
  notesToSlide: { label: 'Notes to Slide Text', prompt: (t) => `Turn these speaker notes into at most 5 short slide bullets (one per line, no bullet characters).\n"""\n${t}\n"""` },
  slideToNotes: { label: 'Slide Text to Notes', prompt: (t) => `Turn these slide bullets into speaker notes in full sentences (what the presenter says).\n"""\n${t}\n"""` },
  summarize: { label: 'Summarize Deck', prompt: (t) => `Summarize this presentation in 4–6 bullet points for a final "Summary" slide (one per line, no bullet characters).\n"""\n${t}\n"""` },
  anticipateQuestions: { label: 'Anticipate Questions', prompt: (t) => `List the 6 questions an audience is most likely to ask after this presentation, each with a one-sentence suggested answer. Format: "Q: …" then "A: …" lines.\n"""\n${t}\n"""` },
  quizFromDeck: { label: 'Generate Quiz', prompt: (t) => `Write 5 multiple-choice questions that test the key points of this presentation. Reply with JSON only: [{"question": string, "choices": [string, string, string, string], "answer": number (0-based index)}].\n"""\n${t}\n"""` },
  altText: { label: 'Generate Alt Text', prompt: (t) => `Write alternative text (one sentence, at most 25 words, no "image of") for this picture on a slide. Context: ${t}` },
  suggestChart: { label: 'Suggest Chart', prompt: (t) => `Choose the best chart for this table. Reply with JSON only: {"type": "column"|"bar"|"line"|"pie"|"area"|"scatter", "title": string}.\n"""\n${t}\n"""` },
};

/** Strips code fences, quotes and bullet characters the model may add. */
export function cleanText(s: string): string {
  return s.replace(/^```[a-z]*\s*|\s*```$/gi, '').replace(/^"""|"""$/g, '').trim();
}

export function linesOf(s: string): string[] {
  return cleanText(s).split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, '').trimEnd()).filter((l) => l.trim());
}

/** Removes the reasoning some models print before the answer (<think>…</think>, also an unclosed one at the start). */
export function stripThinking(s: string): string {
  return String(s ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/^\s*<think(?:ing)?>[\s\S]*$/i, '').trim();
}

/**
 * Scans a JSON value starting at `start` ('[' or '{'), honoring strings. Returns the end index of the
 * balanced value, -1 when the text ends first or -2 when the brackets do not match; `lastItem` is the end of the last complete
 * top-level element of an array (for repairing an answer that was cut off).
 */
function scanJson(t: string, start: number): { end: number; lastItem: number } {
  const stack: string[] = [];
  let inStr = false;
  let lastItem = -1;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') stack.push(c === '[' ? ']' : '}');
    else if (c === ']' || c === '}') {
      if (stack.pop() !== c) return { end: -2, lastItem: -1 };
      if (!stack.length) return { end: i, lastItem };
      if (stack.length === 1 && t[start] === '[') lastItem = i;
    }
  }
  return { end: -1, lastItem };
}

/**
 * Parses JSON that may be wrapped in prose, code fences or <think> blocks. Each '[' or '{' is tried
 * as a start in turn, so a bracket in the prose ("[2 slides]") does not hide the real answer. An
 * array that was cut off is repaired by keeping its complete elements.
 */
export function parseJsonLoose<T = any>(s: string): T | null {
  const t = cleanText(stripThinking(s));
  try { return JSON.parse(t); } catch { /* look inside */ }
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== '[' && c !== '{') continue;
    const { end, lastItem } = scanJson(t, i);
    if (end > i) {
      try { return JSON.parse(t.slice(i, end + 1)); } catch { /* next candidate */ }
    } else if (end === -1 && c === '[' && lastItem > i) {
      // Cut off (length limit): keep the complete elements rather than one element from inside.
      try { return JSON.parse(t.slice(i, lastItem + 1) + ']'); } catch { /* next candidate */ }
    }
  }
  return null;
}

/** Parses an outline answer: JSON first, then Markdown headings and bullets (never for an answer that is JSON). */
export function parseOutline(s: string): OutlineSlide[] {
  const j = parseJsonLoose<any>(s);
  const arr = Array.isArray(j) ? j : Array.isArray(j?.slides) ? j.slides : null;
  if (arr) {
    return arr.filter((x: any) => x && typeof x === 'object' && (x.title || x.bullets)).map((x: any) => ({
      title: String(x.title || '').trim(),
      bullets: Array.isArray(x.bullets) ? x.bullets.map((b: any) => String(b)).filter((b: string) => b.trim()) : typeof x.bullets === 'string' ? x.bullets.split('\n').filter((b: string) => b.trim()) : [],
      notes: x.notes ? String(x.notes) : undefined,
    }));
  }
  const text = cleanText(stripThinking(s));
  // JSON that could not be read (or is not an outline) must not turn into slides of braces and quotes.
  if (/^[[{]/.test(text)) return [];
  const out: OutlineSlide[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const head = /^\s*#{1,3}\s+(.*)$/.exec(line) || /^\s*(?:Slide\s*\d+\s*[:.-]\s*)(.*)$/i.exec(line);
    if (head) { out.push({ title: head[1].replace(/\*\*/g, '').trim(), bullets: [] }); continue; }
    const b = /^(\s*)(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    const note = /^notes?:/i.test(line.trim());
    if (!out.length) {
      // The first plain line is the title of the first slide (and only that).
      if (!b && !note) { out.push({ title: line.trim(), bullets: [] }); continue; }
      out.push({ title: '', bullets: [] });
    }
    if (b) out[out.length - 1].bullets.push(' '.repeat(Math.min(4, b[1].length >= 2 ? 2 : 0)) + b[2].trim());
    else if (note) out[out.length - 1].notes = line.trim().replace(/^notes?:\s*/i, '');
    else if (out[out.length - 1].title) out[out.length - 1].bullets.push(line.trim());
    else out[out.length - 1].title = line.trim();
  }
  return out.filter((x) => x.title || x.bullets.length);
}

export interface QuizQuestion { question: string; choices: string[]; answer: number | null }

/** Reads a quiz answer defensively: choices must be a list of strings, the answer a whole-number index into it. */
export function parseQuiz(s: string): QuizQuestion[] {
  const j = parseJsonLoose<any>(s);
  const arr = Array.isArray(j) ? j : Array.isArray(j?.questions) ? j.questions : [];
  const out: QuizQuestion[] = [];
  for (const q of arr) {
    if (!q || typeof q !== 'object' || typeof q.question !== 'string' || !q.question.trim()) continue;
    const choices = Array.isArray(q.choices) ? q.choices.filter((c: unknown) => typeof c === 'string' || typeof c === 'number').map((c: unknown) => String(c).trim()).filter(Boolean).slice(0, 7) : [];
    const a = typeof q.answer === 'string' && /^\s*\d+\s*$/.test(q.answer) ? Number(q.answer) : q.answer;
    const answer = Number.isInteger(a) && a >= 0 && a < choices.length ? (a as number) : null;
    out.push({ question: q.question.trim(), choices, answer });
  }
  return out;
}

/** Question slides; the answer goes into the speaker notes. */
export function quizOutline(qs: QuizQuestion[]): OutlineSlide[] {
  const L = 'ABCDEFG';
  return qs.map((q, i) => ({
    title: `Question ${i + 1}: ${q.question}`,
    bullets: q.choices.map((c, k) => `${L[k]}. ${c}`),
    notes: q.answer == null ? 'Answer: ?' : `Answer: ${L[q.answer]}. ${q.choices[q.answer]}`,
  }));
}
