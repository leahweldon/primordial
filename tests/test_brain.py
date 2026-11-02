import numpy as np

from primordial.brain import N_IN, N_OUT, mutate, random_brains, think


def test_shapes_and_output_range():
    rng = np.random.default_rng(0)
    brains = random_brains(rng, 50, hidden=8)
    assert brains["W1"].shape == (50, 8, N_IN)
    assert brains["W2"].shape == (50, N_OUT, 8)
    out = think(brains, rng.normal(size=(50, N_IN)) * 10)
    assert out.shape == (50, N_OUT)
    assert np.all(np.abs(out) <= 1.0)


def test_each_creature_uses_its_own_brain():
    rng = np.random.default_rng(1)
    brains = random_brains(rng, 3, hidden=4)
    x = rng.normal(size=(3, N_IN))
    batched = think(brains, x)
    for i in range(3):
        single = think({k: v[i : i + 1] for k, v in brains.items()}, x[i : i + 1])
        np.testing.assert_allclose(batched[i], single[0], rtol=1e-6)


def test_mutation_rate_controls_how_much_changes():
    rng = np.random.default_rng(2)
    brains = random_brains(rng, 20, hidden=8)
    same = mutate(brains, rng, rate=0.0, scale=1.0)
    assert all(np.array_equal(same[k], brains[k]) for k in brains)

    changed = mutate(brains, rng, rate=1.0, scale=1.0)
    frac = np.mean(changed["W1"] != brains["W1"])
    assert frac > 0.99
    assert np.all(np.abs(changed["W1"]) <= 6.0)
    # mutate must not modify the parent in place
    assert not np.shares_memory(changed["W1"], brains["W1"])
