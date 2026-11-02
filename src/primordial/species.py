"""Speciation: splitting the family tree into species as genomes drift apart.

Creatures reproduce asexually, so "can they interbreed?" can't define a
species. Instead every creature carries a pointer to a *reference genome*:
the genome of the founder of its line. When a newborn's genome is more than
``threshold`` away from its reference, it has drifted far enough to found a
new species, unless it is close to a sister species that already split off
from the same parent, in which case it joins that one. This is the
compatibility-distance idea from NEAT, applied to a population that breeds
continuously instead of in generations.

A genome here is a creature's brain weights plus its body traits, with the
traits weighted so that a change of diet counts for a lot.

Most new species are tiny offshoots that die out quickly. A species only
becomes *established* (named, shown in the tree of life, narrated) once it
reaches ``ESTABLISHED`` living members.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from . import analytics, names

ESTABLISHED = 20
# Named species get colours from a categorical palette, in order of appearance,
# so neighbouring species are easy to tell apart on screen.
PALETTE = (
    "#3b78a8",
    "#d08c2c",
    "#5c9e5a",
    "#8e5aa8",
    "#2a9d9a",
    "#c75d8f",
    "#7d8a2e",
    "#b5643c",
    "#4f5fb8",
    "#3f8f73",
    "#a45252",
    "#9a7b4f",
)
W_SIZE, W_SPEED, W_DIET = 4.0, 4.0, 10.0


def genomes(pop, idx: np.ndarray | None = None) -> np.ndarray:
    """Flatten brains and traits of the selected creatures into (m, D) vectors."""
    sel = (lambda a: a) if idx is None else (lambda a: a[idx])
    w1, b1, w2, b2 = sel(pop["W1"]), sel(pop["b1"]), sel(pop["W2"]), sel(pop["b2"])
    m = w1.shape[0]
    traits = np.column_stack(
        [
            W_SIZE * np.log(sel(pop["size"])),
            W_SPEED * np.log(sel(pop["speed"])),
            W_DIET * sel(pop["diet"]),
        ]
    )
    return np.concatenate(
        [w1.reshape(m, -1), b1, w2.reshape(m, -1), b2, traits.astype(np.float32)], axis=1
    ).astype(np.float32)


@dataclass
class Species:
    id: int
    parent: int  # -1 for a root (the first life, or a group of newcomers)
    born: int
    ref: int  # reference genome shared by its members (roots: unused)
    root_kind: str | None = None  # "founder" or "newcomer" for roots
    extinct: int | None = None
    established: int | None = None
    name: str | None = None
    genus: str | None = None
    color: str | None = None
    traits: dict | None = None  # mean traits when it became established
    count: int = 0
    peak: int = 0

    def public(self) -> dict:
        d = asdict(self)
        d.pop("ref")
        return d


class Speciation:
    def __init__(self, threshold: float, world_seed: int):
        self.threshold = threshold
        self.world_seed = world_seed
        self.species: dict[int, Species] = {}
        self.refs: dict[int, np.ndarray] = {}
        self.daughters: dict[int, list[int]] = {}
        self.alive: set[int] = set()
        self.next_species = 0
        self.next_ref = 0
        self.version = 0  # bumps whenever names or the tree change
        self._display = np.zeros(0, np.int32)
        self._display_version = -1

    # ---------------------------------------------------------------- births
    def _new_species(self, tick: int, parent: int, ref: int, root_kind: str | None = None) -> int:
        sid = self.next_species
        self.next_species += 1
        self.species[sid] = Species(sid, parent, tick, ref, root_kind)
        self.alive.add(sid)
        if parent >= 0:
            self.daughters.setdefault(parent, []).append(sid)
        return sid

    def _new_refs(self, g: np.ndarray) -> np.ndarray:
        ids = np.arange(self.next_ref, self.next_ref + g.shape[0], dtype=np.int64)
        self.next_ref += g.shape[0]
        for rid, row in zip(ids, g, strict=True):
            self.refs[int(rid)] = row.copy()
        return ids

    def new_root(self, tick: int, g: np.ndarray, kind: str) -> tuple[np.ndarray, np.ndarray]:
        """A group of brand-new random creatures: one new species, one reference each."""
        refs = self._new_refs(g)
        sid = self._new_species(tick, -1, -1, root_kind=kind)
        return np.full(g.shape[0], sid, np.int32), refs

    def assign_children(
        self, tick: int, parent_species: np.ndarray, parent_refs: np.ndarray, g: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray]:
        """Species and reference for each newborn (inherit, join a sister, or found one)."""
        species = parent_species.astype(np.int32).copy()
        refs = parent_refs.astype(np.int64).copy()
        ref_g = np.stack([self.refs[int(r)] for r in parent_refs])
        drift = np.linalg.norm(g - ref_g, axis=1)
        for i in np.flatnonzero(drift > self.threshold):
            parent = int(parent_species[i])
            sisters = [s for s in self.daughters.get(parent, ()) if s in self.alive]
            if sisters:
                sister_g = np.stack([self.refs[self.species[s].ref] for s in sisters])
                d = np.linalg.norm(sister_g - g[i], axis=1)
                j = int(np.argmin(d))
                if d[j] <= self.threshold:
                    species[i] = sisters[j]
                    refs[i] = self.species[sisters[j]].ref
                    continue
            ref = int(self._new_refs(g[i : i + 1])[0])
            species[i] = self._new_species(tick, parent, ref)
            refs[i] = ref
        return species, refs

    # ---------------------------------------------------------------- census
    def census(self, tick: int, pop) -> tuple[list[dict], dict[str, int]]:
        """Update counts, extinctions and establishments.

        Returns events for the narrator, and population per *displayed*
        species (every creature counted under its nearest established
        ancestor), which is what the tree of life draws.
        """
        events: list[dict] = []
        ids, counts = np.unique(pop["species"], return_counts=True)
        live = dict(zip(ids.tolist(), counts.tolist(), strict=True))

        for sid in sorted(self.alive):
            sp = self.species[sid]
            sp.count = live.get(sid, 0)
            sp.peak = max(sp.peak, sp.count)
            if sp.count == 0:
                sp.extinct = tick
                self.alive.discard(sid)
                if sp.established is not None:
                    self.version += 1
                    events.append({"kind": "extinct", "species": sp})
            elif sp.established is None and sp.count >= ESTABLISHED:
                self._establish(sp, tick, pop)
                events.append({"kind": "established", "species": sp})

        # forget reference genomes nobody points at any more
        live_refs = set(np.unique(pop["ref"]).tolist())
        live_refs.update(self.species[s].ref for s in self.alive)
        for rid in [r for r in self.refs if r not in live_refs]:
            del self.refs[rid]

        display = self.display_ids(pop["species"])
        d_ids, d_counts = np.unique(display[display >= 0], return_counts=True)
        return events, {str(k): int(v) for k, v in zip(d_ids.tolist(), d_counts.tolist(), strict=True)}

    def _establish(self, sp: Species, tick: int, pop) -> None:
        members = pop["species"] == sp.id
        diet = float(pop["diet"][members].mean())
        sp.traits = {
            "size": round(float(pop["size"][members].mean()), 3),
            "speed": round(float(pop["speed"][members].mean()), 3),
            "diet": round(diet, 3),
            "strategy": analytics.STRATEGIES[int(analytics.classify(np.array([diet]))[0])],
        }
        n_named = sum(1 for other in self.species.values() if other.established is not None)
        sp.color = PALETTE[n_named % len(PALETTE)]

        ancestor = self.established_ancestor(sp.parent)
        parent_traits = self.species[ancestor].traits if ancestor >= 0 else None
        rng = names.make_rng(self.world_seed, sp.id)
        kind = sp.root_kind or names.distinction(sp.traits, parent_traits)
        same_diet = ancestor >= 0 and sp.traits["strategy"] == parent_traits["strategy"]
        if same_diet and rng.random() < 0.6:
            sp.genus = self.species[ancestor].genus  # close relatives usually share a genus
        else:
            sp.genus = names.genus(rng)
        taken = {s.name for s in self.species.values() if s.name}
        sp.name = f"{sp.genus} {names.epithet(rng, kind, taken, sp.genus)}"
        sp.established = tick
        self.version += 1

    # ---------------------------------------------------------------- queries
    def established_ancestor(self, sid: int) -> int:
        while sid >= 0 and self.species[sid].established is None:
            sid = self.species[sid].parent
        return sid

    def display_ids(self, species: np.ndarray) -> np.ndarray:
        """Map each species id to its nearest established ancestor (-1 if none)."""
        if self._display_version != self.version or self._display.size < self.next_species:
            table = np.full(self.next_species, -1, np.int32)
            for sid in range(self.next_species):  # parents always have smaller ids
                sp = self.species[sid]
                if sp.established is not None:
                    table[sid] = sid
                elif sp.parent >= 0:
                    table[sid] = table[sp.parent]
            self._display, self._display_version = table, self.version
        return self._display[species] if species.size else np.zeros(0, np.int32)

    def registry(self) -> list[dict]:
        """Every established species, for the tree of life.

        ``ancestor`` is the nearest *named* ancestor, since a species' direct
        parent may have been a short-lived offshoot that never got a name.
        """
        out = []
        for sp in self.species.values():
            if sp.established is not None:
                d = sp.public()
                d["ancestor"] = self.established_ancestor(sp.parent)
                out.append(d)
        return out

    def get(self, sid: int) -> Species | None:
        return self.species.get(sid)

    # ---------------------------------------------------------------- persistence
    def state(self) -> tuple[dict, np.ndarray, np.ndarray]:
        meta = {
            "threshold": self.threshold,
            "world_seed": self.world_seed,
            "next_species": self.next_species,
            "next_ref": self.next_ref,
            "version": self.version,
            "species": [asdict(s) for s in self.species.values()],
        }
        ids = np.array(sorted(self.refs), dtype=np.int64)
        g = np.stack([self.refs[int(i)] for i in ids]) if ids.size else np.zeros((0, 0), np.float32)
        return meta, ids, g

    @classmethod
    def from_state(cls, meta: dict, ref_ids: np.ndarray, ref_g: np.ndarray) -> Speciation:
        sp = cls(float(meta["threshold"]), int(meta["world_seed"]))
        sp.next_species = int(meta["next_species"])
        sp.next_ref = int(meta["next_ref"])
        sp.version = int(meta["version"])
        for d in meta["species"]:
            s = Species(**d)
            sp.species[s.id] = s
            if s.extinct is None:
                sp.alive.add(s.id)
            if s.parent >= 0:
                sp.daughters.setdefault(s.parent, []).append(s.id)
        if len(sp.species) != sp.next_species:
            raise ValueError("species registry is incomplete")
        sp.refs = {int(i): row.astype(np.float32) for i, row in zip(ref_ids, ref_g, strict=True)}
        return sp
