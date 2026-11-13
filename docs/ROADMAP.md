# Roadmap

> **Status (0.2.0):** M1 is done; parts of M2–M5 are done as noted below, and [COMMANDS.md](COMMANDS.md) lists every planned command not yet implemented. Milestones are ordered by dependency, not by date. Each milestone ends with a tagged prerelease built for every platform by the release workflow, starting with M1. Command ids refer to [COMMANDS-PLAN.md](COMMANDS-PLAN.md).

## M0 — Planning (this repository)

- [x] README, feature survey ([INNOVATIONS.md](INNOVATIONS.md)), Quick Access Bar plan ([QAT.md](QAT.md)), command inventory ([COMMANDS-PLAN.md](COMMANDS-PLAN.md)), architecture plan ([ARCHITECTURE-PLAN.md](ARCHITECTURE-PLAN.md)), legal notes, license, contributing guide and issue templates.
- [ ] Verify the Quick Access Toolbar drop-down choices against installed copies of each desktop version and update the footnotes in QAT.md.
- [ ] Collect a corpus of openly licensed test decks (.pptx, .odp, .ppt) made with different programs.

## M1 — Shell and model (done)

- Project scaffold: TypeScript, Vite, vitest, Capacitor 8 (Android, iOS), Electron, PWA manifest and service worker.
- CI (`android.yml`) and Release (`release.yml`) workflows, adapted from Anne's Grid.
- Shared shell from the sister apps: command registry, ribbon, Quick Access Bar with the full drop-down and **Add All Choices** (`view.qatAddAll`), Customize Tabs, Customize Keyboard, command search, Backstage, preferences, settings import/export.
- Deck model with transactions and undo/redo; masters, layouts, placeholders and inheritance; themes.
- Normal view (thumbnails, slide, notes), Outline view with two-way sync, Slide Sorter, sections.
- Text editing with fonts, paragraph formatting, bullets and numbering, autofit.
- Native .qsp save and open; autosave drafts, crash recovery, version history and snapshots.
- A catalog test that compares the registry with COMMANDS-PLAN.md and reports missing commands.

## M2 — Files, show and print (done except external displays on Android/iOS)

- .pptx import and export (shapes, text, pictures, tables, notes, masters, layouts, themes, transitions, basic animations); .odp import and export; .ppt import.
- Slide show: navigation, builds, timings, hide slide, custom shows, kiosk mode, black/white screen, pen and laser.
- Presenter view with layouts and Rehearse; second-screen support on every platform.
- Print and PDF export: slides, handouts, notes pages, outline, one page per build step; grayscale and black-and-white views.
- Plain themes and the first original theme set.

## M3 — Objects

- Shapes (full preset set), connectors that stay glued, merge shapes, edit points.
- Pictures: crop, crop to shape, corrections, color, transparency, compress.
- Tables (design and layout tabs), charts (shared renderer with Anne's Grid, embedded data grid), diagrams (SmartArt-compatible layouts, keyboard editing, outline to diagram).
- Equations (LaTeX and linear), symbols, icons, decorative text, action buttons, links.
- Comments, Navigator pane, Check Accessibility, alt text and reading order.
- Spelling with offline English dictionaries and the **Spelling Dictionaries** wizard (90+ languages).

## M4 — Design and authoring

- Design tab: themes, variants, colors, fonts, effects, backgrounds, slide size, Resize Presentation with reflow.
- Design Ideas (rule-based, offline), Restyle Deck, Layout by Outline Level, content starters, assertion–evidence and big-picture layouts.
- Markdown slides import/export, Text to Deck, Fit Text to Slide, Split into Slides, Insert PDF Pages, Remove Color, openly licensed picture search.

## M5 — Motion

- Full transition set including 3-D effects and **Smooth Morph**.
- Full animation set, Animation Pane, triggers, Animation Painter, **Build Order** panel, **Animation Timeline**, Reveal by Step.
- Zoom links (summary, section, slide), code blocks with step-through highlighting, HTML show export, Package Presentation, Compress Presentation, Timed Format (Pecha Kucha, Ignite), Design Checker.

## M6 — Media, recording and audiences

- Video and audio: insert, trim, split, speed, fades, volume envelope, bookmarks, captions, background video.
- Record tab: camera, microphone, teleprompter, ink and laser capture, re-record slide, recording timeline; export to video, animated GIF, web lecture and story.
- Live Camera, Rehearsal Coach, Live Subtitles, dictation, ink tools (ink to shape, text and math, replay).
- Phone remote, cast to display, polls, word clouds, quizzes, ratings and audience Q&A.
- Brand Kit, Linked Components, Web Embed, Linked Chart from Anne's Grid, slide status and assignees, picture editor.

## M7 — AI and canvas

- AI tab with the setup wizard (on-device, local server, free tier, paid), the on-device model, and every AI command in COMMANDS-PLAN.md, including several AIs per request (master or Quaker consensus).
- Canvas mode: frames, camera path, overview, brainstorm board, board to slides; vertical slide stacks.

## M8 — Collaboration and stretch goals

- Live co-editing (CRDT with a self-hostable relay), Broadcast Show and Audience Link.
- 3D models (glTF), maps chart, Follow Script, Beamer export, digital signatures, OOXML encryption, add-ins.

## Recovery (throughout)

The recovery engine is brought over from the sister apps in M1 (identification, ZIP salvage, XML healing) and grows with the formats: .pptx rebuild, slide-by-slide salvage, media harvest and text scan in M2; .ppt record salvage and .odp salvage in M2–M3. Each format arrives with damaged-file tests.
