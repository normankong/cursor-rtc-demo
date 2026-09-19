/**
 * Talkback — audio-only WebRTC with browser AEC for barge-in.
 *
 * Playback path (AEC reference):
 *   pc.ontrack → unmuted HTMLAudioElement (autoplay + playsInline) in the DOM.
 *   Never play remote audio through AudioContext.destination.
 *
 * Metering:
 *   AnalyserNode on a cloned stream, not connected to speakers. A silent Web
 *   Audio tap is NOT a valid AEC reference — that is why far-end stays on <audio>.
 *
 * Capture:
 *   echoCancellation: { ideal: "all" } on Chrome 141+, then boolean true.
 *   Always surface track.getSettings() in the HUD.
 */

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // Public openrelay TURN — helps when host/srflx ICE fails across NATs / VPN.
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:443",
      "turn:openrelay.metered.ca:443?transport=tcp",
    ],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];
const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CLIENT_KEY = "talkback.clientId";
const TAB_ALIVE_KEY = "talkback.tabAlive";

/** Per-tab id. Duplicated tabs copy sessionStorage — detect that and mint a new id. */
function getUniqueClientId() {
  if (sessionStorage.getItem(TAB_ALIVE_KEY)) {
    // sessionStorage was cloned from another live tab — do not share peer identity.
    sessionStorage.removeItem(CLIENT_KEY);
    console.warn("[Talkback] duplicated tab detected — minting a new clientId");
  }
  let id = sessionStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_KEY, id);
  }
  sessionStorage.setItem(TAB_ALIVE_KEY, "1");
  window.addEventListener("pagehide", () => {
    try {
      sessionStorage.removeItem(TAB_ALIVE_KEY);
    } catch {
      /* ignore */
    }
  });
  return id;
}

const PING_MS = 15000;
const ICE_RESTART_LIMIT = 3;
const MAX_RECONNECTS = 8;

const els = {
  lobby: document.getElementById("lobby"),
  call: document.getElementById("call"),
  joinForm: document.getElementById("join-form"),
  roomInput: document.getElementById("room-input"),
  joinBtn: document.getElementById("join-btn"),
  copyLinkBtn: document.getElementById("copy-link-btn"),
  copyCodeBtn: document.getElementById("copy-code-btn"),
  shuffleBtn: document.getElementById("shuffle-btn"),
  loopbackBtn: document.getElementById("loopback-btn"),
  toneBtn: document.getElementById("tone-btn"),
  toneStatus: document.getElementById("tone-status"),
  lobbyError: document.getElementById("lobby-error"),
  callError: document.getElementById("call-error"),
  audioBlocked: document.getElementById("audio-blocked"),
  enableAudioBtn: document.getElementById("enable-audio-btn"),
  aecBadge: document.getElementById("aec-badge"),
  scenarioBadge: document.getElementById("scenario-badge"),
  browserBadge: document.getElementById("browser-badge"),
  connBadge: document.getElementById("conn-badge"),
  modeLabel: document.getElementById("mode-label"),
  roomTitle: document.getElementById("room-title"),
  peerStatus: document.getElementById("peer-status"),
  micBtn: document.getElementById("mic-btn"),
  speakerBtn: document.getElementById("speaker-btn"),
  pauseRemoteBtn: document.getElementById("pause-remote-btn"),
  hangupBtn: document.getElementById("hangup-btn"),
  aecBtn: document.getElementById("aec-btn"),
  aecCard: document.getElementById("aec-card"),
  aecSwitchLabel: document.getElementById("aec-switch-label"),
  aecWarn: document.getElementById("aec-warn"),
  aecRequested: document.getElementById("aec-requested"),
  aecApplied: document.getElementById("aec-applied"),
  nsApplied: document.getElementById("ns-applied"),
  agcApplied: document.getElementById("agc-applied"),
  formatApplied: document.getElementById("format-applied"),
  aecCaps: document.getElementById("aec-caps"),
  localCaption: document.getElementById("local-meter-caption"),
  remoteCaption: document.getElementById("remote-meter-caption"),
  sinks: document.getElementById("remote-sinks"),
  reconnectBanner: document.getElementById("reconnect-banner"),
  reconnectNowBtn: document.getElementById("reconnect-now-btn"),
  callCopyLink: document.getElementById("call-copy-link"),
  micMutedNote: document.getElementById("mic-muted-note"),
  speakerMutedNote: document.getElementById("speaker-muted-note"),
  interruptMetric: document.getElementById("interrupt-metric"),
  liveHud: document.getElementById("live-hud"),
  liveHudRemote: document.getElementById("live-hud-remote"),
  mutedSpeaking: document.getElementById("muted-speaking"),
  graphBlocked: document.getElementById("graph-blocked"),
  resumeGraphBtn: document.getElementById("resume-graph-btn"),
  pcFailed: document.getElementById("pc-failed"),
  scenarioSpeakers: document.getElementById("scenario-speakers"),
  scenarioHeadphones: document.getElementById("scenario-headphones"),
  scenarioTip: document.getElementById("scenario-tip"),
};

const state = {
  aecEnabled: true,
  requestedAec: 'ideal: "all"',
  micMuted: false,
  speakerMuted: false,
  farEndPaused: false,
  mode: "idle",
  room: "",
  clientId: getUniqueClientId(),
  ws: null,
  localStream: null,
  peers: new Map(),
  loopback: null,
  meters: { local: null, remote: [] },
  meterCtx: null,
  raf: 0,
  pingTimer: 0,
  reconnectTimer: 0,
  reconnectAttempts: 0,
  reconnecting: false,
  audioUnlocked: false,
  output: "speakers",
  rttMs: null,
  statsTimer: 0,
  lastHud: "",
};

console.log("[Talkback] clientId", state.clientId);

function browserLabel() {
  const ua = navigator.userAgent;
  const chrome = ua.match(/Chrome\/(\d+)/);
  if (/Edg\//.test(ua) && chrome) return `Edge ${chrome[1]}`;
  if (chrome && !/Edg\//.test(ua)) return `Chrome ${chrome[1]}`;
  if (/Firefox\/(\d+)/.test(ua)) return `Firefox ${RegExp.$1}`;
  if (/Safari/.test(ua) && !/Chrome/.test(ua)) return "Safari";
  return "Browser";
}

function appliedAecValue() {
  return state.localStream?.getAudioTracks()[0]?.getSettings?.().echoCancellation;
}

function aecIsOn(value = appliedAecValue()) {
  return value === true || value === "all" || value === "remote-only";
}

function randomRoom() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join("");
}

function roomFromUrl() {
  return (new URLSearchParams(location.search).get("room") || "").trim().toUpperCase();
}

function setRoomInUrl(room) {
  const url = new URL(location.href);
  url.searchParams.set("room", room);
  history.replaceState(null, "", url);
}

function showError(el, message) {
  el.hidden = !message;
  el.textContent = message || "";
}

function setConnBadge(text, kind = "") {
  els.connBadge.textContent = text;
  els.connBadge.className = `badge${kind ? ` ${kind}` : ""}`;
}

function setAecUi() {
  const requestedOn = state.aecEnabled;
  const applied = appliedAecValue();
  const on = state.localStream ? aecIsOn(applied) : requestedOn;
  const missing = state.localStream && requestedOn && applied === false;
  els.aecBadge.textContent = state.localStream ? `AEC ${formatAecValue(applied)}` : requestedOn ? "AEC on" : "AEC off";
  els.aecBadge.className = `badge ${missing || !on ? "badge-off" : "badge-on"}`;
  els.aecBtn.setAttribute("aria-checked", String(requestedOn));
  els.aecSwitchLabel.textContent = requestedOn ? "On" : "Off";
  els.aecCard.classList.toggle("is-off", !requestedOn);
  els.aecWarn.hidden = requestedOn;
  els.aecRequested.textContent = requestedOn ? state.requestedAec : "false";
  updateLiveHud();
}

function formatAecValue(value) {
  if (value === "all") return "all";
  if (value === "remote-only") return "remote-only";
  if (value === true) return "on";
  if (value === false) return "off";
  if (value == null) return "unknown";
  return String(value);
}

function boolFlag(value) {
  if (value === true) return "on";
  if (value === false) return "off";
  return "unknown";
}

function remoteOutputReport() {
  const audio = els.sinks.querySelector("audio");
  if (!audio) return "none";
  const playing = !audio.paused && !audio.muted && audio.volume > 0;
  return playing
    ? `playing vol=${audio.volume} muted=${audio.muted}`
    : `paused=${audio.paused} muted=${audio.muted} vol=${audio.volume}`;
}

function updateLiveHud() {
  if (!els.liveHud) return;
  const track = state.localStream?.getAudioTracks()[0];
  const settings = track?.getSettings?.() || {};
  const mic = !track ? "off" : state.micMuted ? "muted" : track.muted ? "hardware-mute" : "live";
  const line = `Mic: ${mic} · AEC: ${formatAecValue(settings.echoCancellation)} · NS: ${boolFlag(settings.noiseSuppression)} · AGC: ${boolFlag(settings.autoGainControl)} · ${browserLabel()}`;
  const ice = [...state.peers.values()].map((p) => p.pc.iceConnectionState).join(",") || (state.mode === "loopback" ? "loopback" : "idle");
  const conn = [...state.peers.values()].map((p) => p.pc.connectionState).join(",") || "—";
  const rtt = state.rttMs == null ? "—" : `${Math.round(state.rttMs)}ms`;
  const remote = `Remote: ${remoteOutputReport()} · ICE: ${ice} · PC: ${conn} · RTT: ${rtt}`;
  if (line !== state.lastHud) {
    els.liveHud.textContent = line;
    els.liveHudRemote.textContent = remote;
    state.lastHud = line + remote;
  }
}

function setScenario(mode) {
  state.output = mode;
  const speakers = mode === "speakers";
  els.scenarioSpeakers.classList.toggle("chip-on", speakers);
  els.scenarioHeadphones.classList.toggle("chip-on", !speakers);
  els.scenarioBadge.textContent = speakers ? "Speakers" : "Headphones";
  els.scenarioTip.textContent = speakers
    ? "AEC stays on · volume ~50–60% · wait ~2s for the canceller to converge"
    : "AEC optional · almost no echo path · best barge-in reliability";
}

function constraintAttempts(aecEnabled) {
  if (!aecEnabled) {
    return [
      { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      { echoCancellation: false },
    ];
  }
  // Chrome 141+: "all" cancels same-process playout (HTMLAudioElement / Web Audio).
  // Older browsers fall through to boolean true. See MDN MediaTrackConstraints.echoCancellation.
  return [
    { echoCancellation: { ideal: "all" }, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    { echoCancellation: { ideal: "all" }, noiseSuppression: true, autoGainControl: true },
    { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    { echoCancellation: true },
  ];
}

function describeRequest(audio) {
  const aec = audio.echoCancellation;
  if (aec && typeof aec === "object" && aec.ideal === "all") return 'ideal: "all"';
  if (aec === true) return "true";
  if (aec === false) return "false";
  return JSON.stringify(aec);
}

async function captureMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support getUserMedia.");
  }
  let lastErr;
  for (const audio of constraintAttempts(state.aecEnabled)) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      state.requestedAec = describeRequest(audio);
      return stream;
    } catch (err) {
      if (err?.name === "NotAllowedError" || err?.name === "NotFoundError" || err?.name === "SecurityError") throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error("Microphone capture failed.");
}

async function getMic({ stopPrevious = true } = {}) {
  const previous = state.localStream;
  const stream = await captureMic();
  state.localStream = stream;
  applyMicMute();
  attachLocalMeter(stream);
  readAppliedProcessing();
  if (stopPrevious && previous) {
    for (const track of previous.getTracks()) track.stop();
  }
  return { stream, previous };
}

function readAppliedProcessing() {
  const track = state.localStream?.getAudioTracks()[0];
  const settings = track?.getSettings?.() || {};
  const caps = track?.getCapabilities?.() || {};
  els.aecApplied.textContent = formatAecValue(settings.echoCancellation);
  els.nsApplied.textContent = boolFlag(settings.noiseSuppression);
  els.agcApplied.textContent = boolFlag(settings.autoGainControl);
  const rate = settings.sampleRate ? `${settings.sampleRate} Hz` : "—";
  const ch = settings.channelCount ?? "—";
  els.formatApplied.textContent = `${rate} · ${ch} ch`;
  const capList = caps.echoCancellation;
  els.aecCaps.textContent = Array.isArray(capList) ? capList.map(formatAecValue).join(", ") : "n/a";
  if (state.aecEnabled && settings.echoCancellation === false) {
    els.aecApplied.textContent = "off (browser did not apply)";
  }
  setAecUi();
}

function applyMicMute() {
  for (const track of state.localStream?.getAudioTracks() || []) {
    track.enabled = !state.micMuted;
  }
  els.micBtn.setAttribute("aria-pressed", String(state.micMuted));
  els.micBtn.querySelector(".ctrl-label").textContent = state.micMuted ? "Unmute mic" : "Mute mic";
  els.localCaption.textContent = state.micMuted ? "Mic muted" : "Mic live · leave it unmuted to barge in";
  els.micMutedNote.hidden = !state.micMuted;
}

function forEachRemoteAudio(fn) {
  for (const audio of els.sinks.querySelectorAll("audio")) fn(audio);
}

function applySpeakerMute() {
  forEachRemoteAudio((audio) => {
    audio.muted = state.speakerMuted;
  });
  els.speakerBtn.setAttribute("aria-pressed", String(state.speakerMuted));
  els.speakerBtn.querySelector(".ctrl-label").textContent = state.speakerMuted ? "Unmute speaker" : "Mute speaker";
  els.speakerMutedNote.hidden = !state.speakerMuted;
}

function applyFarEndPause() {
  const started = performance.now();
  forEachRemoteAudio((audio) => {
    if (state.farEndPaused) {
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {
        /* MediaStream sources may ignore currentTime */
      }
    } else playRemote(audio);
  });
  els.pauseRemoteBtn.setAttribute("aria-pressed", String(state.farEndPaused));
  els.pauseRemoteBtn.querySelector(".ctrl-label").textContent = state.farEndPaused ? "Resume far-end" : "Interrupt";
  if (state.farEndPaused && els.interruptMetric) {
    const ms = Math.max(0, Math.round(performance.now() - started));
    els.interruptMetric.hidden = false;
    els.interruptMetric.textContent = `Far-end silenced in ${ms}ms (target <200ms).`;
  } else if (els.interruptMetric) {
    els.interruptMetric.hidden = true;
  }
  updateLiveHud();
}

function showCall(title, modeLabel) {
  els.lobby.hidden = true;
  els.call.hidden = false;
  els.roomTitle.textContent = title;
  els.modeLabel.textContent = modeLabel;
  showError(els.lobbyError, "");
  showError(els.callError, "");
}

function showLobby() {
  els.lobby.hidden = false;
  els.call.hidden = true;
  els.peerStatus.textContent = "Waiting for a peer…";
  els.remoteCaption.textContent = "No remote audio";
  els.audioBlocked.hidden = true;
  els.reconnectBanner.hidden = true;
  els.micMutedNote.hidden = true;
  els.speakerMutedNote.hidden = true;
  if (els.pcFailed) els.pcFailed.hidden = true;
  if (els.mutedSpeaking) els.mutedSpeaking.hidden = true;
  if (els.graphBlocked) els.graphBlocked.hidden = true;
  if (els.interruptMetric) els.interruptMetric.hidden = true;
}


/** Make sure every live peer has an <audio> in #remote-sinks wired to receiver tracks. */
function ensureRemoteAudioElements(reason = "ensure") {
  const report = [];
  for (const [peerId, session] of state.peers.entries()) {
    if (!session?.pc) continue;
    if (!session.audio) {
      session.audio = createRemoteAudio(peerId);
      console.log("[Talkback] created missing audio for peer", peerId);
    }
    if (els.sinks && session.audio && !els.sinks.contains(session.audio)) {
      els.sinks.append(session.audio);
      console.log("[Talkback] re-appended orphan audio for peer", peerId);
    }
    const audioTracks = session.pc
      .getReceivers()
      .map((r) => r.track)
      .filter((tr) => tr && tr.kind === "audio" && tr.readyState !== "ended");
    const existing = session.audio.srcObject;
    const existingIds = existing instanceof MediaStream
      ? existing.getAudioTracks().map((tr) => tr.id).sort().join(",")
      : "";
    const nextIds = audioTracks.map((tr) => tr.id).sort().join(",");
    if (audioTracks.length && existingIds !== nextIds) {
      const stream = new MediaStream(audioTracks);
      session.audio.srcObject = stream;
      session.audio.autoplay = true;
      session.audio.muted = false;
      session.audio.volume = 1;
      console.log("[Talkback] bound receiver tracks to audio", peerId, nextIds);
      attachRemoteMeter(stream);
      els.remoteCaption.textContent = "Remote live";
    }
    report.push({
      peerId,
      pc: session.pc.connectionState,
      ice: session.pc.iceConnectionState,
      receivers: audioTracks.length,
      inSinks: els.sinks?.contains(session.audio) || false,
      hasSrcObject: Boolean(session.audio.srcObject),
      paused: session.audio.paused,
    });
  }
  // Loopback path
  if (state.loopback?.audio) {
    if (els.sinks && !els.sinks.contains(state.loopback.audio)) {
      els.sinks.append(state.loopback.audio);
    }
  }
  console.log(`[Talkback] ensureRemoteAudioElements(${reason})`, {
    peerCount: state.peers.size,
    report,
  });
  return report;
}

function remoteAudioSnapshot(audio, i) {
  const stream = audio.srcObject;
  const track = stream?.getAudioTracks?.()[0];
  return {
    i,
    peer: audio.dataset.peer,
    paused: audio.paused,
    muted: audio.muted,
    volume: audio.volume,
    readyState: audio.readyState,
    networkState: audio.networkState,
    hasSrcObject: Boolean(stream),
    trackId: track?.id,
    trackEnabled: track?.enabled,
    trackMuted: track?.muted,
    trackReady: track?.readyState,
  };
}

/**
 * Kick every remote <audio> to play INSIDE the user-gesture stack.
 * Must not await anything before audio.play() — awaiting burns the gesture.
 */
function kickRemotePlayback(reason = "kick") {
  ensureRemoteAudioElements(reason);
  const nodes = els.sinks ? [...els.sinks.querySelectorAll("audio")] : [];
  // Also include peer session audio even if query missed them.
  for (const session of state.peers.values()) {
    if (session.audio && !nodes.includes(session.audio)) nodes.push(session.audio);
  }
  if (state.loopback?.audio && !nodes.includes(state.loopback.audio)) {
    nodes.push(state.loopback.audio);
  }
  console.log(`[Talkback] kickRemotePlayback(${reason})`, {
    count: nodes.length,
    farEndPaused: state.farEndPaused,
    speakerMuted: state.speakerMuted,
    audioUnlocked: state.audioUnlocked,
    meterCtx: state.meterCtx?.state,
    snapshots: nodes.map(remoteAudioSnapshot),
  });
  if (state.farEndPaused) {
    console.warn("[Talkback] kick aborted: farEndPaused=true");
    return { kicked: 0, blocked: false };
  }
  let kicked = 0;
  let blocked = false;
  for (const audio of nodes) {
    try {
      audio.muted = false;
      audio.volume = 1;
      state.speakerMuted = false;
      if (audio.srcObject) {
        for (const track of audio.srcObject.getAudioTracks()) {
          track.enabled = true;
        }
      }
      const p = audio.play();
      kicked += 1;
      console.log("[Talkback] audio.play() called", remoteAudioSnapshot(audio, kicked - 1), p);
      if (p && typeof p.then === "function") {
        p.then(() => {
          console.log("[Talkback] audio.play() OK", remoteAudioSnapshot(audio, kicked - 1));
          els.audioBlocked.hidden = true;
          updateLiveHud();
        }).catch((err) => {
          console.error("[Talkback] audio.play() REJECTED", err?.name, err?.message, err);
          if (err?.name === "NotAllowedError") {
            els.audioBlocked.hidden = false;
            blocked = true;
          }
        });
      } else {
        els.audioBlocked.hidden = true;
      }
    } catch (err) {
      console.error("[Talkback] audio.play() THREW", err);
      els.audioBlocked.hidden = false;
      blocked = true;
    }
  }
  if (kicked === 0) {
    console.warn("[Talkback] no remote <audio> nodes — peers:", state.peers.size, "mode:", state.mode);
    if (els.audioBlocked) {
      const tip = els.audioBlocked.querySelector("[data-enable-tip]") || (() => {
        const s = document.createElement("span");
        s.dataset.enableTip = "1";
        s.style.display = "block";
        s.style.marginTop = "6px";
        els.audioBlocked.append(s);
        return s;
      })();
      tip.textContent = state.peers.size === 0
        ? "No remote peer yet — open this room in a second tab/device, then click Enable audio again."
        : "Peer is connected but no audio track yet — wait a second and click Enable audio again.";
    }
  }
  applySpeakerMute();
  return { kicked, blocked };
}

/**
 * Unlock autoplay + AudioContext from a user gesture (Join / Enable audio).
 * Call kickRemotePlayback() in the same turn BEFORE awaiting this.
 */
async function unlockAudio() {
  if (!state.meterCtx) {
    state.meterCtx = new AudioContext();
  }
  // Resume graph — may resolve async; remotes should already have play() kicked.
  if (state.meterCtx.state !== "running") {
    try {
      await state.meterCtx.resume();
    } catch {
      /* ignore */
    }
  }
  if (els.graphBlocked) els.graphBlocked.hidden = state.meterCtx.state === "running";

  // Tiny silent WAV to satisfy autoplay policy; ignore failure.
  try {
    const beep = document.createElement("audio");
    beep.playsInline = true;
    beep.src =
      "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
    await beep.play();
    beep.pause();
  } catch {
    /* remotes may still play */
  }
  state.audioUnlocked = true;
  // Second chance after unlock — still within click microtask chain ideally.
  kickRemotePlayback();
  updateLiveHud();
}

function createRemoteAudio(id) {
  // Real speaker path — unmuted <audio> in the DOM (AEC reference). Prefer createElement
  // over `new Audio()` so Chrome treats it as a document media element.
  console.log("[Talkback] createRemoteAudio", id);
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.setAttribute("playsinline", "");
  audio.setAttribute("webkit-playsinline", "");
  audio.preload = "auto";
  audio.controls = false;
  audio.volume = 1;
  audio.muted = false;
  audio.dataset.peer = id;
  // Keep element "visible" to layout (opacity 0) — some browsers are picky about display:none.
  audio.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;";
  els.sinks.append(audio);
  return audio;
}

async function attachRemoteAudio(audio, trackOrStream, caption) {
  const stream = trackOrStream instanceof MediaStream ? trackOrStream : new MediaStream([trackOrStream]);
  audio.autoplay = true;
  audio.playsInline = true;
  audio.muted = false;
  audio.volume = 1;
  if (state.speakerMuted) audio.muted = true;
  audio.srcObject = stream;
  const track = stream.getAudioTracks()[0];
  if (track) {
    track.onended = () => {
      const stillLive = [...state.peers.values()].some(
        (p) => p.pc.connectionState === "connected" || p.pc.iceConnectionState === "connected"
      );
      if (els.pcFailed) els.pcFailed.hidden = stillLive;
      els.remoteCaption.textContent = stillLive ? "Peer connected" : "Remote track ended";
      updateLiveHud();
    };
  }
  const result = await playRemote(audio);
  console.info("AEC far-end attach", {
    paused: audio.paused,
    muted: audio.muted,
    volume: audio.volume,
    readyState: audio.readyState,
    trackMuted: track?.muted,
    trackEnabled: track?.enabled,
    play: result,
  });
  if (caption) els.remoteCaption.textContent = caption;
  updateLiveHud();
  return stream;
}

async function playRemote(audio) {
  if (state.farEndPaused) {
    audio.pause();
    return { paused: true };
  }
  try {
    audio.volume = 1;
    audio.muted = state.speakerMuted;
    await audio.play();
    els.audioBlocked.hidden = true;
    return { ok: true };
  } catch (err) {
    els.audioBlocked.hidden = false;
    return { needsGesture: err.name === "NotAllowedError", err };
  }
}

function rmsFromAnalyser(analyser, buffer) {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const v = (buffer[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buffer.length);
}

function startMeter(stream) {
  if (!state.meterCtx) state.meterCtx = new AudioContext();
  const ctx = state.meterCtx;
  ctx.resume?.();
  const source = ctx.createMediaStreamSource(stream.clone());
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.7;
  source.connect(analyser);
  return {
    source,
    analyser,
    buffer: new Uint8Array(analyser.fftSize),
    close() {
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        /* already torn down */
      }
    },
  };
}

function attachLocalMeter(stream) {
  state.meters.local?.close();
  state.meters.local = startMeter(stream);
  ensureMeterLoop();
}

function attachRemoteMeter(stream) {
  const meter = startMeter(stream);
  state.meters.remote.push(meter);
  ensureMeterLoop();
  return meter;
}

function stopRemoteMeters() {
  for (const meter of state.meters.remote) meter.close();
  state.meters.remote = [];
}

function ensureMeterLoop() {
  if (state.raf) return;
  const localRing = document.querySelector('[data-meter="local"]');
  const remoteRing = document.querySelector('[data-meter="remote"]');
  const tick = () => {
    const local = state.meters.local ? rmsFromAnalyser(state.meters.local.analyser, state.meters.local.buffer) : 0;
    let remote = 0;
    for (const meter of state.meters.remote) {
      remote = Math.max(remote, rmsFromAnalyser(meter.analyser, meter.buffer));
    }
    localRing.style.setProperty("--level", String(Math.min(100, local * 280)));
    remoteRing.style.setProperty("--level", String(Math.min(100, remote * 280)));
    if (els.mutedSpeaking) els.mutedSpeaking.hidden = !(state.micMuted && local > 0.08);
    if (remote > 0.05 && !state.farEndPaused) els.remoteCaption.textContent = "Peer speaking";
    if (els.graphBlocked) els.graphBlocked.hidden = !state.meterCtx || state.meterCtx.state === "running" || state.mode === "idle";
    updateLiveHud();
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

function rtcConfig() {
  return { iceServers: ICE_SERVERS };
}

function wirePeerConnection(pc, peerId) {
  const pendingIce = [];
  let remoteSet = false;
  let iceRestarts = 0;

  pc.onicecandidate = (event) => {
    if (event.candidate) sendSignal({ type: "ice", to: peerId, candidate: event.candidate });
  };

  pc.onconnectionstatechange = () => {
    updatePeerStatus();
    if (els.pcFailed) {
      els.pcFailed.hidden = pc.connectionState !== "failed";
    }
    if (pc.connectionState === "failed" && iceRestarts < ICE_RESTART_LIMIT) {
      iceRestarts += 1;
      restartIce(peerId).catch((err) => console.warn("ICE restart failed", err));
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    const session = state.peers.get(peerId);
    if (!session) return;
    console.log("[Talkback] ontrack", peerId, event.track.kind, event.track.id, event.track.readyState);
    if (!session.audio) session.audio = createRemoteAudio(peerId);
    if (els.sinks && !els.sinks.contains(session.audio)) els.sinks.append(session.audio);
    attachRemoteAudio(session.audio, stream, "Remote live");
    session.meter?.close();
    session.meter = attachRemoteMeter(stream);
    updatePeerStatus();
    // Auto-kick while gesture may still be warm from join.
    kickRemotePlayback("ontrack");
  };

  return {
    async addIce(candidate) {
      if (!candidate) return;
      if (!remoteSet) {
        pendingIce.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn("addIceCandidate failed", err);
      }
    },
    async markRemoteSet() {
      remoteSet = true;
      for (const candidate of pendingIce.splice(0)) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          console.warn("queued ICE failed", err);
        }
      }
    },
  };
}

function createOutgoingPeer(peerId) {
  const pc = new RTCPeerConnection(rtcConfig());
  const audio = createRemoteAudio(peerId);
  const ice = wirePeerConnection(pc, peerId);
  for (const track of state.localStream.getAudioTracks()) {
    pc.addTrack(track, state.localStream);
  }
  const session = { pc, audio, ice, meter: null, makingOffer: false, ignoreOffer: false };
  state.peers.set(peerId, session);
  return session;
}

async function sendOffer(peerId, { iceRestart = false } = {}) {
  const existing = state.peers.get(peerId);
  if (existing && !iceRestart) {
    const st = existing.pc.connectionState;
    const ice = existing.pc.iceConnectionState;
    // Keep a live or in-flight peer; only replace failed/closed/disconnected.
    if (st === "connected" || st === "connecting" || ice === "connected" || ice === "checking") {
      return;
    }
    closePeer(peerId);
  }
  const session = state.peers.get(peerId) || createOutgoingPeer(peerId);
  session.makingOffer = true;
  try {
    const offer = await session.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await session.pc.setLocalDescription(offer);
    sendSignal({ type: "offer", to: peerId, sdp: session.pc.localDescription });
  } finally {
    session.makingOffer = false;
  }
}

async function restartIce(peerId) {
  const session = state.peers.get(peerId);
  if (!session || session.pc.signalingState !== "stable") return;
  await sendOffer(peerId, { iceRestart: true });
}

async function handleOffer(from, sdp) {
  let session = state.peers.get(from) || createOutgoingPeer(from);
  const polite = state.clientId > from;
  const offerCollision = session.makingOffer || session.pc.signalingState !== "stable";
  session.ignoreOffer = !polite && offerCollision;
  if (session.ignoreOffer) return;
  if (offerCollision && polite) {
    try {
      await session.pc.setLocalDescription({ type: "rollback" });
    } catch {
      closePeer(from);
      session = createOutgoingPeer(from);
    }
  }
  try {
    await session.pc.setRemoteDescription(sdp);
  } catch {
    closePeer(from);
    session = createOutgoingPeer(from);
    await session.pc.setRemoteDescription(sdp);
  }
  await session.ice.markRemoteSet();
  const answer = await session.pc.createAnswer();
  await session.pc.setLocalDescription(answer);
  sendSignal({ type: "answer", to: from, sdp: session.pc.localDescription });
}

async function handleAnswer(from, sdp) {
  const session = state.peers.get(from);
  if (!session) return;
  if (session.pc.signalingState === "stable") return;
  await session.pc.setRemoteDescription(sdp);
  await session.ice.markRemoteSet();
}

async function handleIce(from, candidate) {
  const session = state.peers.get(from);
  if (!session) return;
  try {
    await session.ice.addIce(candidate);
  } catch (err) {
    if (!session.ignoreOffer) console.warn("ICE add failed", err);
  }
}

function closePeer(peerId) {
  const session = state.peers.get(peerId);
  if (!session) return;
  session.pc.onicecandidate = null;
  session.pc.ontrack = null;
  session.pc.close();
  session.audio.remove();
  session.meter?.close();
  state.peers.delete(peerId);
}

function closeAllPeers() {
  for (const id of [...state.peers.keys()]) closePeer(id);
  stopRemoteMeters();
}

function updatePeerStatus() {
  if (state.mode === "loopback") {
    els.peerStatus.textContent = "Loopback · your mic via WebRTC";
    return;
  }
  const n = state.peers.size;
  const live = [...state.peers.values()].filter((p) => p.pc.connectionState === "connected").length;
  if (n === 0) {
    els.peerStatus.textContent = "Waiting for a peer… share the link";
    els.remoteCaption.textContent = "No remote audio";
    return;
  }
  const ice = [...state.peers.values()].map((p) => p.pc.iceConnectionState).join(", ");
  els.peerStatus.textContent = live
    ? `${live} connected · ICE ${ice}`
    : `Connecting to ${n} peer${n === 1 ? "" : "s"} · ${ice}`;
}

function sendSignal(message) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(message));
  }
}

function stopPing() {
  if (state.pingTimer) {
    clearInterval(state.pingTimer);
    state.pingTimer = 0;
  }
}

function startPing() {
  stopPing();
  state.pingTimer = setInterval(() => sendSignal({ type: "ping" }), PING_MS);
}

function connectSignaling() {
  if (state.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
  const previous = state.ws;
  state.ws = null;
  if (previous) {
    try {
      previous.close();
    } catch {
      /* ignore */
    }
  }
  return new Promise((resolve, reject) => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    state.ws = ws;
    setConnBadge("Signaling…", "badge-live");
    let settled = false;

    ws.addEventListener("message", async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      try {
        await onSignal(message);
      } catch (err) {
        console.error(err);
        showError(els.callError, err.message || "Call signaling failed.");
      }
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Signaling timed out."));
      ws.close();
    }, 8000);

    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setConnBadge("Signaling up", "badge-on");
      startPing();
      resolve();
    });

    ws.addEventListener("close", () => {
      if (state.ws !== ws) return;
      clearTimeout(timer);
      stopPing();
      if (state.mode === "room") {
        setConnBadge("Reconnecting…", "badge-live");
        scheduleReconnect();
      } else if (state.mode === "idle") {
        setConnBadge("Idle");
      }
    });

    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setConnBadge("Signaling error", "badge-off");
      reject(new Error("Could not reach the signaling server."));
    });
  });
}

function scheduleReconnect() {
  if (state.mode !== "room" || state.reconnecting) return;
  if (state.ws?.readyState === WebSocket.OPEN) {
    els.reconnectBanner.hidden = true;
    setConnBadge("Signaling up", "badge-on");
    return;
  }
  if (state.reconnectAttempts >= MAX_RECONNECTS) {
    els.reconnectBanner.hidden = false;
    setConnBadge("Signaling down", "badge-off");
    showError(els.callError, "Signaling kept dropping. Use Retry now, or hang up and rejoin.");
    return;
  }
  state.reconnecting = true;
  const mediaOk = [...state.peers.values()].some(
    (p) => p.pc.connectionState === "connected" || p.pc.iceConnectionState === "connected"
  );
  // Don't panic the UI if media is still flowing — quiet reconnect.
  els.reconnectBanner.hidden = mediaOk;
  const delay = Math.min(8000, 400 * 2 ** state.reconnectAttempts);
  state.reconnectAttempts += 1;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    reconnectNow().catch((err) => {
      console.warn(err);
      state.reconnecting = false;
      scheduleReconnect();
    });
  }, delay);
}

async function reconnectNow() {
  if (state.mode !== "room") return;
  clearTimeout(state.reconnectTimer);
  state.reconnecting = true;
  els.reconnectBanner.hidden = false;
  const live = [...state.peers.values()].some((p) => p.pc.connectionState === "connected" || p.pc.iceConnectionState === "connected");
  if (!live) closeAllPeers();
  await connectSignaling();
  console.log("[Talkback] join", { room: state.room, resumeId: state.clientId });
  sendSignal({ type: "join", room: state.room, resumeId: state.clientId });
  state.reconnectAttempts = 0;
  state.reconnecting = false;
  els.reconnectBanner.hidden = true;
  showError(els.callError, "");
  setConnBadge("Signaling up", "badge-on");
  const healthy = [...state.peers.values()].some(
    (p) => p.pc.connectionState === "connected" || p.pc.iceConnectionState === "connected"
  );
  if (healthy && els.pcFailed) els.pcFailed.hidden = true;
}

async function onSignal(message) {
  switch (message.type) {
    case "welcome":
      if (!sessionStorage.getItem(CLIENT_KEY)) {
        state.clientId = message.id;
        sessionStorage.setItem(CLIENT_KEY, state.clientId);
      }
      break;
    case "joined":
      state.room = message.room;
      for (const peerId of message.peers || []) {
        const existing = state.peers.get(peerId);
        if (existing && (existing.pc.connectionState === "connected" || existing.pc.iceConnectionState === "connected")) continue;
        await sendOffer(peerId);
      }
      updatePeerStatus();
      break;
    case "peer-joined":
      updatePeerStatus();
      // Both sides may offer; glare is handled in handleOffer.
      if (message.id && !state.peers.has(message.id)) {
        sendOffer(message.id).catch((err) => console.warn("offer on peer-joined failed", err));
      }
      break;
    case "peer-left":
      closePeer(message.id);
      updatePeerStatus();
      break;
    case "offer":
      await handleOffer(message.from, message.sdp);
      break;
    case "answer":
      await handleAnswer(message.from, message.sdp);
      break;
    case "ice":
      await handleIce(message.from, message.candidate);
      break;
    case "error":
      showError(els.callError, message.message);
      break;
    case "pong":
      break;
    default:
      break;
  }
}

function permissionMessage(err) {
  if (err?.name === "NotAllowedError") return "Microphone permission was denied.";
  if (err?.name === "NotFoundError") return "No microphone found.";
  if (err?.name === "NotSupportedError") return "WebRTC is not available in this browser.";
  return err.message || "Could not start audio.";
}

async function joinRoom(room) {
  const code = room.trim().toUpperCase();
  if (!code) {
    showError(els.lobbyError, "Enter a room code.");
    return;
  }
  els.joinBtn.disabled = true;
  els.loopbackBtn.disabled = true;
  try {
    await unlockAudio();
    await stopEverything({ keepWs: true });
    await getMic();
    await connectSignaling();
    state.mode = "room";
    state.room = code;
    setRoomInUrl(code);
    showCall(code, "Room");
    console.log("[Talkback] join", { room: code, resumeId: state.clientId });
  sendSignal({ type: "join", room: code, resumeId: state.clientId });
    startStats();
    updatePeerStatus();
  } catch (err) {
    showError(els.lobbyError, permissionMessage(err));
    await stopEverything();
  } finally {
    els.joinBtn.disabled = false;
    els.loopbackBtn.disabled = false;
  }
}

async function startLoopback() {
  els.loopbackBtn.disabled = true;
  els.joinBtn.disabled = true;
  try {
    await unlockAudio();
    await stopEverything();
    await getMic();
    const pc1 = new RTCPeerConnection(rtcConfig());
    const pc2 = new RTCPeerConnection(rtcConfig());
    pc1.onicecandidate = (e) => {
      if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {});
    };
    pc2.onicecandidate = (e) => {
      if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {});
    };
    for (const track of state.localStream.getAudioTracks()) {
      pc1.addTrack(track, state.localStream);
    }
    const audio = createRemoteAudio("loopback");
    pc2.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      attachRemoteAudio(audio, stream, "Loopback live");
      attachRemoteMeter(stream);
    };
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);
    state.loopback = { pc1, pc2, audio };
    state.mode = "loopback";
    setConnBadge("Loopback", "badge-live");
    showCall("SELF-TEST", "Loopback");
    startStats();
    updatePeerStatus();
  } catch (err) {
    showError(els.lobbyError, permissionMessage(err));
    await stopEverything();
  } finally {
    els.loopbackBtn.disabled = false;
    els.joinBtn.disabled = false;
  }
}

async function replaceMicTrack() {
  const { stream, previous } = await getMic({ stopPrevious: false });
  const track = stream.getAudioTracks()[0];
  const replacements = [];
  for (const session of state.peers.values()) {
    const sender = session.pc.getSenders().find((s) => s.track?.kind === "audio");
    if (sender) replacements.push(sender.replaceTrack(track));
  }
  if (state.loopback) {
    const sender = state.loopback.pc1.getSenders().find((s) => s.track?.kind === "audio");
    if (sender) replacements.push(sender.replaceTrack(track));
  }
  await Promise.all(replacements);
  if (previous) {
    for (const oldTrack of previous.getTracks()) oldTrack.stop();
  }
}

async function toggleAec() {
  state.aecEnabled = !state.aecEnabled;
  setAecUi();
  els.aecBtn.disabled = true;
  try {
    const track = state.localStream?.getAudioTracks()[0];
    const next = state.aecEnabled
      ? { echoCancellation: { ideal: "all" }, noiseSuppression: true, autoGainControl: true }
      : { echoCancellation: false, noiseSuppression: true, autoGainControl: true };
    if (track?.applyConstraints) {
      try {
        await track.applyConstraints(next);
        readAppliedProcessing();
        const applied = track.getSettings().echoCancellation;
        if (state.aecEnabled === aecIsOn(applied) || (!state.aecEnabled && applied === false)) {
          return;
        }
      } catch {
        /* fall through to re-gUM + replaceTrack */
      }
    }
    await replaceMicTrack();
  } catch (err) {
    showError(els.callError, permissionMessage(err));
  } finally {
    els.aecBtn.disabled = false;
  }
}

function startStats() {
  stopStats();
  const tick = async () => {
    const pcs = state.loopback ? [state.loopback.pc1] : [...state.peers.values()].map((p) => p.pc);
    let rtt = null;
    for (const pc of pcs) {
      try {
        const stats = await pc.getStats();
        for (const report of stats.values()) {
          if (report.type === "candidate-pair" && (report.state === "succeeded" || report.nominated) && report.currentRoundTripTime != null) {
            rtt = (rtt == null ? 0 : rtt) + report.currentRoundTripTime * 1000;
          }
        }
      } catch {
        /* stats not available */
      }
    }
    state.rttMs = rtt;
    updateLiveHud();
  };
  tick();
  state.statsTimer = setInterval(tick, 2000);
}

function stopStats() {
  if (state.statsTimer) {
    clearInterval(state.statsTimer);
    state.statsTimer = 0;
  }
  state.rttMs = null;
}

async function playTestTone() {
  await unlockAudio();
  const ctx = state.meterCtx || new AudioContext();
  state.meterCtx = ctx;
  await ctx.resume().catch(() => {});
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 440;
  gain.gain.value = 0.08;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
  osc.stop(ctx.currentTime + 0.4);
  if (els.toneStatus) els.toneStatus.textContent = "If you heard a short beep, speakers work. Then join a room — that same click path unlocks remote audio.";
}

async function stopEverything({ keepWs = false } = {}) {
  state.mode = "idle";
  state.room = "";
  state.reconnecting = false;
  state.reconnectAttempts = 0;
  clearTimeout(state.reconnectTimer);
  sendSignal({ type: "leave" });
  closeAllPeers();
  if (state.loopback) {
    state.loopback.pc1.close();
    state.loopback.pc2.close();
    state.loopback.audio.remove();
    state.loopback = null;
  }
  stopRemoteMeters();
  state.meters.local?.close();
  state.meters.local = null;
  for (const track of state.localStream?.getTracks() || []) track.stop();
  state.localStream = null;
  els.sinks.replaceChildren();
  state.farEndPaused = false;
  applyFarEndPause();
  stopStats();
  if (!keepWs && state.ws) {
    const socket = state.ws;
    state.ws = null;
    stopPing();
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
  if (!keepWs) setConnBadge("Idle");
  showLobby();
}

async function copyText(value, button, copiedLabel) {
  const previous = button.dataset.label || button.textContent;
  button.dataset.label = previous;
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = copiedLabel;
  } catch {
    try {
      const field = document.createElement("textarea");
      field.value = value;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      document.execCommand("copy");
      field.remove();
      button.textContent = copiedLabel;
    } catch {
      showError(els.lobbyError, "Copy failed — use the address bar.");
      return;
    }
  }
  setTimeout(() => {
    button.textContent = button.dataset.label || previous;
  }, 1400);
}

els.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  joinRoom(els.roomInput.value);
});

els.shuffleBtn.addEventListener("click", () => {
  els.roomInput.value = randomRoom();
  setRoomInUrl(els.roomInput.value);
});

els.copyLinkBtn.addEventListener("click", () => {
  const room = els.roomInput.value.trim().toUpperCase() || randomRoom();
  els.roomInput.value = room;
  setRoomInUrl(room);
  copyText(location.href, els.copyLinkBtn, "Copied");
});

els.copyCodeBtn.addEventListener("click", () => {
  const room = els.roomInput.value.trim().toUpperCase() || randomRoom();
  els.roomInput.value = room;
  setRoomInUrl(room);
  copyText(room, els.copyCodeBtn, "Copied");
});

els.callCopyLink.addEventListener("click", () => {
  copyText(location.href, els.callCopyLink, "Copied");
});

els.loopbackBtn.addEventListener("click", () => startLoopback());
els.toneBtn?.addEventListener("click", () => playTestTone());
els.scenarioSpeakers?.addEventListener("click", () => setScenario("speakers"));
els.scenarioHeadphones?.addEventListener("click", () => setScenario("headphones"));
els.resumeGraphBtn?.addEventListener("click", async (event) => {
  event.preventDefault();
  kickRemotePlayback();
  await unlockAudio();
  kickRemotePlayback();
});
els.micBtn.addEventListener("click", () => {
  state.micMuted = !state.micMuted;
  applyMicMute();
  updateLiveHud();
});
els.speakerBtn.addEventListener("click", () => {
  state.speakerMuted = !state.speakerMuted;
  applySpeakerMute();
  updateLiveHud();
});
els.pauseRemoteBtn.addEventListener("click", () => {
  state.farEndPaused = !state.farEndPaused;
  applyFarEndPause();
});
els.aecBtn.addEventListener("click", () => toggleAec());
els.hangupBtn.addEventListener("click", () => stopEverything());
els.reconnectNowBtn.addEventListener("click", () => {
  state.reconnecting = false;
  reconnectNow().catch((err) => showError(els.callError, permissionMessage(err)));
});
async function onEnableAudioClick(event, source = "enable-audio-btn") {
  event?.preventDefault?.();
  console.log(`[Talkback] Enable audio CLICK from ${source}`, {
    btn: Boolean(els.enableAudioBtn),
    sinks: Boolean(els.sinks),
    audioBlockedHidden: els.audioBlocked?.hidden,
    peers: state.peers.size,
    mode: state.mode,
    peerIds: [...state.peers.keys()],
    time: new Date().toISOString(),
  });
  // Audible proof the gesture reached JS (even if remote play fails).
  try {
    const ctx = state.meterCtx || new AudioContext();
    state.meterCtx = ctx;
    console.log("[Talkback] AudioContext state before resume", ctx.state);
    if (ctx.state !== "running") await ctx.resume();
    console.log("[Talkback] AudioContext state after resume", ctx.state);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    console.log("[Talkback] played 880Hz confirmation beep");
  } catch (err) {
    console.error("[Talkback] confirmation beep failed", err);
  }
  // CRITICAL: kick play() before further awaits burn the gesture.
  state.speakerMuted = false;
  state.farEndPaused = false;
  applySpeakerMute();
  const first = kickRemotePlayback("enable-audio-before-unlock");
  console.log("[Talkback] first kick result", first);
  await unlockAudio();
  console.log("[Talkback] unlockAudio finished", {
    audioUnlocked: state.audioUnlocked,
    meterCtx: state.meterCtx?.state,
  });
  applySpeakerMute();
  const second = kickRemotePlayback("enable-audio-after-unlock");
  console.log("[Talkback] second kick result", second);
  updateLiveHud();
  if (els.audioBlocked) {
    els.audioBlocked.hidden = second.kicked > 0 && !second.blocked;
  }
  if (els.graphBlocked) {
    els.graphBlocked.hidden = state.meterCtx?.state === "running";
  }
}

if (els.enableAudioBtn) {
  els.enableAudioBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onEnableAudioClick(event, "button");
  });
  console.log("[Talkback] Enable audio button listener attached");
} else {
  console.error("[Talkback] #enable-audio-btn NOT FOUND — listener not attached");
}
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.id === "enable-audio-btn" || target.closest?.("#enable-audio-btn")) {
    if (event.defaultPrevented) return;
    onEnableAudioClick(event, "delegated");
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    state.meterCtx?.resume?.();
    if (state.mode === "room" && state.ws?.readyState !== WebSocket.OPEN) {
      state.reconnecting = false;
      scheduleReconnect();
    }
  }
});

window.addEventListener("online", () => {
  if (state.mode === "room" && state.ws?.readyState !== WebSocket.OPEN) {
    state.reconnecting = false;
    scheduleReconnect();
  }
});

window.addEventListener("beforeunload", () => {
  sendSignal({ type: "leave" });
});

els.roomInput.value = roomFromUrl() || randomRoom();
setRoomInUrl(els.roomInput.value);
els.browserBadge.textContent = browserLabel();
setScenario("speakers");
setAecUi();
setConnBadge("Idle");


// First gestures unlock autoplay — play() first, await later.
document.addEventListener(
  "pointerdown",
  () => {
    kickRemotePlayback();
    unlockAudio().catch(() => {});
  },
  { capture: true }
);
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Enter" || event.key === " ") {
      kickRemotePlayback();
      unlockAudio().catch(() => {});
    }
  },
  { capture: true }
);
