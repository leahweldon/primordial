import pytest

from primordial.sweep import parse_vary, run_job, sweep


def test_parse_vary():
    assert parse_vary(["plant_growth=2,4", "attack_damage=5"]) == {
        "plant_growth": [2.0, 4.0],
        "attack_damage": [5.0],
    }
    with pytest.raises(SystemExit):
        parse_vary(["gravity=1,2"])
    with pytest.raises(SystemExit):
        parse_vary(["plant_growth=a,b"])


def test_run_job_reports_metrics():
    r = run_job({"plant_growth": 6.0}, seed=1, ticks=200)
    assert r["plant_growth"] == 6.0 and r["seed"] == 1
    assert 0 <= r["predator_share_late"] <= 1
    assert r["species_named"] >= 1


def test_sweep_runs_in_parallel_and_writes_csv(tmp_path):
    results = sweep({"plant_growth": [4.0, 8.0]}, seeds=1, ticks=100, out=tmp_path, workers=2)
    assert sorted(r["plant_growth"] for r in results) == [4.0, 8.0]
    lines = (tmp_path / "sweep.csv").read_text().splitlines()
    assert len(lines) == 3 and lines[0].startswith("plant_growth,seed")


def test_a_failing_world_does_not_sink_the_sweep(tmp_path, monkeypatch):
    from primordial import sweep as sweep_mod

    real = sweep_mod.run_job

    def flaky(params, seed, ticks):
        if params["plant_growth"] == 8.0:
            raise RuntimeError("boom")
        return real(params, seed, ticks)

    monkeypatch.setattr(sweep_mod, "run_job", flaky)
    # threads are enough here and let the monkeypatch apply inside workers
    monkeypatch.setattr(
        sweep_mod, "ProcessPoolExecutor", __import__("concurrent.futures").futures.ThreadPoolExecutor
    )
    results = sweep_mod.sweep({"plant_growth": [4.0, 8.0]}, seeds=1, ticks=50, out=tmp_path, workers=2)
    assert [r["plant_growth"] for r in results] == [4.0]
