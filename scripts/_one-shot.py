import html
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "src", "lithic.html")
TEST = os.path.join(ROOT, "scripts", "_one-shot-test.html")
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

INJECTED = r"""
<script>
(function(){
  function finish(msg){
    var pre = document.getElementById('out');
    if (!pre) {
      pre = document.createElement('pre');
      pre.id = 'out';
      pre.style.whiteSpace = 'pre';
      (document.body || document.documentElement).appendChild(pre);
    }
    pre.textContent = msg;
  }
  var tries = 0;
  var iv = setInterval(function(){
    tries++;
    if (!(window.$tw && $tw.wiki && $tw.wiki.getTiddler('$:/plugins/sq/streams'))) {
      if (tries > 300) { finish('BOOT TIMEOUT after ' + tries + ' polls'); clearInterval(iv); }
      return;
    }
    clearInterval(iv);
    try { finish(run()); } catch (e) { finish('ERROR: ' + (e && e.message) + '\n' + ((e && e.stack) || '').slice(0, 600)); }
  }, 100);

  function run(){
    var w = $tw.wiki;
    var lines = [];
    function mk(title, fields){
      w.addTiddler(new $tw.Tiddler(Object.assign({title: title, text: '', type: 'text/vnd.tiddlywiki'}, fields)));
    }
    mk('Grand Parent', {text: 'GP', 'stream-list': '[[Fixture Parent]] [[Fixture Aunt]]'});
    mk('Fixture Parent', {text: 'P', parent: 'Grand Parent', 'stream-list': '[[Child A]] [[Child B]] [[Child C]]'});
    mk('Fixture Aunt', {text: 'A', parent: 'Grand Parent', 'stream-list': ''});
    mk('Child A', {text: 'Zebra', parent: 'Fixture Parent'});
    mk('Child B', {text: 'Apple', parent: 'Fixture Parent'});
    mk('Child C', {text: 'Mango', parent: 'Fixture Parent'});
    mk('Fixture Peers', {text: 'X', 'stream-list': '[[Peer One]] [[Peer Two]]'});
    mk('Peer One', {text: 'one', parent: 'Fixture Peers'});
    mk('Peer Two', {text: 'two', parent: 'Fixture Peers'});
    mk('Fixture Lone', {text: 'L', 'stream-list': '[[Lone Node]]'});
    mk('Lone Node', {text: 'solo', parent: 'Fixture Lone'});
    mk('Empty Child', {text: '', parent: 'Fixture Parent'});

    lines.push('T1 tilde-else [[A]] ~[[B]]: ' + JSON.stringify(w.filterTiddlers('[[A]] ~[[B]]')));

    // ---- cycle-leadmark 'compute once, stamp all' pieces (variable-free) ----
    lines.push('C1 first-child source: ' + JSON.stringify(w.filterTiddlers('[[Fixture Parent]get[stream-list]enlist-input[]is[tiddler]first[]]')));
    lines.push('C2a removeprefix match: ' + JSON.stringify(w.filterTiddlers('[[Child A]get[text]removeprefix[Z]]')));
    lines.push('C2b removeprefix NON-match (expect []): ' + JSON.stringify(w.filterTiddlers('[[Child A]get[text]removeprefix[A]]')));
    lines.push('C3 else-fallback to original: ' + JSON.stringify(w.filterTiddlers('[[Child A]get[text]removeprefix[A]] ~[[Child A]get[text]]')));
    lines.push('C3b match-then-stop: ' + JSON.stringify(w.filterTiddlers('[[Child A]get[text]removeprefix[Z]] ~[[Child A]get[text]]')));
    lines.push('C4 addprefix: ' + JSON.stringify(w.filterTiddlers('[[Child A]get[text]addprefix[T]]')));

    mk('C5Src', {text: '[x] foo'});
    mk('C6Src', {text: '<<num>> foo'});
    mk('C7Src', {text: '- [x] foo'});
    lines.push('C5 literal bracket-prefix operand: ' + JSON.stringify(w.filterTiddlers('[[C5Src]get[text]prefix[[x] ]]')));
    lines.push('C5b literal removeprefix bracket: ' + JSON.stringify(w.filterTiddlers('[[C5Src]get[text]removeprefix[[x] ]]')));
    lines.push('C6 literal <<num>> operand: ' + JSON.stringify(w.filterTiddlers('[[C6Src]get[text]prefix[<<num>> ]]')));

    // full nextState chain, literals substituted (only meaningful if C5/C6 parsed)
    lines.push('C7 nextState done->num literal: ' + JSON.stringify(w.filterTiddlers('[[C5Src]get[text]prefix[[x] ]]then[[<<num>> ]] ~[[C5Src]get[text]prefix[[X] ]]then[[<<num>> ]] ~[[C5Src]get[text]prefix[[- [x] ]]then[[<<num>> ]] ~[[C5Src]get[text]prefix[[- [X] ]]then[[<<num>> ]] ~[[C5Src]get[text]prefix[[ ] ]]then[[x] ]] ~[[C5Src]get[text]prefix[[- [ ] ]]then[[x] ]] ~[[ ] ]]')));
    lines.push('C8 strip chain on - [x] foo: ' + JSON.stringify(w.filterTiddlers('[[C7Src]get[text]removeprefix[[ ] ]] ~[[C7Src]get[text]removeprefix[[- [ ] ]] ~[[C7Src]get[text]removeprefix[[x] ]] ~[[C7Src]get[text]removeprefix[[X] ]] ~[[C7Src]get[text]removeprefix[[- [x] ]] ~[[C7Src]get[text]removeprefix[[- [X] ]] ~[[C7Src]get[text]removeprefix[[<<num>> ]] ~[[C7Src]get[text]]')));

    // ---- fixed tiddler forms (variable operands) must PARSE CLEAN (no 'Filter error') ----
    // Variables don't resolve headlessly, so these return [] when unset; the check is
    // that the result is never a 'Filter error' string (which the literal forms produce).
    lines.push('D1 fixed srcTodo form BRACKETED (expect [] parse-clean): ' + JSON.stringify(w.filterTiddlers('[<source>tag[done]then<todo1>] ~[<done1>]')));
    lines.push('D2 fixed nextState chain BRACKETED (expect [] parse-clean): ' + JSON.stringify(w.filterTiddlers('[<source>get[text]prefix<num1>then[none]] ~[<source>get[text]prefix<done1>then<num1>] ~[<source>get[text]prefix<done2>then<num1>] ~[<source>get[text]prefix<done3>then<num1>] ~[<source>get[text]prefix<done4>then<num1>] ~[<source>get[text]prefix<todo1>then<srcTodo>] ~[<source>get[text]prefix<todo2>then<srcTodo>] ~[<todo1>]')));
    lines.push('D3 fixed stripped chain (expect [] parse-clean): ' + JSON.stringify(w.filterTiddlers('[<t>removeprefix<todo1>] ~[<t>removeprefix<todo2>] ~[<t>removeprefix<done1>] ~[<t>removeprefix<done2>] ~[<t>removeprefix<done3>] ~[<t>removeprefix<done4>] ~[<t>removeprefix<num1>] ~[<t>]')));
    lines.push('D4 OLD literal srcTodo form (expect Filter error): ' + JSON.stringify(w.filterTiddlers('[<source>tag[done]then[[ ] ]] ~[[x] ]]')));
    lines.push('D5 bare bracketed var run [<done1>] (expect [""]): ' + JSON.stringify(w.filterTiddlers('[<done1>]')));
    lines.push('D6 UNbracketed ~<done1> (expect literal <done1> title): ' + JSON.stringify(w.filterTiddlers('[<source>tag[done]then<todo1>] ~<done1>')));

    // ---- targetList fallback (childless root -> anchor; peers -> siblings) ----
    mk('Rootless', {text: 'R'});
    mk('Task A', {text: '[ ] do the thing'});
    lines.push('L1 count/match lone child -> [Lone Node]: ' + JSON.stringify(w.filterTiddlers('[[Lone Node]get[parent]get[stream-list]enlist-input[]is[tiddler]count[]match[0]then[[Lone Node]] ~[[Lone Node]get[parent]get[stream-list]enlist-input[]is[tiddler]]')));
    lines.push('L2 count/match root no parent (was []): ' + JSON.stringify(w.filterTiddlers('[[Rootless]get[parent]get[stream-list]enlist-input[]is[tiddler]count[]match[0]then[Rootless] ~[[Rootless]get[parent]get[stream-list]enlist-input[]is[tiddler]]')));
    lines.push('L3 count/match peers -> [Peer One,Peer Two]: ' + JSON.stringify(w.filterTiddlers('[[Peer One]get[parent]get[stream-list]enlist-input[]is[tiddler]count[]match[0]then[[Peer One]] ~[[Peer One]get[parent]get[stream-list]enlist-input[]is[tiddler]]')));
    lines.push('L4 CLEAN targetList root -> [Rootless]: ' + JSON.stringify(w.filterTiddlers('[[Rootless]get[parent]get[stream-list]enlist-input[]is[tiddler]] ~[[Rootless]]')));
    lines.push('L5 CLEAN targetList lone -> [Lone Node]: ' + JSON.stringify(w.filterTiddlers('[[Lone Node]get[parent]get[stream-list]enlist-input[]is[tiddler]] ~[[Lone Node]]')));
    lines.push('L6 CLEAN targetList peers -> [Peer One,Peer Two]: ' + JSON.stringify(w.filterTiddlers('[[Peer One]get[parent]get[stream-list]enlist-input[]is[tiddler]] ~[[Peer One]]')));
    lines.push('L7 count diagnostic on root chain: ' + JSON.stringify(w.filterTiddlers('[[Rootless]get[parent]get[stream-list]enlist-input[]is[tiddler]count[]]')));
    lines.push('R1 user regexp unicode-escape [\\x5B \\x5D] finds [ ] foo: ' + JSON.stringify(w.filterTiddlers('[all[]search:text:regexp[\\x5B \\x5D]]')));

    lines.push('R1b regexp on field text alone: ' + JSON.stringify(w.filterTiddlers('[all[]] +[search:text:regexp[\\x5B \\x5D]]')));
    lines.push('R1c regexp [.] plain (control): ' + JSON.stringify(w.filterTiddlers('[all[]search:text:regexp[.]]')));

    // ---- does `then` actually fire in this build? ----
    lines.push('T-A empty-input count/match/then -> [ROOT]: ' + JSON.stringify(w.filterTiddlers('[[Rootless]get[zzz-none]count[]match[0]then[ROOT]]')));
    lines.push('T-B prefix-match then -> [MATCHED]: ' + JSON.stringify(w.filterTiddlers('[[Child A]get[text]prefix[Z]then[MATCHED]]')));
    lines.push('T-C no-match then -> else original [Zebra]: ' + JSON.stringify(w.filterTiddlers('[[Child A]get[text]prefix[Q]then[MATCHED]] ~[[Child A]get[text]]')));
    lines.push('T-D match then [NOPE] (then fires?): ' + JSON.stringify(w.filterTiddlers('[[Child A]get[text]prefix[Z]then[NOPE]')));

    // ---- cycle-leadmark siblings-branch conditions (fixed structure) ----
    lines.push('F1 sibling cond on peer (expect fires): ' + JSON.stringify(w.filterTiddlers('[[Peer One]get[parent]get[stream-list]enlist-input[]is[tiddler]count[]!match[0]]')));
    lines.push('F2 fallback cond on root (expect fires 0): ' + JSON.stringify(w.filterTiddlers('[[Rootless]get[parent]get[stream-list]enlist-input[]is[tiddler]count[]match[0]]')));
    lines.push('F3 fallback cond on lone child (expect []): ' + JSON.stringify(w.filterTiddlers('[[Lone Node]get[parent]get[stream-list]enlist-input[]is[tiddler]count[]match[0]]')));
    lines.push('F4 sibling cond on root (expect []): ' + JSON.stringify(w.filterTiddlers('[[Rootless]get[parent]get[stream-list]enlist-input[]is[tiddler]count[]!match[0]]')));
    lines.push('F5 full sibling list under parent (expect both peers): ' + JSON.stringify(w.filterTiddlers('[[Peer One]get[parent]get[stream-list]enlist-input[]is[tiddler]]')));

    return lines.join('\n');
  }
})();
</script>
"""


def main():
    with open(BUILD, "rb") as f:
        html_src = f.read().decode("utf-8", errors="replace")
    if INJECTED.strip() in html_src:
        print("ALREADY INJECTED")
        sys.exit(1)
    out = html_src.replace("</body>", INJECTED + "\n</body>")
    if out == html_src:
        print("NO </body> FOUND")
        sys.exit(1)
    with open(TEST, "wb") as f:
        f.write(out.encode("utf-8"))
    print("wrote", TEST)

    url = "file:///" + TEST.replace("\\", "/")
    cmd = [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
           "--virtual-time-budget=30000", "--dump-dom", url]
    res = subprocess.run(cmd, capture_output=True, timeout=120)
    dom = res.stdout.decode("utf-8", errors="replace")
    m = re.search(r'<pre id="out"[^>]*>(.*?)</pre>', dom, re.S)
    if not m:
        print("=== NO <pre id=out> IN DUMP ===")
        print("exit:", res.returncode)
        print("stderr tail:", res.stderr.decode("utf-8", errors="replace")[-800:])
        print("dom tail:", dom[-1500:])
        sys.exit(1)
    print("=== RESULT ===")
    print(html.unescape(m.group(1)))


if __name__ == "__main__":
    main()
