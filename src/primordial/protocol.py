"""Wire format between the simulation server and the browser.

World frames are sent as compact binary WebSocket messages (32 bytes per
creature, 4 per plant) instead of JSON, which keeps a 1,500-creature world
at roughly 55 KB per frame. Everything else (stats, commands, inspector
data) is small and infrequent, so it travels as JSON.

Frame layout (little-endian; every field is naturally aligned so the
browser can read it with typed-array views and no copying):

    header   16 B   magic "PRIM", uint32 tick, uint32 n_creatures, uint32 n_plants
    creature 32 B   uint32 id, float32 x, y, heading, radius,
                    uint8 r, g, b, diet (0-255),
                    uint16 species (nearest named species, 65535 = none),
                    uint8 energy (0-255, 128 = ready to reproduce),
                    uint8 flags (bit 0: biting, bit 1: ate in the last few ticks),
                    uint8 speed (top-speed gene, 0-8 mapped to 0-255),
                    uint8 thrust (how hard it is swimming right now),
                    uint8 age (fraction of a full lifespan), uint8 kills (capped at 255)

The browser draws each creature from these: the speed gene sets its tail,
diet its jaws and spikes, thrust how hard the tail beats, age how faded it
looks, and kills how many scars it carries.
    plant     4 B   uint16 x, y
"""

from __future__ import annotations

import struct
from typing import Annotated, Literal

import numpy as np
from pydantic import BaseModel, Field, TypeAdapter

from .world import BODY_RADIUS, World

MAGIC = b"PRIM"
HEADER = struct.Struct("<4sIII")
CREATURE_DTYPE = np.dtype(
    [
        ("id", "<u4"),
        ("x", "<f4"),
        ("y", "<f4"),
        ("heading", "<f4"),
        ("radius", "<f4"),
        ("r", "u1"),
        ("g", "u1"),
        ("b", "u1"),
        ("diet", "u1"),
        ("species", "<u2"),
        ("energy", "u1"),
        ("flags", "u1"),
        ("speed", "u1"),
        ("thrust", "u1"),
        ("age", "u1"),
        ("kills", "u1"),
    ]
)
PLANT_DTYPE = np.dtype([("x", "<u2"), ("y", "<u2")])
assert CREATURE_DTYPE.itemsize == 32 and PLANT_DTYPE.itemsize == 4
MAX_SPEED_GENE = 8.0
ATE_WINDOW = 8  # ticks a creature keeps its "just ate" flag
NO_SPECIES = 65535


def encode_frame(world: World) -> bytes:
    p = world.pop
    n, m = len(p), world.plants.shape[0]
    rec = np.empty(n, CREATURE_DTYPE)
    rec["id"] = p["id"].astype(np.uint32)
    rec["x"] = p["pos"][:, 0]
    rec["y"] = p["pos"][:, 1]
    rec["heading"] = p["heading"]
    rec["radius"] = BODY_RADIUS * p["size"]
    rgb = np.round(p["color"] * 255).astype(np.uint8)
    rec["r"], rec["g"], rec["b"] = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    rec["diet"] = np.round(p["diet"] * 255).astype(np.uint8)
    shown = world.species.display_ids(p["species"])
    rec["species"] = np.where((shown >= 0) & (shown < NO_SPECIES), shown, NO_SPECIES).astype(np.uint16)
    ready = p["energy"] / (world.cfg.reproduce_threshold * p["size"] ** 2)
    rec["energy"] = np.clip(np.round(ready * 128), 0, 255).astype(np.uint8)
    ate = (world.tick - p["last_meal"]) <= ATE_WINDOW
    rec["flags"] = p["attacking"].astype(np.uint8) | (ate.astype(np.uint8) << 1)
    rec["speed"] = np.clip(np.round(p["speed"] / MAX_SPEED_GENE * 255), 0, 255).astype(np.uint8)
    rec["thrust"] = np.clip(np.round(p["thrust"] * 255), 0, 255).astype(np.uint8)
    rec["age"] = np.clip(np.round(p["age"] / world.cfg.max_age * 255), 0, 255).astype(np.uint8)
    rec["kills"] = np.minimum(p["kills"], 255).astype(np.uint8)

    plants = np.empty(m, PLANT_DTYPE)
    plants["x"] = np.clip(world.plants[:, 0], 0, 65535)
    plants["y"] = np.clip(world.plants[:, 1], 0, 65535)
    return HEADER.pack(MAGIC, world.tick, n, m) + rec.tobytes() + plants.tobytes()


def decode_frame(data: bytes) -> tuple[int, np.ndarray, np.ndarray]:
    """Inverse of :func:`encode_frame` (used by tests and offline tools)."""
    magic, tick, n, m = HEADER.unpack_from(data)
    if magic != MAGIC:
        raise ValueError("not a Primordial frame")
    off = HEADER.size
    creatures = np.frombuffer(data, CREATURE_DTYPE, n, off)
    plants = np.frombuffer(data, PLANT_DTYPE, m, off + n * CREATURE_DTYPE.itemsize)
    return tick, creatures, plants


# --------------------------------------------------------------------------
# Commands from the browser. Validated with a discriminated union so that a
# malformed message is rejected with a clear error instead of crashing the
# simulation loop.
# --------------------------------------------------------------------------
class SetParam(BaseModel):
    type: Literal["set"]
    key: str
    value: float


class Pause(BaseModel):
    type: Literal["pause"]
    paused: bool


class Speed(BaseModel):
    type: Literal["speed"]
    value: int = Field(ge=1, le=64)


class Event(BaseModel):
    type: Literal["event"]
    kind: Literal["meteor", "bloom", "invasion"]
    x: float
    y: float


class Inspect(BaseModel):
    type: Literal["inspect"]
    id: int | None = None


class Reset(BaseModel):
    type: Literal["reset"]
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)


class Ack(BaseModel):
    """The browser has drawn a frame and is ready for another (flow control)."""

    type: Literal["ack"]


class Hello(BaseModel):
    """Ask for a fresh ``hello`` (used by the browser after loading a world)."""

    type: Literal["hello"]


Command = Annotated[
    SetParam | Pause | Speed | Event | Inspect | Reset | Hello | Ack, Field(discriminator="type")
]
parse_command = TypeAdapter(Command).validate_json
