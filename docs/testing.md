# Testing the Launcher by Hand

Two harnesses in `scripts/` cover changes to the launcher's page. They answer different questions.

## `npm run test:puppeteer`

Drives the committed artifact through the states it should be in, and asserts what each one does. It runs in CI, and a failure there is a real failure.

## `npm run monkey:launcher`

Does not know what the launcher should do. It reports what happens when it is used badly:

* It presses every control the page draws and opens every entry box it can reach: a new Lith's name, the Recents search, a bookmark address, the repository and token fields, the vault PIN, and a saved login. Each box gets values nobody types.
* It opens documents instead of boxes. A dozen fixtures go through the Mount button, a real file drop, and a `?json=` or `?url=` address. Each one must end as the wiki or as the launcher, never blank, and a well-formed Lith must always boot.
* It tries the things that are neither a box nor a file: a cancelled picker, a missing or slow engine, a double press, a dropped backup, several Liths dropped at once including a repeated title, a merge that would replace a stored tiddler, a paste, an IME composition, a thousand rows, and a cache that refuses to write.

Options:

* `npm run monkey:launcher:headed` watches the run in a visible browser.
* `--rounds=8` fuzzes each box harder.
* `--seed=1234` repeats a run exactly.
* `--mode=webapp` tests the browser build instead of the desktop one.
* `--mounts=all` opens every document fixture.
* `--no-drop` and `--no-payload-urls` leave out those phases.
* `--list` prints what would be fuzzed and stops.
* `--strict` also fails on weak guardrails, not only on crashes.

Each run writes `scratch/monkey/report-<stamp>.md` (ignored by git), listing every value, what the field held afterwards, and how the name and address logic handled it.

The monkey run is deliberately not part of CI. It is noisy, it needs a browser, and a red build on a random seed encourages retrying instead of fixing. Anything it finds belongs in `test-puppeteer-launcher.mjs`, which is the harness CI runs. `npm run check:push` fails if a workflow invokes the monkey harness.
