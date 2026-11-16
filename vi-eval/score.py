"""Score a transcription against the source text.

usage: python score.py <source.txt> <transcript.txt>
Prints char accuracy (difflib ratio) and syllable accuracy (exact matched words / source words),
plus accented-syllable accuracy, the part a missing Vietnamese glyph can damage.
"""
import difflib
import json
import re
import sys
import unicodedata

src = unicodedata.normalize("NFC", open(sys.argv[1], encoding="utf-8").read())
hyp = unicodedata.normalize("NFC", open(sys.argv[2], encoding="utf-8").read())
norm = lambda s: re.sub(r"\s+", " ", s.replace("↵", "\n")).strip()
src, hyp = norm(src), norm(hyp)

char_acc = difflib.SequenceMatcher(None, src, hyp, autojunk=False).ratio()
sw, hw = src.split(" "), hyp.split(" ")
sm = difflib.SequenceMatcher(None, sw, hw, autojunk=False)
matched = sum(b.size for b in sm.get_matching_blocks())
accented = [i for i, w in enumerate(sw) if any(ord(c) > 127 for c in w)]
hit = set()
for b in sm.get_matching_blocks():
    hit.update(range(b.a, b.a + b.size))
acc_hit = sum(1 for i in accented if i in hit)
print(json.dumps({
    "char_acc": round(char_acc, 4),
    "syllable_acc": round(matched / len(sw), 4),
    "accented_syllable_acc": round(acc_hit / max(len(accented), 1), 4),
    "accented_syllables": len(accented),
}))
