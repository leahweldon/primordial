import numpy as np
import pytest

from primordial import World, WorldConfig
from primordial.world import BODY_RADIUS

from .conftest import by_id, place, quiet_config


def test_same_seed_same_world():
    a, b = World(seed=42), World(seed=42)
    a.run(300)
    b.run(300)
    for key in ("id", "pos", "energy", "W1", "diet"):
        np.testing.assert_array_equal(a.pop[key], b.pop[key])
    np.testing.assert_array_equal(a.plants, b.plants)
    assert a.history.rows == b.history.rows


def test_different_seed_different_world():
    a, b = World(seed=1), World(seed=2)
    a.run(50)
    b.run(50)
    assert a.state_digest() != b.state_digest()


def test_invariants_hold_over_a_long_run():
    cfg = WorldConfig(max_creatures=400)
    w = World(cfg, seed=3)
    for _ in range(20):
        w.run(50)
        p = w.pop
        assert len(p) <= cfg.max_creatures
        assert np.all(np.isfinite(p["pos"])) and np.all(np.isfinite(p["energy"]))
        assert np.all((p["pos"] >= 0) & (p["pos"] < w.box))
        assert np.all(p["energy"] > 0)
        assert np.all((p["diet"] >= 0) & (p["diet"] <= 1))
        assert len(np.unique(p["id"])) == len(p)
        assert w.plants.shape[0] <= cfg.max_plants


def test_torus_wraps_shortest_way(empty_world):
    d = empty_world._delta(np.array([[1.0, 1.0]]), np.array([[1599.0, 999.0]]))
    np.testing.assert_allclose(d, [[-2.0, -2.0]])


def test_herbivore_eats_a_plant_in_reach(empty_world):
    w = empty_world
    cid = place(w, (500, 500), diet=0.0)
    w.plants = np.array([[503.0, 500.0]])
    w.step()
    i = by_id(w, cid)
    assert w.plants.shape[0] == 0
    assert w.pop["eaten"][i] == 1
    assert w.pop["energy"][i] > 60.0 + w.cfg.plant_energy * 0.9


def test_pure_carnivore_gets_nothing_from_plants(empty_world):
    w = empty_world
    cid = place(w, (500, 500), diet=1.0)
    w.plants = np.array([[503.0, 500.0]])
    w.step()
    assert w.pop["energy"][by_id(w, cid)] < 60.0


def test_two_creatures_cannot_eat_the_same_plant(empty_world):
    w = empty_world
    place(w, (500, 500))
    place(w, (506, 500))
    w.plants = np.array([[503.0, 500.0]])
    w.step()
    assert w.pop["eaten"].sum() == 1


def test_bites_move_energy_from_victim_to_predator(empty_world):
    w = empty_world
    hunter = place(w, (500, 500), diet=1.0, attack=5.0)
    prey = place(w, (500 + 2 * BODY_RADIUS, 500), diet=0.0)
    w.step()
    h, p = by_id(w, hunter), by_id(w, prey)
    assert w.pop["energy"][p] < 60.0 - w.cfg.attack_damage * 0.9
    assert w.pop["energy"][h] > 60.0
    assert w.pop["attacking"][h] and not w.pop["attacking"][p]


def test_a_kill_pays_out_the_body_and_is_credited(empty_world):
    w = empty_world
    hunter = place(w, (500, 500), diet=1.0, attack=5.0, energy=30.0)
    place(w, (500 + 2 * BODY_RADIUS, 500), energy=1.0)
    w.step()
    assert len(w.pop) == 1
    h = by_id(w, hunter)
    assert w.pop["kills"][h] == 1
    assert w.pop["energy"][h] > 30.0 + w.cfg.body_energy * 0.5
    assert w.counters["kills"] == 1


def test_reproduction_conserves_energy_and_inherits(empty_world):
    w = empty_world
    cfg = w.cfg
    parent = place(w, (500, 500), energy=150.0, age=cfg.maturity_age + 1, reproduce=5.0)
    w.step()
    assert len(w.pop) == 2
    i = by_id(w, parent)
    child = 1 - i
    assert w.pop["parent"][child] == parent
    assert w.pop["lineage"][child] == w.pop["lineage"][i]
    assert w.pop["generation"][child] == 1
    body = cfg.body_energy * w.pop["size"][child] ** 2
    total_after = w.pop["energy"][i] + w.pop["energy"][child] + body + cfg.reproduce_cost
    burnt = cfg.basal_cost  # size 1, no movement, no attacks
    assert total_after == pytest.approx(150.0 - burnt)


def test_population_cap_is_respected():
    cfg = quiet_config(max_creatures=3)
    w = World(cfg, seed=0)
    for k in range(3):
        place(w, (100 + 200 * k, 500), energy=200.0, age=500, reproduce=5.0)
    w.step()
    assert len(w.pop) == 3


def test_immigrants_keep_the_world_alive():
    cfg = WorldConfig(initial_creatures=0, min_creatures=10)
    w = World(cfg, seed=0)
    w.step()
    assert len(w.pop) == 10


def test_meteor_bloom_and_invasion():
    w = World(seed=5)
    n_before = len(w.pop)
    killed = w.meteor(800, 500, radius=5000)  # covers the whole world
    assert killed == n_before and len(w.pop) == 0 and w.plants.shape[0] == 0
    assert w.bloom(800, 500, amount=100) == 100
    added = w.invasion(800, 500, amount=12)
    assert added == 12 and len(np.unique(w.pop["lineage"])) == 12
    assert [e["kind"] for e in w.events] == ["origin", "meteor", "bloom", "invasion"]
    assert [e["seq"] for e in w.events] == [1, 2, 3, 4]
    assert "wiped out" in w.events[1]["text"]


def test_describe(empty_world):
    w = empty_world
    cid = place(w, (10, 10), diet=0.9)
    info = w.describe(cid)
    assert info["strategy"] == "predator"
    assert len(info["brain"]["W1"]) == w.cfg.hidden_size
    assert w.describe(10**9) is None


def test_history_is_sampled_on_schedule():
    w = World(seed=0)
    w.run(95)
    assert [r["tick"] for r in w.history.rows] == list(range(0, 91, 10))


def test_config_update_validates():
    cfg = WorldConfig()
    cfg.update(plant_growth="3.5", max_age=10.0)
    assert cfg.plant_growth == 3.5 and cfg.max_age == 10
    with pytest.raises(KeyError):
        cfg.update(gravity=9.8)


def test_zero_bite_strength_is_harmless(empty_world):
    # Regression: 0/0 in the damage share used to turn energy into NaN and kill everyone.
    w = empty_world
    w.cfg.attack_damage = 0.0
    hunter = place(w, (500, 500), diet=1.0, attack=5.0)
    prey = place(w, (500 + 2 * BODY_RADIUS, 500))
    w.step()
    assert len(w.pop) == 2
    assert np.all(np.isfinite(w.pop["energy"]))
    assert w.pop["energy"][by_id(w, prey)] == pytest.approx(60.0 - w.cfg.basal_cost)
    assert by_id(w, hunter) >= 0


def test_seasons_swing_plant_growth():
    w = World(WorldConfig(season_length=100, season_strength=0.5, plant_growth=10.0), seed=0)
    seen, growth = [], []
    for _ in range(400):
        seen.append(w.season)
        growth.append(w.plant_growth_now())
        w.tick += 1
    assert [s for i, s in enumerate(seen) if i == 0 or s != seen[i - 1]] == [
        "spring",
        "summer",
        "autumn",
        "winter",
        "spring",
    ]
    assert max(growth) == pytest.approx(15.0, rel=1e-3)  # midsummer
    assert min(growth) == pytest.approx(5.0, rel=1e-3)  # midwinter

    w.cfg.season_strength = 0.0
    assert w.plant_growth_now() == pytest.approx(10.0)


def test_oases_drift_but_stay_in_the_world():
    w = World(seed=0)
    start = w.zones[:, :2].copy()
    w.run(500)
    assert not np.allclose(start, w.zones[:, :2])
    assert np.all((w.zones[:, :2] >= 0) & (w.zones[:, :2] < w.box))


def test_brain_activity_is_recorded_for_the_inspector(empty_world):
    w = empty_world
    cid = place(w, (500, 500), attack=5.0)
    w.step()
    info = w.describe(cid)
    act = info["activity"]
    assert len(act["in"]) == 11 and len(act["hidden"]) == w.cfg.hidden_size and len(act["out"]) == 4
    assert act["out"][2] > 0.9  # the hard-wired attack bias shows up live
    assert info["species"]["name"] is None  # one lone newcomer is too few to be named
    assert isinstance(info["doing"], str)


def test_intent_reads_the_brain():
    from primordial.world import intent

    zeros_in, zeros_out = np.zeros(11), np.zeros(4)
    assert intent(zeros_in, zeros_out, biting=True) == "Biting"
    hunting_out = zeros_out.copy()
    hunting_out[2] = 0.8
    near = zeros_in.copy()
    near[5] = 0.8
    assert intent(near, hunting_out, biting=False) == "Hunting"
    food = zeros_in.copy()
    food[1], food[2] = 0.9, 0.5
    assert intent(food, zeros_out, biting=False) == "Heading for food"
    still = zeros_out.copy()
    still[1] = -1.0
    assert intent(zeros_in, still, biting=False) == "Resting"
