# Editing Remote WebDAV Files Provided via extension Context

**CONTEXT:**
When a USER provides a remote WebDAV file as context via the VSCode extension, it appears as an active document URI looking somewhat like this:
`webdav://<user>:<password>@<domain.app>/<filename>?ssl=1&base=<basepath>/`
*(Example: `webdav://xyvir:Dunko*fiver*555*@lithic-uk-production.up.railway.app/SP26_TM.lith?ssl=1&base=sync/`)*

**PROBLEM:**
1. Built-in file system tools (`view_file`, `replace_file_content`, etc.) cannot natively read or write `webdav://` absolute paths.
2. The remote `.lith` files are often too large (e.g. 7MB+) for the agentic code editing tools' size limits (4MB limit). 

**SOLUTION / STANDARD OPERATING PROCEDURE:**
To view or modify these files, you *must* interact directly with the WebDAV HTTPS endpoint using your command shell (`curl`), circumventing typical local file APIs.

### 1. Formulating the Request
Extract the credentials and path structure from the `webdav://` URI.
- Authentication string: `-u "<user>:<password>"`
- Target URL: `https://<domain.app>/<basepath>/<filename>`

### 2. Reading Contents
To read the original file (if it's not cached locally or is too large to load in an editor payload):
Use PowerShell / cmd `curl` to fetch. Keep in mind Windows PowerShell pipes might terminate early (`Exit Code 1`) when piping to `Select-Object`, but the output is still viable.
```powershell
curl.exe -s -u "<user>:<password>" "https://<domain.app>/<basepath>/<filename>" | Select-Object -First 20
```

### 3. Editing and Appending (Overcoming File Size Limits)
For files too large for standard code-editing tools:
1. Download a complete local copy to a temporary directory (e.g. `C:\scratch\<filename>`).
   ```powershell
   curl.exe -s -u "<user>:<password>" "https://<domain.app>/<basepath>/<filename>" -o C:\scratch\<filename>
   ```
2. Create the appended content (or perform edits/replacements) using `write_to_file` on a standard `C:\scratch\temp.txt` file. 
3. Perform the concatenation or replacement at the shell level.
   ```cmd
   cmd.exe /c "type C:\scratch\temp.txt >> C:\scratch\<filename>"
   ```
4. Upload the modified file back to the server using the HTTP PUT (`-T`) method in `curl`.
   ```powershell
   curl.exe -s -u "<user>:<password>" -T C:\scratch\<filename> "https://<domain.app>/<basepath>/<filename>"
   ```
   
*(Ensure to clean up `scratch/` files after successful upload to prevent leaving lingering copies).*

### What is a `*.lith` File?
A `.lith` file is an extension of the vanilla TiddlyWiki `*.tid` file format, which is based on an HTTP RFC format for headers and body.

**Key differences and requirements for `.lith` formats:**
1. It supports multiple tiddlers appended together within a single file.
2. The **triple-asterism** (`⁂⁂⁂`) is used as a strict delimiter to separate each individual tiddler inside the file. Do NOT use standard asterisks.
3. The `title` field is explicitly required for each tiddler entry within the file.

# TiddlyWiki JS Plugin File Format (`*.js.tid`)

**CONTEXT:**
When creating or editing JavaScript plugins, macros, or startup modules in TiddlyWiki via `.js.tid` files, the boot parser requires a specific dual-header format to function correctly. 

**PROBLEM:**
If a `.js.tid` file is missing the leading plain-text frontmatter, or missing the `/*\` comment block, the TiddlyWiki boot sequence will crash with a `Syntax error in boot module` or `Unexpected identifier` error. The core `$tw.boot` system reads the `/*\` block to extract module metadata *before* the main parser is loaded.

**STANDARD OPERATING PROCEDURE:**
Every `.js.tid` file MUST contain the module metadata **twice**:
1. Once as plain-text tiddler fields at the very top of the file (e.g. `title: ...`, `type: ...`, `module-type: ...`).
2. A second time inside a `/*\` ... `\*/` block comment immediately preceding the JavaScript code.

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
