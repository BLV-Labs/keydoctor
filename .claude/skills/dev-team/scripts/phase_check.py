#!/usr/bin/env python3
"""Check that a dev-team flow ran every required phase.

Usage: phase_check.py <phase-log.md> [--no-code] [--no-prd]
The phase log has one line per phase: `<phase> <result>`, e.g. `3.5 simplify: 2 fixed, 1 skipped`.
A code-changing flow needs 3.5, 3.6, 3.65, 4 and 5. With --no-code (docs/harness only) it needs 5.
A code-changing flow also needs `Epic #<n>` on a phase-5 line (`5 ...` or `5b ...`).
With --no-prd (the profile's `prd` is none) the Epic check is skipped.
A code-changing flow also needs the word `kestrel` on a 3.65 line: only a kestrel writes that result.
A 3.65 line that says `not run` also needs a kestrel spawn id (`agent-<hex>` or `id:<hex>`) or `probe:` with the command and its output.
Exit 1 and list the missing phases, else exit 0 with one OK line.
"""
import re, sys

CODE = ("3.5", "3.6", "3.65", "4", "5")


def main(a):
    if not a or a[0].startswith("--"):
        sys.exit(__doc__)
    need = ("5",) if "--no-code" in a else CODE
    lines = open(a[0]).readlines()
    ran = {m.group(1) for m in (re.match(r"\s*[-*]?\s*(\d+(?:\.\d+)?)\b", l) for l in lines) if m}
    missing = [p for p in need if p not in ran]
    if need == CODE and "--no-prd" not in a and not any(re.match(r"\s*[-*]?\s*5[a-z]?\b.*Epic #\d+", l) for l in lines):
        missing.append("5 (no `Epic #<n>`)")
    if need == CODE and "3.65" in ran and not any(re.match(r"\s*[-*]?\s*3\.65\b.*kestrel", l, re.I) for l in lines):
        missing.append("3.65 (no `kestrel` on the line)")
    if need == CODE and "3.65" in ran:
        l365 = [l for l in lines if re.match(r"\s*[-*]?\s*3\.65\b", l)]
        if all(re.search(r"not run", l, re.I) and not re.search(r"(?:agent-|id:)[0-9a-f]{8,}|probe:", l, re.I) for l in l365):
            missing.append("3.65 (`not run` needs a kestrel spawn id or `probe:`)")
    if missing:
        print(f"missing phases: {', '.join(missing)}")
        sys.exit(1)
    print(f"phase_check OK: {', '.join(need)}")


if __name__ == "__main__":
    main(sys.argv[1:])
