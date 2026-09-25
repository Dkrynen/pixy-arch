import { FileUp, FolderInput, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { deletePcapImport, fetchPcapImports, uploadPcapImport } from "../../lib/apiClient";
import type { PcapImportRecord } from "../../types/api";
import "./PcapImportPanel.css";

const ACCEPTED_EXTENSIONS = [".pcap", ".pcapng"];
const MAX_VISIBLE_CAPTURES = 6;
const SOURCE_OPTIONS = ["windows", "linux", "other"];

function isAcceptedCapture(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((extension) => name.endsWith(extension));
}

export function PcapImportPanel() {
  const [captures, setCaptures] = useState<PcapImportRecord[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [action, setAction] = useState("");
  const [notes, setNotes] = useState("");
  const [source, setSource] = useState("windows");
  const [dragActive, setDragActive] = useState(false);
  const [pending, setPending] = useState<"load" | "upload" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recentCaptures = useMemo(() => captures.slice(0, MAX_VISIBLE_CAPTURES), [captures]);

  const acceptFile = useCallback((file: File | null | undefined) => {
    if (!file) {
      return;
    }
    if (!isAcceptedCapture(file)) {
      setSelectedFile(null);
      setMessage(null);
      setError(`${file.name} is not a .pcap or .pcapng capture`);
      return;
    }
    setSelectedFile(file);
    setError(null);
    setMessage(null);
  }, []);

  const refresh = async () => {
    setPending("load");
    setError(null);
    try {
      setCaptures(await fetchPcapImports());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load imported captures");
    } finally {
      setPending(null);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const upload = async () => {
    if (!selectedFile) {
      setError("Select a .pcap or .pcapng file first");
      return;
    }
    setPending("upload");
    setMessage(null);
    setError(null);
    try {
      const record = await uploadPcapImport(selectedFile, {
        action,
        notes,
        source
      });
      setCaptures((current) => [record, ...current.filter((capture) => capture.id !== record.id)]);
      setSelectedFile(null);
      setAction("");
      setNotes("");
      setMessage(`Imported ${record.original_filename}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to import capture");
    } finally {
      setPending(null);
    }
  };

  const remove = async (capture: PcapImportRecord) => {
    setPending("load");
    setError(null);
    setMessage(null);
    try {
      await deletePcapImport(capture.id);
      setCaptures((current) => current.filter((item) => item.id !== capture.id));
      setMessage(`Deleted ${capture.original_filename}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete capture");
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="pcap-import-panel">
      <div className="panel-title-row">
        <FolderInput size={16} />
        <h2>Capture inbox</h2>
      </div>

      <div
        className={`pcap-upload-card${dragActive ? " is-dragover" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
            return;
          }
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          acceptFile(event.dataTransfer.files?.[0]);
        }}
      >
        <label className="pcap-file-picker">
          <FileUp size={15} />
          <span>{selectedFile ? selectedFile.name : "Select pcap or drop it here"}</span>
          <input
            type="file"
            accept=".pcap,.pcapng,application/vnd.tcpdump.pcap"
            onChange={(event) => {
              acceptFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
        <input
          className="pcap-text-input"
          aria-label="Action changed"
          value={action}
          onChange={(event) => setAction(event.target.value)}
          placeholder="Action changed"
        />
        <textarea
          className="pcap-text-input"
          aria-label="Capture notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Notes"
          rows={2}
        />
        <div className="diagnostic-actions">
          <button className="panel-action-button" disabled={pending !== null || !selectedFile} onClick={() => void upload()}>
            <UploadCloud size={14} />
            <span>{pending === "upload" ? "Uploading" : "Upload"}</span>
          </button>
          <select
            className="pcap-source-select"
            aria-label="Capture source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            {SOURCE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <button className="icon-button" disabled={pending !== null} aria-label="Refresh imports" title="Refresh imports" onClick={() => void refresh()}>
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {error && <div className="mini-error">{error}</div>}
      {message && <div className="mini-success">{message}</div>}

      <div className="pcap-import-list">
        {recentCaptures.map((capture) => (
          <PcapImportRow key={capture.id} capture={capture} disabled={pending !== null} onDelete={() => void remove(capture)} />
        ))}
        {recentCaptures.length === 0 && <div className="empty-state">No imported captures yet.</div>}
        {captures.length > recentCaptures.length && (
          <div className="pcap-import-more">+{captures.length - recentCaptures.length} older captures</div>
        )}
      </div>
    </section>
  );
}

function PcapImportRow({
  capture,
  disabled,
  onDelete
}: {
  capture: PcapImportRecord;
  disabled: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="pcap-import-row">
      <div>
        <strong>{capture.action || capture.original_filename}</strong>
        <small>{capture.original_filename}</small>
        {capture.notes && <small>{capture.notes}</small>}
        <small>
          {capture.source} · {formatUploadedAt(capture.uploaded_at)}
        </small>
        <small>{capture.file_path}</small>
      </div>
      <div className="diagnostic-value-stack">
        <code>{formatBytes(capture.size_bytes)}</code>
        <span>{capture.sha256.slice(0, 8)}</span>
      </div>
      <button
        className="icon-button pcap-delete-button"
        disabled={disabled}
        aria-label={`Delete ${capture.original_filename}`}
        title="Delete capture"
        onClick={onDelete}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function formatUploadedAt(uploadedAt: string): string {
  const timestamp = Date.parse(uploadedAt);
  if (Number.isNaN(timestamp)) {
    return uploadedAt;
  }
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
