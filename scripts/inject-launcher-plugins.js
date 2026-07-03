const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const TARGET_ENV = ARGS[0] || 'prod'; // Which config to read from. By default, prod.

const ROOT_DIR = path.resolve(__dirname, '..');

// We use the merged config generator to guarantee we get exactly what is being built
// Wait, we don't have to duplicate the logic, we can just read the final tiddlywiki.info from wiki/
// The build pipeline generates wiki/tiddlywiki.info before this would run!
const configPath = path.join(ROOT_DIR, 'wiki', 'tiddlywiki.info');
const launcherPath = path.join(ROOT_DIR, 'src', 'launcher.html');

function main() {
    if (!fs.existsSync(configPath)) {
        console.error(`Error: Config file not found at ${configPath}. Please run generate-config.js first.`);
        process.exit(1);
    }
    if (!fs.existsSync(launcherPath)) {
        console.error(`Error: Launcher file not found at ${launcherPath}.`);
        process.exit(1);
    }

    console.log(`Reading plugins from ${configPath}...`);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const plugins = config.plugins || [];
    
    // Scan wiki/tiddlers/ for any external JSON plugins
    const tiddlersPath = path.join(ROOT_DIR, 'wiki', 'tiddlers');
    if (fs.existsSync(tiddlersPath)) {
        const files = fs.readdirSync(tiddlersPath);
        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const content = JSON.parse(fs.readFileSync(path.join(tiddlersPath, file), 'utf8'));
                    const items = Array.isArray(content) ? content : [content];
                    for (const item of items) {
                        if (item['plugin-type'] === 'plugin' && item.title && item.title.startsWith('$:/plugins/')) {
                            const pluginName = item.title.substring('$:/plugins/'.length);
                            if (!plugins.includes(pluginName)) {
                                plugins.push(pluginName);
                                console.log(`Discovered external JSON plugin: ${pluginName}`);
                            }
                        }
                    }
                } catch (e) {
                    console.warn(`Warning: Failed to parse ${file}`);
                }
            }
        }
    }

    // Sort for stable output
    plugins.sort();

    console.log(`Found ${plugins.length} plugins.`);

    let launcherContent = fs.readFileSync(launcherPath, 'utf8');

    // Generate formatted JSON string matching the indentation roughly
    const pluginsJson = JSON.stringify(plugins, null, 2).replace(/\n/g, '\n            ');
    const replacement = `const defaultPlugins = ${pluginsJson};`;

    // Replace the block.
    // The regex looks for `const defaultPlugins = [ ... ];`
    const regex = /const defaultPlugins = \[\s*[\s\S]*?\s*\];/g;
    
    let matchCount = 0;
    const newLauncherContent = launcherContent.replace(regex, (match) => {
        matchCount++;
        return replacement;
    });

    if (matchCount === 0) {
        console.error("Error: Could not find 'const defaultPlugins = [...];' in launcher.html to replace.");
        process.exit(1);
    }

    fs.writeFileSync(launcherPath, newLauncherContent);
    console.log(`Successfully injected ${plugins.length} plugins into ${matchCount} locations in launcher.html.`);
}

main();
