#!/usr/bin/env python3
"""Exercise subscription chat and an actual model tool edit on a temporary map.
Requires a ChatGPT-authenticated Codex CLI. Makes one model turn using the account's plan.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dev", action="store_true", help="Use the debug binary and start Vite")
    parser.add_argument("--web-search", action="store_true", help="Verify live web search with map edits disabled")
    parser.add_argument("--layout", action="store_true", help="Verify image inspection and layout improvement on a temporary map")
    parser.add_argument("--artifacts", type=Path, help="Optional directory for before/after layout PNGs")
    args = parser.parse_args()
    if os.sys.platform != "linux":
        raise SystemExit("This integration test currently isolates native app configuration on Linux only.")
    if args.artifacts:
        args.artifacts.mkdir(parents=True, exist_ok=True)
    binary = ROOT / "src-tauri/target" / ("debug" if args.dev else "release") / "wardley-studio"
    with tempfile.TemporaryDirectory(prefix="wardley-chat-live-") as tmp:
        root = Path(tmp)
        info_path = root / "api.json"
        workspace = root / "workspace"
        env = {**os.environ, "WARDLEY_WORKSPACE": str(workspace), "WARDLEY_API_PORT": "0", "WARDLEY_API_INFO": str(info_path), "XDG_CONFIG_HOME": str(root / "config"), "XDG_DATA_HOME": str(root / "data")}
        server = None
        app = None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            if args.dev:
                server = subprocess.Popen(["npm", "run", "dev"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                for _ in range(60):
                    try:
                        opener.open("http://127.0.0.1:1435", timeout=1).close()
                        break
                    except urllib.error.URLError:
                        time.sleep(.1)
            app = subprocess.Popen([str(binary)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            info = None

            def api(method, path, body=None):
                req = urllib.request.Request(info["url"] + "/api/v1" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer " + info["token"], "Content-Type": "application/json"})
                try:
                    response = opener.open(req, timeout=40)
                except urllib.error.HTTPError as error:
                    raise AssertionError(f"{method} {path}: {error.read().decode()}") from error
                with response:
                    return json.load(response)

            for _ in range(150):
                if app.poll() is not None:
                    raise AssertionError("Native app exited")
                if info_path.exists():
                    info = json.loads(info_path.read_text())
                    try:
                        if api("GET", "/health")["status"] == "ready":
                            break
                    except (AssertionError, urllib.error.URLError):
                        pass
                time.sleep(.2)
            else:
                raise AssertionError("Native API did not become ready")
            state = api("POST", "/chat/connect")
            assert state["connected"], state["error"]
            assert state["account"]["type"] == "chatgpt", "Sign in to Codex with ChatGPT before running this test."
            assert state["models"], "No models available"
            if args.layout:
                api("PATCH", "/maps/coffee-shop/components/brewing", {"evolution": .32, "visibility": .59})
                before = api("GET", "/maps/coffee-shop")
                image = api("GET", "/current-map/snapshot")
                assert image["mimeType"] == "image/png" and image["width"] == 1650
                if args.artifacts:
                    (args.artifacts / "layout-before.png").write_bytes(base64.b64decode(image["dataUrl"].split(",", 1)[1]))
                api("PATCH", "/chat", {"open": True, "allowEdits": True, "webSearch": False})
                api("POST", "/chat/messages", {"text": "Improve the placement of the overlapping experience and brewing components in the coffee-shop map. Keep both in their current evolution stage and preserve all other nodes, links and labels. Use the map snapshot tool to inspect the visual layout before editing, then inspect a fresh snapshot after editing and refine if needed. Briefly explain what you saw and changed."})
                deadline = time.monotonic() + 180
                while time.monotonic() < deadline:
                    state = api("GET", "/chat")
                    if not state["busy"]:
                        break
                    time.sleep(.4)
                else:
                    api("POST", "/chat/stop")
                    raise AssertionError("Visual layout turn timed out")
                assert not state["error"], state["error"]
                tools = [m for m in state["messages"] if m["role"] == "tool" and m.get("status") == "done"]
                snapshots = [i for i, m in enumerate(tools) if "get_map_snapshot" in m["text"] or "/snapshot" in m["text"]]
                edits = [i for i, m in enumerate(tools) if m["text"].startswith(("PATCH /", "PUT /"))]
                assert len(snapshots) >= 2 and edits and snapshots[0] < edits[0] < snapshots[-1], state["messages"]
                after = api("GET", "/maps/coffee-shop")
                assert after["edges"] == before["edges"]
                for original in before["nodes"]:
                    changed = next(n for n in after["nodes"] if n["id"] == original["id"])
                    if original["id"] in ("experience", "brewing"):
                        assert int(changed["evolution"] * 4) == int(original["evolution"] * 4)
                        assert {k: v for k, v in changed.items() if k not in ("evolution", "visibility")} == {k: v for k, v in original.items() if k not in ("evolution", "visibility")}
                    else:
                        assert changed == original
                a, b = [next(n for n in after["nodes"] if n["id"] == ident) for ident in ("experience", "brewing")]
                assert ((a["evolution"] - b["evolution"]) * 920) ** 2 + ((a["visibility"] - b["visibility"]) * 610) ** 2 > 45 ** 2
                image = api("GET", "/current-map/snapshot")
                if args.artifacts:
                    (args.artifacts / "layout-after.png").write_bytes(base64.b64decode(image["dataUrl"].split(",", 1)[1]))
                print("Live visual layout passed: PNG API, before/after image tools, improved spacing, preserved stages and unrelated map content.")
                print(json.dumps({"tools": tools, "replies": [m["text"] for m in state["messages"] if m["role"] == "assistant"]}, ensure_ascii=False))
                return
            if args.web_search:
                before = api("GET", "/maps/coffee-shop")
                api("PATCH", "/chat", {"open": True, "allowEdits": False, "webSearch": True})
                api("POST", "/chat/messages", {"text": "Use web search to find the official Tauri v2 documentation about application windows. Open the relevant official page, then give one short factual sentence with an ordinary Markdown source link. Do not edit the map. You must actually search the web for this check."})
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    state = api("GET", "/chat")
                    if not state["busy"]:
                        break
                    time.sleep(.4)
                else:
                    api("POST", "/chat/stop")
                    raise AssertionError("Web search turn timed out")
                assert not state["error"], state["error"]
                searches = [m for m in state["messages"] if m.get("kind") == "webSearch"]
                assert any(m.get("status") == "done" for m in searches), state["messages"]
                replies = [m["text"] for m in state["messages"] if m["role"] == "assistant"]
                assert any("](https://" in text for text in replies), replies
                assert api("GET", "/maps/coffee-shop") == before, "Research changed the map"
                print("Live web search passed: search activity, source link, subscription reply, and unchanged map.")
                print(json.dumps({"searches": searches, "replies": replies}, ensure_ascii=False))
                return
            api("PATCH", "/chat", {"open": True, "allowEdits": True})
            api("POST", "/chat/messages", {"text": "Use your app tools to update only the component with id experience in the coffee-shop map: set its label to 'Subscription chat verified' and its stage to 2. Verify that change with get_current_map, then reply briefly. Do not change any other components, maps, or settings."})
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                state = api("GET", "/chat")
                if not state["busy"]:
                    break
                time.sleep(.4)
            else:
                api("POST", "/chat/stop")
                raise AssertionError("Model turn timed out")
            assert not state["error"], state["error"]
            node = api("GET", "/maps/coffee-shop/components/experience")
            assert node["label"] == "Subscription chat verified", state["messages"]
            assert node["evolution"] == .625, node
            saved = json.loads((workspace / "maps/coffee-shop.json").read_text())
            assert next(n for n in saved["nodes"] if n["id"] == "experience")["label"] == node["label"]
            assert any(m["role"] == "tool" and m.get("status") == "done" for m in state["messages"])
            assert any(m["role"] == "assistant" and m["text"] for m in state["messages"])
            api("POST", "/actions/undo")
            assert api("GET", "/maps/coffee-shop/components/experience")["label"] == "In-store experience"
            history = root / "data/studio.wardley.desktop/chat.json"
            for _ in range(20):
                if history.exists() and len(json.loads(history.read_text())["messages"]) >= 3:
                    break
                time.sleep(.1)
            assert history.exists()
            print("Live subscription chat passed: model reply, app-tool edit, stage, JSON save, conversation history and Undo.")
        finally:
            for proc in (app, server):
                if proc:
                    try:
                        os.killpg(proc.pid, signal.SIGTERM)
                        proc.wait(timeout=10)
                    except (ProcessLookupError, subprocess.TimeoutExpired):
                        if proc.poll() is None:
                            os.killpg(proc.pid, signal.SIGKILL)
                            proc.wait()


if __name__ == "__main__":
    main()
