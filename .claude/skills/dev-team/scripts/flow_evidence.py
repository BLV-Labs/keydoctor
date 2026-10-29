#!/usr/bin/env python3
"""Extract per-agent evidence for one dev-team flow from Claude Code subagent transcripts.

Usage: flow_evidence.py <match> [--session DIR] [--out FILE]
  match      substring matched (case-insensitive) against agent description, cwd, git branch, or brief
             (subagents inherit the main checkout's cwd, so the brief's worktree path is often the only hit)
  --session  ~/.claude/projects/<cwd-slug>/<session-id>; default = newest session of the current cwd.
             Run from the main checkout, or pass --session: a worktree cwd gives the wrong slug.
Prints markdown: one section per matching subagent, in spawn order, with brief, final report,
and deterministic counters (tool calls, tool errors, turns, duration).
Ends with an orchestrator section: the main session's user messages inside the flow's time window
(first subagent start .. last subagent end + 20 min) — corrections the orchestrator needed.
"""
import json, re, sys, glob, os
from datetime import datetime, timedelta

BRIEF_MAX, REPORT_MAX = 3000, 5000


def role(t):
    """Role name for an agent type: drop the `dev-harness:` plugin prefix."""
    return t.split(":", 1)[1] if t and t.startswith("dev-harness:") else t


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content or [] if b.get("type") == "text")


def load(path):
    meta_path = path[: -len(".jsonl")] + ".meta.json"
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    brief, report, cwd, branch = None, "", "", ""
    tools = errors = turns = 0
    first_ts = last_ts = None
    for line in open(path):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        ts = d.get("timestamp")
        if ts:
            first_ts = first_ts or ts
            last_ts = ts
        cwd = cwd or d.get("cwd", "")
        branch = d.get("gitBranch") or branch
        msg = d.get("message") or {}
        content = msg.get("content")
        if d.get("type") == "user":
            if brief is None:
                brief = text_of(content)
            for b in content if isinstance(content, list) else []:
                if b.get("type") == "tool_result" and b.get("is_error"):
                    errors += 1
        elif d.get("type") == "assistant":
            turns += 1
            for b in content if isinstance(content, list) else []:
                if b.get("type") == "tool_use":
                    tools += 1
            t = text_of(content)
            if t.strip():
                report = t
    dur = None
    if first_ts and last_ts:
        f = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
        dur = round((f(last_ts) - f(first_ts)).total_seconds() / 60, 1)
    return dict(meta=meta, brief=brief or "", report=report, cwd=cwd, branch=branch,
                tools=tools, errors=errors, turns=turns, start=first_ts, minutes=dur)


def ts_of(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def user_messages(session_dir, start, end):
    main = session_dir.rstrip("/") + ".jsonl"
    if not os.path.exists(main):
        return []
    msgs = []
    for line in open(main):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("type") != "user" or d.get("isSidechain") or not d.get("timestamp"):
            continue
        if not start <= ts_of(d["timestamp"]) <= end:
            continue
        content = (d.get("message") or {}).get("content")
        if isinstance(content, list) and any(b.get("type") == "tool_result" for b in content):
            continue
        t = re.sub(r"<(system-reminder|task-notification|command-[a-z-]+)>.*?</\1>", "", text_of(content), flags=re.S).strip()
        if t and not t.startswith("This session is being continued"):
            msgs.append((d["timestamp"], t[:600]))
    return msgs


def opt(args, name):
    return args[args.index(name) + 1] if name in args else None


def newest_session():
    slug = os.getcwd().replace("/", "-").replace(".", "-")
    dirs = [d for d in glob.glob(os.path.expanduser(f"~/.claude/projects/{slug}/*/subagents"))]
    if not dirs:
        sys.exit(f"no subagent transcripts under ~/.claude/projects/{slug}")
    return os.path.dirname(max(dirs, key=os.path.getmtime))


def main():
    args = sys.argv[1:]
    if not args or args[0].startswith("--"):
        sys.exit(__doc__)
    match = args[0].lower()
    session_dir = opt(args, "--session") or newest_session()
    rows = []
    for p in glob.glob(os.path.join(session_dir, "subagents", "agent-*.jsonl")):
        r = load(p)
        hay = " ".join([r["meta"].get("description", ""), r["cwd"], r["branch"], r["brief"]]).lower()
        is_retro = role(r["meta"].get("agentType")) in ("heron", "osprey") or "retro" in r["meta"].get("description", "").lower()
        if match in hay and not is_retro:
            rows.append((r["start"] or "", os.path.basename(p), r))
    rows.sort()
    out = [f"# Flow evidence — match `{match}` — {len(rows)} agents\n"]
    for start, name, r in rows:
        m = r["meta"]
        out.append(f"## {m.get('agentType', '?')} — {m.get('description', '')}")
        out.append(f"- file `{name}` · model {m.get('model', '?')} · start {start} · {r['minutes']} min"
                   f" · turns {r['turns']} · tool calls {r['tools']} · tool errors {r['errors']}"
                   f" · branch `{r['branch']}`")
        out.append("\n### Brief\n```\n" + r["brief"][:BRIEF_MAX] + "\n```")
        out.append("\n### Final report\n```\n" + r["report"][:REPORT_MAX] + "\n```\n")
    starts = [r["start"] for _, _, r in rows if r["start"]]
    if starts:
        lo, hi = ts_of(min(starts)), ts_of(max(starts)) + timedelta(minutes=20)
        for _, _, r in rows:
            if r["start"] and r["minutes"]:
                hi = max(hi, ts_of(r["start"]) + timedelta(minutes=r["minutes"] + 20))
        msgs = user_messages(session_dir, lo, hi)
        out.append(f"## orchestrator — main session\n- briefs = each agent's Brief above · user messages in window: {len(msgs)}")
        for ts, t in msgs:
            out.append(f"\n**user @ {ts}**\n```\n{t}\n```")
    text = "\n".join(out)
    out_path = opt(args, "--out")
    if out_path:
        open(out_path, "w").write(text)
        print(f"wrote {len(rows)} agents from {session_dir}")
    else:
        print(text)


if __name__ == "__main__":
    main()
