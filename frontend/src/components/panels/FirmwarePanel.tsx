import { Cpu } from "lucide-react";

import type { UseFirmwareResult } from "../../hooks/useFirmware";

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
          <div key={component.name} className="privacy-mode-row">
            <span>{componentLabels[component.name] ?? component.name}</span>
            <strong>
              {component.current ?? "—"}
              {component.latest ? ` → ${component.latest}` : ""}
              {component.update_available === true ? " (update)" : ""}
            </strong>
          </div>
        ))}
        {status?.serial_number && (
          <div className="privacy-mode-row">
            <span>Serial</span>
            <strong>{status.serial_number}</strong>
          </div>
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
