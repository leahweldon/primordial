import numpy as np
import pytest
from pydantic import ValidationError

from primordial import World
from primordial.protocol import NO_SPECIES, Event, Reset, decode_frame, encode_frame, parse_command


def test_frame_round_trip():
    w = World(seed=0)
    w.run(30)
    tick, creatures, plants = decode_frame(encode_frame(w))
    assert tick == 30
    assert len(creatures) == len(w.pop) and len(plants) == w.plants.shape[0]
    np.testing.assert_allclose(creatures["x"], w.pop["pos"][:, 0], atol=1e-3)
    np.testing.assert_array_equal(creatures["id"], w.pop["id"])
    np.testing.assert_allclose(creatures["diet"] / 255, w.pop["diet"], atol=1 / 255)
    np.testing.assert_array_equal(creatures["flags"] & 1, w.pop["attacking"])
    np.testing.assert_allclose(creatures["speed"] / 255 * 8, w.pop["speed"], atol=8 / 255)
    np.testing.assert_allclose(creatures["thrust"] / 255, w.pop["thrust"], atol=1 / 255)
    assert np.all(creatures["age"] <= 255) and np.all(creatures["kills"] == np.minimum(w.pop["kills"], 255))
    # everyone starts in the founding species, which is named straight away
    assert set(creatures["species"].tolist()) == {0}


def test_unnamed_species_are_sent_as_none():
    w = World(seed=0)
    w.invasion(100, 100, amount=3)  # too few to become an established species
    _, creatures, _ = decode_frame(encode_frame(w))
    assert (creatures["species"] == NO_SPECIES).sum() == 3


def test_frame_is_compact():
    w = World(seed=0)
    assert len(encode_frame(w)) == 16 + 32 * len(w.pop) + 4 * w.plants.shape[0]


def test_bad_frame_rejected():
    with pytest.raises(ValueError):
        decode_frame(b"NOPE" + bytes(12))


def test_commands_parse_and_validate():
    assert isinstance(parse_command('{"type":"event","kind":"meteor","x":1,"y":2}'), Event)
    assert parse_command('{"type":"reset"}') == Reset(type="reset", seed=None)
    for bad in (
        '{"type":"event","kind":"volcano","x":1,"y":2}',
        '{"type":"speed","value":1000}',
        '{"type":"teleport"}',
        "not json",
    ):
        with pytest.raises(ValidationError):
            parse_command(bad)


def test_recent_meals_are_flagged():
    from tests.conftest import place, quiet_config

    w = World(quiet_config(), seed=0)
    place(w, (500, 500))
    w.plants = np.array([[503.0, 500.0]])
    w.step()
    _, creatures, _ = decode_frame(encode_frame(w))
    assert creatures["flags"][0] & 2
    w.run(20)
    _, creatures, _ = decode_frame(encode_frame(w))
    assert not creatures["flags"][0] & 2
