import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { V4L2Control } from "../../types/api";
import { ControlRenderer } from "./ControlRenderer";

function baseControl(overrides: Partial<V4L2Control>): V4L2Control {
  return {
    name: "brightness",
    label: "Brightness",
    control_id: "0x1",
    group: "User Controls",
    kind: "int",
    value: 10,
    default: 10,
    min: 0,
    max: 100,
    step: 1,
    value_label: null,
    flags: [],
    menu: [],
    ...overrides
  };
}

describe("ControlRenderer", () => {
  it("renders boolean controls as toggles and calls setter", async () => {
    const user = userEvent.setup();
    const onSetValue = vi.fn().mockResolvedValue(undefined);

    render(
      <ControlRenderer
        control={baseControl({ kind: "bool", value: 1 })}
        disabled={false}
        onSetValue={onSetValue}
      />
    );

    await user.click(screen.getByRole("button", { pressed: true }));

    expect(onSetValue).toHaveBeenCalledWith(0);
  });

  it("names toggle, menu, and range inputs after their control", () => {
    render(
      <>
        <ControlRenderer control={baseControl({ name: "hdr", label: "HDR", kind: "bool", value: 0 })} disabled={false} onSetValue={vi.fn()} />
        <ControlRenderer
          control={baseControl({
            name: "power_line_frequency",
            label: "Power Line Frequency",
            kind: "menu",
            value: 1,
            menu: [
              { value: 0, label: "Disabled" },
              { value: 1, label: "50 Hz" }
            ]
          })}
          disabled={false}
          onSetValue={vi.fn()}
        />
        <ControlRenderer control={baseControl({ kind: "int" })} disabled={false} onSetValue={vi.fn()} />
      </>
    );

    expect(screen.getByRole("button", { name: "HDR" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("combobox", { name: "Power Line Frequency" })).toHaveValue("1");
    expect(screen.getByRole("slider", { name: "Brightness" })).toHaveValue("10");
  });

  it("renders menu controls with option labels", () => {
    render(
      <ControlRenderer
        control={baseControl({
          kind: "menu",
          value: 3,
          value_label: "Aperture Priority Mode",
          menu: [
            { value: 1, label: "Manual Mode" },
            { value: 3, label: "Aperture Priority Mode" }
          ]
        })}
        disabled={false}
        onSetValue={vi.fn()}
      />
    );

    expect(screen.getByRole("combobox")).toHaveValue("3");
    expect(screen.getByText("Manual Mode")).toBeInTheDocument();
  });

  it("commits a range value when the slider is released", () => {
    const onSetValue = vi.fn().mockResolvedValue(undefined);

    render(
      <ControlRenderer
        control={baseControl({ kind: "int", value: 10, min: 0, max: 100, step: 1 })}
        disabled={false}
        onSetValue={onSetValue}
      />
    );

    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "42" } });
    fireEvent.pointerUp(slider);

    expect(onSetValue).toHaveBeenCalledWith(42);
  });

  it("does not commit an unchanged range value", () => {
    const onSetValue = vi.fn().mockResolvedValue(undefined);

    render(
      <ControlRenderer
        control={baseControl({ kind: "int", value: 10, min: 0, max: 100, step: 1 })}
        disabled={false}
        onSetValue={onSetValue}
      />
    );

    const slider = screen.getByRole("slider");
    fireEvent.pointerUp(slider);
    fireEvent.blur(slider);

    expect(onSetValue).not.toHaveBeenCalled();
  });

  it("disables the slider when the driver reports a degenerate range", () => {
    render(
      <ControlRenderer
        control={baseControl({ name: "zoom_continuous", label: "Zoom, Continuous", kind: "int", value: 0, min: 0, max: 0, step: 0 })}
        disabled={false}
        onSetValue={vi.fn()}
      />
    );

    expect(screen.getByRole("slider")).toBeDisabled();
  });

  it("renders an honest 'not reported' state for unknown control types", () => {
    render(
      <ControlRenderer
        control={baseControl({ name: "vendor_blob", label: "Vendor Blob", kind: "unknown", value: 7 })}
        disabled={false}
        onSetValue={vi.fn()}
      />
    );

    expect(screen.getByText("Not reported")).toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });
});
