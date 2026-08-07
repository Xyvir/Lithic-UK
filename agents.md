
Please note, the below instructions are loosely organized by priority, with most important being at the top.

# Missing Source Context (IMPORTANT)

**CRITICAL RULE FOR ALL AGENTS:**
If you need source context that is NOT available locally within this repository (such as vanilla TiddlyWiki core files or external third-party plugins), **DO NOT** attempt to find or download it yourself. Instead, you MUST explicitly **ASK THE USER (THE DEVELOPER)** to provide the relevant context manually. 

# Tiddler File Format (`*.tid`)

**CONTEXT:**
TiddlyWiki parses `.tid` files and relies on specific formatting for headers and body content.

**PROBLEM:**
Including a trailing newline at the end of a plugin `*.tid` file can sometimes cause formatting or parsing issues within the wiki.

**STANDARD OPERATING PROCEDURE:**
When creating or editing plugin `*.tid` tiddlers, make sure that they DO NOT have a trailing newline after the last character of the body content. 
To guarantee this, after creating or editing a tiddler you should always execute the provided `trim.ps1` script, passing in the paths of the files you modified:
`powershell -ExecutionPolicy Bypass -File c:\Users\temp\Lithic_Dev\Lithic\assets\trim.ps1 -Files <path_to_file>`

Additional conventions: repo `.tid` files are **CRLF-encoded** — if your editing tool wrote LF, convert to CRLF first (see Environment & Workflow Notes). Pass **one path per `-Files` invocation**; the comma-joined multi-path form had `$_` quoting issues and silently did nothing.

**Bad Example (Trailing newline):**
```yaml
title: $:/config/lithic/sidebar-visibility/$:/core/ui/SideBar/More
type: text/vnd.tiddlywiki

hide\n
```

**Good Example (No trailing newline):**
```yaml
title: $:/config/lithic/sidebar-visibility/$:/core/ui/SideBar/More
type: text/vnd.tiddlywiki

hide
```

# Lithic Design Philosophy & Feature Integration Guidelines

**CONTEXT:**
Lithic is a highly opinionated, single-user PKMS. The following design decisions are intentional and should be respected when suggesting or implementing features. Do NOT suggest features that contradict these principles.

## Core Architecture: Streams-First Outliner

Lithic's primary authoring experience is built on the **Streams plugin** (outliner nodes), not the vanilla TiddlyWiki editor. Key implications:

1. **Keyboard navigation** (Tab/Shift+Tab indent, Alt+Up/Down reorder, Ctrl+Enter new sibling) is already part of the Streams experience. The vanilla Streams plugin is NOT in the local repo — it is fetched at build time via `external.yml` and extended by `lithic-patch-streams`.
2. **Full-text search** surfaces parent context via Streams' built-in breadcrumb navigation. This is not a gap.
3. **Per-tiddler version history** does not integrate well with Streams because Streams subverts the vanilla TW edit/draft workflow. Wiki-level versioning via git/GitHub and browser-storage backups in `launcher.html` is the chosen approach.

## Intentional Feature Omissions

These features have been deliberately rejected. Do NOT suggest or implement them:

- **Global graph view / force-directed backlink visualization:** Considered smoke and mirrors that conflates knowledgebase importance with size/complexity. The Pyramid sidebar (hierarchical mermaid tree) and backlink pills are sufficient for discovering connections.
- **Quick capture / inbox pattern / web clipper:** The developer believes that if an idea can be lost, it wasn't worth remembering. The interstitial journal (today's journal entry) is the only intended capture point — jot a quick note there and do a "full capture" later. Adding an inbox workflow adds friction under a false fear of losing ideas.

## Feature Integration Guidelines

When adding new features to Lithic, follow these principles:

1. **FilterOps as the dashboard layer:** New "views" or "dashboards" (e.g., weekly review, orphan detection, overdue todos) should be delivered as **saved filters accessible via FilterOps**, not as standalone tiddlers or sidebar tabs. Users can use the existing "transcludify" / eyeball button to create permanent views from filters they find useful.
2. **External reference wiki for templates:** Anchor templates and example FilterOps presets should be delivered via an external "Lithic Reference Wiki" that users can drag-and-drop from, rather than bloating the core distribution.
3. **Markdown export via embed-stream:** Rather than building a dedicated markdown exporter, the strategy is to improve the `<<embed-stream>>` macro (removing extra whitespace) so it can produce markdown-friendly flattened output from nodestreams. This leverages existing workflows.
4. **Lightweight plugin integrations only:** When integrating third-party functionality (e.g., spaced repetition), prefer lightweight plugins that can slot into the Streams experience. Reject full "editions" or heavyweight solutions (e.g., TidMe) that would require architectural changes.
5. **Lithic Patina (simple UI mode)** will eventually hide advanced TiddlyWiki UI elements. Features gated behind Patina (like hiding alternate storyviews) should be designed as toggleable via config tiddlers, not hard-coded removals.

# What is a `*.lith` File?
A `.lith` file is an extension of the vanilla TiddlyWiki `*.tid` file format, which is based on an HTTP RFC format for headers and body.

**Key differences and requirements for `.lith` formats:**
1. It supports multiple tiddlers appended together within a single file.
2. The **triple-asterism** (`⁂⁂⁂`) is used as a strict delimiter to separate each individual tiddler inside the file. Do NOT use standard asterisks.
3. The `title` field is explicitly required for each tiddler entry within the file.
4. The `created:` and `modified:` front matter items are not necessary and should be omitted to save space.

# GitHub Actions Build Process

**CONTEXT:**
The Lithic PKMS wiki is compiled and published automatically via a GitHub Actions CI/CD pipeline (`.github/workflows/build-wiki.yml`).

**PROCESS OVERVIEW:**
1. **Dependency Installation:** The pipeline starts by setting up the Node.js environment and running `npm install`.
2. **Mirroring External Plugins:** It dynamically fetches all third-party dependencies defined in `external.yml` using `npm run mirror`.
   - *Note on External Plugins:* External plugins (such as `tiddlystudy`, `relink`, etc.) are intentionally omitted from the repository itself to keep the source tree clean and ensure they are fetched fresh or from specified remote sources during build time.
3. **Configuration Generation:** It dynamically generates the TiddlyWiki build configuration (e.g., `prod-tiddlywiki.info`) representing the specific compilation target.
4. **Compilation:** The core `tiddlywiki` CLI is invoked to compile the output (e.g., `npx tiddlywiki wiki --build index`), generating the raw HTML.
5. **Post-Processing & Release:** The built HTML file is renamed, branded ("Lithic PKMS"), and for production releases, the PWA manifest/offline service worker version is bumped. The final artifacts are committed and pushed back to the repository and attached to a GitHub Release.

**IMPORTANT DIRECTORY RULES:**
- The items within the `assets/` directory are merely for **local reference** and debugging. They should **NOT** be manually edited. The CI/CD pipeline dynamically handles fetching the definitive external dependencies based on `external.yml` during the build process.

# TiddlyWiki JS Plugin File Format (`*.js.tid`)

**CONTEXT:**
When creating or editing JavaScript plugins, macros, or startup modules in TiddlyWiki via `.js.tid` files, the boot parser requires a specific dual-header format to function correctly. 

**PROBLEM:**
If a `.js.tid` file is missing the leading plain-text frontmatter, or missing the `/*\` comment block, the TiddlyWiki boot sequence will crash with a `Syntax error in boot module` or `Unexpected identifier` error. The core `$tw.boot` system reads the `/*\` block to extract module metadata *before* the main parser is loaded.

**STANDARD OPERATING PROCEDURE:**
Every `.js.tid` file MUST contain the module metadata **twice**:
1. Once as plain-text tiddler fields at the very top of the file (e.g. `title: ...`, `type: ...`, `module-type: ...`).
2. A second time inside a `/*\` ... `\*/` block comment immediately preceding the JavaScript code.

*(Note: The `created:` and `modified:` fields are not necessary and should be omitted from both the plain-text headers and the comment block metadata).*

**Example Format:**
```javascript
title: $:/Lithic/Widgets/example.js
type: application/javascript
module-type: widget

/*\
title: $:/Lithic/Widgets/example.js
type: application/javascript
module-type: widget

Description of the module goes here.
\*/
(function(){
"use strict";
// Your JS code here
})();
```

# Custom Filter Tiddlers (FilterOps & Advanced Search)

**CONTEXT:**
The user relies on a custom TiddlyTools filter dropdown UI (referred to as `FilterOps`) for quickly accessing saved filters.

**PROBLEM:**
If you create a custom saved filter and place it in a standard namespace (e.g., `$:/lithic/Filters/...`), it will show up in the default Advanced Search but **will not** appear in the FilterOps dropdown. The dropdown explicitly looks for a specific TiddlyTools prefix to build its menu.

**STANDARD OPERATING PROCEDURE:**
When creating or modifying saved filter tiddlers that are meant to be quickly accessible by the user, you MUST place them within the TiddlyTools namespace so they integrate with the custom UI automatically.

1. **Title Prefix**: Must start exactly with `$:/config/TiddlyTools/Filters/`
   - Example: `title: $:/config/TiddlyTools/Filters/All Highlights`
2. **Tags**: Must be tagged with `$:/tags/Filter`
3. **Description**: Include a `description` field which is what will be displayed in the dropdown menu.
   - Example: `description: All Highlights`
4. **Filter**: The actual filter logic goes in the `filter` field.

**Example Tiddler (`*.tid`):**
```yaml
title: $:/config/TiddlyTools/Filters/My Custom Filter
tags: $:/tags/Filter
description: My Custom Filter
filter: [tag[SomeTag]] -[is[system]]
```



# `.lith` Importer / Exporter Type Quirk

**CONTEXT:**
The `.lith` deserializer/importer (`register-lith-extension.js`) automatically injects `type: text/markdown` into any non-system tiddler that lacks an explicit `type` field during import. 

**QUIRK / EDGE CASE:**
The `.lith` exporter does **not** have symmetric logic to strip this out or explicitly mark native `vnd.tiddlywiki` types. This was an intentional decision to keep the exporter lightweight (using the core `tid-tiddler` template).
As a result, if a standard TiddlyWiki tiddler (which implicitly defaults to `vnd.tiddlywiki`) is exported to a `.lith` file, it will be exported without a type field. If that same file is subsequently re-imported, the importer will catch it as a "no-type non-system tiddler" and erroneously convert its type to `text/markdown`.

**STANDARD OPERATING PROCEDURE:**
If you encounter weird formatting issues where standard tiddlers suddenly behave like markdown after being passed through a `.lith` export/import cycle, be aware of this asymmetrical behavior. Do not try to "fix" the exporter with heavy JS macros unless explicitly requested again.

# Syntax Highlighting for Custom Codeblocks (`highlight.js`)

**CONTEXT:**
TiddlyWiki's core `HighlightPlugin` uses the `$:/config/HighlightPlugin/LanguageMappings` dictionary to map Tiddler *MIME types* (e.g., `text/x-python`) to languages for rendering entire tiddlers. 
However, this config dictionary DOES NOT map the identifiers used in Markdown-style codeblocks (e.g., ` ```jspython `).

**PROBLEM:**
If you try to alias a custom codeblock language like `jspython` to `python` by adding it to `$:/config/HighlightPlugin/LanguageMappings`, the core widget will not recognize it and the codeblock will not be highlighted.

**STANDARD OPERATING PROCEDURE:**
To register new codeblock languages or aliases so that ` ```customlang ` is properly styled, you must do it programmatically by hooking into the `highlight.js` engine on startup. 
Create or modify a TiddlyWiki JS startup module (like `wikitext-highlighter.js.tid`) and call `hljs.registerLanguage` or `hljs.registerAliases` directly on the `hljs` object:
```javascript
var hljs = window.hljs || require("$:/plugins/tiddlywiki/highlight/highlight.js");
if (hljs && typeof hljs.registerAliases === "function") {
    hljs.registerAliases('customlang', {languageName: 'existinglang'});
}
```

# TiddlyWiki Macro Pragmas (`\define`)

**CONTEXT:**
TiddlyWiki parses files from top to bottom. Macro definitions (`\define`) and other pragmas (`\rules`, `\whitespace`) are interpreted differently from regular wikitext body elements.

**PROBLEM:**
If you place HTML elements (like a `<style>` block) or normal wikitext *before* or *in between* `\define` statements, the TiddlyWiki parser switches from "pragma mode" to "body mode". Any subsequent `\define` macros will not be parsed as macros, but instead will be rendered directly to the screen as raw text.

**STANDARD OPERATING PROCEDURE:**
All `\define` macros and pragmas MUST be placed at the absolute top of the `.tid` file, consecutively, before any HTML tags, styles, or standard wikitext. If you need to add a `<style>` block or HTML, place it *after* all `\define` blocks have concluded.

# Headless Testing of TiddlyWiki Logic (The Chrome Harness)

**CONTEXT:**
TiddlyWiki filter syntax and widget/action behavior are subtle and under-documented. The built monoliths (`pre.html`, `src/lithic.html`) embed the entire wiki as a JSON tiddler store, and Chrome can boot them headlessly. Empirically validating filter chains and action wikitext this way caught multiple real bugs that reading minified core source alone did not (sortsub operand parsing, `$let` first-element resolution, `$action-setfield` list mangling).

**STANDARD OPERATING PROCEDURE:**
1. **Tools:** Node.js is NOT reliably available in this dev environment. Use Python (`/c/Python313/python.exe`) for scripting and Chrome (`/c/Program Files/Google/Chrome/Application/chrome.exe`) for execution.
2. **Pick a bootable build:** `pre.html` boots fast and embeds the same core (5.4.1) as the current `src/lithic.html` — grep to confirm before trusting it. `assets/blank_no_server.html` is NOT bootable (bare store, no boot machinery). `src/lithic.html` is the monolith Tauri rolls up.
3. **Inject a harness:** write a small Python builder that reads the build HTML, inserts a `<script>` test block immediately before `</body>`, and writes a copy (e.g. `scripts/_test.html`). The harness polls `window.$tw && $tw.wiki && $tw.rootWidget` on a `setInterval` (boot is asynchronous), then runs assertions into a `<pre id="out">` element.
4. **Run it:** `"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --no-sandbox --virtual-time-budget=30000 --dump-dom "file:///.../_test.html"` then extract the `<pre id="out">` text (sed between the `<pre>` tags and strip tags).
5. **Invoke context-menu action wikitext:** `wiki.parseText("text/vnd.tiddlywiki", body).tree` → `$tw.rootWidget.makeChildWidget({type:"widget", children: tree})` → `w.render(container, null)` → recursively walk the tree calling `invokeAction(node, null)` on every widget that exposes it.
6. **Invoke a single action widget directly:** build `{type: "action-listops", attributes: {name: {type:"string", value: ...}}}`. CRITICAL: call `widget.render(host, null)` BEFORE `invokeAction()` — attributes (e.g. `$subfilter`) are only computed in `render()` → `computeAttributes()`/`execute()`. Skipping render silently no-ops the action.

**GOTCHA:** fixtures must be realistic. Alpha-sort tests passed with space-less titles but failed on real data: use bracket-wrapped, space-containing list entries (e.g. `[[6th August 2026@1:40:02.470]]`) and multi-child streams.

# TiddlyWiki Filter & Widget Gotchas (Field-Tested)

**CONTEXT:** all verified empirically against TiddlyWiki 5.4.1 headlessly; several contradict the official docs or common usage.

1. **`sortsub` is broken for field operands.** `sortsub[{!!text}trim[]lowercase[]]` (the documented idiom) evaluates to nothing in 5.4.1 — the operand is parsed as a literal title. Use the `sort` operator directly: `[enlist{!!stream-list}sort[text]]` sorts the input by a field, case-insensitively by default.
2. **`enlist[]` reads its OPERAND, not the input.** To parse the filter's input as a list use `enlist-input[]` — that is why streams writes `enlist{!!stream-list}` (operand form) everywhere, and why conditions must use `[<currentTiddler>get[stream-list]enlist-input[]count[]!match[0]]`.
3. **NEVER write a list field via `$action-setfield` from a filter result.** `$value={{{[enlist<var>]}}}` writes bare titles; TW's list parser treats spaces as separators, so `6th August 2026@1:40:02.470` shreds to `2026@1:40:02.470`. Always use `$action-listops` with `$subfilter` (or `$filter`) — core parses the field via `getTiddlerList` and writes it back via `stringifyList` as `[[bracketed]]` entries that round-trip.
4. **`$action-listops` `$subfilter` semantics:** core prepends `"[all[]] "` to the subfilter, and `[all[]]` with an EMPTY operand is an IDENTITY (returns the input unchanged) — so the subfilter genuinely operates on the parsed list (e.g. `$subfilter="[sort[text]]"` sorts the list in place; `reverse[]` flips it).
5. **Multi-value `$let` variables expose only their FIRST element as the string `value`** (the full array lives in a hidden `resultList`). So `[<children>match<ascending>]` silently compares first elements only — effectively always "equal" for permutations sharing the first item. Compare JOINED strings instead: `$let sorted={{{[enlist{!!stream-list}sort[text]join[|]]}}}` then `[enlist{!!stream-list}join[|]match<sorted>]`.
6. **Use `join[|]` as a list-join delimiter, not `join[,]`** — commas are legal in tiddler titles; `|` is not, and `join[|]` parses fine as an operand (verified).
7. **`has[done]` checks a FIELD; `tag[done]` checks the TAG.** The streams interactive checkbox stores state as the `done` tag — a `has[done]` condition silently never matches.
8. **Avoid literal bracket-prefix operands** like `prefix[[x] ]]` — operand parsing gets ambiguous. Define prefixes as variables (`$vars todo1="[ ] " done1="[x] " num1="<<num>> "`) and use `prefix<todo1>` / `removeprefix<todo1>` — the established streams pattern.
9. **Don't chain `+[op...]` after `~` union alternatives** — attach the chain inside each run: `[<t>removeprefix<done1>addprefix<num1>] ~[<t>removeprefix<done2>addprefix<num1>]`.
10. **`match` compares single strings.** For list-equality, join both sides first (see #5).
11. `removeprefix` / `addprefix` / `prefix` / `then` / `else` / `count` / `reverse` / `first[]` / `is[tiddler]` / `tag[]` are all verified working as expected.

# Streams Context Menu Extension & Streams Internals

**CONTEXT:** the vanilla Streams plugin source is NOT in the repo (fetched at build time via `external.yml`); a reference copy lives at `assets/streams_and_fusion.json` (a JSON array of plugin blobs — each blob's `text` field is itself JSON containing that plugin's tiddlers). Streams-specific patches live in `wiki/local-plugins/lithic-patch-streams/`.

**Adding an item to the nodestream right-click menu** (the Streams context menu — distinct from the standalone generic context-menu plugin):
1. Create a tiddler tagged `$:/tags/streams/contextmenu` with:
   - `sq-contextmenu-name: <menu label>` (shown in the menu)
   - `text:` = the action wikitext (invoked on click; `currentTiddler` is the right-clicked node)
   - OPTIONAL `sq-contextmenu-condition:` = a filter; if it evaluates empty the item is hidden (e.g. `[<currentTiddler>get[stream-list]enlist-input[]count[]!match[0]]` hides on childless nodes). The template override in lithic-patch-streams (`$:/plugins/sq/streams/contextmenu/contextmenu-template`) wraps every item in a conditional `<$list>` with an `else[yes]` fallback, so items without the field remain visible — backward compatible.
2. Operate on children with `[enlist{!!stream-list}is[tiddler]]`; operate on the node itself when childless by branching on `[enlist{!!stream-list}is[tiddler]count[]!match[0]]` with an `emptyMessage` that re-runs the ops on `<<currentTiddler>>`.
3. For multi-target ops use `<$list filter="..." variable="target">` with inner `$let`/`$list` conditionals and `$action-setfield`/`$action-listops`. Widget attributes are computed at RENDER time from pre-click state, so keep per-target transitions free of cross-target dependencies.
4. Reference implementations: `$__lithic_streams_contextmenu_alpha-sort.tid` and `$__lithic_streams_contextmenu_cycle-leadmark.tid`.

**Streams internals worth knowing:**
- The interactive checkbox is `<$checkbox tag="done"/>` (in `$:/plugins/sq/streams/templates/stream-row-body`) — checked state = the **`done` tag** on the child tiddler, not a field.
- The autonumber leadmark is the literal **`<<num>> `** prefix; `$:/lithic/macros/num` renders the node's 1-based position within its parent via `[<currentTiddler>get[parent]get[stream-list]enlist-input[]allbefore<currentTiddler>count[]add[1]]`.
- Leadmark prefix conventions (from `$:/plugins/sq/streams/action-macros`): `todo1="[ ] "`, `todo2="- [ ] "`, `done1="[x] "`, `done2="[X] "`, `done3="- [x] "`, `done4="- [X] "`, `num1="<<num>> "`, plus bullets `- ` / `* `.

# Theme-Responsive Styling (The `<<colour>>` Macro)

**CONTEXT:**
Lithic users frequently switch between light and dark themes (palettes). Hardcoding HEX or RGB colors in styles will break the UI contrast when the theme changes.

**STANDARD OPERATING PROCEDURE:**
When applying custom styling, always use TiddlyWiki's core `<<colour>>` macro to resolve colors dynamically from the active palette, rather than hardcoding static hex colors.

**Common Lithic Palette Variables:**
- `<<colour primary>>`: The main accent color (great for borders, highlights, active states).
- `<<colour background>>` / `<<colour foreground>>`: The base wiki background and text color.
- `<<colour tiddler-background>>`: The background color of standard tiddler frames.
- `<<colour code-background>>`: Very subtle off-background color (great for subtle UI highlights).
- `<<colour muted-foreground>>`: Dimmer text for secondary or inactive information.
- `<<colour selection-background>>`: The highlight color used when selecting text.

**Example Implementation:**
If injecting styles via a `<style>` block in wikitext, you can evaluate the macro directly:
```css
<style>
.my-custom-class {
    background-color: <<colour code-background>>;
    border-left: 2px solid <<colour primary>>;
    color: <<colour muted-foreground>>;
}
</style>
```

# Environment & Workflow Notes

- **No Node.js in this dev environment** (`which node` fails). Python 3.13 lives at `/c/Python313/python.exe`; Chrome at `/c/Program Files/Google/Chrome/Application/chrome.exe`.
- **`pre.html` vs `src/lithic.html`:** `pre.html` is an older build; `src/lithic.html` is the current monolith Tauri rolls up. Both embed core 5.4.1 (verified) — grep to reconfirm before using `pre.html` for validation. `assets/blank_no_server.html` is NOT bootable.
- **Line endings:** repo `.tid` files (and `agents.md`) are CRLF. Editing tools write LF — convert to CRLF BEFORE running `trim.ps1`, and pass ONE file path per `trim.ps1 -Files` invocation.
- **Reading core sources:** every built HTML embeds all plugins as a JSON array inside `<script class="tiddlywiki-tiddler-store" type="application/json">`. Locate the `$:/core` plugin object (the preceding character must be `{`), then `json.loads(core["text"])["tiddlers"]` yields every core module (widgets, filter operators) — far more reliable than grepping minified blobs. A module lives at a key like `$:/core/modules/widgets/action-listops.js`.
