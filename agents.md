
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


