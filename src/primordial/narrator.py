"""A nature-documentary narrator.

Watches the statistics as they are sampled and writes up the moments worth
noticing: new species, extinctions, the first predators, booms and crashes,
arms races, one family taking over. Each note is plain text in which species
names are wrapped in *asterisks* so the browser can italicise them.

``headline`` notes are shown over the world view; ``note`` notes only go in
the log.
"""

from __future__ import annotations

from collections import deque
from dataclasses import asdict, dataclass, field

CRASH_WINDOW = 50  # samples (500 ticks at the default sample rate)
COOLDOWN = 3000  # ticks between two notes of the same kind


@dataclass
class Narrator:
    predators_seen: bool = False
    predator_peak: int = 0
    first_predator_tick: int | None = None
    speed_at_first_predator: float | None = None
    arms_race_level: float = 1.0
    dynasty_announced: bool = False
    single_ancestor_announced: bool = False
    generation_milestone: int = 0
    population_record: int = 0  # the last record we announced
    last_said: dict = field(default_factory=dict)
    recent_pop: deque = field(default_factory=lambda: deque(maxlen=CRASH_WINDOW))

    def _ready(self, kind: str, tick: int) -> bool:
        return tick - self.last_said.get(kind, -(10**9)) >= COOLDOWN

    def _say(self, notes: list, tick: int, kind: str, text: str, level: str = "headline") -> None:
        self.last_said[kind] = tick
        notes.append({"kind": kind, "level": level, "text": text})

    def observe(self, row: dict, species_events: list[dict], species_lookup, season: str) -> list[dict]:
        """Return the notes prompted by one statistics sample."""
        notes: list[dict] = []
        tick, pop, preds = row["tick"], row["population"], row["predators"]

        for ev in species_events:
            sp = ev["species"]
            if ev["kind"] == "established":
                notes.append(self._speciation_note(sp, species_lookup, tick))
            elif ev["kind"] == "extinct":
                lifespan = tick - sp.born
                text = (
                    f"*{sp.name}* has gone extinct after {lifespan:,} ticks. "
                    f"At its peak there were {sp.peak:,} of them."
                )
                notes.append(
                    {"kind": "extinct", "level": "headline" if sp.peak >= 150 else "note", "text": text}
                )

        # --- predators
        self.predator_peak = max(self.predator_peak, preds)
        if not self.predators_seen and preds >= 5:
            again = self.first_predator_tick is not None
            self.predators_seen = True
            if not again:
                self.first_predator_tick = tick
                self.speed_at_first_predator = row["mean_speed"]
            text = (
                f"Predators have evolved again: {preds} creatures now live mostly by eating others."
                if again
                else f"The first predators have evolved. {preds} creatures now get most of their "
                "energy by hunting other creatures."
            )
            self._say(notes, tick, "predators", text)
        elif self.predators_seen and preds == 0 and self.predator_peak >= 10:
            self.predators_seen = False
            self.predator_peak = 0
            self._say(
                notes,
                tick,
                "predators_gone",
                "The last predator has died. The plant-eaters are safe, for now.",
            )

        # --- arms race: prey speed up once predators exist
        s0 = self.speed_at_first_predator
        if s0 and preds >= 5 and row["mean_speed"] >= s0 * (self.arms_race_level + 0.25):
            self.arms_race_level += 0.25
            gain = round((row["mean_speed"] / s0 - 1) * 100)
            self._say(
                notes,
                tick,
                "arms_race",
                f"Arms race: creatures are now {gain}% faster than when the first predators appeared.",
            )

        # --- booms and crashes
        self.recent_pop.append(pop)
        high = max(self.recent_pop)
        if high >= 200 and pop < 0.55 * high and self._ready("crash", tick):
            cause = "A hard winter" if season == "winter" else "A population crash"
            self._say(notes, tick, "crash", f"{cause}: numbers have fallen from {high:,} to {pop:,}.")
            self.recent_pop.clear()
        if pop >= 500 and pop > 1.25 * max(self.population_record, 400) and self._ready("boom", tick):
            self._say(notes, tick, "boom", f"Population boom: a record {pop:,} creatures are alive.")
            self.population_record = pop

        # --- dynasties
        if not self.dynasty_announced and pop >= 50 and row["top_lineage_share"] >= 0.9 and tick > 0:
            self.dynasty_announced = True
            self._say(
                notes,
                tick,
                "dynasty",
                "One family now makes up over 90% of all life. Every other line is close to dying out.",
            )
        if not self.single_ancestor_announced and row["lineages"] == 1 and tick > 0:
            self.single_ancestor_announced = True
            self._say(
                notes, tick, "single_ancestor", "Every creature alive now descends from a single ancestor."
            )

        # --- generations
        milestone = row["max_generation"] // 100 * 100
        if milestone > self.generation_milestone:
            self.generation_milestone = milestone
            self._say(notes, tick, "generation", f"The {milestone}th generation has been born.", level="note")
        return notes

    def _speciation_note(self, sp, lookup, tick: int) -> dict:
        if sp.root_kind == "founder":
            return {
                "kind": "origin",
                "level": "headline",
                "text": f"Life begins: {sp.count} creatures of *{sp.name}*, plant-eaters with random brains.",
            }
        if sp.root_kind == "newcomer":
            return {"kind": "newcomers", "level": "note", "text": f"Newcomers settle in: *{sp.name}*."}
        parent = lookup(sp.parent)
        how = _difference(sp.traits, parent.traits if parent else None)
        origin = f", branching off from *{parent.name}*" if parent else ""
        # A change of diet is big news; a species that is merely faster or bigger goes in the log.
        changed_diet = parent is not None and sp.traits["strategy"] != parent.traits["strategy"]
        return {
            "kind": "speciation",
            "level": "headline" if changed_diet else "note",
            "text": f"A new species: *{sp.name}*{origin}. {how}",
        }

    # ---------------------------------------------------------------- persistence
    def state(self) -> dict:
        d = asdict(self)
        d["recent_pop"] = list(self.recent_pop)
        return d

    @classmethod
    def from_state(cls, d: dict) -> Narrator:
        d = dict(d)
        recent = d.pop("recent_pop", [])
        n = cls(**d)
        n.recent_pop.extend(recent)
        return n


def _difference(traits: dict, parent: dict | None) -> str:
    if parent is None:
        return ""
    if traits["strategy"] != parent["strategy"]:
        return {
            "predator": "It hunts other creatures.",
            "omnivore": "It eats both plants and other creatures.",
            "forager": "It has gone back to eating plants.",
        }[traits["strategy"]]
    bits = []
    for key, more, less in (("speed", "faster", "slower"), ("size", "bigger", "smaller")):
        change = traits[key] / max(parent[key], 1e-9) - 1
        if abs(change) >= 0.1:
            bits.append(f"{round(abs(change) * 100)}% {more if change > 0 else less}")
    if not bits:
        return "It looks much the same, but its brain is wired differently."
    return "It is " + " and ".join(bits) + "."
