"""Initialize our local Dify, import the submitted DSL and execute real graph runs.

Never print or persist credentials. Run evidence redacts the gateway token.
"""

import argparse
import json
import os
from pathlib import Path
from uuid import uuid4

import httpx
import yaml


ROOT = Path(__file__).parent


def settings():
    return dict(
        line.split("=", 1)
        for line in (ROOT / ".env").read_text().splitlines()
        if line and not line.startswith("#")
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:15001")
    parser.add_argument("--gateway", default="http://10.0.2.2:8010")
    parser.add_argument(
        "--actions", nargs="+", default=["观察", "借伞", "还伞", "回到昨天", "敲铃"]
    )
    parser.add_argument(
        "--reuse",
        action="store_true",
        help="update the locally remembered app instead of creating another",
    )
    parser.add_argument("--evidence-name", default="happy-path")
    args = parser.parse_args()
    env = settings()
    base = args.url.rstrip("/") + "/console/api"
    client = httpx.Client(timeout=240, trust_env=False)

    def call(method, path, **kwargs):
        response = client.request(method, base + path, **kwargs)
        if response.status_code >= 400:
            raise RuntimeError(
                f"Dify {path}: HTTP {response.status_code}: "
                + response.text.replace(env["STORE_TOKEN"], "[REDACTED]")[:2000]
            )
        return response

    setup = call("GET", "/setup").json()
    if setup["step"] == "not_started":
        call(
            "POST",
            "/setup",
            json={
                "email": env["LOCAL_ADMIN_EMAIL"],
                "password": env["LOCAL_ADMIN_PASSWORD"],
                "name": "OceanBase Captain",
                "language": "zh-Hans",
            },
        )
        print("Dify initialized", flush=True)
    login = call(
        "POST",
        "/login",
        json={
            "email": env["LOCAL_ADMIN_EMAIL"],
            "password": env["LOCAL_ADMIN_PASSWORD"],
            "remember_me": True,
        },
    )
    for cookie in client.cookies.jar:
        if "csrf" in cookie.name:
            client.headers["X-CSRF-Token"] = cookie.value
    data = login.json().get("data", {})
    if data.get("access_token"):
        client.headers["Authorization"] = "Bearer " + data["access_token"]
    dsl = yaml.safe_load((ROOT / "yesterday-store.yml").read_text())
    for variable in dsl["workflow"]["environment_variables"]:
        variable["value"] = (
            args.gateway if variable["name"] == "STORE_URL" else env["STORE_TOKEN"]
        )
    import_payload = {
        "mode": "yaml-content",
        "yaml_content": yaml.safe_dump(dsl, allow_unicode=True, sort_keys=False),
    }
    if args.reuse:
        import_payload["app_id"] = (ROOT / "runtime/app-id.txt").read_text().strip()
    imported = call("POST", "/apps/imports", json=import_payload).json()
    if imported["status"] == "pending":
        imported = call("POST", "/apps/imports/" + imported["id"] + "/confirm").json()
    if imported["status"] not in ["completed", "completed-with-warnings"]:
        raise RuntimeError("Dify import: " + str(imported))
    app_id = imported["app_id"]
    print("Dify DSL imported", app_id, imported["status"], flush=True)
    runtime_dir = ROOT / "runtime"
    runtime_dir.mkdir(exist_ok=True)
    (runtime_dir / "app-id.txt").write_text(app_id)
    if not args.evidence_name.replace("-", "").isalnum():
        raise ValueError("Evidence name must contain only letters, numbers and hyphens")
    evidence = ROOT / "evidence" / args.evidence_name
    evidence.mkdir(parents=True, exist_ok=True)
    player = "acceptance-" + uuid4().hex[:12]
    runs = []
    for action in args.actions:
        response = call(
            "POST",
            f"/apps/{app_id}/workflows/draft/run",
            json={"inputs": {"player": player, "action": action}, "files": []},
        )
        raw = response.text.replace(env["STORE_TOKEN"], "[REDACTED]")
        events = [
            json.loads(line[5:].strip())
            for line in raw.splitlines()
            if line.startswith("data:")
        ]
        finished = next(
            (
                item
                for item in reversed(events)
                if item.get("event") == "workflow_finished"
            ),
            None,
        )
        log_path = evidence / f"run-{len(runs) + 1}.sse"
        log_path.write_text(raw)
        if finished is None:
            raise RuntimeError("No workflow_finished event; see " + str(log_path))
        runs.append({"action": action, "result": finished["data"]})
        print(
            action,
            finished["data"].get("status"),
            finished["data"].get("outputs"),
            flush=True,
        )
        if finished["data"].get("status") != "succeeded":
            raise RuntimeError(
                "Dify graph failed: " + str(finished["data"].get("error"))
            )
        if finished["data"]["outputs"]["model_used"] != "true":
            raise RuntimeError("Real model inference was not used")
    if args.actions == ["观察", "借伞", "还伞", "回到昨天", "敲铃"]:
        assert json.loads(runs[-1]["result"]["outputs"]["state"])["escaped"]
    if args.actions == ["偷铃", "回到昨天", "借伞", "道歉", "借伞"]:
        assert json.loads(runs[2]["result"]["outputs"]["state"])["debt"]
        assert not json.loads(runs[2]["result"]["outputs"]["state"])["umbrella"]
        assert json.loads(runs[-1]["result"]["outputs"]["state"])["umbrella"]
    (evidence / "dify-runs.json").write_text(
        json.dumps(
            {"dify_version": "1.9.2", "player": player, "app_id": app_id, "runs": runs},
            ensure_ascii=False,
            indent=2,
        )
    )
    call(
        "POST",
        f"/apps/{app_id}/workflows/publish",
        json={
            "marked_name": "昨日便利店 1.0",
            "marked_comment": "真实记忆和本地模型完整验收",
        },
    )
    call("POST", f"/apps/{app_id}/api-enable", json={"enable_api": True})
    api_key = call("POST", f"/apps/{app_id}/api-keys").json()["token"]
    config_path = runtime_dir / "app-config.json"
    config_path.write_text(
        json.dumps({"app_id": app_id, "url": args.url.rstrip("/"), "token": api_key})
    )
    os.chmod(config_path, 0o600)
    print(
        "Verified workflow published locally; open the gateway at http://127.0.0.1:8010",
        flush=True,
    )


if __name__ == "__main__":
    main()
