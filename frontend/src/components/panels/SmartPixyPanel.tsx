import { useEffect, useState } from "react";
import {
  ChevronDown,
  Crosshair,
  FlipHorizontal2,
  Gauge,
  Lock,
  Move,
  PersonStanding,
  Power,
  ScanFace,
  Settings2,
  Shield,
  Sparkles,
  Volume2
} from "lucide-react";

import type { UseAudioResult } from "../../hooks/useAudio";
import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import { rangeFill } from "../../lib/rangeFill";
import type { AudioMode, FocusMeteringMode, MirrorMode, TargetTrackingMode, TrackingMode } from "../../types/api";
import "./SmartPixyPanel.css";

type Props = {
  pixyHid: UsePixyHidResult;
  audio: UseAudioResult;
  privacySafety: UsePrivacySafetyResult;
};

const audioModes: { value: AudioMode; label: string }[] = [
  { value: "noise_cancel", label: "NC" },
  { value: "live", label: "Live" },
  { value: "original", label: "Original" }
];

const autoPrivacyPresets = [
  { value: 0, label: "Never" },
  { value: 10, label: "10s" },
  { value: 60, label: "1m" },
  { value: 900, label: "15m" }
];

const mirrorModes: { value: MirrorMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "h", label: "H" },
  { value: "v", label: "V" },
  { value: "hv", label: "HV" }
];

const focusMeteringModes: { value: FocusMeteringMode; label: string }[] = [
  { value: "center", label: "Center" },
  { value: "human_face", label: "Face" },
  { value: "selected_area", label: "Region" }
];

const targetTrackingModes: { value: TargetTrackingMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "face", label: "Face" },
  { value: "half_body", label: "Half body" },
  { value: "full_body", label: "Full body" }
];

export function SmartPixyPanel({ pixyHid, audio, privacySafety }: Props) {
  const writable = pixyHid.status?.writable ?? false;
  const available = pixyHid.status?.available ?? false;
  const disabled = !writable || pixyHid.pendingCommand !== null;
  const micMuted = audio.status?.muted === true;
  const micAvailable = audio.status?.available === true;
  const privacyEnabled = pixyHid.deviceTrackingState === "privacy" || pixyHid.trackingMode === "privacy";
  const trackingEnabled = pixyHid.deviceTrackingState === "tracking" || pixyHid.trackingMode === "tracking";
  const deviceTracking = deviceTrackingStateText(
    pixyHid.deviceTrackingState,
    pixyHid.deviceTrackingRawValue,
    pixyHid.deviceTrackingRawBits
  );
  const privacyHelp = privacyHelpText(pixyHid, privacyEnabled, trackingEnabled);
  const unsupported = pixyHid.unsupportedReadbacks ?? [];
  const [autoPrivacyDraft, setAutoPrivacyDraft] = useState(String(pixyHid.autoPrivacySeconds ?? 0));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [panSpeedDraft, setPanSpeedDraft] = useState(String(pixyHid.motorSpeedPanDeg ?? 60));
  const [tiltSpeedDraft, setTiltSpeedDraft] = useState(String(pixyHid.motorSpeedTiltDeg ?? 60));
  const [panTargetDraft, setPanTargetDraft] = useState("0");
  const [tiltTargetDraft, setTiltTargetDraft] = useState("0");
  // Local gain while dragging; committed once on release like the V4L2 sliders.
  const [gainDraft, setGainDraft] = useState<number | null>(null);
  const gainValue = gainDraft ?? audio.status?.volume ?? 0;

  useEffect(() => {
    setAutoPrivacyDraft(String(pixyHid.autoPrivacySeconds ?? 0));
  }, [pixyHid.autoPrivacySeconds]);

  useEffect(() => {
    if (pixyHid.motorSpeedPanDeg !== null && pixyHid.motorSpeedPanDeg !== undefined) {
      setPanSpeedDraft(String(pixyHid.motorSpeedPanDeg));
    }
    if (pixyHid.motorSpeedTiltDeg !== null && pixyHid.motorSpeedTiltDeg !== undefined) {
      setTiltSpeedDraft(String(pixyHid.motorSpeedTiltDeg));
    }
  }, [pixyHid.motorSpeedPanDeg, pixyHid.motorSpeedTiltDeg]);

  const commitAutoPrivacy = () => {
    const parsed = Number(autoPrivacyDraft);
    const clamped = Number.isFinite(parsed) ? Math.min(900, Math.max(0, Math.trunc(parsed))) : 0;
    setAutoPrivacyDraft(String(clamped));
    if (pixyHid.autoPrivacySeconds !== clamped) {
      void pixyHid.setAutoPrivacySeconds(clamped);
    }
  };

  const setAutoPrivacyPreset = (seconds: number) => {
    setAutoPrivacyDraft(String(seconds));
    if (pixyHid.autoPrivacySeconds !== seconds) {
      void pixyHid.setAutoPrivacySeconds(seconds);
    }
  };

  const commitGain = () => {
    if (gainDraft === null) {
      return;
    }
    setGainDraft(null);
    if (gainDraft !== audio.status?.volume) {
      void audio.setVolume(gainDraft);
    }
  };

  const commitMotorSpeed = (axis: 1 | 2, draft: string, resetDraft: (value: string) => void) => {
    const parsed = Number(draft);
    const clamped = Number.isFinite(parsed) ? Math.min(360, Math.max(1, parsed)) : 60;
    resetDraft(String(clamped));
    const current = axis === 1 ? pixyHid.motorSpeedPanDeg : pixyHid.motorSpeedTiltDeg;
    if (current !== clamped) {
      void pixyHid.setMotorSpeed(axis, clamped);
    }
  };

  const goToAbsolute = () => {
    const pan = clampDraft(panTargetDraft, -150, 150, 0);
    const tilt = clampDraft(tiltTargetDraft, -90, 90, 0);
    setPanTargetDraft(String(pan));
    setTiltTargetDraft(String(tilt));
    void pixyHid.sendPtzAbsolute(pan, tilt);
  };

  const setControlMode = (mode: TrackingMode) => {
    if (mode === "privacy") {
      void privacySafety.enterPrivacy();
      return;
    }
    if (mode === "off") {
      void pixyHid.setTrackingMode("off");
      return;
    }
    void pixyHid.setTrackingMode(mode);
  };

  return (
    <section className="smart-panel smart-pixy-panel">
      <div className="panel-title-row">
        <Sparkles size={16} />
        <h2>Smart Pixy</h2>
      </div>

      <div className="hid-status-row">
        <span className={`hid-dot ${writable ? "is-ready" : available ? "is-warn" : ""}`} />
        <div>
          <strong>{writable ? "HID ready" : available ? "HID permission needed" : "HID not found"}</strong>
          <small title={pixyHid.status?.path ?? undefined}>
            {pixyHid.status?.path ??
              (!writable && pixyHid.status?.reason ? null : (pixyHid.status?.reason ?? "Scanning hidraw devices"))}
          </small>
        </div>
      </div>

      {pixyHid.error && <div className="mini-error">{pixyHid.error}</div>}
      {!writable && pixyHid.status?.reason && <div className="mini-warning">{pixyHid.status.reason}</div>}
      {!writable && available && (
        <small className="hid-permission-hint">
          Grant hidraw access: install <code>deploy/udev/70-pixypilot-hid.rules</code> (or add your user to
          the <code>plugdev</code> group), then reload udev and replug the camera.
        </small>
      )}
      <div className={`privacy-safety-strip state-${privacySafetyTone(privacySafety)}`} role="status">
        <Shield size={14} />
        <span>{privacySafetyText(privacySafety)}</span>
      </div>

      <div className="smart-control-stack">
        <details className="smart-control privacy-control" open>
          <summary className="smart-label">
            <ScanFace size={16} />
            <span>Tracking &amp; follow</span>
            <ChevronDown className="collapse-caret" size={14} />
          </summary>
          <div className="privacy-control-body">
            <div className={`device-mode-readback state-${pixyHid.deviceTrackingState}`}>
              <span>Camera reports</span>
              <strong title={deviceTracking.raw ?? undefined}>
                <span className="state-dot" aria-hidden="true" />
                {deviceTracking.label}
              </strong>
            </div>
            <div className="privacy-mode-row mode-stack">
              <span>Mode</span>
              <div className="segmented control-mode-command">
                {controlModes.map((mode) => (
                  <button
                    key={mode.value}
                    className={pixyHid.trackingMode === mode.value ? "is-selected" : ""}
                    aria-pressed={pixyHid.trackingMode === mode.value}
                    data-tone={mode.value === "privacy" ? "warn" : undefined}
                    disabled={disabled}
                    onClick={() => setControlMode(mode.value)}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mic-mute-row">
              <div>
                <strong>Gesture control</strong>
                <small>Wave to toggle tracking</small>
              </div>
              <button
                className={`toggle-switch ${pixyHid.gestureEnabled ? "is-on" : ""}`}
                disabled={disabled}
                aria-pressed={pixyHid.gestureEnabled === true}
                aria-label="Gesture Control"
                onClick={() => void pixyHid.setGestureEnabled(!(pixyHid.gestureEnabled ?? false))}
              >
                <span />
              </button>
            </div>
            <small className="privacy-help">
              {privacyHelp}
            </small>
          </div>
        </details>

        <details className="smart-control privacy-control">
          <summary className="smart-label">
            <Shield size={16} />
            <span>Privacy timer</span>
            <ChevronDown className="collapse-caret" size={14} />
          </summary>
          <div className="privacy-control-body">
            <div className="privacy-mode-row">
              <span>Auto-enter</span>
              <div className="segmented">
                {autoPrivacyPresets.map((preset) => (
                  <button
                    key={preset.value}
                    className={pixyHid.autoPrivacySeconds === preset.value ? "is-selected" : ""}
                    aria-pressed={pixyHid.autoPrivacySeconds === preset.value}
                    disabled={disabled}
                    onClick={() => setAutoPrivacyPreset(preset.value)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="privacy-delay-input">
              <input
                className="number-input"
                type="number"
                min={0}
                max={900}
                step={1}
                disabled={disabled}
                aria-label="Auto-privacy delay in seconds"
                value={autoPrivacyDraft}
                onChange={(event) => setAutoPrivacyDraft(event.target.value)}
                onBlur={commitAutoPrivacy}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitAutoPrivacy();
                  }
                }}
              />
              <span>sec</span>
            </div>
            <small className="privacy-help">
              The captured delay writes and reads back, but the camera-side trigger is unconfirmed —
              treat as experimental.
            </small>
          </div>
        </details>

        <details className="smart-control">
          <summary className="smart-label">
            <FlipHorizontal2 size={16} />
            <span>Orientation</span>
            <ChevronDown className="collapse-caret" size={14} />
          </summary>
          <div className="privacy-mode-row">
            <span>Mirror</span>
            <div className="segmented">
              {mirrorModes.map((mode) => (
                <button
                  key={mode.value}
                  className={pixyHid.mirrorMode === mode.value ? "is-selected" : ""}
                  aria-pressed={pixyHid.mirrorMode === mode.value}
                  disabled={disabled}
                  onClick={() => void pixyHid.setMirrorMode(mode.value)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mic-mute-row">
            <div>
              <strong>Auto rotate</strong>
              <small>Flip the image when the camera is upside down</small>
            </div>
            <button
              className={`toggle-switch ${pixyHid.autoRotateEnabled ? "is-on" : ""}`}
              disabled={disabled}
              aria-pressed={pixyHid.autoRotateEnabled === true}
              aria-label="Auto Rotate"
              onClick={() => void pixyHid.setAutoRotateEnabled(!(pixyHid.autoRotateEnabled ?? false))}
            >
              <span />
            </button>
          </div>
          <small className="privacy-help">Mirror flips only apply while the video preview is streaming.</small>
        </details>

        <details className="smart-control">
          <summary className="smart-label">
            <Crosshair size={16} />
            <span>Focus</span>
            <ChevronDown className="collapse-caret" size={14} />
          </summary>
          <div className="privacy-mode-row">
            <span>Target</span>
            <div className="segmented">
              {focusMeteringModes.map((mode) => (
                <button
                  key={mode.value}
                  className={pixyHid.focusMeteringMode === mode.value ? "is-selected" : ""}
                  aria-pressed={pixyHid.focusMeteringMode === mode.value}
                  disabled={disabled}
                  onClick={() => void pixyHid.setFocusMeteringMode(mode.value)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
          <small className="privacy-help">
            {pixyHid.focusMeteringMode === "selected_area" && pixyHid.focusMeteringPoint
              ? `Region metering at ${pixyHid.focusMeteringPoint.x},${pixyHid.focusMeteringPoint.y}. Click the preview to aim it.`
              : "Region meters where you click in the video preview."}
          </small>
        </details>

        <details className="smart-control">
          <summary className="smart-label">
            <Volume2 size={16} />
            <span>Audio</span>
            <ChevronDown className="collapse-caret" size={14} />
          </summary>
          <div className="segmented" role="group" aria-label="Audio processing">
            {audioModes.map((mode) => (
              <button
                key={mode.value}
                className={pixyHid.audioMode === mode.value ? "is-selected" : ""}
                aria-pressed={pixyHid.audioMode === mode.value}
                disabled={disabled}
                onClick={() => void pixyHid.setAudioMode(mode.value)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="mic-mute-row">
            <div>
              <strong>Mic mute</strong>
              <small>
                {micAvailable
                  ? `ALSA card ${audio.status?.card}${audio.status?.volume !== null ? `, gain ${audio.status?.volume}` : ""}`
                  : audio.status?.reason ?? "Scanning USB audio"}
              </small>
            </div>
            <button
              className={`toggle-switch ${micMuted ? "is-on" : ""}`}
              disabled={!micAvailable || audio.pending}
              aria-pressed={micMuted}
              aria-label="Mic mute"
              onClick={() => void audio.setMuted(!micMuted)}
            >
              <span />
            </button>
          </div>
          {audio.error && <div className="mini-error">{audio.error}</div>}
          {micAvailable && (
            <>
              <div className="privacy-mode-row slider-row">
                <span>Gain {gainDraft ?? audio.status?.volume ?? "—"}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  aria-label="Mic gain"
                  value={gainValue}
                  style={rangeFill(gainValue, 0, 100)}
                  onChange={(event) => setGainDraft(Number(event.target.value))}
                  onPointerUp={commitGain}
                  onKeyUp={commitGain}
                  onBlur={commitGain}
                />
              </div>
              <div className="mic-mute-row">
                <div>
                  <strong>Monitor</strong>
                  <small>{audio.status?.monitor_running ? "Listening via PipeWire loopback" : "Hear the PIXY mic locally"}</small>
                </div>
                <button
                  className={`toggle-switch ${audio.status?.monitor_running ? "is-on" : ""}`}
                  disabled={audio.pending}
                  aria-pressed={audio.status?.monitor_running ?? false}
                  aria-label="Mic monitor"
                  onClick={() => void audio.setMonitorRunning(!(audio.status?.monitor_running ?? false))}
                >
                  <span />
                </button>
              </div>
              {audio.setMeterRunning && (
                <div className="mic-mute-row">
                  <div>
                    <strong>Level meter</strong>
                    <small>
                      {audio.status?.meter_running
                        ? "Live mic level"
                        : micMuted
                          ? "Meters nothing while muted"
                          : "Read the PIXY mic level"}
                    </small>
                  </div>
                  <button
                    className={`toggle-switch ${audio.status?.meter_running ? "is-on" : ""}`}
                    disabled={audio.pending}
                    aria-pressed={audio.status?.meter_running ?? false}
                    aria-label="Mic level meter"
                    onClick={() => void audio.setMeterRunning?.(!(audio.status?.meter_running ?? false))}
                  >
                    <span />
                  </button>
                </div>
              )}
              {audio.status?.meter_running === true && (
                <div
                  className="mic-level-meter"
                  role="meter"
                  aria-label="Mic level"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={audio.status.level ?? 0}
                >
                  <div className="mic-level-fill" style={{ width: `${audio.status.level ?? 0}%` }} />
                </div>
              )}
              {audio.status?.default_source === false && (
                <button className="primary-action" disabled={audio.pending} onClick={() => void audio.setDefaultSource()}>
                  Set as default microphone
                </button>
              )}
              {audio.status?.default_source === true && audio.status?.previous_default_source === true && audio.restoreDefaultSource && (
                <button className="panel-action-button" disabled={audio.pending} onClick={() => void audio.restoreDefaultSource?.()}>
                  Restore previous microphone
                </button>
              )}
            </>
          )}
        </details>

        <details className="smart-control">
          <summary className="smart-label">
            <Lock size={16} />
            <span>Locks &amp; imaging</span>
            <ChevronDown className="collapse-caret" size={14} />
          </summary>
          <div className="smart-toggle-stack">
            <ToggleRow
              label="WB lock"
              hint="Freeze auto white balance"
              checked={pixyHid.wbLockEnabled === true}
              disabled={disabled}
              onToggle={() => void pixyHid.setWbLock(!(pixyHid.wbLockEnabled ?? false))}
            />
            <ToggleRow
              label="EV lock"
              hint="Freeze auto exposure"
              checked={pixyHid.evLockEnabled === true}
              disabled={disabled}
              onToggle={() => void pixyHid.setEvLock(!(pixyHid.evLockEnabled ?? false))}
            />
            <ToggleRow
              label="Focus lock"
              hint="Freeze autofocus position"
              checked={pixyHid.focusLockEnabled === true}
              disabled={disabled}
              onToggle={() => void pixyHid.setFocusLock(!(pixyHid.focusLockEnabled ?? false))}
            />
            <ToggleRow
              label="Denoise"
              hint={
                unsupported.includes("denoise_state")
                  ? "Sent, but this firmware does not report denoise state"
                  : "Low-light noise reduction"
              }
              checked={pixyHid.denoiseEnabled === true}
              disabled={disabled}
              onToggle={() => void pixyHid.setDenoise(!(pixyHid.denoiseEnabled ?? false))}
            />
          </div>
        </details>

        <details className="smart-control">
          <summary className="smart-label">
            <Power size={16} />
            <span>Power-on &amp; remote</span>
            <ChevronDown className="collapse-caret" size={14} />
          </summary>
          <div className="button-row">
            <button className="secondary-button" disabled={disabled} onClick={() => void pixyHid.capturePowerOnDefault()}>
              Save current
            </button>
            <button className="secondary-button" disabled={disabled} onClick={() => void pixyHid.goToDefault()}>
              Go to
            </button>
            <button className="secondary-button" disabled={disabled} onClick={() => void pixyHid.disablePowerOnDefault()}>
              Disable
            </button>
          </div>
          <small className="privacy-help">{powerOnDefaultText(pixyHid)}</small>
          <ToggleRow
            label="Remote pairing"
            hint={
              unsupported.includes("remote_pairing_state")
                ? "Sent, but this firmware does not report pairing state"
                : "Pair or unpair the EMEET remote"
            }
            checked={pixyHid.remotePairingEnabled === true}
            disabled={disabled}
            onToggle={() => void pixyHid.setRemotePairing(!(pixyHid.remotePairingEnabled ?? false))}
          />
        </details>

        <div className="smart-control advanced-control">
          <button
            className="advanced-toggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            <Settings2 size={16} />
            <span>Advanced</span>
            <ChevronDown className="collapse-caret" size={14} />
          </button>
          {advancedOpen && (
            <div className="advanced-body">
              <div className="advanced-group">
                <div className="advanced-group-title">
                  <PersonStanding size={14} />
                  <span>Tracking target</span>
                </div>
                <div className="segmented">
                  {targetTrackingModes.map((mode) => (
                    <button
                      key={mode.value}
                      className={pixyHid.targetTrackingMode === mode.value ? "is-selected" : ""}
                      aria-pressed={pixyHid.targetTrackingMode === mode.value}
                      disabled={disabled}
                      onClick={() => void pixyHid.setTargetTrackingMode(mode.value)}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
                <small className="privacy-help">
                  Experimental: face and half-body read back on this firmware; full-body is unconfirmed.
                  Setting a target also enables Tracking.
                </small>
              </div>

              <div className="advanced-group">
                <div className="advanced-group-title">
                  <Gauge size={14} />
                  <span>Motor speed</span>
                </div>
                <div className="privacy-mode-row slider-row">
                  <span>Pan {pixyHid.motorSpeedPanDeg ?? "—"}°/s</span>
                  <input
                    type="range"
                    min={1}
                    max={360}
                    step={1}
                    disabled={disabled}
                    aria-label="Pan motor speed"
                    value={Number(panSpeedDraft) || 60}
                    style={rangeFill(Number(panSpeedDraft) || 60, 1, 360)}
                    onChange={(event) => setPanSpeedDraft(event.target.value)}
                    onPointerUp={() => commitMotorSpeed(1, panSpeedDraft, setPanSpeedDraft)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        commitMotorSpeed(1, panSpeedDraft, setPanSpeedDraft);
                      }
                    }}
                  />
                </div>
                <div className="privacy-mode-row slider-row">
                  <span>Tilt {pixyHid.motorSpeedTiltDeg ?? "—"}°/s</span>
                  <input
                    type="range"
                    min={1}
                    max={360}
                    step={1}
                    disabled={disabled}
                    aria-label="Tilt motor speed"
                    value={Number(tiltSpeedDraft) || 60}
                    style={rangeFill(Number(tiltSpeedDraft) || 60, 1, 360)}
                    onChange={(event) => setTiltSpeedDraft(event.target.value)}
                    onPointerUp={() => commitMotorSpeed(2, tiltSpeedDraft, setTiltSpeedDraft)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        commitMotorSpeed(2, tiltSpeedDraft, setTiltSpeedDraft);
                      }
                    }}
                  />
                </div>
              </div>

              <div className="advanced-group">
                <div className="advanced-group-title">
                  <Move size={14} />
                  <span>Go to position</span>
                </div>
                <div className="advanced-goto-row">
                  <input
                    className="number-input"
                    type="number"
                    min={-150}
                    max={150}
                    step={1}
                    disabled={disabled}
                    aria-label="Pan degrees"
                    value={panTargetDraft}
                    onChange={(event) => setPanTargetDraft(event.target.value)}
                  />
                  <input
                    className="number-input"
                    type="number"
                    min={-90}
                    max={90}
                    step={1}
                    disabled={disabled}
                    aria-label="Tilt degrees"
                    value={tiltTargetDraft}
                    onChange={(event) => setTiltTargetDraft(event.target.value)}
                  />
                  <button className="secondary-button" disabled={disabled} onClick={goToAbsolute}>
                    Go
                  </button>
                </div>
                <small className="privacy-help">
                  {motorPositionText(pixyHid)} Pan −150..150°, tilt −90..90°.
                </small>
              </div>
            </div>
          )}
        </div>
      </div>

      {pixyHid.lastCommand && (
        <div className="last-command" title="Last HID command">
          Last command: {pixyHid.lastCommand}
        </div>
      )}
    </section>
  );
}

type ToggleRowProps = {
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
};

function ToggleRow({ label, hint, checked, disabled, onToggle }: ToggleRowProps) {
  return (
    <div className="mic-mute-row">
      <div>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </div>
      <button
        className={`toggle-switch ${checked ? "is-on" : ""}`}
        disabled={disabled}
        aria-pressed={checked}
        aria-label={label}
        onClick={onToggle}
      >
        <span />
      </button>
    </div>
  );
}

const controlModes: { value: TrackingMode; label: string }[] = [
  { value: "off", label: "Standard" },
  { value: "tracking", label: "Tracking" },
  { value: "privacy", label: "Privacy" }
];

function clampDraft(draft: string, min: number, max: number, fallback: number) {
  const parsed = Number(draft);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function powerOnDefaultText(pixyHid: UsePixyHidResult) {
  if (pixyHid.powerOnDefaultEnabled === true) {
    const position = pixyHid.powerOnDefaultPosition;
    return position
      ? `Device reports a stored power-on pose at pan ${position.pan}°, tilt ${position.tilt}°.`
      : "Device reports a stored power-on pose.";
  }
  if (pixyHid.powerOnDefaultEnabled === false) {
    return "Device reports no power-on pose saved; it boots to center.";
  }
  return "Save current stores the present pose as the power-on default.";
}

function motorPositionText(pixyHid: UsePixyHidResult) {
  if (pixyHid.motorPosPanDeg === null || pixyHid.motorPosPanDeg === undefined) {
    return "";
  }
  return `Now at pan ${pixyHid.motorPosPanDeg}°, tilt ${pixyHid.motorPosTiltDeg ?? "—"}°.`;
}

function privacySafetyTone(privacySafety: UsePrivacySafetyResult) {
  switch (privacySafety.privacyCommandState) {
    case "sending":
      return "sending";
    case "applied":
      return "applied";
    case "mic-failed":
    case "failed":
      return "failed";
    default:
      return privacySafety.startupPrivacyState;
  }
}

function privacySafetyText(privacySafety: UsePrivacySafetyResult) {
  switch (privacySafety.privacyCommandState) {
    case "sending":
      return "Privacy sending…";
    case "applied":
      return "Privacy on; mic muted";
    case "mic-failed":
      return "Privacy on, but the mic mute failed; check the mic";
    case "failed":
      return "Privacy command failed; press Privacy to retry";
    default:
      break;
  }
  switch (privacySafety.startupPrivacyState) {
    case "enabled":
      return "Lens closes and mic mutes whenever Pixy Arch starts";
    case "disabled":
      return "Camera stays as-is when Pixy Arch starts";
    case "unknown":
      return "Startup privacy setting unavailable";
    default:
      return "Loading startup privacy setting";
  }
}

function privacyHelpText(pixyHid: UsePixyHidResult, privacyEnabled: boolean, trackingEnabled: boolean) {
  if (privacyEnabled) {
    return "Device readback or last command indicates privacy. Auto entry is only used after privacy is off.";
  }
  if (trackingEnabled) {
    return "Tracking is on. Choose the focus target (Center, Face or Region) in the Focus panel.";
  }
  if (pixyHid.deviceTrackingState === "standard") {
    return "Standard mode. Select Tracking for auto follow, or use the Focus panel for Center, Face or Region metering.";
  }
  if (pixyHid.deviceTrackingState === "non_privacy") {
    return "Device confirms non-privacy, but this raw state is still unresolved.";
  }
  return "Device mode is unknown after refresh. Select Privacy to send privacy mode now.";
}

function deviceTrackingStateText(
  state: UsePixyHidResult["deviceTrackingState"],
  rawValue: number | null,
  rawBits: number[]
): { label: string; raw: string | null } {
  const raw = rawValue === null ? null : `Raw value ${rawValue}${rawBits.length ? ` · bits ${rawBits.join(",")}` : ""}`;
  const labels: Record<string, string> = {
    standard: "Standard",
    tracking: "Tracking",
    privacy: "Privacy",
    non_privacy: "Non-privacy"
  };
  return { label: labels[state] ?? "Unknown", raw };
}
