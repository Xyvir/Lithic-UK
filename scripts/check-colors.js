#!/usr/bin/env node
/*
Audit hardcoded colour literals in the tracked Lithic plugin sources.

Lithic themes everything from the live TiddlyWiki palette: stylesheets consume
the shared contrast roles (`var(--lithic-c-*)`, published with WCAG contrast
math by $:/plugins/xyvir/lithic-core/contrast-publisher.js) and wikitext uses
`<<colour field>>` macros. A literal colour is a bug for two reasons: it ignores
the palette (dark themes get light-theme stickers) and it cannot be
contrast-checked.

Usage:
  node scripts/check-colors.js            # scan, report, exit 1 on offenders
  node scripts/check-colors.js --verbose  # also list tolerated exceptions

Exit codes: 0 = clean (or only tolerated exceptions), 1 = offender(s) found.

See the "Hardcoded colour gate" section of agents.md for the policy and for how
to add an exception.
*/
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var SRC = path.join(ROOT, 'wiki', 'local-plugins');
var VERBOSE = process.argv.indexOf('--verbose') !== -1 || process.argv.indexOf('-v') !== -1;

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

// Hex colours. The lookarounds skip tiddler titles/selectors (`$:/...`, `.foo`,
// `#id`) and numeric HTML entities (`&#8942;`).
var RE_HEX = /(?<![\w$/.:#&-])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])/g;

// Functional notations (rgb/rgba/hsl/hwb/lab/color-mix/...).
var RE_FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\([^)]*\)/gi;

// Named colours. A leading `:` is normal (`color:gray`); the lookarounds only
// rule out identifiers and paths (`$:/plugins/orange/...`, `white-space`).
var RE_NAMED = /(?<![\w/.-])(white|black|red|green|blue|gray|grey|yellow|pink|brown|purple|orange|silver|maroon|olive|lime|aqua|teal|navy|fuchsia)(?![\w/-])/g;

// Tokens that adapt to the palette and are therefore not literals.
var ADAPTIVE = /^(?:transparent|currentColor|currentcolor|inherit|initial|unset|revert|revert-layer|none|auto|canvastext|canvas|accentcolor|buttontext|highlight)$/i;

// A fully transparent hex (#0000, #00000000, #ff000000) is a no-op, not a theme colour.
function isTransparentHex(hex) {
  var h = hex.slice(1);
  return (h.length === 4 && h[3] === '0') || (h.length === 8 && h.slice(6) === '00');
}

// A function is only a literal if it carries an explicit colour: a bare numeric
// component (0-255), a hex, or a non-adaptive named colour. This keeps
// `color-mix(in srgb, currentColor 6%, transparent)` out of the report.
function funcIsLiteral(text) {
  var inner = text.slice(text.indexOf('(') + 1, -1);
  if (/(?<![\w.#%-])\d{1,3}(?![\w%.-])/.test(inner)) return true;
  if (/(?<![\w$/.:#&-])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])/.test(inner)) return true;
  var named = inner.match(RE_NAMED) || [];
  return named.some(function (n) { return !ADAPTIVE.test(n); });
}

function scanLine(line) {
  var hits = [], m;
  RE_HEX.lastIndex = 0;
  while ((m = RE_HEX.exec(line)) !== null) {
    if (!isTransparentHex(m[0])) hits.push({ literal: m[0], index: m.index });
  }
  RE_FUNC.lastIndex = 0;
  while ((m = RE_FUNC.exec(line)) !== null) {
    if (funcIsLiteral(m[0])) hits.push({ literal: m[0].replace(/\s+/g, ''), index: m.index });
  }
  RE_NAMED.lastIndex = 0;
  while ((m = RE_NAMED.exec(line)) !== null) {
    if (!ADAPTIVE.test(m[1])) hits.push({ literal: m[1], index: m.index });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Tolerated exceptions
//
// Every entry needs a reason. `file` is matched against the source-relative
// path, `line` (optional) against the offending line. Keep entries short and
// specific -- a broad glob hides real regressions.
// ---------------------------------------------------------------------------
var ALLOWLIST = [
  {
    file: /lithic-default-configs\/\$__themes_nico_notebook_palettes_/,
    reason: 'Palette definitions. These tiddlers ARE the palette; hex is the payload.'
  },
  {
    file: /lithic-core\/\$__lithic_styles_printstyle\.css\.tid/,
    reason: 'Print stylesheet. Paper is white: print output must force light values, not the live (possibly dark) palette.'
  },
  {
    file: /lithic-patch-mermaid\/\$__plugins_orange_mermaid-tw5_styles\.tid/,
    line: /--lithic-c-|background:\s*#ffffff/,
    reason: 'Media-print override block: re-pins the contrast roles to print values (same rationale as printstyle.css).'
  },
  {
    file: /lithic-richlinks\/\$__plugins_richlink_txtviewer-widget\.js\.tid/,
    reason: 'Text-file iframe gets a light color-scheme on purpose: the fetched document brings its own (dark-on-light) styling.'
  },
  {
    file: /lithic-richlinks\/\$__plugins_richlink_(modelviewer|stlviewer)-widget\.js\.tid/,
    line: /#(?:b8b8b8|ffffff)/,
    reason: '3D viewer defaults for model material and canvas clear colour -- content defaults, overridable per embed via widget attributes.'
  },
  {
    file: /lithic-richlinks\/\$__plugins_richlink_f3dmodel@stl\.tid/,
    reason: 'Same 3D model default, as a data tiddler field (content default, not chrome).'
  },
  {
    file: /lithic-import-handler\/pdf(-drop-handler)?\.js\.tid/,
    reason: 'PDF.js render options: documents render light-on-white as authored, independent of the wiki palette.'
  },
  {
    file: /lithic-patch-whiteboard\/\$__Lithic_Patches_Whiteboard_ActionDispatchPaste\.js\.tid/,
    line: /"black"/,
    reason: 'Whiteboard paste dispatch leaves the widget default (document ink) alone rather than re-theming pasted content.'
  },
];

// Drop shadows are depth cues rather than theme colours: a shadow needs a dark
// neutral in every palette. Exempt literals that sit inside a box-shadow
// declaration on the same line (the rest of the line is still audited).
function shadowRanges(line) {
  var ranges = [], m;
  var re = /box-shadow\s*:/g;
  while ((m = re.exec(line)) !== null) {
    var semi = line.indexOf(';', m.index);
    ranges.push([m.index, semi === -1 ? line.length : semi]);
  }
  return ranges;
}

// Single-line bundles (pdf.js and friends) cannot be meaningfully restyled;
// report them as tolerated rather than editing third-party code. Hand-written
// patch files that merely contain some long lines are still audited.
function isVendored(text) {
  var lines = text.split(/\r?\n/);
  var longest = 0;
  lines.forEach(function (l) { if (l.length > longest) longest = l.length; });
  return lines.length < 20 && longest > 1000;
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------
function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'archive') walk(p, out);
    } else if (/\.(tid|css|js|json)$/.test(e.name)) {
      out.push(p);
    }
  });
  return out;
}

function allowlistFor(rel, line) {
  for (var i = 0; i < ALLOWLIST.length; i++) {
    var a = ALLOWLIST[i];
    if (!a.file.test(rel)) continue;
    if (a.line && !a.line.test(line)) continue;
    return { index: i, entry: a };
  }
  return null;
}

var files = walk(SRC, []).sort();
var offenders = [];
var tolerated = [];
var comments = [];
var usedAllowlist = {};

files.forEach(function (f) {
  var rel = path.relative(ROOT, f).replace(/\\/g, '/');
  var text = fs.readFileSync(f, 'utf8');
  var vendored = isVendored(text);
  var inBlockComment = false;
  text.split(/\r?\n/).forEach(function (line, i) {
    // Inline /* ... */ comments are documentation, not styling: strip before scanning.
    var scrubbed = line.replace(/\/\*[\s\S]*?\*\//g, ' ');
    var ranges = shadowRanges(scrubbed);
    var hits = scanLine(scrubbed).filter(function (h) {
      return !ranges.some(function (r) { return h.index >= r[0] && h.index < r[1]; });
    });
    var startsInComment = inBlockComment;
    var open = line.indexOf('/*'), close = line.indexOf('*/');
    if (open !== -1 && (close === -1 || close < open)) inBlockComment = true;
    else if (close !== -1) inBlockComment = false;
    if (!hits.length) return;
    var trimmed = line.trim();
    var isComment = startsInComment || /^(\/\/|\*|\/\*)/.test(trimmed) || /\/\/.*$/.test(line) ||
      (open !== -1 && close !== -1 && trimmed.indexOf('/*') === 0);
    var row = { file: rel, line: i + 1, hits: hits.map(function (h) { return h.literal; }),
                text: trimmed.slice(0, 120) };
    if (vendored) { row.reason = 'minified vendored bundle'; tolerated.push(row); return; }
    if (isComment) { comments.push(row); return; }
    var a = allowlistFor(rel, line);
    if (a) {
      usedAllowlist[a.index] = true;
      row.reason = a.entry.reason;
      tolerated.push(row);
    } else {
      offenders.push(row);
    }
  });
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function groupByFile(rows) {
  return rows.reduce(function (acc, r) {
    (acc[r.file] = acc[r.file] || []).push(r);
    return acc;
  }, {});
}

if (VERBOSE) {
  if (tolerated.length) {
    console.log('Tolerated exceptions (' + tolerated.length + '):\n');
    var tolGroups = groupByFile(tolerated);
    Object.keys(tolGroups).sort().forEach(function (file) {
      var rows = tolGroups[file];
      console.log('  ' + file + '  -- ' + rows[0].reason);
      rows.slice(0, 6).forEach(function (r) {
        console.log('      ' + r.line + ': ' + JSON.stringify(r.hits));
      });
      if (rows.length > 6) console.log('      ... +' + (rows.length - 6) + ' more');
    });
    console.log('');
  }
  if (comments.length) {
    console.log('Mentions inside comments (' + comments.length + ', informational only):\n');
    comments.forEach(function (r) {
      console.log('  ' + r.file + ':' + r.line + '  ' + JSON.stringify(r.hits));
    });
    console.log('');
  }
}

if (offenders.length) {
  console.log('Hardcoded colour literals outside the allowlist:\n');
  var offGroups = groupByFile(offenders);
  Object.keys(offGroups).sort().forEach(function (file) {
    console.log('  ' + file);
    offGroups[file].forEach(function (r) {
      console.log('      ' + r.line + ': ' + JSON.stringify(r.hits) + '   ' + r.text);
    });
  });
  console.log('\nFAIL: ' + offenders.length + ' offending line(s) in ' +
    Object.keys(offGroups).length + ' file(s).');
  console.log('Use `<<colour field>>` (wikitext) or `var(--lithic-c-*)` (stylesheets), then');
  console.log('re-run with --verbose to see the tolerated exceptions and their reasons.');
  process.exit(1);
}

var stale = ALLOWLIST.filter(function (a, i) { return !usedAllowlist[i]; });
if (stale.length) {
  console.log('Note: ' + stale.length + ' allowlist entry(ies) matched nothing (stale?):');
  stale.forEach(function (a) { console.log('  ' + a.file); });
}

console.log('PASS: no hardcoded colour literals outside the allowlist ' +
  '(' + files.length + ' files scanned, ' + tolerated.length + ' tolerated line(s), ' +
  comments.length + ' comment mention(s)).');
