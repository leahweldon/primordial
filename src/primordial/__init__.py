"""Primordial: an evolution sandbox where tiny neural-network creatures
forage, fight and reproduce, and strategies emerge over generations."""

from .config import WorldConfig
from .world import World

__all__ = ["World", "WorldConfig"]
__version__ = "0.4.0"
