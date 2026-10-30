#!/usr/bin/env python3
"""Native HTTP + Tauri + JSON disk integration test (Linux desktop session)."""
import argparse
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary", nargs="?", type=Path, default=ROOT / "src-tauri/target/release/wardley-studio")
parser.add_argument("--chat-disabled", action="store_true", help="Disable chat with the runtime flag")
parser.add_argument("--core", action="store_true", help="Expect a binary compiled without chat, even with its runtime flag on")
args = parser.parse_args()
BINARY = args.binary


def run():
    if sys.platform != "linux":
        raise SystemExit("This integration test currently isolates native app configuration on Linux only.")
    with tempfile.TemporaryDirectory(prefix="wardley-native-api-") as tmp:
        root = Path(tmp)
        discovery = root / "api.json"
        workspace = root / "workspace"
        env = {**os.environ, "WARDLEY_WORKSPACE": str(workspace), "WARDLEY_API_PORT": "0", "WARDLEY_API_INFO": str(discovery), "XDG_CONFIG_HOME": str(root / "config"), "XDG_DATA_HOME": str(root / "data")}
        env["WARDLEY_CHAT_ENABLED"] = "0" if args.chat_disabled else "1"
        with (root / "app.log").open("w+") as log:
            proc = subprocess.Popen([str(BINARY)], cwd=ROOT, env=env, stdout=log, stderr=log)
            try:
                info = None
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

                def request(method, path, body=None, expected=200, headers=None, raw=None):
                    data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
                    req = urllib.request.Request(info["url"] + "/api/v1" + path, data=data, method=method, headers=headers if headers is not None else {"Authorization": "Bearer " + info["token"], "Content-Type": "application/json"})
                    try:
                        response = opener.open(req, timeout=35)
                    except urllib.error.HTTPError as error:
                        response = error
                    with response:
                        content = response.read().decode()
                        value = json.loads(content) if response.headers.get_content_type() == "application/json" else content
                        assert response.status == expected, (method, path, response.status, value)
                        return value

                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    if proc.poll() is not None:
                        log.seek(0)
                        raise AssertionError("Native app exited: " + log.read())
                    if discovery.exists():
                        info = json.loads(discovery.read_text())
                        try:
                            if request("GET", "/health")["status"] == "ready":
                                break
                        except (AssertionError, urllib.error.URLError):
                            pass
                    time.sleep(.2)
                else:
                    log.seek(0)
                    raise AssertionError("API failed to become ready: " + log.read())
                assert stat.S_IMODE(discovery.stat().st_mode) == 0o600
                request("GET", "/maps", expected=401, headers={})
                auth = {"Authorization": "Bearer " + info["token"], "Content-Type": "application/json"}
                request("GET", "/maps", expected=403, headers={**auth, "Origin": "https://example.com"})
                request("GET", "/maps", expected=403, headers={**auth, "Host": "example.com"})
                request("POST", "/maps", expected=400, raw=b"{broken")
                request("POST", "/maps", expected=415, headers={**auth, "Content-Type": "text/plain"}, raw=b"{}")
                routes = request("GET", "/routes")
                chat_enabled = not (args.chat_disabled or args.core)
                assert request("GET", "/features") == {"chat": chat_enabled, "chatCompiled": not args.core}
                if not chat_enabled:
                    assert not any("/chat" in r["path"] for r in routes)
                    for method, path, body in [("GET", "/chat", None), ("POST", "/chat/connect", None), ("POST", "/chat/login", None), ("PATCH", "/chat", {"open": True}), ("POST", "/actions/chat", None)]:
                        request(method, path, body, expected=404)
                    assert not (root / "data/studio.wardley.desktop/chat.json").exists()
                    assert not (root / "data/studio.wardley.desktop/chat-runtime").exists()
                assert len(routes) > 65
                assert request("GET", "/metamodel")["componentTypes"][2]["stageLabels"][2] == "Product (+ rental)"
                created = request("POST", "/actions/new", {"title": "HTTP integration", "anchor": False})
                mid = created["id"]
                node = request("POST", f"/maps/{mid}/components", {"label": "HTTP node", "type": "activity", "stage": 2})
                dependent = request("POST", f"/maps/{mid}/components", {"label": "Dependency", "type": "data", "parentId": node["id"]})
                disk = workspace / "maps" / f"{mid}.json"
                saved = json.loads(disk.read_text())
                assert len(saved["nodes"]) == 2 and len(saved["edges"]) == 1
                assert request("GET", "/state")["selectedId"] == dependent["id"]
                graph = request("GET", "/current-map/model")
                assert len(graph["components"]) == 2 and len(graph["links"]) == 1
                assert graph["components"][0]["stage"]["label"] == "Product (+ rental)"
                assert graph["components"][0]["outgoingLinkIds"] == [graph["links"][0]["id"]]
                request("PATCH", f"/maps/{mid}/components/{node['id']}", {"notes": "Saved through HTTP", "inertia": True})
                assert json.loads(disk.read_text())["nodes"][0]["notes"] == "Saved through HTTP"
                svg = request("POST", "/actions/export-svg")
                assert "<svg" in svg and "Product (+ rental)" in svg
                request("POST", "/actions/undo")
                assert not json.loads(disk.read_text())["nodes"][0].get("inertia", False)
                request("POST", "/actions/redo")
                assert json.loads(disk.read_text())["nodes"][0]["inertia"] is True
                request("POST", "/ui/dialog/new")
                request("POST", "/actions/new", {"title": "Blocked"}, expected=409)
                assert request("POST", "/actions/export-json")["id"] == mid
                request("POST", "/actions/close-dialog")
                # Simulate an external editor changing the JSON file while Studio is open.
                external = json.loads(disk.read_text())
                external["title"] = "External change"
                disk.write_text(json.dumps(external))
                request("PATCH", f"/maps/{mid}", {"title": "Pending API edit"}, expected=409)
                assert json.loads(disk.read_text())["title"] == "External change"
                assert request("POST", "/actions/export-json")["title"] == "Pending API edit"
                request("POST", "/actions/reload-discard")
                assert request("GET", f"/maps/{mid}")["title"] == "External change"
                request("DELETE", f"/maps/{mid}")
                assert not disk.exists() and list((workspace / ".trash").glob(f"{mid}-*.json"))
                second = root / "second-workspace"
                request("PUT", "/workspace", {"path": str(second)})
                assert (second / "metamodel.json").exists()
                assert request("GET", "/workspace")["path"] == str(second)
                model = request("GET", "/metamodel")
                model["name"] = "HTTP metamodel"
                request("PUT", "/metamodel", model)
                assert json.loads((second / "metamodel.json").read_text())["name"] == "HTTP metamodel"
                result = subprocess.run([sys.executable, str(ROOT / "scripts/wardley-api.py"), "--info", str(discovery), "GET", "/state"], check=True, capture_output=True, text=True)
                assert json.loads(result.stdout)["activeMapId"]
                print(f"Native API integration passed: {len(routes)} routes; auth, bridge, disk saves, history, conflicts, exports, workspace switching, metamodel and CLI.")
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()


if __name__ == "__main__":
    run()
