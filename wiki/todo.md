## Todo



## launcher.html modularization Project
- [x] Allow specifying 'modes' via http parameters so the launcher monolith html can be forced into specific modes to make unit tests easier; (all unit tests can be performed in 1 test environment this way, but with multiple test profiles/users)
    - (Done: `launcher-ui/src/mode.ts` honors `?mode=`, `?launcher-mode=`, `?launcher_mode=`)
- [ ] Create unit tests for all lithic.html and launcher.html UI elements, logic and functions
    - (In progress: 42 launcher-ui unit tests + puppeteer smoke + pre-launcher smoke)
    - [ ] this can also intercept bad manual builds and prevent them from pushing 'bad' releases.
- [ ] Modularize launcher.html into separate javascript / html / css files
    - [x] begin modularizing launcher.html and test packaging into prelauncher.html
        - (Svelte launcher builds to `src/pre-launcher.html` via `scripts/build-pre-launcher.mjs`)
    - [ ] once all unit tests pass, update the build-wiki to package launcher.html into the build
    - [ ] archive original launcher.html and begin using new modularized build process moving forward.
- [ ] Move "install app" button on mobile UI only to be next to the 'clear cache' button.
- [ ] Add git history rollback UI/widget to online sync modal. (this should theoretically work for the local git instance even if not synced to github)
- [ ] Make sure the custom.ico is actually saved to GitHub so restoring the GitHub will restore your disambiguation / icon

### Launcher parity (Svelte `pre-launcher.html` vs legacy `launcher.html`) — webapp/local mode

Tracked per-fragment in `launcher-ui/src/legacy-fragments.ts`; statuses are asserted by `fragment-parity.test.ts`.

- [x] Modes via http params (`?mode=` etc.) and environment detection
- [x] Local saver / Save As (File System Access API) + IndexedDB recent files + search cache + cached-history download
- [x] Bookmarks with manifest.json verification of self-host instances
- [x] Pending imports: drag-and-drop `.lith`/`.json`, dropped share URLs, `?json=`/`?lith=`/`?url=` payload injection, pending-imports window
- [x] Intro payload link (fetches `intro.lith` → boots a fresh wiki; offline fallback opens `lithic.uk/intro.html`)
- [x] Ephemeral code-runner integration injected on every local mount (`ephemeral-integration.ts`, byte-identical to legacy)
- [x] HTML monolith mounting (`.html`/`.htm` opened directly as a complete wiki page)
- [x] PWA head (manifest/favicon/theme-color) + `/offline-service-worker.js` registration + `__EPHEMERAL_MODE__` global
- [ ] WebDAV / self-host mode (`runtime.webdav`, remote file listing, locks, GitHub sync modal, emoji picker) — deferred, next milestone
- [ ] Tauri mode — deferred
- [ ] `document.bootstrap` original-path rewrite — deployment glue, still extracted

## Post Modularization Todo
- [ ] update pdf-to-whiteboard plugin to convert svgs into editable "native whiteboards" maintaining individual objects?
- [ ] Create self-destroying /anchor option based on <<stamp>> macro, maybe even super-ceding stamp?
	-I'm making this too complicated, just create a new tiddler and use slashcommands to fill in a re-usable todo template. (This is literlaly it's use case) Maybe I should make a workflow to save convert existing content as a new slashcommands though.

- [ ] Create/Integrate EPUB Serialization based on current to_lithic logic (but have user provide shortcode instead of AI-generated one); add it to existing pdf-to-whiteboard and name the plugin 'lithic-import' or something.
- [ ] make links and transclusions in uni-editor edit-mode clickable and hover-able (appear plugin)
- [ ] Add hotzone for sidebar to autoopen/closen on mouseover?
    (this is mostly for when exporting static HTML sites)
- [ ] Add custom feedback UI (especially for selfhost) for when save button is clicked but before the save confirmation modal appears.
    (Currently, save actions are silent until the confirmation modal appears. The UI should give immediate feedback that the action has been registered and is being processed, particularly for large wikis where the save operation may take a few seconds.)
- [ ] Remove extraneous newlines created when using embed-streams macro.

- [ ] add ## 'toggle button' to unieditor line numbers on line 00; that globally toggles the numbers on and off. (via state tiddler?)
	- add to lithic settings for default on-load behavior? (but toggleable while interactive)

- [X] Add special "Lithic Settings" Sidebar menu item that only appears when Tweak Sidebar is active, below the 'hidden' sidebar items; and has a handful of lithic-specific configuration options. Specifically limited. (maybe 10 max?)
    - option to include/not include 'base' shadow tiddlers in Query sidebar.
    - Default Backlink pill cloud state (expanded/collapsed)
    - Disable/enable hover-over expand (for sidebar, and backlink clouds, and maybe collapsed nodeparents)
    - Default code line-number starting state (on or off)
    (if user wants more customization then can navigate to the vanilla TW control panel via Commands; or via a "Advanced Settings" link in the Lithic Settings menu?)
    - option to completely disable / enable the non-recommended Browse and Commands sidebar items.

- [ ] Integrate spaced repetition / flashcard review into Lithic?
    - Candidates: pdeck, twsr (unmaintained). TidMe is too heavyweight as a full edition. Deafult or add as 'official' plugin.
    - Goal: lightweight integration that works within the streams experience (e.g., sidebar review tab, slashcommand to create cards from highlights).
    - Maybe encorporate into whiteboard instead (as it is more visual)
    - Create a mechanism to easily print the flashcards as well

- [ ] JsxGraph plugin? (I believe updated mermaidgraph supports x/y plot so this is redundant)
     Deafult or add as 'official' plugin?
- [ ] Add additional parameter to AutoTable widget that allows for prefilled content per column? 
    - <<AutoTable "One Two Three" "- - {formula}">>
    - dash here is a placeholder for no prefilled content.
- [x] Create simpleUI TW plugin for Lithic (Lithic Patina)
    - [ ] Include backdoor "edit mode" toggle (secret hotkey / 5-tap on wiki title to unlock editing)
    - [ ] Clean up all reference to TW lingo in 'main' UI.
        - Backdoor action enabled by default, but add config tiddler to "disable unlock action"
    - [X] Hide alternate storyview options (zoomin, etc.) in Patina mode

- [ ] Expansions to tldraw
    - [ ] Create hotzone macro
    - [ ] "draw over time" animation
    - [ ] "typewriter" animation
    - [ ] Add "view frame" background item to DefaultCanvas
    - [ ] Create parallel layout for "Presentation Mode" that is non-editable and can navigate forward/back between whiteboard pages; with the above animations as toggleable options

- [ ] When multiple images are drag-and-dropped simultaneously, serialize them into a single multi-page whiteboard (like PDF import) instead of individual whiteboard objects.

- [ ] Test preserving existing 'rendered height' on unieditor when editing existing nodes/blocks. (IE images which are generally much taller than their sourcecode) Having the viewport jump around in response to editing text can be jarring. (which is the default behavior in logseq but is worth reviewing.)
- [ ] Simple mobile Camera OCR import as text capture feature?

- [ ] Revisit iframe-based web app embedding plugins (Treevis, Falstaad, etc.) Tiddlytools Webtools)

- [ ] Pyramid expansion
    - [ ] Rename to "Treeview"?
    - [ ] Add "depth" field ie depth:3 that modifies how far the "Pyramid" sidebar view shows children.
    - [ ] add Guardarles for 'too wide' views/ TIddler titles? (Capital Letters in nodes or something)
    - [ ] Pull displayname from caption: field if avaiailable
    - [ ] Add togglable full "story river" mode
        - (currently limited to showing treeview for tiddler at top of story river.)
        - This will act as a sort of 'ad-hoc' graph in place of the 'global graph' features of other PKMS; but it's more ideologically more focused.
    - [ ] Add smart behavior for tiddlers that have prev / next fields (like showing the corresponding pyramids the sidebar)

- [ ] "Deep copy" transclusions on single tiddler exporter, or automatic transclusion inclusion on multi tiddler exporter? (implicit standalone exports)

- [ ] Add a whiteboard button that transcludes a parent's stream-list nodes as paginated stickynotes on a whiteboard. (Pre-presentation creation)
    - Highest level nodes are pages and their children are individual stickynotes on that page.

- [ ] Create "Official" Lithic plugin store for Lithic-specific plugins/extensions.
    - [ ] circuitJS
    - [ ] "Lithic Native" Treevis / Chesstree implementation
    - [ ] text-based adventure game plugin
    - [ ] Audio Editor/podcast plugin from talk.tiddlywiki.
    - [ ] Dogreader?
    - [ ] Card deck creation plugin/tool?

- [ ] Create external "Lithic Reference Wiki" with template/snippet library for anchors and saved filters.
    - Browsable anchor templates with inline previews; users drag-and-drop desired templates into their own wiki.
    - Include example dashboard filters (weekly review, overdue todos, recently modified, orphan detection) as importable FilterOps presets.
- [ ] "Zen mode" / focus mode: leverage vanilla TW edit experience as a long-form fullscreen writing mode.
    - Hide sidebar, center content. Could be a simple CSS toggle or a dedicated layout.

- [ ] Automate lithic-light build process (including TW Uglifier) and merge in esp32-launcher repo into this one.
- [ ] Add agents.md to back-end server if anyone wants to clone the github sync in their own LLM-IDE.
- [ ] Greatly improve existing intro.lith to capture ALL current features and workflows.
- [ ] Create "Lithic for Teams" backend version based on Multi-Wiki Server.

- Tauri App Ideas:
    - [ ] Add 'run code' button next to copy code that hooks into ephemeral.exe
    - [ ] Allow file associations for *.txt; *.py, *.md etc so it can act as a lightweight text editor for local files.
    - [ ] Iroh P2P Sync
- [ ] Add local 2fa totp for backend wiki access?
    - Maybe just suggest cloudflare tunnels for this instead. Or only include in `lithic-teams` or desktop apps
- [ ] "zoomin" doesn't play nice with Dynaview; so we need to update the storyriver viewfilter to fallback to 'normal' when using "zoomin"
- [ ] create some static "preview blocks" when lithic public share links are used elsewhere (discord, github, etc.) so the link has some visual cues and doesn't just show up as a ugly broken block.
---

## Done

- [x] hardbreak vs horizontal rule standardizations:
	hardbreaks is my term for markdown ---\n--- (double hr) this forces pagebreaks on PDF prints, newcolumns in multicolumn layout, and should also be content deviders on anchors with prefill spawn.
	- [x] update /anchor to use double --- --- instead of single --- for header vs pre-filled content, so the content can include single <hr> (also brings into alingment with column and pagebreaks)
	- [x] update slashcommands for /hrule `---` vs /hardbreak `---\n---`
- [X] include 'prettylinks' ?
- [x] Extend hover-over 'appear' plugin behavior to be more intuitive
    - [x] modify behavior to show todo when highlighting calendar datelinks
    - [x] Fix the alignment  when sidebar open.
    - [ ] add  size guardrails so only a bit of context is shown on hoverover.
- [x] Allow double-bullet (`-` or `*` prefix) nodestream entries to create date/calendar highlights, not just `[ ]` / `[x]` todo items.
    (Currently only `- [ ] foobar [[date]]` / `- [x] foobar [[date]]` / `[x] foobar  [[date]]` / `[ ] foobar  [[date]]` highlight the calendar sidebar. This would also recognize `- foobar [[date]]` and `* foobar [[date]]` for non-task journal title references to higlight the associated date on the calendar.)
- [X] add 'skinny mode' (inline) to weevkiew for portrait orientatino on mobile.
- [X] Add "reveal" / collapse element to backlink pill clouds; always open by default(but configurable), tracked via state tiddlers that are not saved when the wiki is?
- [x] Add proper print styling to Autotable Macros in printstyles.css
- [x] For both right-click menus, add guardrails so they 'invert' near screen edges so menu never goes out of view.
- [X] auto-select/focus Queries searchbox when Queries sidebar is expanded.
- [X] Add special macro that can define a print percentage for a particular node/tiddler. (only effects print scale)
- [X] Super-cede Dogear bottompill navigation with Favorites[] tag? (remove Dogear tag entirely?)
- [X] Add a Permanent "Navigation" (bookmark) Tiddler area that appears at the top of the sidebar that tiddlers can be 'pinned' to. (it also 'highlights' if it recognizes the story river exactly matches one of the items)
    (Add contextual "Favorites" (with no header)" area in / above the sidebar populated by any of the following tagged Navigation: 1. Saved Queries. 2. Nodestream Parents. 3. Individual Tiddlers. These can be 'sorted' by tag order? (like elsehwere in tiddlywiki) and items can be added to or removed via drag and drop, and sorted via drag and drop; Also these cannot be edited/moved if the wiki is in 'non-edit' mode.)
    - Clicking on these items/links will close everything in the story river and only open the tiddler, save query, or nodestream parent tiddler.
    - The section appears completely 'empty' initially but is stil drag and droppable if you move a wiki in the area between the title and sidebar items.
    - Going to be called Favorites (with star iconography) A permanently-appearing section below the title but above the sidebar tools. (also below 'search' on mobile sidebar UI)
    - Replace tiddlytools "pin" TiddlerToolbar button with a toggable "star" that adds the "Favorite" tag and puts it in the Favorites area. (No "Pin to Sidebar" button, just a "Favorite" toggle). Use star icon instead of pin icon.
    - Topmost favorite automatically has "Dogear" tag added so it appears top of story-river on wiki-load/home.
- [X] New builds mistakenly have context-menu as an over-written shadow tiddler; is it a malformed plugin?
- [x]Make sidebar Wiki Title and subtitle editable via double-clicking (similar to how stream nodes are already)
- [X] Add "Copy All Plaintext" button to page control (or Open sidebar?) for Storyriver markdown export or to give AI context. (There is a smaller merge stream plugin that already does this???) (https://talk.tiddlywiki.org/t/buttons-to-merge-streams/14957/4)
- ~~Embed-wb-text macro? (Shelved — transclusions into whiteboards already cover this use case)~~
- [x] With Lithic custom importer, on custom import finish automatically copy linked references i.ie [[tiddlername]] to the clipboard for the list of import items.
- [X] Add "apply anchor template" filtered UI widget dropdownsearch to stub view / placeholder tiddlers.
- [X] Improve anchors behavior and workflow.
- [X] add copy button to Pyramid sidebar that copies the rendered mermaid code for further embedding / editing / extending.
- [X] Further Extensions to tw-whiteboard; import all images as whiteboard embeds moving forward.
- [X] Add some kind of filter/builder UI or filter slashcommand autocompletes that integrates with FilterOps. 
    (Adding multi-column reference cheatsheet tiddler)
- [x] rearrange icon order on filterops to be more intuitive.
- [X] have some kind of logical 'prefill' on filterops. (all notes?)
- [X] Modify behavior to use <<embed-stream>> macro on parent stream-nodes that do not have their own body.
- [X] Limit hover-over so it doesn't appear on search query result links, etc.
- [X] Make sure all custom lithic-macros accept "[[Tiddler Title]]" syntax parameters and tweak to make sure they work appropriatly with comp-text plugin/ slashcommands.
- [X] Replace the regular searchbox in notebook UI with byper "Advanced Search" also extend it a bit to allow searching shadow tiddlers etc?
- [X] include textcolumns or similair plugin:
    https://br-text-columns.tiddlyhost.com/
- [X] Add a viewfilter or something so transcluded nodestream parents show their children?
    - Just handle by embed-stream macro for now.
- [X] Freeze external plugin integrations once I'm happy with the base featureset. (currently only bypersearch and columns are candidates)
- [X] Create some way to disambiguate if someone wants to self-host multiple backends for different groups of wikis.
- [X] Context Menu Expansions

    - [X] Add "Toggle Prefix" option to one of the right-click menus. (including option <<num>> prefix?)
        - [ ] Add toggle-prefix hotkey like logseq?
    - [X] Add "Alpha Sort" option to nodestream right-click menu.
       (Do twice to toggle ascending/descending)

- [X] "Favorites" sidebar area vertical linespacing is not the same in tweak vs use mode, need to align these so the favorites don't visually shift on tweak mode toggle.