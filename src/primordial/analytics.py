"""Population-level measurements: what is evolving, and how fast.

A sample is taken every ``stats_every`` ticks. Event counters (births,
deaths, kills, meals) accumulate between samples and are reset each time.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

import numpy as np

# Diet thresholds used to name strategies. Diet is a continuous heritable
# trait; these bands only exist to make the charts readable.
FORAGER_MAX = 0.35
PREDATOR_MIN = 0.65
STRATEGIES = ("forager", "omnivore", "predator")


def classify(diet: np.ndarray) -> np.ndarray:
    """0 = forager, 1 = omnivore, 2 = predator."""
    return (diet >= FORAGER_MAX).astype(np.int8) + (diet >= PREDATOR_MIN).astype(np.int8)


def sample(world) -> dict:
    pop = world.pop
    n = len(pop)
    c = world.counters
    row = {
        "tick": world.tick,
        "population": n,
        "plants": int(world.plants.shape[0]),
        "births": c["births"],
        "deaths": c["deaths"],
        "kills": c["kills"],
        "starved": c["starved"],
        "old_age": c["old_age"],
        "meals": c["meals"],
        "immigrants": c["immigrants"],
    }
    if n:
        cls = classify(pop["diet"])
        lineages, counts = np.unique(pop["lineage"], return_counts=True)
        row.update(
            foragers=int((cls == 0).sum()),
            omnivores=int((cls == 1).sum()),
            predators=int((cls == 2).sum()),
            mean_size=float(pop["size"].mean()),
            mean_speed=float(pop["speed"].mean()),
            mean_diet=float(pop["diet"].mean()),
            mean_energy=float(pop["energy"].mean()),
            mean_generation=float(pop["generation"].mean()),
            max_generation=int(pop["generation"].max()),
            attack_rate=float(pop["attacking"].mean()),
            lineages=int(lineages.size),
            top_lineage_share=float(counts.max() / n),
        )
    else:
        row.update(
            foragers=0,
            omnivores=0,
            predators=0,
            mean_size=0.0,
            mean_speed=0.0,
            mean_diet=0.0,
            mean_energy=0.0,
            mean_generation=0.0,
            max_generation=0,
            attack_rate=0.0,
            lineages=0,
            top_lineage_share=0.0,
        )
    for k in c:
        c[k] = 0
    return row


@dataclass
class History:
    """Bounded in-memory time series of samples."""

    max_rows: int = 5000
    rows: list[dict] = field(default_factory=list)

    def add(self, row: dict) -> None:
        self.rows.append(row)
        if len(self.rows) > self.max_rows:
            # Thin the oldest half rather than dropping it, so long runs
            # keep their whole shape at a lower resolution.
            half = len(self.rows) // 2
            self.rows = self.rows[:half:2] + self.rows[half:]

    def column(self, key: str) -> list:
        return [r[key] for r in self.rows]

    def to_csv(self, target: str | Path | TextIO) -> None:
        if not self.rows:
            return
        # Per-species counts are nested, so they stay out of the flat CSV.
        fields = [k for k, v in self.rows[0].items() if not isinstance(v, dict)]
        if isinstance(target, (str, Path)):
            with open(target, "w", newline="") as fh:
                self._write(fh, fields)
        else:
            self._write(target, fields)

    def _write(self, fh: TextIO, fields: list[str]) -> None:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        writer.writerows(self.rows)
