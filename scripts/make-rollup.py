#!/usr/bin/env python3
"""Generate a TiddlyWiki-importable JSON rollup from a set of .tid files.

Usage:
    python scripts/make-rollup.py <output.json> <input.tid> [<input.tid> ...]

Output is a JSON array of tiddler objects (the standard TiddlyWiki import
format). Each tiddler carries every frontmatter field verbatim (including
custom fields like `sq-contextmenu-name` and shadow-override titles) plus
the body as `text`. The user imports the file directly into their live wiki
to test a feature iteration in meatspace.
"""
import json
import re
import sys


def parse_tid(path):
    with open(path, "rb") as f:
        raw = f.read().decode("utf-8-sig")
    raw = raw.replace("\r\n", "\n")
    m = re.match(r"^(.*?)\n\n", raw, re.S)
    if not m:
        raise ValueError("no frontmatter/body separator in %s" % path)
    header = m.group(1)
    body = raw[m.end():]
    fields = {}
    for line in header.split("\n"):
        if ":" in line:
            key, value = line.split(":", 1)
            fields[key.strip()] = value.strip()
    if "title" not in fields:
        raise ValueError("no title field in %s" % path)
    fields["text"] = body
    return fields


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    out_path = sys.argv[1]
    tiddlers = [parse_tid(p) for p in sys.argv[2:]]
    payload = json.dumps(tiddlers, indent=2, ensure_ascii=False)
    with open(out_path, "wb") as f:
        f.write(payload.encode("utf-8"))
    print("Wrote %s with %d tiddlers:" % (out_path, len(tiddlers)))
    for t in tiddlers:
        print("  - %s" % t["title"])


if __name__ == "__main__":
    main()
