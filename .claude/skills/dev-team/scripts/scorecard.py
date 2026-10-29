#!/usr/bin/env python3
"""Deterministic ledger for dev-team agent scoring. The judge classifies; this file does all arithmetic.

Ledger: ~/.claude/agent-scorecard/<repo-slug>/ledger.jsonl  (repo-slug = git toplevel basename)

  scorecard.py add <events.json>            append one flow's result (format below), print its scores
  scorecard.py report [--last N]            per-agent-type trend over the last N flows (default 10)
  scorecard.py patterns [--min 2]           tags seen in >= min distinct flows per agent type
  scorecard.py autonomy [--last 5]          supervision level per agent type from events: watch / standard / trusted
  scorecard.py mark-lesson <agent> <tag> <path>   record that a lesson was written for this pattern
  scorecard.py lessons <agent>              lesson files recorded for this agent (the ones to judge per flow)
  scorecard.py lesson-stats                 per lesson file: runs since written, applied / violated, opened

events.json:
  {"flow": "orders-export-s2", "pr": "https://...", "agents": [
     {"agent_type": "backend-builder", "transcript": "agent-x.jsonl", "tool_calls": 40, "tool_errors": 2,
      "events": [{"tag": "ac-miss", "severity": "major", "summary": "...", "evidence": "...", "caught_by": "kestrel",
                  "lesson": "<path, only when the defect is one a recorded lesson covers>"}],
      "lessons": [{"path": "<lesson file>", "verdict": "applied|violated", "evidence": "..."}]}]}
  "lessons" lists only lessons whose situation arose this flow; `opened` is computed from the transcript.
"""
import glob, json, os, re, subprocess, sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

WEIGHT = {"critical": 25, "major": 10, "minor": 3}
VERDICTS = ("applied", "violated")


def role(t):
    """Role name for an agent type: drop the `dev-harness:` plugin prefix."""
    return t.split(":", 1)[1] if t and t.startswith("dev-harness:") else t


def ledger_path():
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    # worktrees: resolve to the main checkout so every feature lands in one ledger
    common = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
                            capture_output=True, text=True).stdout.strip()
    repo = os.path.basename(os.path.dirname(common)) if common.endswith(".git") else os.path.basename(top or os.getcwd())
    d = os.path.expanduser(f"~/.claude/agent-scorecard/{repo}")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "ledger.jsonl")


def rows():
    p = ledger_path()
    out = [json.loads(l) for l in open(p)] if os.path.exists(p) else []
    for r in out:
        r["agent_type"] = role(r.get("agent_type"))
    return out


def opened_files(transcript):
    """Basenames the agent opened with Read/Edit/Write, or read from an agent-memory path in Bash. None when the transcript cannot be found."""
    if not transcript or transcript == "main-session":
        return None
    hits = glob.glob(os.path.expanduser(f"~/.claude/projects/*/*/subagents/{os.path.basename(transcript)}"))
    if not hits:
        return None
    names = set()
    for line in open(hits[0]):
        content = (json.loads(line).get("message") or {}).get("content")
        for b in content if isinstance(content, list) else []:
            if b.get("type") == "tool_use" and b.get("name") in ("Read", "Edit", "Write"):
                names.add(os.path.basename(str((b.get("input") or {}).get("file_path", ""))))
            elif b.get("type") == "tool_use" and b.get("name") == "Bash":
                # cat/sed of a lesson file in any checkout (main or worktree) counts as opened
                names.update(re.findall(r"agent-memory/[^\s'\"]*?([^/\s'\"]+\.md)", str((b.get("input") or {}).get("command", ""))))
    return names


def add(path):
    data = json.load(open(path))
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out = []
    for a in data["agents"]:
        for e in a.get("events", []):
            if e.get("severity") not in WEIGHT:
                sys.exit(f"bad severity {e.get('severity')!r} in {a['agent_type']}")
            if not e.get("evidence"):
                sys.exit(f"event without evidence in {a['agent_type']}: {e.get('tag')}")
        violated_events = {os.path.basename(e["lesson"]) for e in a.get("events", []) if e.get("lesson")}
        opened = opened_files(a.get("transcript"))
        for l in a.get("lessons", []):
            if l.get("verdict") not in VERDICTS or not l.get("path") or not l.get("evidence"):
                sys.exit(f"lesson verdict needs path, evidence and verdict in {VERDICTS}: {a['agent_type']} {l}")
            if l["verdict"] == "violated" and os.path.basename(l["path"]) not in violated_events:
                sys.exit(f"violated lesson {l['path']} has no event with that \"lesson\" in {a['agent_type']}")
            l["opened"] = None if opened is None else os.path.basename(l["path"]) in opened
        penalty = sum(WEIGHT[e["severity"]] for e in a.get("events", []))
        out.append({"kind": "score", "ts": ts, "flow": data["flow"], "pr": data.get("pr"),
                    "agent_type": role(a["agent_type"]), "transcript": a.get("transcript"),
                    "tool_calls": a.get("tool_calls"), "tool_errors": a.get("tool_errors"),
                    "score": max(0, 100 - penalty), "events": a.get("events", []),
                    "lessons": a.get("lessons", []), "proposal": a.get("proposal")})
    with open(ledger_path(), "a") as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    for r in out:
        tags = ", ".join(f"{e['tag']}({e['severity']})" for e in r["events"]) or "clean"
        print(f"{r['agent_type']:<18} {r['score']:>3}  {tags}")
        for l in r["lessons"]:
            print(f"{'':<18}      lesson {l['verdict']:<8} opened={l['opened']}  {l['path']}")


def report(last):
    scores = [r for r in rows() if r["kind"] == "score"]
    flows = list(dict.fromkeys(r["flow"] for r in scores))[-last:]
    by = defaultdict(list)
    for r in scores:
        if r["flow"] in flows:
            by[r["agent_type"]].append(r)
    print(f"last {len(flows)} flows: {', '.join(flows)}")
    print(f"{'agent':<18} {'runs':>4} {'avg':>5} {'min':>4} {'crit':>4} {'major':>5} {'minor':>5}  trend")
    for agent, rs in sorted(by.items()):
        sev = defaultdict(int)
        for r in rs:
            for e in r["events"]:
                sev[e["severity"]] += 1
        s = [r["score"] for r in rs]
        print(f"{agent:<18} {len(rs):>4} {sum(s)/len(s):>5.1f} {min(s):>4} {sev['critical']:>4} "
              f"{sev['major']:>5} {sev['minor']:>5}  {' '.join(map(str, s))}")


def patterns(minimum):
    all_rows = rows()
    lessons = {(r["agent_type"], r["tag"]): r["path"] for r in all_rows if r["kind"] == "lesson"}
    hits = defaultdict(lambda: {"flows": set(), "events": []})
    for r in all_rows:
        if r["kind"] != "score":
            continue
        for e in r["events"]:
            h = hits[(r["agent_type"], e["tag"])]
            h["flows"].add(r["flow"])
            h["events"].append({"flow": r["flow"], "summary": e["summary"], "evidence": e["evidence"]})
    found = False
    for (agent, tag), h in sorted(hits.items()):
        if len(h["flows"]) < minimum:
            continue
        found = True
        lesson = lessons.get((agent, tag))
        print(f"## {agent} · {tag} · {len(h['flows'])} flows · lesson: {lesson or 'NONE'}")
        for e in h["events"]:
            print(f"- [{e['flow']}] {e['summary']} — {e['evidence']}")
    if not found:
        print(f"no tag repeated in >= {minimum} flows")


def autonomy(last):
    """Supervision level per agent type from events in its last N runs. Tighten-only: `trusted` never relaxes a gate.
    watch = any critical, >= 2 major, or >= 3 runs with any event; trusted = N runs, 0 major, <= 1 run with any event."""
    by = defaultdict(list)
    for r in rows():
        if r["kind"] == "score":
            by[r["agent_type"]].append(r)
    print(f"{'agent':<18} {'runs':>4} {'crit':>4} {'major':>5} {'ev-runs':>7}  level    events")
    for agent, rs in sorted(by.items()):
        rs = rs[-last:]
        sev = defaultdict(int)
        for r in rs:
            for e in r["events"]:
                sev[e["severity"]] += 1
        ev_runs = sum(bool(r["events"]) for r in rs)
        if sev["critical"] or sev["major"] >= 2 or ev_runs >= 3:
            level = "watch"
        elif len(rs) >= last and not sev["major"] and ev_runs <= 1:
            level = "trusted"
        else:
            level = "standard"
        n = Counter(f"{e['tag']}({e['severity']})" for r in rs for e in r["events"])
        tags = ", ".join(f"{k} x{v}" if v > 1 else k for k, v in n.most_common()) or "none"
        print(f"{agent:<18} {len(rs):>4} {sev['critical']:>4} {sev['major']:>5} {ev_runs:>7}  {level:<8} {tags}")


def mark_lesson(agent, tag, path):
    with open(ledger_path(), "a") as f:
        f.write(json.dumps({"kind": "lesson", "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                            "agent_type": agent, "tag": tag, "path": path}) + "\n")
    print(f"lesson recorded: {agent} {tag} -> {path}")


def lesson_rows():
    """First recorded lesson per (agent, file); a file marked for several tags keeps all its tags."""
    out = {}
    for r in rows():
        if r["kind"] == "lesson":
            k = (r["agent_type"], os.path.basename(r["path"]))
            out.setdefault(k, {"ts": r["ts"], "path": r["path"], "tags": []})["tags"].append(r["tag"])
    return out


def lessons(agent):
    found = [v for (a, _), v in lesson_rows().items() if a == agent]
    for v in found:
        print(f"{v['path']}  (tags: {', '.join(v['tags'])}, since {v['ts'][:10]})")
    if not found:
        print(f"no lessons recorded for {agent}")


def lesson_stats():
    scores = [r for r in rows() if r["kind"] == "score"]
    print(f"{'agent':<16} {'lesson':<44} {'since':<10} {'runs':>4} {'appl':>4} {'viol':>4} {'open':>4} {'tag-after':>9}")
    for (agent, name), v in sorted(lesson_rows().items()):
        after = [r for r in scores if r["agent_type"] == agent and r["ts"] > v["ts"]]
        verdicts = [l for r in after for l in r.get("lessons", []) if os.path.basename(l["path"]) == name]
        appl = sum(l["verdict"] == "applied" for l in verdicts)
        viol = sum(l["verdict"] == "violated" for l in verdicts)
        opened = sum(bool(l.get("opened")) for l in verdicts)
        tag_after = sum(any(e["tag"] in v["tags"] for e in r["events"]) for r in after)
        print(f"{agent:<16} {name[:44]:<44} {v['ts'][:10]:<10} {len(after):>4} {appl:>4} {viol:>4} {opened:>4} {tag_after:>9}")
    print("appl/viol/open count only runs scored with per-lesson verdicts; tag-after = runs with the same tag (coarse)")


def main():
    a = sys.argv[1:]
    num = lambda flag, d: int(a[a.index(flag) + 1]) if flag in a else d
    if a[:1] == ["add"] and len(a) == 2:
        add(a[1])
    elif a[:1] == ["report"]:
        report(num("--last", 10))
    elif a[:1] == ["autonomy"]:
        autonomy(num("--last", 5))
    elif a[:1] == ["patterns"]:
        patterns(num("--min", 2))
    elif a[:1] == ["mark-lesson"] and len(a) == 4:
        mark_lesson(role(a[1]), *a[2:])
    elif a[:1] == ["lessons"] and len(a) == 2:
        lessons(role(a[1]))
    elif a[:1] == ["lesson-stats"]:
        lesson_stats()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
