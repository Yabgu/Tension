//! Filtering: one threshold per logger name, log4j-style.
//!
//! A record passes when its level is at least the threshold in force for its
//! logger name. Resolution is by **ancestor**: the name itself is tried first,
//! then each of its prefixes, and the global threshold is the final fallback.
//! A segment boundary is either `:` or `.`, so `audio:real:decode` consults
//! `audio:real:decode`, `audio:real`, `audio`, and then the global threshold —
//! which is what lets `--log-level=audio:warn` quiet the whole subsystem and
//! `--log-level=audio:real:debug` reopen one channel inside it.
//!
//! Names are matched exactly at each step (no wildcards); a name is a
//! namespace, not a pattern.

use super::level::{Level, Threshold};

/// A resolved filter: a global threshold plus per-name overrides.
#[derive(Clone, Debug)]
pub struct Filter {
    global: Threshold,
    overrides: Vec<(String, Threshold)>,
}

impl Filter {
    /// A filter with no overrides.
    pub fn new(global: Threshold) -> Filter {
        Filter {
            global,
            overrides: Vec::new(),
        }
    }

    /// A filter built from a parsed config's thresholds.
    pub fn from_config(config: &super::config::Config) -> Filter {
        let mut filter = Filter::new(config.global);
        for (name, threshold) in &config.overrides {
            filter.set(name, *threshold);
        }
        filter
    }

    /// Set (or replace) an override. The last write for a name wins, which is
    /// what makes a later `--log-level` flag override an earlier one.
    pub fn set(&mut self, name: &str, threshold: Threshold) {
        if let Some(existing) = self.overrides.iter_mut().find(|(known, _)| known == name) {
            existing.1 = threshold;
        } else {
            self.overrides.push((name.to_string(), threshold));
        }
    }

    /// The threshold in force for `name`: the nearest ancestor override, or the
    /// global threshold when the name and none of its ancestors is configured.
    pub fn threshold_for(&self, name: &str) -> Threshold {
        for ancestor in ancestors(name) {
            if let Some((_, threshold)) = self.overrides.iter().find(|(known, _)| known == ancestor)
            {
                return *threshold;
            }
        }
        self.global
    }

    /// Whether a record at `level` from logger `name` passes.
    pub fn allows(&self, name: &str, level: Level) -> bool {
        self.threshold_for(name).allows(level)
    }
}

/// The name and its ancestors, longest first.
///
/// `a.b:c` yields `a.b:c`, `a.b`, then `a` and stops — the first segment has no
/// separator before it. The empty string is never yielded, so the global
/// threshold is always the floor.
fn ancestors(name: &str) -> impl Iterator<Item = &str> {
    std::iter::successors(Some(name), |current| {
        current
            .rfind(|c| c == ':' || c == '.')
            .map(|boundary| &current[..boundary])
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::config::Config;

    #[test]
    fn an_unconfigured_name_uses_the_global_threshold() {
        let filter = Filter::new(Threshold::At(Level::Warn));
        assert!(!filter.allows("anything", Level::Info));
        assert!(filter.allows("anything", Level::Error));
        assert_eq!(filter.threshold_for("anything"), Threshold::At(Level::Warn));
    }

    #[test]
    fn an_exact_override_beats_the_global() {
        let mut filter = Filter::new(Threshold::At(Level::Info));
        filter.set("ogre", Threshold::At(Level::Debug));
        assert!(filter.allows("ogre", Level::Debug));
        // A different name is untouched.
        assert!(!filter.allows("ai", Level::Debug));
    }

    #[test]
    fn an_ancestor_override_applies_to_a_descendant() {
        let mut filter = Filter::new(Threshold::At(Level::Info));
        filter.set("audio", Threshold::At(Level::Error));
        // `audio:real` inherits `audio`'s threshold.
        assert!(!filter.allows("audio:real", Level::Warn));
        assert!(filter.allows("audio:real", Level::Error));
        // And the dotted spelling walks the same chain.
        assert!(!filter.allows("audio.real.decode", Level::Warn));
    }

    #[test]
    fn the_nearest_ancestor_wins() {
        let mut filter = Filter::new(Threshold::At(Level::Info));
        filter.set("audio", Threshold::At(Level::Error));
        filter.set("audio:real", Threshold::At(Level::Debug));
        // The longer prefix is closer, so it decides.
        assert!(filter.allows("audio:real", Level::Debug));
        // A sibling stays on the parent's threshold.
        assert!(!filter.allows("audio:headless", Level::Warn));
    }

    #[test]
    fn a_name_that_is_a_prefix_does_not_match_a_sibling() {
        let mut filter = Filter::new(Threshold::At(Level::Info));
        filter.set("audio", Threshold::At(Level::Error));
        // `audiobook` does not have `audio` as a segment prefix.
        assert_eq!(filter.threshold_for("audiobook"), Threshold::At(Level::Info));
    }

    #[test]
    fn setting_a_name_twice_keeps_the_last() {
        let mut filter = Filter::new(Threshold::At(Level::Info));
        filter.set("ogre", Threshold::At(Level::Trace));
        filter.set("ogre", Threshold::At(Level::Error));
        assert_eq!(filter.threshold_for("ogre"), Threshold::At(Level::Error));
        assert_eq!(
            filter.overrides.iter().filter(|(n, _)| n == "ogre").count(),
            1,
            "one entry per name"
        );
    }

    #[test]
    fn off_quiets_everything_including_the_hierarchy() {
        let mut filter = Filter::new(Threshold::Off);
        assert!(!filter.allows("ogre", Level::Fatal));
        filter.set("ogre", Threshold::At(Level::Debug));
        assert!(filter.allows("ogre", Level::Debug));
        assert!(!filter.allows("ai", Level::Fatal));
    }

    #[test]
    fn from_config_carries_the_overrides() {
        let mut config = Config::default();
        config.set_level_spec("ogre:trace,audio:warn").expect("parses");
        let filter = Filter::from_config(&config);
        assert!(filter.allows("ogre", Level::Trace));
        assert!(!filter.allows("audio", Level::Info));
        assert!(filter.allows("audio", Level::Warn));
        // A name nothing named falls back to Info.
        assert!(!filter.allows("core", Level::Debug));
    }

    #[test]
    fn the_ancestor_chain_is_longest_first() {
        let chain: Vec<&str> = ancestors("a.b:c").collect();
        assert_eq!(chain, vec!["a.b:c", "a.b", "a"]);
        // A single segment is its own whole chain.
        let flat: Vec<&str> = ancestors("ogre").collect();
        assert_eq!(flat, vec!["ogre"]);
        let empty: Vec<&str> = ancestors("").collect();
        assert_eq!(empty, vec![""]);
    }
}
