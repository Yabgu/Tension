"""Tests for the main Tension Engine."""

import pytest
from tension.engine import TensionEngine, NameAnalysis


class TestTensionEngine:
    
    def setup_method(self):
        self.engine = TensionEngine()
    
    def test_analyze_simple_name(self):
        """Test analysis of a simple name."""
        analysis = self.engine.analyze_name("Anna")
        
        assert isinstance(analysis, NameAnalysis)
        assert analysis.name == "Anna"
        assert analysis.essence is not None
        assert len(analysis.dualities) >= 0
        assert analysis.tension_metrics is not None
        assert analysis.trace_network is not None
        assert analysis.summary is not None
    
    def test_analyze_complex_name(self):
        """Test analysis of a complex name."""
        analysis = self.engine.analyze_name("Alexander")
        
        # Complex names should have more dualities and traces
        assert len(analysis.dualities) > 0
        assert len(analysis.trace_network.traces) > 0
        assert analysis.tension_metrics.overall_tension >= 0
    
    def test_compare_names(self):
        """Test name comparison functionality."""
        comparison = self.engine.compare_names("Anna", "Alexander")
        
        assert comparison['name1'] == "Anna"
        assert comparison['name2'] == "Alexander"
        assert 'tension_comparison' in comparison
        assert 'essence_comparison' in comparison
        assert 'network_comparison' in comparison
        assert 'dominant_name' in comparison
        assert 'synthesis_potential' in comparison
        
        # Synthesis potential should be between 0 and 1
        assert 0 <= comparison['synthesis_potential'] <= 1
    
    def test_extract_meaning_traces(self):
        """Test meaning trace extraction."""
        traces = self.engine.extract_meaning_traces("David")
        
        assert traces['name'] == "David"
        assert 'pathways' in traces
        assert 'network_coherence' in traces
        assert 'emergent_patterns' in traces
    
    def test_extract_meaning_traces_with_focus(self):
        """Test focused meaning trace extraction."""
        traces = self.engine.extract_meaning_traces("Alexander", focus_type='phonetic')
        
        assert traces['focus_type'] == 'phonetic'
        # Should only include phonetic traces (or be empty if no phonetic dualities found)
        if traces['pathways']:
            for pathway in traces['pathways']:
                # The pathway names should contain patterns from phonetic dualities
                assert any(keyword in pathway['from_pole'] for keyword in ['vowel', 'consonant', 'front', 'back', 'high', 'low', 'voiced', 'voiceless']) or \
                       any(keyword in pathway['to_pole'] for keyword in ['vowel', 'consonant', 'front', 'back', 'high', 'low', 'voiced', 'voiceless'])
    
    def test_summary_structure(self):
        """Test that summary has expected structure."""
        analysis = self.engine.analyze_name("Maria")
        summary = analysis.summary
        
        required_keys = [
            'name_length', 'essence_summary', 'tension_summary',
            'trace_summary', 'duality_count', 'complexity_score'
        ]
        
        for key in required_keys:
            assert key in summary
        
        # Check essence summary structure
        essence_keys = ['phonetic_weight', 'semantic_density', 'emotional_resonance', 'key_anchors']
        for key in essence_keys:
            assert key in summary['essence_summary']
        
        # Check tension summary structure
        tension_keys = ['overall_tension', 'dominant_tension_type', 'equilibrium_point', 'stability']
        for key in tension_keys:
            assert key in summary['tension_summary']
    
    def test_name_comparison_symmetry(self):
        """Test that name comparison handles order properly."""
        comp1 = self.engine.compare_names("Anna", "David")
        comp2 = self.engine.compare_names("David", "Anna")
        
        # Tension differences should be opposite
        assert comp1['tension_comparison']['overall_tension_diff'] == -comp2['tension_comparison']['overall_tension_diff']
    
    def test_empty_name_handling(self):
        """Test handling of empty or invalid names."""
        analysis = self.engine.analyze_name("")
        
        # Should not crash and should return valid structure
        assert isinstance(analysis, NameAnalysis)
        assert analysis.tension_metrics.overall_tension == 0.0
    
    def test_single_character_name(self):
        """Test handling of single character names."""
        analysis = self.engine.analyze_name("A")
        
        assert isinstance(analysis, NameAnalysis)
        assert analysis.name == "A"
        # Should have minimal complexity
        assert analysis.summary['complexity_score'] >= 0
    
    def test_dominant_name_determination(self):
        """Test dominant name determination logic."""
        # Create analyses with different characteristics
        analysis1 = self.engine.analyze_name("A")  # Simple
        analysis2 = self.engine.analyze_name("Alexander")  # Complex
        
        # Complex name should generally be dominant
        dominant = self.engine._determine_dominant_name(analysis1, analysis2)
        assert dominant in ["A", "Alexander", "balanced"]
    
    def test_synthesis_potential_calculation(self):
        """Test synthesis potential calculation."""
        analysis1 = self.engine.analyze_name("Anna")
        analysis2 = self.engine.analyze_name("David")
        
        potential = self.engine._calculate_synthesis_potential(analysis1, analysis2)
        assert 0 <= potential <= 1
    
    def test_complexity_score_range(self):
        """Test that complexity scores are in reasonable range."""
        names = ["A", "Jo", "Anna", "David", "Alexander", "Christopher"]
        
        for name in names:
            analysis = self.engine.analyze_name(name)
            complexity = analysis.summary['complexity_score']
            assert 0 <= complexity <= 1, f"Complexity {complexity} out of range for {name}"
    
    def test_tension_engine_consistency(self):
        """Test that engine produces consistent results."""
        # Same name should produce same results
        analysis1 = self.engine.analyze_name("Maria")
        analysis2 = self.engine.analyze_name("Maria")
        
        assert analysis1.tension_metrics.overall_tension == analysis2.tension_metrics.overall_tension
        assert analysis1.essence.phonetic_weight == analysis2.essence.phonetic_weight