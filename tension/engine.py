"""
Tension Engine - Main Interface

The core engine that orchestrates essence extraction, duality mapping,
tension scoring, and trace generation to model naming as process.
"""

from typing import Dict, List, Optional, Any
from dataclasses import dataclass
from .essence_extraction import EssenceExtractor, Essence
from .duality_mapping import DualityMapper, DualityPair
from .tension_scoring import TensionScorer, TensionMetrics
from .trace_generation import TraceGenerator, TraceNetwork


@dataclass
class NameAnalysis:
    """Complete analysis of a name through the Tension Engine."""
    name: str
    essence: Essence
    dualities: List[DualityPair]
    tension_metrics: TensionMetrics
    trace_network: TraceNetwork
    summary: Dict[str, Any]


class TensionEngine:
    """Main Tension Engine for modeling naming as process."""
    
    def __init__(self, trace_resolution: int = 20):
        """
        Initialize the Tension Engine.
        
        Args:
            trace_resolution: Number of points per trace (higher = more detailed)
        """
        self.essence_extractor = EssenceExtractor()
        self.duality_mapper = DualityMapper()
        self.tension_scorer = TensionScorer()
        self.trace_generator = TraceGenerator(resolution=trace_resolution)
        
    def analyze_name(self, name: str) -> NameAnalysis:
        """
        Perform complete analysis of a name.
        
        Args:
            name: The name to analyze
            
        Returns:
            Complete NameAnalysis with all tension dynamics
        """
        # Step 1: Extract essence
        essence = self.essence_extractor.extract(name)
        
        # Step 2: Map dualities
        dualities = self.duality_mapper.map_dualities(name, essence)
        
        # Step 3: Calculate tension metrics
        tension_metrics = self.tension_scorer.calculate_tension_metrics(dualities, essence)
        
        # Step 4: Generate trace network
        trace_network = self.trace_generator.generate_trace_network(dualities, tension_metrics)
        
        # Step 5: Create summary
        summary = self._create_summary(name, essence, dualities, tension_metrics, trace_network)
        
        return NameAnalysis(
            name=name,
            essence=essence,
            dualities=dualities,
            tension_metrics=tension_metrics,
            trace_network=trace_network,
            summary=summary
        )
    
    def compare_names(self, name1: str, name2: str) -> Dict[str, Any]:
        """
        Compare tension dynamics between two names.
        
        Args:
            name1: First name to compare
            name2: Second name to compare
            
        Returns:
            Comparison analysis
        """
        analysis1 = self.analyze_name(name1)
        analysis2 = self.analyze_name(name2)
        
        # Compare tension metrics
        tension_comparison = self.tension_scorer.compare_tensions(
            analysis1.tension_metrics, 
            analysis2.tension_metrics
        )
        
        # Compare essence characteristics
        essence_comparison = self._compare_essences(analysis1.essence, analysis2.essence)
        
        # Compare trace networks
        network_comparison = self._compare_networks(
            analysis1.trace_network, 
            analysis2.trace_network
        )
        
        return {
            'name1': name1,
            'name2': name2,
            'tension_comparison': tension_comparison,
            'essence_comparison': essence_comparison,
            'network_comparison': network_comparison,
            'dominant_name': self._determine_dominant_name(analysis1, analysis2),
            'synthesis_potential': self._calculate_synthesis_potential(analysis1, analysis2)
        }
    
    def extract_meaning_traces(self, name: str, focus_type: Optional[str] = None) -> Dict[str, Any]:
        """
        Extract meaning traces with optional focus on specific polarity types.
        
        Args:
            name: Name to analyze
            focus_type: Optional focus ('phonetic', 'structural', 'emotional')
            
        Returns:
            Focused trace analysis
        """
        analysis = self.analyze_name(name)
        
        # Filter traces by focus type if specified
        if focus_type:
            focused_traces = [
                trace for trace in analysis.trace_network.traces
                if trace.duality_pair.positive_pole.polarity_type.value == focus_type
            ]
        else:
            focused_traces = analysis.trace_network.traces
        
        # Extract key pathways
        pathways = []
        for trace in focused_traces:
            pathway = {
                'from_pole': trace.duality_pair.negative_pole.name,
                'to_pole': trace.duality_pair.positive_pole.name,
                'tension_peak': max(p.tension_level for p in trace.points),
                'resonance_pattern': trace.dominant_frequencies,
                'curvature': trace.curvature,
                'key_characteristics': self._extract_key_characteristics(trace)
            }
            pathways.append(pathway)
        
        return {
            'name': name,
            'focus_type': focus_type,
            'pathways': pathways,
            'network_coherence': analysis.trace_network.network_coherence,
            'emergent_patterns': analysis.trace_network.emergent_patterns
        }
    
    def _create_summary(self, name: str, essence: Essence, dualities: List[DualityPair], 
                       tension_metrics: TensionMetrics, trace_network: TraceNetwork) -> Dict[str, Any]:
        """Create a summary of the analysis."""
        return {
            'name_length': len(name),
            'essence_summary': {
                'phonetic_weight': round(essence.phonetic_weight, 3),
                'semantic_density': round(essence.semantic_density, 3),
                'emotional_resonance': round(essence.emotional_resonance, 3),
                'key_anchors': list(essence.conceptual_anchors)[:3]  # Top 3 anchors
            },
            'tension_summary': {
                'overall_tension': round(tension_metrics.overall_tension, 3),
                'dominant_tension_type': self._identify_dominant_tension_type(tension_metrics),
                'equilibrium_point': round(tension_metrics.equilibrium_point, 3),
                'stability': round(self.tension_scorer.calculate_tension_stability(dualities), 3)
            },
            'trace_summary': {
                'total_traces': len(trace_network.traces),
                'network_coherence': round(trace_network.network_coherence, 3),
                'intersections': len(trace_network.intersection_points),
                'emergent_patterns': trace_network.emergent_patterns
            },
            'duality_count': len(dualities),
            'complexity_score': self._calculate_overall_complexity(essence, tension_metrics, trace_network)
        }
    
    def _identify_dominant_tension_type(self, tension_metrics: TensionMetrics) -> str:
        """Identify the dominant type of tension."""
        tensions = {
            'phonetic': tension_metrics.phonetic_tension,
            'structural': tension_metrics.structural_tension,
            'emotional': tension_metrics.emotional_tension
        }
        return max(tensions, key=tensions.get)
    
    def _calculate_overall_complexity(self, essence: Essence, tension_metrics: TensionMetrics, 
                                    trace_network: TraceNetwork) -> float:
        """Calculate overall complexity score."""
        essence_complexity = (essence.morphological_complexity + essence.semantic_density) / 2
        tension_complexity = tension_metrics.overall_tension
        network_complexity = trace_network.network_coherence * len(trace_network.traces) / 10
        
        return round((essence_complexity + tension_complexity + network_complexity) / 3, 3)
    
    def _compare_essences(self, essence1: Essence, essence2: Essence) -> Dict[str, float]:
        """Compare two essences."""
        return {
            'phonetic_weight_diff': essence1.phonetic_weight - essence2.phonetic_weight,
            'semantic_density_diff': essence1.semantic_density - essence2.semantic_density,
            'morphological_complexity_diff': essence1.morphological_complexity - essence2.morphological_complexity,
            'emotional_resonance_diff': essence1.emotional_resonance - essence2.emotional_resonance,
            'anchor_overlap': len(essence1.conceptual_anchors & essence2.conceptual_anchors) / 
                            max(len(essence1.conceptual_anchors | essence2.conceptual_anchors), 1)
        }
    
    def _compare_networks(self, network1: TraceNetwork, network2: TraceNetwork) -> Dict[str, Any]:
        """Compare two trace networks."""
        return {
            'trace_count_diff': len(network1.traces) - len(network2.traces),
            'coherence_diff': network1.network_coherence - network2.network_coherence,
            'intersection_count_diff': len(network1.intersection_points) - len(network2.intersection_points),
            'common_patterns': list(set(network1.emergent_patterns) & set(network2.emergent_patterns)),
            'unique_patterns_1': list(set(network1.emergent_patterns) - set(network2.emergent_patterns)),
            'unique_patterns_2': list(set(network2.emergent_patterns) - set(network1.emergent_patterns))
        }
    
    def _determine_dominant_name(self, analysis1: NameAnalysis, analysis2: NameAnalysis) -> str:
        """Determine which name has stronger tension dynamics."""
        score1 = (analysis1.tension_metrics.overall_tension + 
                 analysis1.trace_network.network_coherence + 
                 len(analysis1.dualities) / 10)
        
        score2 = (analysis2.tension_metrics.overall_tension + 
                 analysis2.trace_network.network_coherence + 
                 len(analysis2.dualities) / 10)
        
        if score1 > score2:
            return analysis1.name
        elif score2 > score1:
            return analysis2.name
        else:
            return "balanced"
    
    def _calculate_synthesis_potential(self, analysis1: NameAnalysis, analysis2: NameAnalysis) -> float:
        """Calculate potential for synthesizing the two names."""
        # High synthesis potential when names have complementary tensions
        
        # Check for complementary tension types
        t1 = analysis1.tension_metrics
        t2 = analysis2.tension_metrics
        
        complementarity = 0.0
        
        # Complementary if one is high where the other is low
        if t1.phonetic_tension > 0.5 and t2.phonetic_tension < 0.5:
            complementarity += 0.3
        if t1.structural_tension > 0.5 and t2.structural_tension < 0.5:
            complementarity += 0.3
        if t1.emotional_tension > 0.5 and t2.emotional_tension < 0.5:
            complementarity += 0.4
        
        # Check for harmonic resonance
        harmonic_bonus = min(t1.harmonic_resonance, t2.harmonic_resonance) * 0.5
        
        # Check for pattern compatibility
        common_patterns = len(set(analysis1.trace_network.emergent_patterns) & 
                            set(analysis2.trace_network.emergent_patterns))
        pattern_bonus = common_patterns * 0.1
        
        synthesis_potential = complementarity + harmonic_bonus + pattern_bonus
        return min(synthesis_potential, 1.0)
    
    def _extract_key_characteristics(self, trace) -> List[str]:
        """Extract key characteristics from a trace."""
        # Find the most significant characteristics across all trace points
        char_totals = {}
        for point in trace.points:
            for char, value in point.characteristics.items():
                char_totals[char] = char_totals.get(char, 0) + value
        
        # Return top 3 characteristics
        sorted_chars = sorted(char_totals.items(), key=lambda x: x[1], reverse=True)
        return [char for char, _ in sorted_chars[:3]]