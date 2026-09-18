import { Cpu } from "lucide-react";

import type { UseFirmwareResult } from "../../hooks/useFirmware";
import type { FirmwareComponent } from "../../types/api";
import "./FirmwarePanel.css";

type Props = {
  firmware: UseFirmwareResult;
};

const componentLabels: Record<string, string> = {
  isp: "ISP (FIC7608)",
  csk: "AI / Gimbal (CSK6)",
  mcu: "Motor MCU (CW32)"
};

export function FirmwarePanel({ firmware }: Props) {
  const status = firmware.status;
  const hasRawVersions = status?.components.some((component) => component.current?.startsWith("0x")) ?? false;
  return (
    <section className="smart-panel">
      <div className="panel-title-row">
        <Cpu size={18} />
        <h2>Firmware</h2>
      </div>

      {firmware.error && <div className="mini-error">{firmware.error}</div>}
      {status?.reason && <div className="mini-warning">{status.reason}</div>}

      <div className="smart-control-stack">
        {status?.components.map((component) => (
          <FirmwareComponentRow key={component.name} component={component} manifestChecked={status.manifest_checked} />
        ))}
        {status?.serial_number && (
          <div className="privacy-mode-row">
            <span>Serial</span>
            <strong>{status.serial_number}</strong>
          </div>
        )}
        {hasRawVersions && (
          <small className="firmware-raw-note">
            0xNN values are raw bytes from the camera&apos;s version query — the exact
            version encoding is not decoded yet, so update detection may be unknown.
          </small>
        )}
        <div className="smart-control">
          <button
            className="primary-action"
            disabled={firmware.checking || !(status?.components.length)}
            onClick={() => void firmware.checkUpdates()}
          >
            {firmware.checking ? "Checking…" : "Check for updates"}
          </button>
          {status?.manifest_checked && <small>Checked {status.manifest_url}</small>}
        </div>
      </div>
    </section>
  );
}

function FirmwareComponentRow({ component, manifestChecked }: { component: FirmwareComponent; manifestChecked: boolean }) {
  let updateLabel = "";
  if (component.update_available === true) {
    updateLabel = " (update available)";
  } else if (component.update_available === false) {
    updateLabel = " (up to date)";
  } else if (manifestChecked && component.latest === null) {
    updateLabel = " (no manifest entry)";
  }
  return (
    <div className="privacy-mode-row" title={component.response_hex ? `HID response: ${component.response_hex}` : undefined}>
      <span>{componentLabels[component.name] ?? component.name}</span>
      <strong>
        {component.current ?? "—"}
        {component.latest ? ` → ${component.latest}` : ""}
        {updateLabel}
      </strong>
    </div>
  );
}
