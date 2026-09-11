// examples/audio/demo.ts — the audio tech demo.
//
// The host is a low-level PCM sink: it knows nothing about waveforms. This
// demo generates its own sine and square waves (the "engine" is the example,
// the substrate just plays them) and drives the audio service through the
// tension-framework API. It never touches the ABI or @external directly.

import {
  print,
  audioInit,
  audioPlay,
  audioStop,
  audioSetGain,
  audioVoiceState,
  audioShutdown,
} from "tension-framework";

// Exported so the busy-wait below is never optimised away.
export let burnSink: f64 = 0;

// Iterations per nominal millisecond. Calibrated on the dev host (a wasm
// f64 increment is a few ns), so the busy-wait below tracks wall time to
// within ~50%. Not exact by design — the ABI deliberately has no clock.
const ITERS_PER_MS: i32 = 400000;

// Busy-wait for roughly `ms` milliseconds. The ABI has no clock and no
// sleep import, so wall time is approximated by counting loop iterations.
function burn(ms: i32): void {
  const n: i32 = ms * ITERS_PER_MS;
  for (let i = 0; i < n; i++) {
    burnSink += 1.0;
  }
}

// Build `seconds` seconds of a 440 Hz tone at `rate`. `kind` 0 = sine,
// 1 = square. Pure guest-side synthesis; the host never sees a waveform
// name, only the resulting samples.
function makeTone(rate: i32, seconds: f32, kind: i32): Float32Array {
  const frames = <i32>(<f32>rate * seconds);
  const buf = new Float32Array(frames);
  const twoPi: f64 = Math.PI * 2.0;
  for (let i = 0; i < frames; i++) {
    const phase: f64 = (<f64>i * 440.0) / <f64>rate;
    const p: f64 = phase - Math.floor(phase);
    if (kind == 0) {
      buf[i] = <f32>(Math.sin(p * twoPi) * 0.8);
    } else {
      buf[i] = p < 0.5 ? 0.5 : -0.5;
    }
  }
  return buf;
}

export function _start_game(): void {
  print("=== TensionCore audio demo ===");

  if (audioInit(44100, 2) < 0) {
    print("audioInit failed — no audio device available in this session.");
    return;
  }

  print("playing a 1.0 s sine (gain 0.8)…");
  let sine = audioPlay(makeTone(44100, 1.0, 0), 44100, 0.8, false);
  print("  voice handle: " + sine.toString());
  burn(1100);

  print("playing a 1.0 s square, then fading it…");
  let square = audioPlay(makeTone(44100, 1.0, 1), 44100, 0.5, false);
  burn(500);
  audioSetGain(square, 0.2);
  burn(800);

  print("square voice_state (should be 0 = finished): " + audioVoiceState(square).toString());

  print("starting a looping square, stopping it early…");
  let looping = audioPlay(makeTone(44100, 0.5, 1), 44100, 0.6, true);
  burn(600);
  print("  stop -> " + audioStop(looping).toString());
  print("  voice_state after stop (should be 0): " + audioVoiceState(looping).toString());

  print("bogus handle voice_state (should be -1): " + audioVoiceState(123456).toString());

  print("shutting down audio…");
  audioShutdown();
  print("--- end ---");
}
