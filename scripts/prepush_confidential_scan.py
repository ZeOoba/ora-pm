#!/usr/bin/env python3
"""Git pre-push confidentiality gate (Hard Invariant 3) -- fail-closed.

This repo is PUBLIC (Gabriel ruling 2026-11-09), so it is an external surface: no active
confidential deal may reach it before closing. This gate scans everything a push would make
new on the remote and BLOCKS if any active deal's term from the machine-local roster
(~/.claude/hooks/confidential-terms.json, never committed anywhere) appears in it: an
`always` term anywhere, or a `context` term together with one of that deal's
`context_requires_any` anchors in the same window (see "Context terms" below).

Ported from ~/.claude/hooks/git-prepush-confidential-scan.py (the ora-claude-config gate,
which has carried this design since 2026-06-11), terms-only: that gate's credential scan
depends on ~/.claude/hooks/lib/secret_patterns.py and is not ported. The same file is
committed to ora-skills, website-canonical and ora-pm; keep the three copies identical.

What is scanned, per pushed ref:
  * every commit object in the range, raw (message, author, mergetag and other headers), and
    `git log -p --cc` over the range (every diff; a clean HEAD does not mean a clean push);
  * EVERY blob the range adds or modifies, read whole via `git cat-file --batch` and
    classified by content, never by extension or git's binary flag (which `.gitattributes`
    can flip). Views: utf-8, cp1252, UTF-16 LE/BE at byte offsets 0 and 1; markup with tags
    stripped and HTML entities decoded (a Word run split across `<w:t>` elements still
    matches); gzip / bz2 / xz / zip / tar decompressed in memory, nested to a small depth
    (docx / xlsx are zips);
  * the pushed ref names, and every annotated tag object in a pushed tag's chain; when a
    pushed ref or tag chain ends at a BLOB it is scanned like a pushed file, and at a TREE
    every blob in it (`ls-tree -r`, all of them -- blobs already on the remote included);
    any other non-commit type blocks;
  * every path, ref name and file name as raw bytes through the same text views, so a
    cp1252 / UTF-16 path is read too.
Every git call runs with `--no-replace-objects` and GIT_NO_REPLACE_OBJECTS=1 (and without
GIT_REPLACE_REF_BASE): `git replace` must not show the scan a different object from the one
pack-objects sends.
Every text is also read URL-decoded (`unquote_plus` and plain `unquote`, so `%20`, `+` and
`%51uiet` decode), repeated to a fixpoint bounded at 4 rounds, which unwraps up to four
levels of encoding (`%20`, `%2520`, `%252520`, `%25252520`); deeper nesting is a residual.
URL-decoding runs on the raw and the entity-decoded text (tag-stripped readings are not
URL-decoded), so an encoded term inside an `href` attribute is read too. Plain `unquote`
(which keeps a literal `+`) is only run when some roster string contains `+`; otherwise it
can find nothing `unquote_plus` does not.
Cost versus origin/main, measured best of 3 on 4 MB texts with an anchored roster:
clean ASCII 1.1x; dense `+ % & <` (`a+b%2Bc%252Bd...&amp;amp;<i>x</i>`) 3.7x, 7.7x when a
roster string contains `+`; %-only 6.1x; accented non-ASCII text 7.9x (the guard-tight
anchor reading: NFKD over every non-ASCII window). The earlier refute pass measured 3.4x /
5.0x / 3.4x on 30d2a246, before the tight anchor reading existed.
Matching: NFKC + casefold on both sides; any run of whitespace / `_` / `-` / `.` / NBSP
counts as one separator, and a separator-free form of each MULTI-word term (5+ chars) is
also matched against the normalized text, so `LOI_<TermNoSpaces>_MMDDYYYY` and line-wrapped
or `&nbsp;`-joined names are caught without "east on" matching a one-word "easton".
Range: an existing remote ref scans remote_sha..local_sha (git took remote_sha from the
destination itself). A brand-new remote ref scans the pushed commits NOT reachable from what
the destination actually advertises: `git ls-remote <push url>` (argv[2], or argv[1] when
argv[2] is absent; no prompt, 60 s timeout, credential helpers inherited), keeping only the
advertised shas that exist locally as commits, passed as `^<sha>` lines on `--stdin` (no
command-line cap). No local tracking ref, remote name or remote config is consulted. If
ls-remote fails, times out or advertises nothing usable, the pushed ref's FULL history is
scanned -- fail-closed, and slower; an orphan branch or a push to an empty repository is
likewise scanned in full. This costs one extra connection to the remote per push that
creates a ref.

Context terms (mirrors find_hit() in ~/.claude/hooks/confidentiality-guard.py): a deal's
`context` term blocks only when one of the same deal's `context_requires_any` anchors also
appears in the same WINDOW. A window is one scanned unit:
  * one commit: its raw object in every text view, its own patch from `git log -p`, AND the
    content and path of every blob it adds or modifies (`git log --raw`, merges via --cc) --
    binary, archive and `-diff` files show in the patch only as "Binary files differ", so
    their decoded text is pooled in explicitly (the guard pools file_path with content);
  * one blob: every text view, every decompressed archive member (a docx is one document)
    and every path it is pushed under;
  * one annotated tag object; one pushed ref name.
An anchor and a context term that only meet across two commits of the same push do not
combine (residual; the anchored-context design is about one text).
A deal whose context terms have no usable anchor -- `context_requires_any` missing or empty,
or ANY anchor with no match form once tightened and normalized (`normalize(_guard_tight(a))`
is empty: separators and invisibles only, e.g. `<WORD JOINER>-`), or blank under the guard's
tight form (NFKD, lowercase, superscript
digits, combining marks (Mn) and the guard's invisible set _TABLE_FMT deleted, whitespace
collapsed: U+3164, U+2800, U+115F/1160, U+0301, U+FE0F, ZWSP ... all count as blank; a
blank anchor matches everywhere, as in the guard) -- has its context terms treated as
`always` terms. That is stricter than the guard for a missing / empty anchor list, which the
guard reads as "never fires"; fail-closed wins here. An anchor made only of separators
(`-`, `_`, `.`) has no match form and counts as blank too. Each usable anchor is matched in
its plain normalized form AND its tight form, against the normalized text AND the guard's
tight form of the raw / entity-decoded text, so `projectcode<ZWSP>q7` in the roster fires on
`projectcodeq7`, `projectcode<WORD JOINER>q7` or a stray combining mark in the text still
fires, and an accented anchor fires with or without the accent, as the guard does (its
punctuation and non-ASCII digit folds are not mirrored). An anchor alone never blocks.

Output never echoes a term: hits are reported as roster indices, and a path or ref name
that itself contains ANY roster string (always, context or anchor) is withheld.

FAIL-CLOSED -- each of these BLOCKS the push:
  * roster missing, unreadable, unparseable, not a JSON object, or any deal entry malformed
    (a non-dict deal; `always`, `context` or `context_requires_any` present but not a list of
    strings, null included; or an active deal that declares terms none of which survives
    normalization -- we cannot know what to look for);
  * `git log` / `git rev-list` / `git cat-file` fails (e.g. remote sha unknown locally --
    run `git fetch`);
  * a pushed ref or tag chain that ends at an object that is not a commit, tree or blob;
  * content that cannot be decoded reliably while a deal is active: a corrupt or encrypted
    archive, one over the size / member / depth caps, 7z / rar / zstd archives, and PDFs
    (PDF text is often compressed AND glyph-encoded, so no byte scan can prove it clean) --
    verify such a push by hand, then `git push --no-verify`;
  * ORA_PREPUSH_REQUIRE_REFS=1 and no ref lines arrived on stdin.
A roster with no active deal (all closed) allows every push without scanning, as does one
whose active deals carry no `always` and no `context` term at all (anchors alone cannot
block). An active deal with context terms and no always terms is SCANNED, never fast-pathed.

Residual (not covered):
  * text inside images, OCR-only scans, raw zlib / lzma-alone streams, PNG zTXt chunks, and
    encodings other than those listed above (URL-encoding nested past 4 rounds included);
  * a context term and its anchor split across two commits, or across two blobs of a tree
    pushed through a tag;
  * zero-width characters or combining marks inside an always / context term (anchors are
    tightened, terms are not);
  * URL-encoded or tag-split anchors with invisible characters inside (the tight reading
    covers the raw and entity-decoded text only);
  * a term interleaved with markup whose total span exceeds the slice overlap AND straddles a
    256 KB slice edge;
  * history the destination already advertises is not rescanned (it is already public).

Exit 0 = allow, 1 = block (git pre-push convention). Bypass for a verified-clean push is a
human's `git push --no-verify`; there is deliberately no environment-variable bypass.
"""
import html
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.parse

ZERO = "0"
ROSTER_RELPATH = (".claude", "hooks", "confidential-terms.json")

MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024  # decompressed bytes allowed per pushed blob
MAX_MEMBERS = 20000
MAX_DEPTH = 3
MIN_SQUASHED_LEN = 5
WITHHELD = "<withheld: contains a confidential term>"
MAX_URL_DECODE_ROUNDS = 4
# Window overlap factor: 4 URL rounds can turn one character into 9 (`%252525XX`), plus
# markup / entity slack. See scan_text.
OVERLAP_FACTOR = 16

# Mirror of the guard's deletion set (~/.claude/hooks/confidentiality-guard.py _TABLE_MN and
# _TABLE_FMT, Unicode 17 fixed tables, pinned by hash in the tests). Used for anchors only.
_TABLE_MN = "300-36f,483-487,591-5bd,5bf,5c1-5c2,5c4-5c5,5c7,610-61a,64b-65f,670,6d6-6dc,6df-6e4,6e7-6e8,6ea-6ed,711,730-74a,7a6-7b0,7eb-7f3,7fd,816-819,81b-823,825-827,829-82d,859-85b,897-89f,8ca-8e1,8e3-902,93a,93c,941-948,94d,951-957,962-963,981,9bc,9c1-9c4,9cd,9e2-9e3,9fe,a01-a02,a3c,a41-a42,a47-a48,a4b-a4d,a51,a70-a71,a75,a81-a82,abc,ac1-ac5,ac7-ac8,acd,ae2-ae3,afa-aff,b01,b3c,b3f,b41-b44,b4d,b55-b56,b62-b63,b82,bc0,bcd,c00,c04,c3c,c3e-c40,c46-c48,c4a-c4d,c55-c56,c62-c63,c81,cbc,cbf,cc6,ccc-ccd,ce2-ce3,d00-d01,d3b-d3c,d41-d44,d4d,d62-d63,d81,dca,dd2-dd4,dd6,e31,e34-e3a,e47-e4e,eb1,eb4-ebc,ec8-ece,f18-f19,f35,f37,f39,f71-f7e,f80-f84,f86-f87,f8d-f97,f99-fbc,fc6,102d-1030,1032-1037,1039-103a,103d-103e,1058-1059,105e-1060,1071-1074,1082,1085-1086,108d,109d,135d-135f,1712-1714,1732-1733,1752-1753,1772-1773,17b4-17b5,17b7-17bd,17c6,17c9-17d3,17dd,180b-180d,180f,1885-1886,18a9,1920-1922,1927-1928,1932,1939-193b,1a17-1a18,1a1b,1a56,1a58-1a5e,1a60,1a62,1a65-1a6c,1a73-1a7c,1a7f,1ab0-1abd,1abf-1add,1ae0-1aeb,1b00-1b03,1b34,1b36-1b3a,1b3c,1b42,1b6b-1b73,1b80-1b81,1ba2-1ba5,1ba8-1ba9,1bab-1bad,1be6,1be8-1be9,1bed,1bef-1bf1,1c2c-1c33,1c36-1c37,1cd0-1cd2,1cd4-1ce0,1ce2-1ce8,1ced,1cf4,1cf8-1cf9,1dc0-1dff,20d0-20dc,20e1,20e5-20f0,2cef-2cf1,2d7f,2de0-2dff,302a-302d,3099-309a,a66f,a674-a67d,a69e-a69f,a6f0-a6f1,a802,a806,a80b,a825-a826,a82c,a8c4-a8c5,a8e0-a8f1,a8ff,a926-a92d,a947-a951,a980-a982,a9b3,a9b6-a9b9,a9bc-a9bd,a9e5,aa29-aa2e,aa31-aa32,aa35-aa36,aa43,aa4c,aa7c,aab0,aab2-aab4,aab7-aab8,aabe-aabf,aac1,aaec-aaed,aaf6,abe5,abe8,abed,fb1e,fe00-fe0f,fe20-fe2f,101fd,102e0,10376-1037a,10a01-10a03,10a05-10a06,10a0c-10a0f,10a38-10a3a,10a3f,10ae5-10ae6,10d24-10d27,10d69-10d6d,10eab-10eac,10efa-10eff,10f46-10f50,10f82-10f85,11001,11038-11046,11070,11073-11074,1107f-11081,110b3-110b6,110b9-110ba,110c2,11100-11102,11127-1112b,1112d-11134,11173,11180-11181,111b6-111be,111c9-111cc,111cf,1122f-11231,11234,11236-11237,1123e,11241,112df,112e3-112ea,11300-11301,1133b-1133c,11340,11366-1136c,11370-11374,113bb-113c0,113ce,113d0,113d2,113e1-113e2,11438-1143f,11442-11444,11446,1145e,114b3-114b8,114ba,114bf-114c0,114c2-114c3,115b2-115b5,115bc-115bd,115bf-115c0,115dc-115dd,11633-1163a,1163d,1163f-11640,116ab,116ad,116b0-116b5,116b7,1171d,1171f,11722-11725,11727-1172b,1182f-11837,11839-1183a,1193b-1193c,1193e,11943,119d4-119d7,119da-119db,119e0,11a01-11a0a,11a33-11a38,11a3b-11a3e,11a47,11a51-11a56,11a59-11a5b,11a8a-11a96,11a98-11a99,11b60,11b62-11b64,11b66,11c30-11c36,11c38-11c3d,11c3f,11c92-11ca7,11caa-11cb0,11cb2-11cb3,11cb5-11cb6,11d31-11d36,11d3a,11d3c-11d3d,11d3f-11d45,11d47,11d90-11d91,11d95,11d97,11ef3-11ef4,11f00-11f01,11f36-11f3a,11f40,11f42,11f5a,13440,13447-13455,1611e-16129,1612d-1612f,16af0-16af4,16b30-16b36,16f4f,16f8f-16f92,16fe4,1bc9d-1bc9e,1cf00-1cf2d,1cf30-1cf46,1d167-1d169,1d17b-1d182,1d185-1d18b,1d1aa-1d1ad,1d242-1d244,1da00-1da36,1da3b-1da6c,1da75,1da84,1da9b-1da9f,1daa1-1daaf,1e000-1e006,1e008-1e018,1e01b-1e021,1e023-1e024,1e026-1e02a,1e08f,1e130-1e136,1e2ae,1e2ec-1e2ef,1e4ec-1e4ef,1e5ee-1e5ef,1e6e3,1e6e6,1e6ee-1e6ef,1e6f5,1e8d0-1e8d6,1e944-1e94a,e0100-e01ef"
_TABLE_FMT = "0-8,e-1b,7f-84,86-9f,ad,600-605,61c,6dd,70f,890-891,8e2,115f-1160,180e,200b-200f,202a-202e,2060-206f,2800,3164,feff,ffa0,fff0-fffb,110bd,110cd,13430-1343f,1bca0-1bca3,1d173-1d17a,e0000-e00ff,e01f0-e0fff"


def _ranges(spec):
    out = []
    for r in spec.split(","):
        a, _, b = r.partition("-")
        out.append((int(a, 16), int(b or a, 16)))
    return out


_T_GUARD_TIGHT = {c: None for a, b in _ranges(_TABLE_MN) + _ranges(_TABLE_FMT)
                  for c in range(a, b + 1)}
_T_SUPERSCRIPT = {c: None for a, b in ((0xB2, 0xB3), (0xB9, 0xB9), (0x2070, 0x2070),
                                       (0x2074, 0x2079), (0x2080, 0x2089))
                  for c in range(a, b + 1)}


# The only ASCII characters in the guard's deletion set (_TABLE_FMT: 0-8, e-1b, 7f).
_ASCII_DELETED_RE = re.compile(r"[\x00-\x08\x0e-\x1b\x7f]")


def _guard_tight(t):
    """The guard's tight form (_tight_form): superscript digits deleted, NFKD, lowercase,
    combining marks and the invisible set deleted, whitespace runs collapsed."""
    c = unicodedata.normalize("NFKD", t.translate(_T_SUPERSCRIPT)).lower()
    return " ".join(c.translate(_T_GUARD_TIGHT).split())


# The ONLY spelling of the git command in this module (a test enforces it); every call goes
# through _git() or the cat-file Popen, both with _git_env(). No replace objects: the scan
# must read exactly what pack-objects sends. Pin everything that could change what `git log`
# prints: no external diff, no textconv, no colour, unquoted paths, UTF-8 output regardless
# of i18n.logOutputEncoding, no signature lines before a commit (log.showSignature), no diff
# limited to the cwd (diff.relative). format.pretty / log.decorate / log.abbrevCommit do not
# reach an explicit --format without %d, and --no-ext-diff / --no-textconv / --no-renames /
# --no-abbrev are passed per call. Parsers still fail closed on any line they do not know.
GIT_BASE = ["git", "--no-replace-objects", "-c", "core.quotepath=off",
            "-c", "diff.noprefix=false", "-c", "i18n.logOutputEncoding=UTF-8",
            "-c", "log.showSignature=false", "-c", "color.ui=false",
            "-c", "diff.relative=false"]

SEP_RE = re.compile(r"[\s_.\- ­‐-―]+")
TAG_RE = re.compile(r"<[^<>]{0,4000}>")


class Unscannable(Exception):
    pass


def _git_env():
    """The hook's environment with replace refs disabled: GIT_NO_REPLACE_OBJECTS=1, and
    GIT_REPLACE_REF_BASE removed so it cannot point the lookup anywhere else."""
    env = dict(os.environ)
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    env.pop("GIT_REPLACE_REF_BASE", None)
    return env


def _git(args, cwd=None, text=False, input=None, timeout=None):
    """The ONE way this module runs git (a test enforces it): GIT_BASE + args. stdin is
    `input` or empty (never the hook's own stdin); git never prompts."""
    env = _git_env()
    env["GIT_TERMINAL_PROMPT"] = "0"
    kw = {"input": input} if input is not None else {"stdin": subprocess.DEVNULL}
    return subprocess.run(GIT_BASE + list(args), capture_output=True, cwd=cwd, text=text,
                          env=env, timeout=timeout, **kw)


# --------------------------------------------------------------------------- matching
def normalize(s):
    """NFKC + casefold, every separator run collapsed to one space."""
    return SEP_RE.sub(" ", unicodedata.normalize("NFKC", s).casefold())


def _squash(s):
    return s.replace(" ", "")


WINDOW = 256 * 1024
MIN_OVERLAP = 8192


def _url_views(cands, plus_terms):
    """URL-decoded readings of each candidate: unquote_plus (`+` -> space) and, only when a
    roster string contains `+` (plus_terms), plain unquote (a literal `+` kept); repeated on
    every NEW reading until nothing changes or MAX_URL_DECODE_ROUNDS rounds have run (round 2
    unwraps `%2520`, round 3 `%252520`, round 4 `%25252520`)."""
    seen = set(cands)
    out, frontier = [], list(cands)
    for _ in range(MAX_URL_DECODE_ROUNDS):
        nxt = []
        for c in frontier:
            if "%" not in c and "+" not in c:
                continue
            ds = [urllib.parse.unquote_plus(c)]
            if plus_terms and "%" in c and "+" in c:  # else it adds nothing unquote_plus lacks
                ds.append(urllib.parse.unquote(c))
            for d in ds:
                if d not in seen:
                    seen.add(d)
                    nxt.append(d)
        if not nxt:
            break
        out += nxt
        frontier = nxt
    return out


def _scan_window(text, terms, found, plus_terms, tight=()):
    cands = [text]
    if "&" in text:
        cands.append(html.unescape(text))
    # Tag-strip the raw / entity-decoded readings only; URL-decoding reads those same two
    # (an encoded term inside an href survives there). Keeps the worst case near 2x.
    cands += [TAG_RE.sub("", c) for c in list(cands) if "<" in c] + _url_views(cands, plus_terms)
    for c in cands:
        n = normalize(c)
        for i, t in enumerate(terms):
            if i in found:
                continue
            # The separator-free form is matched only for MULTI-word terms and only against
            # the normalized text (never a separator-free copy of it), so word boundaries in
            # the text still count: "LOI_<TermNoSpaces>" and "<w:t>A</w:t><w:t>B" match,
            # "east on" never matches a one-word term like "easton" (REFUTE round 2, N1).
            if t in n or (" " in t and len(_squash(t)) >= MIN_SQUASHED_LEN
                          and _squash(t) in n):
                found.add(i)
    # Anchors (`tight` indices) are also looked for in the guard's tight form of the raw and
    # entity-decoded text, as find_hit() does: `anchor<WORD JOINER>q7` and an anchor with a
    # stray combining mark are present. Only anchors: always / context terms are not.
    todo = [i for i in tight if i not in found]
    if todo:
        for c in cands[:2]:
            if c.isascii() and not _ASCII_DELETED_RE.search(c):
                continue  # nothing for the tight form to delete: same as the plain reading
            n = normalize(_guard_tight(c))
            for i in todo:
                if terms[i] in n:
                    found.add(i)


def scan_text(text, terms, tight=()):
    """Sorted indices of (already-normalized) terms present in text -- never the terms.
    Raw presence only: Roster.blocking() decides which of them block. `tight`: indices
    (anchors) also matched against the guard's tight form of the text.

    Large texts are scanned in overlapping windows: NFKC on one multi-MB string is
    super-linear (REFUTE round 2, N2: 16 s for 4 MB). The overlap (OVERLAP_FACTOR = 16x the
    longest term, at least MIN_OVERLAP = 8192 characters) covers a term in up to 4 rounds of
    URL-encoding (9 characters per character) at a window edge. It does NOT bound markup:
    TAG_RE strips tags up to 4000 characters each, so a term interleaved with tags whose
    total span exceeds the overlap, sitting exactly on a slice edge, can be missed
    (documented residual). These slices are a performance device, not the context-term
    window: indices found in every slice of one text are pooled first."""
    found = set()
    plus_terms = any("+" in t for t in terms)
    if len(text) <= WINDOW:
        _scan_window(text, terms, found, plus_terms, tight)
        return sorted(found)
    overlap = max(MIN_OVERLAP, OVERLAP_FACTOR * max((len(t) for t in terms), default=0))
    step = WINDOW - overlap
    for start in range(0, len(text), step):
        _scan_window(text[start:start + WINDOW], terms, found, plus_terms, tight)
        if len(found) == len(terms) or start + WINDOW >= len(text):
            break
    return sorted(found)


def name_found(name, roster):
    """Raw indices in a path / ref name, read as text and as its raw bytes through every
    text view (a cp1252 or UTF-16 path)."""
    found = set(roster.scan(name))
    for view in text_views(name.encode("utf-8", "surrogateescape")):
        found.update(roster.scan(view))
    return found


def shown(name, roster):
    return WITHHELD if name_found(name, roster) else name


# --------------------------------------------------------------------------- roster
def roster_path():
    """~/.claude/hooks/confidential-terms.json. On Windows expanduser reads USERPROFILE."""
    return os.path.join(os.path.expanduser("~"), *ROSTER_RELPATH)


TERM_FIELDS = ("always", "context", "context_requires_any")


class Roster:
    """The active roster as matchable data.

    terms   -- sorted, deduplicated normalized vocabulary: every active always, context and
               anchor string. Reported indices point into this list.
    uncond  -- indices that block on their own (always terms, plus the context terms of a
               deal with no usable anchor).
    groups  -- [(anchor indices, context indices)]: the context indices block only when one
               of the anchor indices was found in the same window.
    tight   -- every anchor index (also matched against the guard's tight form of a text)."""

    def __init__(self, terms, uncond, groups):
        self.terms, self.uncond, self.groups = terms, frozenset(uncond), groups
        self.tight = tuple(sorted({i for anchors, _ctx in groups for i in anchors}))

    def scan(self, text):
        """Raw indices present in one text (see scan_text)."""
        return scan_text(text, self.terms, self.tight)

    def can_block(self):
        return bool(self.uncond) or any(ctx for _anchors, ctx in self.groups)

    def blocking(self, found):
        """Sorted blocking indices among `found`, the indices present in ONE window."""
        found = set(found)
        out = found & self.uncond
        for anchors, ctx in self.groups:
            if found & anchors:
                out |= found & ctx
        return sorted(out)

    def hits(self, text):
        """Blocking indices in one text treated as one window."""
        return self.blocking(self.scan(text))


def _blank(t):
    """True for an anchor the guard treats as blank: its tight form is empty."""
    return not _guard_tight(t)


def _unusable_anchor(t):
    """No match form once tightened and normalized: blank, separators and invisibles only."""
    return _blank(t) or not normalize(_guard_tight(t)).strip() or not _anchor_forms(t)


def _anchor_forms(t):
    """Normalized match forms of one usable anchor: as written, and its guard tight form."""
    return sorted({f for f in (normalize(t).strip(), normalize(_guard_tight(t)).strip()) if f})


def load_roster(path=None):
    """Roster, or None when the roster cannot be read or any deal entry is malformed
    (fail-closed: we cannot prove we know its terms).

    A deal counts unless it explicitly says `"active": false` (a missing flag is treated as
    active). A key starting with "_" is metadata (e.g. `_meta`) unless it carries one of
    `always` / `context` / `context_requires_any`. Each of those fields, when present, must be
    a list of strings (null is malformed), on inactive deals too."""
    path = path or roster_path()
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    deals = []
    for key, deal in data.items():
        if key.startswith("_") and not (isinstance(deal, dict)
                                        and any(f in deal for f in TERM_FIELDS)):
            continue
        if not isinstance(deal, dict):
            return None
        raw = {}
        for field in TERM_FIELDS:
            v = deal.get(field, [])
            if not isinstance(v, list) or not all(isinstance(t, str) for t in v):
                return None
            raw[field] = v
        if deal.get("active", True) is False:
            continue
        always = [n for n in (normalize(t).strip() for t in raw["always"]) if n]
        context = [n for n in (normalize(t).strip() for t in raw["context"]) if n]
        if (raw["always"] or raw["context"]) and not (always or context):
            return None  # declares terms, none usable: cannot know what to look for
        anchors_raw = raw["context_requires_any"]
        # An anchor with no match form (blank, or separators only: `-`, `_`, `.`) would
        # leave a group that can never fire: treat the group as unanchored instead.
        unanchored = not anchors_raw or any(_unusable_anchor(a) for a in anchors_raw)
        anchors = [] if unanchored else [f for a in anchors_raw for f in _anchor_forms(a)]
        deals.append((always, context, anchors, unanchored))
    terms = sorted({t for a, c, an, _u in deals for t in a + c + an})
    idx = {t: i for i, t in enumerate(terms)}
    uncond, groups = set(), []
    for always, context, anchors, unanchored in deals:
        uncond.update(idx[t] for t in always)
        if not context:
            continue
        if unanchored:
            uncond.update(idx[t] for t in context)
        else:
            groups.append((frozenset(idx[t] for t in anchors),
                           frozenset(idx[t] for t in context)))
    return Roster(terms, uncond, groups)


def load_terms(path=None):
    """The roster's normalized vocabulary (sorted), or None when it is unreadable / malformed.
    Kept for callers that only need the strings; matching goes through load_roster()."""
    r = load_roster(path)
    return None if r is None else r.terms


# --------------------------------------------------------------------------- refs / range
def _is_sha(s):
    return len(s) in (40, 64) and all(c in "0123456789abcdef" for c in s.lower())


def parse_pushrefs(text):
    """Pre-push stdin lines: '<local_ref> <local_sha> <remote_ref> <remote_sha>'."""
    refs = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 4 and _is_sha(parts[1]) and _is_sha(parts[3]):
            refs.append(tuple(parts))
    return refs


LS_REMOTE_TIMEOUT = 60  # seconds


def destination_bound(remote, url, cwd=None):
    """Local commit shas the push destination advertises (`git ls-remote`), or [] when it
    cannot be asked or advertises nothing usable (the caller then scans full history).
    `url` is the hook's argv[2] (the push URL), `remote` its argv[1]."""
    target = url or remote
    if not target or target.startswith("-"):
        return []
    try:
        p = _git(["ls-remote", target], cwd, timeout=LS_REMOTE_TIMEOUT)
    except (subprocess.TimeoutExpired, OSError):
        return []
    if p.returncode != 0:
        return []
    advertised = []
    for line in p.stdout.decode("utf-8", "surrogateescape").splitlines():
        sha = line.split("\t", 1)[0].strip()
        if _is_sha(sha) and sha not in advertised:
            advertised.append(sha)
    if not advertised:
        return []
    q = _git(["cat-file", "--batch-check"], cwd,
             input="".join("%s^{commit}\n" % sha for sha in advertised).encode())
    if q.returncode != 0:
        return []
    out = []
    for line in q.stdout.decode("ascii", "replace").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "commit" and _is_sha(parts[0]) \
                and parts[0] not in out:
            out.append(parts[0])
    return out


class RevRange:
    """Revision arguments for one pushed ref: `args` on the command line, `exclude` shas as
    `^<sha>` lines on --stdin (any number of them, no command-line cap)."""

    def __init__(self, args, exclude=()):
        self.args, self.exclude = list(args), list(exclude)

    def git_args(self):
        return self.args + (["--stdin"] if self.exclude else [])

    def stdin(self):
        return "".join("^%s\n" % sha for sha in self.exclude) if self.exclude else None

    def __str__(self):
        extra = " (minus %d advertised commits)" % len(self.exclude) if self.exclude else ""
        return " ".join(self.args) + extra


def rev_range(local_sha, remote_sha, bound):
    """What one pushed ref makes new on the destination. `bound`: destination_bound()."""
    if set(remote_sha) != {ZERO}:
        return RevRange([local_sha, "^" + remote_sha])
    return RevRange([local_sha], bound or ())  # nothing advertised: full history


# --------------------------------------------------------------------------- objects
def _b(text):
    return None if text is None else text.encode()


def range_commits(rng, cwd=None):
    p = _git(["rev-list"] + rng.git_args(), cwd, text=True, input=rng.stdin())
    if p.returncode != 0:
        raise Unscannable("`git rev-list` failed for the pushed range")
    return [s for s in p.stdout.split() if s]


def range_blobs(rng, cwd=None):
    """[(commit_sha, path, blob_sha)] for every blob added or modified anywhere in rng, merges
    included (--cc lists what a merge resolution changed relative to every parent); the same
    blob is listed once per commit that introduces it. RAISES Unscannable."""
    marker = "ORA-PREPUSH-" + os.urandom(16).hex()
    p = _git(["log", "--raw", "--cc", "--root", "-z", "--no-abbrev", "--no-renames",
              "--no-color", "--format=" + marker + "%H"] + rng.git_args(), cwd,
             input=_b(rng.stdin()))
    if p.returncode != 0:
        raise Unscannable("`git log --raw` failed for the pushed range")
    return parse_raw_log(p.stdout, marker)


def parse_raw_log(stdout, marker):
    """Parse `git log --raw -z --format=<marker>%H` output into [(commit, path, blob)].
    Any non-empty field that is neither a marker nor a raw record RAISES Unscannable: an
    unexpected line (a signature, colour codes) could otherwise shift blobs onto the wrong
    commit."""
    fields = stdout.decode("utf-8", "surrogateescape").split("\0")
    out, seen, commit = [], set(), None
    i = 0
    while i < len(fields):
        meta = fields[i].lstrip("\n")
        if meta.startswith(marker):
            commit = meta[len(marker):].strip()
            if not _is_sha(commit):
                raise Unscannable("unparseable `git log --raw` commit line")
            i += 1
            continue
        if not meta.startswith(":"):
            if meta.strip():
                raise Unscannable("unrecognised `git log --raw` output")
            i += 1
            continue
        if commit is None:
            raise Unscannable("`git log --raw` record before any commit line")
        path = fields[i + 1] if i + 1 < len(fields) else ""
        i += 2
        nparents = len(meta) - len(meta.lstrip(":"))
        parts = meta.lstrip(":").split()
        if len(parts) < 2 * nparents + 3:
            raise Unscannable("unparseable `git log --raw` record")
        new_mode, new_sha = parts[nparents], parts[2 * nparents + 1]
        if set(new_sha) == {ZERO} or new_mode == "160000":
            continue  # deletion or submodule (a symlink's blob is its target text: scanned)
        if (commit, path, new_sha) not in seen:
            seen.add((commit, path, new_sha))
            out.append((commit, path, new_sha))
    return out


def iter_objects(shas, cwd=None):
    """Yield (sha, type, bytes) one object at a time from one `git cat-file --batch`.
    RAISES Unscannable on a git failure or a missing object."""
    if not shas:
        return
    proc = subprocess.Popen(GIT_BASE + ["cat-file", "--batch"], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=cwd,
                            env=_git_env())
    try:
        for sha in shas:
            proc.stdin.write((sha + "\n").encode())
            proc.stdin.flush()
            header = proc.stdout.readline().decode("ascii", "replace").split()
            if len(header) < 3 or header[1] == "missing":
                raise Unscannable("object %s unreadable" % sha[:12])
            size = int(header[2])
            data = proc.stdout.read(size)
            proc.stdout.read(1)  # trailing newline
            if len(data) != size:
                raise Unscannable("short read for object %s" % sha[:12])
            yield sha, header[1], data
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.kill()
        proc.wait()


# --------------------------------------------------------------------------- content
def text_views(data):
    """Every text reading of a byte buffer: utf-8 and cp1252 (errors ignored), plus UTF-16 LE
    and BE at byte offsets 0 and 1 -- a UTF-16 string can sit at any offset inside a binary,
    and decoding all four costs a few passes but cannot pick the wrong one."""
    views = [data.decode("utf-8", "ignore"), data.decode("cp1252", "ignore")]
    if len(data) >= 4:
        for off in (0, 1):
            for enc in ("utf-16-le", "utf-16-be"):
                views.append(data[off:].decode(enc, "ignore"))
    return views


def sniff(data):
    """Container kind by magic bytes (never by extension), or None for plain content."""
    if data[:2] == b"\x1f\x8b":
        return "gzip"
    if data[:3] == b"BZh":
        return "bz2"
    if data[:6] == b"\xfd7zXZ\x00":
        return "xz"
    if data[:4] == b"PK\x03\x04":
        return "zip"
    if data[:6] == b"7z\xbc\xaf\x27\x1c":
        return "7z (unsupported)"
    if data[:6] == b"Rar!\x1a\x07":
        return "rar (unsupported)"
    if data[:4] == b"\x28\xb5\x2f\xfd":
        return "zstd (unsupported)"
    if b"%PDF-" in data[:1024]:
        return "pdf (text is not reliably decodable)"
    if data[257:262] == b"ustar":
        return "tar"
    import io
    import zipfile
    try:
        if zipfile.is_zipfile(io.BytesIO(data)):  # prefixed / self-extracting zip
            return "zip"
    except Exception:
        pass
    return None


def _stream_decompress(make, data, take):
    """Run a bz2/lzma decompressor over possibly multi-stream data, bounded by `take`."""
    out = []
    while data:
        d = make()
        while True:
            chunk = d.decompress(data, max_length=1024 * 1024)
            take(len(chunk))
            out.append(chunk)
            data = b""
            if d.eof:
                data = d.unused_data.lstrip(b"\0")  # xz stream padding is legal
                break
            if d.needs_input:
                raise Unscannable("truncated stream")
    return b"".join(out)


def expand(data, budget, depth=0):
    """Every text view of `data` and, recursively, of whatever it decompresses to.
    RAISES Unscannable on anything that cannot be fully and reliably read. `budget` is a
    one-item list of decompressed bytes still allowed for the top-level blob."""
    import bz2
    import gzip
    import io
    import lzma
    import tarfile
    import zipfile
    if depth > MAX_DEPTH:
        raise Unscannable("archives nested deeper than %d" % MAX_DEPTH)

    def take(n):
        budget[0] -= n
        if budget[0] < 0:
            raise Unscannable("decompressed size over the %d MB per-file cap"
                              % (MAX_DECOMPRESSED_BYTES // (1024 * 1024)))

    out = text_views(data)
    kind = sniff(data)
    if kind is None:
        return out
    if "(" in kind:
        raise Unscannable(kind)
    try:
        if kind == "gzip":
            with gzip.GzipFile(fileobj=io.BytesIO(data)) as gz:
                inner = gz.read(budget[0] + 1)
            take(len(inner))
            out += expand(inner, budget, depth + 1)
        elif kind == "bz2":
            out += expand(_stream_decompress(bz2.BZ2Decompressor, data, take), budget, depth + 1)
        elif kind == "xz":
            out += expand(_stream_decompress(lzma.LZMADecompressor, data, take), budget,
                          depth + 1)
        elif kind == "tar":
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as tf:
                members = tf.getmembers()
                if len(members) > MAX_MEMBERS:
                    raise Unscannable("too many tar members")
                for m in members:
                    if not m.isfile():
                        continue
                    fh = tf.extractfile(m)
                    if fh is None:
                        raise Unscannable("unreadable tar member")
                    out += expand(fh.read(), budget, depth + 1)
        else:  # zip
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                infos = zf.infolist()
                if len(infos) > MAX_MEMBERS:
                    raise Unscannable("too many zip members")
                for info in infos:
                    out.append(info.filename)
                    if info.is_dir():
                        continue
                    with zf.open(info) as fh:
                        mdata = fh.read(budget[0] + 1)
                    take(len(mdata))
                    out += expand(mdata, budget, depth + 1)
    except Unscannable:
        raise
    except Exception as e:  # corrupt stream, encrypted member, unsupported method, ...
        raise Unscannable(type(e).__name__)
    return out


def scan_blobs(rng, roster, cwd=None):
    """(hits, unscannable, per_commit) over every blob added or modified in rng. One blob --
    all of its text views, decompressed members and pushed paths -- is one context window.
    hits: [(shown_path, indices)]; unscannable: [reason]; per_commit: {commit sha: raw
    indices of the content and path of every blob that commit introduces}, which the
    caller pools into that commit's window."""
    try:
        entries = range_blobs(rng, cwd)
    except (Unscannable, ValueError, OSError) as e:
        return [], ["blob enumeration failed (%s)" % e], {}
    return scan_blob_entries(entries, roster, cwd)


def tree_blobs(tree_sha, cwd=None):
    """[(None, path, blob_sha)] for every blob in a tree, recursively. RAISES Unscannable."""
    p = _git(["ls-tree", "-r", "-z", "--full-tree", tree_sha], cwd)
    if p.returncode != 0:
        raise Unscannable("`git ls-tree` failed for a pushed tree")
    out = []
    for rec in p.stdout.decode("utf-8", "surrogateescape").split("\0"):
        if not rec.strip():
            continue
        meta, sep, path = rec.partition("\t")
        parts = meta.split()
        if not sep or len(parts) != 3:
            raise Unscannable("unparseable `git ls-tree` record")
        if parts[1] == "blob":
            out.append((None, path, parts[2]))
        elif parts[1] != "commit":  # a gitlink names another repo's commit: nothing sent
            raise Unscannable("unexpected `git ls-tree` entry type")
    return out


def scan_blob_entries(entries, roster, cwd=None):
    """scan_blobs over [(commit or None, path, blob_sha)]."""
    hits, bad, per_commit = [], [], {}
    try:
        paths_by_sha, commits_by_sha = {}, {}
        for commit, path, sha in entries:
            if path not in paths_by_sha.setdefault(sha, []):
                paths_by_sha[sha].append(path)
            if commit is not None:
                commits_by_sha.setdefault(sha, []).append((commit, path))
                per_commit.setdefault(commit, set()).update(name_found(path, roster))
        for sha, _typ, blob in iter_objects(sorted(paths_by_sha), cwd):
            path = shown(paths_by_sha[sha][0], roster)
            try:
                texts = expand(blob, [MAX_DECOMPRESSED_BYTES])
            except Unscannable as e:
                bad.append("%s: %s" % (path, e))
                continue
            found = set()
            for text in texts:
                found.update(roster.scan(text))
            for commit, _p in commits_by_sha.get(sha, ()):
                per_commit[commit].update(found)
            for p in paths_by_sha[sha]:
                found.update(name_found(p, roster))
            blocking = roster.blocking(found)
            if blocking:
                hits.append((path, blocking))
    except (Unscannable, ValueError, OSError) as e:
        bad.append("blob enumeration failed (%s)" % e)
    return hits, bad, per_commit


def commit_object_found(rng, roster, cwd=None):
    """{commit sha: raw indices} found in the raw commit objects of rng: message, author /
    committer, mergetag and encoding headers -- a legacy-encoded message is read through
    every view. RAISES Unscannable."""
    out = {}
    for sha, _typ, data in iter_objects(range_commits(rng, cwd), cwd):
        found = out.setdefault(sha, set())
        for text in text_views(data):
            found.update(roster.scan(text))
    return out


def patch_found(rng, roster, cwd=None):
    """{commit sha: raw indices} found in each commit's own `git log -p --cc` output (its
    re-encoded message and its patch). Commits are split on a per-run random marker that no
    pushed content can forge. RAISES Unscannable."""
    marker = "ORA-PREPUSH-" + os.urandom(16).hex()
    p = _git(["log", "-p", "--cc", "--root", "--no-color", "--no-ext-diff", "--no-textconv",
              "--format=" + marker + "%H%n%an <%ae>%n%cn <%ce>%n%B"] + rng.git_args(), cwd,
             input=_b(rng.stdin()))
    if p.returncode != 0:
        raise Unscannable("`git log -p %s` failed (remote sha unknown locally? run "
                          "`git fetch` first)" % rng)
    out = {}
    chunks = p.stdout.decode("utf-8", "ignore").split(marker)
    if chunks[0].strip():
        raise Unscannable("unparseable `git log -p` output")
    for chunk in chunks[1:]:
        sha = chunk[:64].split("\n", 1)[0].strip()
        if not _is_sha(sha):
            raise Unscannable("unparseable `git log -p` output")
        out.setdefault(sha, set()).update(roster.scan(chunk))
    return out


def tag_chain_hits(local_sha, roster, cwd=None):
    """(blocking indices, final sha, final type) after peeling local_sha through every
    annotated tag object (a tag of a tag transfers both objects); each tag object is one
    window. RAISES Unscannable."""
    found, sha = set(), local_sha
    for _ in range(16):
        objs = list(iter_objects([sha], cwd))
        _s, typ, data = objs[0]
        if typ != "tag":
            return sorted(found), sha, typ
        one = set()
        for text in text_views(data):
            one.update(roster.scan(text))
        found.update(roster.blocking(one))
        first = data.split(b"\n", 1)[0].decode("ascii", "replace").split()
        if len(first) != 2 or first[0] != "object" or not _is_sha(first[1]):
            raise Unscannable("unparseable tag object")
        sha = first[1]
    raise Unscannable("tag chain longer than 16")


# --------------------------------------------------------------------------- main
def scan_ref(local_ref, local_sha, remote_ref, remote_sha, roster, bound, cwd=None):
    """List of block messages for one pushed ref (empty = clean)."""
    msgs = []
    label = shown(local_ref, roster)
    name_hits = sorted(set(roster.blocking(name_found(local_ref, roster))
                           + roster.blocking(name_found(remote_ref, roster))))
    if name_hits:
        msgs.append("a pushed ref NAME contains confidential term(s) (indices %s)." % name_hits)
    try:
        t_hits, final_sha, final_type = tag_chain_hits(local_sha, roster, cwd)
    except Unscannable as e:
        msgs.append("(fail-closed) could not read the pushed object for %s: %s" % (label, e))
        return msgs
    if t_hits:
        msgs.append("confidential term(s) (indices %s) in an annotated tag message of %s."
                    % (t_hits, label))
    if final_type in ("blob", "tree"):
        # A ref or tag pointing straight at a blob / tree: no commit range to walk. A blob is
        # one window with the pushed ref name; a tree is every blob in it.
        try:
            entries = ([(None, local_ref, final_sha)] if final_type == "blob"
                       else tree_blobs(final_sha, cwd))
        except Unscannable as e:
            msgs.append("(fail-closed) the %s pushed on %s could not be read: %s"
                        % (final_type, label, e))
            return msgs
        b_hits, b_bad, _ = scan_blob_entries(entries, roster, cwd)
        if b_hits:
            msgs.append("confidential term(s) inside the %s pushed on %s: %s."
                        % (final_type, label, "; ".join("%s -> indices %s" % h for h in b_hits)))
        if b_bad:
            msgs.append("(fail-closed) the %s pushed on %s cannot be proven clean by this "
                        "scan (verify by hand, then --no-verify): %s"
                        % (final_type, label, "; ".join(b_bad)))
        return msgs
    if final_type != "commit":
        msgs.append("(fail-closed) %s points at an object of unexpected type %r."
                    % (label, final_type))
        return msgs
    rng = rev_range(local_sha, remote_sha, bound)
    # One commit = one window: its raw object (every view), its own patch, and the content
    # and path of every blob it introduces (scan_blobs) -- see "Context terms" above.
    try:
        per_commit = patch_found(rng, roster, cwd)
    except Unscannable as e:
        msgs.append("(fail-closed) %s for %s." % (e, label))
        return msgs
    try:
        for sha, found in commit_object_found(rng, roster, cwd).items():
            per_commit.setdefault(sha, set()).update(found)
    except Unscannable as e:
        msgs.append("(fail-closed) commit objects for %s could not be read: %s" % (label, e))
    b_hits, b_bad, blob_commits = scan_blobs(rng, roster, cwd)
    for sha, found in blob_commits.items():
        per_commit.setdefault(sha, set()).update(found)
    hits = sorted({i for found in per_commit.values() for i in roster.blocking(found)})
    if hits:
        msgs.append("%d confidential term(s) (indices %s) in the commits being pushed on %s "
                    "(range %s: messages, diffs and the files they add). A clean HEAD does "
                    "not mean a clean push -- rewrite the history first."
                    % (len(hits), hits, label, rng))
    if b_hits:
        msgs.append("confidential term(s) inside file content pushed on %s: %s."
                    % (label, "; ".join("%s -> indices %s" % h for h in b_hits)))
    if b_bad:
        msgs.append("(fail-closed) file(s) pushed on %s cannot be proven clean by this scan "
                    "(verify by hand, then --no-verify): %s" % (label, "; ".join(b_bad)))
    return msgs


def main(stdin_text=None, roster=None, cwd=None, remote=None, url=None):
    """`remote`, `url`: the hook's argv[1] and argv[2]; with neither, new refs are scanned
    in full."""
    try:
        sys.stderr.reconfigure(errors="backslashreplace")
    except Exception:
        pass
    roster = load_roster(roster)
    if roster is None:
        sys.stderr.write("pre-push BLOCKED (fail-closed): the confidential-deal roster "
                         "(~/.claude/hooks/confidential-terms.json) is missing, unreadable or "
                         "malformed -- cannot prove the push is clean (Invariant 3).\n")
        return 1
    if stdin_text is None:
        # Bytes, decoded as UTF-8: on Windows text-mode stdin is cp1252, which would mangle a
        # non-ASCII ref name past both the name check and the withholding of its label.
        stdin_text = sys.stdin.buffer.read().decode("utf-8", "surrogateescape")
    pushrefs = parse_pushrefs(stdin_text)
    # git runs pre-push with EMPTY stdin on an up-to-date push, so zero refs cannot block
    # unconditionally; a caller that guarantees >= 1 ref opts in to the stricter rule.
    if not pushrefs and os.environ.get("ORA_PREPUSH_REQUIRE_REFS") == "1":
        sys.stderr.write("pre-push BLOCKED (fail-closed): zero ref lines on stdin while "
                         "ORA_PREPUSH_REQUIRE_REFS=1.\n")
        return 1
    if not roster.can_block():
        return 0  # no active always / context term: nothing can leak
    needs_bound = any(set(r[1]) != {ZERO} and set(r[3]) == {ZERO} for r in pushrefs)
    bound = destination_bound(remote, url, cwd) if needs_bound else []
    blocked = False
    for local_ref, local_sha, remote_ref, remote_sha in pushrefs:
        if set(local_sha) == {ZERO}:
            continue  # ref deletion: nothing new reaches the remote
        for m in scan_ref(local_ref, local_sha, remote_ref, remote_sha, roster, bound, cwd):
            sys.stderr.write("pre-push BLOCKED: %s\n" % m)
            blocked = True
    if blocked:
        sys.stderr.write("Terms are never printed; indices refer to the active roster's "
                         "sorted, normalized always / context / anchor strings. Bypass only "
                         "after verifying the push is clean: git push --no-verify\n")
    return 1 if blocked else 0


if __name__ == "__main__":
    sys.exit(main(remote=sys.argv[1] if len(sys.argv) > 1 else None,
                  url=sys.argv[2] if len(sys.argv) > 2 else None))
