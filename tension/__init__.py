"""
Tension Engine - Experimental modeling of naming as process.

Treats names as traces between dual poles where tension shapes meaning.
"""

from .engine import TensionEngine
from .essence_extraction import EssenceExtractor
from .duality_mapping import DualityMapper
from .tension_scoring import TensionScorer
from .trace_generation import TraceGenerator

__version__ = "0.1.0"

__all__ = [
    "TensionEngine",
    "EssenceExtractor", 
    "DualityMapper",
    "TensionScorer",
    "TraceGenerator",
]