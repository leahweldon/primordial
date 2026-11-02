"""Save a world to a file and load it back, bit for bit.

A snapshot is a NumPy ``.npz`` archive: every creature array, the plants
and oases, the species reference genomes, plus one JSON metadata blob with
everything else (config, random generator state, history, species registry,
narrator memory). Restoring the generator state is what makes a loaded world
continue exactly as the original would have.

Snapshots can be uploaded through the web app, so loading treats the file
as untrusted: ``allow_pickle=False`` (no code execution), a fixed schema,
and shape and dtype checks on every array before anything is used.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import BinaryIO

import numpy as np

from . import analytics
from .config import WorldConfig
from .narrator import Narrator
from .population import Population
from .species import Speciation
from .world import World

FORMAT = "primordial-snapshot"
VERSION = 2  # 2: creatures remember their last meal


class SnapshotError(ValueError):
    """The file is not a valid Primordial snapshot."""


def save(world: World, target: str | Path | BinaryIO) -> None:
    sp_meta, ref_ids, ref_g = world.species.state()
    meta = {
        "format": FORMAT,
        "version": VERSION,
        "tick": world.tick,
        "seed": world.seed,
        "next_id": world.next_id,
        "rng": world.rng.bit_generator.state,
        "config": world.cfg.to_dict(),
        "counters": world.counters,
        "history": world.history.rows,
        "events": world.events,
        "event_seq": world.event_seq,
        "species": sp_meta,
        "narrator": world.narrator.state(),
    }
    arrays = {f"pop__{k}": v for k, v in world.pop.a.items()}
    arrays.update(
        plants=world.plants,
        zones=world.zones,
        zone_vel=world.zone_vel,
        ref_ids=ref_ids,
        ref_genomes=ref_g,
        meta=np.frombuffer(json.dumps(meta).encode(), dtype=np.uint8),
    )
    np.savez_compressed(target, **arrays)


def to_bytes(world: World) -> bytes:
    buf = io.BytesIO()
    save(world, buf)
    return buf.getvalue()


def load(source: str | Path | BinaryIO | bytes) -> World:
    if isinstance(source, bytes):
        source = io.BytesIO(source)
    try:
        with np.load(source, allow_pickle=False) as npz:
            files = {k: npz[k] for k in npz.files}
    except Exception as exc:  # zipfile, pickle refusal, truncated data...
        raise SnapshotError(f"not a readable snapshot ({exc.__class__.__name__})") from exc

    try:
        meta = json.loads(files.pop("meta").tobytes().decode())
    except Exception as exc:
        raise SnapshotError("snapshot metadata is missing or corrupt") from exc
    if meta.get("format") != FORMAT:
        raise SnapshotError("not a Primordial snapshot")
    if meta.get("version") != VERSION:
        raise SnapshotError(f"unsupported snapshot version {meta.get('version')}")

    try:
        return _restore(meta, files)
    except SnapshotError:
        raise
    except (KeyError, TypeError, ValueError) as exc:
        raise SnapshotError(f"snapshot is inconsistent: {exc}") from exc


def _restore(meta: dict, files: dict[str, np.ndarray]) -> World:
    cfg = WorldConfig()
    cfg.update(**meta["config"])

    template = Population.empty(cfg.hidden_size).a
    pop_arrays = {}
    n = None
    for key, empty in template.items():
        arr = files.get(f"pop__{key}")
        if arr is None:
            raise SnapshotError(f"missing creature array {key!r}")
        if arr.dtype != empty.dtype or arr.shape[1:] != empty.shape[1:]:
            raise SnapshotError(f"creature array {key!r} has the wrong shape or type")
        if n is None:
            n = arr.shape[0]
        elif arr.shape[0] != n:
            raise SnapshotError("creature arrays have different lengths")
        pop_arrays[key] = arr.copy()
    if n > cfg.max_creatures * 2:
        raise SnapshotError("too many creatures")

    w = World.__new__(World)
    w.cfg = cfg
    w.seed = int(meta["seed"])
    w.rng = np.random.Generator(np.random.PCG64())
    if meta["rng"].get("bit_generator") != "PCG64":
        raise SnapshotError("unsupported random generator")
    w.rng.bit_generator.state = meta["rng"]
    w.tick = int(meta["tick"])
    w.next_id = int(meta["next_id"])
    w.box = np.array([cfg.width, cfg.height])
    w.counters = {k: int(v) for k, v in meta["counters"].items()}
    w.history = analytics.History(rows=list(meta["history"]))
    w.events = list(meta["events"])
    w.event_seq = int(meta["event_seq"])
    w.narrator = Narrator.from_state(meta["narrator"])
    w.pop = Population(pop_arrays)

    w.plants = _float_matrix(files, "plants", 2)
    w.zones = _float_matrix(files, "zones", 3)
    w.zone_vel = _float_matrix(files, "zone_vel", 2)
    w.species = Speciation.from_state(meta["species"], files["ref_ids"], files["ref_genomes"])

    # every creature must point at species and references that exist
    if n and (w.pop["species"].min() < 0 or w.pop["species"].max() >= w.species.next_species):
        raise SnapshotError("creature refers to an unknown species")
    missing = set(np.unique(w.pop["ref"]).tolist()) - set(w.species.refs)
    if missing:
        raise SnapshotError("creature refers to an unknown reference genome")
    return w


def _float_matrix(files: dict, key: str, cols: int) -> np.ndarray:
    arr = files.get(key)
    if arr is None or arr.ndim != 2 or arr.shape[1] != cols or arr.dtype.kind != "f":
        raise SnapshotError(f"{key!r} has the wrong shape")
    return arr.astype(np.float64)
