# Talkback

Minimal audio-only WebRTC voice rooms with **browser acoustic echo cancellation**, so two people (or two tabs) can interrupt / barge in on laptop speakers without howl.

Far-end audio is played through an **unmuted** `<audio autoplay playsInline>` element attached in `pc.ontrack`. That element is the AEC reference. VU meters clone the stream into an `AnalyserNode` that is **not** connected to speakers — a silent Web Audio tap is not a valid echo reference.

## Run locally

```bash
npm install
npm start
```

Open [http://127.0.0.1:3847](http://127.0.0.1:3847). Allow the microphone when prompted. **Join room** is a user gesture: it unlocks autoplay and resumes `AudioContext` so remote audio can start when the track arrives.

There is no database, no accounts, and no TURN server. Signaling is a **room-code WebSocket** (same-origin two tabs or two devices on a LAN). ICE is **STUN only** (`stun.l.google.com` + `stun1`); host candidates usually suffice for two tabs on one machine.

### Two-tab test

1. Copy the room **link** (or type the same code in both tabs).
2. Click **Join room** in each tab and allow the mic. Leave both mics unmuted.
3. You should hear each other. Status shows ICE/connection state.
4. Talk over each other. Feedback should not run away on typical laptop speakers.

## Test echo suppression / barge-in

**Recommended:** Chrome, laptop speakers, no headphones, normal conversation volume.

1. Join the same room from two tabs, or use **Loopback self-test**.
2. Let one side talk for a few seconds. Adaptive AEC needs about **1–4s** of far-end energy to converge.
3. Interrupt mid-sentence. You should hear the interruption; you should not get mic-into-speaker howl.
4. Flip the **Echo cancellation** switch off, then on. Off + speakers often rings. On should stabilize.
5. **Interrupt** pauses local far-end playback immediately (software barge-in / TTS-stop pattern). The HUD shows click-to-silence in milliseconds.
6. Mute mic uses `track.enabled = false` (half-duplex — you cannot barge in). Mute speaker removes the AEC reference.

### QA checklist

Setup: Chrome, two tabs, same room, `http://127.0.0.1`, laptop speakers, headphones unplugged, volume ~50–60%. HUD should show `AEC: all` or `on`, not `false`.

| Check | Expect |
| --- | --- |
| Test tone | Short beep from **Play test tone** |
| Mic meter | Moves when you speak after Join |
| Remote audio | Audible after Join (use **Enable audio** only if autoplay blocked) |
| ICE | `connected` / `completed`, not stuck `failed` |
| AEC on, speakers, after ~3s | Little or no self-echo / no howl |
| AEC off, same setup | Echo or ringing returns (the compare) |
| Double-talk | Both voices audible; no catastrophic feedback |
| Interrupt button | Far-end stops in **<200ms** (HUD prints the time) |
| Headphones | Echo path gone; barge-in still works |
| Mute via `track.enabled` | Unmute is instant; track does not end |
| Refresh one tab | Clean re-negotiate |
| HUD | `getSettings().echoCancellation` matches what you hear |

**Pass:** Speakers + AEC on: no obvious self-echo at steady state; double-talk intelligible; no autoplay/silence footguns; HUD matches reality.

**If it fails, check first:** remote `<audio>` muted/volume 0 / not playing; AEC false; far-end not on the PeerConnection track path; autoplay blocked; two open mics in one room.

## Audio constraints

Capture tries Chrome 141+ [`"all"`](https://developer.chrome.com/release-notes/141) first, then boolean `true`:

```js
{
  audio: {
    echoCancellation: { ideal: "all" }, // fallback: true
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1
  },
  video: false
}
```

[MDN `MediaTrackConstraints.echoCancellation`](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation) documents boolean plus `"all"` / `"remote-only"`. Constraints are **requests**. The in-call HUD prints `getSettings()` and `getCapabilities()`.

Chrome implements this with **AEC3**. `"all"` asks Chromium to cancel same-process playout (the `<audio>` element), not only remote RTC in the narrow historical sense.

## Speakers vs headphones

| | Speakers (speakerphone) | Headphones |
| --- | --- | --- |
| Acoustic echo path | Strong (speaker → mic) | Essentially none |
| AEC needed | Yes — this is the demo | Minimal |
| Barge-in | Depends on AEC + keeping the mic open | Highest reliability |
| Product fallback | Recommend Chrome; wait ~3s to converge | Use when Bluetooth, two laptops in one room, or Firefox speakerphone fails |

## Browser notes

| Browser | Notes |
| --- | --- |
| Chrome / Edge | Best AEC3 results. Prefer this for the speaker test. Chrome 141+ may report `echoCancellation: "all"`. |
| Safari | Usually strong on Apple hardware. Needs `playsInline` and a join gesture for autoplay. |
| Firefox | AEC exists; speakerphone quality is weaker in practice. |
| Autoplay | If a tab blocks audio, **Enable audio**. Join / loopback already try to unlock playback. |

## Limitations of browser AEC

- Typical laptop / phone geometry, not PA systems or long rooms.
- First 1–4 seconds of far-end audio are a convergence window.
- Bluetooth, odd USB sample-rate conversion, and two unmuted devices in one room often leak echo.
- Routing far-end through a Web Audio graph, a silent `GainNode`, another tab, or another app usually means **no reference**.
- Muting the speaker removes the reference; muting the mic prevents barge-in.
- Aggressive noise suppression / AGC can clip soft interrupts or pump levels. This demo leaves NS and AGC on and shows the applied flags.
- No TURN: some NATs will not connect. Rooms are whoever knows the code.

## Project layout

```
server.js          Express + WebSocket rooms (resume id, heartbeat)
public/index.html  UI
public/styles.css  Layout
public/app.js      Capture, mesh WebRTC, AEC toggle, reconnect, loopback, VU
```

`npm start` listens on port **3847** (`PORT` overrides).
