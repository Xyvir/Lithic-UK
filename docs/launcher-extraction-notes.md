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

Two more rounds of that class were taken, and together they are what the last 128 lines of the
page were worth:

| move | lines | where it landed |
|---|---|---|
| the import routing group | 86 | new module `import-kinds.ts` |
| five type declarations | 12 | the modules that own their data |
| `clipFilename` | 8 | `document-format.ts` |

The import group is the one case where a new file is right, because its six declarations are one
decision (a file is one of four kinds, and its name, its window key and its fallback follow from
that): `ImportKind`, `importKindOf`, `importLithName`, `IMPORT_REQUEST`, `IMPORT_FALLBACK_NAME`,
`importContainerTitle`. `importKindOf` and `importContainerTitle` keep their names and bodies;
`importLithName` was a page-local function and is now exported.

The types went to their owners instead of into one `launcher-types.ts`, on the grounds that a
shared type file is how a hub is born: `TrailAnswer` belongs to `instance-trail.ts`,
`HistoryEntry` and `HistoryRow` to `wiki-history.ts`, `CacheSearchEntry` to `cache-search.ts`.
Two details cost a pass each. `HistoryRow` is `HistoryEntry & { inline?: boolean }`, so the pair
moves together and the dependency should be declared first even though TypeScript hoists it. And a
one line declaration is not a safe slice anchor, which is how `CacheSearchEntry` was nearly left
behind in the page while its type was deleted.

What is still in that class is small enough to leave alone until it has a home: the external-link
pair and `PROJECT_URL` (37 lines), and the two size formatters (24). `openExternally` reads `mode`,
which is an exported prop rather than a constant, so it is not free at all and it stays where the
prop is. The one snippet with no bindings, `fullBackupIcon`, is 14 lines of path data and is not
worth a component of its own.

## The reporting seam, taken before the hubs

`status` is the one hub every extracted surface needs, and 52 places in the page wrote it: 48 bare
assignments and four guarded clears inside timers and conditionals. It is now four named verbs, and
the variable itself is now assigned in two places, `report` and the guarded clear inside
`clearStatus`:

| verb | what it says | sites |
|---|---|---|
| `report(message)` | this is what just happened, gone at the deadline | 40 |
| `reportHeld(message)` | this names something to act on, so it stands | 12 |
| `reportAndRetire(message, ms)` | this gets its own clock | 2 |
| `clearStatus(only?)` | say nothing, or stand a line down if it is still that sentence | 12 |

**It changes no state.** `status`, `heldStatus`, `statusSettled` and `cancelStatusDeadline` are
still the page's, the reactive `$: syncStatusDeadlines(status, heldStatus)` is untouched, and
`status-lifetime.ts` is not touched at all. What moved is the vocabulary: a site now says which
class of line it writes instead of leaving that to be inferred from what happens to it later.

**It is name-only, and that was checked rather than asserted.** Every right hand side in `HEAD`
was compared as a multiset against every `report(...)` argument. The one expression that does not
appear on the other side is the empty string, which became `clearStatus()`: 40 report calls and 8
clears account for all 48 assignments, and the four guarded clears became the two argument-taking
calls and the two inline conditionals.

**What it buys, exactly.** A component boundary needs one prop, `onReport={report}`, and no
adapter: the callback is the page's own writer, so a surface lifted tomorrow reports what it
reported yesterday. And the later move into a module or a store is one line inside `report`
rather than fifty call sites, because the call sites already say `report(...)`.

**What it does not buy.** No line count. The page grew by 27 lines, all of it the two functions and
their docs, and the prop count of any surface is unchanged until that surface is actually lifted.
It is a seam, not a saving: worth taking because the alternative is paying for it during the risky
pass, where a rename of fifty sites is the kind of churn that hides a real change.

**The redeclaration trap, for whoever moves this next.** `status` is shadowed by five locals of the
same name in `App.svelte` (`const status = await readGitStatus(...)` and its four siblings), so a
search and replace on the bare name silently damages those. The conversions above were anchored on
statement position (start of line, or after `{ ` or `; `), which is the shape to keep.

## The branch decisions, named

The declarations that decided which launcher a page is now live in `branch-decisions.ts` (91 lines)
and are called from the page as one-line adapters:

| decision | rule | mentions in the page |
|---|---|---|
| `hasLocalSync` | the app, or a shim token | 22 |
| `shimBackend` | a shim token is present | the disjunction appeared 5 times, now once |
| `storageMode` | a shim is a file backend, everyone else asks the platform | 1 declaration |
| `indexDbOnly` | that mode is `index-db` | 10 |
| `isSelfHost` | the mode is `self-host` | 37 |

**None of them was ever a `let`.** Three were consts, `hasLocalSync` was a `$:` derived from the
mode, and `isSelfHost` was a function, so the state tree's finding 1 was a naming problem rather
than a state problem. That makes this the cheapest reduction of the hub list available, and it is
why it went first: no store, no ownership change, and the 69 mentions that read the names are
untouched.

Three duplicates went with it: the sites that wrote `mode === 'tauri' || shimToken !== null` by
hand now read `hasLocalSync`. `showBookmarks` followed as a fifth decision, taking the iOS answer
as an argument so the platform read stays where `isIosDevice` documents it. There is now no
`mode === 'tauri' ||` left in the page at all.

The module is pure by construction, which is the part worth copying for the stateful pass: every
function is an answer about an environment the page has already read, so the seven cases in
`branch-decisions.test.ts` (a shim on a browser with no picker, a shim told to use the fallback, a
published page with and without the API, the query override, an app that cannot hold a document,
each mode against the local-backend question) run without a page at all. The inline copies could
only be tested by driving the whole launcher.

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
