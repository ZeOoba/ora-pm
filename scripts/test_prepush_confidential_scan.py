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
CTX_TERM = "quiet marsh park"      # invented context term
ANCHOR = "projectcodeq7"           # invented context_requires_any anchor (NOT an always term)
ZWSP = "\u200b"

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
            self.rel = "tools/prepush_confidential_scan.py"         # the shim's REL
            self.fallback = os.path.join(tools, "prepush_confidential_scan.py")
        else:
            p = subprocess.run([sys.executable, INSTALLER, "--repo", self.work],
                               capture_output=True, text=True, env=self.env)
            assert p.returncode == 0, p.stderr
            self.rel = "scripts/prepush_confidential_scan.py"
            hooks = self.out("rev-parse", "--git-path", "hooks")
            self.fallback = os.path.join(self.work, hooks, "ora_prepush_confidential_scan.py")
        assert os.path.isfile(self.fallback), self.fallback

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
        return self.push_to("origin", *(refspec or ("HEAD",)))

    def push_to(self, remote, *refspec):
        p = self.git(self.work, "push", remote, *refspec, check=False)
        return p.returncode, p.stderr.decode("utf-8", "replace")

    def bare(self, name):
        path = os.path.join(self.root, name + ".git")
        self.git(self.root, "init", "-q", "--bare", "-b", "main", path)
        return path

    def hash_object(self, data):
        p = subprocess.run(["git", "hash-object", "-w", "--stdin"], cwd=self.work, input=data,
                           capture_output=True, env=self.env)
        assert p.returncode == 0, p.stderr
        return p.stdout.decode().strip()

    def out(self, *args):
        return self.git(self.work, *args).stdout.decode().strip()

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
        low = err.lower()
        for t in (TERM, TERM2, CTX_TERM, ANCHOR):
            self.assertNotIn(t.lower(), low, "a roster term was echoed")
            self.assertNotIn(t.lower().replace(" ", ""), low, "a roster term was echoed")

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

    def test_new_branch_bound_ignores_local_tracking_refs(self):
        # The bound comes from what the destination advertises (ls-remote), never from local
        # refs/remotes/*: deleting them changes nothing. The term below is ALREADY on the
        # destination's main, so it is not new and is not rescanned; the full-history
        # fallback (ls-remote unusable) is pinned by
        # test_unreachable_push_url_falls_back_to_full_history.
        self.sb.commit("old.md", "%s\n" % TERM)
        self.sb.git(self.sb.work, "push", "-q", "--no-verify", "origin", "main")
        self.sb.git(self.sb.work, "update-ref", "-d", "refs/remotes/origin/main")
        self.sb.git(self.sb.work, "checkout", "-q", "-b", "feature")
        self.sb.commit("feature.md", "clean\n")
        self.assertAllowed(*self.sb.push("feature"))

    def test_new_branch_without_tracking_refs_and_clean_history_is_allowed(self):
        self.sb.git(self.sb.work, "update-ref", "-d", "refs/remotes/origin/main")
        self.sb.git(self.sb.work, "checkout", "-q", "-b", "feature")
        self.sb.commit("feature.md", "clean\n")
        self.assertAllowed(*self.sb.push("feature"))

    # --- REFUTE round 3 on 655645f9 ----------------------------------------------------
    def test_replace_ref_cannot_hide_the_pushed_commit(self):
        w = self.sb.work
        self.sb.commit("notes.md", "memo for %s\n" % TERM, msg="memo")
        bad = self.sb.out("rev-parse", "HEAD")
        clean = self.sb.out("commit-tree", self.sb.out("rev-parse", "HEAD~1^{tree}"),
                            "-p", "HEAD~1", "-m", "memo")
        self.sb.git(w, "replace", bad, clean)
        self.sb.env["GIT_REPLACE_REF_BASE"] = "refs/replace/"
        self.assertBlocked(*self.sb.push())

    def test_replaced_blob_cannot_hide_pushed_content(self):
        self.sb.commit("notes.md", "memo for %s\n" % TERM, msg="memo")
        blob = self.sb.out("rev-parse", "HEAD:notes.md")
        self.sb.git(self.sb.work, "replace", "-f", blob, self.sb.hash_object(b"clean\n"))
        self.assertBlocked(*self.sb.push())

    def test_tags_pointing_at_blobs_and_trees_are_scanned(self):
        w = self.sb.work
        blob = self.sb.hash_object(("memo %s\n" % TERM).encode())
        clean_blob = self.sb.hash_object(b"nothing here\n")
        self.sb.git(w, "tag", "t-blob", blob)
        self.assertBlocked(*self.sb.push("refs/tags/t-blob"))
        self.sb.git(w, "tag", "-a", "t-ablob", "-m", "clean", blob)
        self.assertBlocked(*self.sb.push("refs/tags/t-ablob"))
        with open(os.path.join(w, "deep.md"), "w", encoding="utf-8") as f:
            f.write("x %s y\n" % TERM2)
        self.sb.git(w, "add", "deep.md")
        tree = self.sb.out("write-tree")
        self.sb.git(w, "rm", "-q", "--cached", "deep.md")
        self.sb.git(w, "tag", "t-tree", tree)
        self.assertBlocked(*self.sb.push("refs/tags/t-tree"))
        self.sb.git(w, "tag", "-a", "t-atree", "-m", "clean", tree)
        self.assertBlocked(*self.sb.push("refs/tags/t-atree"))
        # existing ref moved from a clean blob to the term blob
        self.sb.git(w, "tag", "t-move", clean_blob)
        self.sb.git(w, "push", "-q", "--no-verify", "origin", "refs/tags/t-move")
        self.sb.git(w, "tag", "-f", "t-move", blob)
        self.assertBlocked(*self.sb.push("+refs/tags/t-move"))
        # a clean blob tag is allowed
        self.sb.git(w, "tag", "t-clean", clean_blob)
        self.assertAllowed(*self.sb.push("refs/tags/t-clean"))

    def test_new_ref_on_a_second_remote_is_bounded_by_that_remote(self):
        # The term commit is already on origin (private), not on `public`: pushing it to
        # public must be scanned even though origin's default branch contains it.
        w = self.sb.work
        self.sb.commit("notes.md", "memo %s\n" % TERM, msg="memo")
        self.sb.git(w, "push", "-q", "--no-verify", "origin", "main")
        self.sb.git(w, "fetch", "-q", "origin")
        self.sb.git(w, "remote", "add", "public", self.sb.bare("public"))
        self.assertBlocked(*self.sb.push_to("public", "HEAD:refs/heads/main"))
        # ... and once public's tracking refs exist, only what public lacks is scanned
        self.sb.git(w, "push", "-q", "--no-verify", "public", "HEAD:refs/heads/main")
        self.sb.git(w, "fetch", "-q", "public")
        self.sb.commit("more.md", "clean\n", msg="clean")
        self.assertAllowed(*self.sb.push_to("public", "HEAD:refs/heads/feature"))

    # --- REFUTE round 4 on 6d5b9031: the tracking-ref bound must describe the push target
    def _term_on_origin_tracking(self):
        w = self.sb.work
        self.sb.commit("notes.md", "memo %s\n" % TERM, msg="memo")
        self.sb.git(w, "push", "-q", "--no-verify", "origin", "main")
        self.sb.git(w, "fetch", "-q", "origin")
        self.sb.commit("more.md", "clean\n", msg="clean")

    def test_pushurl_remote_is_not_bounded_by_its_fetch_tracking_refs(self):
        self._term_on_origin_tracking()
        self.sb.git(self.sb.work, "config", "remote.origin.pushurl", self.sb.bare("pub2"))
        self.assertBlocked(*self.sb.push("HEAD:refs/heads/main"))

    def test_push_instead_of_remote_is_not_bounded_by_its_fetch_tracking_refs(self):
        self._term_on_origin_tracking()
        self.sb.git(self.sb.work, "config", "url.%s.pushInsteadOf" % self.sb.bare("pub3"),
                    self.sb.remote)
        self.assertBlocked(*self.sb.push("HEAD:refs/heads/main"))

    def test_multiple_urls_remote_is_not_bounded(self):
        self._term_on_origin_tracking()
        self.sb.git(self.sb.work, "config", "--add", "remote.origin.url", self.sb.bare("pub4"))
        self.assertBlocked(*self.sb.push("HEAD:refs/heads/main"))

    def test_prefix_remote_tracking_refs_do_not_bound_the_shorter_remote(self):
        # remotes `o` (public) and `o/priv` (private): refs/remotes/o/priv/* must not count
        # as already on `o`.
        w = self.sb.work
        self.sb.git(w, "remote", "add", "o", self.sb.bare("o_public"))
        # `git remote add` refuses a subset name; `git remote rename` allows it
        self.sb.git(w, "remote", "add", "opriv", self.sb.bare("o_priv"))
        self.sb.git(w, "remote", "rename", "opriv", "o/priv")
        self.sb.git(w, "push", "-q", "--no-verify", "o", "HEAD~0:refs/heads/seed")
        self.sb.commit("notes.md", "memo %s\n" % TERM, msg="memo")
        self.sb.git(w, "push", "-q", "--no-verify", "o/priv", "main")
        self.sb.git(w, "fetch", "-q", "o")
        self.sb.git(w, "fetch", "-q", "o/priv")
        self.assertBlocked(*self.sb.push_to("o", "HEAD:refs/heads/main"))

    # --- REFUTE round 5 on 51d9b668: bound new refs by what the destination advertises ---
    def test_case_colliding_remote_names_cannot_hide_commits(self):
        # NTFS / APFS: `origin` and `Origin` share refs/remotes/origin/; a fetch from the
        # private `Origin` must not make its commits count as already on public `origin`.
        w = self.sb.work
        self.sb.git(w, "remote", "add", "Origin", self.sb.bare("priv"))
        self.sb.commit("notes.md", "memo %s\n" % TERM, msg="memo")
        self.sb.git(w, "push", "-q", "--no-verify", "Origin", "main")
        self.sb.git(w, "fetch", "-q", "Origin")
        self.sb.commit("more.md", "clean\n", msg="clean")
        self.assertBlocked(*self.sb.push("HEAD:refs/heads/feature"))

    def test_stale_tracking_ref_after_remote_rewind_cannot_hide_commits(self):
        w = self.sb.work
        seed = self.sb.out("rev-parse", "HEAD")
        self.sb.commit("notes.md", "memo %s\n" % TERM, msg="memo")
        self.sb.git(w, "push", "-q", "--no-verify", "origin", "main")
        self.sb.git(w, "fetch", "-q", "origin")
        self.sb.git(self.sb.remote, "update-ref", "refs/heads/main", seed)  # remote rewound
        self.sb.commit("more.md", "clean\n", msg="clean")
        self.assertBlocked(*self.sb.push("HEAD:refs/heads/feature"))

    def _term_on_remote_main_then_feature(self):
        w = self.sb.work
        self.sb.commit("notes.md", "memo %s\n" % TERM, msg="memo")
        self.sb.git(w, "push", "-q", "--no-verify", "origin", "main")
        self.sb.git(w, "checkout", "-q", "-b", "feature")
        self.sb.commit("feature.md", "clean\n", msg="clean")
        head = self.sb.out("rev-parse", "HEAD")
        line = "refs/heads/feature %s refs/heads/feature %s\n" % (head, "0" * 40)
        return head, line

    def _main_in_sandbox(self, **kw):
        old = {k: os.environ.get(k) for k in ("HOME", "USERPROFILE", "GIT_CONFIG_GLOBAL",
                                              "GIT_CONFIG_NOSYSTEM")}
        os.environ.update({k: self.sb.env[k] for k in old})
        try:
            return scan.main(cwd=self.sb.work, **kw)
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_unreachable_push_url_falls_back_to_full_history(self):
        _head, line = self._term_on_remote_main_then_feature()
        roster = os.path.join(self.sb.home, ".claude", "hooks", "confidential-terms.json")
        self.assertEqual(self._main_in_sandbox(stdin_text=line, roster=roster, remote="origin",
                                               url=self.sb.remote), 0)
        bad = os.path.join(self.sb.root, "no-such-remote.git")
        self.assertEqual(self._main_in_sandbox(stdin_text=line, roster=roster, remote="origin",
                                               url=bad), 1)
        # argv[2] absent: argv[1] (a remote NAME) never equals its own resolved URL, so the
        # bound is refused and the full history is scanned (fail-closed)
        self.assertEqual(self._main_in_sandbox(stdin_text=line, roster=roster, remote="origin"), 1)

    def test_new_branch_off_up_to_date_main_scans_only_its_own_commits(self):
        head, _line = self._term_on_remote_main_then_feature()
        bound = scan.destination_bound("origin", self.sb.remote, self.sb.work)
        self.assertTrue(bound)
        self.assertEqual(scan.range_commits(scan.rev_range(head, "0" * 40, bound), self.sb.work),
                         [head])
        self.assertAllowed(*self.sb.push("feature"))

    # --- REFUTE round 6 on bb7e7e3e: ls-remote must ask the repo the push goes to -------
    def _private_has_term_public_pushed_via(self, remote_url, private, configure=None):
        """Term commit on the PRIVATE bare repo's main (fetched locally); a remote `pub`
        whose push URL resolves elsewhere; returns the push result of a new branch.
        `configure` (the insteadOf rules) runs only AFTER the private repo is seeded: on
        POSIX the private path itself can match a rule's prefix and be rewritten away."""
        w = self.sb.work
        self.sb.commit("notes.md", "memo %s\n" % TERM, msg="memo")
        self.sb.git(w, "push", "-q", "--no-verify", private, "main")
        if configure is not None:
            configure()
        self.sb.commit("more.md", "clean\n", msg="clean")
        self.sb.git(w, "remote", "add", "pub", remote_url)
        return self.sb.push_to("pub", "HEAD:refs/heads/feature")

    def test_self_matching_insteadof_cannot_bound_by_another_repo(self):
        # rule <root>/rr <- <root>/r: git rewrites r.git -> rr.git (the push target, argv[2]);
        # ls-remote rr.git would rewrite AGAIN to rrr.git (private).
        root = self.sb.root.replace("\\", "/")
        self.sb.bare("rr")
        private = self.sb.bare("rrr")
        configure = lambda: self.sb.git(self.sb.work, "config", "url.%s/rr.insteadOf" % root,
                                        "%s/r" % root)
        self.assertBlocked(*self._private_has_term_public_pushed_via("%s/r.git" % root, private,
                                                                     configure))

    def test_insteadof_rule_chain_cannot_bound_by_another_repo(self):
        root = self.sb.root.replace("\\", "/")
        self.sb.bare("chain_pub")
        private = self.sb.bare("chain_priv")
        w = self.sb.work

        def configure():
            self.sb.git(w, "config", "url.%s/chain_pub.git.insteadOf" % root, "%s/u.git" % root)
            self.sb.git(w, "config", "url.%s/chain_priv.git.insteadOf" % root,
                        "%s/chain_pub.git" % root)
        self.assertBlocked(*self._private_has_term_public_pushed_via("%s/u.git" % root, private,
                                                                     configure))

    def test_custom_receivepack_disables_the_bound(self):
        w = self.sb.work
        self.sb.commit("notes.md", "memo %s\n" % TERM, msg="memo")
        self.sb.git(w, "push", "-q", "--no-verify", "origin", "main")
        self.sb.git(w, "checkout", "-q", "-b", "feature")
        self.sb.commit("feature.md", "clean\n", msg="clean")
        self.sb.git(w, "config", "remote.origin.receivepack", "git-receive-pack")
        self.assertBlocked(*self.sb.push("feature"))  # full history: the old term counts

    def test_bound_refused_for_helpers_odd_transports_and_custom_pack_programs(self):
        w = self.sb.work
        good = self.sb.remote.replace("\\", "/")
        self.assertTrue(scan.destination_bound("origin", good, w))
        for target in ("ext::sh -c true", "foo::" + good, "ftp://example.invalid/x.git",
                       "ssh+git://example.invalid/x.git", "-oProxyCommand=x"):
            self.assertEqual(scan.destination_bound("origin", target, w), [], target)
        self.sb.git(w, "config", "remote.origin.uploadpack", "git-upload-pack")
        self.assertEqual(scan.destination_bound("origin", good, w), [])

    def test_push_to_a_bare_url_scans_full_history(self):
        w = self.sb.work
        self.sb.commit("notes.md", "memo %s\n" % TERM, msg="memo")
        self.sb.git(w, "push", "-q", "--no-verify", "origin", "main")
        self.sb.git(w, "fetch", "-q", "origin")
        self.sb.commit("more.md", "clean\n", msg="clean")
        self.assertBlocked(*self.sb.push_to(self.sb.bare("elsewhere"), "HEAD:refs/heads/main"))

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

    def test_duplicate_deal_key_roster_blocks_in_either_order(self):
        # json.load keeps the LAST value for a repeated key: a trailing inactive copy would
        # silently drop the deal's terms (REFUTE wf_df157e64-c52). Both orders must block.
        live = '{"active": true, "always": ["%s"]}' % TERM
        dead = '{"active": false}'
        self.sb.commit("notes.md", "clean\n")
        for first, second in ((live, dead), (dead, live)):
            self.sb.write_roster('{"deal_x": %s, "deal_x": %s}' % (first, second))
            self.assertBlocked(*self.sb.push())

    def test_inactive_deal_term_is_allowed(self):
        self.sb.commit("notes.md", "closed deal %s is public now\n" % INACTIVE)
        self.assertAllowed(*self.sb.push())

    def test_roster_with_no_active_deal_allows(self):
        self.sb.write_roster({"_meta": {}, "deal_closed": {"active": False, "always": [TERM]}})
        self.sb.commit("notes.md", "%s\n" % TERM)
        self.assertAllowed(*self.sb.push())


CTX_ROSTER = {
    "_meta": {"note": "synthetic context-only roster"},
    "deal_ctx": {"active": True, "always": [], "context": [CTX_TERM],
                 "context_requires_any": [ANCHOR]},
}


class ContextAndEncoding(unittest.TestCase):
    """Context terms (context / context_requires_any) and URL-encoded terms (2026-11-12)."""

    assertBlocked = PushGate.assertBlocked
    assertAllowed = PushGate.assertAllowed

    def setUp(self):
        self.sb = Sandbox(CTX_ROSTER)

    def tearDown(self):
        self.sb.close()

    def _each_blocked(self, cases):
        for name, body in cases:
            self.sb.commit(name, body)
            self.assertBlocked(*self.sb.push())
            self.sb.git(self.sb.work, "reset", "-q", "--hard", "HEAD~1")

    # --- context terms -------------------------------------------------------------------
    def test_context_term_without_anchor_is_allowed(self):
        self.sb.commit("notes.md", "walk to %s on saturday\n" % CTX_TERM)
        self.assertAllowed(*self.sb.push())

    def test_anchor_alone_is_allowed(self):
        self.sb.commit("notes.md", "ref %s only\n" % ANCHOR)
        self.assertAllowed(*self.sb.push())

    def test_context_only_deal_with_anchor_in_same_file_is_blocked(self):
        self.sb.commit("notes.md", "%s update: %s\n" % (ANCHOR, CTX_TERM.title()))
        self.assertBlocked(*self.sb.push())

    def test_anchor_in_commit_message_and_term_in_same_commit_diff_is_blocked(self):
        self.sb.commit("notes.md", "site visit at %s\n" % CTX_TERM, msg="%s notes" % ANCHOR)
        self.assertBlocked(*self.sb.push())

    def test_anchor_and_term_in_one_docx_are_one_window(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("word/header1.xml", "<w:t>%s</w:t>" % ANCHOR)
            z.writestr("word/document.xml", "<w:t>%s</w:t>" % CTX_TERM)
        self.sb.commit("memo.docx", buf.getvalue())
        self.assertBlocked(*self.sb.push())

    def test_anchor_and_term_in_different_commits_and_files_are_separate_windows(self):
        # Documented window: one commit (raw object + its patch) or one blob (all views).
        self.sb.commit("a.md", "ref %s\n" % ANCHOR)
        self.sb.commit("b.md", "walk to %s\n" % CTX_TERM)
        self.assertAllowed(*self.sb.push())

    def test_context_term_with_no_usable_anchor_is_always_level(self):
        for anchors in (None, [], [""], ["   "], [ZWSP], ["", ANCHOR], [ZWSP, ANCHOR]):
            deal = {"active": True, "always": [], "context": [CTX_TERM]}
            if anchors is not None:
                deal["context_requires_any"] = anchors
            self.sb.write_roster({"deal_ctx": deal})
            self.sb.commit("notes.md", "walk to %s\n" % CTX_TERM)
            self.assertBlocked(*self.sb.push())
            self.sb.git(self.sb.work, "reset", "-q", "--hard", "HEAD~1")

    def test_malformed_context_blocks_clean_push(self):
        for bad in ({"context": "not-a-list", "context_requires_any": [ANCHOR]},
                    {"context": [CTX_TERM, 7], "context_requires_any": [ANCHOR]},
                    {"context": [CTX_TERM], "context_requires_any": "not-a-list"},
                    {"context": [CTX_TERM], "context_requires_any": [ANCHOR, None]},
                    {"context": None, "context_requires_any": [ANCHOR]}):
            self.sb.write_roster({"deal_ctx": dict(bad, active=True, always=[])})
            self.sb.commit("notes.md", "nothing confidential here\n")
            self.assertBlocked(*self.sb.push())
            self.sb.git(self.sb.work, "reset", "-q", "--hard", "HEAD~1")

    # --- URL-encoded terms ---------------------------------------------------------------
    def test_url_encoded_term_is_blocked(self):
        self.sb.write_roster({"deal_u": {"active": True, "always": [CTX_TERM]}})
        self._each_blocked((
            ("pct.md", "see /search?q=Quiet%20Marsh%20Park\n"),
            ("plus.md", "see /search?q=Quiet+Marsh+Park&x=1\n"),
            ("hexletter.md", "see /x/%51uiet%20%4Darsh%20Park\n"),
            ("double.md", "see /x?u=Quiet%2520Marsh%2520Park\n"),
            ("triple.md", "see /x?u=Quiet%252520Marsh%252520Park\n"),
            ("href.html", '<a href="/q?t=quiet%20marsh%20park">listing</a>\n'),
            ("entity.html", "<p>quiet&#37;20marsh&#37;20park</p>\n"),
        ))

    def test_url_encoded_context_term_with_anchor_is_blocked(self):
        self.sb.commit("notes.md", "%s: /q?t=Quiet+Marsh+Park\n" % ANCHOR)
        self.assertBlocked(*self.sb.push())

    # --- REFUTE round 1 on 43ba624e: blob content and paths join their commit's window --
    @staticmethod
    def _docx(text):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("word/document.xml", "<w:t>%s</w:t>" % text)
        return buf.getvalue()

    def test_anchor_in_message_and_term_inside_docx_is_blocked(self):
        self.sb.commit("memo.docx", self._docx(CTX_TERM), msg="add %s IC memo" % ANCHOR)
        self.assertBlocked(*self.sb.push())

    def test_anchor_in_path_and_term_inside_docx_is_blocked(self):
        self.sb.commit("%s_memo.docx" % ANCHOR, self._docx(CTX_TERM))
        self.assertBlocked(*self.sb.push())

    def test_anchor_in_message_and_term_inside_gzip_is_blocked(self):
        self.sb.commit("log.txt.gz", gzip.compress(("x %s y" % CTX_TERM).encode()),
                       msg="%s export" % ANCHOR)
        self.assertBlocked(*self.sb.push())

    def test_anchor_in_message_and_term_in_no_diff_file_is_blocked(self):
        self.sb.commit(".gitattributes", "*.md -diff\n")
        self.sb.commit("notes.md", "site visit at %s\n" % CTX_TERM, msg="%s notes" % ANCHOR)
        self.assertBlocked(*self.sb.push())

    def test_anchor_message_and_docx_term_in_different_commits_stay_separate(self):
        self.sb.commit("a.md", "clean\n", msg="%s kickoff" % ANCHOR)
        self.sb.commit("memo.docx", self._docx(CTX_TERM), msg="add memo")
        self.assertAllowed(*self.sb.push())

    # --- REFUTE round 2 on 30d2a246 ----------------------------------------------------
    def test_log_config_cannot_misattribute_blobs_between_commits(self):
        # C1/C8: with log.showSignature=true a signature line precedes a commit's marker; the
        # older (signed) commit's blob must not be credited to the newer commit.
        w = self.sb.work
        signed = False
        keygen = shutil.which("ssh-keygen")
        if keygen:
            key = os.path.join(self.sb.root, "sk")
            k = subprocess.run([keygen, "-q", "-t", "ed25519", "-N", "", "-f", key],
                               capture_output=True)
            if k.returncode == 0:
                self.sb.git(w, "config", "gpg.format", "ssh")
                self.sb.git(w, "config", "user.signingkey", key.replace("\\", "/"))
                signed = True
        with open(os.path.join(w, "f.gz"), "wb") as f:
            f.write(gzip.compress(CTX_TERM.encode()))
        self.sb.git(w, "add", "f.gz")
        self.sb.git(w, "commit", "-q", "--no-verify", *(["-S"] if signed else []),
                    "-m", "%s signed older" % ANCHOR)
        self.sb.commit("b.txt", "x\n", msg="unsigned newer")
        for k, v in (("log.showSignature", "true"), ("color.ui", "always"),
                     ("diff.relative", "true"), ("log.decorate", "full"),
                     ("format.pretty", "oneline")):
            self.sb.git(w, "config", k, v)
        self.assertBlocked(*self.sb.push())

    def test_non_utf8_path_is_read_through_every_view(self):
        # a cp1252 path spelling the anchor with an accent, context term inside a .gz
        sb = self.sb
        gz = sb.hash_object(gzip.compress(CTX_TERM.encode()))
        base = sb.out("rev-parse", "HEAD:README.md")
        listing = (b"100644 blob " + base.encode() + b"\tREADME.md\0"
                   + b"100644 blob " + gz.encode() + b"\tpr\xf3jectcodeq7.gz\0")
        p = subprocess.run(["git", "mktree", "-z"], cwd=sb.work, input=listing,
                           capture_output=True, env=sb.env)
        self.assertEqual(p.returncode, 0, p.stderr)
        c = sb.out("commit-tree", p.stdout.decode().strip(), "-p", "HEAD", "-m", "add")
        sb.git(sb.work, "update-ref", "refs/heads/main", c)
        self.assertBlocked(*sb.push("main"))

    def test_zero_width_anchor_still_gates_on_its_visible_spelling(self):
        self.sb.write_roster({"deal_ctx": {"active": True, "always": [], "context": [CTX_TERM],
                                           "context_requires_any": ["projectcode" + ZWSP + "q7"]}})
        self.sb.commit("notes.md", "walk to %s\n" % CTX_TERM)
        self.assertAllowed(*self.sb.push())
        self.sb.commit("notes2.md", "%s: %s\n" % (ANCHOR, CTX_TERM))
        self.assertBlocked(*self.sb.push())


GZIP_TRUNCATED = gzip.compress(b"x" * 5000)[:-12]
# sha256 of the guard's _TABLE_MN + "|" + _TABLE_FMT (~/.claude/hooks/confidentiality-guard.py).
GUARD_TABLES_SHA256 = "74a4895cdb19be8885ff6d9338b636e6613e1ef211c3aacc6799449bc6118718"


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

    def test_duplicate_keys_fail_closed_at_any_level(self):
        live = '{"active": true, "always": ["%s"]}' % TERM
        dead = '{"active": false}'
        for text in ('{"deal_x": %s, "deal_x": %s}' % (live, dead),        # deal key, both orders
                     '{"deal_x": %s, "deal_x": %s}' % (dead, live),
                     '{"deal_x": {"always": ["%s"], "always": []}}' % TERM,  # nested field
                     '{"deal_x": {"always": [], "always": ["%s"]}}' % TERM,
                     '{"deal_x": {"always": ["%s"], "active": true, "active": false}}' % TERM,
                     '{"_meta": {"n": 1, "n": 2}, "deal_x": %s}' % live,     # metadata too
                     '{"deal_x": %s, "deal_y": {"active": false, "always": [{"a": 1, "a": 2}]}}'
                     % live):                                                # inside a list
            self.assertIsNone(scan.load_roster(self._roster(text)), text)
        # The same key in two DIFFERENT objects is not a duplicate.
        ok = '{"deal_x": %s, "deal_y": {"active": false, "always": ["%s"]}}' % (live, INACTIVE)
        r = scan.load_roster(self._roster(ok))
        self.assertIsNotNone(r)
        self.assertEqual(r.terms, [TERM.lower()])

    def test_any_pdf_header_in_the_first_kb_is_unscannable(self):
        # Pinned broad on purpose: narrowing this by structure tokens (obj / trailer / xref /
        # startxref) was refuted twice -- pypdf (strict=False) opens trailer-only documents,
        # `N 0 OBJ` + xref-stream files, and `Xtrailer` / `startxrefZ` spellings.
        hexterm = TERM.encode().hex().encode()
        lenient = (
            b"%PDF-1.4\n%%EOF\n",
            b"readme\n%PDF-1.7\ntrailer\n<< /Info << /Title <" + hexterm + b"> >> >>\n",
            b"readme\n%PDF-1.7\nXtrailer\n<< /Info << /Title <" + hexterm + b"> >> >>\n"
            b"startxrefZ\n5\n%%EOF\n",
            b"readme\n%PDF-1.7\n2 0 OBJ << /Type /XRef >> stream\nendstream\n",
            b" " * 1000 + b"%PDF-1.7\n",
            # Known false positive, kept: a text file mentioning the header still fails closed.
            b"# Notes\nA PDF starts with %PDF- then a version.\n",
        )
        for data in lenient:
            self.assertTrue((scan.sniff(data) or "").startswith("pdf"), data[:40])

    def test_scan_text_with_a_very_long_term_still_scans_every_slice(self):
        # 16 x 16384 = WINDOW: the old step was 0 (range() raised); a longer term gave a
        # negative step and an EMPTY loop (nothing scanned). The window now grows instead.
        for n in (16384, 17000):
            term = ("q" * (n - 6)) + "zyxwvu"
            filler = "a b " * (scan.WINDOW // 2)
            self.assertEqual(scan.scan_text(filler + term.upper() + filler, [term]), [0], n)
            self.assertEqual(scan.scan_text(filler + filler, [term]), [], n)

    def test_load_terms_context_shapes(self):
        ok = {"d": {"always": [], "context": [CTX_TERM], "context_requires_any": [ANCHOR]}}
        self.assertEqual(scan.load_terms(self._roster(ok)), sorted([CTX_TERM, ANCHOR]))
        for bad in ({"context": "x"}, {"context": [1]}, {"context": None},
                    {"context": [CTX_TERM], "context_requires_any": "x"},
                    {"context": [CTX_TERM], "context_requires_any": [None]},
                    {"context": [CTX_TERM], "context_requires_any": [["x"]]},
                    {"context_requires_any": [ANCHOR, 3]}):
            self.assertIsNone(scan.load_terms(self._roster({"d": dict(bad, always=[])})), bad)
            self.assertIsNone(scan.load_roster(self._roster({"d": dict(bad, always=[])})), bad)
        # a metadata-looking key that carries context terms is a deal, not metadata
        self.assertEqual(scan.load_terms(self._roster({"_d": {"context": ["Abcde"]}})), ["abcde"])
        # declared terms that are all blank: cannot know what to look for -> fail closed
        self.assertIsNone(scan.load_roster(self._roster({"d": {"context": ["  "]}})))
        self.assertIsNone(scan.load_roster(self._roster({"d": {"always": [""]}})))
        # an inactive deal's context terms are ignored
        r = scan.load_roster(self._roster({"d": {"active": False, "context": [CTX_TERM]}}))
        self.assertFalse(r.can_block())

    def test_context_resolution(self):
        r = scan.load_roster(self._roster(CTX_ROSTER))
        self.assertTrue(r.can_block(), "a context-only deal must never take the fast path")
        ti, ai = r.terms.index(CTX_TERM), r.terms.index(ANCHOR)
        self.assertEqual(r.blocking([ti]), [])
        self.assertEqual(r.blocking([ai]), [])
        self.assertEqual(r.blocking([ti, ai]), [ti])
        self.assertEqual(r.hits("%s .. %s" % (ANCHOR.upper(), CTX_TERM)), [ti])
        self.assertEqual(r.hits(CTX_TERM), [])
        for anchors in (None, [], [""], [" \t"], [ZWSP], ["", ANCHOR]):
            deal = {"context": [CTX_TERM]}
            if anchors is not None:
                deal["context_requires_any"] = anchors
            r = scan.load_roster(self._roster({"d": deal}))
            self.assertEqual(r.hits("at %s today" % CTX_TERM), [r.terms.index(CTX_TERM)], anchors)

    def test_context_only_roster_scans_instead_of_fast_path(self):
        repo = tempfile.mkdtemp()
        self.addCleanup(_rmtree, repo)
        subprocess.run(["git", "init", "-q", repo], check=True, capture_output=True)
        line = "refs/heads/main %s refs/heads/main %s\n" % ("a" * 40, "b" * 40)
        # unknown shas: a real scan fails closed; the old fast path returned 0 unscanned
        self.assertEqual(scan.main(stdin_text=line, roster=self._roster(CTX_ROSTER), cwd=repo), 1)
        self.assertEqual(scan.main(stdin_text=line, roster=self._roster(
            {"d": {"active": False, "context": [CTX_TERM]}}), cwd=repo), 0)

    def test_blank_anchor_mirrors_guard_deletion_set(self):
        for a in ("", "   ", ZWSP, "\u3164", "\u2800", "\u115f\u1160", "\u0301", "\ufe0f",
                  "\u00b2", ZWSP + "\u00a0" + "\ufeff", "\u200d\u0301 \u3164"):
            self.assertTrue(scan._blank(a), repr(a))
        for a in ("a", "q7", "\u3164a", "projectcode" + ZWSP + "q7"):
            self.assertFalse(scan._blank(a), repr(a))
        for a in ("\u3164", "\u2800", "\u0301", "\ufe0f"):
            r = scan.load_roster(self._roster({"d": {"context": [CTX_TERM],
                                                     "context_requires_any": [a, ANCHOR]}}))
            self.assertEqual(r.hits("at %s" % CTX_TERM), [r.terms.index(CTX_TERM)], repr(a))

    def test_anchor_forms_mirror_guard_tight_form(self):
        r = scan.load_roster(self._roster({"d": {"context": [CTX_TERM],
                                                 "context_requires_any": ["projectcode" + ZWSP + "q7"]}}))
        ti = r.terms.index(CTX_TERM)
        self.assertEqual(r.hits("%s: %s" % (ANCHOR, CTX_TERM)), [ti])
        self.assertEqual(r.hits(CTX_TERM), [])
        # accented anchor (invented): matches with and without the accent, as in the guard
        r = scan.load_roster(self._roster({"d": {"context": [CTX_TERM],
                                                 "context_requires_any": ["Br\u00fbl\u00e9 Yard"]}}))
        ti = r.terms.index(CTX_TERM)
        for text in ("brule yard %s", "Br\u00fbl\u00e9 Yard %s", "Bru\u0302le\u0301 yard %s"):
            self.assertEqual(r.hits(text % CTX_TERM), [ti], text)

    def test_invisible_plus_separator_anchor_is_unanchored(self):
        # rv3/G: anchors whose guard-tight form is only separators
        for anchors in (["\u2060-"], ["\u200b_"], ["-\u200d"], ["\ufeff-"], ["\u2060 - "],
                        ["\u2060-", ANCHOR], ["\u00ad."]):
            r = scan.load_roster(self._roster({"d": {"context": ["zqxvterm"],
                                                     "context_requires_any": anchors}}))
            self.assertEqual(r.hits("zqxvterm - x"), [r.terms.index("zqxvterm")], anchors)

    def test_ascii_deleted_re_matches_guard_table(self):
        table = {c for c in scan._T_GUARD_TIGHT if c < 128}
        regex = {c for c in range(128) if scan._ASCII_DELETED_RE.match(chr(c))}
        self.assertEqual(regex, table)
        self.assertEqual(table, set(range(0, 9)) | set(range(0x0E, 0x1C)) | {0x7F})

    def test_every_git_call_goes_through_one_helper(self):
        with open(SCAN, encoding="utf-8") as f:
            src = f.read()
        self.assertEqual(src.count('["git"'), 1, "only GIT_BASE may spell the git command")
        self.assertNotIn("subprocess.run([", src)
        self.assertNotIn("subprocess.Popen([", src)
        self.assertEqual(scan.GIT_BASE[:2], ["git", "--no-replace-objects"])
        old = os.environ.get("GIT_REPLACE_REF_BASE")
        os.environ["GIT_REPLACE_REF_BASE"] = "refs/heads/"
        try:
            env = scan._git_env()
        finally:
            if old is None:
                os.environ.pop("GIT_REPLACE_REF_BASE")
            else:
                os.environ["GIT_REPLACE_REF_BASE"] = old
        self.assertEqual(env.get("GIT_NO_REPLACE_OBJECTS"), "1")
        self.assertNotIn("GIT_REPLACE_REF_BASE", env)

    def test_separator_only_anchor_is_unanchored(self):
        # C2: an anchor of separators only has no match form: the group must not go dead.
        for anchors in (["-"], ["_"], ["."], ["-_."], [" - "], ["-", ANCHOR], [ANCHOR, "_"]):
            r = scan.load_roster(self._roster({"d": {"context": ["zqxvterm"],
                                                     "context_requires_any": anchors}}))
            self.assertTrue(r.can_block())
            self.assertEqual(r.hits("zqxvterm - x"), [r.terms.index("zqxvterm")], anchors)

    def test_invisible_or_combining_char_inside_anchor_in_text(self):
        # C2 text side: the guard tightens the TEXT too, so these anchors are present.
        r = scan.load_roster(self._roster(CTX_ROSTER))
        ti = r.terms.index(CTX_TERM)
        for text in ("projectcode\u2060q7: %s", "projectcod\u0301eq7: %s",
                     "project" + ZWSP + "codeq7 &amp; %s", "PROJECTCODE\u00adQ7 %s"):
            self.assertEqual(r.hits(text % CTX_TERM), [ti], repr(text))
        self.assertEqual(r.hits("projectcode q7: %s" % CTX_TERM), [])
        self.assertEqual(r.hits("projectcode\u2060q7 only"), [])

    def test_unrecognised_raw_log_field_blocks(self):
        mk = "ORA-PREPUSH-x"
        good = mk + "a" * 40 + "\0\n:100644 100644 " + "1" * 40 + " " + "2" * 40 + " M\0p\0"
        self.assertEqual(scan.parse_raw_log(good.encode(), mk), [("a" * 40, "p", "2" * 40)])
        for junk in ("No signature\n" + mk + "b" * 40, "\x1b[33m" + mk + "b" * 40, "gpg: x"):
            with self.assertRaises(scan.Unscannable, msg=repr(junk)):
                scan.parse_raw_log((good + junk + "\0").encode(), mk)
        self.assertEqual(scan.parse_raw_log((good + "\n\0").encode(), mk),
                         [("a" * 40, "p", "2" * 40)])

    def test_git_base_pins_log_output_config(self):
        pinned = " ".join(scan.GIT_BASE)
        for kv in ("log.showSignature=false", "color.ui=false", "diff.relative=false"):
            self.assertIn(kv, pinned)

    def test_guard_tables_match_live_guard_when_present(self):
        import re
        guard = os.path.join(os.path.expanduser("~"), ".claude", "hooks",
                             "confidentiality-guard.py")
        if not os.path.isfile(guard):
            return  # CI / other machines: the pinned hash below still guards the copy
        with open(guard, encoding="utf-8") as f:
            src = f.read()
        for name in ("_TABLE_MN", "_TABLE_FMT"):
            m = re.search(r'^%s = "([^"]*)"' % name, src, re.M)
            self.assertIsNotNone(m, name)
            self.assertEqual(m.group(1), getattr(scan, name), "%s drifted from the guard" % name)

    def test_guard_tables_are_pinned(self):
        import hashlib
        self.assertEqual(hashlib.sha256("|".join((scan._TABLE_MN, scan._TABLE_FMT)).encode())
                         .hexdigest(), GUARD_TABLES_SHA256)

    def test_window_overlap_covers_four_url_rounds(self):
        term = ("quiet marsh park " * 59).strip()               # ~1000 chars, invented
        enc = "".join("%%252525%02X" % ord(c) for c in term)   # 9 chars per char, 4 rounds
        p = scan.WINDOW - (len(enc) + scan.MIN_OVERLAP) // 2
        text = "a" * p + enc + "a" * scan.WINDOW
        self.assertEqual(scan.scan_text(text, [term]), [0])

    def test_url_encoded_plus_term_matches(self):
        self.assertEqual(scan.scan_text("re: C%2BD Yard", ["c+d yard"]), [0])

    def test_url_encoded_forms_match(self):
        t = [CTX_TERM]
        for text in ("Quiet%20Marsh%20Park", "Quiet+Marsh+Park", "%51uiet%20Marsh%20Park",
                     "Quiet%2520Marsh%2520Park", "Quiet%252520Marsh%252520Park",
                     "quiet%2Bmarsh%2Bpark", "Q%75iet%5FMarsh%2DPark"):
            self.assertEqual(scan.scan_text(text, t), [0], text)
        # decoding must not create cross-word matches for a one-word term
        self.assertEqual(scan.scan_text("east+on east%20on", ["easton"]), [])
        # a term that itself contains '+' still matches its literal spelling
        self.assertEqual(scan.scan_text("re: C+D Yard", ["c+d yard"]), [0])

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
        c, d = "c" * 40, "d" * 40
        r = scan.rev_range(a, b, [c, d])        # existing ref: git's remote sha is the truth
        self.assertEqual((r.git_args(), r.stdin()), ([a, "^" + b], None))
        r = scan.rev_range(a, z, [c, d])        # new ref: advertised shas, on stdin
        self.assertEqual((r.git_args(), r.stdin()), ([a, "--stdin"], "^%s\n^%s\n" % (c, d)))
        for nothing in (None, []):              # nothing advertised / ls-remote failed
            r = scan.rev_range(a, z, nothing)
            self.assertEqual((r.git_args(), r.stdin()), ([a], None))

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


class PlantedInterpreter(unittest.TestCase):
    """A python planted in the worktree must never stand in for the real one. git runs the
    hook in the worktree root, so '.', an empty or relative entry, the worktree itself (or a
    case variant), a '..' entry or a junction/symlink INTO a worktree subdirectory on PATH
    would otherwise resolve the bare name `python` to the planted copy (refute run
    wf_39e200e8-462). Every case is a real `git push`."""

    def setUp(self):
        self.sb = Sandbox(ROSTER)
        self.marker = os.path.join(self.sb.root, "planted-python-ran")
        self.real = os.path.dirname(os.path.abspath(sys.executable))

    def tearDown(self):
        self.sb.close()

    def plant(self, d):
        os.makedirs(d, exist_ok=True)
        body = "#!/bin/sh\necho ran >> '%s'\nexit 0\n" % self.marker.replace("\\", "/")
        for n in ("python", "python3", "py"):
            path = os.path.join(d, n)
            with open(path, "w", newline="\n") as f:
                f.write(body)
            os.chmod(path, 0o755)

    def links_into(self, target):
        """Directory links outside the worktree that point at `target` inside it. Windows: a
        junction (no privilege needed; must succeed) plus a symlink when the account may make
        one. Elsewhere: a symlink (must succeed). Never skips: CI's skip baseline is zero."""
        links = []
        if os.name == "nt":
            j = os.path.join(self.sb.root, "jlink")
            p = subprocess.run(["cmd", "/c", "mklink", "/J", j, target], capture_output=True)
            self.assertEqual(p.returncode, 0, "mklink /J failed: %r" % p.stderr)
            links.append(j)
            s = os.path.join(self.sb.root, "slink")
            try:
                os.symlink(target, s, target_is_directory=True)
                links.append(s)
            except OSError:
                pass        # WinError 1314 without Developer Mode; the junction covers it
        else:
            s = os.path.join(self.sb.root, "slink")
            os.symlink(target, s, target_is_directory=True)
            links.append(s)
        return links

    def set_path(self, *front):
        self.sb.env["PATH"] = os.pathsep.join(list(front) + [self.real, os.environ.get("PATH", "")])

    def assertBlockedByRealScan(self, rc, err):
        self.assertNotEqual(rc, 0, "push should have been blocked:\n" + err)
        self.assertIn("pre-push BLOCKED", err)
        self.assertFalse(os.path.exists(self.marker), "the planted python ran:\n" + err)
        self.assertNotIn(TERM.lower(), err.lower(), "a roster term was echoed")

    def push_term_with_path(self, *front):
        self.set_path(*front)
        self.sb.commit("deal.md", "memo for %s\n" % TERM)
        self.assertBlockedByRealScan(*self.sb.push())

    def test_dot_first_on_path_runs_real_scanner(self):
        self.plant(self.sb.work)
        self.push_term_with_path(".")

    def test_empty_and_relative_entries_are_dropped(self):
        self.plant(self.sb.work)
        self.plant(os.path.join(self.sb.work, "bin"))
        self.push_term_with_path("", "bin", "./bin")

    def test_absolute_worktree_entry_and_case_variant_are_dropped(self):
        sub = os.path.join(self.sb.work, "sub")
        self.plant(self.sb.work)
        self.plant(sub)
        front = [self.sb.work, sub]
        if os.name == "nt":
            front = [self.sb.work.upper(), sub.swapcase()] + front
        self.push_term_with_path(*front)

    def test_dotdot_entry_back_into_worktree_is_dropped(self):
        sub = os.path.join(self.sb.work, "sub")
        self.plant(sub)
        # End-to-end only: MSYS normalises '..' away before the hook sees it on Windows, and
        # the physical-path check drops the entry anyway. PathBlock pins the '..' filter.
        os.makedirs(os.path.join(self.sb.root, "hk"), exist_ok=True)
        self.push_term_with_path(os.path.join(self.sb.root, "hk", "..", "work", "sub"))

    def test_link_into_worktree_subdirectory_is_dropped(self):
        # A junction/symlink OUTSIDE the worktree whose target is INSIDE it has no string
        # prefix equal to the worktree; only its physical path gives it away.
        sub = os.path.join(self.sb.work, "deep", "bin")
        self.plant(sub)
        links = self.links_into(sub)
        for i, link in enumerate(links):
            self.set_path(link)         # each link alone is the first hit for `python`
            self.sb.commit("deal-%d.md" % i, "memo for %s\n" % TERM)
            self.assertBlockedByRealScan(*self.sb.push())

    def test_planted_python_does_not_block_a_clean_push(self):
        # The real interpreter later on PATH is still found once the planted entries are gone.
        self.plant(self.sb.work)
        self.set_path(".")
        self.sb.commit("notes.md", "nothing confidential here\n")
        rc, err = self.sb.push()
        self.assertEqual(rc, 0, "push should have been allowed:\n" + err)
        self.assertFalse(os.path.exists(self.marker), "the planted python ran:\n" + err)

    def test_untracked_module_beside_scanner_is_not_imported(self):
        # The scanner runs isolated (-I): an untracked json.py beside the tracked scanner copy
        # is not imported in its place. Both layouts (tools/ and scripts/) carry the copy.
        dirs = [os.path.join(self.sb.work, d) for d in ("tools", "scripts")]
        for d in dirs:
            os.makedirs(d, exist_ok=True)
            shutil.copyfile(SCAN, os.path.join(d, "prepush_confidential_scan.py"))
        self.sb.git(self.sb.work, "add", "-A")
        self.sb.git(self.sb.work, "commit", "-q", "--no-verify", "-m", "add scanner")
        for d in dirs:
            with open(os.path.join(d, "json.py"), "w", newline="\n") as f:
                f.write("import sys\nopen(%r, 'w').close()\nsys.exit(0)\n" % self.marker)
        self.set_path()
        self.sb.commit("deal.md", "memo for %s\n" % TERM)
        self.assertBlockedByRealScan(*self.sb.push())

    def wrap_python(self):
        """A python/python3/py OUTSIDE the worktree, first on PATH, that logs how the hook calls
        it and then runs the real interpreter. Proves -I and the Windows no-cwd-search variable
        reach every interpreter call (2026-11-14 refute: deleting either passed every test).
        The inherited variable is removed so only the hook's own export can supply it."""
        wrap = os.path.join(self.sb.root, "wrap")
        os.makedirs(wrap)
        log = os.path.join(self.sb.root, "wrap.log")
        real = os.path.abspath(sys.executable).replace("\\", "/")
        body = ('#!/bin/sh\n'
                'printf \'%s|%s|%s\\n\' "${NoDefaultCurrentDirectoryInExePath-}" "$1" "$2" >> \'@LOG@\'\n'
                'exec \'@REAL@\' "$@"\n').replace("@LOG@", log.replace("\\", "/")).replace("@REAL@", real)
        for n in ("python", "python3", "py"):
            path = os.path.join(wrap, n)
            with open(path, "w", newline="\n") as f:
                f.write(body)
            os.chmod(path, 0o755)
        for k in [k for k in self.sb.env if k.upper() == "NODEFAULTCURRENTDIRECTORYINEXEPATH"]:
            del self.sb.env[k]
        self.set_path(wrap)
        return log

    def test_every_interpreter_call_is_isolated_with_cwd_exe_search_off(self):
        log = self.wrap_python()
        self.sb.commit("deal.md", "memo for %s\n" % TERM)
        self.assertBlockedByRealScan(*self.sb.push())
        with open(log, encoding="utf-8") as f:
            calls = [line.rstrip("\n").split("|") for line in f if line.strip()]
        scans = [c for c in calls if c[2] != "-c"]
        self.assertTrue(scans, "the scanner never ran through the logged interpreter: %r" % calls)
        for c in calls:
            self.assertEqual(c[0], "1", "NoDefaultCurrentDirectoryInExePath not exported: %r" % c)
            self.assertEqual(c[1], "-I", "interpreter called without -I: %r" % c)

    def test_committed_scanner_runs_even_when_fallback_copy_is_noop(self):
        # HEAD tracks the real scanner, so its blob must be what runs, not the copy beside the
        # hook (2026-11-14 refute: dropping SCAN=$TMPSCAN passed every test).
        dst = os.path.join(self.sb.work, *self.sb.rel.split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(SCAN, dst)
        self.sb.git(self.sb.work, "add", "-A")
        self.sb.git(self.sb.work, "commit", "-q", "--no-verify", "-m", "add scanner")
        self.sb.commit("deal.md", "memo for %s\n" % TERM)
        self.plant_noop_scanner(os.path.dirname(self.sb.fallback))
        if os.path.basename(self.sb.fallback) != "prepush_confidential_scan.py":
            os.replace(os.path.join(os.path.dirname(self.sb.fallback), "prepush_confidential_scan.py"),
                       self.sb.fallback)
        self.set_path()
        self.assertBlockedByRealScan(*self.sb.push())

    def plant_noop_scanner(self, d):
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "prepush_confidential_scan.py"), "w", newline="\n") as f:
            f.write("import sys\nopen(%r, 'w').close()\nsys.exit(0)\n" % self.marker)

    def test_untracked_scanner_in_worktree_is_not_used(self):
        # The tree does not track the scanner; a planted copy must not replace the hook's own.
        for d in ("tools", "scripts"):
            self.plant_noop_scanner(os.path.join(self.sb.work, d))
        self.set_path()
        self.sb.commit("deal.md", "memo for %s\n" % TERM)   # commit -A would track them: undo
        self.sb.git(self.sb.work, "rm", "-q", "--cached", "-r", "tools", "scripts")
        self.sb.git(self.sb.work, "commit", "-q", "--no-verify", "--amend", "--no-edit")
        self.assertBlockedByRealScan(*self.sb.push())

    def test_edited_tracked_scanner_in_worktree_is_not_used(self):
        dirs = [os.path.join(self.sb.work, d) for d in ("tools", "scripts")]
        for d in dirs:
            os.makedirs(d, exist_ok=True)
            shutil.copyfile(SCAN, os.path.join(d, "prepush_confidential_scan.py"))
        self.sb.git(self.sb.work, "add", "-A")
        self.sb.git(self.sb.work, "commit", "-q", "--no-verify", "-m", "add scanner")
        self.sb.commit("deal.md", "memo for %s\n" % TERM)
        # Age the files and refresh the index so it is not "racily clean" (a checkout made
        # earlier than the index write): then only size+mtime decide in git's stat cache.
        for d in dirs:
            path = os.path.join(d, "prepush_confidential_scan.py")
            old = os.stat(path).st_mtime_ns - 3600 * 10 ** 9
            os.utime(path, ns=(old, old))
        self.sb.git(self.sb.work, "update-index", "-q", "--really-refresh")
        for d in dirs:
            # Same size and mtime restored: git's stat cache would call this file unmodified
            # (2026-11-13 refute round 2), so the hook must not trust `git diff` either.
            path = os.path.join(d, "prepush_confidential_scan.py")
            st = os.stat(path)
            payload = ("import sys\nopen(%r, 'w').close()\nsys.exit(0)\n" % self.marker).encode()
            payload += b"#" * (st.st_size - len(payload))
            with open(path, "wb") as f:
                f.write(payload)
            os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.set_path()
        self.assertBlockedByRealScan(*self.sb.push())

    def test_edited_tracked_scanner_in_worktree_is_not_used_size_change(self):
        dirs = [os.path.join(self.sb.work, d) for d in ("tools", "scripts")]
        for d in dirs:
            os.makedirs(d, exist_ok=True)
            shutil.copyfile(SCAN, os.path.join(d, "prepush_confidential_scan.py"))
        self.sb.git(self.sb.work, "add", "-A")
        self.sb.git(self.sb.work, "commit", "-q", "--no-verify", "-m", "add scanner")
        self.sb.commit("deal.md", "memo for %s\n" % TERM)
        for d in dirs:
            self.plant_noop_scanner(d)          # uncommitted edit after the commit
        self.set_path()
        self.assertBlockedByRealScan(*self.sb.push())


HOOK_FILE = HOOKSPATH_SHIM if os.path.isfile(HOOKSPATH_SHIM) else os.path.join(HERE, "git-hooks", "pre-push")


def _posix(p):
    """POSIX spelling sh understands without any conversion (C:\\x\\y -> /c/x/y on Windows)."""
    p = os.path.abspath(p)
    if os.name == "nt":
        drive, rest = os.path.splitdrive(p)
        return "/" + drive[0].lower() + rest.replace("\\", "/")
    return p


def _sh():
    """The sh git runs hooks with: on PATH, else beside Git for Windows' exec path."""
    found = shutil.which("sh")
    if not found:
        exec_path = subprocess.run(["git", "--exec-path"], capture_output=True,
                                   text=True).stdout.strip()
        cand = os.path.join(exec_path, "..", "..", "..", "usr", "bin", "sh.exe")
        found = os.path.normpath(cand) if os.path.isfile(cand) else None
    assert found, "no sh found to run the hook's PATH block"
    return found


class PathBlock(unittest.TestCase):
    """The hook's PATH block run on its own in sh, with PATH set INSIDE sh: a native process
    handing PATH to MSYS sh has '.' and '..' segments normalised away first, so a real push
    on Windows never shows the block those spellings (2026-11-14 refute). Each case pins one
    filter line: deleting it makes the case fail. Never skips."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="ora-pathblock-")
        self.work = os.path.join(self.root, "work")
        os.makedirs(os.path.join(self.work, "bin"))
        with open(HOOK_FILE, encoding="utf-8") as f:
            lines = f.read().replace("\r\n", "\n").split("\n")
        start = lines.index("NoDefaultCurrentDirectoryInExePath=1")
        end = next(i for i, ln in enumerate(lines) if "no usable PATH entry outside the worktree" in ln)
        self.assertEqual(lines[end + 1:end + 3], ["  exit 1", "fi"])
        self.block = "\n".join(lines[start:end + 3])

    def tearDown(self):
        _rmtree(self.root)

    def run_block(self, path_value, cwd, cdpath=""):
        """Returns (rc, [entries kept], stderr). PATH and CDPATH come from a file read with the
        `read` built-in, so nothing outside sh rewrites them."""
        vals = os.path.join(self.root, "vals")
        with open(vals, "w", newline="\n") as f:
            f.write(path_value + "\n" + cdpath + "\n")
        script = os.path.join(self.root, "block.sh")
        with open(script, "w", newline="\n") as f:
            f.write('{ IFS= read -r PATH; IFS= read -r CDPATH; } < "$1"\n'
                    '[ -n "$CDPATH" ] && export CDPATH || unset CDPATH\n'
                    + self.block + '\nprintf "%s\\n" "$PATH"\n')
        env = dict(os.environ)
        env.pop("CDPATH", None)
        p = subprocess.run([_sh(), script, vals.replace("\\", "/")], cwd=cwd, env=env,
                           capture_output=True, text=True)
        out = p.stdout.strip().splitlines()
        kept = out[-1].split(":") if p.returncode == 0 and out else []
        return p.returncode, kept, p.stderr

    def test_relative_entry_is_dropped_even_when_cdpath_resolves_it_outside(self):
        # With CDPATH set, `cd -P bin` lands OUTSIDE the worktree, but exec lookup of the
        # relative entry `bin` still means <worktree>/bin: only the absolute-only filter stops it.
        outside = os.path.join(self.root, "outside")
        os.makedirs(os.path.join(outside, "bin"))
        rc, kept, err = self.run_block("bin:/usr/bin", self.work, cdpath=_posix(outside))
        self.assertNotIn("bin", kept, err)

    def test_dotdot_entry_is_dropped_even_when_it_resolves_outside(self):
        outside = os.path.join(self.root, "outside", "bin")
        os.makedirs(outside)
        dotted = _posix(os.path.join(self.root, "outside")) + "/../outside/bin"
        rc, kept, err = self.run_block(dotted + ":/usr/bin", self.work)
        self.assertNotIn(dotted, kept, err)

    def test_filesystem_root_as_cwd_drops_everything_under_it(self):
        # The parent walk must reach '/' (and 'C:/'): the line that turns '' or 'C:' into a
        # root is what lets a worktree at a filesystem root contain anything.
        root = os.path.abspath(os.sep)
        rc, kept, err = self.run_block("/usr/bin:/tmp", root)
        self.assertNotIn("/usr/bin", kept, err)
        self.assertNotIn("/tmp", kept, err)

    def test_mount_whose_real_folder_is_inside_the_worktree_is_dropped(self):
        # Git for Windows mounts /tmp on the user's temp folder: run from that folder's parent,
        # /tmp's MSYS path shares no prefix with the cwd and only its Windows spelling
        # (pwd -W) shows it is inside. Elsewhere /tmp sits under the cwd (/) anyway.
        cwd = os.path.dirname(os.path.realpath(tempfile.gettempdir()))
        rc, kept, err = self.run_block("/tmp:/usr/bin", cwd)
        self.assertNotIn("/tmp", kept, err)

    def test_no_usable_entry_blocks(self):
        rc, kept, err = self.run_block("bin:.:" + _posix(self.work), self.work)
        self.assertEqual(rc, 1, err)
        self.assertIn("no usable PATH entry", err)

    def test_an_ordinary_outside_entry_is_kept(self):
        outside = os.path.join(self.root, "outside", "bin")
        os.makedirs(outside)
        rc, kept, err = self.run_block(_posix(outside) + ":/usr/bin", self.work)
        self.assertEqual(rc, 0, err)
        self.assertIn(_posix(outside), kept)


if __name__ == "__main__":
    unittest.main(verbosity=2)
