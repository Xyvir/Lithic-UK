# Lifting a feature out of App.svelte

What it actually costs to move a feature out of `launcher-ui/src/App.svelte`, measured on
`main` at `8de414a7` (2026-11-02) before any of this work landed. Every number here was produced
by reading the file, not by intent, and the method is at the bottom so it can be repeated after
the state rework.

This exists because the obvious plan (lift the big features first, then simplify the state) is
backwards for two of them, and the reason is one variable.

## What App.svelte was made of

| | count |
|---|---|
| lines | 8,815 (460 KB) |
| `let` state | 197 |
| `$:` reactive statements | 71 |
| functions | 225 |
| imports | 46 |
| markup lines | 1,744 in 21 top-level blocks |

Comments are 33% of its lines and 38% of its bytes (2,929 lines, 179 KB), and the same is true of
the launcher sources as a whole: 32% of lines, 40% of bytes under `launcher-ui/src` excluding
tests. That is not where the context cost is. 671 comment blocks exist in App.svelte and 70% of
them are one to five lines, so there is no bulk to strip; and only 2% of the comment text appears
in `agents.md` or the round log, so "keep a short pointer to the long form" would mean authoring
180 KB of new prose rather than relocating something that exists. The comments are the rationale
and they are load-bearing: `scripts/check-launcher-copy.mjs` scans them on purpose, because the
sentence around an em dash is the sentence somebody is editing.

## What lifting a cluster costs

The cost is not the feature's own size, it is the closure: the helpers it calls, the state those
helpers read, and the state other code reads back off it. Followed to a fixed point, per seeded
feature:

| cluster | lines in its closure | names it needs from the page |
|---|---|---|
| git sync | 3,292 | 258 |
| vault (manager, unlock, offer, coverage) | 2,808 | 213 |
| bookmark | 2,500 | 213 |
| install | 1,306 | 93 |
| rebuild | 1,235 | 91 |
| icon | 142 | 18 |
| trail | 96 | 11 |
| server sync | 49 | 9 |

The two largest features are the two most expensive to move. A 258-name boundary is not a
component, it is the page with a different filename.

## What lifting a dialog costs

Dialogs are the other unit, and each one's binding count is measured the same way: distinct
component identifiers its markup mentions.

| dialog | markup lines | bindings |
|---|---|---|
| the recents panel | 357 | 41 |
| GitHub sync | 240 | 39 |
| version history | 147 | 22 |
| vault manager | 108 | 18 |
| the save-login offer | 100 | 18 |
| the icon manager | 83 | 21 |
| rebuild orphans | 63 | 12 |
| the trail (a snippet) | 61 | 6 |
| unsaved edits prompt | 57 | 6 |
| pending imports | 46 | 5 |
| reset at risk | 44 | 9 |
| bookmarks | 42 | 10 |
| instance backup | 36 | 7 |
| instance unlock | 29 | 9 |

A binding count also overstates the boundary when some of the names are imports the component can
take for itself: the unsaved-edits prompt measures 6, but four of those are `copy` and
`LOCALE_TAG`, so its real boundary is one prop and one event.

## The six hubs that decide everything

These are the names that appear in the most clusters' requirements. They are why every dialog
needs a double-digit prop list.

| name | clusters that need it |
|---|---|
| `status` | 8 of 8 |
| `confirmation` | 6 |
| `isSelfHost` | 6 |
| `shimToken` | 6 |
| `files` | 6 |
| `appliance` | 6 |

A long tail sits at 5 (`recentFiles`, `search`, `stageBeat`, `cachedEntries`, `dirtyEntries`,
`indexDbOnly`, `busy`, `openTauriPath`, and the handed-share watchers).

`status` is universal because every feature reports to the one status line, so every extraction
owes the page a way to write it. That single fact is most of why `git sync` measures 258 names and
why the ESP32 flash dialog measured 2. It never writes `status`.

## Lifted so far

Four surfaces came out cleanly, and each one is a boundary worth having in front of the others:

| component | lines | boundary | markup parity |
|---|---|---|---|
| `FlashDialog.svelte` | 120 | 2 props, 1 event | 19 lines, identical |
| `TrailPanel.svelte` | 107 | 4 props, 1 event | 65 tokens, identical |
| `DirtyRecoveryDialog.svelte` | 74 | 1 prop, 1 event | 61 tokens, identical |
| `CredentialOfferDialog.svelte` | 301 | 3 props, 2 events | 74 tokens, identical |

App.svelte went from 8,815 to 8,181 lines (460 KB to 436 KB), 7.2% smaller, while the four
components and `launcher-geometry.ts` total 753 lines. The split moves lines, it does not shorten them: the gain is that each
feature is one file an agent can read whole, instead of a set of identifiers scattered through
8,800 lines.

Boundaries that had to be found rather than assumed:

- **One variable, two surfaces.** `flashProblem` is written both by the flash dialog's failed run
  and by the manager row's failed browser handoff, and cleared by `openInstanceManagement`. It is
  bound rather than owned, so behaviour is unchanged. Giving each surface its own band would be a
  small improvement, and it is a behaviour change, so it was not made.
- **One reveal toggle, four PIN fields.** `pinReveal` is shared by the manager, the unlock prompt,
  the offer and its confirmation, which is why it is a bound prop rather than local state.
- **The row is composed where it is drawn.** `TrailPanel` failed type-check with a `rows` prop
  because the badge is composed by the page, not part of a `TrailRow`. The composition moved into
  the panel, which also let the parent ask `trailCommits.length` for its `has-trail` class.
- **A dialog that can be retargeted while open needs a key.** `{#key credentialOffer}` remounts the
  offer when the page hands it a new target, which is what reproduced the old field resets.

### The moves that need no boundary at all

A declaration that measures or formats, reads no component state and calls only modules is free:
it becomes `export` in a new file, the page gains one import, and nothing else changes.
`launcher-geometry.ts` is that move, holding the three Svelte actions the page used to declare
(`positionCachePreview`, `trackListScroll`, `alignNewLithLabel`, 143 lines between them). Their
bodies moved unchanged, verified line for line against `HEAD`.

What is left in that class is small, and worth doing only if it can join a module that already
exists rather than creating one: the external-link pair and `PROJECT_URL` (37 lines), the two size
formatters and the filename clip (42), and the import routing constants and their two readers
(59). The one snippet with no bindings at all, `fullBackupIcon`, is 14 lines of path data and is
not worth a component of its own.

## Why git and vault come last

Not because they are big, but because their boundary is made of hubs:

- `git sync`: 240 markup lines against 39 bindings, and it writes `status` constantly.
- `vault`: not one surface. The manager, the unlock prompt, the offer and the coverage refresh are
  separate, and the manager is bound to bookmark rows, instance opening and the backup controls.

Lifting either today produces a component with forty props. Lifting them after the hubs are
importable produces a component with five.

## The order this suggests

1. **The hubs**, as a store or module: `status` first, then `isSelfHost`, `appliance`, `files`,
   `confirmation`, `shimToken`. This is the highest-leverage change available and it is smaller
   than any feature extraction, because it moves values rather than logic.
2. **`git sync`**, which is where the locality dividend finally matches the effort: 1,008 lines
   and 96 blocks stop being interleaved with everything else.
3. **The vault manager**, then `install` and `rebuild`, which are the remaining double-digit prop
   lists.
4. **The remainder** (86 variables, 30 reactive statements, 20 of them shared) is the spine and is
   not a component. That is what a state design is for, and it is the only part that genuinely
   cannot be lifted as it stands.

## How this was measured

- **State, functions, imports**: top-level declarations at two spaces of indent in the script half.
- **Cluster closure**: seed on a feature's identifiers, then take every block that mentions one,
  then every App function those blocks call, to a fixed point. The IN set is what the closure reads
  that it does not own; the OUT set is what the rest of the page reads back off it.
- **Dialogs**: split markup by brace depth into top-level blocks, then count the distinct
  identifiers each mentions.
- **Hubs**: frequency of each name across the clusters' IN sets.
- **Parity after a move**: compare the extracted component's markup against the original block in
  `HEAD` as a sequence of structural tokens (element names, class attributes, ids, aria attributes,
  `viewBox` values, `copy.*` expressions), with the renamed variables mapped. The four extractions
  above each passed with no token missing and none reordered.

Two traps in the measurement worth remembering. A prefix based cluster map understates everything
that has no prefix (`instanceUnlock`, `credentialOffer`, every `offer*` field all belong to the
vault but sort into an "other" bucket), which is why the closure exists. And a substring anchor
like `'  {/if}'` matches inside `'      {/if}'`, so a slice taken with it silently truncates the
block; anchors that end a block need the line break.
