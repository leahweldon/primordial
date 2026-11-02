"""Simulation parameters.

Every tunable number lives here so that a run is fully described by
(config, seed). The web UI edits a whitelisted subset of these at runtime.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, fields


@dataclass
class WorldConfig:
    # --- world -----------------------------------------------------------
    width: float = 1600.0
    height: float = 1000.0

    # --- population ------------------------------------------------------
    initial_creatures: int = 160
    max_creatures: int = 1500
    min_creatures: int = 25  # below this, random immigrants arrive
    immigration: bool = True

    # --- plants ----------------------------------------------------------
    initial_plants: int = 900
    max_plants: int = 2400
    plant_growth: float = 6.0  # expected new plants per tick
    plant_energy: float = 22.0
    fertile_zones: int = 4  # gaussian "oases" where plants prefer to grow
    fertile_fraction: float = 0.75  # share of new plants that spawn in an oasis
    zone_drift: float = 0.04  # px per tick that each oasis wanders

    # --- seasons ---------------------------------------------------------
    season_length: int = 1500  # ticks per season (a year is four of these)
    season_strength: float = 0.5  # plant growth swings by +/- this fraction over a year

    # --- brains ----------------------------------------------------------
    hidden_size: int = 8

    # --- body & metabolism ----------------------------------------------
    start_energy: float = 60.0
    basal_cost: float = 0.045  # per tick, scaled by size^2
    move_cost: float = 0.012  # scaled by size * speed^2
    attack_cost: float = 0.12  # per tick spent attacking
    vision: float = 140.0
    max_age: int = 3000
    maturity_age: int = 80

    # --- combat ----------------------------------------------------------
    attack_damage: float = 5.5
    meat_efficiency: float = 1.0  # fraction of stolen energy a pure carnivore keeps
    body_energy: float = 20.0  # energy locked in a body (x size^2): paid at birth, eaten by killers
    plant_efficiency: float = 1.0  # fraction of plant energy a pure herbivore keeps

    # --- reproduction ----------------------------------------------------
    reproduce_threshold: float = 70.0  # energy needed (scaled by size^2)
    offspring_share: float = 0.45  # share of parent energy given to the child
    reproduce_cost: float = 2.0

    # --- mutation --------------------------------------------------------
    mutation_rate: float = 0.12  # probability each weight mutates
    mutation_scale: float = 0.35  # std-dev of a weight mutation
    trait_mutation: float = 0.06  # std-dev of trait mutations (relative)

    # --- species ---------------------------------------------------------
    species_threshold: float = 12.0  # genome distance from a founder that makes a new species

    # --- analytics -------------------------------------------------------
    stats_every: int = 10  # ticks between analytics samples

    def to_dict(self) -> dict:
        return asdict(self)

    def update(self, **changes) -> None:
        names = {f.name: f.type for f in fields(self)}
        for key, value in changes.items():
            if key not in names:
                raise KeyError(f"unknown config key: {key}")
            current = getattr(self, key)
            setattr(self, key, type(current)(value))


# Parameters the live UI is allowed to change while the world runs,
# with (min, max, step) for the sliders.
TUNABLE: dict[str, tuple[float, float, float]] = {
    "plant_growth": (0.0, 25.0, 0.5),
    "plant_energy": (5.0, 60.0, 1.0),
    "season_strength": (0.0, 1.0, 0.05),
    "mutation_rate": (0.0, 0.6, 0.01),
    "mutation_scale": (0.0, 1.5, 0.05),
    "basal_cost": (0.0, 0.2, 0.005),
    "attack_damage": (0.0, 20.0, 0.5),
    "meat_efficiency": (0.0, 1.0, 0.05),
}
