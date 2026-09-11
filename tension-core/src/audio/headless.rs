//! Headless audio adapter.
//!
//! Implements the full `tension::audio` contract with no device and zero
//! audio dependencies: instead of driving a sound card it renders the
//! guest's PCM offline to a WAV file (`tension-audio.wav` in the working
//! directory, or the path given to `with_output`). It is the no-feature
//! fallback and the test adapter. Like the real adapter it is a sink: it
//! plays what the guest sends, it synthesises nothing.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::audio::{AudioAdapter, MAX_VOICES};

const DEFAULT_OUT: &str = "tension-audio.wav";

#[derive(Clone, Copy)]
struct VoiceRow {
    id: i32,
    loop_: bool,
    started: Instant,
    duration: Duration,
}

enum EventKind {
    Play { pcm: Arc<[f32]>, rate: u32, gain: f32, loop_: bool },
    Stop,
    SetGain { gain: f32 },
}

struct Event {
    /// Time in seconds since session start.
    t: f64,
    voice: i32,
    kind: EventKind,
}

struct Session {
    rate: u32,
    channels: u32,
    start: Instant,
    events: Vec<Event>,
}

pub struct HeadlessAdapter {
    next_id: i32,
    voices: [Option<VoiceRow>; MAX_VOICES],
    session: Option<Session>,
    out_path: PathBuf,
}

impl HeadlessAdapter {
    /// Render to `tension-audio.wav` in the process working directory.
    pub fn new() -> Self {
        Self::with_output(DEFAULT_OUT)
    }

    /// Render to the given path.
    pub fn with_output(path: impl Into<PathBuf>) -> Self {
        Self {
            next_id: 0,
            voices: [None; MAX_VOICES],
            session: None,
            out_path: path.into(),
        }
    }

    /// Lazily free every non-looping voice whose PCM duration has elapsed.
    fn expire_finished(&mut self) {
        for slot in &mut self.voices {
            if let Some(v) = slot {
                if !v.loop_ && v.started.elapsed() >= v.duration {
                    *slot = None;
                }
            }
        }
    }

    /// End the session: render everything recorded so far and write the
    /// WAV, then reset all bookkeeping. No-op when no session is open.
    fn flush(&mut self) {
        let Some(session) = self.session.take() else { return };
        self.voices = [None; MAX_VOICES];
        self.next_id = 0;

        let mut end = session.start.elapsed().as_secs_f64();
        for ev in &session.events {
            if let EventKind::Play { pcm, rate, loop_, .. } = &ev.kind {
                if !loop_ && *rate > 0 {
                    end = end.max(ev.t + pcm.len() as f64 / *rate as f64);
                }
            }
        }

        let mono = render_session(&session, end);
        let channels = session.channels.max(1) as usize;
        let mut interleaved = Vec::with_capacity(mono.len() * channels);
        for &s in &mono {
            for _ in 0..channels {
                interleaved.push(s);
            }
        }

        match write_wav(&self.out_path, session.rate, channels as u16, &interleaved) {
            Ok(()) => eprintln!(
                "[tension:audio:headless] wrote {} ({} frames, {:.2} s)",
                self.out_path.display(),
                mono.len(),
                mono.len() as f64 / session.rate as f64
            ),
            Err(e) => eprintln!(
                "[tension:audio:headless] failed to write {}: {e}",
                self.out_path.display()
            ),
        }
    }
}

impl Drop for HeadlessAdapter {
    fn drop(&mut self) {
        // A guest that never calls audio_shutdown still gets its render.
        self.flush();
    }
}

impl AudioAdapter for HeadlessAdapter {
    fn do_init(&mut self, sample_rate: i32, channels: i32) -> i32 {
        self.session = Some(Session {
            rate: sample_rate as u32,
            channels: channels as u32,
            start: Instant::now(),
            events: Vec::new(),
        });
        0
    }

    fn do_play(&mut self, pcm: &[f32], rate: i32, gain: f32, loop_: bool) -> i32 {
        self.expire_finished();
        let Some(free) = self.voices.iter_mut().find(|s| s.is_none()) else {
            return -1; // live-voice cap reached
        };
        if self.next_id == i32::MAX {
            return -1; // id space exhausted; never wrap
        }
        let id = self.next_id;
        self.next_id += 1;
        *free = Some(VoiceRow {
            id,
            loop_,
            started: Instant::now(),
            duration: Duration::from_secs_f64(pcm.len() as f64 / rate as f64),
        });
        if let Some(s) = &mut self.session {
            s.events.push(Event {
                t: s.start.elapsed().as_secs_f64(),
                voice: id,
                kind: EventKind::Play { pcm: Arc::<[f32]>::from(pcm.to_vec()), rate: rate as u32, gain, loop_ },
            });
        }
        id
    }

    fn do_stop(&mut self, voice: i32) -> i32 {
        self.expire_finished();
        match self.voices.iter_mut().find(|s| matches!(s, Some(v) if v.id == voice)) {
            Some(slot) => {
                *slot = None;
                if let Some(s) = &mut self.session {
                    s.events.push(Event { t: s.start.elapsed().as_secs_f64(), voice, kind: EventKind::Stop });
                }
                0
            }
            None => -1,
        }
    }

    fn do_set_gain(&mut self, voice: i32, gain: f32) -> i32 {
        self.expire_finished();
        if !self.voices.iter().any(|s| matches!(s, Some(v) if v.id == voice)) {
            return -1;
        }
        if let Some(s) = &mut self.session {
            s.events.push(Event { t: s.start.elapsed().as_secs_f64(), voice, kind: EventKind::SetGain { gain } });
        }
        0
    }

    fn voice_state(&mut self, voice: i32) -> i32 {
        self.expire_finished();
        if self.voices.iter().any(|s| matches!(s, Some(v) if v.id == voice)) {
            1 // live
        } else if voice >= 0 && voice < self.next_id {
            0 // dead but known
        } else {
            -1 // never allocated
        }
    }

    fn do_shutdown(&mut self) -> i32 {
        self.flush();
        0
    }
}

/// Mix the recorded events into mono `f32` at the session rate, then quantise.
fn render_session(session: &Session, end: f64) -> Vec<i16> {
    let frames = (end * session.rate as f64) as usize;
    let mut out = vec![0.0f32; frames];

    struct Active {
        id: i32,
        start: f64,
        pcm: Arc<[f32]>,
        rate: f64,
        gain: f32,
        loop_: bool,
    }

    let mut active: Vec<Active> = Vec::new();
    let mut events = session.events.iter().peekable();

    for fi in 0..frames {
        let t = fi as f64 / session.rate as f64;
        while let Some(e) = events.peek() {
            if e.t > t {
                break;
            }
            let e = events.next().unwrap();
            match &e.kind {
                EventKind::Play { pcm, rate, gain, loop_ } => {
                    active.push(Active {
                        id: e.voice,
                        start: e.t,
                        pcm: Arc::clone(pcm),
                        rate: *rate as f64,
                        gain: *gain,
                        loop_: *loop_,
                    });
                }
                EventKind::Stop => {
                    active.retain(|a| a.id != e.voice);
                }
                EventKind::SetGain { gain } => {
                    for a in active.iter_mut() {
                        if a.id == e.voice {
                            a.gain = *gain;
                        }
                    }
                }
            }
        }

        let mut mix = 0.0f32;
        for a in active.iter() {
            if a.rate <= 0.0 || a.pcm.is_empty() {
                continue;
            }
            let pos = (t - a.start) * a.rate;
            let len = a.pcm.len();
            if !a.loop_ && pos >= len as f64 {
                continue;
            }
            let p = if a.loop_ { pos % len as f64 } else { pos };
            let idx = p as usize;
            let frac = (p - idx as f64) as f32;
            let s0 = a.pcm[idx];
            let s1 = a.pcm[if idx + 1 < len { idx + 1 } else { idx }];
            mix += (s0 + (s1 - s0) * frac) * a.gain;
        }
        out[fi] = mix.clamp(-1.0, 1.0);
    }

    out.iter().map(|&s| (s * 32767.0) as i16).collect()
}

fn write_wav(path: &Path, rate: u32, channels: u16, samples: &[i16]) -> std::io::Result<()> {
    let mut f = File::create(path)?;
    let byte_rate = rate * channels as u32 * 2;
    let block_align = channels * 2;
    let data_len = (samples.len() * 2) as u32;

    let mut hdr = Vec::with_capacity(44);
    hdr.extend_from_slice(b"RIFF");
    hdr.extend_from_slice(&(36 + data_len).to_le_bytes());
    hdr.extend_from_slice(b"WAVE");
    hdr.extend_from_slice(b"fmt ");
    hdr.extend_from_slice(&16u32.to_le_bytes());
    hdr.extend_from_slice(&1u16.to_le_bytes()); // PCM
    hdr.extend_from_slice(&channels.to_le_bytes());
    hdr.extend_from_slice(&rate.to_le_bytes());
    hdr.extend_from_slice(&byte_rate.to_le_bytes());
    hdr.extend_from_slice(&block_align.to_le_bytes());
    hdr.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    hdr.extend_from_slice(b"data");
    hdr.extend_from_slice(&data_len.to_le_bytes());
    f.write_all(&hdr)?;

    for s in samples {
        f.write_all(&s.to_le_bytes())?;
    }
    Ok(())
}
