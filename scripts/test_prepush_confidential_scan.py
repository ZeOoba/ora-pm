#!/usr/bin/env python3
"""Tests for the fail-closed confidentiality pre-push gate (prepush_confidential_scan.py).

End-to-end: each case builds a throwaway bare remote + clone, installs the REAL pre-push shim
the way this repo installs it, points HOME/USERPROFILE at a temp home holding a synthetic
roster, and runs an actual `git push`. The roster terms are invented (not real deals, people
or companies). Stdlib only; the same file is committed to ora-skills, website-canonical and
ora-pm (layout is detected below).

    python <dir>/test_prepush_confidential_scan.py
"""
import gzip
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCAN = os.path.join(HERE, "prepush_confidential_scan.py")
HOOKSPATH_SHIM = os.path.join(HERE, "hooks", "pre-push")        # ora-skills layout
INSTALLER = os.path.join(HERE, "install_prepush_hook.py")        # default-.git/hooks layout

TERM = "Zyxwv Quillborne"          # invented
TERM2 = "Vrenk Oltaz Parcel"       # invented
INACTIVE = "Plorbix Glimmerfen"    # invented, belongs to a closed deal

spec = importlib.util.spec_from_file_location("prepush_confidential_scan", SCAN)
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)


def _rmtree(path):
    def onerr(func, p, _exc):
        os.chmod(p, stat.S_IWRITE)
        func(p)
    shutil.rmtree(path, onerror=onerr)


class Sandbox:
    """Temp home + roster, bare remote, and a clone with the real shim installed."""

    def __init__(self, roster=None):
        self.root = tempfile.mkdtemp(prefix="ora-prepush-")
        self.home = os.path.join(self.root, "home")
        os.makedirs(os.path.join(self.home, ".claude", "hooks"))
        gcfg = os.path.join(self.root, "gitconfig")
        open(gcfg, "w").close()
        self.env = dict(os.environ)
        self.env.update({
            "HOME": self.home, "USERPROFILE": self.home,
            "GIT_CONFIG_GLOBAL": gcfg, "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
            "GIT_TERMINAL_PROMPT": "0",
        })
        self.env.pop("ORA_PREPUSH_REQUIRE_REFS", None)
        if roster is not None:
            self.write_roster(roster)
        self.remote = os.path.join(self.root, "remote.git")
        self.work = os.path.join(self.root, "work")
        self.git(self.root, "init", "-q", "--bare", "-b", "main", self.remote)
        self.git(self.root, "init", "-q", "-b", "main", self.work)
        self.git(self.work, "remote", "add", "origin", self.remote)
        self.commit("README.md", "seed\n", "seed")
        self.git(self.work, "push", "-q", "--no-verify", "origin", "main")
        self.git(self.work, "fetch", "-q", "origin")
        self._install_shim()

    def _install_shim(self):
        if os.path.isfile(HOOKSPATH_SHIM):
            # Mirror the repo layout (tools/hooks/pre-push + tools/<scan>) in a temp dir so only
            # the pre-push hook is active -- the repo's other hooks are not under test.
            tools = os.path.join(self.root, "hk", "tools")
            os.makedirs(os.path.join(tools, "hooks"))
            shutil.copyfile(HOOKSPATH_SHIM, os.path.join(tools, "hooks", "pre-push"))
            os.chmod(os.path.join(tools, "hooks", "pre-push"), 0o755)
            shutil.copyfile(SCAN, os.path.join(tools, "prepush_confidential_scan.py"))
            self.git(self.work, "config", "core.hooksPath", os.path.join(tools, "hooks"))
        else:
            p = subprocess.run([sys.executable, INSTALLER, "--repo", self.work],
                               capture_output=True, text=True, env=self.env)
            assert p.returncode == 0, p.stderr

    def write_roster(self, roster):
        path = os.path.join(self.home, ".claude", "hooks", "confidential-terms.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write(roster if isinstance(roster, str) else json.dumps(roster))

    def git(self, cwd, *args, check=True):
        p = subprocess.run(["git"] + list(args), cwd=cwd, capture_output=True, env=self.env)
        if check and p.returncode != 0:
            raise AssertionError("git %s failed: %s" % (args, p.stderr.decode(errors="replace")))
        return p

    def commit(self, name, content, msg="change"):
        path = os.path.join(self.work, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        mode = "wb" if isinstance(content, bytes) else "w"
        with open(path, mode, **({} if mode == "wb" else {"encoding": "utf-8", "newline": "\n"})) as f:
            f.write(content)
        self.git(self.work, "add", "-A")
        self.git(self.work, "commit", "-q", "--no-verify", "-m", msg)

    def push(self, *refspec):
        p = self.git(self.work, "push", "origin", *(refspec or ("HEAD",)), check=False)
        return p.returncode, p.stderr.decode("utf-8", "replace")

    def close(self):
        _rmtree(self.root)


ROSTER = {
    "_meta": {"note": "synthetic test roster"},
    "deal_a": {"active": True, "always": [TERM, TERM2]},
    "deal_closed": {"active": False, "always": [INACTIVE]},
}


class PushGate(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox(ROSTER)

    def tearDown(self):
        self.sb.close()

    def assertBlocked(self, rc, err):
        self.assertNotEqual(rc, 0, "push should have been blocked:\n" + err)
        self.assertIn("pre-push BLOCKED", err)
        for t in (TERM, TERM2):
            self.assertNotIn(t.lower(), err.lower(), "a roster term was echoed")

    def assertAllowed(self, rc, err):
        self.assertEqual(rc, 0, "push should have been allowed:\n" + err)
        self.assertNotIn("pre-push BLOCKED", err)

    # --- the two TDD anchors -------------------------------------------------------------
    def test_push_with_active_term_is_blocked(self):
        self.sb.commit("notes.md", "Deal memo for %s, 40k SF\n" % TERM.upper())
        self.assertBlocked(*self.sb.push())

    def test_clean_push_is_allowed(self):
        self.sb.commit("notes.md", "nothing confidential here\n")
        self.assertAllowed(*self.sb.push())

    # --- history, metadata, names --------------------------------------------------------
    def test_term_in_history_but_not_head_is_blocked(self):
        self.sb.commit("notes.md", "draft mentions %s\n" % TERM)
        self.sb.commit("notes.md", "scrubbed\n")
        self.assertBlocked(*self.sb.push())

    def test_term_in_commit_message_is_blocked(self):
        self.sb.commit("notes.md", "clean\n", msg="LOI sent re %s" % TERM2)
        self.assertBlocked(*self.sb.push())

    def test_new_branch_named_after_deal_is_blocked(self):
        self.sb.write_roster(dict(ROSTER, deal_b={"active": True, "always": ["quillborne-ridge"]}))
        self.sb.commit("notes.md", "clean\n")
        rc, err = self.sb.push("HEAD:refs/heads/feature/Quillborne-Ridge")
        self.assertBlocked(rc, err)
        self.assertNotIn("quillborne-ridge", err.lower())

    def test_annotated_tag_message_is_blocked(self):
        self.sb.git(self.sb.work, "tag", "-a", "v1", "-m", "closing set for %s" % TERM)
        self.assertBlocked(*self.sb.push("refs/tags/v1"))

    # --- content git log -p cannot see ---------------------------------------------------
    def test_term_inside_zip_docx_is_blocked(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("word/document.xml", "<w:t>%s</w:t>" % TERM)
        self.sb.commit("memo.docx", buf.getvalue())
        self.assertBlocked(*self.sb.push())

    def test_term_inside_gzip_is_blocked(self):
        self.sb.commit("log.txt.gz", gzip.compress(("x %s y" % TERM2).encode()))
        self.assertBlocked(*self.sb.push())

    def test_term_in_utf16_file_is_blocked(self):
        self.sb.commit("export.csv", ("name\n%s\n" % TERM).encode("utf-16"))
        self.assertBlocked(*self.sb.push())

    def test_term_in_file_marked_binary_by_gitattributes_is_blocked(self):
        self.sb.commit(".gitattributes", "*.dat binary\n")
        self.sb.commit("blob.dat", b"\x00\x01" + ("..%s.." % TERM).encode() + b"\x00")
        self.assertBlocked(*self.sb.push())

    def test_unreadable_archive_fails_closed(self):
        self.sb.commit("broken.gz", GZIP_TRUNCATED)
        self.assertBlocked(*self.sb.push())

    def test_term_in_file_path_is_blocked_and_withheld(self):
        self.sb.commit("deals/%s.md" % TERM, "clean body\n")
        self.assertBlocked(*self.sb.push())

    # --- REFUTE round 1 regressions (2026-11-09) -----------------------------------------
    def test_docx_term_split_across_word_runs_is_blocked(self):
        a, b = TERM.split(" ")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("word/document.xml",
                       '<w:p><w:r><w:t>%s</w:t></w:r><w:r><w:t xml:space="preserve"> %s</w:t>'
                       '</w:r></w:p>' % (a, b))
        self.sb.commit("memo.docx", buf.getvalue())
        self.assertBlocked(*self.sb.push())

    def test_pdf_fails_closed_while_a_deal_is_active(self):
        import zlib
        stream = zlib.compress(b"BT (%s) Tj ET" % TERM.encode())
        pdf = (b"%PDF-1.4\n1 0 obj << /Filter /FlateDecode /Length " + str(len(stream)).encode()
               + b" >>\nstream\n" + stream + b"\nendstream\nendobj\n%%EOF\n")
        self.sb.commit("LOI.pdf", pdf)
        self.assertBlocked(*self.sb.push())

    def test_bz2_and_xz_are_decompressed(self):
        import bz2
        import lzma
        filler = ("lorem ipsum " * 200).encode()
        self.sb.commit("a.bz2", bz2.compress(filler + TERM.encode() + filler))
        self.assertBlocked(*self.sb.push())
        self.sb.git(self.sb.work, "reset", "-q", "--hard", "HEAD~1")
        self.sb.commit("a.xz", lzma.compress(filler + TERM2.encode() + filler))
        self.assertBlocked(*self.sb.push())

    def test_plain_tar_wrapping_gzip_is_blocked(self):
        import tarfile
        inner = gzip.compress(("x %s y" % TERM).encode())
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tf:
            info = tarfile.TarInfo("inner.txt.gz")
            info.size = len(inner)
            tf.addfile(info, io.BytesIO(inner))
        self.sb.commit("bundle.tar", buf.getvalue())
        self.assertBlocked(*self.sb.push())

    def test_unsupported_archive_fails_closed(self):
        self.sb.commit("x.7z", b"7z\xbc\xaf\x27\x1c" + b"\x00" * 64)
        self.assertBlocked(*self.sb.push())

    def test_separator_variants_are_blocked(self):
        a, b = TERM.split(" ")
        for name, body in (("wrap.md", "%s\n%s\n" % (a, b)),
                           ("nbsp.html", "<p>%s&nbsp;%s</p>\n" % (a, b)),
                           ("uni.md", "%s %s\n" % (a, b)),
                           ("LOI_%s%s_11092026.md" % (a, b), "clean body\n")):
            self.sb.commit(name, body)
            self.assertBlocked(*self.sb.push())
            self.sb.git(self.sb.work, "reset", "-q", "--hard", "HEAD~1")

    def test_nested_annotated_tag_message_is_blocked(self):
        self.sb.git(self.sb.work, "tag", "-a", "inner", "-m", "closing %s" % TERM)
        self.sb.git(self.sb.work, "tag", "-a", "outer", "-m", "clean", "inner")
        self.sb.git(self.sb.work, "tag", "-d", "inner")
        self.assertBlocked(*self.sb.push("refs/tags/outer"))

    def test_non_ascii_term_in_ref_name_cp1252_and_nfd(self):
        term = "Großquill Fähre"  # invented
        self.sb.write_roster(dict(ROSTER, deal_c={"active": True, "always": [term]}))
        rc, err = self.sb.push("HEAD:refs/heads/deal/%s" % term.replace(" ", "-"))
        self.assertNotEqual(rc, 0, err)
        self.assertNotIn("quill", err.lower())
        for name, data in (("cp.csv", ("x;%s\n" % term).encode("cp1252")),
                           ("nfd.md", unicodedata.normalize("NFD", term).encode()),
                           ("upper.md", term.upper().encode())):  # GROSSQUILL FAHRE
            self.sb.commit(name, data)
            self.assertBlocked(*self.sb.push())
            self.sb.git(self.sb.work, "reset", "-q", "--hard", "HEAD~1")

    def test_commit_message_in_utf16_log_encoding_is_blocked(self):
        self.sb.git(self.sb.work, "config", "i18n.logOutputEncoding", "UTF-16")
        self.sb.commit("notes.md", "clean\n", msg="LOI re %s" % TERM)
        self.assertBlocked(*self.sb.push())

    # --- REFUTE round 2 regressions -----------------------------------------------------
    def test_clean_large_binary_is_allowed_quickly(self):
        import random
        import time
        rnd = random.Random(7)
        self.sb.commit("photo.jpg", b"\xff\xd8\xff\xe0" + bytes(rnd.getrandbits(8)
                                                                for _ in range(3 * 1024 * 1024)))
        t0 = time.time()
        self.assertAllowed(*self.sb.push())
        self.assertLess(time.time() - t0, 120, "3 MB clean binary took too long")

    # --- range bounds --------------------------------------------------------------------
    def test_only_new_commits_are_scanned_on_existing_branch(self):
        # A term that is ALREADY on the remote (pushed past the gate) does not block a later
        # clean push: the delta remote_sha..local_sha is what is new.
        self.sb.commit("old.md", "%s\n" % TERM)
        self.sb.git(self.sb.work, "push", "-q", "--no-verify", "origin", "main")
        self.sb.commit("new.md", "clean\n")
        self.assertAllowed(*self.sb.push())

    def test_new_branch_scans_only_commits_not_on_trunk(self):
        self.sb.commit("old.md", "%s\n" % TERM)
        self.sb.git(self.sb.work, "push", "-q", "--no-verify", "origin", "main")
        self.sb.git(self.sb.work, "fetch", "-q", "origin")
        self.sb.git(self.sb.work, "checkout", "-q", "-b", "feature")
        self.sb.commit("feature.md", "clean\n")
        self.assertAllowed(*self.sb.push("feature"))

    def test_new_branch_without_resolvable_baseline_fails_closed(self):
        self.sb.git(self.sb.work, "update-ref", "-d", "refs/remotes/origin/main")
        self.sb.git(self.sb.work, "checkout", "-q", "-b", "feature")
        self.sb.commit("feature.md", "clean\n")
        self.assertBlocked(*self.sb.push("feature"))

    def test_branch_deletion_is_allowed(self):
        self.sb.git(self.sb.work, "push", "-q", "--no-verify", "origin", "HEAD:refs/heads/tmp")
        self.assertAllowed(*self.sb.push(":refs/heads/tmp"))

    # --- roster states -------------------------------------------------------------------
    def test_missing_roster_blocks(self):
        os.remove(os.path.join(self.sb.home, ".claude", "hooks", "confidential-terms.json"))
        self.sb.commit("notes.md", "clean\n")
        self.assertBlocked(*self.sb.push())

    def test_unparseable_roster_blocks(self):
        self.sb.write_roster("{ not json")
        self.sb.commit("notes.md", "clean\n")
        self.assertBlocked(*self.sb.push())

    def test_inactive_deal_term_is_allowed(self):
        self.sb.commit("notes.md", "closed deal %s is public now\n" % INACTIVE)
        self.assertAllowed(*self.sb.push())

    def test_roster_with_no_active_deal_allows(self):
        self.sb.write_roster({"_meta": {}, "deal_closed": {"active": False, "always": [TERM]}})
        self.sb.commit("notes.md", "%s\n" % TERM)
        self.assertAllowed(*self.sb.push())


GZIP_TRUNCATED = gzip.compress(b"x" * 5000)[:-12]


class Units(unittest.TestCase):
    def _roster(self, data):
        d = tempfile.mkdtemp()
        self.addCleanup(_rmtree, d)
        p = os.path.join(d, "r.json")
        with open(p, "w", encoding="utf-8") as f:
            f.write(data if isinstance(data, str) else json.dumps(data))
        return p

    def test_load_terms_shapes(self):
        self.assertIsNone(scan.load_terms(os.path.join(tempfile.gettempdir(), "nope-ora.json")))
        self.assertIsNone(scan.load_terms(self._roster("[1, 2]")))
        self.assertIsNone(scan.load_terms(self._roster({"d": {"always": "not-a-list"}})))
        self.assertIsNone(scan.load_terms(self._roster({"d": ["x"]})))        # non-dict deal
        self.assertIsNone(scan.load_terms(self._roster({"d": {"always": [["x"]]}})))
        self.assertIsNone(scan.load_terms(self._roster({"_d": {"always": ["x", 1]}})))
        self.assertEqual(scan.load_terms(self._roster({"_d": {"always": ["Abcde"]}})), ["abcde"])
        self.assertEqual(scan.load_terms(self._roster({"d": {"always": ["  AbC  ", ""]}})),
                         ["abc"])  # missing `active` counts as active
        self.assertEqual(scan.load_terms(self._roster(ROSTER)),
                         sorted([TERM.lower(), TERM2.lower()]))

    def test_scan_text_reports_indices_only(self):
        self.assertEqual(scan.scan_text("..ZYXWV QUILLBORNE..", ["vrenk", "zyxwv quillborne"]), [1])

    def test_no_false_positive_across_word_boundaries(self):
        # N1: a one-word term must not match words that merely abut; a multi-word term's
        # separator-free form must not match across a space in the text.
        self.assertEqual(scan.scan_text("turn quil ton road", ["quilton"]), [])
        self.assertEqual(scan.scan_text("the pros saved time", ["ross ave"]), [])
        self.assertEqual(scan.scan_text("LOI_RossAve_11092026", ["ross ave"]), [0])

    def test_window_edges_do_not_lose_matches(self):
        filler = "a" * (scan.WINDOW - 5)
        self.assertEqual(scan.scan_text(filler + "Zyxwv Quillborne" + filler,
                                        ["zyxwv quillborne"]), [0])

    def test_rev_range(self):
        z, a, b = "0" * 40, "a" * 40, "b" * 40
        self.assertEqual(scan.rev_range(a, b, "refs/remotes/origin/main"), "%s..%s" % (b, a))
        self.assertEqual(scan.rev_range(a, z, "refs/remotes/origin/main"),
                         "refs/remotes/origin/main..%s" % a)
        self.assertIsNone(scan.rev_range(a, z, None))

    def test_require_refs_env_blocks_empty_stdin(self):
        p = self._roster(ROSTER)
        old = os.environ.get("ORA_PREPUSH_REQUIRE_REFS")
        os.environ["ORA_PREPUSH_REQUIRE_REFS"] = "1"
        try:
            self.assertEqual(scan.main(stdin_text="", roster=p), 1)
        finally:
            if old is None:
                os.environ.pop("ORA_PREPUSH_REQUIRE_REFS")
            else:
                os.environ["ORA_PREPUSH_REQUIRE_REFS"] = old
        self.assertEqual(scan.main(stdin_text="", roster=p), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
