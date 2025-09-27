"""
Trace Generation Module

Generates traces between dual poles, mapping the dynamic pathways
through which tension shapes meaning in names and concepts.
"""

from typing import List, Dict, Tuple, Optional, Iterator
from dataclasses import dataclass
import numpy as np
from .duality_mapping import DualityPair, Pole, PolarityType
from .tension_scoring import TensionMetrics


@dataclass
class TracePoint:
    """A point along a trace between poles."""
    position: float  # 0.0 = negative pole, 1.0 = positive pole
    tension_level: float
    resonance: float
    characteristics: Dict[str, float]


@dataclass
class Trace:
    """A trace between two poles."""
    duality_pair: DualityPair
    points: List[TracePoint]
    total_length: float
    curvature: float
    dominant_frequencies: List[float]


@dataclass
class TraceNetwork:
    """A network of interconnected traces."""
    traces: List[Trace]
    intersection_points: List[Tuple[int, int, TracePoint]]  # trace1_idx, trace2_idx, intersection
    network_coherence: float
    emergent_patterns: List[str]


class TraceGenerator:
    """Generates traces between dual poles."""
    
    def __init__(self, resolution: int = 20):
        self.resolution = resolution  # Number of points per trace
        self.curve_factors = {
            PolarityType.PHONETIC: 0.3,
            PolarityType.STRUCTURAL: 0.1,
            PolarityType.EMOTIONAL: 0.5,
            PolarityType.SEMANTIC: 0.4,
            PolarityType.TEMPORAL: 0.2
        }
    
    def generate_traces(self, dualities: List[DualityPair], tension_metrics: Optional[TensionMetrics] = None) -> List[Trace]:
        """Generate traces for all duality pairs."""
        traces = []
        
        for duality in dualities:
            trace = self._generate_single_trace(duality, tension_metrics)
            traces.append(trace)
        
        return traces
    
    def generate_trace_network(self, dualities: List[DualityPair], tension_metrics: Optional[TensionMetrics] = None) -> TraceNetwork:
        """Generate a complete trace network with interconnections."""
        traces = self.generate_traces(dualities, tension_metrics)
        
        # Find intersection points between traces
        intersections = self._find_trace_intersections(traces)
        
        # Calculate network coherence
        coherence = self._calculate_network_coherence(traces, intersections)
        
        # Identify emergent patterns
        patterns = self._identify_emergent_patterns(traces, intersections)
        
        return TraceNetwork(
            traces=traces,
            intersection_points=intersections,
            network_coherence=coherence,
            emergent_patterns=patterns
        )
    
    def _generate_single_trace(self, duality: DualityPair, tension_metrics: Optional[TensionMetrics] = None) -> Trace:
        """Generate a single trace between two poles."""
        points = []
        
        # Generate points along the trace
        for i in range(self.resolution + 1):
            position = i / self.resolution
            
            # Calculate tension level at this position
            tension_level = self._calculate_tension_at_position(duality, position)
            
            # Calculate resonance at this position
            resonance = self._calculate_resonance_at_position(duality, position)
            
            # Calculate characteristics blend
            characteristics = self._blend_characteristics(duality, position)
            
            point = TracePoint(
                position=position,
                tension_level=tension_level,
                resonance=resonance,
                characteristics=characteristics
            )
            points.append(point)
        
        # Calculate trace properties
        total_length = self._calculate_trace_length(points)
        curvature = self._calculate_trace_curvature(points, duality)
        dominant_frequencies = self._extract_dominant_frequencies(points)
        
        return Trace(
            duality_pair=duality,
            points=points,
            total_length=total_length,
            curvature=curvature,
            dominant_frequencies=dominant_frequencies
        )
    
    def _calculate_tension_at_position(self, duality: DualityPair, position: float) -> float:
        """Calculate tension level at a specific position along the trace."""
        # Maximum tension typically occurs near the center (around 0.5)
        # but can shift based on pole weights
        
        pos_weight = duality.positive_pole.weight
        neg_weight = duality.negative_pole.weight
        total_weight = pos_weight + neg_weight
        
        if total_weight > 0:
            # Tension center shifts based on relative pole weights
            tension_center = pos_weight / total_weight
        else:
            tension_center = 0.5
        
        # Distance from tension center determines tension level
        distance_from_center = abs(position - tension_center)
        
        # Apply tension magnitude and create a curve
        base_tension = duality.tension_magnitude
        curve_factor = self.curve_factors.get(duality.positive_pole.polarity_type, 0.3)
        
        # Exponential decay from center with adjustable curvature
        tension = base_tension * np.exp(-distance_from_center / curve_factor)
        
        return min(tension, 1.0)
    
    def _calculate_resonance_at_position(self, duality: DualityPair, position: float) -> float:
        """Calculate resonance at a specific position along the trace."""
        base_resonance = duality.resonance_frequency
        
        # Resonance can vary along the trace based on polarity type
        if duality.positive_pole.polarity_type == PolarityType.PHONETIC:
            # Phonetic resonance varies smoothly
            resonance = base_resonance * (1 + 0.3 * np.sin(2 * np.pi * position))
        elif duality.positive_pole.polarity_type == PolarityType.STRUCTURAL:
            # Structural resonance has discrete jumps
            resonance = base_resonance * (1.2 if position < 0.5 else 0.8)
        elif duality.positive_pole.polarity_type == PolarityType.EMOTIONAL:
            # Emotional resonance follows power law
            resonance = base_resonance * (position ** 0.7 + (1-position) ** 0.7)
        else:
            resonance = base_resonance
        
        return min(resonance, 1.0)
    
    def _blend_characteristics(self, duality: DualityPair, position: float) -> Dict[str, float]:
        """Blend characteristics of both poles based on position."""
        pos_chars = duality.positive_pole.characteristics
        neg_chars = duality.negative_pole.characteristics
        
        # Collect all unique characteristics
        all_chars = set(pos_chars) | set(neg_chars)
        
        blended = {}
        for char in all_chars:
            pos_presence = 1.0 if char in pos_chars else 0.0
            neg_presence = 1.0 if char in neg_chars else 0.0
            
            # Blend based on position (0 = all negative, 1 = all positive)
            blended_value = neg_presence * (1 - position) + pos_presence * position
            
            # Add some nonlinearity for more interesting blends
            if pos_presence > 0 and neg_presence > 0:
                # When both poles have the characteristic, create interaction
                interaction = 4 * position * (1 - position)  # Peaks at 0.5
                blended_value += interaction * 0.2
            
            blended[char] = min(blended_value, 1.0)
        
        return blended
    
    def _calculate_trace_length(self, points: List[TracePoint]) -> float:
        """Calculate the total length of the trace in tension-space."""
        if len(points) < 2:
            return 0.0
        
        total_length = 0.0
        for i in range(1, len(points)):
            # Distance in multidimensional space (position, tension, resonance)
            prev_point = points[i-1]
            curr_point = points[i]
            
            position_diff = curr_point.position - prev_point.position
            tension_diff = curr_point.tension_level - prev_point.tension_level
            resonance_diff = curr_point.resonance - prev_point.resonance
            
            # Euclidean distance with weighted dimensions
            distance = np.sqrt(
                position_diff**2 + 
                (tension_diff * 0.5)**2 +  # Tension changes are less significant for length
                (resonance_diff * 0.3)**2   # Resonance changes are least significant
            )
            total_length += distance
        
        return total_length
    
    def _calculate_trace_curvature(self, points: List[TracePoint], duality: DualityPair) -> float:
        """Calculate the curvature of the trace."""
        if len(points) < 3:
            return 0.0
        
        curvatures = []
        for i in range(1, len(points) - 1):
            # Calculate curvature using three consecutive points
            prev_point = points[i-1]
            curr_point = points[i]
            next_point = points[i+1]
            
            # Vectors
            v1 = np.array([curr_point.position - prev_point.position,
                          curr_point.tension_level - prev_point.tension_level])
            v2 = np.array([next_point.position - curr_point.position,
                          next_point.tension_level - curr_point.tension_level])
            
            # Calculate angle between vectors
            if np.linalg.norm(v1) > 0 and np.linalg.norm(v2) > 0:
                cos_angle = np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2))
                cos_angle = np.clip(cos_angle, -1.0, 1.0)
                angle = np.arccos(cos_angle)
                curvatures.append(angle)
        
        return np.mean(curvatures) if curvatures else 0.0
    
    def _extract_dominant_frequencies(self, points: List[TracePoint]) -> List[float]:
        """Extract dominant frequencies from the trace using FFT."""
        if len(points) < 4:
            return []
        
        # Extract tension signal
        tension_signal = [p.tension_level for p in points]
        
        # Apply FFT
        fft_result = np.fft.fft(tension_signal)
        frequencies = np.fft.fftfreq(len(tension_signal))
        
        # Find dominant frequencies (highest magnitude components)
        magnitudes = np.abs(fft_result)
        
        # Get indices of top 3 frequencies (excluding DC component)
        dominant_indices = np.argsort(magnitudes[1:])[-3:] + 1
        dominant_freqs = [abs(frequencies[i]) for i in dominant_indices if magnitudes[i] > 0.1]
        
        return sorted(dominant_freqs, reverse=True)
    
    def _find_trace_intersections(self, traces: List[Trace]) -> List[Tuple[int, int, TracePoint]]:
        """Find intersection points between traces."""
        intersections = []
        
        for i, trace1 in enumerate(traces):
            for j, trace2 in enumerate(traces[i+1:], i+1):
                intersection = self._find_intersection(trace1, trace2)
                if intersection:
                    intersections.append((i, j, intersection))
        
        return intersections
    
    def _find_intersection(self, trace1: Trace, trace2: Trace) -> Optional[TracePoint]:
        """Find intersection between two traces."""
        # Simplified intersection detection
        # Look for points where traces have similar tension and resonance profiles
        
        min_distance = float('inf')
        best_intersection = None
        
        for p1 in trace1.points:
            for p2 in trace2.points:
                # Distance in tension-resonance space
                distance = np.sqrt(
                    (p1.tension_level - p2.tension_level)**2 +
                    (p1.resonance - p2.resonance)**2
                )
                
                if distance < min_distance and distance < 0.1:  # Threshold for intersection
                    min_distance = distance
                    # Create intersection point with blended characteristics
                    intersection_chars = {}
                    all_chars = set(p1.characteristics.keys()) | set(p2.characteristics.keys())
                    for char in all_chars:
                        val1 = p1.characteristics.get(char, 0.0)
                        val2 = p2.characteristics.get(char, 0.0)
                        intersection_chars[char] = (val1 + val2) / 2
                    
                    best_intersection = TracePoint(
                        position=(p1.position + p2.position) / 2,
                        tension_level=(p1.tension_level + p2.tension_level) / 2,
                        resonance=(p1.resonance + p2.resonance) / 2,
                        characteristics=intersection_chars
                    )
        
        return best_intersection
    
    def _calculate_network_coherence(self, traces: List[Trace], intersections: List[Tuple[int, int, TracePoint]]) -> float:
        """Calculate how coherent the trace network is."""
        if not traces:
            return 0.0
        
        # Coherence based on multiple factors
        
        # 1. Frequency alignment (traces with similar dominant frequencies are coherent)
        freq_coherence = self._calculate_frequency_coherence(traces)
        
        # 2. Intersection density (more intersections = more coherence)
        max_possible_intersections = len(traces) * (len(traces) - 1) / 2
        intersection_density = len(intersections) / max_possible_intersections if max_possible_intersections > 0 else 0
        
        # 3. Length consistency (similar trace lengths indicate coherence)
        lengths = [trace.total_length for trace in traces]
        length_variance = np.var(lengths) if len(lengths) > 1 else 0
        length_coherence = 1.0 / (1.0 + length_variance)
        
        # Combine factors
        coherence = (freq_coherence * 0.4 + intersection_density * 0.3 + length_coherence * 0.3)
        return min(coherence, 1.0)
    
    def _calculate_frequency_coherence(self, traces: List[Trace]) -> float:
        """Calculate coherence based on frequency alignment."""
        if not traces:
            return 0.0
        
        all_frequencies = []
        for trace in traces:
            all_frequencies.extend(trace.dominant_frequencies)
        
        if not all_frequencies:
            return 0.0
        
        # Look for common or harmonic frequencies
        coherence_score = 0.0
        for i, freq1 in enumerate(all_frequencies):
            for freq2 in all_frequencies[i+1:]:
                if abs(freq1 - freq2) < 0.05:  # Very similar frequencies
                    coherence_score += 1.0
                elif freq1 > 0 and freq2 > 0:
                    ratio = max(freq1, freq2) / min(freq1, freq2)
                    if abs(ratio - 2.0) < 0.1 or abs(ratio - 1.5) < 0.1:  # Harmonic relationships
                        coherence_score += 0.5
        
        # Normalize by number of possible pairs
        max_pairs = len(all_frequencies) * (len(all_frequencies) - 1) / 2
        return coherence_score / max_pairs if max_pairs > 0 else 0.0
    
    def _identify_emergent_patterns(self, traces: List[Trace], intersections: List[Tuple[int, int, TracePoint]]) -> List[str]:
        """Identify emergent patterns in the trace network."""
        patterns = []
        
        if not traces:
            return patterns
        
        # Pattern 1: Convergence patterns (many traces intersecting in similar regions)
        if len(intersections) > len(traces) / 2:
            patterns.append("high_convergence")
        
        # Pattern 2: Harmonic patterns (dominant frequencies are harmonically related)
        all_freqs = []
        for trace in traces:
            all_freqs.extend(trace.dominant_frequencies)
        
        harmonic_count = 0
        for i, freq1 in enumerate(all_freqs):
            for freq2 in all_freqs[i+1:]:
                if freq1 > 0 and freq2 > 0:
                    ratio = max(freq1, freq2) / min(freq1, freq2)
                    if abs(ratio - 2.0) < 0.1:
                        harmonic_count += 1
        
        if harmonic_count > len(all_freqs) / 4:
            patterns.append("harmonic_resonance")
        
        # Pattern 3: Symmetry patterns (similar curvatures)
        curvatures = [trace.curvature for trace in traces]
        if len(curvatures) > 1 and np.std(curvatures) < 0.1:
            patterns.append("symmetric_structure")
        
        # Pattern 4: Cascade patterns (decreasing tension magnitudes)
        tensions = [trace.duality_pair.tension_magnitude for trace in traces]
        if len(tensions) > 2:
            sorted_tensions = sorted(tensions, reverse=True)
            if tensions == sorted_tensions:
                patterns.append("tension_cascade")
        
        return patterns