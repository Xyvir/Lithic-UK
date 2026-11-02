# Plugin Library

Lithic's plugins are also published as a TiddlyWiki plugin library.

1. Drag [plugin-store-carrier-wiki.html](https://lithic.uk/library/plugin-store-carrier-wiki.html) into your wiki.
2. Open Control Panel, then Plugins, then Get more plugins.
3. Install any plugin you want.

The full library is at [lithic.uk/library](https://lithic.uk/library/).

* **It is built from the same sources as the wiki.** `npm run build:library` writes `library/` from `wiki/local-plugins/`. The release run rebuilds it on every production build, so it arrives in the same review pull request as the wiki.
* **Only Lithic's own plugins are listed.** Third-party plugins are fetched from their own hosts at build time, so they are not bundled into the library.
