#!/usr/bin/env python3
"""Read-only access to Oracle through OMV. Uses only Python's standard library."""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
STACK_UUID = "d5e4c8ad-09c6-4a9b-8f8f-473355d75d76"
SERVICE = "meeting-helper-bot"
PUBLIC_ENV = {
    "ALERTS_CHANNEL_ID", "CLIENT_ID", "GUILD_ID", "VOICE_CHANNEL_ID",
    "PING_ROLE_ID", "LOG_CHANNEL_ID", "EMPTY_GRACE_SECONDS", "JOIN_GRACE_SECONDS",
    "NOTESBOT_START_COMMAND", "NOTESBOT_STOP_COMMAND", "NOTES_START_HINT", "PROMPT_TEXT",
}


class OMV:
    def __init__(self, credentials, base_url=None):
        self.url = (base_url or credentials["base_url"]).rstrip("/") + "/rpc.php"
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )
        response = self.rpc("Session", "login", {
            "username": credentials["username"], "password": credentials["password"],
        })
        if not isinstance(response, dict) or not response.get("authenticated"):
            raise RuntimeError("OMV login failed")
        if response.get("sessionid"):
            self.opener.addheaders = [
                ("Cookie", "OPENMEDIAVAULT-SESSIONID=" + response["sessionid"])
            ]

    def rpc(self, service, method, params):
        request = urllib.request.Request(self.url, data=json.dumps({
            "service": service, "method": method, "params": params,
        }).encode(), headers={"Content-Type": "application/json"})
        with self.opener.open(request, timeout=20) as response:
            result = json.load(response)
        if result.get("error"):
            # Server errors can echo credentials/configuration; don't print them.
            raise RuntimeError(f"OMV rejected {service}.{method}; details suppressed")
        return result.get("response")

    def compose(self, command):
        if command not in {"ps", "images", "config --format json"}:
            raise ValueError("Only read-only Compose commands are allowed")
        filename = self.rpc("Compose", "doCommand", {
            "uuid": STACK_UUID, "command": command,
        })
        position, output = 0, []
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            result = self.rpc("Exec", "getOutput", {
                "filename": filename, "pos": position,
            })
            output.append(result.get("output") or "")
            position = result.get("pos", position)
            if not result.get("running") and not result.get("pendingOutput"):
                text = "".join(output)
                if "*** ERROR" in text:
                    raise RuntimeError("Compose command failed; output suppressed")
                return text
            time.sleep(0.5)
        raise TimeoutError("Timed out waiting for read-only Compose command")

    def config(self):
        text = self.compose("config --format json")
        # Compose may prefix JSON with an obsolete-version warning.
        config = json.loads(text[text.index("{"):])
        if SERVICE not in config.get("services", {}):
            raise RuntimeError("Expected bot service missing from Compose config")
        return config


def public_config(config):
    """Only expose known deployment fields; omit arbitrary mounts/other services."""
    service = config["services"][SERVICE]
    return {"name": config.get("name"), "services": {SERVICE: {
        key: ({k: v if k in PUBLIC_ENV else "[REDACTED]" for k, v in value.items()}
              if key == "environment" else value)
        for key, value in service.items()
        if key in {"container_name", "image", "restart", "environment"}
    }}}


def export_env(config, destination):
    environment = config["services"][SERVICE].get("environment", {})
    lines = ["# Production Discord credentials: do not commit or run alongside Oracle."]
    for key, value in sorted(environment.items()):
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError("Invalid environment variable name")
        if value is None:
            continue
        value = str(value)
        # Single-quoted dotenv values avoid dollar interpolation. Fail rather than
        # silently emit a value that dotenv readers would interpret differently.
        if any(char in value for char in "'\r\n\x00"):
            raise ValueError("Environment value needs manual dotenv escaping")
        lines.append(f"{key}='{value}'")
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["status", "images", "config", "export-env"])
    parser.add_argument("--credentials", type=Path, default=ROOT / ".private/omv.json")
    parser.add_argument("--base-url", help="Override the saved OMV URL (e.g. http://192.168.1.100)")
    args = parser.parse_args()
    client = OMV(json.loads(args.credentials.read_text()), args.base_url)
    if args.action == "status":
        print(client.compose("ps"), end="")
    elif args.action == "images":
        print(client.compose("images"), end="")
    elif args.action == "config":
        print(json.dumps(public_config(client.config()), indent=2))
    else:
        destination = ROOT / ".env.local"
        export_env(client.config(), destination)
        print("Saved .env.local with mode 0600. Production bot was not changed.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Avoid tracebacks/server responses that might include secret values.
        print(f"Failed ({type(error).__name__}). Check LAN access, credentials, and whether .env.local already exists.", file=sys.stderr)
        sys.exit(1)
