"""Verify memory changes gameplay after a fresh gateway session, using real PowerContext."""

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend import create_app
from engine import main

TOKEN = "local-test-token-for-yesterday-store"
HEADERS = {"Authorization": "Bearer " + TOKEN}


def play(client, player, action, request):
    snapshot = client.get(f"/players/{player}", headers=HEADERS)
    assert snapshot.status_code == 200
    transition = json.loads(main(snapshot.text, action, request)["transition"])
    saved = client.post(f"/players/{player}/commit", headers=HEADERS, json=transition)
    assert saved.status_code == 200, saved.text
    assert saved.json()["citation"]["memory_ref"]["family"] == "memory"
    return saved.json()


def test_returning_umbrella_changes_ending_after_restart(tmp_path: Path):
    with TestClient(create_app(tmp_path, TOKEN)) as client:
        assert not play(client, "keeper", "敲铃", "a")["event"]["state"]["escaped"]
        play(client, "keeper", "借伞", "b")
        play(client, "keeper", "还伞", "c")
    with TestClient(create_app(tmp_path, TOKEN)) as client:
        rewind = play(client, "keeper", "回到昨天", "d")
        assert "守约不会白费" in rewind["event"]["story"]
        assert play(client, "keeper", "敲铃", "e")["event"]["state"]["escaped"]
        stranger = play(client, "stranger", "敲铃", "f")
        assert not stranger["event"]["state"]["escaped"]


def test_stolen_bell_remains_debt_and_retries_do_not_double_apply(tmp_path: Path):
    with TestClient(create_app(tmp_path, TOKEN)) as client:
        play(client, "thief", "偷铃", "steal")
        rewind = play(client, "thief", "回到昨天", "rewind")
        assert rewind["event"]["state"]["debt"]
        assert not rewind["event"]["state"]["bell"]
        denied = play(client, "thief", "借伞", "borrow")
        assert not denied["event"]["state"]["umbrella"]
        replay = client.post(
            "/players/thief/commit", headers=HEADERS, json=denied["event"]
        )
        assert replay.status_code == 200
        assert replay.json()["replayed"]
        stale = dict(denied["event"], request_id="stale-request")
        assert (
            client.post(
                "/players/thief/commit", headers=HEADERS, json=stale
            ).status_code
            == 409
        )
        play(client, "thief", "道歉", "sorry")
        assert play(client, "thief", "借伞", "borrow-again")["event"]["state"][
            "umbrella"
        ]


def test_gateway_requires_token(tmp_path: Path):
    with TestClient(create_app(tmp_path, TOKEN)) as client:
        assert client.get("/players/guest").status_code == 401


def test_model_outage_preserves_committed_memory(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MODEL_BASE_URL", "http://127.0.0.1:1/v1")
    with TestClient(create_app(tmp_path, TOKEN)) as client:
        saved = play(client, "offline", "借伞", "offline-request")
        narration = client.post(
            "/narrate", headers=HEADERS, json={"saved": saved, "past": {}}
        )
        assert narration.status_code == 200
        assert narration.json()["used_model"] is False
        recalled = client.get("/players/offline", headers=HEADERS).json()
        assert recalled["state"]["umbrella"] is True
        assert recalled["revision"] == saved["citation"]["memory_ref"]["revision"]
