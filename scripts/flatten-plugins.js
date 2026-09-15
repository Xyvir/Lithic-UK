const fs = require('fs');
const path = require('path');

const EXTERNAL_DIR = path.join(__dirname, '../wiki/external');
const TARGET_PLUGINS_DIR = path.join(__dirname, '../wiki/plugins');

if (!fs.existsSync(EXTERNAL_DIR)) {
    console.error(`External plugins directory not found: ${EXTERNAL_DIR}`);
    process.exit(1);
}

// staging dirs are fully derived from the current build config; stale entries from
// retired sources must not survive between runs. Preserve tracked .gitkeep placeholders.
const STAGING_DIRS = [TARGET_PLUGINS_DIR, path.join(__dirname, '../wiki/themes')];
STAGING_DIRS.forEach(dir => {
    const keepFile = path.join(dir, '.gitkeep');
    let keepContent = null;
    if (fs.existsSync(keepFile)) keepContent = fs.readFileSync(keepFile);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`Cleared stale staging: ${dir}`);
    }
    fs.mkdirSync(dir, { recursive: true });
    if (keepContent !== null) fs.writeFileSync(keepFile, keepContent);
});

function findPluginInfoFiles(dir, fileList = []) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            if (file === 'archive') {
                console.log(`Skipping archive directory: ${filePath}`);
                return fileList; // Retired plugins must not leak into staging
            }
            findPluginInfoFiles(filePath, fileList);
        } else if (file === 'plugin.info') {
            fileList.push(filePath);
        }
    }
    return fileList;
}

function copyRecursiveSync(src, dest) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats.isDirectory();

    if (isDirectory) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        fs.readdirSync(src).forEach((childItemName) => {
            copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
        });
    } else {
        fs.copyFileSync(src, dest);
    }
}

const manifestPath = path.join(__dirname, '../wiki/flatten-manifest.log');
let manifestContent = "--- Flattened Plugin Manifest ---\nGenerated at: " + new Date().toISOString() + "\n\n";

console.log('Scanning for external plugins...');
const pluginInfos = findPluginInfoFiles(EXTERNAL_DIR);

console.log(`Found ${pluginInfos.length} plugin.info files.`);

if (pluginInfos.length === 0) {
    console.error('FATAL: no plugin.info files found under wiki/external — the mirror step produced no plugins. Failing the build so an empty wiki never ships. Check wiki/mirror.log / external.yml / external-lock.json.');
    process.exit(1);
}

pluginInfos.forEach(infoPath => {
    try {
        const content = fs.readFileSync(infoPath, 'utf8');
        const pluginInfo = JSON.parse(content);

        if (!pluginInfo.title) {
            console.warn(`Skipping ${infoPath}: Missing 'title' in plugin.info`);
            manifestContent += `[SKIP] ${infoPath} (Missing title)\n`;
            return;
        }

        let targetBaseDir;
        let relativePathStart;
        let typeLabel = "PLUGIN";

        if (pluginInfo.title.startsWith('$:/plugins/')) {
            targetBaseDir = TARGET_PLUGINS_DIR;
            // $:/plugins/publisher/name -> publisher/name
            relativePathStart = 2;
        } else if (pluginInfo.title.startsWith('$:/themes/')) {
            targetBaseDir = path.join(__dirname, '../wiki/themes');
            // $:/themes/publisher/name -> publisher/name
            relativePathStart = 2;
            typeLabel = "THEME";
        } else {
            console.warn(`Skipping ${infoPath}: Unknown plugin type (title: ${pluginInfo.title})`);
            manifestContent += `[SKIP] ${infoPath} (Unknown type: ${pluginInfo.title})\n`;
            return;
        }

        // Extract publisher/plugin-name
        const parts = pluginInfo.title.split('/');
        if (parts.length < 4) {
            console.warn(`Skipping ${infoPath}: Title structure too short (${pluginInfo.title})`);
            manifestContent += `[SKIP] ${infoPath} (Title too short: ${pluginInfo.title})\n`;
            return;
        }

        const relativePath = parts.slice(relativePathStart).join('/');
        const targetPath = path.join(targetBaseDir, relativePath);
        const sourceDir = path.dirname(infoPath);

        console.log(`Copying ${pluginInfo.title} -> ${targetPath}`);
        manifestContent += `[${typeLabel}] ${pluginInfo.title}\n`;
        manifestContent += `  Source: ${sourceDir}\n`;
        manifestContent += `  Target: ${targetPath}\n`;

        copyRecursiveSync(sourceDir, targetPath);
        manifestContent += `  Status: Copied\n\n`;

    } catch (e) {
        console.error(`Error processing ${infoPath}:`, e.message);
        manifestContent += `[ERROR] ${infoPath}: ${e.message}\n\n`;
    }
});

fs.writeFileSync(manifestPath, manifestContent);
console.log(`Plugin flattening complete. Manifest written to ${manifestPath}`);
