import { describe, expect, it } from "vitest";

import { focusPointFromContainClick, focusPointFromCoverClick } from "./focusPoint";

describe("focusPointFromContainClick", () => {
  it("maps a centered click to the HID coordinate range", () => {
    expect(
      focusPointFromContainClick(
        { width: 1280, height: 720 },
        { width: 1280, height: 720 },
        { x: 640, y: 360 }
      )
    ).toEqual({ x: 64, y: 64 });
  });

  it("maps frame corners to the 0..127 extremes with origin top-left", () => {
    const box = { width: 1280, height: 720 };
    const image = { width: 1280, height: 720 };

    expect(focusPointFromContainClick(box, image, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(focusPointFromContainClick(box, image, { x: 1280, y: 0 })).toEqual({ x: 127, y: 0 });
    expect(focusPointFromContainClick(box, image, { x: 0, y: 720 })).toEqual({ x: 0, y: 127 });
    expect(focusPointFromContainClick(box, image, { x: 1280, y: 720 })).toEqual({ x: 127, y: 127 });
  });

  it("ignores clicks in object-fit contain letterbox space", () => {
    expect(
      focusPointFromContainClick(
        { width: 1000, height: 500 },
        { width: 500, height: 500 },
        { x: 100, y: 250 }
      )
    ).toBeNull();
  });

  it("maps clicks inside the rendered image when letterboxed", () => {
    expect(
      focusPointFromContainClick(
        { width: 1000, height: 500 },
        { width: 500, height: 500 },
        { x: 500, y: 250 }
      )
    ).toEqual({ x: 64, y: 64 });
  });

  it("ignores clicks in pillarbox space beside a tall image", () => {
    const box = { width: 400, height: 800 };
    const image = { width: 1600, height: 900 };
    // Rendered image is 400x225 centered vertically; a click near the bottom
    // edge lands in the pillarbox band and must not move the focus point.
    expect(focusPointFromContainClick(box, image, { x: 200, y: 700 })).toBeNull();
    expect(focusPointFromContainClick(box, image, { x: 200, y: 400 })).toEqual({ x: 64, y: 64 });
  });

  it("maps a quarter-frame click to the matching quarter of the HID grid", () => {
    expect(
      focusPointFromContainClick(
        { width: 1280, height: 720 },
        { width: 1280, height: 720 },
        { x: 320, y: 180 }
      )
    ).toEqual({ x: 32, y: 32 });
  });

  it("returns null for degenerate boxes or images", () => {
    expect(
      focusPointFromContainClick({ width: 0, height: 720 }, { width: 1280, height: 720 }, { x: 10, y: 10 })
    ).toBeNull();
    expect(
      focusPointFromContainClick({ width: 1280, height: 720 }, { width: 0, height: 720 }, { x: 10, y: 10 })
    ).toBeNull();
    expect(
      focusPointFromContainClick({ width: -5, height: 720 }, { width: 1280, height: 720 }, { x: 10, y: 10 })
    ).toBeNull();
  });
});

describe("focusPointFromCoverClick", () => {
  it("maps a centered click to the HID coordinate range", () => {
    expect(
      focusPointFromCoverClick(
        { width: 1280, height: 720 },
        { width: 1280, height: 720 },
        { x: 640, y: 360 }
      )
    ).toEqual({ x: 64, y: 64 });
  });

  it("maps clicks in the cropped overflow to the image edges they land on", () => {
    // 16:9 image covering a square box: rendered 888.9x500, 194.4px cropped
    // left and right. A click at the box edge maps to the cropped image edge,
    // not to x=0 — cover only shows the middle of the frame.
    const box = { width: 500, height: 500 };
    const image = { width: 1600, height: 900 };
    expect(focusPointFromCoverClick(box, image, { x: 0, y: 250 })).toEqual({ x: 28, y: 64 });
    expect(focusPointFromCoverClick(box, image, { x: 250, y: 250 })).toEqual({ x: 64, y: 64 });
    expect(focusPointFromCoverClick(box, image, { x: 500, y: 250 })).toEqual({ x: 99, y: 64 });
  });

  it("still maps the true image center when the image overflows vertically", () => {
    // 4:3 box, 16:9 image: cover scales by height, crops the sides.
    const box = { width: 400, height: 800 };
    const image = { width: 1600, height: 900 };
    // rendered = 1422.2x800; x offset = (400-1422.2)/2 = -511.1
    // click at box center → image center
    expect(focusPointFromCoverClick(box, image, { x: 200, y: 400 })).toEqual({ x: 64, y: 64 });
  });

  it("returns null for degenerate boxes or images", () => {
    expect(
      focusPointFromCoverClick({ width: 0, height: 720 }, { width: 1280, height: 720 }, { x: 10, y: 10 })
    ).toBeNull();
  });
});
