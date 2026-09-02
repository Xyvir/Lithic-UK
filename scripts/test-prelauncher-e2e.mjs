import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const preLauncherHtml = readFileSync('src/pre-launcher.html', 'utf8');
const testHtmlPath = resolve('src/test-prelauncher-e2e.html');

const mockHarness = `
<script>
window.__E2E_SAVER_LOGS__ = [];
window.showSaveFilePicker = async function(options) {
  window.__E2E_SAVER_LOGS__.push({
    event: 'showSaveFilePicker',
    options: options
  });
  return {
    name: options.suggestedName || 'new.lith',
    createWritable: async function() {
      return {
        write: async function(data) {
          window.__E2E_SAVER_LOGS__.push({
            event: 'write',
            dataSnippet: data.slice(0, 300),
            dataLength: data.length
          });
        },
        close: async function() {
          window.__E2E_SAVER_LOGS__.push({ event: 'close' });
        }
      };
    }
  };
};

(function() {
  var checkBtnTimer = setInterval(function() {
    var btn = document.querySelector('.launcher-actions button');
    if (btn && btn.textContent.includes('New Blank Lith')) {
      clearInterval(checkBtnTimer);
      btn.click();
      // A timestamp keeps the name collision-free across runs (the recent
      // liths list persists in the shared test profile's IndexedDB).
      var typedName = 'E2E Blank ' + Date.now();

      var checkFormTimer = setInterval(function() {
        var input = document.querySelector('input[aria-label="Lith file name"]');
        if (input) {
          clearInterval(checkFormTimer);
          input.value = typedName;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

          var checkTwTimer = setInterval(function() {
            if (window.$tw && window.$tw.wiki && window.$tw.saverHandler && window.$tw.rootWidget) {
              clearInterval(checkTwTimer);
              
              window.$tw.wiki.addTiddler(new window.$tw.Tiddler({
                title: "E2E Journal Note",
                text: "Testing full modular launcher save as flow",
                tags: ["E2ETag"]
              }));

              window.$tw.rootWidget.dispatchEvent({ type: "tm-save-wiki" });

              setTimeout(function() {
                var out = document.createElement('pre');
                out.id = 'e2e-out';
                out.textContent = JSON.stringify({
                  hasCustomSaver: !!(window.$tw && window.$tw.customSaver),
                  savers: (window.$tw.saverHandler.savers || []).map(function(s){ return { name: s.info.name, priority: s.info.priority }; }),
                  typedName: typedName,
                  logs: window.__E2E_SAVER_LOGS__
                }, null, 2);
                document.body.appendChild(out);
              }, 1000);
            }
          }, 100);
        }
      }, 100);
    }
  }, 100);
})();
</script>
`;

let modifiedHtml = preLauncherHtml.replace('</body>', `${mockHarness}</body>`);
writeFileSync(testHtmlPath, modifiedHtml, 'utf8');

const profileDir = resolve('scratch/chrome-test-profile');

try {
  const stdout = execFileSync(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-web-security',
    `--user-data-dir=${profileDir}`,
    '--virtual-time-budget=20000',
    '--dump-dom',
    `file:///${testHtmlPath.replace(/\\/g, '/')}`
  ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

  const match = stdout.match(/<pre id="e2e-out"[^>]*>([\s\S]*?)<\/pre>/);
  assert.ok(match, 'Headless Chrome returned E2E test output');

  const parsed = JSON.parse(match[1]);
  console.log('E2E Pre-Launcher Test Results:\n', JSON.stringify(parsed, null, 2));

  assert.equal(parsed.hasCustomSaver, true);
  const customSaver = parsed.savers.find(s => s.name === 'custom');
  assert.ok(customSaver, 'Custom saver was registered');
  assert.equal(customSaver.priority, 4000);

  assert.equal(parsed.logs.length, 3);
  assert.equal(parsed.logs[0].event, 'showSaveFilePicker');
  assert.equal(parsed.logs[0].options.suggestedName, parsed.typedName, 'the name from the launcher prompt reaches the save picker');
  assert.match(parsed.logs[0].options.suggestedName, /\.lith$/);
  assert.deepEqual(parsed.logs[0].options.types[0].accept, { 'application/x-lith': ['.lith'] });
  assert.equal(parsed.logs[1].event, 'write');
  assert.match(parsed.logs[1].dataSnippet, /title: E2E Journal Note/);
  assert.match(parsed.logs[1].dataSnippet, /tags: E2ETag/);
  assert.equal(parsed.logs[2].event, 'close');

  console.log('\n✔ E2E Pre-Launcher Save-As Parity Test Passed!');
} finally {
  unlinkSync(testHtmlPath);
}
