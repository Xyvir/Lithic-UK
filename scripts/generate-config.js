const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const TARGET_ENV = ARGS[0] || 'prod'; // Default to prod

const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT_DIR, 'wiki', 'tiddlywiki.info');

// Hierarchy: prod -> pre -> dev -> all
// If target is 'dev', we merge prod + pre + dev.
const HIERARCHY = ['prod', 'pre', 'dev', 'all'];

function loadConfig(env) {
    const filePath = path.join(ROOT_DIR, `${env}-tiddlywiki.info`);
    if (fs.existsSync(filePath)) {
        console.log(`Loading ${env} config from ${filePath}`);
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    console.warn(`Warning: Config for ${env} not found at ${filePath}`);
    return { plugins: [], themes: [], build: {} };
}

function mergeConfigs(base, overlay) {
    const result = { ...base };

    // Update description if overlay has one
    if (overlay.description) {
        result.description = overlay.description; // Or append? Keeping simple replacement for now.
    }

    // Merge plugins (deduplicated)
    if (overlay.plugins) {
        result.plugins = [...new Set([...(result.plugins || []), ...overlay.plugins])];
    }

    // The uglify plugin is a build-time-only compression tool. It is kept out
    // of published artifacts by wiki/local-plugins/lithic-save (save/all shadow
    // override) and must never leak into non-prod (pre/dev) builds.
    if (TARGET_ENV !== 'prod' && Array.isArray(result.plugins)) {
        result.plugins = result.plugins.filter(p => p !== 'flibbles/uglify');
    }

    // Merge themes (deduplicated)
    if (overlay.themes) {
        result.themes = [...new Set([...(result.themes || []), ...overlay.themes])];
    }

    // Merge build targets (overlay overwrites same keys)
    if (overlay.build) {
        result.build = { ...(result.build || {}), ...overlay.build };
    }

    return result;
}

function main() {
    console.log(`Generating tiddlywiki.info for environment: ${TARGET_ENV}`);

    if (!HIERARCHY.includes(TARGET_ENV)) {
        console.error(`Error: Invalid environment '${TARGET_ENV}'. Must be one of: ${HIERARCHY.join(', ')}`);
        process.exit(1);
    }

    // Determine inclusion chain
    const targetIndex = HIERARCHY.indexOf(TARGET_ENV);
    const chain = HIERARCHY.slice(0, targetIndex + 1);

    console.log(`Merge chain: ${chain.join(' -> ')}`);

    let finalConfig = loadConfig('prod'); // Base is always prod

    // Start merging from the second item in chain (since we loaded prod already)
    // Wait, if chain is ['prod'], loop doesn't run. Correct.
    // If chain is ['prod', 'pre'], we merge pre.
    for (let i = 1; i < chain.length; i++) {
        const env = chain[i];
        const overlay = loadConfig(env);
        finalConfig = mergeConfigs(finalConfig, overlay);
    }

    // Write output
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalConfig, null, 4));
    console.log(`Successfully wrote merged config to ${OUTPUT_FILE}`);
}

main();
