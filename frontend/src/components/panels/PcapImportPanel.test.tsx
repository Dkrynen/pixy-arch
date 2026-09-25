import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchPcapImports, uploadPcapImport } from "../../lib/apiClient";
import type { PcapImportRecord } from "../../types/api";
import { PcapImportPanel } from "./PcapImportPanel";

vi.mock("../../lib/apiClient", () => ({
  fetchPcapImports: vi.fn(),
  uploadPcapImport: vi.fn()
}));

const fetchMock = vi.mocked(fetchPcapImports);
const uploadMock = vi.mocked(uploadPcapImport);

function capture(overrides: Partial<PcapImportRecord> = {}): PcapImportRecord {
  return {
    id: "abc123",
    original_filename: "tracking.pcapng",
    stored_filename: "2026-tracking.pcapng",
    file_path: "/home/user/pixy-arch/pcaps/imports/2026-tracking.pcapng",
    size_bytes: 2048,
    sha256: "abcdef1234567890",
    uploaded_at: "2026-06-11T10:00:00+00:00",
    action: "Privacy -> Tracking",
    notes: "Changed one setting",
    source: "windows",
    ...overrides
  };
}

function pcapFile(name = "capture31.pcapng"): File {
  return new File([new Uint8Array([1, 2, 3])], name, {
    type: "application/vnd.tcpdump.pcap"
  });
}

describe("PcapImportPanel", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    uploadMock.mockReset();
    fetchMock.mockResolvedValue([]);
  });

  it("loads recent imported captures with action, notes and source", async () => {
    fetchMock.mockResolvedValue([capture()]);

    render(<PcapImportPanel />);

    expect(await screen.findByText("Privacy -> Tracking")).toBeInTheDocument();
    expect(screen.getByText("tracking.pcapng")).toBeInTheDocument();
    expect(screen.getByText("Changed one setting")).toBeInTheDocument();
    expect(screen.getByText(/windows ·/)).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  it("uploads a selected Windows pcap with action notes", async () => {
    const user = userEvent.setup();
    const imported = capture({ original_filename: "capture31.pcapng", action: "Auto privacy 10s" });
    uploadMock.mockResolvedValue(imported);

    render(<PcapImportPanel />);

    const file = pcapFile();
    await user.upload(screen.getByLabelText(/select pcap/i), file);
    await user.type(screen.getByPlaceholderText("Action changed"), "Auto privacy 10s");
    await user.type(screen.getByPlaceholderText("Notes"), "Windows EMEET Studio");
    await user.click(screen.getByRole("button", { name: /upload/i }));

    expect(uploadMock).toHaveBeenCalledWith(file, {
      action: "Auto privacy 10s",
      notes: "Windows EMEET Studio",
      source: "windows"
    });
    expect(await screen.findByText("Imported capture31.pcapng")).toBeInTheDocument();
    expect(screen.getByText("Auto privacy 10s")).toBeInTheDocument();
  });

  it("accepts a dropped capture file", async () => {
    const user = userEvent.setup();
    uploadMock.mockResolvedValue(capture({ original_filename: "dropped.pcap", action: null }));
    const { container } = render(<PcapImportPanel />);

    const file = pcapFile("dropped.pcap");
    fireEvent.drop(container.querySelector(".pcap-upload-card") as HTMLElement, {
      dataTransfer: { files: [file] }
    });

    expect(screen.getByText("dropped.pcap")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /upload/i }));
    expect(uploadMock).toHaveBeenCalledWith(file, expect.objectContaining({ source: "windows" }));
  });

  it("rejects a dropped file that is not a capture before uploading", async () => {
    const { container } = render(<PcapImportPanel />);

    fireEvent.drop(container.querySelector(".pcap-upload-card") as HTMLElement, {
      dataTransfer: { files: [new File(["text"], "notes.txt", { type: "text/plain" })] }
    });

    expect(await screen.findByText(/not a .pcap or .pcapng capture/)).toBeInTheDocument();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("sends the chosen capture source with the upload", async () => {
    const user = userEvent.setup();
    uploadMock.mockResolvedValue(capture({ source: "linux" }));

    render(<PcapImportPanel />);

    const file = pcapFile("linux.pcap");
    await user.upload(screen.getByLabelText(/select pcap/i), file);
    await user.selectOptions(screen.getByLabelText("Capture source"), "linux");
    await user.click(screen.getByRole("button", { name: /upload/i }));

    expect(uploadMock).toHaveBeenCalledWith(file, expect.objectContaining({ source: "linux" }));
  });

  it("summarizes captures beyond the visible window", async () => {
    fetchMock.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => capture({ id: `id-${index}`, action: `Run ${index}` }))
    );

    render(<PcapImportPanel />);

    expect(await screen.findByText("+2 older captures")).toBeInTheDocument();
  });
});
