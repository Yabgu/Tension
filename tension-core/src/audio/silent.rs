//! A silent audio adapter: the contract's full shape, and no device.
//!
//! **Why this exists alongside `headless`.** `headless` renders the guest's PCM
//! to a WAV file, which is what a CI assertion wants and what a no-device build
//! falls back to. Neither is right for a sandboxed guest: it must not open a
//! device (the `cpal` `Stream` is `!Send` on ALSA and the audio session is a
//! process singleton — `host/mod.rs`, item 2), and it must not write a file into
//! the working directory either, because a nested run's side effects are the
//! outer run's surprises.
//!
//! So this adapter accepts every call and produces nothing. That is a deliberate
//! choice over refusing `audio_init`: a nested game that aborts because its
//! audio device is missing would make Play Mode unable to run exactly the games
//! that use sound, and the honest degradation for audio in a nested run is
//! "silent", not "broken". When forwarding lands — the nested guest's verbs
//! feeding a host mixer thread — this is the adapter that gets replaced, and the
//! guest-side contract does not change.
//!
//! Compiled unconditionally, under every feature combination, because a sandbox
//! has to exist in all of them.

use crate::audio::{AudioAdapter, MAX_VOICES};

pub struct SilentAdapter {
    /// Voice ids are handed out from 1 upwards; `live[i]` says whether voice
    /// `i + 1` is playing. A fixed table, because the contract's voice count is
    /// fixed (`MAX_VOICES`) and a guest cannot exceed it.
    live: [bool; MAX_VOICES],
    next_id: i32,
}

impl SilentAdapter {
    pub fn new() -> Self {
        Self {
            live: [false; MAX_VOICES],
            next_id: 0,
        }
    }

    fn slot(voice: i32) -> Option<usize> {
        if voice >= 1 && (voice as usize) <= MAX_VOICES {
            Some(voice as usize - 1)
        } else {
            None
        }
    }
}

impl Default for SilentAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioAdapter for SilentAdapter {
    fn do_init(&mut self, _sample_rate: i32, _channels: i32) -> i32 {
        0
    }

    fn do_play(&mut self, _pcm: &[f32], _rate: i32, _gain: f32, _loop: bool) -> i32 {
        // An empty PCM is refused by the gate above this adapter; a non-empty one
        // gets a voice id, so the guest's `audio_play` answers what it would have
        // answered on a real device.
        if let Some(slot) = Self::slot(self.next_id + 1) {
            self.next_id += 1;
            self.live[slot] = true;
            return self.next_id;
        }
        // All voices handed out at least once: reuse the lowest free one, which
        // is what a real mixer does rather than refusing the 33rd sound.
        match self.live.iter().position(|live| !live) {
            Some(slot) => {
                self.live[slot] = true;
                slot as i32 + 1
            }
            None => -1,
        }
    }

    fn do_stop(&mut self, voice: i32) -> i32 {
        match Self::slot(voice) {
            Some(slot) if self.live[slot] => {
                self.live[slot] = false;
                0
            }
            _ => -1,
        }
    }

    fn do_set_gain(&mut self, voice: i32, _gain: f32) -> i32 {
        match Self::slot(voice) {
            Some(slot) if self.live[slot] => 0,
            _ => -1,
        }
    }

    fn voice_state(&mut self, voice: i32) -> i32 {
        match Self::slot(voice) {
            Some(slot) if self.live[slot] => 1,
            Some(_) => 0,
            None => -1,
        }
    }

    fn do_shutdown(&mut self) -> i32 {
        self.live = [false; MAX_VOICES];
        self.next_id = 0;
        0
    }
}
