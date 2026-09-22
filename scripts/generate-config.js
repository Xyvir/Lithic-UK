const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const TARGET_ENV = ARGS[0] || 'prod'; // Default to prod

const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT_DIR, 'wiki', 'tiddlywiki.info');

// Hierarchy: prod -> pre -> dev -> all
// If target is 'dev', we merge prod + pre + dev.
const HIERARCHY = ['prod', 'pre', 'dev', 'all'];

// 'light' is not part of that hierarchy: it is a *subset* of prod, not prod plus
// extras, so it is written by its own definition instead of being merged. That
// definition is named lithic-light-tw.info rather than <env>-tiddlywiki.info
// because it describes a distribution (the flash-sized one), not an environment
// that layers onto prod — so it is deliberately outside the merge chain.
const LIGHT_ENV = 'light';
const LIGHT_CONFIG = 'lithic-light-tw.info';

function loadConfig(env) {
    // Accepts an environment name (`prod` -> prod-tiddlywiki.info) or a full file
    // name, which is how the light distribution's definition is addressed.
    const filePath = env.endsWith('.info')
        ? path.join(ROOT_DIR, env)
        : path.join(ROOT_DIR, `${env}-tiddlywiki.info`);
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

    if (TARGET_ENV === LIGHT_ENV) {
        // Written verbatim: the light set IS the whole story, so there is nothing
        // to merge and no prod imports to inherit. flibbles/uglify stays in the
        // list because light is a published artifact like prod, and light ships
        // xyvir/lithic-save, whose save/all override is what strips the uglify
        // tooling back out of the rendered file.
        const lightConfig = loadConfig(LIGHT_CONFIG);
        if (!Array.isArray(lightConfig.plugins) || lightConfig.plugins.length === 0) {
            console.error(`Error: ${LIGHT_CONFIG} lists no plugins — refusing to write a build config from it.`);
            process.exit(1);
        }
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(lightConfig, null, 4));
        console.log(
            `Successfully wrote ${lightConfig.plugins.length} plugins / ` +
                `${(lightConfig.themes || []).length} themes to ${OUTPUT_FILE}`
        );
        return;
    }

    if (!HIERARCHY.includes(TARGET_ENV)) {
        console.error(
            `Error: Invalid environment '${TARGET_ENV}'. Must be one of: ${[...HIERARCHY, LIGHT_ENV].join(', ')}`
        );
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
