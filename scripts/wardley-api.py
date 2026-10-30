#!/usr/bin/env python3
"""Call the running Wardley Studio API using its local discovery file."""
import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


def default_info():
    if os.environ.get("WARDLEY_API_INFO"):
        return Path(os.environ["WARDLEY_API_INFO"])
    if sys.platform == "darwin":
        root = Path.home() / "Library/Application Support"
    elif os.name == "nt":
        root = Path(os.environ["APPDATA"])
    else:
        root = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return root / "studio.wardley.desktop/api.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("method", help="GET, POST, PUT, PATCH or DELETE")
    parser.add_argument("path", help="Route, e.g. /maps or /api/v1/state")
    parser.add_argument("body", nargs="?", help="JSON body; @file reads a file; - reads stdin")
    parser.add_argument("--info", type=Path, default=default_info(), help="Connection discovery file")
    parser.add_argument("--output", "-o", type=Path, help="Write response to this file")
    args = parser.parse_args()
    try:
        info = json.loads(args.info.read_text())
        path = args.path if args.path.startswith("/api/v1/") else "/api/v1/" + args.path.lstrip("/")
        data = None
        if args.body is not None:
            raw = sys.stdin.read() if args.body == "-" else Path(args.body[1:]).read_text() if args.body.startswith("@") else args.body
            data = json.dumps(json.loads(raw)).encode()
        request = urllib.request.Request(info["url"] + path, data=data, method=args.method.upper(), headers={"Authorization": "Bearer " + info["token"], "Content-Type": "application/json"})
        # Loopback requests never need a proxy.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        status = 200
        try:
            response = opener.open(request, timeout=35)
        except urllib.error.HTTPError as error:
            response = error
            status = error.code
        with response:
            output = response.read()
            if response.headers.get_content_type() == "application/json":
                output = (json.dumps(json.loads(output), indent=2, ensure_ascii=False) + "\n").encode()
        if args.output:
            args.output.write_bytes(output)
        else:
            sys.stdout.buffer.write(output)
        return 0 if status < 400 else 1
    except (OSError, ValueError, KeyError, urllib.error.URLError) as error:
        print(f"API error: {error}. Open Wardley Studio and check the connection file in Maps → API.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
