# About Lithic

Lithic is a personal knowledge management system built on [TiddlyWiki](https://tiddlywiki.com/). It is an outliner: notes are nested, and each can be moved, indented or linked from where it sits. It is an extension of [TiddlyStudy](https://github.com/postkevone/tiddlystudy).

## Principles

* **Free and open source.** Lithic is free to use and its source is public. It is not a subscription, and there is no paid tier.
* **You own your data.** Each wiki is a `.lith` file on a disk you choose, or on a server you run. There is no required account and no required cloud. See [storage modes](storage-modes.md) for what each platform keeps and where.
* **Portable.** The launcher is one file that works offline, from a USB stick, over `file://`, or on a machine that has never been online.
* **A `.lith` is many notes in one text file.** Think of it as several Markdown files joined together into one, with each note keeping its own title and tags.
* **Built for AI to read.** The `.lith` format was designed as something an AI can ingest directly. The Copy Story River button in the toolbar copies your current notes as one block, ready to paste into a chat-based AI interface. Lithic has no direct AI integration and will not add one.

## How Lithic Was Built

Lithic is TiddlyWiki with a launcher, plugins and desktop builds added on top. AI coding tools were used to glue an existing, stable and proven codebase together. The TiddlyWiki engine and its plugin ecosystem are the work of the TiddlyWiki developers and contributors.

## Companion Project: Ephemeral.exe

If you want to run code blocks from Lithic or any other text-based PKMS, see [Ephemeral.exe](https://github.com/Xyvir/Ephemeral.exe). It is a lightweight, daemonless utility that runs code snippets from your clipboard inside isolated Podman containers, so you can run many languages from your notes without installing them on your host.
