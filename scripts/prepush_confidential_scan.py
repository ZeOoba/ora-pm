#!/usr/bin/env python3
"""Git pre-push confidentiality gate (Hard Invariant 3) -- fail-closed.

This repo is PUBLIC (Gabriel ruling 2026-11-09), so it is an external surface: no active
confidential deal may reach it before closing. This gate scans everything a push would make
new on the remote and BLOCKS if any active `always` term from the machine-local roster
(~/.claude/hooks/confidential-terms.json, never committed anywhere) appears in it.

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
  * the pushed ref names, and every annotated tag object in a pushed tag's chain.
Matching: NFKC + casefold on both sides; any run of whitespace / `_` / `-` / `.` / NBSP
counts as one separator, and a separator-free form of each MULTI-word term (5+ chars) is
also matched against the normalized text, so `LOI_<TermNoSpaces>_MMDDYYYY` and line-wrapped
or `&nbsp;`-joined names are caught without "east on" matching a one-word "easton".
Range: an existing remote ref scans remote_sha..local_sha. A brand-new remote ref scans
origin/<default>..local_sha (commits not already on the trunk); an orphan branch is
therefore scanned in full, deliberately.

Output never echoes a term: hits are reported as roster indices, and a path or ref name
that itself contains a term is withheld.

FAIL-CLOSED -- each of these BLOCKS the push:
  * roster missing, unreadable, unparseable, not a JSON object, or any deal entry malformed;
  * `git log` / `git rev-list` / `git cat-file` fails (e.g. remote sha unknown locally --
    run `git fetch`);
  * a brand-new ref whose default-branch baseline cannot be resolved;
  * content that cannot be decoded reliably while a deal is active: a corrupt or encrypted
    archive, one over the size / member / depth caps, 7z / rar / zstd archives, and PDFs
    (PDF text is often compressed AND glyph-encoded, so no byte scan can prove it clean) --
    verify such a push by hand, then `git push --no-verify`;
  * ORA_PREPUSH_REQUIRE_REFS=1 and no ref lines arrived on stdin.
A roster with no active deal (all closed) allows every push without scanning.

Residual (not covered): text inside images, OCR-only scans, raw zlib / lzma-alone streams,
PNG zTXt chunks, and encodings other than those listed above; history already on the
remote is not rescanned.

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

ZERO = "0"
ROSTER_RELPATH = (".claude", "hooks", "confidential-terms.json")

MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024  # decompressed bytes allowed per pushed blob
MAX_MEMBERS = 20000
MAX_DEPTH = 3
MIN_SQUASHED_LEN = 5
WITHHELD = "<withheld: contains a confidential term>"

# Pin everything that could change what `git log` prints: no external diff, no textconv, no
# colour, unquoted paths, UTF-8 output regardless of i18n.logOutputEncoding.
GIT_BASE = ["git", "-c", "core.quotepath=off", "-c", "diff.noprefix=false",
            "-c", "i18n.logOutputEncoding=UTF-8"]

SEP_RE = re.compile(r"[\s_.\- ­‐-―]+")
TAG_RE = re.compile(r"<[^<>]{0,4000}>")


class Unscannable(Exception):
    pass


# --------------------------------------------------------------------------- matching
def normalize(s):
    """NFKC + casefold, every separator run collapsed to one space."""
    return SEP_RE.sub(" ", unicodedata.normalize("NFKC", s).casefold())


def _squash(s):
    return s.replace(" ", "")


WINDOW = 256 * 1024
MIN_OVERLAP = 8192


def _scan_window(text, terms, found):
    cands = [text]
    if "&" in text:
        cands.append(html.unescape(text))
    if "<" in text:
        cands += [TAG_RE.sub("", c) for c in list(cands)]
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


def scan_text(text, terms):
    """Sorted indices of (already-normalized) terms present in text -- never the terms.

    Large texts are scanned in overlapping windows: NFKC on one multi-MB string is
    super-linear (REFUTE round 2, N2: 16 s for 4 MB). The overlap exceeds any term plus the
    markup that could sit inside it, so no match is lost at a window edge."""
    found = set()
    if len(text) <= WINDOW:
        _scan_window(text, terms, found)
        return sorted(found)
    overlap = max(MIN_OVERLAP, 8 * max((len(t) for t in terms), default=0))
    step = WINDOW - overlap
    for start in range(0, len(text), step):
        _scan_window(text[start:start + WINDOW], terms, found)
        if len(found) == len(terms) or start + WINDOW >= len(text):
            break
    return sorted(found)


def shown(name, terms):
    return WITHHELD if scan_text(name, terms) else name


# --------------------------------------------------------------------------- roster
def roster_path():
    """~/.claude/hooks/confidential-terms.json. On Windows expanduser reads USERPROFILE."""
    return os.path.join(os.path.expanduser("~"), *ROSTER_RELPATH)


def load_terms(path=None):
    """Normalized active `always` terms (sorted, deduplicated), or None when the roster cannot
    be read or any deal entry is malformed (fail-closed: we cannot prove we know its terms).

    A deal counts unless it explicitly says `"active": false` (a missing flag is treated as
    active). A key starting with "_" is metadata (e.g. `_meta`) unless it carries `always`."""
    path = path or roster_path()
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    out = set()
    for key, deal in data.items():
        if key.startswith("_") and not (isinstance(deal, dict) and "always" in deal):
            continue
        if not isinstance(deal, dict):
            return None
        if deal.get("active", True) is False:
            continue
        always = deal.get("always", [])
        if not isinstance(always, list) or not all(isinstance(t, str) for t in always):
            return None
        for t in always:
            n = normalize(t).strip()
            if n:
                out.add(n)
    return sorted(out)


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


_DEFAULT_CANDIDATES = ("refs/remotes/origin/main", "refs/remotes/origin/master")


def resolve_default_baseline(cwd=None):
    """Fully-qualified remote-tracking ref of the trunk (never a short name, which a local
    branch literally called 'origin/main' could shadow), or None if nothing resolves."""
    candidates = []
    p = subprocess.run(["git", "symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
                       capture_output=True, text=True, cwd=cwd)
    target = p.stdout.strip()
    if p.returncode == 0 and target.startswith("refs/remotes/"):
        candidates.append(target)
    candidates += [c for c in _DEFAULT_CANDIDATES if c not in candidates]
    for ref in candidates:
        v = subprocess.run(["git", "rev-parse", "-q", "--verify", ref + "^{commit}"],
                           capture_output=True, text=True, cwd=cwd)
        if v.returncode == 0 and v.stdout.strip():
            return ref
    return None


def rev_range(local_sha, remote_sha, baseline):
    """Commit range to scan for one ref; None = cannot bound it (caller blocks)."""
    if set(remote_sha) != {ZERO}:
        return "%s..%s" % (remote_sha, local_sha)
    if baseline is None:
        return None
    return "%s..%s" % (baseline, local_sha)


# --------------------------------------------------------------------------- objects
def range_commits(rng, cwd=None):
    p = subprocess.run(["git", "rev-list", rng], capture_output=True, text=True, cwd=cwd)
    if p.returncode != 0:
        raise Unscannable("`git rev-list` failed for the pushed range")
    return [s for s in p.stdout.split() if s]


def range_blobs(rng, cwd=None):
    """[(path, blob_sha)] for every blob added or modified anywhere in rng, merges included
    (--cc lists what a merge resolution changed relative to every parent). RAISES Unscannable."""
    p = subprocess.run(GIT_BASE + ["log", "--raw", "--cc", "--root", "-z", "--no-abbrev",
                                   "--no-renames", "--format=", rng],
                       capture_output=True, cwd=cwd)
    if p.returncode != 0:
        raise Unscannable("`git log --raw` failed for the pushed range")
    fields = p.stdout.decode("utf-8", "surrogateescape").split("\0")
    out, seen = [], set()
    i = 0
    while i < len(fields):
        meta = fields[i].lstrip("\n")
        if not meta.startswith(":"):
            i += 1
            continue
        path = fields[i + 1] if i + 1 < len(fields) else ""
        i += 2
        nparents = len(meta) - len(meta.lstrip(":"))
        parts = meta.lstrip(":").split()
        if len(parts) < 2 * nparents + 3:
            raise Unscannable("unparseable `git log --raw` record")
        new_mode, new_sha = parts[nparents], parts[2 * nparents + 1]
        if set(new_sha) == {ZERO} or new_mode == "160000":
            continue  # deletion or submodule (a symlink's blob is its target text: scanned)
        if (path, new_sha) not in seen:
            seen.add((path, new_sha))
            out.append((path, new_sha))
    return out


def iter_objects(shas, cwd=None):
    """Yield (sha, type, bytes) one object at a time from one `git cat-file --batch`.
    RAISES Unscannable on a git failure or a missing object."""
    if not shas:
        return
    proc = subprocess.Popen(["git", "cat-file", "--batch"], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=cwd)
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


def scan_blobs(rng, terms, cwd=None):
    """(hits, unscannable) over every blob added or modified in rng.
    hits: [(shown_path, indices)]; unscannable: [reason]."""
    hits, bad = [], []
    try:
        paths_by_sha = {}
        for path, sha in range_blobs(rng, cwd):
            paths_by_sha.setdefault(sha, []).append(path)
        for sha, _typ, blob in iter_objects(sorted(paths_by_sha), cwd):
            path = shown(paths_by_sha[sha][0], terms)
            try:
                texts = expand(blob, [MAX_DECOMPRESSED_BYTES])
            except Unscannable as e:
                bad.append("%s: %s" % (path, e))
                continue
            found = set()
            for text in texts:
                found.update(scan_text(text, terms))
            if found:
                hits.append((path, sorted(found)))
    except (Unscannable, ValueError, OSError) as e:
        bad.append("blob enumeration failed (%s)" % e)
    return hits, bad


def commit_object_hits(rng, terms, cwd=None):
    """Indices found in the raw commit objects of rng: message, author / committer, mergetag
    and encoding headers -- a message in a legacy encoding is read through every view."""
    found = set()
    for _sha, _typ, data in iter_objects(range_commits(rng, cwd), cwd):
        for text in text_views(data):
            found.update(scan_text(text, terms))
    return sorted(found)


def tag_chain_hits(local_sha, terms, cwd=None):
    """Indices found in every annotated tag object reachable by peeling local_sha (a tag of
    a tag transfers both objects). Empty for anything that is not a tag. RAISES Unscannable."""
    found, sha = set(), local_sha
    for _ in range(16):
        objs = list(iter_objects([sha], cwd))
        _s, typ, data = objs[0]
        if typ != "tag":
            return sorted(found)
        for text in text_views(data):
            found.update(scan_text(text, terms))
        first = data.split(b"\n", 1)[0].decode("ascii", "replace").split()
        if len(first) != 2 or first[0] != "object" or not _is_sha(first[1]):
            raise Unscannable("unparseable tag object")
        sha = first[1]
    raise Unscannable("tag chain longer than 16")


# --------------------------------------------------------------------------- main
def scan_ref(local_ref, local_sha, remote_ref, remote_sha, terms, baseline, cwd=None):
    """List of block messages for one pushed ref (empty = clean)."""
    msgs = []
    label = shown(local_ref, terms)
    name_hits = sorted(set(scan_text(local_ref, terms) + scan_text(remote_ref, terms)))
    if name_hits:
        msgs.append("a pushed ref NAME contains confidential term(s) (indices %s)." % name_hits)
    try:
        t_hits = tag_chain_hits(local_sha, terms, cwd)
    except Unscannable as e:
        msgs.append("(fail-closed) could not read the pushed object for %s: %s" % (label, e))
        t_hits = []
    if t_hits:
        msgs.append("confidential term(s) (indices %s) in an annotated tag message of %s."
                    % (t_hits, label))
    rng = rev_range(local_sha, remote_sha, baseline)
    if rng is None:
        msgs.append("(fail-closed) %s is a brand-new remote ref and origin's default branch "
                    "could not be resolved to bound the scan -- run `git fetch` first." % label)
        return msgs
    p = subprocess.run(GIT_BASE + ["log", "-p", "--cc", "--root", "--no-color",
                                   "--no-ext-diff", "--no-textconv", rng],
                       capture_output=True, cwd=cwd)
    if p.returncode != 0:
        msgs.append("(fail-closed) `git log -p %s` failed for %s (remote sha unknown "
                    "locally? run `git fetch` first)." % (rng, label))
        return msgs
    hits = scan_text(p.stdout.decode("utf-8", "ignore"), terms)
    try:
        hits = sorted(set(hits) | set(commit_object_hits(rng, terms, cwd)))
    except Unscannable as e:
        msgs.append("(fail-closed) commit objects for %s could not be read: %s" % (label, e))
    if hits:
        msgs.append("%d confidential term(s) (indices %s) in the commit messages / diffs "
                    "being pushed on %s (range %s). A clean HEAD does not mean a clean "
                    "push -- rewrite the history first." % (len(hits), hits, label, rng))
    b_hits, b_bad = scan_blobs(rng, terms, cwd)
    if b_hits:
        msgs.append("confidential term(s) inside file content pushed on %s: %s."
                    % (label, "; ".join("%s -> indices %s" % h for h in b_hits)))
    if b_bad:
        msgs.append("(fail-closed) file(s) pushed on %s cannot be proven clean by this scan "
                    "(verify by hand, then --no-verify): %s" % (label, "; ".join(b_bad)))
    return msgs


def main(stdin_text=None, roster=None, cwd=None):
    try:
        sys.stderr.reconfigure(errors="backslashreplace")
    except Exception:
        pass
    terms = load_terms(roster)
    if terms is None:
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
    if not terms:
        return 0  # no active confidential deal: nothing can leak
    baseline = resolve_default_baseline(cwd)
    blocked = False
    for local_ref, local_sha, remote_ref, remote_sha in pushrefs:
        if set(local_sha) == {ZERO}:
            continue  # ref deletion: nothing new reaches the remote
        for m in scan_ref(local_ref, local_sha, remote_ref, remote_sha, terms, baseline, cwd):
            sys.stderr.write("pre-push BLOCKED: %s\n" % m)
            blocked = True
    if blocked:
        sys.stderr.write("Terms are never printed; indices refer to the active roster's "
                         "sorted, normalized always-terms. Bypass only after verifying the "
                         "push is clean: git push --no-verify\n")
    return 1 if blocked else 0


if __name__ == "__main__":
    sys.exit(main())
