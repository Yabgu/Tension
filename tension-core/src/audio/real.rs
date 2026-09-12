//! Device-backed audio adapter (cpal): plays the guest's PCM.
//!
//! The host is a low-level sink. It knows nothing about waveforms: it
//! accepts mono `f32` PCM buffers from the guest and mixes them out to the
//! device, resampling to the device rate by linear interpolation. All
//! synthesis lives in the guest.
//!
//! # Threading
//!
//! A driver thread owns the cpal `Stream` for its whole life. `audio_init`
//! blocks (bounded, 5 s) for that thread's handshake; `audio_shutdown`
//! signals it, the stream is dropped *on the thread that created it*, and
//! the guest thread joins it. The stream never crosses threads.
//!
//! # Transport (lock-free, no `unsafe`)
//!
//! Each voice slot is a small block of atomics plus an [`ArcSwap`] of the
//! immutable PCM buffer. The guest thread publishes a voice by writing the
//! buffer + params and then storing the generation *last* (Release); the
//! callback reads the generation first (Acquire) and reloads the buffer
//! only when the generation changes. `stop` stores generation 0; `set_gain`
//! stores a new gain atom that the callback reads every block.
//!
//! # Real-time callback constraints
//!
//! The callback must not allocate, lock, block, `println!`, panic across
//! the C ABI, or touch cpal stream control. It may use atomics, a
//! preallocated per-voice playback mirror, arithmetic, and `clamp`. The one
//! allocation it performs is the `Arc` clone on a *voice start* (generation
//! change), not per block.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, FromSample, SampleFormat, SizedSample, StreamConfig};

use crate::audio::{AudioAdapter, MAX_VOICES};

/// Bounded wait for the driver thread's ready/error handshake.
const INIT_TIMEOUT: Duration = Duration::from_secs(5);

/// One voice's shared, lock-free state. `gen == 0` means inactive; the
/// callback treats any generation change as "a new voice started here".
struct VoiceSlot {
    /// Immutable mono `f32` PCM, published before `gen`.
    samples: ArcSwap<Vec<f32>>,
    /// PCM sample rate.
    rate: AtomicU32,
    /// Gain as `f32` bits; mutable during a voice's life.
    gain: AtomicU32,
    loop_: AtomicBool,
    /// 0 = inactive; nonzero = active voice generation (publish point).
    gen: AtomicU32,
}

struct Shared {
    slots: Box<[VoiceSlot]>,
    device_rate: u32,
}

/// The callback's local mirror of one voice. Rebuilt only when `gen`
/// changes; `pos` advances every block in source-sample units.
struct Playback {
    gen: u32,
    pos: f64,
    samples: Arc<Vec<f32>>,
    rate: f64,
    loop_: bool,
    len: usize,
}

fn default_playback() -> Playback {
    Playback {
        gen: 0,
        pos: 0.0,
        samples: Arc::new(Vec::<f32>::new()),
        rate: 0.0,
        loop_: false,
        len: 0,
    }
}

/// Mix one output block. Realtime: no alloc, no lock, no block.
fn fill<T>(data: &mut [T], pb: &mut [Playback; MAX_VOICES], shared: &Shared, channels: usize)
where
    T: SizedSample + FromSample<f32>,
{
    let device_rate = shared.device_rate as f64;

    for frame in data.chunks_mut(channels) {
        let mut mix = 0.0f32;
        for i in 0..MAX_VOICES {
            let slot = &shared.slots[i];
            let gen = slot.gen.load(Ordering::Acquire);
            if gen == 0 {
                continue;
            }
            let p = &mut pb[i];
            if p.gen != gen {
                // A new voice started in this slot: reload its PCM once.
                p.gen = gen;
                p.pos = 0.0;
                p.samples = slot.samples.load_full();
                p.rate = slot.rate.load(Ordering::Relaxed) as f64;
                p.loop_ = slot.loop_.load(Ordering::Relaxed);
                p.len = p.samples.len();
            }
            if p.len == 0 || p.rate <= 0.0 {
                continue;
            }
            let gain = f32::from_bits(slot.gain.load(Ordering::Relaxed));
            if !p.loop_ && p.pos >= p.len as f64 {
                continue; // finished; the guest marks the handle dead by wall-clock
            }

            let pos = if p.loop_ { p.pos % p.len as f64 } else { p.pos };
            let idx = pos as usize;
            let frac = (pos - idx as f64) as f32;
            let s0 = p.samples[idx];
            let s1 = p.samples[if idx + 1 < p.len { idx + 1 } else { idx }];
            mix += (s0 + (s1 - s0) * frac) * gain;

            p.pos += p.rate / device_rate;
        }
        let s: T = T::from_sample(mix.clamp(-1.0, 1.0));
        for c in frame.iter_mut() {
            *c = s;
        }
    }
}

/// What the device agreed to, for the trace line.
struct Params {
    device: String,
    format: &'static str,
    rate: u32,
    channels: u16,
    requested_rate: u32,
    requested_channels: u16,
}

fn format_name(f: SampleFormat) -> &'static str {
    match f {
        SampleFormat::I8 => "i8",
        SampleFormat::I16 => "i16",
        SampleFormat::I32 => "i32",
        SampleFormat::I64 => "i64",
        SampleFormat::U8 => "u8",
        SampleFormat::U16 => "u16",
        SampleFormat::U32 => "u32",
        SampleFormat::U64 => "u64",
        SampleFormat::F32 => "f32",
        SampleFormat::F64 => "f64",
        _ => "unknown",
    }
}

fn format_rank(f: SampleFormat) -> Option<u8> {
    match f {
        SampleFormat::F32 => Some(0),
        SampleFormat::I32 => Some(1),
        SampleFormat::F64 => Some(2),
        SampleFormat::I16 => Some(3),
        SampleFormat::U16 => Some(4),
        SampleFormat::I8 => Some(5),
        SampleFormat::U8 => Some(6),
        _ => None,
    }
}

/// Full-quality formats we will accept for a *requested* rate/channel pair.
const GOOD_RANK_MAX: u8 = 3;

/// Pick the stream configuration. The guest's request is honoured only when
/// the device offers it in a full-quality format; otherwise the device
/// default wins. Safe to do silently because the PCM is resampled to the
/// device rate, so the guest cannot observe the negotiation.
fn choose(
    device: &cpal::Device,
    default_cfg: &cpal::SupportedStreamConfig,
    want_rate: u32,
    want_ch: u16,
) -> (SampleFormat, StreamConfig) {
    if let Ok(ranges) = device.supported_output_configs() {
        let mut best: Option<(u8, SampleFormat)> = None;
        for r in ranges {
            if r.channels() != want_ch {
                continue;
            }
            if r.min_sample_rate() > want_rate || want_rate > r.max_sample_rate() {
                continue;
            }
            if let Some(rank) = format_rank(r.sample_format()) {
                if best.map_or(true, |(best_rank, _)| rank < best_rank) {
                    best = Some((rank, r.sample_format()));
                }
            }
        }
        if let Some((rank, fmt)) = best {
            if rank <= GOOD_RANK_MAX {
                return (
                    fmt,
                    StreamConfig {
                        channels: want_ch,
                        sample_rate: want_rate,
                        buffer_size: BufferSize::Default,
                    },
                );
            }
        }
    }
    (default_cfg.sample_format(), default_cfg.config())
}

fn play_typed<T>(
    device: &cpal::Device,
    cfg: StreamConfig,
    shared: Arc<Shared>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
{
    let channels = cfg.channels as usize;
    let mut pb = std::array::from_fn(|_| default_playback());
    let cb_shared = Arc::clone(&shared);
    let err_fn = |e: cpal::Error| eprintln!("[tension:audio:real] stream error: {e}");
    let stream = device
        .build_output_stream::<T, _, _>(
            cfg,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                fill::<T>(data, &mut pb, &cb_shared, channels)
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("build_output_stream: {e}"))?;
    stream.play().map_err(|e| format!("stream.play: {e}"))?;
    Ok(stream)
}

/// Open the default output device, negotiate a config, and start playing.
fn build(want_rate: u32, want_ch: u16) -> Result<(cpal::Stream, Arc<Shared>, Params), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "no default output device".to_string())?;
    let device_name = device.to_string();

    let default_cfg = device
        .default_output_config()
        .map_err(|e| format!("default_output_config: {e}"))?;
    let (fmt, cfg) = choose(&device, &default_cfg, want_rate, want_ch);

    let shared = Arc::new(Shared {
        slots: (0..MAX_VOICES)
            .map(|_| VoiceSlot {
                samples: ArcSwap::new(Arc::new(Vec::<f32>::new())),
                rate: AtomicU32::new(0),
                gain: AtomicU32::new(1.0f32.to_bits()),
                loop_: AtomicBool::new(false),
                gen: AtomicU32::new(0),
            })
            .collect(),
        device_rate: cfg.sample_rate,
    });

    let params = Params {
        device: device_name,
        format: format_name(fmt),
        rate: cfg.sample_rate,
        channels: cfg.channels,
        requested_rate: want_rate,
        requested_channels: want_ch,
    };

    let stream = match fmt {
        SampleFormat::F32 => play_typed::<f32>(&device, cfg, Arc::clone(&shared)),
        SampleFormat::I16 => play_typed::<i16>(&device, cfg, Arc::clone(&shared)),
        SampleFormat::U16 => play_typed::<u16>(&device, cfg, Arc::clone(&shared)),
        SampleFormat::I32 => play_typed::<i32>(&device, cfg, Arc::clone(&shared)),
        SampleFormat::I8 => play_typed::<i8>(&device, cfg, Arc::clone(&shared)),
        SampleFormat::U8 => play_typed::<u8>(&device, cfg, Arc::clone(&shared)),
        SampleFormat::F64 => play_typed::<f64>(&device, cfg, Arc::clone(&shared)),
        other => Err(format!("unsupported sample format {other:?}")),
    }?;

    Ok((stream, shared, params))
}

/// Guest-thread bookkeeping for one live voice.
#[derive(Clone, Copy)]
struct Slot {
    alive: bool,
    gen: u8,
    loop_: bool,
    started: Instant,
    /// Wall-clock length of the PCM (samples / rate).
    duration: Duration,
}

struct Session {
    slots: [Slot; MAX_VOICES],
    /// Last generation handed out per slot; 0 means "never allocated".
    known_gen: [u8; MAX_VOICES],
}

/// Device-backed adapter. Cheap to construct: the device opens at
/// `audio_init`, so the host pays nothing when a game never uses audio.
pub struct RealAdapter {
    shared: Option<Arc<Shared>>,
    shutdown_tx: Option<Sender<()>>,
    driver: Option<JoinHandle<()>>,
    session: Option<Session>,
}

impl RealAdapter {
    pub fn new() -> Self {
        Self {
            shared: None,
            shutdown_tx: None,
            driver: None,
            session: None,
        }
    }

    /// Free slots whose voice finished naturally (its PCM duration elapsed).
    /// Mirrors the callback, which simply stops mixing once it runs out of
    /// samples.
    fn expire(&mut self) {
        let Some(session) = self.session.as_mut() else {
            return;
        };
        for slot in session.slots.iter_mut() {
            if slot.alive && !slot.loop_ && slot.started.elapsed() >= slot.duration {
                slot.alive = false;
            }
        }
    }

    fn decode(handle: i32) -> Option<(usize, u8)> {
        if handle < 0 {
            return None;
        }
        let h = handle as u32;
        let slot = (h & 0xFF) as usize;
        let gen = ((h >> 8) & 0xFF) as u8;
        if slot >= MAX_VOICES || gen == 0 {
            return None;
        }
        Some((slot, gen))
    }

    fn encode(slot: usize, gen: u8) -> i32 {
        (slot as i32) | ((gen as i32) << 8)
    }

    fn next_gen(prev: u8) -> u8 {
        if prev >= 255 {
            1
        } else {
            prev + 1
        }
    }

    fn start(&mut self, want_rate: u32, want_ch: u16) -> Result<(Arc<Shared>, Params), String> {
        let (ready_tx, ready_rx) = mpsc::channel();
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();

        let driver = std::thread::Builder::new()
            .name("tension-audio".into())
            .spawn(move || match build(want_rate, want_ch) {
                Ok((stream, shared, params)) => {
                    if ready_tx.send(Ok((shared, params))).is_err() {
                        return; // init gave up; stream drops right here
                    }
                    let _ = shutdown_rx.recv();
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            })
            .map_err(|e| format!("spawn audio driver: {e}"))?;

        match ready_rx.recv_timeout(INIT_TIMEOUT) {
            Ok(Ok((shared, params))) => {
                self.shutdown_tx = Some(shutdown_tx);
                self.driver = Some(driver);
                Ok((shared, params))
            }
            Ok(Err(e)) => {
                let _ = driver.join();
                Err(e)
            }
            Err(_) => {
                let _ = shutdown_tx.send(());
                Err(format!("audio device did not start within {INIT_TIMEOUT:?}"))
            }
        }
    }
}

impl Default for RealAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioAdapter for RealAdapter {
    fn do_init(&mut self, sample_rate: i32, channels: i32) -> i32 {
        match self.start(sample_rate as u32, channels as u16) {
            Ok((shared, params)) => {
                eprintln!(
                    "[tension:audio:real] device=\"{}\" format={} rate={} channels={} (requested {}/{})",
                    params.device,
                    params.format,
                    params.rate,
                    params.channels,
                    params.requested_rate,
                    params.requested_channels
                );
                self.shared = Some(shared);
                self.session = Some(Session {
                    slots: [Slot {
                        alive: false,
                        gen: 0,
                        loop_: false,
                        started: Instant::now(),
                        duration: Duration::ZERO,
                    }; MAX_VOICES],
                    known_gen: [0; MAX_VOICES],
                });
                0
            }
            Err(e) => {
                eprintln!("[tension:audio:real] init failed: {e}");
                -1
            }
        }
    }

    fn do_play(&mut self, pcm: &[f32], rate: i32, gain: f32, loop_: bool) -> i32 {
        self.expire();
        let Some(shared) = self.shared.as_ref().map(Arc::clone) else {
            return -1;
        };
        let Some(session) = self.session.as_mut() else {
            return -1;
        };
        let Some(slot) = session.slots.iter().position(|s| !s.alive) else {
            return -1; // live-voice cap reached; not a total-play limit
        };
        let gen = Self::next_gen(session.known_gen[slot]);

        // Publish: write the buffer + params first, then `gen` last.
        let s = &shared.slots[slot];
        s.samples.store(Arc::new(pcm.to_vec()));
        s.rate.store(rate as u32, Ordering::Release);
        s.gain.store(gain.to_bits(), Ordering::Release);
        s.loop_.store(loop_, Ordering::Release);
        s.gen.store(gen as u32, Ordering::Release);

        session.known_gen[slot] = gen;
        session.slots[slot] = Slot {
            alive: true,
            gen,
            loop_,
            started: Instant::now(),
            duration: Duration::from_secs_f64(pcm.len() as f64 / rate as f64),
        };
        Self::encode(slot, gen)
    }

    fn do_stop(&mut self, voice: i32) -> i32 {
        self.expire();
        let Some((slot, gen)) = Self::decode(voice) else {
            return -1;
        };
        let Some(shared) = self.shared.as_ref().map(Arc::clone) else {
            return -1;
        };
        let Some(session) = self.session.as_mut() else {
            return -1;
        };
        if !session.slots[slot].alive || session.slots[slot].gen != gen {
            return -1;
        }
        shared.slots[slot].gen.store(0, Ordering::Release);
        session.slots[slot].alive = false;
        0
    }

    fn do_set_gain(&mut self, voice: i32, gain: f32) -> i32 {
        self.expire();
        let Some((slot, gen)) = Self::decode(voice) else {
            return -1;
        };
        let Some(shared) = self.shared.as_ref().map(Arc::clone) else {
            return -1;
        };
        let Some(session) = self.session.as_mut() else {
            return -1;
        };
        if !session.slots[slot].alive || session.slots[slot].gen != gen {
            return -1;
        }
        shared.slots[slot].gain.store(gain.to_bits(), Ordering::Release);
        0
    }

    fn voice_state(&mut self, voice: i32) -> i32 {
        self.expire();
        let Some((slot, gen)) = Self::decode(voice) else {
            return -1;
        };
        let Some(session) = self.session.as_ref() else {
            return -1;
        };
        if session.known_gen[slot] != gen || session.known_gen[slot] == 0 {
            return -1;
        }
        if session.slots[slot].alive {
            1
        } else {
            0
        }
    }

    fn do_shutdown(&mut self) -> i32 {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(driver) = self.driver.take() {
            let _ = driver.join();
        }
        self.shared = None;
        self.session = None;
        0
    }
}

impl Drop for RealAdapter {
    fn drop(&mut self) {
        self.do_shutdown();
    }
}
