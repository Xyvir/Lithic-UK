/**
 * scripts/mirror.js (Lithic - Disposable Root)
 * * Plugins -> wiki/external
 * * Tiddlers -> wiki/tiddlers (Wiped and rebuilt every run)
 */

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const yaml = require('js-yaml');

// --- CONFIGURATION ---
const CONFIG_FILE = 'external.yml';
const LOCK_FILE = 'external-lock.json'; // Updated for consistency

const EXTERNAL_DIR = path.join('wiki', 'external');
const TIDDLERS_DIR = path.join('wiki', 'tiddlers');

// 1. Load Config
if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`❌ ERROR: Could not find ${CONFIG_FILE}`);
    process.exit(1);
}

let sources;
try {
    sources = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (e) {
    console.error(`❌ ERROR: Invalid YAML: ${e.message}`);
    process.exit(1);
}

// 2. Prepare Directories
if (!fs.existsSync(EXTERNAL_DIR)) fs.mkdirSync(EXTERNAL_DIR, { recursive: true });

// WIPE TIDDLERS COMPLETELY (Since Lithic code is in /plugins)
if (fs.existsSync(TIDDLERS_DIR)) {
    console.log(`🧹 Wiping ${TIDDLERS_DIR} for a clean build...`);
    fs.rmSync(TIDDLERS_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TIDDLERS_DIR, { recursive: true });

let lockData = {};
if (fs.existsSync(LOCK_FILE)) {
    lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
}

// Helper: Get Remote Headers
function getRemoteInfo(url) {
    try {
        const headers = execSync(`curl -s -I -L "${url}"`).toString();
        const etagMatch = headers.match(/etag:\s*"?([^"\r\n]+)"?/i);
        const dateMatch = headers.match(/last-modified:\s*([^\r\n]+)/i);
        return {
            etag: etagMatch ? etagMatch[1] : null,
            lastModified: dateMatch ? dateMatch[1] : null
        };
    } catch (e) { return null; }
}

const logPath = path.join(__dirname, '../wiki/mirror.log');
let logContent = `--- Mirror Log ${new Date().toISOString()} ---\n\n`;

function log(msg) {
    console.log(msg);
    logContent += `${msg}\n`;
}

function errorFromLog(msg) {
    console.error(msg);
    logContent += `[ERROR] ${msg}\n`;
}

log(`Starting Mirror (External Mode)...`);
let changesMade = false;
let failedDownloads = 0;

sources.forEach(source => {
    if (source.type === 'disable') return;

    log(`\n--- Processing: ${source.name} ---`);
    const targetDir = path.join(EXTERNAL_DIR, source.name);

    // --- CHECK UPDATE ---
    const remoteInfo = getRemoteInfo(source.url);
    const lockEntry = lockData[source.name];

    // The lockfile caches the REMOTE revision (etag/last-modified), not the
    // local artifacts: wiki/external and wiki/tiddlers are gitignored merge
    // caches. A fresh checkout has an empty cache, so "lockfile matches" alone
    // must NEVER skip a download — CI would build from zero plugins (seen in
    // CI: every external plugin 'Cannot find', empty build output).
    // Fresh = remote revision matches lockfile AND the local artifact exists
    // and is non-empty.
    const isJsonPluginSource = source.type === 'json-plugin';
    const localArtifact = isJsonPluginSource
        ? path.join(TIDDLERS_DIR, `${source.name}.json`)
        : targetDir;
    let hasLocalArtifact = false;
    if (fs.existsSync(localArtifact)) {
        const st = fs.statSync(localArtifact);
        hasLocalArtifact = st.isDirectory()
            ? fs.readdirSync(localArtifact).length > 0
            : st.size > 0;
    }

    let isFresh = false;
    if (hasLocalArtifact && lockEntry && remoteInfo) {
        if (remoteInfo.etag && remoteInfo.etag === lockEntry.etag) isFresh = true;
        else if (remoteInfo.lastModified && remoteInfo.lastModified === lockEntry.lastModified) isFresh = true;
    }
    if (lockEntry && remoteInfo && !hasLocalArtifact) {
        log(`📥 Local cache empty (fresh checkout?) — re-fetching despite lockfile match.`);
    }

    if (!isFresh || source.force) {
        log(`🔄 Updating source...`);
        const isJsonPlugin = source.type === 'json-plugin';
        const isZip = source.url.toLowerCase().endsWith('.zip');
        const ext = isJsonPlugin ? '.json' : isZip ? '.zip' : '.html';
        const tempFile = `temp_${source.name}${ext}`;

        let downloadSuccess = false;
        try {
            execSync(`curl -f -L -S "${source.url}" -o ${tempFile}`, { stdio: 'inherit' });
            downloadSuccess = true;
        } catch (error) {
            log(`⚠️ Download failed: ${error.message}. Retrying in 3 seconds...`);
            execSync('node -e "setTimeout(()=>{}, 3000)"');
            try {
                log(`🔄 Retry downloading...`);
                execSync(`curl -f -L -S "${source.url}" -o ${tempFile}`, { stdio: 'inherit' });
                downloadSuccess = true;
                log(`✅ Retry successful.`);
            } catch (retryError) {
                errorFromLog(`❌ FAILED (Retry limit reached): ${retryError.message}`);
                failedDownloads++;
            }
        }

        if (downloadSuccess) {
            try {
                if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 0) {
                    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });

                    let updateSuccess = true;

                    if (isZip) {
                        log(`📦 Unzipping...`);
                        // If source.extract is set, we unzip to a temp dir first, then move the specific folder
                        if (source.extract && source.target) {
                            const tempUnzipDir = path.join(EXTERNAL_DIR, `${source.name}_temp_unzip`);
                            if (fs.existsSync(tempUnzipDir)) fs.rmSync(tempUnzipDir, { recursive: true, force: true });
                            fs.mkdirSync(tempUnzipDir, { recursive: true });

                            execSync(`unzip -q -o ${tempFile} -d ${tempUnzipDir}`, { stdio: 'inherit' });

                            const extractSourcePath = path.join(tempUnzipDir, source.extract);
                            const finalTargetPath = path.join(__dirname, '..', source.target); // Resolve relative to script root

                            if (fs.existsSync(extractSourcePath)) {
                                log(`🚚 Moving extracted folder ${source.extract} -> ${source.target}`);
                                if (fs.existsSync(finalTargetPath)) fs.rmSync(finalTargetPath, { recursive: true, force: true });
                                fs.mkdirSync(path.dirname(finalTargetPath), { recursive: true });
                                fs.renameSync(extractSourcePath, finalTargetPath);
                            } else {
                                errorFromLog(`❌ ERROR: Extraction path not found in zip: ${source.extract}`);
                                updateSuccess = false;
                            }

                            // Cleanup temp unzip
                            fs.rmSync(tempUnzipDir, { recursive: true, force: true });

                        } else {
                            // Standard unzip to targetDir
                            fs.mkdirSync(targetDir, { recursive: true });
                            execSync(`unzip -q -o ${tempFile} -d ${targetDir}`, { stdio: 'inherit' });
                        }
                    } else if (isJsonPlugin) {
                        // JSON plugin tiddler: copy directly into wiki/tiddlers/
                        log(`📄 Installing JSON plugin tiddler into wiki/tiddlers/...`);
                        if (!fs.existsSync(TIDDLERS_DIR)) fs.mkdirSync(TIDDLERS_DIR, { recursive: true });
                        const destFile = path.join(TIDDLERS_DIR, `${source.name}.json`);
                        fs.copyFileSync(tempFile, destFile);
                        log(`✅ Copied to ${destFile}`);
                    } else {
                        log(`💥 Exploding TiddlyWiki...`);
                        execSync(`npx tiddlywiki --load ${tempFile} --savewikifolder ${targetDir}`, { stdio: 'inherit' });
                    }

                    // Pruning Logic based on 'type' (json-plugin skips pruning, it's already placed)
                    if (updateSuccess && !isJsonPlugin) {
                        const tiddlersDir = path.join(targetDir, 'tiddlers');
                        const pluginsDir = path.join(targetDir, 'plugins');
                        const themesDir = path.join(targetDir, 'themes');

                        if (source.type === 'plugins') {
                            // Keep plugins, delete tiddlers and themes
                            log('✂️  Type: plugins -> Removing tiddlers and themes...');
                            if (fs.existsSync(tiddlersDir)) fs.rmSync(tiddlersDir, { recursive: true, force: true });
                            if (fs.existsSync(themesDir)) fs.rmSync(themesDir, { recursive: true, force: true });
                        } else if (source.type === 'themes') {
                            // Keep themes, delete tiddlers and plugins
                            log('✂️  Type: themes -> Removing tiddlers and plugins...');
                            if (fs.existsSync(tiddlersDir)) fs.rmSync(tiddlersDir, { recursive: true, force: true });
                            if (fs.existsSync(pluginsDir)) fs.rmSync(pluginsDir, { recursive: true, force: true });
                        } else if (source.type === 'tiddlers') {
                            // Keep tiddlers, delete plugins and themes
                            log('✂️  Type: tiddlers -> Removing plugins and themes...');
                            if (fs.existsSync(pluginsDir)) fs.rmSync(pluginsDir, { recursive: true, force: true });
                            if (fs.existsSync(themesDir)) fs.rmSync(themesDir, { recursive: true, force: true });
                        } else {
                            log(`✨ Type: ${source.type || 'all'} -> No pruning.`);
                        }
                    }

                    if (updateSuccess) {
                        // Only a changed revision may touch the lockfile.
                        //
                        // Because wiki/external is a gitignored cache, a fresh
                        // checkout (every CI run, every fresh clone) re-downloads
                        // sources whose etag never moved — so restamping
                        // updatedAt here marked the lockfile dirty on every
                        // build, and a file that is always modified stops
                        // meaning anything. A re-fetch of identical bytes now
                        // leaves the entry exactly as it was.
                        const probed = Boolean(remoteInfo && (remoteInfo.etag || remoteInfo.lastModified));
                        if (!probed && lockEntry) {
                            // A failed header probe must not erase a revision we
                            // already know: keeping the old pin is strictly safer
                            // than writing null, which forgets what we had.
                            log(`⚠️ No revision headers for ${source.name} — keeping the revision already in the lockfile.`);
                        }
                        const etag = probed ? remoteInfo.etag : (lockEntry ? lockEntry.etag : null);
                        const lastModified = probed
                            ? remoteInfo.lastModified
                            : (lockEntry ? lockEntry.lastModified : null);
                        const sameRevision = Boolean(lockEntry)
                            && lockEntry.etag === etag
                            && lockEntry.lastModified === lastModified;
                        const entry = {
                            url: source.url,
                            etag,
                            lastModified,
                            updatedAt: sameRevision && lockEntry.updatedAt
                                ? lockEntry.updatedAt
                                : new Date().toISOString()
                        };
                        // Compare before assigning: re-deriving an unchanged
                        // entry must not schedule a write, so the lockfile stays
                        // byte-identical when nothing actually moved.
                        if (JSON.stringify(lockEntry) !== JSON.stringify(entry)) {
                            lockData[source.name] = entry;
                            changesMade = true;
                        }
                    }
                }
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            } catch (error) {
                errorFromLog(`❌ FAILED Extractions/Processing: ${error.message}`);
            }
        }
    } else {
        log(`✅ Up to date.`);
    }

    // --- AGGREGATION REMOVED (Replaced by direct usage in plugins dir) ---
});

// --- PROCESS LOCAL PLUGINS ---
const LOCAL_PLUGINS_DIR = path.join('wiki', 'local-plugins');
if (fs.existsSync(LOCAL_PLUGINS_DIR)) {
    log(`\n--- Processing Local Plugins from ${LOCAL_PLUGINS_DIR} ---`);
    const localPlugins = fs.readdirSync(LOCAL_PLUGINS_DIR, { withFileTypes: true });

    localPlugins.forEach(dirent => {
        // 'archive' holds retired local plugins for reference only — it must NEVER
        // be merged into wiki/external or it will leak back into builds.
        if (dirent.isDirectory() && dirent.name !== 'archive') {
            const pluginName = dirent.name;
            const sourcePath = path.join(LOCAL_PLUGINS_DIR, pluginName);
            const targetPath = path.join(EXTERNAL_DIR, pluginName);

            log(`📂 Copying local plugin: ${pluginName}`);

            try {
                if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
                fs.cpSync(sourcePath, targetPath, { recursive: true });
            } catch (e) {
                errorFromLog(`❌ Failed to copy local plugin ${pluginName}: ${e.message}`);
            }
        }
    });
}

// --- PRUNE STALE MERGE-CACHE ENTRIES ---
// wiki/external is a MERGE CACHE, not a source location. Anything not re-derived
// from external.yml + wiki/local-plugins (e.g. retired plugins, leftover archive/
// copies) must not survive into flatten, or retired content leaks into builds.
if (fs.existsSync(EXTERNAL_DIR)) {
    const keep = new Set(sources.filter(s => s.type !== 'disable').map(s => s.name));
    if (fs.existsSync(LOCAL_PLUGINS_DIR)) {
        fs.readdirSync(LOCAL_PLUGINS_DIR, { withFileTypes: true }).forEach(d => {
            if (d.isDirectory() && d.name !== 'archive') keep.add(d.name);
        });
    }
    fs.readdirSync(EXTERNAL_DIR, { withFileTypes: true }).forEach(dirent => {
        if (keep.has(dirent.name)) return;
        if (dirent.name === '.gitkeep') return; // tracked placeholder, not stale content
        const stalePath = path.join(EXTERNAL_DIR, dirent.name);
        log(`🧨 Pruning stale external entry: ${dirent.name}`);
        fs.rmSync(stalePath, { recursive: true, force: true });
    });
}

if (changesMade) {
    log(`\n📝 Saving lockfile...`);
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lockData, null, 2));
}

fs.writeFileSync(logPath, logContent);
console.log(`Mirror complete. Log written to ${logPath}`);

if (failedDownloads >= 2) {
    console.error(`\n❌ ERROR: ${failedDownloads} source(s) failed to download completely. Failing the build.`);
    process.exit(1);
}
