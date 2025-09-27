"""
Essence Extraction Module

Extracts essence from names and concepts, identifying core semantic features
that contribute to tension dynamics.
"""

import re
from typing import Dict, List, Set, Tuple
from dataclasses import dataclass


@dataclass
class Essence:
    """Represents extracted essence from a name or concept."""
    phonetic_weight: float
    semantic_density: float
    morphological_complexity: float
    emotional_resonance: float
    conceptual_anchors: Set[str]


class EssenceExtractor:
    """Extracts essence from names and linguistic constructs."""
    
    def __init__(self):
        self.vowel_weights = {'a': 0.8, 'e': 0.6, 'i': 0.9, 'o': 0.7, 'u': 0.85}
        self.consonant_weights = {
            'b': 0.4, 'c': 0.5, 'd': 0.45, 'f': 0.6, 'g': 0.5,
            'h': 0.3, 'j': 0.7, 'k': 0.6, 'l': 0.4, 'm': 0.5,
            'n': 0.4, 'p': 0.5, 'q': 0.8, 'r': 0.7, 's': 0.6,
            't': 0.5, 'v': 0.6, 'w': 0.4, 'x': 0.9, 'y': 0.7, 'z': 0.8
        }
        
    def extract(self, name: str) -> Essence:
        """Extract essence from a given name."""
        name_clean = re.sub(r'[^a-zA-Z]', '', name.lower())
        
        phonetic_weight = self._calculate_phonetic_weight(name_clean)
        semantic_density = self._calculate_semantic_density(name_clean)
        morphological_complexity = self._calculate_morphological_complexity(name_clean)
        emotional_resonance = self._calculate_emotional_resonance(name_clean)
        conceptual_anchors = self._identify_conceptual_anchors(name_clean)
        
        return Essence(
            phonetic_weight=phonetic_weight,
            semantic_density=semantic_density,
            morphological_complexity=morphological_complexity,
            emotional_resonance=emotional_resonance,
            conceptual_anchors=conceptual_anchors
        )
    
    def _calculate_phonetic_weight(self, name: str) -> float:
        """Calculate phonetic weight based on sound patterns."""
        if not name:
            return 0.0
            
        total_weight = 0.0
        for char in name:
            if char in self.vowel_weights:
                total_weight += self.vowel_weights[char]
            elif char in self.consonant_weights:
                total_weight += self.consonant_weights[char]
                
        return total_weight / len(name) if name else 0.0
    
    def _calculate_semantic_density(self, name: str) -> float:
        """Calculate semantic density using length and repetition patterns."""
        if not name:
            return 0.0
            
        unique_chars = len(set(name))
        total_chars = len(name)
        repetition_factor = 1.0 - (unique_chars / total_chars) if total_chars > 0 else 0.0
        
        # Higher density for names with unique character patterns
        density = (unique_chars / max(total_chars, 1)) * (1 + repetition_factor)
        return min(density, 1.0)
    
    def _calculate_morphological_complexity(self, name: str) -> float:
        """Calculate morphological complexity based on structure patterns."""
        if not name:
            return 0.0
            
        # Patterns that increase complexity
        vowel_clusters = len(re.findall(r'[aeiou]{2,}', name))
        consonant_clusters = len(re.findall(r'[bcdfghjklmnpqrstvwxyz]{2,}', name))
        alternation_score = self._calculate_alternation_score(name)
        
        # Longer names have base complexity
        length_factor = min(len(name) / 10.0, 0.5)  # Base complexity from length
        
        complexity = length_factor + (vowel_clusters * 0.1 + consonant_clusters * 0.15 + alternation_score * 0.1)
        return min(complexity, 1.0)
    
    def _calculate_alternation_score(self, name: str) -> float:
        """Calculate vowel-consonant alternation score."""
        if len(name) < 2:
            return 0.0
            
        alternations = 0
        vowels = set('aeiou')
        
        for i in range(len(name) - 1):
            curr_is_vowel = name[i] in vowels
            next_is_vowel = name[i + 1] in vowels
            if curr_is_vowel != next_is_vowel:
                alternations += 1
                
        return alternations / (len(name) - 1) if len(name) > 1 else 0.0
    
    def _calculate_emotional_resonance(self, name: str) -> float:
        """Calculate emotional resonance based on sound psychology."""
        if not name:
            return 0.0
            
        # Sounds that typically carry emotional weight
        emotional_patterns = {
            r'[aeiou]': 0.1,  # Vowels create openness
            r'[rl]': 0.15,    # Liquids create flow
            r'[mn]': 0.1,     # Nasals create depth
            r'[ptkbdg]': 0.2, # Stops create impact
            r'[sz]': 0.1,     # Sibilants create texture
        }
        
        resonance = 0.0
        for pattern, weight in emotional_patterns.items():
            matches = len(re.findall(pattern, name))
            resonance += matches * weight
            
        return min(resonance / len(name) if name else 0.0, 1.0)
    
    def _identify_conceptual_anchors(self, name: str) -> Set[str]:
        """Identify conceptual anchors - recurring patterns that anchor meaning."""
        anchors = set()
        
        if not name:
            return anchors
        
        # Common morphological patterns
        if len(name) >= 3:
            # Prefixes and suffixes
            anchors.add(f"prefix_{name[:2]}")
            anchors.add(f"suffix_{name[-2:]}")
            
        # Phonetic patterns
        vowels_count = sum(1 for c in name if c in 'aeiou')
        consonants_count = len(name) - vowels_count
        
        if vowels_count > consonants_count:
            anchors.add("vowel_dominant")
        elif consonants_count > vowels_count:
            anchors.add("consonant_dominant")
        elif len(name) > 0:  # Only add if name has content
            anchors.add("balanced_phonetics")
            
        # Length categories
        if len(name) <= 3:
            anchors.add("short_form")
        elif len(name) <= 6:
            anchors.add("medium_form")
        else:
            anchors.add("long_form")
            
        return anchors