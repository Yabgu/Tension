"""
Tension Scoring Module

Calculates tension metrics between dual poles, measuring the dynamic
forces that shape meaning within names and concepts.
"""

from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass
import numpy as np
from .duality_mapping import DualityPair, PolarityType
from .essence_extraction import Essence


@dataclass
class TensionMetrics:
    """Comprehensive tension metrics for a name."""
    overall_tension: float
    phonetic_tension: float
    structural_tension: float
    emotional_tension: float
    harmonic_resonance: float
    tension_distribution: Dict[str, float]
    peak_tensions: List[Tuple[str, float]]
    equilibrium_point: float


class TensionScorer:
    """Calculates tension scores and metrics."""
    
    def __init__(self):
        self.polarity_weights = {
            PolarityType.PHONETIC: 0.4,
            PolarityType.STRUCTURAL: 0.3,
            PolarityType.EMOTIONAL: 0.3,
            PolarityType.SEMANTIC: 0.2,
            PolarityType.TEMPORAL: 0.1
        }
        
        # Tension interaction coefficients
        self.interaction_matrix = {
            (PolarityType.PHONETIC, PolarityType.EMOTIONAL): 0.8,
            (PolarityType.PHONETIC, PolarityType.STRUCTURAL): 0.6,
            (PolarityType.STRUCTURAL, PolarityType.EMOTIONAL): 0.7,
            (PolarityType.PHONETIC, PolarityType.SEMANTIC): 0.5,
            (PolarityType.STRUCTURAL, PolarityType.SEMANTIC): 0.6,
            (PolarityType.EMOTIONAL, PolarityType.SEMANTIC): 0.9,
        }
    
    def calculate_tension_metrics(self, dualities: List[DualityPair], essence: Optional[Essence] = None) -> TensionMetrics:
        """Calculate comprehensive tension metrics from dualities."""
        if not dualities:
            return self._create_empty_metrics()
        
        # Calculate tension by type
        tension_by_type = self._calculate_tension_by_type(dualities)
        
        # Calculate overall tension with interactions
        overall_tension = self._calculate_overall_tension(tension_by_type, dualities)
        
        # Calculate harmonic resonance
        harmonic_resonance = self._calculate_harmonic_resonance(dualities)
        
        # Find peak tensions
        peak_tensions = self._find_peak_tensions(dualities)
        
        # Calculate equilibrium point
        equilibrium_point = self._calculate_equilibrium_point(dualities)
        
        # Create tension distribution map
        tension_distribution = self._create_tension_distribution(dualities)
        
        return TensionMetrics(
            overall_tension=overall_tension,
            phonetic_tension=tension_by_type.get(PolarityType.PHONETIC, 0.0),
            structural_tension=tension_by_type.get(PolarityType.STRUCTURAL, 0.0),
            emotional_tension=tension_by_type.get(PolarityType.EMOTIONAL, 0.0),
            harmonic_resonance=harmonic_resonance,
            tension_distribution=tension_distribution,
            peak_tensions=peak_tensions,
            equilibrium_point=equilibrium_point
        )
    
    def _calculate_tension_by_type(self, dualities: List[DualityPair]) -> Dict[PolarityType, float]:
        """Calculate tension grouped by polarity type."""
        tension_by_type = {}
        
        for polarity_type in PolarityType:
            type_dualities = [d for d in dualities if d.positive_pole.polarity_type == polarity_type]
            if type_dualities:
                # Aggregate tensions using RMS (root mean square) for better peak preservation
                tensions = [d.tension_magnitude for d in type_dualities]
                rms_tension = np.sqrt(np.mean([t**2 for t in tensions]))
                tension_by_type[polarity_type] = rms_tension
            else:
                tension_by_type[polarity_type] = 0.0
                
        return tension_by_type
    
    def _calculate_overall_tension(self, tension_by_type: Dict[PolarityType, float], dualities: List[DualityPair]) -> float:
        """Calculate overall tension considering type weights and interactions."""
        # Weighted sum of individual tensions
        weighted_sum = sum(
            tension * self.polarity_weights[polarity_type]
            for polarity_type, tension in tension_by_type.items()
        )
        
        # Add interaction effects
        interaction_bonus = 0.0
        for (type1, type2), coefficient in self.interaction_matrix.items():
            tension1 = tension_by_type.get(type1, 0.0)
            tension2 = tension_by_type.get(type2, 0.0)
            # Interaction creates additional tension when both types are present
            interaction_bonus += min(tension1, tension2) * coefficient * 0.1
        
        # Apply resonance amplification
        resonance_amplification = self._calculate_resonance_amplification(dualities)
        
        overall = weighted_sum + interaction_bonus
        return min(overall * (1 + resonance_amplification), 1.0)
    
    def _calculate_harmonic_resonance(self, dualities: List[DualityPair]) -> float:
        """Calculate harmonic resonance across all dualities."""
        if not dualities:
            return 0.0
        
        # Collect all resonance frequencies
        frequencies = [d.resonance_frequency for d in dualities if d.resonance_frequency > 0]
        
        if not frequencies:
            return 0.0
        
        # Calculate harmonic relationships
        harmonic_strength = 0.0
        for i, freq1 in enumerate(frequencies):
            for freq2 in frequencies[i+1:]:
                # Check for harmonic relationships (ratios of small integers)
                ratio = max(freq1, freq2) / min(freq1, freq2) if min(freq1, freq2) > 0 else 0
                if ratio > 0:
                    # Strong harmonics at 2:1, 3:2, 4:3, etc.
                    harmonic_scores = {2.0: 1.0, 1.5: 0.8, 1.33: 0.7, 1.25: 0.6}
                    for harmonic_ratio, score in harmonic_scores.items():
                        if abs(ratio - harmonic_ratio) < 0.1:
                            harmonic_strength += score
                            break
        
        # Normalize by number of possible pairs
        max_pairs = len(frequencies) * (len(frequencies) - 1) / 2
        return harmonic_strength / max_pairs if max_pairs > 0 else 0.0
    
    def _calculate_resonance_amplification(self, dualities: List[DualityPair]) -> float:
        """Calculate amplification effect from resonance patterns."""
        if not dualities:
            return 0.0
        
        # High resonance frequencies create amplification
        resonance_sum = sum(d.resonance_frequency for d in dualities)
        avg_resonance = resonance_sum / len(dualities)
        
        # Amplification is stronger when resonances are consistent
        resonance_variance = np.var([d.resonance_frequency for d in dualities])
        consistency_factor = 1.0 / (1.0 + resonance_variance)
        
        return avg_resonance * consistency_factor * 0.2  # Max 20% amplification
    
    def _find_peak_tensions(self, dualities: List[DualityPair]) -> List[Tuple[str, float]]:
        """Find the highest tension points."""
        tensions = [(f"{d.positive_pole.name}_vs_{d.negative_pole.name}", d.tension_magnitude) 
                   for d in dualities]
        
        # Sort by tension magnitude and return top peaks
        tensions.sort(key=lambda x: x[1], reverse=True)
        return tensions[:min(5, len(tensions))]  # Top 5 peaks
    
    def _calculate_equilibrium_point(self, dualities: List[DualityPair]) -> float:
        """Calculate the equilibrium point where tensions balance."""
        if not dualities:
            return 0.5  # Perfect balance
        
        # Weight each duality by its magnitude
        weighted_balances = []
        total_weight = 0.0
        
        for duality in dualities:
            # Balance is the relative weight of positive vs negative pole
            total_pole_weight = duality.positive_pole.weight + duality.negative_pole.weight
            if total_pole_weight > 0:
                balance = duality.positive_pole.weight / total_pole_weight
                weight = duality.tension_magnitude
                weighted_balances.append(balance * weight)
                total_weight += weight
        
        if total_weight > 0:
            equilibrium = sum(weighted_balances) / total_weight
        else:
            equilibrium = 0.5
            
        return equilibrium
    
    def _create_tension_distribution(self, dualities: List[DualityPair]) -> Dict[str, float]:
        """Create a detailed tension distribution map."""
        distribution = {}
        
        for duality in dualities:
            key = f"{duality.positive_pole.polarity_type.value}_{duality.positive_pole.name}"
            distribution[key] = duality.tension_magnitude
        
        # Add summary statistics
        if dualities:
            tensions = [d.tension_magnitude for d in dualities]
            distribution['mean_tension'] = np.mean(tensions)
            distribution['max_tension'] = np.max(tensions)
            distribution['min_tension'] = np.min(tensions)
            distribution['tension_std'] = np.std(tensions)
        
        return distribution
    
    def _create_empty_metrics(self) -> TensionMetrics:
        """Create empty metrics for cases with no dualities."""
        return TensionMetrics(
            overall_tension=0.0,
            phonetic_tension=0.0,
            structural_tension=0.0,
            emotional_tension=0.0,
            harmonic_resonance=0.0,
            tension_distribution={},
            peak_tensions=[],
            equilibrium_point=0.5
        )
    
    def compare_tensions(self, metrics1: TensionMetrics, metrics2: TensionMetrics) -> Dict[str, float]:
        """Compare tension metrics between two names."""
        return {
            'overall_tension_diff': metrics1.overall_tension - metrics2.overall_tension,
            'phonetic_tension_diff': metrics1.phonetic_tension - metrics2.phonetic_tension,
            'structural_tension_diff': metrics1.structural_tension - metrics2.structural_tension,
            'emotional_tension_diff': metrics1.emotional_tension - metrics2.emotional_tension,
            'harmonic_resonance_diff': metrics1.harmonic_resonance - metrics2.harmonic_resonance,
            'equilibrium_diff': metrics1.equilibrium_point - metrics2.equilibrium_point,
        }
    
    def calculate_tension_stability(self, dualities: List[DualityPair]) -> float:
        """Calculate how stable the tension configuration is."""
        if not dualities:
            return 1.0  # Maximum stability (no tensions to become unstable)
        
        tensions = [d.tension_magnitude for d in dualities]
        resonances = [d.resonance_frequency for d in dualities]
        
        # Stability decreases with tension variance (unstable if tensions vary wildly)
        tension_variance = np.var(tensions) if len(tensions) > 1 else 0.0
        tension_stability = 1.0 / (1.0 + tension_variance)
        
        # Stability increases with harmonic resonance (harmonic = stable)
        resonance_stability = np.mean(resonances) if resonances else 0.0
        
        return (tension_stability + resonance_stability) / 2