#!/usr/bin/env python3
"""Check that the code facts in a brief exist before the brief goes to an agent.

Usage:
  brief_check.py <brief.md> --worktree <wt> [--packet <packet.md>] [--ste-baseline N] [--builder]
  brief_check.py --selftest

Reports, one line each:
  - a backticked identifier or path that `git grep` (outside *.md) and the file system cannot find
  - an `S<n>-AC<n>` id that the packet does not contain (only with --packet)
  - a `pnpm --filter <x>` that matches no package.json name or package dir
  - with --builder: a test path (`__tests__/`, `.test.`, `.spec.`, `tests/`), since builders never touch tests
  - each hard STE violation from ste-lint.py (references/writing.md), when the count is above
    --ste-baseline (default 0; pass the origin/<integration_branch> count for an amended packet)
Skipped spans: text with spaces (commands, phrases), flags, numbers, URLs, placeholders (`<x>`, `${x}`),
and env-var values (`NAME=value` checks NAME only). Mark a symbol the brief asks the agent to create
with `(new)` right after the span: `` `fooBar` (new) ``.
Exit 1 when any item is unresolved, else exit 0 with one OK line.
"""
import json, os, re, subprocess, sys

SPAN = re.compile(r"`([^`\n]+)`(\s*\(new\))?")
AC_ID = re.compile(r"\bS\d+[a-z]?-AC\d+\b")
FILTER = re.compile(r"pnpm\s+(?:-F|--filter)[ =]([^\s`]+)")
NUMBER = re.compile(r"^[~<>=+-]?[\d.,:%]+[a-zA-Z]{0,3}$")
SHA = re.compile(r"^[0-9a-f]{7,40}$")
EXT = re.compile(r"\.(tsx?|jsx?|py|json|md|prisma|proto|sql|ya?ml|sh)$")
MIME = re.compile(r"^(application|text|image|multipart)/")
BRANCH = re.compile(r"^(feature|harness|chore|fix|claude|origin)/")
TEST_PATH = re.compile(r"[\w./-]*(?:__tests__/|\.test\.|\.spec\.|(?:^|/)tests?/)[\w./-]*")


def token(span):
    """The part of a span to look up, or None when the span is not a code fact."""
    s = re.sub(r"^(…|\.\.\.|\./|!)", "", span.strip().rstrip(".,;:"))
    if not s or " " in s or s[0] in "-#" or ")" in s or MIME.match(s) or any(c in s for c in ("://", "<", ">", "${", "*", "{", ",", "'", '"')):
        return None
    if "=" in s:
        s = s.split("=", 1)[0]
    s = re.sub(r"\([^)]*\)|\[\]|\?.*$", "", s)  # call args, `x[]`, query string / optional `?`
    s = re.sub(r":[\d,-]+$", "", s)  # path:line
    if BRANCH.match(s) or NUMBER.match(s) or len(s) < 3 or not re.search(r"[A-Za-z]", s):
        return None
    return s


def grep(wt, tok):
    return subprocess.run(["git", "-C", wt, "grep", "-qF", tok, "--", ".", ":!*.md"], capture_output=True).returncode == 0


def found(wt, tok, files):
    """SHA: a commit. Path: a tracked file or dir ends with it. Else the text is in code, or each part of `a.b` / `a/b` is."""
    t = tok.rstrip("/")
    if all(SHA.match(x) for x in t.split("..")):  # sha or sha..sha
        return all(subprocess.run(["git", "-C", wt, "cat-file", "-e", x + "^{commit}"], capture_output=True).returncode == 0
                   for x in t.split(".."))
    if any(f == t or f.endswith("/" + t) or f.startswith(t + "/") or os.path.splitext(f)[0].endswith("/" + t) for f in files):
        return True
    if grep(wt, t):
        return True
    parts = [p for p in re.split(r"[./]", t) if p]
    return len(parts) > 1 and not EXT.search(t) and all(grep(wt, p) for p in parts)


def packages(wt):
    ls = subprocess.run(["git", "-C", wt, "ls-files", "*package.json"], capture_output=True, text=True).stdout
    out = set()
    for p in ls.split():
        try:
            out.add(json.load(open(os.path.join(wt, p))).get("name"))
        except (OSError, ValueError):
            continue
        out.add(os.path.dirname(p))
        out.add("./" + os.path.dirname(p))
    return out


def check(text, wt, packet_text=None, builder=False):
    bad, seen = [], set()
    if builder:
        bad += [f"test path in a builder brief: {t}" for t in sorted(set(TEST_PATH.findall(text)))]
    files = set(subprocess.run(["git", "-C", wt, "ls-files"], capture_output=True, text=True).stdout.split())
    for m in SPAN.finditer(text):
        tok = None if m.group(2) else token(m.group(1))
        if tok and tok not in seen:
            seen.add(tok)
            if not found(wt, tok, files):
                bad.append(f"not found in code: `{tok}`")
    if packet_text is not None:
        for ac in sorted(set(AC_ID.findall(text)) - set(AC_ID.findall(packet_text))):
            bad.append(f"AC id not in packet: {ac}")
    filters = set(FILTER.findall(text))
    if filters:
        pkgs = packages(wt)
        bad += [f"pnpm --filter matches no package: {f}" for f in sorted(filters - pkgs)]
    return bad


def ste_hard(path, baseline=0):
    """Hard STE violations in the file, or [] when the count is within the baseline."""
    lint = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ste-lint.py")
    out = json.loads(subprocess.run([sys.executable, lint, "--json", path], capture_output=True, text=True).stdout)
    if out["hard_count"] <= baseline:
        return []
    return [f"ste-lint {v['line']}:{v['col']} {v['rule']}: [{v['match']}]"
            for v in out["violations"] if v["level"] == "advisory-free"]


def selftest():
    import tempfile
    # A throwaway repo, so the selftest runs the same in any checkout.
    wt = tempfile.mkdtemp(prefix="brief_check_")
    os.makedirs(os.path.join(wt, "src", "orders"))
    with open(os.path.join(wt, "src", "orders", "service.ts"), "w") as f:
        f.write("export function getOrder(id) { return process.env.ORDER_REGION; }\n")
    with open(os.path.join(wt, "package.json"), "w") as f:
        f.write('{"name": "orders-app"}\n')
    for cmd in (["init", "-q"], ["add", "-A"]):
        subprocess.run(["git", "-C", wt] + cmd, check=True, capture_output=True)
    miss, path = "zz" + "MissingSymbolQq", "src/" + "nope/missing.ts"
    brief = ("Edit `src/orders/service.ts:12`, call `getOrder` with `ORDER_REGION=eu`. Run `pnpm --filter orders-app build`, "
             "`--watch`, `5 min`, `30s`, `https://example.com`, `<app>`. Add `zzNoSuchSymbolQq` (new). Keep S1-AC2. "
             f"`{miss}`, `{path}`, S9-AC9, pnpm --filter zz-no-pkg test.")
    got = check(brief, wt, packet_text="S1-AC2 S1-AC3")
    want = [f"not found in code: `{miss}`", f"not found in code: `{path}`",
            "AC id not in packet: S9-AC9", "pnpm --filter matches no package: zz-no-pkg"]
    assert got == want, got
    got = check("Edit `src/orders/service.ts`. Leave `src/__tests__/` alone.", wt, builder=True)
    assert [g for g in got if g.startswith("test path")] == ["test path in a builder brief: src/__tests__/"], got
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write("Run the job; check the log.\n")
    try:
        assert len(ste_hard(f.name)) == 1 and ste_hard(f.name, baseline=1) == [], ste_hard(f.name)
    finally:
        os.unlink(f.name)
        import shutil
        shutil.rmtree(wt, ignore_errors=True)
    print("selftest OK")


def main(a):
    if "--selftest" in a:
        return selftest()
    if not a or "--worktree" not in a or a[0].startswith("--"):
        sys.exit(__doc__)
    opt = lambda f: a[a.index(f) + 1] if f in a else None
    packet = opt("--packet")
    bad = check(open(a[0]).read(), opt("--worktree"), open(packet).read() if packet else None, "--builder" in a)
    bad += ste_hard(a[0], int(opt("--ste-baseline") or 0))
    for b in bad:
        print(b)
    if bad:
        sys.exit(1)
    print(f"brief_check OK: {a[0]}")


if __name__ == "__main__":
    main(sys.argv[1:])
