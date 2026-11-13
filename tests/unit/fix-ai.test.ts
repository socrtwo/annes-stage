import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseJsonLoose, parseOutline, parseQuiz, quizOutline } from '../../src/ai/slides';
import { parseStance, runEnsemble, outcomeLine, type EnsemblePlan } from '../../src/ai/ensemble';
import type { ChatRequest, ChatResult } from '../../src/ai/client';
import { aiSettings, saveAiSettings, reloadAiSettings } from '../../src/ai/store';

const full = JSON.stringify([{ title: 'A', bullets: ['x', 'y'], notes: 'n' }, { title: 'B', bullets: ['z'], notes: 'm' }], null, 1);
const two = [{ title: 'A', bullets: ['x', 'y'], notes: 'n' }, { title: 'B', bullets: ['z'], notes: 'm' }];

describe('parseJsonLoose / parseOutline (6)', () => {
  it('skips brackets in the prose before the answer', () => {
    expect(parseOutline('Here is the outline [2 slides]:\n' + full)).toEqual(two);
  });
  it('ignores trailing prose with brackets', () => {
    expect(parseOutline(full + '\nLet me know if you want changes [e.g. more slides].')).toEqual(two);
  });
  it('strips <think> blocks', () => {
    expect(parseOutline('<think>I should make {a plan} [maybe]</think>\n' + full)).toEqual(two);
  });
  it('repairs a truncated array by keeping complete objects', () => {
    const out = parseOutline(full.slice(0, full.length - 25));
    expect(out).toEqual([two[0]]);
  });
  it('handles brackets inside strings', () => {
    expect(parseJsonLoose('x [{"title":"a ] }","bullets":[]}] y')).toEqual([{ title: 'a ] }', bullets: [] }]);
  });
  it('never turns unreadable JSON into Markdown slides', () => {
    expect(parseOutline('[{"title": "A", "bul')).toEqual([]);
    expect(parseOutline('{"oops": true}')).toEqual([]);
  });
  it('does not duplicate the first plain line as title and bullet', () => {
    expect(parseOutline('My Talk\n- one\n- two')).toEqual([{ title: 'My Talk', bullets: ['one', 'two'] }]);
    expect(parseOutline('## Intro\n- one\n## End\n- three')).toEqual([{ title: 'Intro', bullets: ['one'] }, { title: 'End', bullets: ['three'] }]);
  });
});

describe('parseStance (5)', () => {
  it('does not read prose as a stance', () => {
    const s = parseStance('I must block this. The minute is wrong.');
    expect(s.unreadable).toBe(true);
    expect(s.stance).not.toBe('unite');
  });
  it('reads the JSON reply, also after a think block and fences', () => {
    expect(parseStance('<think>{"stance":"unite"}?</think>```json\n{"stance":"block","reason":"wrong"}\n```')).toEqual({ stance: 'block', reason: 'wrong', suggestedChange: undefined });
    expect(parseStance('{"stance":"Stand Aside","reason":"r"}').stance).toBe('stand-aside');
    expect(parseStance('Sure: {"stance": "unite"} and {"x": 1}').stance).toBe('unite');
  });
  it('reads a bare keyword', () => {
    expect(parseStance('Unite').stance).toBe('unite');
    expect(parseStance('stance: block').stance).toBe('block');
  });
  it('treats an empty or unknown stance as unreadable', () => {
    expect(parseStance('').unreadable).toBe(true);
    expect(parseStance('{"stance":"maybe"}').unreadable).toBe(true);
  });
});

describe('consensus (5)', () => {
  const plan: EnsemblePlan = { mode: 'consensus', members: [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }], master: { provider: 'a', model: 'm' }, maxRounds: 3, memberTimeoutMs: 1000 };
  const ok = (p: string, text: string): ChatResult => ({ text, model: 'm', provider: p, providerName: p });
  const isStance = (r: ChatRequest) => String(r.messages[r.messages.length - 1].content).includes('Unite if the minute');

  it('sends no temperature with stance calls', async () => {
    const temps: unknown[] = [];
    const r = await runEnsemble({ messages: [{ role: 'user', content: 'q' }], temperature: 0.7 }, plan, async (p, _m, req) => {
      if (isStance(req)) { temps.push(req.temperature); if (req.temperature != null) throw new Error('400 temperature not supported'); return ok(p, '{"stance":"unite"}'); }
      return ok(p, 'ans ' + p);
    });
    expect(temps).toEqual([undefined, undefined]);
    expect(r.ensemble.outcome).toBe('unity');
  });
  it('zero readable votes is not unity, and each failure is recorded', async () => {
    const r = await runEnsemble({ messages: [{ role: 'user', content: 'q' }] }, plan, async (p, _m, req) => {
      if (isStance(req)) throw new Error(`boom ${p}`);
      return ok(p, 'ans ' + p);
    });
    expect(r.ensemble.outcome).toBe('no-unity');
    expect(r.ensemble.rounds![0].failed).toEqual([{ provider: 'a', error: 'boom a' }, { provider: 'b', error: 'boom b' }]);
    expect(r.ensemble.note).toMatch(/boom a/);
    expect(outcomeLine(r.ensemble)).toMatch(/No unity/);
  });
  it('unreadable votes are not unity', async () => {
    const r = await runEnsemble({ messages: [{ role: 'user', content: 'q' }] }, plan, async (p, _m, req) => {
      if (isStance(req)) return ok(p, p === 'a' ? '{"stance":"unite"}' : 'I must block this.');
      return ok(p, 'ans ' + p);
    });
    expect(r.ensemble.outcome).toBe('no-unity');
    expect(r.ensemble.rounds![0].failed?.[0].provider).toBe('b');
  });
});

describe('quiz parsing (11)', () => {
  it('guards choices and answer', () => {
    const qs = parseQuiz(JSON.stringify([
      { question: 'Q1', choices: ['a', 'b'], answer: 1 },
      { question: 'Q2', choices: 'not a list', answer: 0 },
      { question: 'Q3', choices: ['a', 'b'], answer: 1.5 },
      { question: 'Q4', choices: ['a'], answer: 7 },
      { nope: true },
      null,
    ]));
    expect(qs.map((q) => q.question)).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(qs[1].choices).toEqual([]);
    expect(qs[2].answer).toBeNull();
    expect(qs[3].answer).toBeNull();
    const o = quizOutline(qs);
    expect(o[0]).toEqual({ title: 'Question 1: Q1', bullets: ['A. a', 'B. b'], notes: 'Answer: B. b' });
    expect(o[2].notes).toBe('Answer: ?');
  });
  it('returns [] for non-lists', () => {
    expect(parseQuiz('no json here')).toEqual([]);
    expect(parseQuiz('{"question":"x"}')).toEqual([]);
  });
});

describe('settings storage (12)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('keeps in-memory changes when localStorage.setItem fails, and does not reload from its own broadcast', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    saveAiSettings((s) => { s.styleGuide = 'kept in memory'; });
    await new Promise((r) => setTimeout(r, 30));
    expect(aiSettings().styleGuide).toBe('kept in memory');
    // Another window saved: the unsaved local change survives the reload.
    reloadAiSettings();
    expect(aiSettings().styleGuide).toBe('kept in memory');
  });
});

describe('OpenAI streaming usage (12)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('asks for usage only from the official OpenAI API', async () => {
    const store = await import('../../src/ai/store');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    store.saveAiSettings((s) => {
      s.active = 'openai';
      s.providers.openai = { id: 'openai', model: 'gpt-x' };
      s.providers.custom = { id: 'custom', model: 'local', baseUrl: 'https://example.test/v1' };
      s.ensemble.mode = 'single';
    });
    await store.setApiKey('openai', 'sk-test').catch(() => undefined);
    await store.setApiKey('custom', 'k').catch(() => undefined);
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }));
    const { chat } = await import('../../src/ai/client');
    const r = await chat({ messages: [{ role: 'user', content: 'q' }], onToken: () => undefined });
    expect(r.text).toBe('hi');
    expect(r.usage).toEqual({ in: 3, out: 1 });
    expect(bodies[0].stream_options).toEqual({ include_usage: true });
    await chat({ messages: [{ role: 'user', content: 'q' }], provider: 'custom', onToken: () => undefined });
    expect(bodies[1].stream_options).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
