# AI in Anne's Stage

The **AI** tab is optional. Nothing is sent anywhere until you run an AI command, and every AI command is an ordinary command: it can go on the Quick Access Bar, on a custom tab, on a shortcut, or in a macro.

## Setting up

**AI › Set Up AI** opens a wizard that:
1. lists providers grouped as *Free · on device*, *Free · your computer*, *Free tier*, *Free trial* and *Paid*;
2. links to the provider's key page and checks the key with a test request;
3. fetches the provider's model list so you can pick an interactive model and a cheaper "fast" model.

You can add several providers and switch with **Active AI**. **Providers & Models** edits them; **AI & Privacy** shows what each command sends.

### Providers

| Group | Providers |
|---|---|
| On device | Anne's Stage Local AI (see below); Chrome's built-in model on desktop Chrome |
| Your computer | Ollama (`http://localhost:11434/v1`), LM Studio (`http://localhost:1234/v1`) |
| Free tiers | OpenRouter (free models), Google Gemini, Groq, Mistral, Cerebras, SambaNova, Z.ai, Cohere, NVIDIA NIM, Cloudflare Workers AI |
| Paid keys | OpenAI, Anthropic, DeepSeek, xAI, Perplexity, Together, Fireworks, Hugging Face Inference Providers, Moonshot, Alibaba Qwen, Azure OpenAI / AI Foundry, Amazon Bedrock, any OpenAI-compatible service |

Free-tier terms are set by each provider and change; the wizard links to the provider's current page rather than promising limits.

### On-device model

Anne's Stage Local AI runs a small open instruction model with Transformers.js in a Web Worker, on WebGPU when available, otherwise WebAssembly on the CPU. The model is downloaded once (from the Hugging Face Hub) and then works offline. Choices:

| Model | Download | Notes |
|---|---|---|
| Qwen2.5 0.5B Instruct (recommended) | ≈ 480–510 MB | Best quality for its size; many languages |
| SmolLM2 360M Instruct | ≈ 270–365 MB | Fastest on older phones; English-centric |
| Gemma 3 270M IT | ≈ 270–545 MB | Simple rewrites and summaries |
| Llama 3.2 1B Instruct | ≈ 1.24 GB | Needs WebGPU |

Small models are good at rewriting, classification and extraction; for drafting whole decks a hosted or local-server model is noticeably better. **Delete Downloaded Models** frees the space.

## Commands

**Create:** Draft Presentation (from a prompt; the model returns an outline that becomes Title and Content slides), Document to Deck (from a .txt, .md or .docx file), Outline to Slides, Add Slide About…

**Write:** Rewrite, Shorten, Expand, Change Tone, Bullets to Sentence Headline (assertion–evidence), Proofread, Translate — on the selected text or shapes.

**Notes:** Write Speaker Notes, Notes to Slide Text, Slide Text to Notes, Summarize Deck, Anticipate Questions.

**More:** Generate Alt Text (sends the picture when the provider accepts images), Suggest Chart from a table, Generate Quiz from Deck, AI Assistant (chat with the deck as context), Prompt Library and My Prompts.

**Providers:** Several AIs (Single AI, Master Combines Answers, Quaker Consensus), Choose AIs…, Show AI Discussion. See [Using several AIs](#using-several-ais).

Every result is shown for review before it is applied, and changes to the presentation are applied as one undoable step.

## Using several AIs

If you have set up two or more providers, you can send each AI command to several of them at once and get one answer back. Turn it on in **AI › AI Settings › Use several AIs** (or **AI › Several AIs** and **Choose AIs…** in the *Providers* group of the AI tab). Tick two to six AIs, optionally choose a model for each (otherwise each uses its own default model), pick which one is the **master** (or **clerk**), and choose how the AIs work together:

- **One AI combines the answers (master).** Every chosen AI answers the request on its own. The master then reads all the answers, shuffled and labeled only "Response A", "Response B" and so on so it cannot favor a service by name, and writes the single best answer: it keeps what is correct, fixes mistakes, settles disagreements on the merits and keeps the format the command needs (for example, only a slide outline).
- **The AIs deliberate until they agree (Quaker consensus).** This works like a Quaker business meeting, where a group looks for unity instead of taking a vote. Every AI first answers on its own. The **clerk** then words the "sense of the meeting" as a **minute**: one proposed answer. Each AI reads the minute and either **unites** with it (it is correct and complete), **stands aside** (it would prefer something different but can accept the minute; its concern is recorded), or **blocks** it (the minute is wrong or harmful; it says exactly what must change). If anyone blocks, the clerk revises the minute to meet the objections that are right, and the AIs consider it again. When no one blocks, the minute is adopted. After the number of **rounds of discussion** you allow (1 to 5, three by default) with a block still standing, the AIs have not reached unity: you get the clerk's last minute, and the AI pane says "The AIs did not reach unity" and shows each objection.

While the AIs work, the busy indicator and the AI pane show progress ("Asking 3 AIs…", "Round 2 of 3: 1 objection"). With **Show the discussion** on (**Show AI Discussion** on the AI tab), answers have a collapsible **How the AIs answered** section: each AI's own answer with the service, model and time it took (or the error, if it failed), each round's minute with every AI's stance and reason, and the outcome ("Synthesized by …", "United (3 of 3)", "United; 1 stood aside", or "No unity after 3 rounds: 1 objection"). Commands that change the presentation (rewrite text, add slides, write notes) apply only the final answer; the discussion is never written into the presentation. An AI that fails or does not answer in time (90 seconds by default) is left out and the section says so; Stop cancels every request at once. Testing a key, listing models and "Try it" always use the one provider you are working with.

**Cost.** Each command is sent to every chosen service. With N AIs, master mode makes about N + 1 requests; consensus mode makes up to N × (rounds + 1) + rounds (for three AIs and three rounds, up to 15). Paid services charge for each request, and free tiers reach their limits sooner. AI Settings shows the numbers for your choice, and the usage counter there counts every request.

**Privacy.** The same text is sent to every chosen service, and each service's terms and privacy policy apply. AI Settings lists every service that will receive the text, and the first time a cloud service joins, Anne's Stage asks before sending it anything. Choosing only on-device or local-server AIs keeps everything on your devices. The settings store only which providers and models take part; keys stay in the key store.

## Privacy and keys

- Only what a command works on is sent: the selected text or shapes, the current slide, or for whole-deck commands the slides' text (truncated to a size limit, smaller for the on-device model). **AI & Privacy** summarizes this.
- API keys are never stored in settings, drafts, exported settings or presentations. On Android they are encrypted with a key held in the Android Keystore; on desktop they are encrypted with the OS keychain (Electron `safeStorage`: Keychain, DPAPI or libsecret); when there is none (Linux without a secret service), Anne's Stage asks whether to store the key unencrypted or keep it only until the app closes. In a plain browser they are kept in IndexedDB for this site only, which is not encrypted at rest; use the on-device model or a local server if that matters.
