import numpy as np
import pytest

from primordial import World, WorldConfig
from primordial.names import EPITHETS, distinction, epithet, make_rng
from primordial.species import ESTABLISHED, Speciation, genomes

D = 8


def root(sp: Speciation, n: int = 1):
    return sp.new_root(0, np.zeros((n, D), np.float32), "founder")


def test_children_inherit_species_until_they_drift_too_far():
    sp = Speciation(threshold=1.0, world_seed=0)
    species, refs = root(sp)
    close = np.full((1, D), 0.1, np.float32)  # distance ~0.28
    s2, r2 = sp.assign_children(1, species, refs, close)
    assert s2[0] == species[0] and r2[0] == refs[0]

    far = np.full((1, D), 1.0, np.float32)  # distance ~2.8
    s3, r3 = sp.assign_children(2, species, refs, far)
    assert s3[0] != species[0]
    new = sp.get(int(s3[0]))
    assert new.parent == species[0] and new.born == 2
    np.testing.assert_array_equal(sp.refs[int(r3[0])], far[0])


def test_drifting_relatives_join_a_sister_species_instead_of_founding_many():
    sp = Speciation(threshold=1.0, world_seed=0)
    species, refs = root(sp)
    a = np.full((1, D), 1.0, np.float32)
    b = np.full((1, D), 1.05, np.float32)  # far from the root, close to a
    c = -np.full((1, D), 1.0, np.float32)  # far from both
    s, _ = sp.assign_children(1, np.repeat(species, 3), np.repeat(refs, 3), np.concatenate([a, b, c]))
    assert s[0] == s[1]  # b joined a's new species
    assert s[2] not in (s[0], species[0])
    assert sp.next_species == 3


def test_genome_includes_traits():
    w = World(seed=0)
    g = genomes(w.pop)
    assert g.shape == (len(w.pop), w.pop["W1"][0].size + 8 + w.pop["W2"][0].size + 4 + 3)
    w.pop["diet"][0] += 0.5
    assert np.linalg.norm(genomes(w.pop, np.array([0]))[0] - g[0]) == pytest.approx(5.0, rel=1e-4)


def test_census_names_established_species_and_records_extinction():
    w = World(WorldConfig(initial_creatures=ESTABLISHED + 5, immigration=False), seed=1)
    founders = w.species.get(0)
    assert founders.established == 0 and founders.name and founders.color.startswith("#")
    assert any(e["kind"] == "origin" for e in w.events)

    small = w.invasion(800, 500, amount=ESTABLISHED - 5)
    assert small == ESTABLISHED - 5
    newcomers = w.species.get(1)
    w.tick += 10
    w._sample()
    assert newcomers.established is None and newcomers.count == ESTABLISHED - 5
    # unnamed species show up under their nearest named ancestor (none, for a root)
    assert w.species.display_ids(np.array([1]))[0] == -1

    w.meteor(800, 500, radius=5000)
    w.tick += 10
    w._sample()
    assert founders.extinct == w.tick and newcomers.extinct == w.tick
    assert not w.species.alive
    assert any("gone extinct" in e["text"] for e in w.events)


def test_unnamed_offshoots_display_as_their_named_ancestor():
    sp = Speciation(threshold=1.0, world_seed=0)
    species, refs = root(sp, n=1)
    sp.species[0].established = 0
    sp.version += 1
    child, _ = sp.assign_children(1, species, refs, np.full((1, D), 1.0, np.float32))
    assert sp.display_ids(np.array([0, int(child[0])])).tolist() == [0, 0]


def test_speciation_happens_in_a_real_run_and_is_reproducible():
    a, b = World(seed=7), World(seed=7)
    a.run(9000)
    b.run(9000)
    assert len(a.species.registry()) >= 2
    assert [s["name"] for s in a.species.registry()] == [s["name"] for s in b.species.registry()]
    tree = {s["id"]: s for s in a.species.registry()}
    for s in tree.values():
        assert s["ancestor"] == -1 or s["ancestor"] in tree


def test_names():
    rng = make_rng(0, 5)
    taken = {"Ara vorax"}
    word = epithet(rng, "predator", taken, "Ara")
    assert word in EPITHETS["predator"] and word != "vorax"
    every = {f"Ara {w}" for words in EPITHETS.values() for w in words}
    assert epithet(make_rng(0, 6), "predator", every, "Ara").endswith(" II")

    parent = {"strategy": "forager", "speed": 2.0, "size": 1.0}
    assert distinction({"strategy": "predator", "speed": 2.0, "size": 1.0}, parent) == "predator"
    assert distinction({"strategy": "forager", "speed": 3.0, "size": 1.0}, parent) == "faster"
    assert distinction({"strategy": "forager", "speed": 2.0, "size": 0.7}, parent) == "smaller"
    assert distinction({"strategy": "forager", "speed": 2.1, "size": 1.0}, parent) == "same"
    assert distinction(parent, None) == "founder"
