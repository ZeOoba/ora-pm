#!/usr/bin/env python3
"""Install (or verify) the fail-closed confidentiality pre-push hook for this clone.

    python scripts/install_prepush_hook.py            # install / refresh
    python scripts/install_prepush_hook.py --check    # exit 1 unless installed and current
    python scripts/install_prepush_hook.py --force    # move an unrelated existing pre-push
                                                      # aside (never deleted), then install

.git/hooks is not version-controlled, so run this once per fresh clone. It writes two files
into the clone's shared hooks directory (`git rev-parse --git-path hooks`, which every linked
worktree also uses):
  pre-push                         <- scripts/git-hooks/pre-push (the shim)
  ora_prepush_confidential_scan.py <- scripts/prepush_confidential_scan.py (fallback copy,
                                      used when the tree being pushed predates the scan)
Re-run after the tracked scan changes; `--check` reports drift.
"""
import argparse
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SHIM_SRC = os.path.join(HERE, "git-hooks", "pre-push")
SCAN_SRC = os.path.join(HERE, "prepush_confidential_scan.py")
SCAN_COPY_NAME = "ora_prepush_confidential_scan.py"
MARKER = "ORA-PREPUSH-CONFIDENTIAL-SCAN"


def _git(repo, *args):
    p = subprocess.run(["git", "-C", repo] + list(args), capture_output=True, text=True)
    return p.returncode, p.stdout.strip()


def _read(path):
    """File bytes with CRLF folded to LF: a Windows checkout (core.autocrlf) can hand us a
    CRLF shim, and `sh` would then read `exit 1\\r` -- the hook must always be written LF."""
    with open(path, "rb") as f:
        return f.read().replace(b"\r\n", b"\n")


def hooks_dir(repo):
    rc, top = _git(repo, "rev-parse", "--show-toplevel")
    if rc != 0:
        raise SystemExit("not a git work tree: %s" % repo)
    rc, hooks_path_cfg = _git(repo, "config", "--get", "core.hooksPath")
    if rc == 0 and hooks_path_cfg:
        raise SystemExit("core.hooksPath is set (%s); this installer only manages the default "
                         "hooks directory. Unset it or wire the shim in by hand." % hooks_path_cfg)
    rc, path = _git(top, "rev-parse", "--git-path", "hooks")
    if rc != 0 or not path:
        raise SystemExit("could not resolve the hooks directory")
    return path if os.path.isabs(path) else os.path.normpath(os.path.join(top, path))


def check(hooks):
    problems = []
    for dst, src in ((os.path.join(hooks, "pre-push"), SHIM_SRC),
                     (os.path.join(hooks, SCAN_COPY_NAME), SCAN_SRC)):
        if not os.path.isfile(dst):
            problems.append("missing: %s" % dst)
        elif _read(dst) != _read(src):
            problems.append("stale: %s (re-run the installer)" % dst)
    return problems


def install(hooks, force=False):
    os.makedirs(hooks, exist_ok=True)
    shim_dst = os.path.join(hooks, "pre-push")
    if os.path.isfile(shim_dst) and MARKER.encode() not in _read(shim_dst):
        if not force:
            raise SystemExit("an unrelated pre-push hook already exists at %s; re-run with "
                             "--force to move it aside (it is renamed, never deleted)." % shim_dst)
        aside = "%s.pre-ora.%s" % (shim_dst, time.strftime("%Y%m%d-%H%M%S"))
        os.replace(shim_dst, aside)
        print("moved existing pre-push aside -> %s" % aside)
    scan_dst = os.path.join(hooks, SCAN_COPY_NAME)
    for src, dst in ((SCAN_SRC, scan_dst), (SHIM_SRC, shim_dst)):
        with open(dst, "wb") as f:
            f.write(_read(src))
    for p in (shim_dst, scan_dst):
        os.chmod(p, 0o755)
    print("installed confidentiality pre-push hook -> %s" % shim_dst)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", default=os.path.dirname(HERE), help="clone to install into")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    hooks = hooks_dir(a.repo)
    if a.check:
        problems = check(hooks)
        for p in problems:
            print(p, file=sys.stderr)
        return 1 if problems else 0
    install(hooks, a.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
