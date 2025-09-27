"""
Duality Mapping Module

Maps dual poles and relationships within names and concepts,
identifying opposing forces that create tension dynamics.
"""

from typing import Dict, List, Tuple, Set, Optional
from dataclasses import dataclass
from enum import Enum
import numpy as np


class PolarityType(Enum):
    """Types of polarity relationships."""
    PHONETIC = "phonetic"
    SEMANTIC = "semantic" 
    STRUCTURAL = "structural"
    TEMPORAL = "temporal"
    EMOTIONAL = "emotional"


@dataclass
class Pole:
    """Represents one pole of a duality."""
    name: str
    weight: float
    characteristics: Set[str]
    polarity_type: PolarityType


@dataclass
class DualityPair:
    """Represents a pair of opposing poles."""
    positive_pole: Pole
    negative_pole: Pole
    tension_magnitude: float
    resonance_frequency: float


class DualityMapper:
    """Maps dualities within names and concepts."""
    
    def __init__(self):
        self.polarity_patterns = {
            # Phonetic oppositions
            PolarityType.PHONETIC: {
                'vowel_consonant': (['a', 'e', 'i', 'o', 'u'], ['b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'q', 'r', 's', 't', 'v', 'w', 'x', 'y', 'z']),
                'front_back': (['i', 'e'], ['u', 'o', 'a']),
                'high_low': (['i', 'u'], ['a', 'e', 'o']),
                'voiced_voiceless': (['b', 'd', 'g', 'v', 'z'], ['p', 't', 'k', 'f', 's'])
            },
            # Structural oppositions
            PolarityType.STRUCTURAL: {
                'beginning_end': ('prefix', 'suffix'),
                'simple_complex': ('short', 'long'),
                'regular_irregular': ('pattern', 'exception')
            },
            # Emotional oppositions
            PolarityType.EMOTIONAL: {
                'soft_hard': (['l', 'r', 'm', 'n'], ['k', 't', 'p', 'b']),
                'open_closed': (['a', 'o'], ['i', 'u']),
                'flow_stop': (['l', 'r', 'y', 'w'], ['p', 't', 'k', 'b', 'd', 'g'])
            }
        }
        
    def map_dualities(self, name: str, essence=None) -> List[DualityPair]:
        """Map all dualities present in a name."""
        name_clean = name.lower().replace(' ', '').replace('-', '').replace('_', '')
        dualities = []
        
        # Map phonetic dualities
        phonetic_dualities = self._map_phonetic_dualities(name_clean)
        dualities.extend(phonetic_dualities)
        
        # Map structural dualities
        structural_dualities = self._map_structural_dualities(name_clean)
        dualities.extend(structural_dualities)
        
        # Map emotional dualities
        emotional_dualities = self._map_emotional_dualities(name_clean)
        dualities.extend(emotional_dualities)
        
        return dualities
    
    def _map_phonetic_dualities(self, name: str) -> List[DualityPair]:
        """Map phonetic dualities within the name."""
        dualities = []
        
        for pattern_name, (positive_chars, negative_chars) in self.polarity_patterns[PolarityType.PHONETIC].items():
            positive_count = sum(1 for c in name if c in positive_chars)
            negative_count = sum(1 for c in name if c in negative_chars)
            
            if positive_count > 0 and negative_count > 0:
                total_chars = len(name)
                positive_weight = positive_count / total_chars
                negative_weight = negative_count / total_chars
                
                positive_pole = Pole(
                    name=f"{pattern_name}_positive",
                    weight=positive_weight,
                    characteristics={f"contains_{c}" for c in positive_chars if c in name},
                    polarity_type=PolarityType.PHONETIC
                )
                
                negative_pole = Pole(
                    name=f"{pattern_name}_negative", 
                    weight=negative_weight,
                    characteristics={f"contains_{c}" for c in negative_chars if c in name},
                    polarity_type=PolarityType.PHONETIC
                )
                
                tension_magnitude = self._calculate_tension_magnitude(positive_weight, negative_weight)
                resonance_frequency = self._calculate_resonance_frequency(positive_count, negative_count, len(name))
                
                dualities.append(DualityPair(
                    positive_pole=positive_pole,
                    negative_pole=negative_pole,
                    tension_magnitude=tension_magnitude,
                    resonance_frequency=resonance_frequency
                ))
                
        return dualities
    
    def _map_structural_dualities(self, name: str) -> List[DualityPair]:
        """Map structural dualities within the name."""
        dualities = []
        
        if len(name) >= 4:  # Need sufficient length for structural analysis
            # Beginning vs End duality
            prefix_weight = self._calculate_positional_weight(name[:len(name)//2])
            suffix_weight = self._calculate_positional_weight(name[len(name)//2:])
            
            if prefix_weight != suffix_weight:
                positive_pole = Pole(
                    name="beginning_emphasis",
                    weight=prefix_weight,
                    characteristics={f"prefix_dominant"},
                    polarity_type=PolarityType.STRUCTURAL
                )
                
                negative_pole = Pole(
                    name="ending_emphasis",
                    weight=suffix_weight, 
                    characteristics={f"suffix_dominant"},
                    polarity_type=PolarityType.STRUCTURAL
                )
                
                tension_magnitude = abs(prefix_weight - suffix_weight)
                resonance_frequency = (prefix_weight + suffix_weight) / 2
                
                dualities.append(DualityPair(
                    positive_pole=positive_pole,
                    negative_pole=negative_pole,
                    tension_magnitude=tension_magnitude,
                    resonance_frequency=resonance_frequency
                ))
        
        # Simple vs Complex duality
        complexity_score = self._calculate_complexity_score(name)
        simplicity_score = 1.0 - complexity_score
        
        if complexity_score > 0.1 and simplicity_score > 0.1:
            positive_pole = Pole(
                name="complexity",
                weight=complexity_score,
                characteristics={"complex_structure"},
                polarity_type=PolarityType.STRUCTURAL
            )
            
            negative_pole = Pole(
                name="simplicity",
                weight=simplicity_score,
                characteristics={"simple_structure"},
                polarity_type=PolarityType.STRUCTURAL
            )
            
            tension_magnitude = abs(complexity_score - simplicity_score)
            resonance_frequency = (complexity_score + simplicity_score) / 2
            
            dualities.append(DualityPair(
                positive_pole=positive_pole,
                negative_pole=negative_pole,
                tension_magnitude=tension_magnitude,
                resonance_frequency=resonance_frequency
            ))
            
        return dualities
    
    def _map_emotional_dualities(self, name: str) -> List[DualityPair]:
        """Map emotional dualities within the name."""
        dualities = []
        
        for pattern_name, (soft_chars, hard_chars) in self.polarity_patterns[PolarityType.EMOTIONAL].items():
            soft_count = sum(1 for c in name if c in soft_chars)
            hard_count = sum(1 for c in name if c in hard_chars)
            
            if soft_count > 0 and hard_count > 0:
                total_relevant = soft_count + hard_count
                soft_weight = soft_count / total_relevant
                hard_weight = hard_count / total_relevant
                
                positive_pole = Pole(
                    name=f"{pattern_name}_soft",
                    weight=soft_weight,
                    characteristics={f"soft_{c}" for c in soft_chars if c in name},
                    polarity_type=PolarityType.EMOTIONAL
                )
                
                negative_pole = Pole(
                    name=f"{pattern_name}_hard",
                    weight=hard_weight,
                    characteristics={f"hard_{c}" for c in hard_chars if c in name},
                    polarity_type=PolarityType.EMOTIONAL
                )
                
                tension_magnitude = abs(soft_weight - hard_weight)
                resonance_frequency = min(soft_weight, hard_weight) * 2  # Peak tension when balanced
                
                dualities.append(DualityPair(
                    positive_pole=positive_pole,
                    negative_pole=negative_pole,
                    tension_magnitude=tension_magnitude,
                    resonance_frequency=resonance_frequency
                ))
                
        return dualities
    
    def _calculate_tension_magnitude(self, weight1: float, weight2: float) -> float:
        """Calculate tension magnitude between two poles."""
        # Maximum tension occurs when poles are balanced
        balance_factor = 1.0 - abs(weight1 - weight2)
        presence_factor = min(weight1, weight2) * 2  # Both must be present
        return balance_factor * presence_factor
    
    def _calculate_resonance_frequency(self, count1: int, count2: int, total_length: int) -> float:
        """Calculate resonance frequency based on alternation patterns."""
        if total_length <= 1:
            return 0.0
            
        # Simple approximation of alternation frequency
        total_relevant = count1 + count2
        if total_relevant == 0:
            return 0.0
            
        # Higher frequency when elements alternate more
        alternation_potential = min(count1, count2) * 2 / total_length
        return alternation_potential
    
    def _calculate_positional_weight(self, segment: str) -> float:
        """Calculate positional weight for a segment of the name."""
        if not segment:
            return 0.0
            
        # Weight based on vowel density and character variety
        vowel_count = sum(1 for c in segment if c in 'aeiou')
        unique_chars = len(set(segment))
        
        vowel_density = vowel_count / len(segment) if segment else 0.0
        variety_factor = unique_chars / len(segment) if segment else 0.0
        
        return (vowel_density + variety_factor) / 2
    
    def _calculate_complexity_score(self, name: str) -> float:
        """Calculate structural complexity score."""
        if not name:
            return 0.0
            
        # Factors contributing to complexity
        length_complexity = min(len(name) / 10.0, 1.0)  # Longer names are more complex
        variety_complexity = len(set(name)) / len(name) if name else 0.0
        
        # Pattern complexity (repeated patterns reduce complexity)
        pattern_repetition = 0
        for i in range(len(name) - 1):
            for j in range(i + 2, len(name)):
                if name[i:i+2] == name[j:j+2]:
                    pattern_repetition += 1
                    
        pattern_complexity = 1.0 - min(pattern_repetition / max(len(name) - 1, 1), 1.0)
        
        return (length_complexity + variety_complexity + pattern_complexity) / 3