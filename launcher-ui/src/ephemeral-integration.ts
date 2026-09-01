// Ported verbatim from the legacy launcher runtime (launcher-fragments/runtime.js,
// lines 251-640) so local-mode engine mounts keep the Ephemeral code-runner
// integration. Regenerate by re-extracting that block if the legacy launcher changes.

export type EphemeralTiddler = Record<string, string>;

export const EPHEMERAL_INTEGRATION_JSON: EphemeralTiddler[] = [
      {
        "title": "$:/plugins/lithic/ephemeral/action-ephemeral.js",
        "type": "application/javascript",
        "module-type": "widget",
        "text": `/*\\
title: $:/plugins/lithic/ephemeral/action-ephemeral.js
type: application/javascript
module-type: widget

Action widget to run Ephemeral code.
\\*/
(function(){
"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;

// Resolve where to POST a job:
//   self-host   -> the same-origin /ephemeral/api/v1/run path
//   paper-light -> the fastest/nearest bastion advertised in docs/swarm.json
async function _resolveEphemeralEndpoint() {
    var mode = (typeof window !== "undefined" && window.__EPHEMERAL_MODE__) || "self-host";
    if (mode !== "paper-light") {
        return "/ephemeral/api/v1/run";
    }
    var swarmUrls = [
        "https://raw.githubusercontent.com/Xyvir/Ephemeral.exe/main/docs/swarm.json",
        "https://xyvir.github.io/Ephemeral.exe/docs/swarm.json"
    ];
    var bastions = [];
    for (var i = 0; i < swarmUrls.length && bastions.length === 0; i++) {
        try {
            var res = await fetch(swarmUrls[i]);
            if (!res.ok) continue;
            var data = await res.json();
            bastions = (data.bastions || []).filter(function (b) {
                return b && b.url && b.probe !== "failed";
            });
        } catch (e) {
            // try the next mirror
        }
    }
    if (!bastions.length) {
        throw new Error("No bastion server found in swarm.json (paper-light mode)");
    }
    // Fastest/nearest first: lowest recorded probe latency wins.
    bastions.sort(function (a, b) {
        return (a.probe_ms || 999999999) - (b.probe_ms || 999999999);
    });
    var base = bastions[0].url;
    while (base.charAt(base.length - 1) === "/") { base = base.slice(0, -1); }
    return base + "/ephemeral/api/v1/run";
}

class ActionEphemeralWidget extends Widget {
    render(parent, nextSibling) {
        this.computeAttributes();
        this.execute();
    }
    execute() {
        this.code = this.getAttribute("code");
        this.language = this.getAttribute("language") || "bash";
        this.parentTiddler = this.getAttribute("parentTiddler") || this.getVariable("currentTiddler");
    }
    refresh(changedTiddlers) {
        var changedAttributes = this.computeAttributes();
        if(changedAttributes.code || changedAttributes.parentTiddler) {
            this.refreshSelf();
            return true;
        }
        return this.refreshChildren(changedTiddlers);
    }

    async invokeAction(triggeringWidget, event) {
        if (!this.code) return true;
        
        let btn = null;
        if (event && event.target) {
            btn = typeof event.target.closest === "function" ? event.target.closest('.run-jspython-btn') : null;
            if (!btn && event.target.classList && event.target.classList.contains('run-jspython-btn')) btn = event.target;
            if (btn) btn.classList.add("ephemeral-running");
        }
        
        try {
            // Ephemeral parses Markdown documents, so retain an explicit shebang
            // exactly as supplied (it overrides the fence language), and otherwise
            // wrap the code in a language-labelled triple-backtick block. This is
            // the same contract used by the self-hosted/local API client.
            const code = String(this.code).replace(/^\uFEFF/, "");
            const hasShebang = /^\s*#!/.test(code);
            const markdownPayload = hasShebang
                ? code
                : "\\\`\\\`\\\`" + this.language + "\\n" + code + "\\n\\\`\\\`\\\`";
            const utf8str = new TextEncoder().encode(markdownPayload);
            let binary = '';
            for (let i = 0; i < utf8str.byteLength; i++) {
                binary += String.fromCharCode(utf8str[i]);
            }
            const base64code = window.btoa(binary);
            
            const endpoint = await _resolveEphemeralEndpoint();
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ document_blob: base64code, timeout: 300 })
            });

            // Surface HTTP errors instead of silently swallowing them: the
            // bastion answers 422 with {"detail": "..."} when a job cannot be
            // run (e.g. orchestration-only bastion with no peer holding the
            // required image warm). Before, the error body was parsed and
            // discarded, so a failed run looked like it did nothing.
            let data = null;
            try {
                data = await response.json();
            } catch (parseErr) {
                data = null; // non-JSON error body — fall through to status handling
            }
            if (!response.ok) {
                const detail = (data && typeof data.detail === "string" && data.detail.trim())
                    ? data.detail
                    : ("HTTP " + response.status + ((data && data.error) ? " - " + data.error : ""));
                throw new Error("Ephemeral API returned HTTP " + response.status + ": " + detail);
            }
            if (!data) data = {};

            if (data.stderr && data.stderr.trim()) {
                console.warn("Ephemeral API Stderr:", data.stderr);
            }
              if (data.stdout && data.stdout.trim()) {
                const childTitle = $tw.wiki.generateNewTitle(this.parentTiddler + "/stdout");
                
                if (data.artifact_ext) {
                    const ext = data.artifact_ext.toLowerCase();
                    if (ext === ".svg") {
                        $tw.wiki.addTiddler(new $tw.Tiddler({
                            title: childTitle,
                            text: data.stdout,
                            type: "image/svg+xml",
                            parent: this.parentTiddler,
                            "stream-type": "default"
                        }));
                        this.appendToStream(this.parentTiddler, childTitle);
                    } else if (ext.match(/^\.(png|jpe?g|webp|gif)$/)) {
                        const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
                        const dataUri = "data:" + mime + ";base64," + data.stdout.trim();
                        
                        const img = new Image();
                        img.onload = () => {
                            const payload = this.generateWhiteboardData([{
                                filename: "artifact" + ext,
                                dataUri: dataUri,
                                width: img.width,
                                height: img.height
                            }]);
                            
                            const wbTitle = $tw.wiki.generateNewTitle(this.parentTiddler + "/artifact-wb");
                            
                            $tw.wiki.addTiddler(new $tw.Tiddler({
                                title: wbTitle,
                                text: JSON.stringify(payload),
                                type: "application/tldr"
                            }));
                            
                            $tw.wiki.addTiddler(new $tw.Tiddler({
                                title: childTitle,
                                text: "<<wb-image \\"[[" + wbTitle + "]]\\" \\"80%\\">>",
                                type: "text/vnd.tiddlywiki",
                                parent: this.parentTiddler,
                                "stream-type": "default"
                            }));
                            this.appendToStream(this.parentTiddler, childTitle);
                        };
                        img.src = dataUri;
                    } else if (ext === ".csv") {
                        $tw.wiki.addTiddler(new $tw.Tiddler({
                            title: childTitle,
                            text: data.stdout,
                            type: "text/csv",
                            parent: this.parentTiddler,
                            "stream-type": "default"
                        }));
                        this.appendToStream(this.parentTiddler, childTitle);
                    } else {
                        $tw.wiki.addTiddler(new $tw.Tiddler({
                            title: childTitle,
                            text: data.stdout,
                            type: "text/plain",
                            parent: this.parentTiddler,
                            "stream-type": "default"
                        }));
                        this.appendToStream(this.parentTiddler, childTitle);
                    }
                } else {
                    $tw.wiki.addTiddler(new $tw.Tiddler({
                        title: childTitle,
                        text: data.stdout,
                        type: "text/x-markdown",
                        parent: this.parentTiddler,
                        "stream-type": "default"
                    }));
                    this.appendToStream(this.parentTiddler, childTitle);
                }
            }
            
            if (data.artifact_file && (!data.artifact_ext || data.artifact_ext === ".zip")) {
                const artifactUrl = '/sync/ephemeral/' + encodeURIComponent(data.artifact_file);
                const a = document.createElement("a");
                a.href = artifactUrl;
                a.download = data.artifact_file;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }
            
        } catch (e) {
            console.error("Ephemeral API Error:", e);
            const errTitle = $tw.wiki.generateNewTitle(this.parentTiddler + "/error");
            $tw.wiki.addTiddler(new $tw.Tiddler({
                title: errTitle,
                text: "❌ **Ephemeral API Error:**\\n\\n\\\`\\\`\\\`\\n" + e.toString() + "\\n\\\`\\\`\\\`",
                type: "text/x-markdown",
                parent: this.parentTiddler,
                "stream-type": "default"
            }));
            this.appendToStream(this.parentTiddler, errTitle);
        } finally {
            if (btn) btn.classList.remove("ephemeral-running");
        }
        
        return true;
    }
    
    appendToStream(parentTitle, childTitle) {
        var parent = $tw.wiki.getTiddler(parentTitle);
        var list = parent ? ($tw.utils.parseStringArray(parent.fields["stream-list"]) || []) : [];
        if (!list.includes(childTitle)) {
            list.push(childTitle);
            $tw.wiki.addTiddler(new $tw.Tiddler(parent, {"stream-list": $tw.utils.stringifyList(list)}));
        }
    }
    
    generateUUID() {
        if (typeof crypto !== "undefined" && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    generateWhiteboardData(images) {
        const documentId = "doc";
        const pages = {};
        const assets = {};
        const pageStates = {};

        images.forEach((img, index) => {
            const i = index + 1;
            const uuidAsset = this.generateUUID();
            const uuidShape = this.generateUUID();
            const uuidPage = i === 1 ? "page" : this.generateUUID();

            pages[uuidPage] = {
                id: uuidPage,
                name: \`Page \${i}\`,
                childIndex: i,
                shapes: {},
                bindings: {}
            };

            assets[uuidAsset] = {
                id: uuidAsset,
                type: "image",
                fileName: img.filename,
                src: img.dataUri,
                size: [img.width, img.height]
            };

            pages[uuidPage].shapes[uuidShape] = {
                id: uuidShape,
                type: "image",
                name: "Image",
                parentId: uuidPage,
                childIndex: 1,
                point: [0, 0],
                size: [img.width, img.height],
                rotation: 0,
                style: {
                    color: "black",
                    size: "small",
                    isFilled: false,
                    dash: "draw",
                    scale: 1
                },
                assetId: uuidAsset,
                isLocked: true
            };

            const sidebarMargin = 0; 
            const topMargin = 50;
            const viewerWidth = 1200;
            const isPortrait = img.height > img.width;

            let zoom, viewerHeight;
            if (isPortrait) {
                zoom = 0.75;
                viewerHeight = 1056; 
            } else {
                viewerHeight = 540;
                zoom = Math.min(
                    (viewerWidth - sidebarMargin) / img.width,
                    (viewerHeight - topMargin) / img.height,
                    1
                );
            }

            pageStates[uuidPage] = {
                id: uuidPage,
                selectedIds: [],
                camera: {
                    point: [sidebarMargin / zoom, topMargin / zoom],
                    zoom: zoom
                }
            };
        });

        return {
            document: {
                id: documentId,
                name: "PDF Canvas",
                version: 15.5,
                pages: pages,
                pageStates: pageStates,
                assets: assets
            }
        };
    }
}

exports["action-ephemeral"] = ActionEphemeralWidget;
})();`
      },
      {
        "title": "~$:/plugins/lithic/ephemeral/codeblock-override",
        "tags": "$:/tags/Global",
        "text": `\\widget $codeblock(code, language)
<div class="wilk-copy-code-button">
	<$list filter="[<language>match[jspython]]" variable="ignore">
		<$button tooltip="Run Code" class="tc-btn-invisible run-jspython-btn">&gt;_
			<$set name="consoleTiddler" value={{{ [<currentTiddler>addsuffix[/console]] }}}>
				<$action-jspython code=<<code>> outputTiddler=<<consoleTiddler>> />
				<$action-listops $tiddler=<<currentTiddler>> $field="stream-list" $subfilter="[<consoleTiddler>]" />
				<$action-setfield $tiddler=<<consoleTiddler>> parent=<<currentTiddler>> />
			</$set>
		</$button>
	</$list>
	<$list filter="[<language>!match[jspython]]" variable="ignore">
		<$button tooltip="Run on Ephemeral API" class="tc-btn-invisible run-jspython-btn">&gt;_
			<$action-ephemeral code=<<code>> language=<<language>> parentTiddler=<<currentTiddler>> />
		</$button>
	</$list>
	<$button
	message="tm-copy-to-clipboard"
	param=<<code>>
	tooltip="Copy"
	class="tc-btn-invisible">
		{{$:/core/images/copy-clipboard}}
	</$button>
	<$genesis $type="$codeblock" $remappable="no" code=<<code>> language=<<language>>/>
</div>
\\end`
      },
      {
        "title": "$:/plugins/lithic/ephemeral/styles.css",
        "tags": "$:/tags/Stylesheet",
        "type": "text/vnd.tiddlywiki",
        "text": `
@keyframes ephemeral-bob {
    0% { transform: translateY(0px); color: <<colour foreground>>; }
    50% { transform: translateY(-3px); color: <<colour primary>>; }
    100% { transform: translateY(0px); color: <<colour foreground>>; }
}
.ephemeral-running {
    animation: ephemeral-bob 1s infinite ease-in-out !important;
}
`
      }
    ];
