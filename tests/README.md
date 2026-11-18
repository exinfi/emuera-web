# Tests

Tests are grouped by area so a change can be checked by running only the tests that cover it.

| Area | Folder | Covers | Source paths |
|---|---|---|---|
| engine | `tests/engine/` | the interpreter core: language, parsing, saves | `src/engine/` |
| host | `tests/host/` | the DOM-free page layer: protocol, client input rules, zip and pack loading, drop recognition | `src/host/`, `src/play/`, `src/mobile/drop.ts` |
| data | `tests/data/` | reference tables the code relies on | `reference/`, arity tables |

`tests/areas.json` lists each area and the source paths it covers. Add a new area by creating the folder and adding it there (the runner refuses a folder that is not listed).

```
npm test                          # everything
npm test -- engine                # one area
npm test -- engine/language       # one topic (file)
npm test -- engine host           # several
npm test -- -t "recursion"        # tests whose name matches, across what was selected
npm test -- engine -t "RETURN"    # combine
npm test -- --changed             # the areas whose source paths changed since HEAD (uncommitted work included)
npm test -- --changed main        # ... since another git ref
npm test -- --list                # show the areas
```

Rules for a test in this folder: it passes on a clean clone, needs no game archive, network or browser, writes nothing to disk, and checks behaviour with a value worked out independently of the code (not a copy of its own output). Shared helpers are in `tests/helpers.ts`.
