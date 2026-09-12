//! Guest-side bindings for the `tension::audio` service.
//!
//! The host is a low-level PCM sink: it opens a device and plays the mono
//! `f32` samples the guest hands it. All waveform generation (sine, square,
//! whatever a game needs) happens here in the guest; the host synthesises
//! nothing. The guest holds only opaque `i32` voice handles and must not
//! interpret or perform arithmetic on them.
//!
//! All six verbs run on the guest thread. `audio_init` is first-wins: the
//! session's parameters are fixed at the first successful init until
//! `audio_shutdown`.

@external("tension::audio", "audio_init")
declare function hostAudioInit(sampleRate: i32, channels: i32): i32;
@external("tension::audio", "audio_play")
declare function hostAudioPlay(ptr: usize, len: i32, rate: i32, gain: f32, looping: i32): i32;
@external("tension::audio", "audio_stop")
declare function hostAudioStop(voice: i32): i32;
@external("tension::audio", "audio_set_gain")
declare function hostAudioSetGain(voice: i32, gain: f32): i32;
@external("tension::audio", "audio_voice_state")
declare function hostAudioVoiceState(voice: i32): i32;
@external("tension::audio", "audio_shutdown")
declare function hostAudioShutdown(): i32;

/** Open the audio device. 0 ok, -1 error. First-wins. */
export function audioInit(sampleRate: i32 = 44100, channels: i32 = 2): i32 {
  return hostAudioInit(sampleRate, channels);
}

/** Play mono f32 PCM (`pcm` samples at `rate` Hz). Returns an opaque voice
 *  handle, or -1 on error. `looping` repeats the buffer until stopped. */
export function audioPlay(
  pcm: Float32Array,
  rate: i32,
  gain: f32 = 1.0,
  looping: bool = false,
): i32 {
  return hostAudioPlay(pcm.dataStart, pcm.byteLength, rate, gain, looping ? 1 : 0);
}

/** Stop a live voice. 0 if it was live, -1 otherwise. */
export function audioStop(voice: i32): i32 {
  return hostAudioStop(voice);
}

/** Set a live voice's gain (clamped to [0, 1] host-side). */
export function audioSetGain(voice: i32, gain: f32): i32 {
  return hostAudioSetGain(voice, gain);
}

/** 1 live, 0 dead but known, -1 never allocated. */
export function audioVoiceState(voice: i32): i32 {
  return hostAudioVoiceState(voice);
}

/** Stop everything and release the device. Idempotent. */
export function audioShutdown(): i32 {
  return hostAudioShutdown();
}
