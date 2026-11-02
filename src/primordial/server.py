"""FastAPI app: runs one shared world and streams it to every browser.

Architecture
------------
* A single ``Simulation`` owns the ``World``. A background asyncio task
  advances it and broadcasts a binary frame ~30 times a second.
* The CPU-bound ``World.step`` calls run in a worker thread so the event loop
  stays free to accept connections and commands.
* An ``asyncio.Lock`` serialises every mutation of the world (stepping,
  slider changes, meteors, resets), so commands never race the simulation.
* Every viewer sees the same world; commands from any viewer affect it for
  everyone. Events are rate-limited per connection.
* Narrated events carry a sequence number, so each broadcast sends only the
  ones viewers haven't seen, and a late joiner gets the backlog in ``hello``.
* Worlds can be downloaded and uploaded as snapshots; uploads are size-capped
  and validated before they replace the running world.
* Each viewer has its own sender task. The simulation never waits on a
  socket: it drops the newest frame into the viewer's slot (replacing any
  frame that viewer hasn't taken yet) and moves on.
* Frames are flow-controlled with credits: a viewer gets a frame only when
  it has acknowledged drawing an earlier one (two may be in flight). A slow
  device simply receives fewer, always-current frames instead of building
  up a backlog and falling seconds behind, and it can't slow the world down
  for anyone else.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from . import __version__
from .brain import INPUTS, OUTPUTS
from .config import TUNABLE, WorldConfig
from .persistence import SnapshotError, load, to_bytes
from .protocol import Ack, Event, Hello, Inspect, Pause, Reset, SetParam, Speed, encode_frame, parse_command
from .world import World

log = logging.getLogger("primordial")
WEB_DIR = Path(__file__).parent / "web"
MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024


@dataclass
class TokenBucket:
    """Allows ``rate`` actions per second with bursts of up to ``burst``."""

    rate: float = 2.0
    burst: float = 4.0
    tokens: float = 4.0
    updated: float = field(default_factory=time.monotonic)

    def take(self) -> bool:
        now = time.monotonic()
        self.tokens = min(self.burst, self.tokens + (now - self.updated) * self.rate)
        self.updated = now
        if self.tokens >= 1.0:
            self.tokens -= 1.0
            return True
        return False


@dataclass(eq=False)  # identity hashing so clients can live in a set
class Client:
    ws: WebSocket
    inspect_id: int | None = None
    events: TokenBucket = field(default_factory=TokenBucket)
    frame: bytes | None = None  # latest world frame not yet sent (older ones are dropped)
    credits: int = 2  # frames this viewer is ready for; each "ack" returns one
    outbox: deque = field(default_factory=lambda: deque(maxlen=512))  # JSON messages, in order
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    dropped: int = 0

    async def pump(self) -> None:
        """Send queued messages, then the newest frame, whenever there's something to send."""
        while True:
            await self.wake.wait()
            self.wake.clear()
            while self.outbox:
                await self.ws.send_json(self.outbox.popleft())
            if self.frame is not None and self.credits > 0:
                frame, self.frame = self.frame, None
                self.credits -= 1
                await self.ws.send_bytes(frame)


class Simulation:
    def __init__(
        self, seed: int = 7, config: WorldConfig | None = None, fps: float = 30.0, world: World | None = None
    ):
        self.base_config = config or WorldConfig()
        self.world = world or World(WorldConfig(**self.base_config.to_dict()), seed=seed)
        self.seed = self.world.seed
        self.fps = fps
        self.ticks_per_frame = 4
        self.paused = False
        self.clients: set[Client] = set()
        self.lock = asyncio.Lock()
        self.step_ms = 0.0  # rolling average cost of one tick
        self._sent_rows = len(self.world.history.rows)
        self._sent_seq = self.world.event_seq
        self._task: asyncio.Task | None = None

    # ------------------------------------------------------------- lifecycle
    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _loop(self) -> None:
        frame_time = 1.0 / self.fps
        frame_no = 0
        while True:
            started = time.perf_counter()
            async with self.lock:
                if not self.paused:
                    await asyncio.to_thread(self._advance, self.ticks_per_frame)
                frame = encode_frame(self.world)
            await self._broadcast_bytes(frame)
            frame_no += 1
            if frame_no % 3 == 0:  # ~10 Hz: the inspector's live brain view
                await self._broadcast_inspect()
            if frame_no % 6 == 0:  # ~5 Hz: charts, status, narration
                await self._broadcast_stats()
            elapsed = time.perf_counter() - started
            await asyncio.sleep(max(0.0, frame_time - elapsed))

    def _advance(self, ticks: int) -> None:
        t0 = time.perf_counter()
        self.world.run(ticks)
        per_tick = (time.perf_counter() - t0) * 1000 / max(ticks, 1)
        self.step_ms = 0.9 * self.step_ms + 0.1 * per_tick

    # ------------------------------------------------------------- messaging
    def hello(self) -> dict:
        w = self.world
        return {
            "type": "hello",
            "version": __version__,
            "world": {"width": w.cfg.width, "height": w.cfg.height, "zones": w.zones.tolist()},
            "seed": self.seed,
            "config": w.cfg.to_dict(),
            "tunable": {k: {"min": a, "max": b, "step": s} for k, (a, b, s) in TUNABLE.items()},
            "brain": {"inputs": list(INPUTS), "outputs": list(OUTPUTS)},
            "history": w.history.rows,
            "events": w.events,
            "species": w.species.registry(),
        }

    def status(self) -> dict:
        return {
            "type": "status",
            "tick": self.world.tick,
            "population": len(self.world.pop),
            "paused": self.paused,
            "speed": self.ticks_per_frame,
            "seed": self.seed,
            "step_ms": round(self.step_ms, 3),
            "viewers": len(self.clients),
            "season": self.world.season,
            "season_phase": round(self.world.season_phase(), 4),
            "zones": self.world.zones.round(1).tolist(),
        }

    async def _broadcast_bytes(self, data: bytes) -> None:
        for c in self.clients:
            if c.frame is not None:
                c.dropped += 1  # they hadn't taken the last one yet: latest frame wins
            c.frame = data
            c.wake.set()

    async def _send(self, c: Client, msg: dict) -> None:
        c.outbox.append(msg)
        c.wake.set()

    async def _broadcast_stats(self) -> None:
        w = self.world
        rows = w.history.rows
        # History thins itself when it gets long; if that happened, resend the tail.
        new_rows = rows[self._sent_rows :] if self._sent_rows <= len(rows) else rows[-1:]
        self._sent_rows = len(rows)
        events = [e for e in w.events if e["seq"] > self._sent_seq]
        self._sent_seq = w.event_seq
        status = self.status()
        stats = {"type": "stats", "rows": new_rows, "events": events}
        if any(e["kind"] in ("speciation", "extinct", "origin", "newcomers") for e in events):
            stats["species"] = w.species.registry()
        for c in list(self.clients):
            await self._send(c, status)
            if new_rows or events:
                await self._send(c, stats)

    async def _broadcast_inspect(self) -> None:
        for c in list(self.clients):
            if c.inspect_id is not None:
                await self._send(c, {"type": "inspect", "creature": self.world.describe(c.inspect_id)})

    async def replace_world(self, world: World) -> None:
        """Swap in a new world (reset or upload) and re-sync every viewer."""
        self.world = world
        self.seed = world.seed
        self._sent_rows = len(world.history.rows)
        self._sent_seq = world.event_seq
        hello = self.hello()
        for other in list(self.clients):
            other.inspect_id = None
            await self._send(other, hello)

    # ------------------------------------------------------------- commands
    async def handle(self, c: Client, raw: str) -> None:
        try:
            cmd = parse_command(raw)
        except ValidationError as exc:
            await self._send(c, {"type": "error", "message": exc.errors()[0]["msg"]})
            return
        if isinstance(cmd, Ack):  # flow control: no lock, no reply
            c.credits = min(2, c.credits + 1)
            c.wake.set()
            return

        async with self.lock:
            w = self.world
            if isinstance(cmd, SetParam):
                if cmd.key not in TUNABLE:
                    await self._send(c, {"type": "error", "message": f"{cmd.key} is not tunable"})
                    return
                lo, hi, _ = TUNABLE[cmd.key]
                w.cfg.update(**{cmd.key: min(max(cmd.value, lo), hi)})
                msg = {"type": "config", "config": w.cfg.to_dict()}
                for other in list(self.clients):
                    await self._send(other, msg)
            elif isinstance(cmd, Pause):
                self.paused = cmd.paused
            elif isinstance(cmd, Speed):
                self.ticks_per_frame = cmd.value
            elif isinstance(cmd, Event):
                if not c.events.take():
                    await self._send(c, {"type": "error", "message": "Easy! One disaster at a time."})
                    return
                getattr(w, cmd.kind)(cmd.x, cmd.y)
            elif isinstance(cmd, Inspect):
                c.inspect_id = cmd.id
                creature = w.describe(cmd.id) if cmd.id is not None else None
                await self._send(c, {"type": "inspect", "creature": creature})
            elif isinstance(cmd, Reset):
                seed = cmd.seed if cmd.seed is not None else int(time.time()) % 100_000
                await self.replace_world(World(WorldConfig(**self.base_config.to_dict()), seed=seed))
            elif isinstance(cmd, Hello):
                await self._send(c, self.hello())
        await self._send(c, self.status())


def create_app(
    seed: int = 7, config: WorldConfig | None = None, fps: float = 30.0, world: World | None = None
) -> FastAPI:
    sim = Simulation(seed=seed, config=config, fps=fps, world=world)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        sim.start()
        yield
        await sim.stop()

    app = FastAPI(title="Primordial", version=__version__, lifespan=lifespan)
    app.state.sim = sim

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/healthz")
    async def health():
        return {"ok": True, "tick": sim.world.tick, "population": len(sim.world.pop)}

    @app.get("/api/status")
    async def api_status():
        return sim.status()

    @app.get("/api/history")
    async def api_history():
        return JSONResponse(sim.world.history.rows)

    @app.get("/api/history.csv", response_class=PlainTextResponse)
    async def api_history_csv():
        buf = io.StringIO()
        sim.world.history.to_csv(buf)
        return PlainTextResponse(
            buf.getvalue(),
            headers={"Content-Disposition": f'attachment; filename="primordial-seed{sim.seed}.csv"'},
        )

    @app.get("/api/species")
    async def api_species():
        return sim.world.species.registry()

    @app.get("/api/events")
    async def api_events():
        return sim.world.events

    @app.get("/api/snapshot")
    async def api_snapshot_download():
        async with sim.lock:
            data = await asyncio.to_thread(to_bytes, sim.world)
            tick = sim.world.tick
        return Response(
            data,
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f'attachment; filename="primordial-seed{sim.seed}-tick{tick}.npz"'
            },
        )

    @app.post("/api/snapshot")
    async def api_snapshot_upload(request: Request):
        declared = int(request.headers.get("content-length") or 0)
        if declared > MAX_SNAPSHOT_BYTES:
            raise HTTPException(413, "snapshot is too large")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_SNAPSHOT_BYTES:
                raise HTTPException(413, "snapshot is too large")
        try:
            world = await asyncio.to_thread(load, bytes(body))
        except SnapshotError as exc:
            raise HTTPException(400, str(exc)) from exc
        async with sim.lock:
            await sim.replace_world(world)
        return {"ok": True, "tick": world.tick, "population": len(world.pop)}

    @app.get("/api/creatures/{creature_id}")
    async def api_creature(creature_id: int):
        found = sim.world.describe(creature_id)
        if found is None:
            raise HTTPException(404, "no living creature with that id")
        return found

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        await ws.accept()
        client = Client(ws)
        await ws.send_json(sim.hello())
        sim.clients.add(client)
        sender = asyncio.create_task(client.pump())
        try:
            while True:
                receive = asyncio.ensure_future(ws.receive_text())
                done, _ = await asyncio.wait({receive, sender}, return_when=asyncio.FIRST_COMPLETED)
                if sender in done:  # the socket broke while sending
                    receive.cancel()
                    break
                await sim.handle(client, receive.result())
        except WebSocketDisconnect:
            pass
        finally:
            sim.clients.discard(client)
            sender.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await sender

    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
    return app
