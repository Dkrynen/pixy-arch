import { Clipboard, DatabaseZap, Download, Microscope, Save, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { capturePixyHidDiagnostics, fetchPixyHidQuery } from "../../lib/apiClient";
import type { PixyHidDiagnosticSnapshot, PixyHidQueryName, PixyHidRawQueryResult } from "../../types/api";
import "./HidDiagnosticsPanel.css";

const QUERY_NAMES: PixyHidQueryName[] = [
  "tracking_state",
  "target_tracking_state",
  "tracking_capability",
  "tracking_probe_0100",
  "tracking_probe_0102",
  "tracking_probe_0103",
  "tracking_probe_0104",
  "device_info",
  "audio_state",
  "gesture_state",
  "auto_privacy_state",
  "focus_metering_state",
  "mirror_horizontal_state",
  "mirror_vertical_state",
  "auto_rotate_state",
  "serial_number",
  "firmware_isp",
  "firmware_ai",
  "firmware_mcu",
  "serial_csk",
  "power_on_default_state",
  "preset_1_state",
  "preset_2_state",
  "preset_3_state",
  "meter_mode",
  "wb_lock_state",
  "ev_lock_state",
  "focus_lock_state",
  "denoise_state",
  "remote_pairing_state",
  "motor_pos_pan",
  "motor_pos_tilt",
  "motor_speed_pan",
  "motor_speed_tilt"
];

export function HidDiagnosticsPanel() {
  const [snapshot, setSnapshot] = useState<PixyHidDiagnosticSnapshot | null>(null);
  const [pending, setPending] = useState<"capture" | "save" | "copy" | "query" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedQuery, setSelectedQuery] = useState<PixyHidQueryName>("tracking_state");
  const [explorerResult, setExplorerResult] = useState<PixyHidRawQueryResult | null>(null);

  const snapshotText = useMemo(() => (snapshot ? JSON.stringify(snapshot, null, 2) : ""), [snapshot]);

  const capture = async (save: boolean) => {
    setPending(save ? "save" : "capture");
    setMessage(null);
    setError(null);
    try {
      const result = await capturePixyHidDiagnostics(save);
      setSnapshot(result);
      setMessage(save && result.file_path ? `Saved ${result.file_path}` : "Snapshot captured");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to capture HID diagnostics");
    } finally {
      setPending(null);
    }
  };

  const runQuery = async () => {
    setPending("query");
    setMessage(null);
    setError(null);
    try {
      const result = await fetchPixyHidQuery(selectedQuery);
      setExplorerResult(result);
      setMessage(result.response_hex === null ? `${selectedQuery}: no response from device` : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to run HID query");
    } finally {
      setPending(null);
    }
  };

  const copySnapshot = async () => {
    if (!snapshotText) {
      return;
    }
    setPending("copy");
    setMessage(null);
    setError(null);
    try {
      await navigator.clipboard.writeText(snapshotText);
      setMessage("Snapshot copied");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to copy snapshot");
    } finally {
      setPending(null);
    }
  };

  const downloadSnapshot = () => {
    if (!snapshotText) {
      return;
    }
    const blob = new Blob([snapshotText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = hidSnapshotFileName(snapshot?.captured_at);
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="hid-diagnostics-panel">
      <div className="panel-title-row">
        <Microscope size={18} />
        <h2>HID Diagnostics</h2>
      </div>

      <div className="diagnostic-actions">
        <button className="panel-action-button" disabled={pending !== null} onClick={() => void capture(false)}>
          <DatabaseZap size={14} />
          <span>{pending === "capture" ? "Reading" : "Capture"}</span>
        </button>
        <button className="panel-action-button" disabled={pending !== null} onClick={() => void capture(true)}>
          <Save size={14} />
          <span>{pending === "save" ? "Saving" : "Save"}</span>
        </button>
        <button className="icon-button" disabled={!snapshot || pending !== null} aria-label="Copy HID snapshot" onClick={() => void copySnapshot()}>
          <Clipboard size={15} />
        </button>
        <button className="icon-button" disabled={!snapshot} aria-label="Download HID snapshot" onClick={downloadSnapshot}>
          <Download size={15} />
        </button>
      </div>

      <div className="query-explorer">
        <select
          className="menu-select"
          aria-label="HID query"
          value={selectedQuery}
          disabled={pending !== null}
          onChange={(event) => setSelectedQuery(event.target.value as PixyHidQueryName)}
        >
          {QUERY_NAMES.map((name) => (
            <option key={name} value={name}>
              {name.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <button className="panel-action-button" disabled={pending !== null} onClick={() => void runQuery()}>
          <Search size={14} />
          <span>{pending === "query" ? "Running" : "Run"}</span>
        </button>
      </div>

      {error && <div className="mini-error">{error}</div>}
      {message && <div className="mini-success">{message}</div>}

      {explorerResult && (
        <div className="query-explorer-result">
          <DiagnosticQueryRow query={explorerResult} />
        </div>
      )}

      <div className="diagnostic-summary">
        <span>{snapshot?.captured_at ?? "No capture yet"}</span>
        <code>{snapshot?.path ?? "hidraw pending"}</code>
      </div>

      <div className="diagnostic-query-list">
        {(snapshot?.queries ?? []).map((query) => (
          <DiagnosticQueryRow key={query.name} query={query} />
        ))}
        {!snapshot && <div className="empty-state">Run Capture after changing camera modes.</div>}
      </div>
    </section>
  );
}

function DiagnosticQueryRow({ query }: { query: PixyHidRawQueryResult }) {
  const decoded = decodeQuery(query);
  return (
    <div className="diagnostic-query-row">
      <div>
        <strong>{query.name.replaceAll("_", " ")}</strong>
        <small>{query.response_hex ?? "no response"}</small>
        {decoded && <small className="diagnostic-decoded">{decoded}</small>}
      </div>
      <div className="diagnostic-value-stack">
        <code>{query.raw_value === null ? "--" : `0x${query.raw_value.toString(16).padStart(2, "0")}`}</code>
        <span>{query.raw_bits.length ? `bits ${query.raw_bits.join(",")}` : "bits none"}</span>
      </div>
      {(query.ascii_value || query.ascii_preview) && (
        <small className="diagnostic-ascii">
          ASCII {query.ascii_value ? `${query.ascii_value} | ` : ""}
          {query.ascii_preview}
        </small>
      )}
    </div>
  );
}

function decodeQuery(query: PixyHidRawQueryResult): string | null {
  if (query.response_hex === null) {
    return null;
  }
  const raw = query.raw_value;
  switch (query.name) {
    case "tracking_state":
      return mapRaw(raw, { 0: "Standard", 1: "Tracking", 2: "Privacy", 3: "Non-privacy (unresolved)" });
    case "target_tracking_state":
      return mapRaw(raw, { 0: "Off", 1: "Face", 2: "Half body", 3: "Full body" });
    case "audio_state":
      return mapRaw(raw, { 1: "Noise cancel", 2: "Live", 3: "Original" });
    case "focus_metering_state":
    case "meter_mode":
      return mapRaw(raw, { 0: "Center", 1: "Human face", 2: "Selected area" });
    case "gesture_state":
    case "mirror_horizontal_state":
    case "mirror_vertical_state":
    case "auto_rotate_state":
    case "wb_lock_state":
    case "ev_lock_state":
    case "focus_lock_state":
    case "denoise_state":
    case "remote_pairing_state":
    case "power_on_default_state":
      return raw === null ? null : raw === 1 ? "On" : "Off";
    case "auto_privacy_state": {
      const seconds = leUint32(query.response_hex, 8);
      return seconds === null ? null : seconds === 0 ? "Never" : `${seconds} s`;
    }
    case "preset_1_state":
    case "preset_2_state":
    case "preset_3_state":
      return presetPositionText(query.response_hex);
    case "motor_pos_pan":
    case "motor_pos_tilt": {
      const target = leFloat(query.response_hex, 9);
      const actual = leFloat(query.response_hex, 13);
      if (actual === null) {
        return null;
      }
      return target !== null && Math.abs(target - actual) > 0.5
        ? `${round2(actual)}° → ${round2(target)}°`
        : `${round2(actual)}°`;
    }
    case "motor_speed_pan":
    case "motor_speed_tilt": {
      const speed = leFloat(query.response_hex, 9);
      return speed === null ? null : `${round2(speed)}°/s`;
    }
    case "device_info":
    case "serial_number":
    case "serial_csk":
      return query.ascii_value ? `ID ${query.ascii_value}` : null;
    case "firmware_isp":
    case "firmware_ai":
    case "firmware_mcu": {
      const bytes = hexBytes(query.response_hex);
      return bytes && bytes.length > 9 && raw !== null ? `v${raw}.${bytes[9]}` : null;
    }
    default:
      return null;
  }
}

function presetPositionText(responseHex: string): string | null {
  const bytes = hexBytes(responseHex);
  if (!bytes || bytes.length < 22 || bytes[9] !== 1) {
    return bytes && bytes[9] === 0 ? "Empty" : null;
  }
  const pan = leFloat(responseHex, 10);
  const tilt = leFloat(responseHex, 14);
  if (pan === null || tilt === null) {
    return "Saved";
  }
  return `Saved pan ${round2(pan)}°, tilt ${round2(tilt)}°`;
}

function mapRaw(raw: number | null, labels: Record<number, string>): string | null {
  if (raw === null) {
    return null;
  }
  return labels[raw] ?? `Raw ${raw}`;
}

function hexBytes(hex: string): number[] | null {
  const bytes = hex
    .trim()
    .split(/\s+/)
    .map((part) => Number.parseInt(part, 16));
  return bytes.every((byte) => Number.isFinite(byte)) ? bytes : null;
}

function leFloat(hex: string, index: number): number | null {
  const bytes = hexBytes(hex);
  if (!bytes || bytes.length < index + 4) {
    return null;
  }
  const view = new DataView(new Uint8Array(bytes.slice(index, index + 4)).buffer);
  const value = view.getFloat32(0, true);
  return Number.isFinite(value) ? value : null;
}

function leUint32(hex: string, index: number): number | null {
  const bytes = hexBytes(hex);
  if (!bytes || bytes.length < index + 4) {
    return null;
  }
  return (bytes[index] | (bytes[index + 1] << 8) | (bytes[index + 2] << 16) | (bytes[index + 3] << 24)) >>> 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Download name for a HID diagnostics snapshot, e.g. `pixy-arch-hid-20260918T100000.json`. */
export function hidSnapshotFileName(capturedAt: string | null | undefined): string {
  return `pixy-arch-hid-${capturedAt?.replace(/[:+]/g, "") ?? "snapshot"}.json`;
}
