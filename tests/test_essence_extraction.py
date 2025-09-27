"""Tests for the Essence Extraction module."""

import pytest
from tension.essence_extraction import EssenceExtractor, Essence


class TestEssenceExtractor:
    
    def setup_method(self):
        self.extractor = EssenceExtractor()
    
    def test_extract_empty_name(self):
        """Test extraction from empty name."""
        essence = self.extractor.extract("")
        assert essence.phonetic_weight == 0.0
        assert essence.semantic_density == 0.0
        assert essence.morphological_complexity == 0.0
        assert essence.emotional_resonance == 0.0
        assert len(essence.conceptual_anchors) == 0
    
    def test_extract_simple_name(self):
        """Test extraction from simple name."""
        essence = self.extractor.extract("Anna")
        assert isinstance(essence, Essence)
        assert essence.phonetic_weight > 0
        assert essence.semantic_density > 0
        assert len(essence.conceptual_anchors) > 0
        # Anna should be classified as medium_form (4 characters)
        assert "medium_form" in essence.conceptual_anchors
    
    def test_extract_complex_name(self):
        """Test extraction from complex name."""
        essence = self.extractor.extract("Alexander")
        assert essence.morphological_complexity > 0
        assert "long_form" in essence.conceptual_anchors
        # Test complexity comparison with a very simple name
        short_essence = self.extractor.extract("A")
        assert essence.morphological_complexity >= short_essence.morphological_complexity
    
    def test_phonetic_weight_calculation(self):
        """Test phonetic weight calculation."""
        # Vowel-heavy name should have different weight than consonant-heavy
        vowel_heavy = self.extractor.extract("Aea")
        consonant_heavy = self.extractor.extract("Brd")
        assert vowel_heavy.phonetic_weight != consonant_heavy.phonetic_weight
    
    def test_semantic_density_uniqueness(self):
        """Test semantic density reflects character uniqueness."""
        # Names with more unique characters should have higher density
        unique_chars = self.extractor.extract("abcdef")
        repeated_chars = self.extractor.extract("aaaaaa")
        assert unique_chars.semantic_density > repeated_chars.semantic_density
    
    def test_emotional_resonance_patterns(self):
        """Test emotional resonance detection."""
        name_with_liquids = self.extractor.extract("Laura")
        name_with_stops = self.extractor.extract("Kate")
        # Both should have some emotional resonance
        assert name_with_liquids.emotional_resonance > 0
        assert name_with_stops.emotional_resonance > 0
    
    def test_conceptual_anchors_categories(self):
        """Test conceptual anchor categorization."""
        short_name = self.extractor.extract("Jo")
        medium_name = self.extractor.extract("David")
        long_name = self.extractor.extract("Alexander")
        
        assert "short_form" in short_name.conceptual_anchors
        assert "medium_form" in medium_name.conceptual_anchors
        assert "long_form" in long_name.conceptual_anchors
    
    def test_vowel_consonant_balance(self):
        """Test vowel/consonant balance detection."""
        vowel_dominant = self.extractor.extract("Aiea")
        consonant_dominant = self.extractor.extract("Brdj")
        
        assert "vowel_dominant" in vowel_dominant.conceptual_anchors
        assert "consonant_dominant" in consonant_dominant.conceptual_anchors
    
    def test_alternation_score(self):
        """Test vowel-consonant alternation scoring."""
        alternating = "ababa"
        non_alternating = "aaabbb"
        
        alt_score = self.extractor._calculate_alternation_score(alternating)
        non_alt_score = self.extractor._calculate_alternation_score(non_alternating)
        
        assert alt_score > non_alt_score
    
    def test_morphological_complexity_patterns(self):
        """Test morphological complexity detection."""
        # Names with clusters should be more complex
        clustered = self.extractor.extract("strong")
        simple = self.extractor.extract("Ana")
        
        assert clustered.morphological_complexity >= simple.morphological_complexity