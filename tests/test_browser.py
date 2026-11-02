"""End-to-end smoke test: the real page renders the world with no JS errors.

Skipped unless Playwright and its Chromium are installed
(``pip install playwright && playwright install chromium``).
"""

import socket
import threading
import time

import pytest

playwright = pytest.importorskip("playwright.sync_api")


@pytest.fixture(scope="module")
def server_url():
    import uvicorn

    from primordial.server import create_app

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(create_app(seed=7), host="127.0.0.1", port=port, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}/"
    server.should_exit = True
    thread.join(timeout=5)


@pytest.mark.parametrize("renderer", ["gpu", "2d"])
def test_page_draws_creatures_without_errors(server_url, renderer):
    with playwright.sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as exc:  # browser binaries not installed
            pytest.skip(f"no Chromium for Playwright: {exc}")
        page = browser.new_page(viewport={"width": 1280, "height": 860})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(server_url + ("?renderer=2d" if renderer == "2d" else ""))
        page.wait_for_function("() => state.frame && state.frame.creatures.length > 0", timeout=30_000)
        used = page.evaluate("() => document.documentElement.dataset.renderer")
        if renderer == "gpu" and used != "gpu":
            # only skip when WebGL2 is genuinely missing; a shader that fails to
            # compile also falls back to 2D, and that must fail the test
            if not page.evaluate("() => GLRenderer.supported()"):
                pytest.skip("this browser has no WebGL2")
        assert used == renderer
        if renderer == "2d":
            page.wait_for_function("() => Art.spriteStats.hits > 100", timeout=30_000)
        else:
            # a couple of real frames through the whole GPU pipeline
            page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")

        # the founders are named straight away and appear in the field guide
        assert page.locator("#guide button").count() >= 1
        # click a creature: the inspector opens with a live portrait. Pause
        # first and let the camera settle so the target can't wander off
        # between reading its position and clicking (software WebGL is slow).
        page.evaluate("() => send({ type: 'pause', paused: true })")
        page.wait_for_function("() => state.status.paused", timeout=15_000)
        page.wait_for_function(
            "() => Math.abs(state.eye.zoom - state.view.zoom) < 1e-3"
            " && Math.abs(state.eye.cx - state.view.cx) < 0.5",
            timeout=30_000,
        )
        x, y = page.evaluate(
            """() => {
                const r = canvas.getBoundingClientRect();
                const [hw, hh] = halfSpan(state.eye);
                const toScreen = (c) => [r.left + ((c.x - (state.eye.cx - hw)) / (2 * hw)) * r.width,
                                         r.top + ((c.y - (state.eye.cy - hh)) / (2 * hh)) * r.height];
                // the on-screen creature nearest the middle of the dish
                let best = null, bestD = Infinity;
                for (const c of state.frame.creatures) {
                    const [sx, sy] = toScreen(c);
                    const d = Math.hypot(sx - (r.left + r.width / 2), sy - (r.top + r.height / 2));
                    if (d < bestD) { bestD = d; best = [sx, sy]; }
                }
                return best;
            }"""
        )
        page.mouse.click(x, y)
        page.wait_for_selector("#inspect-body:not([hidden])", timeout=15_000)
        assert errors == []
        browser.close()
