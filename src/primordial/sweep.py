"""Run many worlds in parallel to map how conditions shape evolution.

Each (parameter combination, seed) pair is an independent job, so a sweep
is embarrassingly parallel: jobs are farmed out to a process pool (one
process per core, sidestepping the GIL), results stream back as they
finish, and every finished job is appended to the CSV immediately so an
interrupted sweep keeps its partial results. Seeds are explicit, so any
single cell of the grid can be re-run and inspected on its own.
"""

from __future__ import annotations

import csv
import itertools
import os
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

from .config import WorldConfig
from .world import World

ESTABLISHED_PREDATORS = 5  # mean predators over the final quarter for "predators established"


def parse_vary(specs: list[str]) -> dict[str, list[float]]:
    grid: dict[str, list[float]] = {}
    known = set(WorldConfig().to_dict())
    for spec in specs:
        key, _, values = spec.partition("=")
        if key not in known:
            raise SystemExit(f"unknown parameter {key!r}")
        try:
            grid[key] = [float(v) for v in values.split(",") if v]
        except ValueError:
            raise SystemExit(f"bad values for {key!r}: {values}") from None
        if not grid[key]:
            raise SystemExit(f"no values given for {key!r}")
    return grid


def run_job(params: dict, seed: int, ticks: int) -> dict:
    """One world, start to finish. Runs in a worker process."""
    started = time.perf_counter()
    cfg = WorldConfig()
    cfg.update(**params)
    world = World(cfg, seed=seed)
    world.run(ticks)

    rows = world.history.rows
    late = rows[len(rows) * 3 // 4 :]
    preds = np.array([r["predators"] for r in late], float)
    pops = np.maximum(np.array([r["population"] for r in late], float), 1)
    first = next((r["tick"] for r in rows if r["predators"] >= ESTABLISHED_PREDATORS), None)
    return {
        **params,
        "seed": seed,
        "ticks": ticks,
        "predators_late": round(float(preds.mean()), 2),
        "predator_share_late": round(float((preds / pops).mean()), 4),
        "predators_established": bool(preds.mean() >= ESTABLISHED_PREDATORS),
        "first_predator_tick": first,
        "population_late": round(float(pops.mean()), 1),
        "mean_speed_late": round(float(np.mean([r["mean_speed"] for r in late])), 3),
        "mean_size_late": round(float(np.mean([r["mean_size"] for r in late])), 3),
        "species_named": len(world.species.registry()),
        "max_generation": rows[-1]["max_generation"],
        "seconds": round(time.perf_counter() - started, 1),
    }


def sweep(
    grid: dict[str, list[float]], seeds: int, ticks: int, out: Path, workers: int | None = None
) -> list[dict]:
    out.mkdir(parents=True, exist_ok=True)
    keys = list(grid)
    jobs = [
        (dict(zip(keys, combo, strict=True)), seed)
        for combo in itertools.product(*grid.values())
        for seed in range(seeds)
    ]
    workers = workers or os.cpu_count() or 1
    print(f"{len(jobs)} worlds x {ticks:,} ticks on {workers} worker processes")

    results: list[dict] = []
    failures: list[tuple] = []
    started = time.perf_counter()
    csv_path = out / "sweep.csv"
    with ProcessPoolExecutor(max_workers=workers) as pool, open(csv_path, "w", newline="") as fh:
        writer = None
        futures = {pool.submit(run_job, p, s, ticks): (p, s) for p, s in jobs}
        for done, fut in enumerate(as_completed(futures), 1):
            try:
                row = fut.result()
            except Exception as exc:  # one broken world shouldn't sink the whole sweep
                params, seed = futures[fut]
                failures.append((params, seed, repr(exc)))
                print(f"[{done:>3}/{len(jobs)}] {params}, seed {seed}: FAILED with {exc!r}", flush=True)
                continue
            results.append(row)
            if writer is None:
                writer = csv.DictWriter(fh, fieldnames=list(row))
                writer.writeheader()
            writer.writerow(row)
            fh.flush()
            label = ", ".join(f"{k}={row[k]:g}" for k in keys)
            print(
                f"[{done:>3}/{len(jobs)}] {label}, seed {row['seed']}: "
                f"{row['predators_late']:.0f} predators, {row['seconds']:.0f}s",
                flush=True,
            )
    elapsed = time.perf_counter() - started
    cpu = sum(r["seconds"] for r in results)
    print(f"done in {elapsed:.0f}s ({cpu:.0f} CPU-seconds, {cpu / elapsed:.1f}x parallel speed-up)")
    if failures:
        print(
            f"{len(failures)} world(s) failed; re-run one with: primordial run --seed N --set KEY=VALUE ..."
        )
    return results


def phase_diagram(results: list[dict], grid: dict[str, list[float]], path: Path, labels=None) -> None:
    """Heatmap of predator share across a two-parameter grid."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LinearSegmentedColormap

    (kx, xs), (ky, ys) = list(grid.items())[:2]
    share = np.zeros((len(ys), len(xs)))
    est = np.zeros_like(share, dtype=int)
    n = np.zeros_like(share, dtype=int)
    for r in results:
        i, j = ys.index(r[ky]), xs.index(r[kx])
        share[i, j] += r["predator_share_late"]
        est[i, j] += r["predators_established"]
        n[i, j] += 1
    share = share / np.maximum(n, 1)

    labels = labels or {}
    cmap = LinearSegmentedColormap.from_list("prey", ["#eef0e6", "#e7b9a6", "#b23a48", "#5e1622"])
    fig, ax = plt.subplots(figsize=(7.4, 5.6))
    fig.patch.set_facecolor("#fafbf6")
    im = ax.imshow(share * 100, origin="lower", cmap=cmap, vmin=0, aspect="auto")
    for i in range(len(ys)):
        for j in range(len(xs)):
            dark = share[i, j] > 0.6 * share.max()
            ax.text(
                j,
                i,
                f"{share[i, j] * 100:.0f}%\n{est[i, j]}/{n[i, j]}",
                ha="center",
                va="center",
                fontsize=9,
                color="white" if dark else "#1e2b30",
            )
    ax.set_xticks(range(len(xs)), [f"{v:g}" for v in xs])
    ax.set_yticks(range(len(ys)), [f"{v:g}" for v in ys])
    ax.set_xlabel(labels.get(kx, kx))
    ax.set_ylabel(labels.get(ky, ky))
    ax.set_title("When do predators evolve?", loc="left", fontweight="bold", color="#1e2b30")
    cb = fig.colorbar(im, ax=ax)
    cb.set_label("Predators as % of population (final quarter)")
    for spine in ax.spines.values():
        spine.set_visible(False)
    fig.text(
        0.01,
        0.01,
        "Cell label: predator share, and how many seeds ended with predators established.",
        fontsize=8,
        color="#5d6c68",
    )
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(path, dpi=150)
    plt.close(fig)
