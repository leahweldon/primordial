"""Tiny neural-network brains, evaluated for the whole population at once.

Each creature owns a 2-layer MLP (inputs -> hidden -> outputs). Rather than
looping over creatures, all weights are stored as stacked tensors so that a
single ``einsum`` evaluates every brain in the world in one vectorised call:

    W1: (N, H, I)   b1: (N, H)
    W2: (N, O, H)   b2: (N, O)
"""

from __future__ import annotations

import numpy as np

INPUTS = (
    "food_sin",  # direction to nearest plant (relative to heading)
    "food_cos",
    "food_near",  # 1 = touching, 0 = out of sight
    "other_sin",  # direction to nearest creature
    "other_cos",
    "other_near",
    "other_bigger",  # (their size - mine) / (their size + mine)
    "other_diet",  # their diet - my diet (positive = they are more carnivorous)
    "other_kin",  # colour similarity: a heritable "family resemblance" signal
    "energy",  # my energy relative to what I need to reproduce
    "clock",  # internal oscillator, lets brains learn rhythms
)

OUTPUTS = (
    "turn",  # -1 .. 1, scaled to max turn rate
    "thrust",  # mapped to 0 .. 1 of max speed
    "attack",  # > 0 means bite whatever is in reach
    "reproduce",  # > 0 means split if energy allows
)

N_IN = len(INPUTS)
N_OUT = len(OUTPUTS)
BRAIN_KEYS = ("W1", "b1", "W2", "b2")


def random_brains(rng: np.random.Generator, n: int, hidden: int) -> dict[str, np.ndarray]:
    """Xavier-style random initialisation for ``n`` brains."""
    s1 = np.sqrt(2.0 / (N_IN + hidden))
    s2 = np.sqrt(2.0 / (hidden + N_OUT))
    brains = {
        "W1": rng.normal(0.0, s1, (n, hidden, N_IN)),
        "b1": rng.normal(0.0, 0.1, (n, hidden)),
        "W2": rng.normal(0.0, s2, (n, N_OUT, hidden)),
        "b2": rng.normal(0.0, 0.1, (n, N_OUT)),
    }
    # A gentle nudge so generation zero isn't completely hopeless:
    # steer towards food and keep moving. Evolution does everything else.
    brains["b2"][:, 1] += 0.5  # thrust
    return {k: v.astype(np.float32) for k, v in brains.items()}


def think(
    brains: dict[str, np.ndarray], x: np.ndarray, return_hidden: bool = False
) -> np.ndarray | tuple[np.ndarray, np.ndarray]:
    """Evaluate every brain on its own input row. ``x`` is (N, N_IN).

    With ``return_hidden`` the hidden-layer activations are returned too, so
    the UI can show a creature's brain lighting up as it thinks.
    """
    x = x.astype(np.float32, copy=False)
    h = np.tanh(np.einsum("nhi,ni->nh", brains["W1"], x) + brains["b1"])
    out = np.tanh(np.einsum("noh,nh->no", brains["W2"], h) + brains["b2"])
    return (out, h) if return_hidden else out


def mutate(
    brains: dict[str, np.ndarray],
    rng: np.random.Generator,
    rate: float,
    scale: float,
) -> dict[str, np.ndarray]:
    """Return mutated copies: each weight changes with probability ``rate``."""
    out = {}
    for key in BRAIN_KEYS:
        w = brains[key].copy()
        mask = rng.random(w.shape) < rate
        w[mask] += rng.normal(0.0, scale, int(mask.sum())).astype(np.float32)
        np.clip(w, -6.0, 6.0, out=w)
        out[key] = w
    return out
