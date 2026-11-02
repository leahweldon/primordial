import io
import json

import numpy as np
import pytest

from primordial import World
from primordial.persistence import SnapshotError, load, save, to_bytes


def test_a_loaded_world_continues_exactly_like_the_original(tmp_path):
    a = World(seed=3)
    a.run(2500)
    path = tmp_path / "world.npz"
    save(a, path)
    b = load(path)
    a.run(1500)
    b.run(1500)
    for key in a.pop.a:
        np.testing.assert_array_equal(a.pop[key], b.pop[key], err_msg=key)
    np.testing.assert_array_equal(a.plants, b.plants)
    np.testing.assert_array_equal(a.zones, b.zones)
    assert a.history.rows == b.history.rows
    assert a.events == b.events
    assert a.species.registry() == b.species.registry()


def test_rejects_garbage():
    with pytest.raises(SnapshotError):
        load(b"definitely not a zip file")


def test_rejects_pickles():
    buf = io.BytesIO()
    np.savez(buf, meta=np.array([{"evil": True}], dtype=object))
    with pytest.raises(SnapshotError):
        load(buf.getvalue())


def _tamper(world, **changes) -> bytes:
    with np.load(io.BytesIO(to_bytes(world)), allow_pickle=False) as npz:
        files = {k: npz[k] for k in npz.files}
    meta = json.loads(files["meta"].tobytes())
    for key, value in changes.items():
        if key.startswith("meta."):
            meta[key[5:]] = value
        else:
            files[key] = value
    files["meta"] = np.frombuffer(json.dumps(meta).encode(), np.uint8)
    buf = io.BytesIO()
    np.savez(buf, **files)
    return buf.getvalue()


@pytest.mark.parametrize(
    "changes, message",
    [
        ({"meta.format": "something-else"}, "not a Primordial snapshot"),
        ({"meta.version": 99}, "unsupported snapshot version"),
        ({"pop__energy": np.zeros(3)}, "different lengths"),
        ({"pop__W1": np.zeros((1, 2, 3), np.float32)}, "wrong shape"),
        ({"plants": np.zeros((4, 5))}, "wrong shape"),
        ({"meta.config": {"gravity": 9.8}}, "inconsistent"),
    ],
)
def test_rejects_tampered_snapshots(changes, message):
    w = World(seed=0)
    w.run(20)
    with pytest.raises(SnapshotError, match=message):
        load(_tamper(w, **changes))


def test_rejects_creatures_from_unknown_species():
    w = World(seed=0)
    species = w.pop["species"].copy()
    species[0] = 999
    with pytest.raises(SnapshotError, match="unknown species"):
        load(_tamper(w, pop__species=species))
