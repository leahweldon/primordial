"""Static charts of a finished run (used by ``primordial run`` and the README)."""

from __future__ import annotations

from pathlib import Path

FORAGER, OMNIVORE, PREDATOR = "#3b78a8", "#c0951e", "#b23a48"
INK, MUTED, PAPER, LINE = "#1e2b30", "#5d6c68", "#fafbf6", "#d7dcc8"


def plot_history(rows: list[dict], path: str | Path, title: str = "") -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    t = [r["tick"] for r in rows]
    col = lambda k: [r[k] for r in rows]  # noqa: E731

    plt.rcParams.update(
        {
            "font.size": 10,
            "axes.edgecolor": LINE,
            "axes.labelcolor": MUTED,
            "xtick.color": MUTED,
            "ytick.color": MUTED,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "figure.facecolor": PAPER,
            "axes.facecolor": PAPER,
        }
    )
    fig, axes = plt.subplots(
        4, 1, figsize=(9, 9.5), sharex=True, gridspec_kw={"height_ratios": [2.2, 1, 1, 1]}
    )

    ax = axes[0]
    ax.stackplot(
        t,
        col("foragers"),
        col("omnivores"),
        col("predators"),
        colors=[FORAGER, OMNIVORE, PREDATOR],
        alpha=0.9,
        labels=["Foragers", "Omnivores", "Predators"],
    )
    ax.set_ylabel("Creatures alive")
    ax.legend(loc="upper right", ncol=3, frameon=True, facecolor=PAPER, edgecolor=PAPER, framealpha=0.9)
    ax.set_title(
        f"Primordial: what evolved ({title})" if title else "Primordial: what evolved",
        loc="left",
        color=INK,
        fontsize=13,
        fontweight="bold",
    )

    for ax, key, label, colour in (
        (axes[1], "mean_speed", "Mean top speed", FORAGER),
        (axes[2], "mean_size", "Mean body size", INK),
        (axes[3], "mean_diet", "Mean meat in diet", PREDATOR),
    ):
        ax.plot(t, col(key), color=colour, lw=1.8)
        ax.set_ylabel(label)
    axes[3].set_ylim(0, 1)
    axes[3].set_xlabel("Tick")
    for ax in axes:
        ax.grid(axis="y", color=LINE, lw=0.8)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_tree(rows: list[dict], species: list[dict], path: str | Path, title: str = "") -> None:
    """Static version of the browser's tree of life."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    if not species or not rows:
        return
    by_id = {s["id"]: s for s in species}
    kids: dict[int, list[dict]] = {}
    roots = []
    for s in sorted(species, key=lambda s: (s["born"], s["id"])):
        if s["ancestor"] in by_id:
            kids.setdefault(s["ancestor"], []).append(s)
        else:
            roots.append(s)
    order: list[dict] = []

    def visit(s):
        order.append(s)
        for k in kids.get(s["id"], []):
            visit(k)

    for r in roots:
        visit(r)

    t_end = rows[-1]["tick"]
    lane = {s["id"]: i for i, s in enumerate(order)}
    peak = max(s["peak"] for s in order) or 1
    fig, ax = plt.subplots(figsize=(10, 0.42 * len(order) + 1.2))
    fig.patch.set_facecolor(PAPER)
    ax.set_facecolor(PAPER)
    for s in order:
        y = -lane[s["id"]]
        end = s["extinct"] if s["extinct"] is not None else t_end
        if s["ancestor"] in lane:
            ax.plot([s["born"], s["born"]], [-lane[s["ancestor"]], y], color=INK, alpha=0.25, lw=0.8)
        ax.plot([s["born"], end], [y, y], color=s["color"], alpha=0.5, lw=0.8)
        key = str(s["id"])
        pts = [
            (r["tick"], r.get("species", {}).get(key, 0)) for r in rows if s["born"] <= r["tick"] <= end + 10
        ]
        if len(pts) > 1:
            t = [p[0] for p in pts]
            half = [0.42 * (p[1] / peak) ** 0.5 for p in pts]
            ax.fill_between(
                t, [y - h for h in half], [y + h for h in half], color=s["color"], lw=0, alpha=0.9
            )
        if s["extinct"] is not None:
            ax.plot([end, end], [y - 0.15, y + 0.15], color=INK, lw=1.5)
        x_label = s["established"] if s["established"] is not None else s["born"]
        x_label = min(x_label, t_end * 0.84)  # keep late arrivals' names inside the chart
        ax.text(
            x_label + t_end * 0.006,
            y + 0.18,
            s["name"],
            fontsize=9,
            style="italic",
            va="bottom",
            color=MUTED if s["extinct"] is not None else INK,
        )
    ax.set_xlim(0, t_end)
    ax.set_ylim(-len(order) + 0.4, 0.9)
    ax.set_yticks([])
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(LINE)
    ax.tick_params(colors=MUTED)
    ax.set_xlabel("Tick", color=MUTED)
    ax.set_title(
        f"Tree of life ({title})" if title else "Tree of life",
        loc="left",
        color=INK,
        fontsize=13,
        fontweight="bold",
    )
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)
