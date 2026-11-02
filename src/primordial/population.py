"""Struct-of-arrays storage for creatures.

Every per-creature attribute is a NumPy array whose first axis is the
creature index. Births and deaths are handled by boolean selection and
concatenation, so the arrays always stay dense (no "alive" mask to skip).
"""

from __future__ import annotations

import numpy as np

# name -> (dtype, trailing shape)
SCHEMA: dict[str, tuple[type, tuple[int, ...]]] = {
    "id": (np.int64, ()),
    "parent": (np.int64, ()),
    "lineage": (np.int64, ()),  # id of the founding ancestor
    "generation": (np.int32, ()),
    "born": (np.int64, ()),  # tick of birth
    "pos": (np.float64, (2,)),
    "heading": (np.float64, ()),
    "energy": (np.float64, ()),
    "age": (np.int32, ()),
    # heritable traits
    "size": (np.float64, ()),  # body radius multiplier
    "speed": (np.float64, ()),  # max speed in px / tick
    "diet": (np.float64, ()),  # 0 = pure herbivore, 1 = pure carnivore
    "color": (np.float64, (3,)),  # drifts slowly -> visible family resemblance
    # life history / behaviour (not inherited)
    "kills": (np.int32, ()),
    "children": (np.int32, ()),
    "eaten": (np.int32, ()),
    "attacking": (np.bool_, ()),
    "thrust": (np.float64, ()),
    "last_meal": (np.int64, ()),  # tick of the last plant or kill eaten (for the eating animation)
    # species membership (see species.py)
    "species": (np.int32, ()),
    "ref": (np.int64, ()),  # reference genome this creature is compared against
}


class Population:
    """Dense arrays of creature state plus their stacked brains."""

    def __init__(self, arrays: dict[str, np.ndarray]):
        self.a = arrays

    @classmethod
    def empty(cls, hidden: int) -> Population:
        from .brain import N_IN, N_OUT

        arrays = {k: np.zeros((0, *shape), dtype=dt) for k, (dt, shape) in SCHEMA.items()}
        arrays["W1"] = np.zeros((0, hidden, N_IN), np.float32)
        arrays["b1"] = np.zeros((0, hidden), np.float32)
        arrays["W2"] = np.zeros((0, N_OUT, hidden), np.float32)
        arrays["b2"] = np.zeros((0, N_OUT), np.float32)
        # last tick's brain activity, so the UI can show a brain thinking
        arrays["act_in"] = np.zeros((0, N_IN), np.float32)
        arrays["act_h"] = np.zeros((0, hidden), np.float32)
        arrays["act_out"] = np.zeros((0, N_OUT), np.float32)
        return cls(arrays)

    def __len__(self) -> int:
        return int(self.a["id"].shape[0])

    def __getitem__(self, key: str) -> np.ndarray:
        return self.a[key]

    def __setitem__(self, key: str, value: np.ndarray) -> None:
        self.a[key] = value

    def select(self, idx: np.ndarray) -> Population:
        """Keep only the creatures at ``idx`` (bool mask or int index)."""
        return Population({k: v[idx] for k, v in self.a.items()})

    def extend(self, other: Population) -> None:
        if len(other) == 0:
            return
        for k in self.a:
            self.a[k] = np.concatenate([self.a[k], other.a[k].astype(self.a[k].dtype)])

    def brains(self) -> dict[str, np.ndarray]:
        return {k: self.a[k] for k in ("W1", "b1", "W2", "b2")}
