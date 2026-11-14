#!/usr/bin/env python3
"""ora-pm-only tests for the installed pre-push hook's pinned-first stage.

The installer copies scripts/git-hooks/pre-push and a PINNED scanner copy
(ora_prepush_confidential_scan.py) into the clone's untracked hooks directory. The hook must
ALWAYS run that pinned copy first: a commit that swaps scripts/prepush_confidential_scan.py for a
no-op can then only ADD blocks through the HEAD-blob stage, never remove one. Every case is a real
`git push` through the installed hook. The shared, cross-repo suite stays in
test_prepush_confidential_scan.py (byte-identical with ora-skills); this file reuses its Sandbox.

    python scripts/test_install_prepush_hook.py
"""
import importlib.util
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "test_prepush_confidential_scan", os.path.join(HERE, "test_prepush_confidential_scan.py"))
shared = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shared)

SCAN = shared.SCAN
TERM = shared.TERM
ROSTER = shared.ROSTER
REL = "scripts/prepush_confidential_scan.py"


class PinnedFirst(unittest.TestCase):

    def setUp(self):
        self.sb = shared.Sandbox(ROSTER)
        self.pinned = self.sb.fallback
        self.marker = os.path.join(self.sb.root, "noop-ran")
        self.tmp = os.path.join(self.sb.root, "tmp")
        os.makedirs(self.tmp)
        self.sb.env["TMPDIR"] = self.tmp.replace("\\", "/")

    def tearDown(self):
        self.sb.close()

    # -- helpers -------------------------------------------------------------------------------

    def noop_body(self, marker=None):
        line = "open(%r, 'a').close()\n" % (marker or self.marker)
        return "import sys\n" + line + "sys.exit(0)\n"

    def dump_body(self, out):
        """A scanner stand-in that records argv and stdin, then allows."""
        return ("import sys\n"
                "data = sys.stdin.buffer.read()\n"
                "with open(%r, 'wb') as f:\n"
                "    f.write(repr(sys.argv[1:]).encode() + b'\\n' + data)\n"
                "sys.exit(0)\n" % out)

    def commit_scanner(self, body):
        """Commit `body` as the tracked scanner at HEAD (what a malicious local commit does)."""
        self.sb.commit(REL, body, "scanner change")

    def commit_real_scanner(self):
        with open(SCAN, "rb") as f:
            self.sb.commit(REL, f.read(), "add scanner")

    def set_pinned(self, body):
        with open(self.pinned, "w", newline="\n") as f:
            f.write(body)

    def assertBlocked(self, rc, err, why="push should have been blocked"):
        self.assertNotEqual(rc, 0, why + ":\n" + err)
        self.assertIn("pre-push BLOCKED", err)
        self.assertNotIn(TERM.lower(), err.lower(), "a roster term was echoed")

    def assertAllowed(self, rc, err):
        self.assertEqual(rc, 0, "push should have been allowed:\n" + err)
        self.assertNotIn("pre-push BLOCKED", err)

    # -- the gap this stage closes ---------------------------------------------------------------

    def test_committed_noop_scanner_cannot_disable_the_gate(self):
        self.commit_scanner(self.noop_body())
        self.sb.commit("deal.md", "memo for %s\n" % TERM)
        rc, err = self.sb.push()
        self.assertBlocked(rc, err, "a no-op scanner committed at HEAD turned the gate off")

    def test_committed_noop_scanner_in_the_same_commit_as_the_term(self):
        path = os.path.join(self.sb.work, *REL.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", newline="\n") as f:
            f.write(self.noop_body())
        self.sb.commit("deal.md", "memo for %s\n" % TERM)
        self.assertBlocked(*self.sb.push())

    # -- pinned stage: fail-closed ---------------------------------------------------------------

    def test_missing_pinned_copy_blocks_even_a_clean_push(self):
        self.commit_real_scanner()
        os.remove(self.pinned)
        self.sb.commit("notes.md", "nothing confidential here\n")
        rc, err = self.sb.push()
        self.assertBlocked(rc, err)
        self.assertIn("pinned", err)

    def test_pinned_nonzero_blocks_a_clean_push(self):
        self.commit_real_scanner()
        self.set_pinned("import sys\nsys.exit(3)\n")
        self.sb.commit("notes.md", "nothing confidential here\n")
        self.assertNotEqual(self.sb.push()[0], 0, "a nonzero pinned scan must block")

    def test_pinned_blocks_without_the_head_stage(self):
        # HEAD does not track the scanner (the sandbox seed): only the pinned copy runs.
        self.sb.commit("deal.md", "memo for %s\n" % TERM)
        self.assertBlocked(*self.sb.push())

    def test_no_python_blocks(self):
        # python/python3/py stand-ins outside the worktree, first on PATH, that fail the 3.8+
        # probe: the hook must refuse to run rather than skip the scan.
        stub = os.path.join(self.sb.root, "stubpy")
        os.makedirs(stub)
        for n in ("python", "python3", "py"):
            p = os.path.join(stub, n)
            with open(p, "w", newline="\n") as f:
                f.write("#!/bin/sh\nexit 1\n")
            os.chmod(p, 0o755)
        self.sb.env["PATH"] = os.pathsep.join([stub, os.environ.get("PATH", "")])
        self.sb.commit("notes.md", "nothing confidential here\n")
        rc, err = self.sb.push()
        self.assertBlocked(rc, err)
        self.assertIn("no Python 3.8+", err)

    # -- HEAD stage: can only add blocks ---------------------------------------------------------

    def test_head_stage_still_blocks_when_pinned_copy_allows(self):
        self.commit_real_scanner()
        self.set_pinned(self.noop_body())
        self.sb.commit("deal.md", "memo for %s\n" % TERM)
        self.assertBlocked(*self.sb.push())
        self.assertTrue(os.path.exists(self.marker), "the pinned copy did not run first")

    def test_head_stage_nonzero_blocks(self):
        self.commit_scanner("import sys\nsys.exit(5)\n")
        self.sb.commit("notes.md", "nothing confidential here\n")
        self.assertNotEqual(self.sb.push()[0], 0, "a nonzero HEAD scan must block")

    def test_empty_scanner_at_head_blocks(self):
        self.commit_scanner("")
        self.sb.commit("notes.md", "nothing confidential here\n")
        self.assertBlocked(*self.sb.push())

    def test_both_stages_get_the_same_ref_lines_and_arguments(self):
        a = os.path.join(self.sb.root, "pinned.out")
        b = os.path.join(self.sb.root, "head.out")
        self.set_pinned(self.dump_body(a))
        self.commit_scanner(self.dump_body(b))
        self.sb.commit("notes.md", "nothing confidential here\n")
        self.assertAllowed(*self.sb.push())
        with open(a, "rb") as f:
            got_a = f.read()
        with open(b, "rb") as f:
            got_b = f.read()
        self.assertEqual(got_a, got_b)
        self.assertIn(b"origin", got_a.split(b"\n", 1)[0])
        self.assertIn(b"refs/heads/main", got_a.split(b"\n", 1)[1])

    def test_clean_push_with_real_scanner_at_head_is_allowed(self):
        self.commit_real_scanner()
        self.sb.commit("notes.md", "nothing confidential here\n")
        self.assertAllowed(*self.sb.push())

    def test_clean_push_without_scanner_at_head_is_allowed(self):
        self.sb.commit("notes.md", "nothing confidential here\n")
        self.assertAllowed(*self.sb.push())

    def test_unusable_tmpdir_blocks(self):
        # No temp file for the ref lines => no scan => BLOCKED, never "allow".
        self.sb.env["TMPDIR"] = os.path.join(self.sb.root, "missing", "dir").replace("\\", "/")
        self.sb.commit("notes.md", "nothing confidential here\n")
        self.assertBlocked(*self.sb.push())

    def test_partial_ref_buffering_blocks(self):
        # A cat that writes only part of git's ref lines and then fails (ENOSPC/EIO in TMPDIR)
        # must block: the scanner allows when it sees no complete ref line (2026-11-14 refute).
        stub = os.path.join(self.sb.root, "stubcat")
        os.makedirs(stub)
        p = os.path.join(stub, "cat")
        with open(p, "w", newline="\n") as f:
            f.write("#!/bin/sh\nhead -c 20\nexit 1\n")
        os.chmod(p, 0o755)
        self.sb.env["PATH"] = os.pathsep.join([stub, os.environ.get("PATH", "")])
        self.sb.commit("deal.md", "memo for %s\n" % TERM)
        rc, err = self.sb.push()
        self.assertBlocked(rc, err)
        self.assertIn("cannot buffer the ref lines", err)

    def test_both_stages_run_isolated_with_cwd_exe_search_off(self):
        # The shared suite's -I check never reaches the HEAD stage (its sandbox does not track
        # the scanner): here both stages run, each through a logging python first on PATH.
        wrap = os.path.join(self.sb.root, "wrap")
        os.makedirs(wrap)
        log = os.path.join(self.sb.root, "wrap.log")
        real = os.path.abspath(sys.executable).replace("\\", "/")
        body = ('#!/bin/sh\n'
                'printf \'%s|%s|%s\\n\' "${NoDefaultCurrentDirectoryInExePath-}" "$1" "$2" >> \'@LOG@\'\n'
                'exec \'@REAL@\' "$@"\n').replace("@LOG@", log.replace("\\", "/")).replace("@REAL@", real)
        for n in ("python", "python3", "py"):
            p = os.path.join(wrap, n)
            with open(p, "w", newline="\n") as f:
                f.write(body)
            os.chmod(p, 0o755)
        for k in [k for k in self.sb.env if k.upper() == "NODEFAULTCURRENTDIRECTORYINEXEPATH"]:
            del self.sb.env[k]
        self.sb.env["PATH"] = os.pathsep.join([wrap, os.path.dirname(real), os.environ.get("PATH", "")])
        self.commit_real_scanner()
        self.sb.commit("notes.md", "nothing confidential here\n")
        self.assertAllowed(*self.sb.push())
        with open(log, encoding="utf-8") as f:
            calls = [ln.rstrip("\n").split("|") for ln in f if ln.strip()]
        scans = [c for c in calls if c[2] != "-c"]
        self.assertEqual(len(scans), 2, "expected the pinned and the HEAD scan: %r" % calls)
        self.assertTrue(scans[0][2].endswith("ora_prepush_confidential_scan.py"), scans)
        for c in calls:
            self.assertEqual(c[0], "1", "NoDefaultCurrentDirectoryInExePath not exported: %r" % c)
            self.assertEqual(c[1], "-I", "interpreter called without -I: %r" % c)

    def test_temp_files_are_removed(self):
        self.commit_real_scanner()
        self.sb.commit("deal.md", "memo for %s\n" % TERM)
        self.assertBlocked(*self.sb.push())
        self.sb.git(self.sb.work, "reset", "-q", "--hard", "HEAD~1")
        self.sb.commit("notes.md", "nothing confidential here\n")
        self.assertAllowed(*self.sb.push())
        self.assertEqual(os.listdir(self.tmp), [])


class Installer(unittest.TestCase):

    def test_check_reports_a_stale_pinned_copy(self):
        sb = shared.Sandbox(ROSTER)
        try:
            inst = os.path.join(HERE, "install_prepush_hook.py")
            run = lambda: subprocess.run([sys.executable, inst, "--repo", sb.work, "--check"],
                                                capture_output=True, text=True, env=sb.env)
            self.assertEqual(run().returncode, 0, run().stderr)
            with open(sb.fallback, "a") as f:
                f.write("\n# drift\n")
            p = run()
            self.assertEqual(p.returncode, 1)
            self.assertIn("stale", p.stderr)
        finally:
            sb.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
