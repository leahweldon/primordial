"""Command line entry point.

primordial serve                  # live web app on http://localhost:8000
primordial run --ticks 30000      # headless experiment -> CSV, JSON, charts, narration
primordial sweep --vary ...       # many worlds in parallel -> phase diagram
primordial bench                  # ticks per second at several population sizes
"""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

from . import __version__
from .config import WorldConfig
from .world import World


def cmd_serve(args: argparse.Namespace) -> None:
    import uvicorn

    from .server import create_app

    world = None
    if args.load:
        from .persistence import load

        world = load(args.load)
        print(f"Loaded {args.load} at tick {world.tick:,}")
    app = create_app(seed=args.seed, fps=args.fps, world=world)
    print(f"Primordial {__version__}: open http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


def cmd_run(args: argparse.Namespace) -> None:
    if args.load:
        from .persistence import load

        world = load(args.load)
        target = world.tick + args.ticks
    else:
        overrides = dict(kv.split("=", 1) for kv in args.set or [])
        cfg = WorldConfig()
        cfg.update(**overrides)
        world = World(cfg, seed=args.seed)
        target = args.ticks
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    started, start_tick = time.perf_counter(), world.tick
    report_every = max(args.ticks // 10, 1)
    seen = world.event_seq if args.load else 0
    while world.tick < target:
        world.run(min(report_every, target - world.tick))
        if not args.quiet:
            for e in world.events:
                if e["seq"] > seen and e["level"] == "headline":
                    print(f"  {e['tick']:>7,}  {re.sub(r'[*]', '', e['text'])}")
            seen = world.event_seq
        r = world.history.rows[-1]
        print(
            f"tick {world.tick:>7,}  alive {r['population']:>5}  "
            f"foragers {r['foragers']:>4}  omnivores {r['omnivores']:>4}  predators {r['predators']:>4}  "
            f"species {r['species_alive']:>3}  gen {r['max_generation']:>4}"
        )
    elapsed = time.perf_counter() - started

    world.history.to_csv(out / "history.csv")
    (out / "events.json").write_text(json.dumps(world.events, indent=1))
    (out / "species.json").write_text(json.dumps(world.species.registry(), indent=1))
    if args.save:
        from .persistence import save

        save(world, args.save)
    summary = summarise(world, elapsed, world.tick - start_tick)
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    if not args.no_plot and _have_matplotlib():
        from .plots import plot_history, plot_tree

        plot_history(world.history.rows, out / "evolution.png", title=f"seed {world.seed}")
        plot_tree(world.history.rows, world.species.registry(), out / "tree.png", title=f"seed {world.seed}")
    print(f"\n{summary['ticks_per_second']:,.0f} ticks/s. Results written to {out}/")


def summarise(world: World, elapsed: float, ticks_run: int) -> dict:
    rows = world.history.rows
    first_predator = next((r["tick"] for r in rows if r["predators"] >= 5), None)
    peak = max(rows, key=lambda r: r["predators"])
    last = {k: v for k, v in rows[-1].items() if k != "species"}
    return {
        "seed": world.seed,
        "ticks": world.tick,
        "seconds": round(elapsed, 2),
        "ticks_per_second": round(ticks_run / max(elapsed, 1e-9), 1),
        "species_named": len(world.species.registry()),
        "final": last,
        "first_predators_tick": first_predator,
        "peak_predators": {"tick": peak["tick"], "count": peak["predators"]},
        "config": world.cfg.to_dict(),
    }


def cmd_bench(args: argparse.Namespace) -> None:
    print(f"{'creatures':>10} {'plants':>8} {'ms/tick':>9} {'ticks/s':>9}")
    for n in args.sizes:
        cfg = WorldConfig(
            initial_creatures=n,
            max_creatures=n * 2,
            min_creatures=0,
            initial_plants=1500,
            plant_growth=10_000.0,  # refill plants every tick
            max_plants=1500,
            basal_cost=0.0,
            move_cost=0.0,
            attack_cost=0.0,
            attack_damage=0.0,  # keep N fixed
        )
        world = World(cfg, seed=0)
        world.cfg.reproduce_threshold = 1e9
        world.run(20)  # warm-up
        t0 = time.perf_counter()
        world.run(args.ticks)
        ms = (time.perf_counter() - t0) * 1000 / args.ticks
        print(f"{len(world.pop):>10} {world.plants.shape[0]:>8} {ms:>9.2f} {1000 / ms:>9.0f}")


def cmd_sweep(args: argparse.Namespace) -> None:
    from .sweep import parse_vary, phase_diagram, sweep

    grid = parse_vary(args.vary)
    out = Path(args.out)
    results = sweep(grid, args.seeds, args.ticks, out, args.workers)
    if len(grid) >= 2 and not args.no_plot and _have_matplotlib():
        labels = {"plant_growth": "Plant growth (new plants per tick)", "attack_damage": "Bite strength"}
        # x axis: the first parameter; y axis: the second
        phase_diagram(results, grid, out / "phase.png", labels)
        print(f"Phase diagram written to {out / 'phase.png'}")


def _have_matplotlib() -> bool:
    try:
        import matplotlib  # noqa: F401
    except ImportError:
        print("Skipping charts: install them with  pip install 'primordial[plots]'")
        return False
    return True


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="primordial", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    s = sub.add_parser("serve", help="run the live web app")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    s.add_argument("--seed", type=int, default=7)
    s.add_argument("--fps", type=float, default=30.0)
    s.add_argument("--load", metavar="FILE", help="start from a saved world (.npz)")
    s.set_defaults(func=cmd_serve)

    r = sub.add_parser("run", help="run a headless experiment")
    r.add_argument("--ticks", type=int, default=30_000)
    r.add_argument("--seed", type=int, default=7)
    r.add_argument("--out", default="results")
    r.add_argument("--set", nargs="*", metavar="KEY=VALUE", help="override config values")
    r.add_argument("--no-plot", action="store_true")
    r.add_argument("--quiet", action="store_true", help="don't print the narration")
    r.add_argument("--load", metavar="FILE", help="continue a saved world for --ticks more ticks")
    r.add_argument("--save", metavar="FILE", help="save the final world (.npz)")
    r.set_defaults(func=cmd_run)

    w = sub.add_parser("sweep", help="run many worlds in parallel and map the results")
    w.add_argument(
        "--vary",
        nargs="+",
        metavar="KEY=V1,V2,...",
        required=True,
        help="parameters to vary, e.g. plant_growth=3,6,9 attack_damage=4,8",
    )
    w.add_argument("--seeds", type=int, default=2, help="seeds per combination")
    w.add_argument("--ticks", type=int, default=20_000)
    w.add_argument("--workers", type=int, default=None, help="processes (default: one per core)")
    w.add_argument("--out", default="results/sweep")
    w.add_argument("--no-plot", action="store_true")
    w.set_defaults(func=cmd_sweep)

    b = sub.add_parser("bench", help="measure simulation speed")
    b.add_argument("--ticks", type=int, default=200)
    b.add_argument("--sizes", type=int, nargs="*", default=[100, 250, 500, 1000, 2000, 4000])
    b.set_defaults(func=cmd_bench)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
