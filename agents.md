
# Missing Source Context (IMPORTANT)

**CRITICAL RULE FOR ALL AGENTS:**
If you need source context that is NOT available locally within this repository (such as vanilla TiddlyWiki core files or external third-party plugins), **DO NOT** attempt to find or download it yourself. Instead, you MUST explicitly **ASK THE USER (THE DEVELOPER)** to provide the relevant context manually. 

### What is a `*.lith` File?
A `.lith` file is an extension of the vanilla TiddlyWiki `*.tid` file format, which is based on an HTTP RFC format for headers and body.

**Key differences and requirements for `.lith` formats:**
1. It supports multiple tiddlers appended together within a single file.
2. The **triple-asterism** (`⁂⁂⁂`) is used as a strict delimiter to separate each individual tiddler inside the file. Do NOT use standard asterisks.
3. The `title` field is explicitly required for each tiddler entry within the file.

---

### What is a `*.lith` File?
A `.lith` file is an extension of the vanilla TiddlyWiki `*.tid` file format, which is based on an HTTP RFC format for headers and body.

**Key differences and requirements for `.lith` formats:**
1. It supports multiple tiddlers appended together within a single file.
2. The **triple-asterism** (`⁂⁂⁂`) is used as a strict delimiter to separate each individual tiddler inside the file. Do NOT use standard asterisks.
3. The `title` field is explicitly required for each tiddler entry within the file.
4. The `created:` and `modified:` front matter items are not necessary and should be omitted to save space.

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

# `.lith` Importer / Exporter Type Quirk

**CONTEXT:**
The `.lith` deserializer/importer (`register-lith-extension.js`) automatically injects `type: text/markdown` into any non-system tiddler that lacks an explicit `type` field during import. 

**QUIRK / EDGE CASE:**
The `.lith` exporter does **not** have symmetric logic to strip this out or explicitly mark native `vnd.tiddlywiki` types. This was an intentional decision to keep the exporter lightweight (using the core `tid-tiddler` template).
As a result, if a standard TiddlyWiki tiddler (which implicitly defaults to `vnd.tiddlywiki`) is exported to a `.lith` file, it will be exported without a type field. If that same file is subsequently re-imported, the importer will catch it as a "no-type non-system tiddler" and erroneously convert its type to `text/markdown`.

**STANDARD OPERATING PROCEDURE:**
If you encounter weird formatting issues where standard tiddlers suddenly behave like markdown after being passed through a `.lith` export/import cycle, be aware of this asymmetrical behavior. Do not try to "fix" the exporter with heavy JS macros unless explicitly requested again.
