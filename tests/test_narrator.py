from primordial.narrator import COOLDOWN, Narrator

BASE = dict(
    tick=0, population=300, predators=0, mean_speed=2.0, top_lineage_share=0.3, lineages=40, max_generation=1
)


def row(**kw):
    return {**BASE, **kw}


def kinds(notes):
    return [n["kind"] for n in notes]


def test_first_predators_and_arms_race():
    n = Narrator()
    assert n.observe(row(tick=10, predators=4), [], None, "summer") == []
    notes = n.observe(row(tick=20, predators=6), [], None, "summer")
    assert kinds(notes) == ["predators"] and "first predators" in notes[0]["text"]
    assert n.observe(row(tick=30, predators=9), [], None, "summer") == []  # said once

    notes = n.observe(row(tick=40, predators=9, mean_speed=2.6), [], None, "summer")
    assert kinds(notes) == ["arms_race"] and "30% faster" in notes[0]["text"]


def test_predators_dying_out_and_coming_back():
    n = Narrator()
    n.observe(row(tick=10, predators=12), [], None, "summer")
    assert kinds(n.observe(row(tick=20, predators=0), [], None, "summer")) == ["predators_gone"]
    notes = n.observe(row(tick=30, predators=7), [], None, "summer")
    assert "evolved again" in notes[0]["text"]


def test_crash_mentions_winter_and_has_a_cooldown():
    n = Narrator()
    n.observe(row(tick=10, population=800), [], None, "autumn")
    notes = n.observe(row(tick=20, population=300), [], None, "winter")
    assert kinds(notes) == ["crash"] and notes[0]["text"].startswith("A hard winter")
    n.observe(row(tick=30, population=800), [], None, "spring")
    assert n.observe(row(tick=40, population=300), [], None, "winter") == []
    n.observe(row(tick=40 + COOLDOWN, population=800), [], None, "spring")
    assert kinds(n.observe(row(tick=50 + COOLDOWN, population=300), [], None, "winter")) == ["crash"]


def test_dynasty_and_generations():
    n = Narrator()
    notes = n.observe(
        row(tick=10, top_lineage_share=0.95, lineages=3, max_generation=104), [], None, "summer"
    )
    assert kinds(notes) == ["dynasty", "generation"]
    assert notes[1]["level"] == "note" and "100th" in notes[1]["text"]
    assert kinds(n.observe(row(tick=20, top_lineage_share=1.0, lineages=1), [], None, "summer")) == [
        "single_ancestor"
    ]


def test_state_round_trip():
    n = Narrator()
    for t in range(0, 300, 10):
        n.observe(row(tick=t, population=500 + t, predators=t // 20), [], None, "summer")
    copy = Narrator.from_state(n.state())
    assert copy.state() == n.state()
    assert copy.recent_pop.maxlen == n.recent_pop.maxlen


def test_new_species_whose_parent_was_never_named():
    # Regression: an established species descended only from unnamed offshoots
    # (lookup returns None) used to crash the narrator.
    from primordial.species import Species

    sp = Species(
        id=5,
        parent=3,
        born=100,
        ref=1,
        name="Ara novus",
        count=25,
        peak=25,
        traits={"size": 1.0, "speed": 2.0, "diet": 0.1, "strategy": "forager"},
    )
    notes = Narrator().observe(
        row(tick=200), [{"kind": "established", "species": sp}], lambda _: None, "summer"
    )
    assert notes[0]["kind"] == "speciation" and "*Ara novus*" in notes[0]["text"]
