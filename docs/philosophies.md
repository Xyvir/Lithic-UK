# Philosophies

Lithic is built around a few beliefs about notes. They explain most of the choices in the app.

## Your notes should outlast the app

A `.lith` is a plain-text file that holds many notes together. Each note keeps its own title and tags, and the whole file opens in Lithic on any device. Because it is text, you can read it, copy it, diff it, or hand it to another tool. If Lithic disappeared tomorrow, the notes would still be there.

## Portable, single-file

The launcher and engine ship as one file. It runs from a USB stick, over `file://`, or on a machine that has never been online. Nothing the app needs to run may be loaded from another host. The app and the notes stay together, so moving one moves the other.

## You own your data

Each wiki is a file on a disk you choose, or on a server you run. Nothing requires an account, a subscription or a connection. Moving your notes means copying a file. See [storage modes](storage-modes.md) for what each platform keeps and where.

## Free and open source, with no paid tier

Lithic is free to use and its source is public. It is not a subscription, and there is no plan to add a paid tier.

## Notes are an outline

The unit of knowledge is the node, a bullet point, not a page. Notes nest, and each one can be moved, indented or linked from where it sits. Tab and Shift+Tab indent, and Alt+Up and Alt+Down reorder. Search results show their parent context, so a note never loses its place in the hierarchy.

## Go wide, not tall

The katamari fallacy is the belief that one knowledge base should hold everything. Katamari Damacy is a game about rolling up everything in reach into one giant sticky ball. A knowledge base can become the same ball: one wiki that collects every subject, grows heavier with each addition, and sticks to whatever it touches. Lithic favours several smaller topical knowledge bases, each focused on one area, over one large wiki that holds everything.

## The journal is the only capture point

New information goes into today's journal as it happens. There is no separate inbox to empty later, because an inbox is where ideas go to rot. Jot a quick note in the journal, then do a full capture later if it is worth keeping.

## Structure is inherited, not re-entered

Children in an outline inherit the context and tags of their parents, so you do not add metadata to every line. Time spent is worked out from the gaps between bullet points in the journal, so you do not start or stop a timer.

## Scheduling uses the notes themselves

Tasks are journal date references dropped onto items. The calendar reads those references, so there is no separate to-do database to keep in step with the notes.

## Built for AI to read, not to run

The `.lith` format was designed so an AI can ingest it directly. The Copy Story River button copies your current notes as one block, ready to paste into a chat-based AI tool. Lithic has no direct AI integration, and it will not add one. The choice of what to send to an AI stays with you.

## What Lithic leaves out

Some features are missing on purpose, to keep the focus on the notes:

* **No global graph view.** Force-directed graphs make a knowledge base look more connected or more important than it is. The Pyramid sidebar, a hierarchical tree, and backlink pills show connections without that distortion.
* **No per-note version history.** The outliner replaces the usual edit-and-draft flow, so history lives at the wiki level, in Git and in the launcher's backups.

## Build on proven foundations

Lithic is TiddlyWiki with a launcher, plugins and desktop builds added on top. The TiddlyWiki engine and its plugin ecosystem are the work of the TiddlyWiki developers and contributors. Lithic extends an existing, stable codebase rather than replacing it. It is an extension of [TiddlyStudy](https://github.com/postkevone/tiddlystudy).
