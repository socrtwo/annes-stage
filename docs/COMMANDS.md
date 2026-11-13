# Anne's Stage Command Reference

Anne's Stage ships **556 commands**. Every one can be placed on the Quick Access Bar, added to a custom tab, bound to a keyboard shortcut, recorded in a macro, or found with command search (Alt+Q).

250 of them are "Commands Not in the Tabs" — reachable through the Quick Access Bar chooser, Customize Tabs, the command search, or menus — so nothing the app can do is hidden.

Of the 755 command ids named in [COMMANDS-PLAN.md](COMMANDS-PLAN.md), 464 are implemented and 291 are not yet; they are listed at the end of this file.

This file is generated from the source by `npm run catalog`; a unit test fails when it is out of date.

## Default tab layout

- **Home**: Clipboard · Slides · Font · Paragraph · Drawing · Editing · Designer
- **Insert**: Slides · Tables · Images · Illustrations · Links · Comments · Text · Symbols · Media
- **Draw**: Tools · Pens · Convert · Ink · Background
- **Design**: Themes · Variants · Customize · Designer
- **Transitions**: Preview · Transition to This Slide · Timing
- **Animations**: Preview · Animation · Advanced Animation · Timing
- **Slide Show**: Start Slide Show · Set Up · Monitors
- **Review**: Proofing · Accessibility · Insights · Language · Comments · Compare · Protect · Ink
- **View**: Presentation Views · Master Views · Show · Zoom · Color/Grayscale · Window · Panes · Macros
- **Tools**: Text · Clean Up · Reports · Numbering
- **AI**: Setup · Create · Write · Notes · More · Several AIs
- **Developer**: Code · Data
- **Help**: Help
- **Slide Master** (contextual): Edit Master · Master Layout · Edit Theme · Background · Size · Close
- **Shape Format** (contextual): Insert Shapes · Shape Styles · Decorative Text Styles · Accessibility · Arrange · Size
- **Picture Format** (contextual): Adjust · Picture Styles · Accessibility · Arrange · Size
- **Table Design** (contextual): Table Style Options · Table Styles
- **Table Layout** (contextual): Rows & Columns · Merge · Cell Size · Data · Alignment
- **Chart Design** (contextual): Chart Layouts · Chart Styles · Data · Type
- **Playback** (contextual): Preview · Editing · Options

## File (67)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Close | Close | Ctrl+w, Ctrl+F4 | `file.close` | not in tabs |
| Close All | Close |  | `file.closeAll` | not in tabs |
| Exit | Close |  | `file.exit` | not in tabs |
| Export as Anne's Stage JSON | Export |  | `file.export.json` | not in tabs |
| Export as Anne's Stage Presentation | Export |  | `file.export.qsp` | not in tabs |
| Export as Encrypted Anne's Stage Presentation | Export |  | `file.export.qspe` | not in tabs |
| Export as Flat OpenDocument Presentation | Export |  | `file.export.fodp` | not in tabs |
| Export as Markdown Slides | Export |  | `file.export.md` | not in tabs |
| Export as OpenDocument Presentation | Export |  | `file.export.odp` | not in tabs |
| Export as OpenDocument Presentation Template | Export |  | `file.export.otp` | not in tabs |
| Export as Plain-Text Outline | Export |  | `file.export.txt` | not in tabs |
| Export as PowerPoint Macro-Enabled Presentation | Export |  | `file.export.pptm` | not in tabs |
| Export as PowerPoint Presentation | Export |  | `file.export.pptx` | not in tabs |
| Export as PowerPoint Show | Export |  | `file.export.ppsx` | not in tabs |
| Export as PowerPoint Template | Export |  | `file.export.potx` | not in tabs |
| Export as Rich Text Outline | Export |  | `file.export.rtf` | not in tabs |
| Export Handouts PDF | Export |  | `file.export.handoutsPdf` | not in tabs |
| Export HTML Show | Export |  | `file.export.htmlShow` | not in tabs; inspired by S5 and reveal.js |
| Export Markdown Slides | Export |  | `file.export.markdown` | not in tabs; inspired by Marp, reveal.js, Slidev |
| Export Outline… | Export |  | `file.export.outline` | not in tabs |
| Export Slides as Pictures… | Export |  | `file.export.images` | not in tabs |
| Export Story (responsive web page) | Export |  | `file.export.story` | not in tabs; inspired by Sway |
| Export to PDF | Export |  | `file.export.pdf` | not in tabs |
| Package Presentation… | Export |  | `file.package` | not in tabs; inspired by Corel Show on the Go, Pack and Go |
| Import Markdown Slides… | Import |  | `file.import.markdown` | not in tabs |
| Text to Deck… | Import |  | `file.import.textDeck` | not in tabs; inspired by Plain-text decks |
| Always Open Read-Only | Info |  | `file.alwaysReadOnly` | not in tabs |
| Check Compatibility | Info |  | `file.checkCompatibility` | not in tabs |
| Compress Media… | Info |  | `file.compressMedia` | not in tabs |
| Encrypt with Password… | Info |  | `file.encrypt` |  |
| Inspect Presentation… | Info |  | `file.inspect` | not in tabs |
| Mark as Final | Info |  | `file.markFinal` |  |
| Properties… | Info |  | `file.properties` | not in tabs |
| Recover Unsaved Presentations | Info |  | `file.recoverUnsaved` | not in tabs |
| Revert to Saved | Info |  | `file.revert` | not in tabs |
| Take Snapshot | Info | Ctrl+Alt+5 | `file.snapshot` | not in tabs |
| Version History | Info |  | `file.versions` | not in tabs; inspired by Snapshots (Scrivener) / version history (online editors) |
| New | New | Ctrl+n | `file.new` | not in tabs |
| New from Content Starter… | New |  | `file.newFromStarter` | not in tabs; inspired by Freelance Graphics SmartMasters |
| New from Template… | New |  | `file.newFromTemplate` | not in tabs |
| Clear Unpinned Recent Presentations | Open |  | `file.clearRecent` | not in tabs |
| Manual Recovery Options | Open |  | `file.recoveryHelp` | not in tabs |
| Open | Open | Ctrl+o, Ctrl+F12 | `file.open` | not in tabs |
| Open and Repair… | Open |  | `file.openRepair` | not in tabs |
| Open Encrypted Presentation… | Open |  | `file.openEncrypted` | not in tabs |
| Open Recent File | Open |  | `file.openRecent` | has options menu; not in tabs |
| Recover Data from Any File… | Open |  | `file.recoverAny` | not in tabs |
| Recovery Report | Open |  | `file.recoveryReport` | not in tabs |
| AutoCorrect Options… | Options |  | `file.autocorrectOptions` | not in tabs |
| Custom Dictionary… | Options |  | `file.customDictionary` | not in tabs |
| Customize Keyboard… | Options |  | `file.customizeKeyboard` | not in tabs |
| Customize Quick Access Bar… | Options |  | `file.customizeQat` | not in tabs |
| Customize Tabs… | Options |  | `file.customizeRibbon` | not in tabs |
| Export / Import Settings… | Options |  | `file.exportSettings` | not in tabs |
| Options… | Options |  | `file.options` | not in tabs |
| Reset All Customizations | Options |  | `file.resetCustomizations` | not in tabs |
| Print Preview and Print | Print | Ctrl+p | `file.print` | not in tabs |
| Quick Print | Print |  | `file.quickPrint` | not in tabs |
| AutoSave | Save |  | `file.autosave` | not in tabs |
| Save | Save | Ctrl+s, Shift+F12 | `file.save` | not in tabs |
| Save a Copy… | Save |  | `file.saveCopy` | not in tabs |
| Save All | Save |  | `file.saveAll` | not in tabs |
| Save As | Save | F12 | `file.saveAs` | not in tabs |
| Save as Template | Save |  | `file.saveTemplate` | not in tabs |
| Email | Share |  | `file.email` | not in tabs |
| Email as PDF | Share |  | `file.emailPdf` | not in tabs |
| Share | Share |  | `file.share` | not in tabs |

## Home (114)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Align | Arrange |  | `arrange.align` | has options menu |
| Align Bottom | Arrange |  | `arrange.alignBottom` | not in tabs |
| Align Center | Arrange |  | `arrange.alignCenter` | not in tabs |
| Align Left | Arrange |  | `arrange.alignLeft` | not in tabs |
| Align Middle | Arrange |  | `arrange.alignMiddle` | not in tabs |
| Align Right | Arrange |  | `arrange.alignRight` | not in tabs |
| Align Selected Objects | Arrange |  | `arrange.alignToSelection` | not in tabs |
| Align to Slide | Arrange |  | `arrange.alignToSlide` | not in tabs |
| Align Top | Arrange |  | `arrange.alignTop` | not in tabs |
| Bring Forward | Arrange | Ctrl+] | `arrange.bringForward` |  |
| Bring to Front | Arrange | Ctrl+Shift+] | `arrange.bringToFront` | not in tabs |
| Distribute Horizontally | Arrange |  | `arrange.distributeH` | not in tabs |
| Distribute Vertically | Arrange |  | `arrange.distributeV` | not in tabs |
| Flip Horizontal | Arrange |  | `arrange.flipH` | not in tabs |
| Flip Vertical | Arrange |  | `arrange.flipV` | not in tabs |
| Group | Arrange | Ctrl+g | `arrange.group` | has options menu |
| Lock Position | Arrange |  | `arrange.lock` | not in tabs |
| Match Position | Arrange |  | `arrange.pastePosition` | not in tabs |
| Match Size | Arrange |  | `arrange.matchSize` | not in tabs |
| More Rotation Options… | Arrange |  | `arrange.rotateDialog` | not in tabs |
| Nudge | Arrange |  | `arrange.nudge` | has options menu; not in tabs |
| Regroup | Arrange |  | `arrange.regroup` | not in tabs |
| Rotate | Arrange |  | `arrange.rotate` | has options menu |
| Rotate Left 90° | Arrange | Alt+ArrowLeft | `arrange.rotateLeft` | not in tabs |
| Rotate Right 90° | Arrange | Alt+ArrowRight | `arrange.rotateRight` | not in tabs |
| Send Backward | Arrange | Ctrl+[ | `arrange.sendBackward` |  |
| Send to Back | Arrange | Ctrl+Shift+[ | `arrange.sendToBack` | not in tabs |
| Ungroup | Arrange | Ctrl+Shift+g | `arrange.ungroup` | not in tabs |
| Unlock Position | Arrange |  | `arrange.unlock` | not in tabs |
| Clipboard | Clipboard |  | `edit.clipboardPane` | not in tabs |
| Copy | Clipboard | Ctrl+c, Ctrl+Insert | `edit.copy` |  |
| Copy Formatting | Clipboard | Ctrl+Shift+c | `edit.copyFormat` | not in tabs |
| Cut | Clipboard | Ctrl+x, Shift+Delete | `edit.cut` |  |
| Duplicate | Clipboard | Ctrl+d | `edit.duplicate` |  |
| Format Painter | Clipboard |  | `edit.formatPainter` |  |
| Paste | Clipboard | Ctrl+v, Shift+Insert | `edit.paste` | has options menu |
| Paste as Picture | Clipboard |  | `edit.pastePicture` | not in tabs |
| Paste Formatting | Clipboard | Ctrl+Shift+v | `edit.pasteFormat` | not in tabs |
| Paste Special… | Clipboard | Ctrl+Alt+v | `edit.pasteSpecial` | not in tabs |
| Paste: Keep Source Formatting | Clipboard |  | `edit.pasteKeepSource` | not in tabs |
| Paste: Keep Text Only | Clipboard | Ctrl+Alt+Shift+v | `edit.pasteText` | not in tabs |
| Paste: Use Destination Theme | Clipboard |  | `edit.pasteDestTheme` | not in tabs |
| Arrange | Drawing |  | `arrange.menu` | has options menu |
| Delete | Editing |  | `edit.delete` | not in tabs |
| Find | Editing | Ctrl+f | `edit.find` |  |
| Replace | Editing | Ctrl+h | `edit.replace` |  |
| Replace Fonts… | Editing |  | `edit.replaceFonts` |  |
| Select | Editing |  | `edit.selectMenu` | has options menu |
| Select All | Editing | Ctrl+a | `edit.selectAll` | not in tabs |
| Select Similar | Editing |  | `edit.selectSimilar` | has options menu; not in tabs |
| Selection Pane | Editing | Alt+F10 | `home.selectionPane` |  |
| All Caps | Font | Ctrl+Shift+a | `fmt.allCaps` | not in tabs |
| Bold | Font | Ctrl+b | `fmt.bold` |  |
| Change Case | Font | Shift+F3 | `fmt.changeCase` | has options menu |
| Character Spacing | Font |  | `fmt.charSpacing` | has options menu |
| Clear All Formatting | Font | Ctrl+Space | `fmt.clearFormatting` |  |
| Decrease Font Size | Font | Ctrl+Shift+, | `fmt.shrinkFont` |  |
| Double Strikethrough | Font |  | `fmt.doubleStrike` | not in tabs |
| Font | Font | Ctrl+Shift+f | `fmt.font` |  |
| Font Color | Font |  | `fmt.fontColor` |  |
| Font Size | Font | Ctrl+Shift+p | `fmt.fontSize` |  |
| Font… | Font | Ctrl+t | `fmt.fontDialog` | not in tabs |
| Increase Font Size | Font | Ctrl+Shift+. | `fmt.growFont` |  |
| Italic | Font | Ctrl+i | `fmt.italic` |  |
| Small Caps | Font |  | `fmt.smallCaps` | not in tabs |
| Strikethrough | Font |  | `fmt.strike` |  |
| Subscript | Font | Ctrl+= | `fmt.subscript` | not in tabs |
| Superscript | Font | Ctrl+Shift+= | `fmt.superscript` | not in tabs |
| Text Highlight Color | Font |  | `fmt.highlight` |  |
| Text Shadow | Font |  | `fmt.shadow` |  |
| Underline | Font | Ctrl+u | `fmt.underline` | has options menu |
| Align Left | Paragraph | Ctrl+l | `fmt.alignLeft` |  |
| Align Right | Paragraph | Ctrl+r | `fmt.alignRight` |  |
| Align Text | Paragraph |  | `fmt.verticalAlign` | has options menu |
| Bullets | Paragraph |  | `fmt.bullets` | has options menu |
| Bullets and Numbering… | Paragraph |  | `fmt.bulletsDialog` | not in tabs |
| Center | Paragraph | Ctrl+e | `fmt.alignCenter` |  |
| Columns | Paragraph |  | `fmt.columns` | has options menu |
| Convert to Diagram | Paragraph |  | `diagram.fromOutline` | has options menu |
| Decrease List Level | Paragraph | Alt+Shift+ArrowLeft | `fmt.outdent` |  |
| Distributed | Paragraph | Ctrl+Shift+j | `fmt.distribute` | not in tabs |
| Increase List Level | Paragraph | Alt+Shift+ArrowRight | `fmt.indent` |  |
| Justify | Paragraph | Ctrl+j | `fmt.justify` |  |
| Left-to-Right Text Direction | Paragraph |  | `fmt.ltr` | not in tabs |
| Line Spacing | Paragraph |  | `fmt.lineSpacing` | has options menu |
| Numbering | Paragraph |  | `fmt.numbering` | has options menu |
| Paragraph… | Paragraph |  | `fmt.paragraphDialog` | not in tabs |
| Right-to-Left Text Direction | Paragraph |  | `fmt.rtl` | not in tabs |
| Text Direction | Paragraph |  | `fmt.textDirection` | has options menu |
| Add Section | Slides |  | `section.add` | not in tabs |
| Collapse All Sections | Slides |  | `section.collapseAll` | not in tabs |
| Copy Slide to Another Presentation | Slides |  | `slide.copyTo` | not in tabs |
| Delete Slide | Slides |  | `slide.delete` | not in tabs |
| Duplicate Slide | Slides |  | `slide.duplicate` | not in tabs |
| Expand All Sections | Slides |  | `section.expandAll` | not in tabs |
| Layout | Slides |  | `slide.layout` | has options menu |
| Move Section Down | Slides |  | `section.moveDown` | not in tabs |
| Move Section Up | Slides |  | `section.moveUp` | not in tabs |
| Move Slide Down | Slides | Ctrl+ArrowDown | `slide.moveDown` | not in tabs |
| Move Slide to End | Slides | Ctrl+Shift+ArrowDown | `slide.moveEnd` | not in tabs |
| Move Slide to Start | Slides | Ctrl+Shift+ArrowUp | `slide.moveStart` | not in tabs |
| Move Slide Up | Slides | Ctrl+ArrowUp | `slide.moveUp` | not in tabs |
| New Slide | Slides | Ctrl+m | `slide.new` | has options menu |
| New Slide with Layout | Slides |  | `slide.newWithLayout` | has options menu; not in tabs |
| Remove All Sections | Slides |  | `section.removeAll` | not in tabs |
| Remove Section | Slides |  | `section.remove` | not in tabs |
| Remove Section & Slides | Slides |  | `section.removeWithSlides` | not in tabs |
| Rename Section | Slides |  | `section.rename` | not in tabs |
| Reset | Slides |  | `slide.reset` |  |
| Reuse Slides… | Slides |  | `slide.reuse` |  |
| Section | Slides |  | `section.menu` | has options menu |
| Redo | Undo | Ctrl+y, Ctrl+Shift+z, F4 | `edit.redo` | not in tabs |
| Repeat | Undo |  | `edit.repeat` | not in tabs |
| Undo | Undo | Ctrl+z | `edit.undo` | has options menu; not in tabs |

## Insert (27)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Chart | Illustrations |  | `insert.chart` |  |
| Diagram | Illustrations |  | `insert.diagram` |  |
| Shapes | Illustrations |  | `insert.shape` | has options menu |
| Photo Album | Images |  | `insert.photoAlbum` |  |
| Pictures | Images |  | `insert.picture` |  |
| Screenshot | Images |  | `insert.screenshot` |  |
| Action | Links |  | `insert.action` |  |
| Action Buttons | Links |  | `insert.actionButton` | has options menu |
| Link | Links | Ctrl+k | `insert.link` |  |
| Slide Zoom | Links |  | `insert.slideZoom` |  |
| Summary Zoom | Links |  | `insert.summaryZoom` |  |
| Audio | Media |  | `insert.audio` |  |
| Record Audio | Media |  | `insert.recordAudio` |  |
| Video | Media |  | `insert.video` |  |
| Slides from Outline… | Slides |  | `insert.slidesFromOutline` |  |
| Emoji | Symbols |  | `insert.emoji` |  |
| Equation | Symbols | Alt+= | `insert.equation` |  |
| Symbol | Symbols |  | `insert.symbol` |  |
| Draw Table | Tables |  | `insert.drawTable` |  |
| Table | Tables |  | `insert.table` |  |
| Code Block | Text |  | `insert.codeBlock` | inspired by reveal.js, Slidev |
| Date & Time | Text |  | `insert.dateTime` |  |
| Decorative Text | Text |  | `insert.decorativeText` |  |
| Header & Footer | Text |  | `insert.headerFooter` |  |
| Slide Number | Text |  | `insert.slideNumber` |  |
| Sticky Note | Text |  | `insert.stickyNote` | inspired by Freeform, Miro |
| Text Box | Text |  | `insert.textBox` |  |

## Draw (11)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Ink to Shape | Convert |  | `ink.toShape` |  |
| Delete All Ink on Slide | Ink |  | `ink.deleteAll` |  |
| Ink Replay | Ink |  | `ink.replay` |  |
| Highlighter | Pens |  | `draw.highlighter` |  |
| Pen | Pens |  | `draw.pen` |  |
| Pen Color | Pens |  | `draw.penColor` |  |
| Pencil | Pens |  | `draw.pencil` |  |
| Thickness | Pens |  | `draw.penWidth` | has options menu |
| Draw with Touch | Tools |  | `draw.withTouch` |  |
| Eraser | Tools |  | `draw.eraser` |  |
| Select | Tools |  | `draw.select` |  |

## Design (24)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Apply Background to All | Customize |  | `design.backgroundApplyAll` |  |
| Format Background | Customize |  | `design.formatBackground` |  |
| Reset Background | Customize |  | `design.backgroundReset` |  |
| Resize Presentation | Customize |  | `design.resizeTo` | not in tabs; inspired by Canva |
| Slide Size | Customize |  | `design.slideSize` | has options menu |
| Design Ideas | Designer |  | `design.designIdeas` |  |
| Layout by Outline Level | Designer |  | `design.autoLayoutRules` | inspired by Persuasion AutoTemplates |
| Restyle Deck | Designer |  | `design.restyle` | inspired by WPS, Gamma |
| Apply Theme to All Slides | Themes |  | `design.applyThemeAll` | not in tabs |
| Apply Theme to Selected Slides | Themes |  | `design.applyThemeSelected` | not in tabs |
| Browse for Themes | Themes |  | `design.browseThemes` |  |
| Save Current Theme | Themes |  | `design.saveTheme` |  |
| Theme: Archive | Themes |  | `design.theme.archive` | not in tabs |
| Theme: Meadow | Themes |  | `design.theme.meadow` | not in tabs |
| Theme: Paper | Themes |  | `design.theme.paper` | not in tabs |
| Theme: Quill | Themes |  | `design.theme.quill` | not in tabs |
| Theme: Slate | Themes |  | `design.theme.slate` | not in tabs |
| Theme: Studio | Themes |  | `design.theme.studio` | not in tabs |
| Themes | Themes |  | `design.theme` | has options menu |
| Background Styles | Variants |  | `design.backgroundStyles` | has options menu |
| Colors | Variants |  | `design.colors` | has options menu |
| Customize Colors | Variants |  | `design.customColors` |  |
| Customize Fonts | Variants |  | `design.customFonts` |  |
| Fonts | Variants |  | `design.fonts` | has options menu |

## Transitions (34)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Preview | Preview |  | `trans.preview` |  |
| After | Timing |  | `trans.advanceAfter` |  |
| Apply To All | Timing |  | `trans.applyAll` |  |
| Duration | Timing |  | `trans.duration` |  |
| On Mouse Click | Timing |  | `trans.advanceOnClick` |  |
| Remove Transitions from All Slides | Timing |  | `trans.removeAll` |  |
| Blinds | Transition to This Slide |  | `trans.blinds` | not in tabs |
| Checkerboard | Transition to This Slide |  | `trans.checker` | not in tabs |
| Circle | Transition to This Slide |  | `trans.circle` | not in tabs |
| Clock | Transition to This Slide |  | `trans.clock` | not in tabs |
| Comb | Transition to This Slide |  | `trans.comb` | not in tabs |
| Cover | Transition to This Slide |  | `trans.cover` | not in tabs |
| Cube | Transition to This Slide |  | `trans.cube` | not in tabs |
| Cut | Transition to This Slide |  | `trans.cut` | not in tabs |
| Diamond | Transition to This Slide |  | `trans.diamond` | not in tabs |
| Dissolve | Transition to This Slide |  | `trans.dissolve` | not in tabs |
| Effect Options | Transition to This Slide |  | `trans.effectOptions` | has options menu |
| Fade | Transition to This Slide |  | `trans.fade` | not in tabs |
| Flip | Transition to This Slide |  | `trans.flip` | not in tabs |
| Gallery | Transition to This Slide |  | `trans.gallery` | not in tabs |
| No Transition | Transition to This Slide |  | `trans.none` | not in tabs |
| Plus | Transition to This Slide |  | `trans.plus` | not in tabs |
| Pull | Transition to This Slide |  | `trans.pull` | not in tabs |
| Push | Transition to This Slide |  | `trans.push` | not in tabs |
| Random Bars | Transition to This Slide |  | `trans.randomBars` | not in tabs |
| Reveal | Transition to This Slide |  | `trans.reveal` | not in tabs |
| Shape | Transition to This Slide |  | `trans.shape` | not in tabs |
| Smooth Morph | Transition to This Slide |  | `trans.smoothMorph` | not in tabs; inspired by Keynote Magic Move, PowerPoint Morph |
| Split | Transition to This Slide |  | `trans.split` | not in tabs |
| Transition | Transition to This Slide |  | `trans.apply` | has options menu |
| Uncover | Transition to This Slide |  | `trans.uncover` | not in tabs |
| Wedge | Transition to This Slide |  | `trans.wedge` | not in tabs |
| Wipe | Transition to This Slide |  | `trans.wipe` | not in tabs |
| Zoom | Transition to This Slide |  | `trans.zoom` | not in tabs |

## Animations (58)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Add Animation | Advanced Animation |  | `anim.add` | has options menu |
| Animation Painter | Advanced Animation | Alt+Shift+c | `anim.painter` |  |
| Animation Pane | Advanced Animation |  | `anim.pane` |  |
| Build Order | Advanced Animation |  | `anim.buildOrder` | inspired by Keynote |
| Reveal by Step | Advanced Animation |  | `anim.revealSteps` | not in tabs; inspired by Beamer overlays |
| Trigger | Advanced Animation |  | `anim.trigger` | has options menu |
| Animation | Animation |  | `anim.apply` | has options menu |
| Effect Options | Animation |  | `anim.effectOptions` | has options menu |
| Effect Options Dialog | Animation |  | `anim.effectDialog` | not in tabs |
| Emphasi: Bold Flash | Animation |  | `anim.em.boldFlash` | not in tabs |
| Emphasi: Color Pulse | Animation |  | `anim.em.colorPulse` | not in tabs |
| Emphasi: Desaturate | Animation |  | `anim.em.desaturate` | not in tabs |
| Emphasi: Grow/Shrink | Animation |  | `anim.em.growShrink` | not in tabs |
| Emphasi: Pulse | Animation |  | `anim.em.pulse` | not in tabs |
| Emphasi: Spin | Animation |  | `anim.em.spin` | not in tabs |
| Emphasi: Teeter | Animation |  | `anim.em.teeter` | not in tabs |
| Emphasi: Transparency | Animation |  | `anim.em.transparency` | not in tabs |
| Entrance: Appear | Animation |  | `anim.in.appear` | not in tabs |
| Entrance: Bounce | Animation |  | `anim.in.bounce` | not in tabs |
| Entrance: Fade | Animation |  | `anim.in.fade` | not in tabs |
| Entrance: Float In | Animation |  | `anim.in.float` | not in tabs |
| Entrance: Fly In | Animation |  | `anim.in.fly` | not in tabs |
| Entrance: Grow & Turn | Animation |  | `anim.in.grow` | not in tabs |
| Entrance: Peek In | Animation |  | `anim.in.peek` | not in tabs |
| Entrance: Random Bars | Animation |  | `anim.in.randomBars` | not in tabs |
| Entrance: Shape | Animation |  | `anim.in.shape` | not in tabs |
| Entrance: Split | Animation |  | `anim.in.split` | not in tabs |
| Entrance: Swivel | Animation |  | `anim.in.swivel` | not in tabs |
| Entrance: Wheel | Animation |  | `anim.in.wheel` | not in tabs |
| Entrance: Wipe | Animation |  | `anim.in.wipe` | not in tabs |
| Entrance: Zoom | Animation |  | `anim.in.zoom` | not in tabs |
| Exit: Bounce | Animation |  | `anim.out.bounce` | not in tabs |
| Exit: Disappear | Animation |  | `anim.out.disappear` | not in tabs |
| Exit: Fade Out | Animation |  | `anim.out.fade` | not in tabs |
| Exit: Float Out | Animation |  | `anim.out.float` | not in tabs |
| Exit: Fly Out | Animation |  | `anim.out.fly` | not in tabs |
| Exit: Peek Out | Animation |  | `anim.out.peek` | not in tabs |
| Exit: Random Bars | Animation |  | `anim.out.randomBars` | not in tabs |
| Exit: Shape | Animation |  | `anim.out.shape` | not in tabs |
| Exit: Shrink & Turn | Animation |  | `anim.out.grow` | not in tabs |
| Exit: Split | Animation |  | `anim.out.split` | not in tabs |
| Exit: Swivel | Animation |  | `anim.out.swivel` | not in tabs |
| Exit: Wheel | Animation |  | `anim.out.wheel` | not in tabs |
| Exit: Wipe | Animation |  | `anim.out.wipe` | not in tabs |
| Exit: Zoom | Animation |  | `anim.out.zoom` | not in tabs |
| Motion Path: Arcs | Animation |  | `anim.path.arc` | not in tabs |
| Motion Path: Lines | Animation |  | `anim.path.line` | not in tabs |
| Motion Path: Shapes (Circle) | Animation |  | `anim.path.circle` | not in tabs |
| Preview | Preview |  | `anim.preview` |  |
| Delay | Timing |  | `anim.delay` |  |
| Duration | Timing |  | `anim.duration` |  |
| Move Earlier | Timing |  | `anim.moveEarlier` |  |
| Move Later | Timing |  | `anim.moveLater` |  |
| Remove All Animations on Slide | Timing |  | `anim.removeAll` | not in tabs |
| Remove Animation | Timing |  | `anim.remove` |  |
| Start: After Previous | Timing |  | `anim.startAfterPrevious` |  |
| Start: On Click | Timing |  | `anim.startOnClick` |  |
| Start: With Previous | Timing |  | `anim.startWithPrevious` |  |

## Slide Show (12)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Use Presenter View | Monitors |  | `show.usePresenterView` |  |
| Clear Timings | Set Up |  | `show.clearTimings` | has options menu |
| Hide Slide | Set Up |  | `slide.hide` |  |
| Rehearse Timings | Set Up |  | `show.rehearseTimings` |  |
| Set Up Slide Show | Set Up |  | `show.setUp` |  |
| Timed Format | Set Up |  | `show.timedFormat` | has options menu; inspired by Pecha Kucha, Ignite |
| Use Timings | Set Up |  | `show.useTimings` |  |
| Custom Slide Show | Start Slide Show |  | `show.customShows` | has options menu |
| Present from Beginning | Start Slide Show | F5 | `show.fromStart` |  |
| Present from Current Slide | Start Slide Show | Shift+F5 | `show.fromCurrent` |  |
| Presenter View | Start Slide Show | Alt+F5 | `show.presenterView` |  |
| Rehearse | Start Slide Show |  | `show.rehearse` | inspired by Keynote |

## Review (21)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Alt Text | Accessibility |  | `review.altText` |  |
| Check Accessibility | Accessibility |  | `review.checkAccessibility` |  |
| Reading Order Pane | Accessibility |  | `review.readingOrder` |  |
| Assign Slide… | Collaboration |  | `slide.assign` | not in tabs; inspired by Pitch |
| Slide Status | Collaboration |  | `slide.status` | has options menu; not in tabs; inspired by Pitch |
| Delete All Comments in Presentation | Comments |  | `review.deleteAllComments` | not in tabs |
| Delete All Comments on Slide | Comments |  | `review.deleteSlideComments` | not in tabs |
| Delete Comment | Comments |  | `review.deleteComment` | has options menu |
| New Comment | Comments | Ctrl+Alt+m | `review.newComment` |  |
| Next Comment | Comments |  | `review.nextComment` |  |
| Previous Comment | Comments |  | `review.prevComment` |  |
| Show Comments | Comments |  | `review.commentsPane` |  |
| Compare | Compare |  | `review.compare` |  |
| Hide Ink | Ink |  | `ink.toggleVisibility` |  |
| Design Checker | Insights |  | `review.designCheck` | inspired by Harvard Graphics advisor; Tufte |
| Look Up | Insights |  | `review.lookUp` |  |
| Language | Language |  | `review.language` |  |
| Translate | Language |  | `review.translate` |  |
| Presentation Statistics | Proofing |  | `review.statistics` |  |
| Spelling | Proofing | F7 | `review.spelling` |  |
| Spelling Dictionaries | Proofing |  | `review.dictionaries` |  |

## View (41)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Dark Mode | Appearance |  | `view.theme` | has options menu; not in tabs |
| Black and White | Color/Grayscale |  | `view.blackWhite` |  |
| Color | Color/Grayscale |  | `view.color` |  |
| Grayscale | Color/Grayscale |  | `view.grayscale` |  |
| Search Commands | Help | Alt+q | `view.cmdSearch` | not in tabs |
| Slide Master | Master Views |  | `view.slideMaster` |  |
| First Slide | Navigation | Ctrl+Home | `slide.first` | not in tabs |
| Go to Slide… | Navigation |  | `slide.goTo` | not in tabs |
| Last Slide | Navigation | Ctrl+End | `slide.last` | not in tabs |
| Next Slide | Navigation | PageDown | `slide.next` | not in tabs |
| Previous Slide | Navigation | PageUp | `slide.prev` | not in tabs |
| Demote | Outline |  | `outline.demote` | not in tabs |
| Move Down | Outline | Alt+Shift+ArrowDown | `outline.moveDown` | not in tabs |
| Move Up | Outline | Alt+Shift+ArrowUp | `outline.moveUp` | not in tabs |
| Promote | Outline |  | `outline.promote` | not in tabs |
| Navigator | Panes |  | `view.navigator` | inspired by Impress Navigator |
| Normal | Presentation Views |  | `view.normal` |  |
| Notes Page | Presentation Views |  | `view.notesPage` |  |
| Outline View | Presentation Views |  | `view.outline` |  |
| Reading View | Presentation Views |  | `view.reading` |  |
| Slide Sorter | Presentation Views |  | `view.slideSorter` |  |
| Add All Quick Access Choices (A–Z) | Quick Access Bar |  | `view.qatAddAll` | not in tabs |
| Hide Quick Access Bar | Quick Access Bar |  | `view.qatHide` | not in tabs |
| Quick Access Bar Labels | Quick Access Bar |  | `view.qatLabels` | not in tabs |
| Quick Access Bar Position | Quick Access Bar |  | `view.qatPosition` | has options menu; not in tabs |
| Show Quick Access Bar | Quick Access Bar |  | `view.qatShow` | not in tabs |
| Collapse the Ribbon | Ribbon | Ctrl+F1 | `view.collapseRibbon` | not in tabs |
| Touch/Mouse Mode | Ribbon |  | `view.touchMode` | not in tabs |
| Grid and Guides… | Show |  | `view.gridSettings` | not in tabs |
| Gridlines | Show | Shift+F9 | `view.gridlines` |  |
| Notes | Show |  | `view.notes` |  |
| Smart Guides | Show |  | `view.smartGuides` |  |
| Snap to Grid | Show |  | `view.snapToGrid` | not in tabs |
| Thumbnails | Show |  | `view.thumbnails` |  |
| Full Screen | Window |  | `view.fullScreen` |  |
| New Window | Window |  | `view.newWindow` |  |
| Switch Windows | Window | Ctrl+F6 | `view.switchWindow` | has options menu |
| Fit to Window | Zoom |  | `view.fit` |  |
| Zoom In | Zoom | Ctrl+Alt+= | `view.zoomIn` |  |
| Zoom Out | Zoom | Ctrl+- | `view.zoomOut` |  |
| Zoom… | Zoom |  | `view.zoom` |  |

## Tools (13)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Extract All Media | Clean Up |  | `tools.extractMedia` |  |
| Find Off-Slide Content | Clean Up |  | `tools.offSlide` |  |
| Find Unused Masters and Layouts | Clean Up |  | `tools.unusedLayouts` |  |
| Remove Unused Masters and Layouts | Clean Up |  | `tools.removeUnusedLayouts` |  |
| Reset All Slides to Layout | Clean Up |  | `tools.resetAll` |  |
| Slide Numbering Options | Numbering |  | `tools.numbering` |  |
| Compare Fonts Used | Reports |  | `tools.fontsUsed` |  |
| Estimate Speaking Time | Reports |  | `tools.speakingTime` |  |
| Speaker Notes to Script | Reports |  | `tools.notesToDoc` | not in tabs |
| Fit Text to Slide | Text |  | `fmt.fitTextToSlide` | inspired by Takahashi method |
| Merge Slides | Text |  | `slide.merge` |  |
| OCR Clean-up | Text |  | `tools.ocrCleanup` |  |
| Split into Slides | Text |  | `slide.splitByParagraph` | inspired by Lessig method |

## AI (31)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Add Slide About | Create |  | `ai.addSlide` |  |
| Document to Deck | Create |  | `ai.docToDeck` | inspired by Gamma |
| Draft Presentation | Create |  | `ai.draftDeck` | inspired by Tome, Gamma |
| Outline to Slides | Create |  | `ai.outlineToSlides` |  |
| AI Assistant | More |  | `ai.assistant` |  |
| Generate Alt Text | More |  | `ai.altText` |  |
| Generate Quiz from Deck | More |  | `ai.quizFromDeck` |  |
| Prompt Library | More |  | `ai.prompts` | has options menu |
| Suggest Chart from Data | More |  | `ai.suggestChart` |  |
| Anticipate Questions | Notes |  | `ai.anticipateQuestions` |  |
| Notes to Slide Text | Notes |  | `ai.notesToSlide` |  |
| Slide Text to Notes | Notes |  | `ai.slideToNotes` |  |
| Summarize Deck | Notes |  | `ai.summarize` |  |
| Write Speaker Notes | Notes |  | `ai.writeNotes` |  |
| Active AI | Setup |  | `ai.active` | has options menu |
| AI & Privacy | Setup |  | `ai.privacy` |  |
| AI Settings | Setup |  | `ai.settings` | not in tabs |
| Delete Downloaded Models | Setup |  | `ai.deleteModels` | not in tabs |
| Providers & Models | Setup |  | `ai.providers` |  |
| Set Up AI | Setup |  | `ai.setup` |  |
| Stop AI | Setup |  | `ai.stop` |  |
| Choose AIs | Several AIs |  | `ai.ensembleMembers` |  |
| Several AIs | Several AIs |  | `ai.ensembleMode` | has options menu |
| Show AI Discussion | Several AIs |  | `ai.showDeliberation` |  |
| Bullets to Sentence Headline | Write |  | `ai.assertionHeadline` | inspired by Assertion–evidence slides |
| Change Tone | Write |  | `ai.tone` |  |
| Expand | Write |  | `ai.expand` |  |
| Proofread | Write |  | `ai.proofread` |  |
| Rewrite | Write |  | `ai.rewrite` |  |
| Shorten | Write |  | `ai.shorten` |  |
| Translate | Write |  | `ai.translate` |  |

## Developer (9)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Macro Editor | Code |  | `dev.macroEditor` |  |
| Macro Security | Code |  | `dev.macroSecurity` |  |
| Macros | Code | Alt+F8 | `dev.macros` |  |
| Record Macro | Code |  | `dev.recordMacro` |  |
| Stop Recording | Code |  | `dev.stopRecording` | not in tabs |
| View VBA Project | Code |  | `dev.viewVba` |  |
| Document Tags | Data |  | `dev.tags` |  |
| Export Presentation JSON | Data |  | `dev.exportJson` |  |
| Import Presentation JSON | Data |  | `dev.importJson` |  |

## Help (9)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| About Anne's Stage | Help |  | `help.about` |  |
| Check for Updates | Help |  | `help.updates` | not in tabs |
| Command Reference | Help |  | `help.commandReference` |  |
| Help | Help | F1 | `help.help` |  |
| Keyboard Shortcuts | Help |  | `help.shortcuts` |  |
| Report a Problem / Feedback | Help |  | `help.feedback` |  |
| Third-Party Notices | Help |  | `help.notices` |  |
| Tour | Help |  | `help.tour` |  |
| What's New | Help |  | `help.whatsNew` |  |

## Slide Master (contextual) (13)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Hide Background Graphics | Background |  | `master.hideBackgroundGraphics` |  |
| Close Master View | Close |  | `master.close` |  |
| Delete | Edit Master |  | `master.delete` |  |
| Delete Layout | Edit Master |  | `master.deleteLayout` | not in tabs |
| Duplicate Layout | Edit Master |  | `master.duplicateLayout` | not in tabs |
| Insert Layout | Edit Master |  | `master.insertLayout` |  |
| Insert Slide Master | Edit Master |  | `master.insertMaster` |  |
| Preserve | Edit Master |  | `master.preserve` |  |
| Rename | Edit Master |  | `master.rename` |  |
| Rename Layout | Edit Master |  | `master.renameLayout` | not in tabs |
| Footers | Master Layout |  | `master.showFooters` |  |
| Insert Placeholder | Master Layout |  | `master.insertPlaceholder` | has options menu |
| Title | Master Layout |  | `master.showTitle` |  |

## Shape Format (contextual) (16)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Mark as Decorative | Accessibility |  | `shape.decorative` |  |
| Text Autofit | Decorative Text Styles |  | `shape.autofit` | has options menu |
| Text Fill | Decorative Text Styles |  | `shape.textFill` |  |
| Text Margins | Decorative Text Styles |  | `shape.textMargins` |  |
| Wrap Text in Shape | Decorative Text Styles |  | `shape.wrapText` |  |
| Change Shape | Insert Shapes |  | `shape.change` | has options menu |
| Edit Text | Insert Shapes |  | `shape.editText` | not in tabs |
| Format Shape | Shape Styles |  | `shape.formatPane` | not in tabs |
| Quick Styles | Shape Styles |  | `shape.quickStyle` | has options menu |
| Shape Effects | Shape Styles |  | `shape.effects` | has options menu |
| Shape Fill | Shape Styles |  | `shape.fill` |  |
| Shape Outline | Shape Styles |  | `shape.outline` | has options menu |
| Save as Picture | Size |  | `shape.saveAsPicture` | not in tabs |
| Shape Height | Size |  | `shape.height` |  |
| Shape Width | Size |  | `shape.width` |  |
| Size and Position | Size |  | `shape.sizeDialog` |  |

## Picture Format (contextual) (15)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Change Picture | Adjust |  | `picture.change` |  |
| Color | Adjust |  | `picture.color` | has options menu |
| Compress Pictures | Adjust |  | `picture.compress` |  |
| Corrections | Adjust |  | `picture.corrections` | has options menu |
| Remove Color | Adjust |  | `picture.removeColor` | inspired by Keynote Instant Alpha |
| Reset Picture | Adjust |  | `picture.reset` | has options menu |
| Set Transparent Color | Adjust |  | `picture.setTransparentColor` | not in tabs |
| Transparency | Adjust |  | `picture.transparency` | has options menu |
| Picture Border | Picture Styles |  | `picture.border` | has options menu |
| Picture Effects | Picture Styles |  | `picture.effects` | has options menu |
| Picture Styles | Picture Styles |  | `picture.style` | has options menu |
| Aspect Ratio | Size |  | `picture.cropAspect` | has options menu |
| Crop | Size |  | `picture.crop` |  |
| Crop to Shape | Size |  | `picture.cropToShape` | has options menu |
| Save as Picture | Size |  | `picture.saveAs` | not in tabs |

## Table Design (contextual) (10)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Banded Columns | Table Style Options |  | `table.bandedColumns` |  |
| Banded Rows | Table Style Options |  | `table.bandedRows` |  |
| First Column | Table Style Options |  | `table.firstColumn` |  |
| Header Row | Table Style Options |  | `table.headerRow` |  |
| Last Column | Table Style Options |  | `table.lastColumn` |  |
| Total Row | Table Style Options |  | `table.totalRow` |  |
| Borders | Table Styles |  | `table.borders` | has options menu |
| Clear Table | Table Styles |  | `table.clearStyle` |  |
| Shading | Table Styles |  | `table.shading` |  |
| Table Styles | Table Styles |  | `table.style` | has options menu |

## Table Layout (contextual) (17)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Cell Alignment | Alignment |  | `table.align` | has options menu |
| Distribute Columns | Cell Size |  | `table.distributeColumns` |  |
| Distribute Rows | Cell Size |  | `table.distributeRows` |  |
| Convert Text to Table | Data |  | `table.fromText` | not in tabs |
| Convert to Text | Data |  | `table.toText` |  |
| Edit Table | Data |  | `table.editCells` |  |
| Sort Rows | Data |  | `table.sort` |  |
| Merge Cells | Merge |  | `table.merge` |  |
| Split Cells | Merge |  | `table.split` |  |
| Delete | Rows & Columns |  | `table.deleteMenu` | has options menu |
| Delete Columns | Rows & Columns |  | `table.deleteColumns` | not in tabs |
| Delete Rows | Rows & Columns |  | `table.deleteRows` | not in tabs |
| Delete Table | Rows & Columns |  | `table.delete` | not in tabs |
| Insert Above | Rows & Columns |  | `table.insertAbove` |  |
| Insert Below | Rows & Columns |  | `table.insertBelow` |  |
| Insert Left | Rows & Columns |  | `table.insertLeft` |  |
| Insert Right | Rows & Columns |  | `table.insertRight` |  |

## Chart Design (contextual) (8)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Add Chart Element | Chart Layouts |  | `chart.addElement` | has options menu |
| Quick Layout | Chart Layouts |  | `chart.quickLayout` | has options menu |
| Change Colors | Chart Styles |  | `chart.colors` | has options menu |
| Chart Styles | Chart Styles |  | `chart.style` | has options menu |
| Edit Data | Data |  | `chart.editData` |  |
| Switch Row/Column | Data |  | `chart.switchRowCol` |  |
| Change Chart Type | Type |  | `chart.changeType` | has options menu |
| Stacking | Type |  | `chart.stacked` | has options menu; not in tabs |

## Playback (contextual) (6)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Poster Frame | Editing |  | `media.posterFrame` |  |
| Trim | Editing |  | `media.trim` |  |
| Loop until Stopped | Options |  | `media.loop` |  |
| Start | Options |  | `media.start` | has options menu |
| Volume | Options |  | `media.volume` | has options menu |
| Play | Preview |  | `media.play` |  |

## Planned, not yet implemented (291)

These ids are in the plan but have no command yet. A command is only registered when it works; nothing below is a placeholder in the app.

- **ai**: `ai.designIdeas`, `ai.generateImage`, `ai.myPrompts`, `ai.rehearsalFeedback`, `ai.suggestImages`, `ai.writeMacro`
- **anim**: `anim.em.wave`, `anim.in.whip`, `anim.media.pause`, `anim.media.play`, `anim.media.seek`, `anim.media.stop`, `anim.path.custom`, `anim.timeline`
- **area**: `area.name`
- **camera**: `camera.border`, `camera.effects`, `camera.preview`, `camera.select`, `camera.shape`, `camera.style`, `camera.toggle`
- **canvas**: `canvas.addFrame`, `canvas.brainstorm`, `canvas.editPath`, `canvas.fromDeck`, `canvas.overview`, `canvas.removeFrame`, `canvas.toDeck`, `canvas.toSlides`
- **chart**: `chart.animateBy`, `chart.editInGrid`, `chart.formatSelection`, `chart.refreshData`, `chart.resetStyle`, `chart.saveTemplate`, `chart.selectData`, `chart.selectElement`
- **code**: `code.copyText`, `code.language`, `code.lineNumbers`, `code.run`, `code.stepLines`, `code.theme`
- **design**: `design.backgroundVideo`, `design.brandKit`, `design.effects`, `design.variant`
- **dev**: `dev.addins`, `dev.control`, `dev.controlProperties`
- **diagram**: `diagram.addBullet`, `diagram.addShape`, `diagram.autoLayout`, `diagram.changeShape`, `diagram.colors`, `diagram.demote`, `diagram.edit2d`, `diagram.larger`, `diagram.layout`, `diagram.moveDown`, `diagram.moveUp`, `diagram.orgLayout`, `diagram.promote`, `diagram.reset`, `diagram.rtl`, `diagram.smaller`, `diagram.style`, `diagram.textPane`, `diagram.toShapes`, `diagram.toText`
- **draw**: `draw.addPen`, `draw.lasso`, `draw.protractor`, `draw.ruler`
- **edit**: `edit.selectObjects`
- **equation**: `equation.latex`, `equation.linear`, `equation.normalText`, `equation.professional`, `equation.structure`, `equation.symbol`
- **file**: `file.compress`, `file.embedFonts`, `file.export.beamer`, `file.export.gif`, `file.export.handoutDoc`, `file.export.video`, `file.export.webLecture`, `file.optimizeMedia`, `file.sign`
- **fmt**: `fmt.tabs`
- **graphic**: `graphic.change`, `graphic.toShape`
- **ink**: `ink.color`, `ink.forward`, `ink.rewind`, `ink.thickness`, `ink.toMath`, `ink.toText`
- **insert**: `insert.gridObject`, `insert.icons`, `insert.linkedChart`, `insert.liveCamera`, `insert.model3d`, `insert.object`, `insert.onlinePictures`, `insert.pdfPages`, `insert.poll`, `insert.quiz`, `insert.rating`, `insert.screenRecording`, `insert.sectionZoom`, `insert.sparkline`, `insert.webEmbed`, `insert.wordCloud`
- **master**: `master.handoutOrientation`, `master.masterLayout`, `master.notesOrientation`, `master.placeholderToggle`, `master.slideOrientation`, `master.slidesPerPage`
- **media**: `media.addBookmark`, `media.border`, `media.color`, `media.corrections`, `media.crop`, `media.effects`, `media.exportTrimmed`, `media.fadeIn`, `media.fadeOut`, `media.fullScreen`, `media.generateCaptions`, `media.hideDuringShow`, `media.hideWhileNotPlaying`, `media.insertCaptions`, `media.noStyle`, `media.playAcrossSlides`, `media.playInBackground`, `media.removeBookmark`, `media.removeCaptions`, `media.resetDesign`, `media.rewind`, `media.shape`, `media.speed`, `media.split`, `media.style`, `media.volumeEnvelope`
- **model3d**: `model3d.panZoom`, `model3d.play`, `model3d.reset`, `model3d.scene`, `model3d.view`
- **outline**: `outline.collapse`, `outline.collapseAll`, `outline.expand`, `outline.expandAll`, `outline.showFormatting`
- **picture**: `picture.artisticEffects`, `picture.cropFill`, `picture.cropFit`, `picture.editPixels`, `picture.layout`, `picture.removeBackground`, `picture.resetSize`
- **poll**: `poll.anonymous`, `poll.chartType`, `poll.edit`, `poll.exportResults`, `poll.multiple`
- **quiz**: `quiz.correct`, `quiz.leaderboard`, `quiz.timer`
- **record**: `record.backgroundBlur`, `record.camera`, `record.cameraPreview`, `record.clearAll`, `record.clearSlide`, `record.fromBeginning`, `record.fromCurrent`, `record.microphone`, `record.rerecordSlide`, `record.teleprompter`, `record.timeline`
- **review**: `review.accept`, `review.endReview`, `review.nextChange`, `review.prevChange`, `review.protect`, `review.reject`, `review.reviewPane`, `review.thesaurus`
- **shape**: `shape.closePath`, `shape.combine`, `shape.connector`, `shape.editPoints`, `shape.fragment`, `shape.intersect`, `shape.lockAspect`, `shape.openPath`, `shape.rerouteConnectors`, `shape.setDefault`, `shape.setDefaultTextBox`, `shape.subtract`, `shape.textEffects`, `shape.textOutline`, `shape.textStyle`, `shape.textTransform`, `shape.union`
- **show**: `show.arrow`, `show.audienceLink`, `show.black`, `show.broadcast`, `show.cast`, `show.end`, `show.eraseInk`, `show.first`, `show.followScript`, `show.goTo`, `show.grid`, `show.hidePointer`, `show.highlighter`, `show.keepInk`, `show.laser`, `show.last`, `show.mediaControls`, `show.monitor`, `show.navigate2d`, `show.next`, `show.pause`, `show.pen`, `show.playNarrations`, `show.presenterLayout`, `show.previous`, `show.qa`, `show.rehearsalCoach`, `show.remote`, `show.resetResults`, `show.showResults`, `show.subtitleSettings`, `show.subtitles`, `show.toggleSubtitles`, `show.white`, `show.zoomIn`, `show.zoomOut`
- **slide**: `slide.createComponent`, `slide.detachComponent`, `slide.insertComponent`, `slide.lockLayout`, `slide.stackBelow`
- **table**: `table.cellMargins`, `table.colWidth`, `table.effects`, `table.eraser`, `table.penColor`, `table.penStyle`, `table.penWeight`, `table.rowHeight`, `table.selectCell`, `table.selectColumn`, `table.selectRow`, `table.selectTable`, `table.size`, `table.textDirection`, `table.viewGridlines`
- **tools**: `tools.dictate`, `tools.replaceImages`
- **trans**: `trans.fallOver`, `trans.flash`, `trans.flyThrough`, `trans.pan`, `trans.random`, `trans.sound`, `trans.strips`
- **view**: `view.arrangeAll`, `view.canvas`, `view.cascade`, `view.guides`, `view.handoutMaster`, `view.moveSplit`, `view.notesMaster`, `view.ruler`, `view.story`
- **zoom**: `zoom.background`, `zoom.changeImage`, `zoom.duration`, `zoom.editSummary`, `zoom.reset`, `zoom.returnToZoom`, `zoom.style`, `zoom.transition`
