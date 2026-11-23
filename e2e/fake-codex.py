#!/usr/bin/python3 -I
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Enigma Technologies Solutions
#
# A stand-in for `codex app-server`, for the end-to-end suite. It speaks the part of the
# protocol Sanctum uses (src-tauri/src/agent/protocol.rs) over stdin and stdout, one JSON
# message per line, and does what scenario.json beside it says. It runs inside Sanctum's
# sandbox like the real Codex, so it can read only its own folder and write only to CODEX_HOME
# and the work folder.
#
# scenario.json:
#   {"turns": [<turn>, ...]}   one entry per turn/start, in order, counted across restarts;
#                              the last one repeats
#   <turn> is one of
#     {"do": "build", "title": "Counter", "reply": "Done.", "html": "<optional full file>"}
#     {"do": "fail", "error": "stream disconnected before completion"}
#     {"do": "hang"}           never finishes; turn/interrupt ends it
#     {"do": "exit"}           the process exits in the middle of the turn
#   any <turn> may add "startDelay": <ms>, a wait before Codex answers turn/start
#   {"login": "ok" | "fail" | "never"}   how account/login/start ends (default "ok")
#
# Sign-in state lives in $CODEX_HOME/fake-auth, so it survives restarts and is gone after
# Delete agent data, as with the real Codex. Each turn appends a line to $CODEX_HOME/fake-log.

import json
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.realpath(__file__))
HOME = os.environ.get("CODEX_HOME", "")
AUTH = os.path.join(HOME, "fake-auth")
LOG = os.path.join(HOME, "fake-log")
ACCOUNT = {"type": "chatgpt", "email": "e2e@example.com", "planType": "plus"}

lock = threading.Lock()
state = {"turn": 0, "thread": None, "cwd": None, "hanging": None}


def scenario():
    try:
        with open(os.path.join(HERE, "scenario.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def send(msg):
    with lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


def log(line):
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def turns_so_far():
    try:
        with open(LOG) as f:
            return sum(1 for line in f if line.startswith("turn "))
    except OSError:
        return 0


def account():
    if os.path.exists(AUTH):
        return {"account": ACCOUNT, "requiresOpenaiAuth": True}
    return {"account": None, "requiresOpenaiAuth": True}


def page(title, note):
    return (
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>%s</title>"
        "<meta name=\"description\" content=\"Made by the fake Codex\"></head>"
        "<body><h1>%s</h1><p id=\"note\">%s</p>"
        "<button id=\"inc\">+</button><output id=\"n\">0</output>"
        "<script>let n=0;document.getElementById('inc').onclick=()=>{n++;"
        "document.getElementById('n').textContent=n};</script></body></html>"
    ) % (title, title, note)


def notify(method, params):
    params = dict(params, threadId=state["thread"])
    send({"method": method, "params": params})


def run_turn(turn_id, text, step):
    kind = step.get("do", "build")
    if kind == "exit":
        time.sleep(0.3)
        os._exit(3)
    if kind == "hang":
        state["hanging"] = turn_id
        return
    if kind == "fail":
        time.sleep(0.2)
        notify("turn/completed", {"turn": {"id": turn_id, "status": "failed", "items": [],
                                           "error": {"message": step.get("error", "failed")}}})
        return
    # build
    cmd = {"type": "commandExecution", "id": "c-" + turn_id, "command": "cat > app.html",
           "cwd": state["cwd"], "status": "inProgress"}
    notify("item/started", {"turnId": turn_id, "item": cmd})
    html = step.get("html") or page(step.get("title", "Counter"), text)
    with open(os.path.join(state["cwd"], "app.html"), "w") as f:
        f.write(html)
    time.sleep(0.2)
    notify("item/completed", {"turnId": turn_id, "item": dict(cmd, status="completed", exitCode=0)})
    msg = "m-" + turn_id
    for part in step.get("reply", "Done. The app is in app.html.").split(" "):
        notify("item/agentMessage/delta", {"turnId": turn_id, "itemId": msg, "delta": part + " "})
    notify("turn/completed", {"turn": {"id": turn_id, "status": "completed", "items": []}})


def login():
    how = scenario().get("login", "ok")
    if how == "never":
        return
    time.sleep(0.3)
    ok = how == "ok"
    if ok:
        with open(AUTH, "w") as f:
            f.write("signed in\n")
    send({"method": "account/login/completed",
          "params": {"loginId": "L1", "success": ok, "error": None if ok else "denied"}})


def main():
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        method, rid, params = req.get("method"), req.get("id"), req.get("params") or {}
        if rid is None:
            continue  # a notification, such as initialized
        if method == "initialize":
            send({"id": rid, "result": {"userAgent": "fake-codex/0.0.0"}})
        elif method == "account/read":
            send({"id": rid, "result": account()})
        elif method == "account/login/start":
            send({"id": rid, "result": {"type": "chatgpt", "loginId": "L1",
                                        "authUrl": "https://auth.openai.com/oauth/authorize?fake=1"}})
            threading.Thread(target=login, daemon=True).start()
        elif method == "account/login/cancel":
            send({"id": rid, "result": {}})
        elif method == "account/logout":
            try:
                os.remove(AUTH)
            except OSError:
                pass
            send({"id": rid, "result": {}})
        elif method == "thread/start":
            state["thread"] = "th-%d" % os.getpid()
            state["cwd"] = params.get("cwd")
            send({"id": rid, "result": {"thread": {"id": state["thread"], "cliVersion": "0.0.0-fake"},
                                        "model": "fake-model"}})
        elif method == "turn/start":
            # Count turns across restarts, so a scenario continues after Codex is stopped.
            state["turn"] = turns_so_far() + 1
            turn_id = "t%d" % state["turn"]
            if params.get("cwd"):
                state["cwd"] = params["cwd"]
            text = " ".join(i.get("text", "") for i in params.get("input", []) if isinstance(i, dict))
            turns = scenario().get("turns") or [{"do": "build"}]
            step = turns[min(state["turn"], len(turns)) - 1]
            log("turn %s %s %s" % (turn_id, step.get("do", "build"), text))
            time.sleep(step.get("startDelay", 0) / 1000.0)
            send({"id": rid, "result": {"turn": {"id": turn_id, "status": "inProgress", "items": []}}})
            threading.Thread(target=run_turn, args=(turn_id, text, step), daemon=True).start()
        elif method == "turn/interrupt":
            send({"id": rid, "result": {}})
            turn_id = params.get("turnId")
            if turn_id:
                notify("turn/completed", {"turn": {"id": turn_id, "status": "interrupted", "items": []}})
        else:
            send({"id": rid, "error": {"code": -32601, "message": "fake: no " + str(method)}})


if __name__ == "__main__":
    main()
