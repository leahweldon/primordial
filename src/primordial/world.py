"""The simulated world: a toroidal plane of plants and creatures.

One call to :meth:`World.step` advances everything by a tick:

    sense -> think -> eat -> fight -> pay metabolism -> move
          -> reproduce (and maybe speciate) -> die -> grow plants (by season)

Every phase is vectorised over the whole population. Neighbour lookups use
periodic KD-trees, so the cost per tick is O(N log N) instead of O(N^2).
All randomness comes from one seeded generator, so (config, seed) fully
determines a run.
"""

from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

from . import analytics
from .brain import INPUTS, N_IN, N_OUT, OUTPUTS, mutate, random_brains, think
from .config import WorldConfig
from .narrator import Narrator
from .population import Population
from .species import Speciation, genomes

BODY_RADIUS = 5.0  # px per unit of size
PLANT_RADIUS = 3.0
MAX_TURN = 0.3  # radians per tick at full turn output
CLOCK_FREQ = 0.15  # radians per tick for the internal oscillator
SEASONS = ("spring", "summer", "autumn", "winter")


class World:
    def __init__(self, config: WorldConfig | None = None, seed: int = 0):
        self.cfg = config or WorldConfig()
        self.seed = seed
        self.rng = np.random.default_rng(seed)
        self.tick = 0
        self.next_id = 0
        self.box = np.array([self.cfg.width, self.cfg.height])
        self.counters = dict.fromkeys(
            ("births", "deaths", "kills", "starved", "old_age", "meals", "immigrants"), 0
        )
        self.history = analytics.History()
        self.events: list[dict] = []  # narrated happenings, for the UI
        self.event_seq = 0
        self.species = Speciation(self.cfg.species_threshold, seed)
        self.narrator = Narrator()

        self.zones, self.zone_vel = self._make_zones()
        self.plants = np.zeros((0, 2))
        self._spawn_plants(self.cfg.initial_plants)
        self.pop = Population.empty(self.cfg.hidden_size)
        self.pop.extend(self._random_creatures(self.cfg.initial_creatures, kind="founder"))
        self._sample()

    # ------------------------------------------------------------------ geometry
    def _wrap(self, pos: np.ndarray) -> np.ndarray:
        pos = np.mod(pos, self.box)
        pos[pos >= self.box] = 0.0  # np.mod(-1e-17, w) can round up to w
        return pos

    def _delta(self, a: np.ndarray, b: np.ndarray) -> np.ndarray:
        """Shortest vector from a to b on the torus."""
        d = b - a
        return d - self.box * np.round(d / self.box)

    # ------------------------------------------------------------------ spawning
    def _make_zones(self) -> tuple[np.ndarray, np.ndarray]:
        n = self.cfg.fertile_zones
        centres = self.rng.random((n, 2)) * self.box
        sigma = self.rng.uniform(0.06, 0.12, n) * min(self.cfg.width, self.cfg.height)
        angle = self.rng.uniform(-np.pi, np.pi, n)
        velocity = np.column_stack([np.cos(angle), np.sin(angle)])
        return np.column_stack([centres, sigma]), velocity

    def _drift_zones(self) -> None:
        """Oases wander slowly, so the best grazing moves around over time."""
        if not len(self.zones) or self.cfg.zone_drift <= 0:
            return
        turn = self.rng.normal(0.0, 0.02, len(self.zones))
        c, s = np.cos(turn), np.sin(turn)
        vx, vy = self.zone_vel[:, 0].copy(), self.zone_vel[:, 1].copy()
        self.zone_vel = np.column_stack([c * vx - s * vy, s * vx + c * vy])
        self.zones[:, :2] = self._wrap(self.zones[:, :2] + self.zone_vel * self.cfg.zone_drift)

    # ------------------------------------------------------------------ seasons
    def season_phase(self) -> float:
        """0..1 through the year; plant growth peaks at 0.25 (midsummer)."""
        return (self.tick % (4 * self.cfg.season_length)) / (4 * self.cfg.season_length)

    @property
    def season(self) -> str:
        # spring is centred on phase 0, summer on 0.25, autumn on 0.5, winter on 0.75
        return SEASONS[int((self.season_phase() + 0.125) * 4) % 4]

    def plant_growth_now(self) -> float:
        swing = np.sin(2 * np.pi * self.season_phase())
        return max(0.0, self.cfg.plant_growth * (1.0 + self.cfg.season_strength * swing))

    def _spawn_plants(self, n: int, around: tuple[float, float, float] | None = None) -> int:
        n = min(n, self.cfg.max_plants - self.plants.shape[0])
        if n <= 0:
            return 0
        if around is not None:
            x, y, r = around
            new = np.array([x, y]) + self.rng.normal(0.0, r / 2, (n, 2))
        else:
            n_fertile = self.rng.binomial(n, self.cfg.fertile_fraction) if len(self.zones) else 0
            zone = self.zones[self.rng.integers(0, max(len(self.zones), 1), n_fertile)]
            fertile = zone[:, :2] + self.rng.normal(0.0, 1.0, (n_fertile, 2)) * zone[:, 2:3]
            wild = self.rng.random((n - n_fertile, 2)) * self.box
            new = np.concatenate([fertile, wild])
        self.plants = np.concatenate([self.plants, self._wrap(new)])
        return n

    def _new_ids(self, m: int) -> np.ndarray:
        ids = np.arange(self.next_id, self.next_id + m, dtype=np.int64)
        self.next_id += m
        return ids

    def _blank(self, m: int) -> dict[str, np.ndarray]:
        h = self.cfg.hidden_size
        return {
            "kills": np.zeros(m, np.int32),
            "children": np.zeros(m, np.int32),
            "eaten": np.zeros(m, np.int32),
            "attacking": np.zeros(m, bool),
            "thrust": np.zeros(m),
            "last_meal": np.full(m, -(10**9), np.int64),
            "act_in": np.zeros((m, N_IN), np.float32),
            "act_h": np.zeros((m, h), np.float32),
            "act_out": np.zeros((m, N_OUT), np.float32),
        }

    def _random_creatures(
        self, m: int, centre=None, spread: float = 0.0, kind: str = "newcomer"
    ) -> Population:
        rng, cfg = self.rng, self.cfg
        ids = self._new_ids(m)
        if centre is None:
            pos = rng.random((m, 2)) * self.box
        else:
            pos = np.asarray(centre) + rng.normal(0.0, spread, (m, 2))
        a = {
            "id": ids,
            "parent": np.full(m, -1, np.int64),
            "lineage": ids.copy(),
            "generation": np.zeros(m, np.int32),
            "born": np.full(m, self.tick, np.int64),
            "pos": self._wrap(pos),
            "heading": rng.uniform(-np.pi, np.pi, m),
            "energy": np.full(m, cfg.start_energy),
            "age": np.zeros(m, np.int32),
            "size": rng.uniform(0.8, 1.3, m),
            "speed": rng.uniform(1.5, 3.0, m),
            # Life starts as plant-eaters. Predators have to evolve.
            "diet": rng.uniform(0.0, 0.3, m),
            "color": rng.uniform(0.25, 1.0, (m, 3)),
            **self._blank(m),
        }
        a.update(random_brains(rng, m, cfg.hidden_size))
        if m:
            a["species"], a["ref"] = self.species.new_root(self.tick, genomes(a), kind)
        else:
            a["species"], a["ref"] = np.zeros(0, np.int32), np.zeros(0, np.int64)
        return Population(a)

    def _offspring(self, parents: np.ndarray, energy: np.ndarray) -> Population:
        rng, cfg, p = self.rng, self.cfg, self.pop
        m = parents.size
        tm = cfg.trait_mutation
        angle = rng.uniform(-np.pi, np.pi, m)
        dist = 2.5 * BODY_RADIUS * p["size"][parents]
        offset = np.column_stack([np.cos(angle), np.sin(angle)]) * dist[:, None]
        a = {
            "id": self._new_ids(m),
            "parent": p["id"][parents],
            "lineage": p["lineage"][parents],
            "generation": p["generation"][parents] + 1,
            "born": np.full(m, self.tick, np.int64),
            "pos": self._wrap(p["pos"][parents] + offset),
            "heading": angle,
            "energy": energy,
            "age": np.zeros(m, np.int32),
            "size": np.clip(p["size"][parents] * np.exp(rng.normal(0, tm, m)), 0.5, 3.0),
            "speed": np.clip(p["speed"][parents] * np.exp(rng.normal(0, tm, m)), 0.3, 8.0),
            "diet": np.clip(p["diet"][parents] + rng.normal(0, tm, m), 0.0, 1.0),
            "color": np.clip(p["color"][parents] + rng.normal(0, 0.035, (m, 3)), 0.0, 1.0),
            **self._blank(m),
        }
        parent_brains = {k: v[parents] for k, v in p.brains().items()}
        a.update(mutate(parent_brains, rng, cfg.mutation_rate, cfg.mutation_scale))
        a["species"], a["ref"] = self.species.assign_children(
            self.tick, p["species"][parents], p["ref"][parents], genomes(a)
        )
        return Population(a)

    # ------------------------------------------------------------------ sensing
    def sense(self) -> tuple[np.ndarray, dict]:
        """Build the (N, N_IN) input matrix plus the contacts used by actions."""
        cfg, p = self.cfg, self.pop
        n = len(p)
        pos, heading, size = p["pos"], p["heading"], p["size"]
        x = np.zeros((n, N_IN))

        # nearest other creature (k=2 because the nearest point is yourself)
        # Trees are rebuilt every tick, so a faster build beats a tighter tree
        # (measured: ~20% quicker per tick at 2,000 creatures).
        tree = cKDTree(pos, boxsize=self.box, balanced_tree=False, compact_nodes=False)
        d, idx = tree.query(pos, k=2, distance_upper_bound=cfg.vision)
        first_is_self = idx[:, 0] == np.arange(n)
        nb = np.where(first_is_self, idx[:, 1], idx[:, 0])
        nd = np.where(first_is_self, d[:, 1], d[:, 0])
        has_nb = nb < n

        # nearest plant
        n_plants = self.plants.shape[0]
        if n_plants:
            pd, pidx = cKDTree(self.plants, boxsize=self.box, balanced_tree=False, compact_nodes=False).query(
                pos, k=1, distance_upper_bound=cfg.vision
            )
            has_food = pidx < n_plants
        else:
            pd, pidx = np.full(n, np.inf), np.zeros(n, np.intp)
            has_food = np.zeros(n, bool)

        if has_food.any():
            f = has_food
            v = self._delta(pos[f], self.plants[pidx[f]])
            ang = np.arctan2(v[:, 1], v[:, 0]) - heading[f]
            x[f, 0], x[f, 1] = np.sin(ang), np.cos(ang)
            x[f, 2] = 1.0 - pd[f] / cfg.vision

        if has_nb.any():
            h, j = has_nb, nb[has_nb]
            v = self._delta(pos[h], pos[j])
            ang = np.arctan2(v[:, 1], v[:, 0]) - heading[h]
            x[h, 3], x[h, 4] = np.sin(ang), np.cos(ang)
            x[h, 5] = 1.0 - nd[h] / cfg.vision
            x[h, 6] = (size[j] - size[h]) / (size[j] + size[h])
            x[h, 7] = p["diet"][j] - p["diet"][h]
            x[h, 8] = 1.0 - np.linalg.norm(p["color"][j] - p["color"][h], axis=1) / np.sqrt(3)

        threshold = cfg.reproduce_threshold * size**2
        x[:, 9] = np.clip(p["energy"] / threshold, 0.0, 2.0)
        x[:, 10] = np.sin(p["age"] * CLOCK_FREQ)

        contacts = dict(nb=nb, nd=nd, has_nb=has_nb, pd=pd, pidx=pidx, has_food=has_food)
        return x, contacts

    # ------------------------------------------------------------------ the tick
    def step(self) -> None:
        cfg, rng = self.cfg, self.rng
        if len(self.pop):
            self._step_creatures()
        self._spawn_plants(int(rng.poisson(self.plant_growth_now())))
        self._drift_zones()
        if cfg.immigration and len(self.pop) < cfg.min_creatures:
            m = cfg.min_creatures - len(self.pop)
            self.pop.extend(self._random_creatures(m))
            self.counters["immigrants"] += m
        self.tick += 1
        if self.tick % cfg.stats_every == 0:
            self._sample()

    def _sample(self) -> None:
        """Record statistics, update the species census, and let the narrator speak."""
        row = analytics.sample(self)
        species_events, by_species = self.species.census(self.tick, self.pop)
        row["season"] = self.season
        row["species_alive"] = sum(
            1 for s in self.species.alive if self.species.species[s].established is not None
        )
        row["species"] = by_species
        self.history.add(row)

        def named_ancestor(sid: int):
            return self.species.get(self.species.established_ancestor(sid))

        for note in self.narrator.observe(row, species_events, named_ancestor, self.season):
            self._log(note.pop("kind"), **note)

    def _step_creatures(self) -> None:
        cfg, p = self.cfg, self.pop
        n = len(p)
        size, diet = p["size"], p["diet"]
        radius = BODY_RADIUS * size

        x, c = self.sense()
        out32, hidden = think(p.brains(), x, return_hidden=True)
        p["act_in"], p["act_h"], p["act_out"] = x.astype(np.float32), hidden, out32
        out = out32.astype(np.float64)
        turn = out[:, 0]
        thrust = (out[:, 1] + 1.0) / 2.0
        wants_attack = out[:, 2] > 0.0
        wants_child = out[:, 3] > 0.0
        energy = p["energy"].copy()

        # --- eat: each plant in reach goes to the first creature that claims it
        can_eat = c["has_food"] & (c["pd"] < radius + PLANT_RADIUS)
        eaters = np.flatnonzero(can_eat)
        if eaters.size:
            eaten_plants, first = np.unique(c["pidx"][eaters], return_index=True)
            winners = eaters[first]
            energy[winners] += cfg.plant_energy * cfg.plant_efficiency * (1.0 - diet[winners])
            p["eaten"][winners] += 1
            p["last_meal"][winners] = self.tick
            self.counters["meals"] += winners.size
            self.plants = np.delete(self.plants, eaten_plants, axis=0)

        # --- fight: bite the nearest creature if it's touching you
        nb, has_nb = c["nb"], c["has_nb"]
        nb_safe = np.where(has_nb, nb, 0)
        in_reach = has_nb & (c["nd"] < radius + BODY_RADIUS * size[nb_safe] + 2.0)
        biting = wants_attack & in_reach
        attackers = np.flatnonzero(biting)
        killed = np.zeros(n, bool)
        if attackers.size:
            victims = nb[attackers]
            sa, sv = size[attackers], size[victims]
            damage = cfg.attack_damage * 2.0 * sa / (sa + sv)
            total = np.zeros(n)
            np.add.at(total, victims, damage)
            # A victim can't lose more energy than it has; split it pro rata.
            scale = np.where(total > 0, np.minimum(1.0, np.maximum(energy, 0) / np.maximum(total, 1e-9)), 0.0)
            stolen = damage * scale[victims]
            energy -= total * scale
            energy[attackers] += stolen * cfg.meat_efficiency * diet[attackers]
            killed = (total > 0) & (energy <= 0)
            # Killers also eat the body, shared by how much damage each did.
            share = damage / np.maximum(total[victims], 1e-12)  # safe when bite strength is 0
            body = cfg.body_energy * sv**2 * share * killed[victims]
            energy[attackers] += body * cfg.meat_efficiency * diet[attackers]
            credited = attackers[killed[victims]]
            p["last_meal"][credited] = self.tick
            np.add.at(p["kills"], credited, 1)
            self.counters["kills"] += int(killed.sum())

        # --- metabolism: bigger and faster bodies burn more
        velocity = thrust * p["speed"]
        energy -= (
            cfg.basal_cost * size**2 + cfg.move_cost * size * velocity**2 + cfg.attack_cost * wants_attack
        )

        # --- move
        heading = p["heading"] + turn * MAX_TURN
        heading = (heading + np.pi) % (2 * np.pi) - np.pi
        step = np.column_stack([np.cos(heading), np.sin(heading)]) * velocity[:, None]
        p["pos"] = self._wrap(p["pos"] + step)
        p["heading"] = heading
        p["thrust"] = thrust
        p["attacking"] = biting
        p["age"] += 1

        threshold = cfg.reproduce_threshold * size**2
        np.minimum(energy, 2.5 * threshold, out=energy)
        p["energy"] = energy

        # --- reproduce (asexual, with mutation)
        alive = (energy > 0) & (p["age"] <= cfg.max_age)
        can_breed = wants_child & alive & (energy > threshold) & (p["age"] > cfg.maturity_age)
        room = max(cfg.max_creatures - int(alive.sum()), 0)
        parents = np.flatnonzero(can_breed)
        if parents.size > room:
            parents = self.rng.permutation(parents)[:room]
            parents.sort()
        children = None
        if parents.size:
            # The parent pays for the child's starting energy *and* its body.
            # Body energy is what a predator later recovers from a kill, so
            # energy only ever enters the world through plants.
            child_energy = energy[parents] * cfg.offspring_share
            children = self._offspring(parents, child_energy)
            body = cfg.body_energy * children["size"] ** 2
            energy[parents] -= child_energy + body + cfg.reproduce_cost
            p["children"][parents] += 1
            self.counters["births"] += parents.size
            alive = (energy > 0) & (p["age"] <= cfg.max_age)

        # --- die
        dead = ~alive
        if dead.any():
            self.counters["deaths"] += int(dead.sum())
            self.counters["starved"] += int((dead & (energy <= 0) & ~killed).sum())
            self.counters["old_age"] += int((dead & (energy > 0)).sum())
            self.pop = self.pop.select(alive)
        if children is not None:
            self.pop.extend(children)

    def run(self, ticks: int) -> None:
        for _ in range(ticks):
            self.step()

    # ------------------------------------------------------------------ events
    def meteor(self, x: float, y: float, radius: float = 120.0) -> int:
        """Wipe out every creature and plant inside the blast radius."""
        centre = np.array([x, y])
        hit = np.linalg.norm(self._delta(centre, self.pop["pos"]), axis=1) < radius
        burnt = np.linalg.norm(self._delta(centre, self.plants), axis=1) < radius
        self.plants = self.plants[~burnt]
        killed = int(hit.sum())
        if killed:
            self.pop = self.pop.select(~hit)
            self.counters["deaths"] += killed
        noun = "creature" if killed == 1 else "creatures"
        self._log("meteor", text=f"A meteor strikes! {killed} {noun} wiped out.", x=x, y=y, radius=radius)
        return killed

    def bloom(self, x: float, y: float, radius: float = 150.0, amount: int = 300) -> int:
        """Drop a burst of plants around a point."""
        grown = self._spawn_plants(amount, around=(x, y, radius))
        self._log("bloom", text=f"A food bloom: {grown} new plants spring up.", level="note", x=x, y=y)
        return grown

    def invasion(self, x: float, y: float, amount: int = 30) -> int:
        """Introduce a band of fresh random creatures (new lineages)."""
        amount = max(0, min(amount, self.cfg.max_creatures - len(self.pop)))
        if amount > 0:
            self.pop.extend(self._random_creatures(amount, centre=(x, y), spread=40.0))
        self._log("invasion", text=f"{amount} newcomers with random brains arrive.", level="note", x=x, y=y)
        return amount

    def _log(self, kind: str, text: str, level: str = "headline", **info) -> None:
        self.event_seq += 1
        self.events.append(
            {"seq": self.event_seq, "tick": self.tick, "kind": kind, "level": level, "text": text, **info}
        )
        self.events = self.events[-200:]

    # ------------------------------------------------------------------ inspection
    def describe(self, creature_id: int) -> dict | None:
        """Everything about one creature, including its brain weights."""
        hits = np.flatnonzero(self.pop["id"] == creature_id)
        if hits.size == 0:
            return None
        i = int(hits[0])
        p = self.pop
        return {
            "id": int(p["id"][i]),
            "parent": int(p["parent"][i]),
            "lineage": int(p["lineage"][i]),
            "generation": int(p["generation"][i]),
            "age": int(p["age"][i]),
            "energy": round(float(p["energy"][i]), 1),
            "size": round(float(p["size"][i]), 3),
            "speed": round(float(p["speed"][i]), 3),
            "diet": round(float(p["diet"][i]), 3),
            "strategy": ("forager", "omnivore", "predator")[int(analytics.classify(p["diet"][i : i + 1])[0])],
            "color": [round(float(v), 3) for v in p["color"][i]],
            "kills": int(p["kills"][i]),
            "children": int(p["children"][i]),
            "meals": int(p["eaten"][i]),
            "lineage_size": int((p["lineage"] == p["lineage"][i]).sum()),
            "species": self._species_label(int(p["species"][i])),
            "doing": intent(p["act_in"][i], p["act_out"][i], bool(p["attacking"][i])),
            "brain": {
                "inputs": list(INPUTS),
                "outputs": list(OUTPUTS),
                "W1": np.round(p["W1"][i], 3).tolist(),
                "W2": np.round(p["W2"][i], 3).tolist(),
            },
            "activity": {
                "in": np.round(p["act_in"][i], 3).tolist(),
                "hidden": np.round(p["act_h"][i], 3).tolist(),
                "out": np.round(p["act_out"][i], 3).tolist(),
            },
        }

    def _species_label(self, sid: int) -> dict:
        shown = int(self.species.display_ids(np.array([sid]))[0])
        sp = self.species.get(shown) if shown >= 0 else None
        return {
            "id": sid,
            "shown": shown,
            "name": sp.name if sp else None,
            "color": sp.color if sp else None,
            "subspecies": shown != sid,
        }

    def state_digest(self) -> int:
        """Cheap fingerprint of the world, used to verify determinism."""
        p = self.pop
        parts = [p["pos"], p["energy"], p["W1"], self.plants]
        return hash(tuple(round(float(a.sum()), 9) for a in parts) + (len(p), self.tick))


def intent(act_in: np.ndarray, act_out: np.ndarray, biting: bool) -> str:
    """A best guess, in words, at what a creature's brain is doing this tick."""
    food_ahead, food_near = act_in[1], act_in[2]
    other_near, other_bigger, other_meatier = act_in[5], act_in[6], act_in[7]
    thrust = (act_out[1] + 1) / 2
    if biting:
        return "Biting"
    if act_out[2] > 0 and other_near > 0.4:
        return "Hunting"
    if other_near > 0.3 and (other_meatier > 0.3 or other_bigger > 0.2) and thrust > 0.6 and act_in[4] < 0:
        return "Running away"
    if food_near > 0.2 and food_ahead > 0.6:
        return "Heading for food"
    if act_in[9] >= 1.0 and act_out[3] > 0:
        return "Ready to reproduce"
    if thrust < 0.25:
        return "Resting"
    return "Wandering"
