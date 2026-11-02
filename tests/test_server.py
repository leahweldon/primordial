from fastapi.testclient import TestClient

from primordial.protocol import decode_frame
from primordial.server import create_app


def recv_until(ws, kind):
    for _ in range(200):
        msg = ws.receive()
        if msg.get("text") and f'"type":"{kind}"' in msg["text"].replace(" ", ""):
            import json

            return json.loads(msg["text"])
    raise AssertionError(f"never received {kind}")


def test_http_endpoints():
    with TestClient(create_app(seed=1)) as client:
        assert client.get("/healthz").json()["ok"] is True
        assert client.get("/").status_code == 200
        assert client.get("/static/app.js").status_code == 200
        csv = client.get("/api/history.csv")
        assert csv.status_code == 200 and csv.text.startswith("tick,population")
        assert client.get("/api/creatures/999999999").status_code == 404


def test_websocket_stream_and_commands():
    with TestClient(create_app(seed=1)) as client, client.websocket_connect("/ws") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["seed"] == 1
        assert "plant_growth" in hello["tunable"]
        assert hello["species"][0]["name"] and hello["events"][0]["kind"] == "origin"

        frame = next(m["bytes"] for m in iter(ws.receive, None) if m.get("bytes"))
        tick, creatures, _ = decode_frame(frame)
        assert len(creatures) > 0

        ws.send_json({"type": "pause", "paused": True})
        assert recv_until(ws, "status")["paused"] is True

        ws.send_json({"type": "set", "key": "plant_growth", "value": 99})
        assert recv_until(ws, "config")["config"]["plant_growth"] == 25.0  # clamped to slider max

        ws.send_json({"type": "set", "key": "width", "value": 10})
        assert "not tunable" in recv_until(ws, "error")["message"]

        ws.send_json({"type": "teleport"})
        assert recv_until(ws, "error")["type"] == "error"

        cid = int(creatures["id"][0])
        ws.send_json({"type": "inspect", "id": cid})
        assert recv_until(ws, "inspect")["creature"]["id"] == cid

        ws.send_json({"type": "reset", "seed": 99})
        assert recv_until(ws, "hello")["seed"] == 99


def test_events_are_rate_limited():
    with TestClient(create_app(seed=1)) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()
        for _ in range(8):
            ws.send_json({"type": "event", "kind": "bloom", "x": 100, "y": 100})
        assert "one disaster at a time" in recv_until(ws, "error")["message"].lower()


def test_snapshot_download_and_upload():
    with TestClient(create_app(seed=1)) as client:
        snap = client.get("/api/snapshot")
        assert snap.status_code == 200 and snap.content[:2] == b"PK"  # a zip archive
        tick = client.get("/api/status").json()["tick"]

        with TestClient(create_app(seed=2)) as other:
            up = other.post("/api/snapshot", content=snap.content)
            assert up.status_code == 200 and up.json()["tick"] >= 0
            assert other.get("/api/status").json()["seed"] == 1
            assert other.get("/api/status").json()["tick"] >= tick

        bad = client.post("/api/snapshot", content=b"nope")
        assert bad.status_code == 400


def test_snapshot_upload_size_limit(monkeypatch):
    from primordial import server

    monkeypatch.setattr(server, "MAX_SNAPSHOT_BYTES", 100)
    with TestClient(create_app(seed=1)) as client:
        assert client.post("/api/snapshot", content=b"x" * 500).status_code == 413


def test_species_and_events_endpoints():
    with TestClient(create_app(seed=1)) as client:
        species = client.get("/api/species").json()
        assert species[0]["root_kind"] == "founder" and species[0]["ancestor"] == -1
        assert client.get("/api/events").json()[0]["kind"] == "origin"


def test_frames_are_flow_controlled():
    """A viewer that never acknowledges frames gets two and then only JSON."""
    import time

    with TestClient(create_app(seed=1, fps=60)) as client, client.websocket_connect("/ws") as ws:
        ws.receive_json()  # hello
        frames = 0
        deadline = time.time() + 1.5
        while time.time() < deadline:
            msg = ws.receive()
            frames += bool(msg.get("bytes"))
        assert frames == 2
        ws.send_json({"type": "ack"})
        while not (msg := ws.receive()).get("bytes"):
            pass  # one more frame arrives once there's credit
