#!/usr/bin/env python3
"""Deterministic speed + token cost per agent for one dev-team flow. Companion to flow_evidence.py.

Usage:
  flow_cost.py <match>[,<match>...] [--session DIR] [--record <flow-slug> --lane <lane>]   table for the flow; --record appends to the cost ledger
  flow_cost.py --report [--last N]                              per agent type: this flow vs median of earlier flows
  flow_cost.py --advise <flow-slug> <advice.json>               attach the judge's advice to that flow's ledger row
  flow_cost.py --advice [--last N]                              print earlier flows' advice (to check what was applied)

match / --session behave as in flow_evidence.py. A comma-separated match counts an agent that hits any part. Ledger: ~/.claude/agent-scorecard/<repo>/cost.jsonl
Tokens come from each assistant message's `usage`, de-duplicated by message id (last copy wins).
  fresh = input + cache_creation + output   (work the model had to do)
  cached = cache_read                        (context replayed from cache)
wall = first..last timestamp; active = sum of gaps between consecutive messages that are <= 5 min
(longer gaps are waits on background jobs, the user or the harness, not agent work).
"""
import glob, json, os, statistics, subprocess, sys
from datetime import datetime, timezone

IDLE_GAP_S = 300


def role(t):
    """Role name for an agent type: drop the `dev-harness:` plugin prefix."""
    return t.split(":", 1)[1] if t and t.startswith("dev-harness:") else t


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def measure(path, sidechain_only=None, window=None):
    msgs, stamps = {}, []
    tools = 0
    for line in open(path):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if sidechain_only is not None and bool(d.get("isSidechain")) != sidechain_only:
            continue
        t = d.get("timestamp")
        if not t or (window and not window[0] <= ts(t) <= window[1]):
            continue
        stamps.append(ts(t))
        if d.get("type") != "assistant":
            continue
        m = d.get("message") or {}
        if m.get("usage"):
            msgs[m.get("id") or d.get("uuid")] = m["usage"]
        tools += sum(1 for b in m.get("content") or [] if isinstance(b, dict) and b.get("type") == "tool_use")
    inp = sum(u.get("input_tokens", 0) for u in msgs.values())
    out = sum(u.get("output_tokens", 0) for u in msgs.values())
    cw = sum(u.get("cache_creation_input_tokens", 0) for u in msgs.values())
    cr = sum(u.get("cache_read_input_tokens", 0) for u in msgs.values())
    stamps.sort()
    gaps = [(b - a).total_seconds() for a, b in zip(stamps, stamps[1:])]
    return dict(turns=len(msgs), tools=tools, input=inp, output=out, cache_write=cw, cache_read=cr,
                fresh=inp + cw + out, cached=cr,
                wall_min=round((stamps[-1] - stamps[0]).total_seconds() / 60, 1) if len(stamps) > 1 else 0,
                active_min=round(sum(g for g in gaps if g <= IDLE_GAP_S) / 60, 1),
                start=stamps[0].isoformat() if stamps else None, end=stamps[-1].isoformat() if stamps else None)


def repo_slug():
    common = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
                            capture_output=True, text=True).stdout.strip()
    return os.path.basename(os.path.dirname(common)) if common.endswith(".git") else os.path.basename(os.getcwd())


def ledger_path():
    d = os.path.expanduser(f"~/.claude/agent-scorecard/{repo_slug()}")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "cost.jsonl")


def ledger():
    p = ledger_path()
    return [json.loads(l) for l in open(p)] if os.path.exists(p) else []


def opt(args, name):
    return args[args.index(name) + 1] if name in args else None


def newest_session():
    slug = os.getcwd().replace("/", "-").replace(".", "-")
    dirs = glob.glob(os.path.expanduser(f"~/.claude/projects/{slug}/*/subagents"))
    if not dirs:
        sys.exit(f"no subagent transcripts under ~/.claude/projects/{slug}")
    return os.path.dirname(max(dirs, key=os.path.getmtime))


def collect(match, session_dir):
    agents = []
    for p in glob.glob(os.path.join(session_dir, "subagents", "agent-*.jsonl")):
        mp = p[:-len(".jsonl")] + ".meta.json"
        meta = json.load(open(mp)) if os.path.exists(mp) else {}
        first = next((json.loads(l) for l in open(p) if l.strip()), {})
        # brief text is not matched: it cites other flows (one flow counted an agent of an unrelated flow)
        hay = " ".join([meta.get("description", ""), first.get("cwd", ""), first.get("gitBranch", "") or ""]).lower()
        if any(m in hay for m in match.split(",")) and role(meta.get("agentType")) not in ("heron", "osprey") and "retro" not in meta.get("description", "").lower():
            agents.append(dict(agent_type=role(meta.get("agentType")) or "?", description=meta.get("description", ""),
                               model=meta.get("model", "?"), file=os.path.basename(p), **measure(p)))
    agents.sort(key=lambda a: a["start"] or "")
    if agents:
        lo = ts(agents[0]["start"])
        hi = max(ts(a["end"]) for a in agents if a["end"])
        main = session_dir.rstrip("/") + ".jsonl"
        if os.path.exists(main):
            agents.append(dict(agent_type="orchestrator", description="main session, flow window", model="?",
                               file="main-session", **measure(main, sidechain_only=False, window=(lo, hi))))
    return agents


def table(agents):
    h = "| agent | model | wall min | active min | turns | tools | fresh tok | cached tok | description |"
    rows = [h, "|" + "---|" * 9]
    for a in agents:
        rows.append(f"| {a['agent_type']} | {a['model']} | {a['wall_min']} | {a['active_min']} | {a['turns']} | {a['tools']} "
                    f"| {a['fresh']:,} | {a['cached']:,} | {a['description'][:50]} |")
    tot = lambda k: sum(a[k] for a in agents if a["agent_type"] != "orchestrator")
    rows.append(f"| **subagents total** | | {round(tot('wall_min'), 1)} | {round(tot('active_min'), 1)} | {tot('turns')} | {tot('tools')} "
                f"| {tot('fresh'):,} | {tot('cached'):,} | |")
    return "\n".join(rows)


def report(last):
    flows = ledger()[-last:]
    by = {}
    for f in flows:
        for a in f["agents"]:
            by.setdefault(role(a["agent_type"]), []).append((f["flow"], a))
    print("| agent type | runs | median active min | median fresh tok | latest flow | latest active | latest fresh |\n|---|---|---|---|---|---|---|")
    for t, runs in sorted(by.items()):
        am = statistics.median(a["active_min"] for _, a in runs)
        ft = statistics.median(a["fresh"] for _, a in runs)
        fl, la = runs[-1]
        print(f"| {t} | {len(runs)} | {am} | {int(ft):,} | {fl} | {la['active_min']} | {la['fresh']:,} |")


def advise(flow, path):
    rows = ledger()
    hit = [r for r in rows if r["flow"] == flow]
    if not hit:
        sys.exit(f"no ledger row for flow {flow}; run with --record first")
    hit[-1]["advice"] = json.load(open(path))
    with open(ledger_path(), "w") as f:
        f.writelines(json.dumps(r) + "\n" for r in rows)
    print(f"advice attached to {flow}")


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        sys.exit(__doc__)
    if args[0] == "--advise":
        advise(args[1], args[2])
        return
    if args[0] == "--advice":
        for r in ledger()[-int(opt(args, "--last") or 5):]:
            if r.get("advice"):
                print(f"## {r['flow']}\n{json.dumps(r['advice'], indent=1)}\n")
        return
    if args[0] == "--report":
        report(int(opt(args, "--last") or 10))
        return
    agents = collect(args[0].lower(), opt(args, "--session") or newest_session())
    print(table(agents))
    flow = opt(args, "--record")
    if flow:
        row = dict(flow=flow, at=datetime.now(timezone.utc).isoformat(), lane=opt(args, "--lane"), agents=agents)
        with open(ledger_path(), "a") as f:
            f.write(json.dumps(row) + "\n")
        print(f"\nrecorded {len(agents)} rows to {ledger_path()}")


if __name__ == "__main__":
    main()
