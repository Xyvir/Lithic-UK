# Language

The launcher reads in the language of the device it is opened on. This applies to the published web app, to the launcher a self-hosted instance serves, and to the desktop app, which follows the machine. A language the launcher cannot read falls back to English. The shipped languages are the ones in `launcher-ui/src/copy.ts`.

Two things override this.

* **`?lang=es` on the address** asks for one page in that language, whatever the device says. It is also the way out of a pinned deployment.
* **A build can be pinned.** Set `VITE_LAUNCHER_LOCALE=es` when running `npm run build:launcher`, or put it in `launcher-ui/.env`. The published site, the desktop bundle and the server tarball are then all built in that language.

A self-hosted instance can pin its own language without rebuilding, by setting `LITHIC_LOCALE=es`. See [self-host.md](../self-host.md) for the details and for the two things a pin does not reach.
