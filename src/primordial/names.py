"""Latin-ish binomial names for new species.

The genus is invented from syllables; the species epithet describes what is
most distinctive about the new species compared with the one it split from.
Names come from their own seeded generator, so naming never touches the
simulation's random stream and a run stays reproducible.
"""

from __future__ import annotations

import numpy as np

_ONSETS = (
    "Ar",
    "Bel",
    "Cor",
    "Dra",
    "El",
    "Fen",
    "Gly",
    "Hal",
    "Ix",
    "Lum",
    "Mor",
    "Neb",
    "Or",
    "Pyr",
    "Quil",
    "Rho",
    "Syl",
    "Thal",
    "Ul",
    "Vor",
    "Xan",
    "Zyg",
    "Cal",
    "Ner",
)
_MIDDLES = ("a", "o", "i", "e", "u", "ae", "y")
_ENDINGS = ("ella", "opsis", "odon", "ia", "ura", "onyx", "ites", "oma", "ana", "ix", "ulus", "aster")

EPITHETS = {
    "predator": ("vorax", "sanguinarius", "rapax", "carnifex", "lupinus", "ferox"),
    "forager": ("herbivorus", "pratensis", "mitis", "pascuus", "viridis", "placidus"),
    "omnivore": ("omnivorus", "ambiguus", "varius", "versutus", "opportunus"),
    "faster": ("velox", "celer", "rapidus", "fugax", "volans"),
    "slower": ("lentus", "tardus", "segnis", "quietus"),
    "bigger": ("magnus", "grandis", "robustus", "gigas", "maximus"),
    "smaller": ("minimus", "pusillus", "parvus", "minor", "nanus"),
    "founder": ("primus", "originalis", "antiquus"),
    "newcomer": ("advena", "peregrinus", "novus"),
    "same": ("vulgaris", "communis", "simplex", "modestus", "secundus", "alter"),
}


def make_rng(world_seed: int, species_id: int) -> np.random.Generator:
    return np.random.default_rng([world_seed, species_id, 0x5BEC1E5])


def genus(rng: np.random.Generator) -> str:
    return rng.choice(_ONSETS) + rng.choice(_MIDDLES) + rng.choice(_ENDINGS)


def distinction(traits: dict, parent: dict | None) -> str:
    """What sets a species apart from its parent: a key into ``EPITHETS``."""
    if parent is None:
        return "founder"
    if traits["strategy"] != parent["strategy"]:
        return traits["strategy"]
    speed = traits["speed"] / max(parent["speed"], 1e-9)
    size = traits["size"] / max(parent["size"], 1e-9)
    # pick whichever trait moved furthest, if it moved by more than 15%
    moves = {"faster": speed, "slower": 1 / speed, "bigger": size, "smaller": 1 / size}
    key, ratio = max(moves.items(), key=lambda kv: kv[1])
    return key if ratio > 1.15 else "same"


def epithet(rng: np.random.Generator, kind: str, taken: set[str], genus_name: str) -> str:
    options = list(EPITHETS[kind])
    rng.shuffle(options)
    spare = list(EPITHETS["same"])
    rng.shuffle(spare)
    for word in options + spare:
        if f"{genus_name} {word}" not in taken:
            return word
    n = 2
    while f"{genus_name} {options[0]} {_roman(n)}" in taken:
        n += 1
    return f"{options[0]} {_roman(n)}"


def _roman(n: int) -> str:
    out = ""
    for value, sym in ((10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")):
        while n >= value:
            out += sym
            n -= value
    return out
