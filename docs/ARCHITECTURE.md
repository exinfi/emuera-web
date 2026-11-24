# Architecture

This is a map of the code for someone who needs to find their way around it: what the parts are, how they talk to each other, where state is kept, and where to look when you want to change something. It is deliberately not a reference for every command; the code comments carry the detail, and each source file starts with a comment saying what it is.

emuera-web is a browser-only interpreter for Emuera games. A game normally lives as a folder on the player's computer, next to the Emuera program that runs it. A browser cannot open a folder the way that program does, so the player gives the page the game folder as a zip of its text and resource files. The page reads the zip, hands the files to an interpreter running in a Web Worker, and draws what the interpreter prints. Nothing is sent anywhere: there is no server component, and the interpreter has no network access.

## How Emuera works

Emuera is a family of engines that run text games written in the style of eramaker, the "era" games. The original was a Windows program, and other authors have since built branches on it, each adding features. They share one model, and this section describes only that shared model. A game is a folder of script, data and resource files that lives next to the Emuera program (or whichever branch the game was made for) and is distributed together with it as a complete bundle. The engine reads that folder and runs it.

- **Scripts.** The game's logic is written in a scripting language kept in script files (ERB, with ERH header files). A script is a set of named functions made of statements and expressions over integer and string variables. Variables are mostly arrays, many of them tied to characters, plus global ones and temporary ones used for passing values around.
- **Data.** Tables of data files (CSV) name the things the scripts refer to by number, such as abilities, talents, items and characters, and hold facts about the game such as its title and version. Scripts can use the names, and the engine turns them into indices before the game runs. Small configuration files adjust the engine's behavior for that game.
- **Resources.** Images, sounds and fonts live in their own folders. Resource tables describe the images.
- **The screen.** The game talks to the player through a console: lines of text, some of which are buttons that send a value when clicked, along with images and background layers. A script prints, then waits for the player, for a number, some text, a keypress, a mouse or key event, or a timeout.
- **The system states.** Above the scripts is a fixed loop of states, such as the title screen, the start of a new game, and the main play loop. In each state the engine calls well-known script functions, and the scripts move the game from one state to the next. Most of a game happens inside those functions.
- **Saves.** Scripts save and load numbered slots and a global save, which the original keeps as files in a save folder.

Games depend on very exact behavior: the order things are evaluated in, how integers overflow, how text is measured (in bytes of the Japanese character set the engine was built around, which is why wide and narrow characters line up), when a line reaches the screen, and what a button click returns. A game that works on the original can break on a small difference.

## How we work

This is a reimplementation, not a wrapper. The interpreter is written in TypeScript, follows the behavior of the original (the C# source of Emuera EM+EE is the specification), and runs in the browser. The pieces map onto the picture above like this:

- The scripts and CSV files are read from the zip and parsed by `src/engine/compiler/` into a program; the CSV names are resolved at that point, as the original does.
- The program runs in `src/engine/runtime/`, with the system states in `system.ts` following the original's state machine.
- The console is a message stream: the interpreter prints into a renderer, and when it waits for the player it posts what it is waiting for to the page, which draws the screen and sends back the answer.
- The game folder is virtual. There is no file system, so `sav/`, text files a game writes, and resources come from the zip and from browser storage: saves live in "memory cards" in IndexedDB and can be exported and imported as zips, and native `.sav` files can be converted.
- The parts of Emuera that need a desktop are handled in the page or stubbed: plugins and network commands are stubbed, and the update check answers without any network access. Fonts the game expects (often MS Gothic) fall back to a bundled font when they are not installed.
- Where games differ in ways the engine cannot guess, we use a profile (which Emuera the game was written for) and, for individual games, patches that fix or speed up one known function. These are always opt-out and listed in the page.

The rest of this document is about how that is organized in the code.

## The big picture

```
 page (main thread)                                  Web Worker
 ------------------                                  ----------
 src/mobile/*        the shell: panel, input,        src/play/worker.ts   entry point, owns one VM
                     viewport, widgets                  |
 src/host/web/*      browser parts: zip reader,         +-- src/engine/compiler/   text -> program
                     screen view, fonts, packs,         +-- src/engine/runtime/    the VM and the commands
                     audio, memory-card session         +-- src/engine/patches/    per-game fixes
 src/host/client.ts  worker client + input rules
 src/host/protocol.ts  <---- typed messages ---->   (same file: the contract)
 src/translate/*     optional translation, in its own worker (Bergamot)
```

The one idea to hold on to: the engine never touches the page, and the page never reaches into the engine. They exchange typed messages (`src/host/protocol.ts`). The page sends a `start` message with the game's files and options, then `input` and mouse or key messages; the worker answers with `screen` or `frame` messages (the lines to show, the buttons, the sprites), plus `sound`, `persist` (a save was written), `status`, and a few others.

Inside the worker, the interpreter is written as a generator. When a script needs the player (INPUT, WAIT, a timed wait) the VM yields a request, the worker posts a `screen` message that says what it is waiting for, and execution resumes when the page sends the answer. This keeps the core synchronous, free of timers and promises, and easy to run headless in tests.

## Directory map

| Path | What it is |
| --- | --- |
| `src/engine/compiler/` | Text to program. The preprocessor (`[IF]`, `#DEFINE`, `_Rename.csv`), the ERB/ERH parser, the expression grammar, name resolution (CSV names such as `ABL:TECH` become indices), load order, CSV name tables, and argument-count checks. Pure functions over `{ path: text }`. |
| `src/engine/runtime/` | The VM and everything it runs: variables, statements, built-in functions, the system state machine, saves, graphics, XML, console state. See the module map below. |
| `src/engine/patches/` | Per-game compatibility and speed patches. Each is tied to one game and one fingerprint. `registry.ts` is the catalogue the page lists. |
| `src/engine/profile.ts` | Which Emuera a game was written for (`em-ee`, `emuera-net`, `puchi`). A profile switches behavior only where the engines differ. |
| `src/engine/textdecode.ts`, `src/engine/util/` | Text decoding (UTF-8, then Shift_JIS), line splitting the way Emuera reads files, case-insensitive keys, .NET regex translation. |
| `src/engine/adapter.ts` | A headless way to run the engine for tests; not used by the page. |
| `src/play/` | The worker entry (`worker.ts`), and engine-adjacent code shared with the page: memory cards (`cards.ts`), HTML unescaping and colors, the automatic `[N]` buttons. |
| `src/host/` | The platform-neutral host layer: the message protocol, the worker client (`client.ts`, which also holds the input rules every shell must share), pure screen helpers. No DOM. |
| `src/host/web/` | Browser implementations: the zip loader, the screen view, fonts, audio, resource packs, the memory-card session, native save recognition. |
| `src/mobile/` | The page shell. Despite the name it serves phones and desktops: control panel, pan/zoom viewport, touch and mouse handling, widgets, translation panel, drag and drop. |
| `src/translate/` | The optional translation feature, in its own tier. |
| `src/version.ts` | The release number. |
| `reference/` | Tables the code relies on, generated from the original Emuera source (command and variable lists, argument forms, known gaps, which variables are saved). Treat as generated. |
| `tools/` | Build scripts, the test runner, a translation-pack builder. |
| `tests/` | The test suite, grouped by area. See `tests/README.md`. |
| `dist-play/play.html` | The built single-file player, committed as a reference. The published site is built fresh from source. |

## Life of a game

1. **Loading the zip** (`src/host/web/gamezip.ts`, called from `src/mobile/mobile.ts` `load`). The zip's directory is read by the thin reader in `src/host/web/zipindex.ts`: it reads the central directory only (zip64 included), names an entry by its UTF-8 flag, its Unicode Path field or a Shift_JIS fallback, inflates one entry at a time with pako, and holds no copy of the archive. The constant `THIN_ZIP` at the top of `gamezip.ts` switches back to JSZip (images on demand needs the thin reader). The folder that holds the game is found by looking for `ERB/`, `CSV/` and similar markers, and each file is classified as code, data, image, sound, font or text. Text is decoded as UTF-8 and falls back to Shift_JIS. Resource packs (`src/host/web/packs.ts`) are merged over the game's files in list order; a later pack wins. When a path is supplied again the loader removes the earlier copy using a record of the exact key it was stored under, so an override costs one lookup however many files there are. Text-like files outside the usual folders (XML, map data and so on) are taken only with the option "enable extra file check" (`xrefs`). With the thin reader each one becomes a `TextRef` in `textRefs` (the zips are listed in `imageSources`, as for images) and nothing is read at load; the worker gives the VM a reader per file (`VM.lazyTexts`) and LOADTEXT reads and decodes it on first use (`VM.getText`, with a bounded cache of decoded text); EXISTFILE and ENUMFILES see all of them. Without the thin reader the files are read at load within a 20 MB budget, in the folders the game's code names.
   By default (loader option "read images on demand", `ximages`) image files are not read at load. Each is kept as an `ImageRef` (`protocol.ts`): its place in its zip, its size in bytes and the zip it lives in. Width and height are read at load without keeping any image data: after the last zip is added, `GameLoader.sweepImageSizes` makes one forward pass over each zip (`sweepHeads` in `zipindex.ts`) in slices of the read-ahead size, cuts each image's first 16 KB out of the slice it falls in, reads the size from that header and drops the slice. The size goes into the `ImageRef`, so the engine never reads a file to answer a size question. A few large forward reads replace one small read per image: a file-backed Blob has a cost per read, and on some devices a small read at a scattered place costs far more than a large forward one. An image whose size the pass could not read is read when the game first asks (the first 16 KB, or the whole file when the header does not hold the size). The image's bytes are read when it is first drawn. With the option off every image is read at load and held, as before.
2. **Memory card** (`src/host/web/cardsession.ts`, storage in `src/play/cards.ts`). The page picks the card for this game and passes its saves in the `start` message.
3. **`start` message** to the worker (`StartMsg` in `protocol.ts`): the ERB and CSV text (or ERB as bytes in the low-memory path), resource images (or, with `ximages`, references to them plus the zips they live in: Blobs are posted as handles, not copied), sound names, saves, fonts, and the options the player chose.
4. **Parsing** (`start()` in `src/play/worker.ts`). Source patches are applied to a file's text just before it is parsed, `parseProgram` builds the program (function bodies are parsed lazily by default), and the VM, tables, character templates and config are created. Per-game patches are installed here.
5. **Running** (`src/engine/runtime/system.ts` drives `vm.ts`). The system state machine is a port of Emuera's: TITLE, FIRST, SHOP, TRAIN and the rest each run a script function and then pick the next state. Statements are closures built from the AST; expressions are compiled to closures once.
6. **Output.** The VM prints to a `Renderer` (`WebRenderer` in `worker.ts`), which collects lines, buttons and graphics. When the VM yields for input, the worker sends a `screen` message. With `deltaLines` on, lines the page already has are not sent again.
7. **Drawing** (`src/host/web/screenview.ts`). Turns a `screen` message into DOM, answers "which button is under this point", and handles tooltips. The shell (`mobile.ts`) owns the layout and decides what a tap or click means; the rules for what a click does at each kind of wait are in `src/host/client.ts`.
8. **Saves.** The script's save statements (`SAVEDATA`, `SAVEGLOBAL` and the like) write into slots held by the VM; the worker posts `persist` messages, and the card session writes them to the browser's storage.

## The engine in more detail

**Compiler** (`src/engine/compiler/`). `preprocess.ts` handles the line-level conditionals and comments; `parser.ts` builds statements (the grammar per command comes from `reference/builtins.json`); `expr.ts` parses expressions and FORM strings; `resolve.ts` swaps CSV names for indices; `tables.ts` holds CSV name tables and array sizes; `arity*.ts` hold the argument-count rules, two of which are generated tables.

**VM** (`src/engine/runtime/vm.ts`). Runs compiled statement arrays, one frame per call, as generators. Integers are 64-bit: JS numbers while they are safe, `bigint` beyond that (`value.ts`).

**Registries.** Statements are registered in `COMMANDS` (`commands.ts`) and expression functions in `FUNCS` (`funcs.ts`) by modules that `vm.ts` imports for their side effect. To find where a command lives, search for its name in `src/engine/runtime/`; to add one, put it in the module that matches its concern.

| Concern | Modules |
| --- | --- |
| Core | `vm.ts`, `eval.ts` (expressions and variable references), `vars.ts` (variable store), `value.ts`, `system.ts`, `host.ts` (the surface to the outside), `errctx.ts` (error messages with the ERB call stack) |
| Flow and basics | `commands.ts`, `funcs.ts`, `cmdargs.ts`, `listcmds.ts` (the `TRYCALLLIST` family and `TRYCALLF`) |
| Printing and console | `printcmds.ts`, `consolestate.ts`, `htmlfuncs.ts`, `tooltipcmds.ts`, `windowcmds.ts` |
| Input | `inputcmds.ts` |
| Variables and data | `varcmds.ts`, `varbyname.ts`, `arrayfuncs.ts`, `datacmds.ts`, `datatable.ts`, `csvfuncs.ts`, `charas.ts`, `charatemplates.ts`, `compare.ts` |
| Text | `strfuncs.ts`, `text.ts` (width in Shift_JIS bytes), `methodcmds.ts` |
| Files and saves | `filefuncs.ts`, `savedata.ts`, `nativesave.ts` (conversion to and from Emuera's own `.sav` files) |
| Graphics and sound | `gfx.ts`, `gfxfuncs.ts`, `imagestore.ts`, `fixedimg.ts`, `puchicmds.ts`, `sound.ts` |
| XML | `xml.ts`, `xmldom.ts`, `xmlfuncs.ts` |
| Program and environment | `systemcmds.ts`, `envfuncs.ts`, `config.ts`, `configitems.ts`, `opts.ts` |

**Patches** (`src/engine/patches/`). A game is recognized by the code in its `CSV/GameBase.csv`, not by version. A patch is either native (replaces a function with faster code, same results), a source patch (fixes one function's text, and only applies when that function is byte-for-byte the one it was written for), or an alias patch (for example image folders). Every patch can be switched off individually from the page, and there is a master switch.

**Profiles** (`src/engine/profile.ts`). The Emuera branches share one scripting language, but they have drifted apart: the same statement can behave slightly differently, and each branch has instructions the others lack. A game is written and tested against one of them, so running it faithfully means behaving like that branch. Rather than build one interpreter per branch, there is one interpreter with a profile that selects the places where the engines differ. The profile exists to bridge compatibility between the Emuera types, so that games made for different branches can run on the same engine.

The rules are:

- The default profile, `em-ee`, follows Emuera EM+EE, which is the reference for everything the branches share. If a feature exists in EM+EE, its behavior is the main implementation.
- A behavior that differs in another branch goes under that branch's profile, so it cannot change how an EM+EE game runs. The same goes for instructions that only another branch has and that could clash with a name in an EM+EE game; functions that cannot clash can simply be added.
- The profile is detected from the game's files, not chosen by the player. A game that ships a `setting.json` with keys EM+EE does not use is treated as Emuera.NET (`emuera-net`). `puchi` (PuchiEmuera) is switched on by the code of one specific game and never guessed from features, so nothing it adds can leak into another game.
- The boot summary in the debug view says which profile is in effect and why.

**Optimizations** (`src/engine/runtime/opts.ts`). Ways of running that are not the original's way. One switch turns the set on or off.

## The host layer

`src/host/protocol.ts` is the authority on message shapes. Changes to it are meant to be additive: new fields are optional, and an older page keeps working. `PROTOCOL_VERSION` changes only when a message name or payload shape changes incompatibly.

`src/host/client.ts` owns the worker and the input rules, so every shell behaves the same: what a click does at a wait, how skipping works, how mouse and key events reach INPUTMOUSEKEY, and the log of inputs. A shell turns its native events into `Client` calls and renders what the client's hooks hand it.

`src/host/web/` is reusable by any browser shell. `screenview.ts` draws; `gamezip.ts` reads zips (with `zipindex.ts`, the thin zip reader); `fonts.ts`, `fontinfo.ts`, `fontstore.ts` register fonts (the worker measures text, so fonts must be registered in the worker as well as the page); `audio.ts` plays sound (workers have no audio); `packs.ts` and `cardsession.ts` manage packs and cards; `nativescan.ts` recognizes Emuera's own save files without loading a game.

## The shell

`src/mobile/mobile.ts` is the page's main module and is large; the other files in `src/mobile/` hold the parts that stand alone (`viewport.ts` pan and zoom, `assist.ts` nearest-button selection, `rules.ts` the pure rules (direction pad shape, the pad's default, quick-value parsing; tested in `tests/host/shellrules.test.ts`), `memory.ts` card UI, `packs.ts` pack list UI, `patches.ts`, `tlpanel.ts`, `drop.ts`). The page's HTML is `src/mobile/shell.html`, with the launcher options generated from `OPTION_DEFS` in `protocol.ts` (the single table of option defaults). Within `mobile.ts`, the main sections are: debug and issue list, tap handling, the quick access buttons (off by default; the repeat button and the values the player adds), widgets (direction pad and custom buttons; the pad's layout and buttons are saved per game), font UI, the game loader, bundled and auto-loaded files, and translation wiring. The section headings in the file are the quickest guide.

The debug list (the dbg sheet) holds issues (warnings and errors, counted on the button) and load facts, which are not counted: the page's line (zip read, image sizes pass) and the engine's line (`info` message from the worker: parse, sprite tables, first screen, image sizes still read from the file, image reads, time screens waited for images). Each fact is one entry, updated in place.

## Translation

The translation feature (`src/translate/`) is optional and isolated. With it off, none of it runs and nothing is stored. When on, it reads finished lines from the screen messages the page already receives; it never writes into the game.

- `pack.ts` reads translation zips (a `translation.json` manifest, or a plain zip of Mozilla model files recognized by file name). There are engine zips and language zips; a zip can hold both.
- `known.ts` accepts only the published engine: the SHA-256 of the three engine files is checked when a zip is added and again when the worker starts, because the engine is code that runs in the browser.
- `bergamot.ts` starts the engine (WebAssembly) in its own worker from blob URLs built from the zip; nothing is fetched.
- `filter.ts` decides which lines are worth translating; `guards.ts` catches degenerate output from the small model; `queue.ts` translates only while the interpreter is idle; `store.ts` keeps the zips and the per-game translation memory in IndexedDB; `index.ts` ties it together; `panel.ts` and `src/mobile/tlpanel.ts` are the panel.

## Where state lives

| What | Where |
| --- | --- |
| Memory cards (saves) | IndexedDB `emuera-web`; a card can also be exported as a zip or mounted from a folder where the browser allows |
| Resource packs | IndexedDB `emuera-web-packs` |
| Translation zips and memory | IndexedDB `emuera-web-translation` |
| Imported fonts | an IndexedDB font store, global to the browser |
| Player preferences | `localStorage` keys beginning `emu.` (tap mode, widgets, panel state, translation options); per-patch switches under `emuera-patch:` |
| Which bundled files were auto-loaded | `localStorage`, `emu.auto:<kind>:<file>:<size>` |

All storage access is guarded: the page keeps working with storage blocked, it just does not remember anything.

## Build and test

- `npm run build:mobile` runs `tools/build-mobile.mts`: esbuild bundles the worker and the shell, the worker is inlined as a string, the bundled fonts are inlined (the game fonts, and the shell's own text face, which is loaded outside the game's font list), the page HTML is filled in, and the result is `dist-play/play.html`. The header of the page carries the font licenses and the build line (release number and time).
- `npm run build:site` runs the above and writes `site/`: the page as `index.html` plus any files found in `bundled-assets/` (`tools/lib/bundle.ts` finds them by name; a manifest `bundled/bundle.json` lists them because a static host cannot list a folder).
- `npm run typecheck`, `npm test` (see `tests/README.md` for running one area, one topic, or only what a change touched).
- `tools/make-translation-pack.mts` builds translation zips (see its header).

## Where to look

| To do this | Start here |
| --- | --- |
| Fix or add an ERB command or function | the module in `src/engine/runtime/` for that concern; `reference/builtins.json` lists what Emuera has |
| A game fails to parse | `src/engine/compiler/` (`preprocess.ts`, `parser.ts`); the debug log shows the file and line |
| A game runs but behaves differently from Emuera | find the command in `src/engine/runtime/`, then compare with the original source; add a test in `tests/engine/` |
| Add a per-game patch | `src/engine/patches/registry.ts` (the catalogue) and the existing patch files as examples |
| Add a launcher option | `OPTION_DEFS` in `src/host/protocol.ts` (an option marked `hidden` gets no checkbox and the page sends its default), then read it in `start()` in `src/play/worker.ts` |
| Add or change a message between page and worker | `src/host/protocol.ts` (keep it additive), the handler in `worker.ts`, the client in `src/host/client.ts` |
| Change what a click or tap does | `src/host/client.ts` for the rules, `src/mobile/mobile.ts` `onTap` for the shell |
| Text layout or button rendering is wrong | `src/host/web/screenview.ts`; text width is measured in `src/engine/runtime/gfx.ts` and `text.ts` |
| Fonts look wrong | `src/host/web/fonts.ts` (resolution and fallbacks), `fontinfo.ts` |
| Saves | `src/engine/runtime/savedata.ts` (engine), `src/play/cards.ts` and `cardsession.ts` (storage), `nativesave.ts` (native `.sav`) |
| Resource packs | `src/host/web/packs.ts` (scan and storage), `src/mobile/packs.ts` (UI) |
| Zip reading, overrides, images on demand | `src/host/web/zipindex.ts` (reader), `src/host/web/gamezip.ts` (loader, override rule), `src/engine/runtime/imagestore.ts` (tiers, size on first ask), `GameLoader.sweepImageSizes` and `sweepHeads` (sizes at load), `start()` in `src/play/worker.ts` (registers the references); tests in `tests/host/zip.test.ts` and `tests/engine/imagestore.test.ts`; extra files by reference: `registerExtras` in `gamezip.ts`, `VM.getText`, `tests/engine/lazytext.test.ts` |
| Translation | `src/translate/` |
| Page layout or panel UI | `src/mobile/shell.html`, `mobile.css`, `mobile.ts` |

## Conventions and gotchas

- **The original is the specification.** Emuera EM+EE behavior is the reference. When behavior is in question, check the original source rather than guessing, and prefer a narrow fix with a test that states the expected value independently of the code.
- **No DOM in the engine.** Everything under `src/engine/` and `src/host/` (outside `host/web`) must run in a worker or in Node.
- **Messages are additive.** Add optional fields; do not rename or reshape existing ones.
- **A name is defined once.** Commands and functions register by name; a second definition silently replaces the first, so search before adding.
- **Generated files.** `reference/*.json`, `arity-table.ts` and `stmt-arity-table.ts` are derived from the original source. The tooling that generated them is not in this repository, so edit them by hand only with care and say so in the commit message.
- **Memory.** Large games matter on phones: ERB can be parsed lazily and decoded per file, and images are held in tiers. By default the files stay in the zip (`ximages`); encoded files read on demand are kept under a budget (`imageCacheMB` in `StartMsg`, default 128 MB); decoded bitmaps are kept under a second budget (256 MB, `imageBudgetMB` lowers it) and decoded again on demand. In each tier the least recently used goes first. Reading from a file-backed Blob has a cost per read, so an image's bytes are read on first use rather than at load, and the sizes of all images come from one forward pass at load whose slices are dropped as soon as the headers are read. The debug option `eager` (no checkbox, but a host can still send it) decodes every image at boot.
- **Storage may be blocked.** Never let a storage failure stop the page.
- **Tests.** A test must pass on a clean clone with no game archive, network or browser. See `tests/README.md`.
