import numpy as np
import pytest

from primordial import World, WorldConfig


def quiet_config(**overrides) -> WorldConfig:
    """An empty world with no random arrivals or plant growth, for controlled tests."""
    cfg = WorldConfig(initial_creatures=0, initial_plants=0, plant_growth=0.0, immigration=False)
    cfg.update(**overrides) if overrides else None
    return cfg


def place(
    world: World, xy, *, diet=0.0, size=1.0, energy=60.0, age=0, attack=-5.0, reproduce=-5.0, thrust=-5.0
) -> int:
    """Add one creature with a hard-wired brain: outputs are fixed by the biases."""
    pop = world._random_creatures(1)
    pop["pos"][:] = xy
    pop["diet"][:] = diet
    pop["size"][:] = size
    pop["energy"][:] = energy
    pop["age"][:] = age
    pop["W2"][:] = 0.0
    pop["b2"][:] = [0.0, thrust, attack, reproduce]
    world.pop.extend(pop)
    return int(pop["id"][0])


@pytest.fixture
def empty_world():
    return World(quiet_config(), seed=0)


def by_id(world: World, cid: int) -> int:
    hits = np.flatnonzero(world.pop["id"] == cid)
    assert hits.size == 1, f"creature {cid} not found"
    return int(hits[0])
