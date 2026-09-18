export type FocusPoint = {
  x: number;
  y: number;
};

export type Box = {
  width: number;
  height: number;
};

// Maps a click inside the letterboxed (object-contain) preview into the
// camera's 0..127 focus-metering coordinate space. Corners verified end-to-end
// (00/7f readback). Note: the official app was captured sending 0x38 (56) for
// a center click while linear mapping gives 64 — linear 0..127 is kept since
// corner captures match exactly and the true center encoding is unconfirmed.
export function focusPointFromContainClick(
  box: Box,
  image: Box,
  click: FocusPoint
): FocusPoint | null {
  if (box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0) {
    return null;
  }

  const boxRatio = box.width / box.height;
  const imageRatio = image.width / image.height;
  const rendered =
    boxRatio > imageRatio
      ? {
          width: box.height * imageRatio,
          height: box.height,
          left: (box.width - box.height * imageRatio) / 2,
          top: 0
        }
      : {
          width: box.width,
          height: box.width / imageRatio,
          left: 0,
          top: (box.height - box.width / imageRatio) / 2
        };

  const localX = click.x - rendered.left;
  const localY = click.y - rendered.top;
  if (localX < 0 || localX > rendered.width || localY < 0 || localY > rendered.height) {
    return null;
  }

  return {
    x: clampFocusCoordinate(Math.round((localX / rendered.width) * 127)),
    y: clampFocusCoordinate(Math.round((localY / rendered.height) * 127))
  };
}

// Same mapping as focusPointFromContainClick but for object-fit: cover —
// the image is scaled until it covers the box and the overflow is cropped
// symmetrically, so clicks outside the visible region can't happen but the
// crop offset must still be subtracted before normalizing.
export function focusPointFromCoverClick(
  box: Box,
  image: Box,
  click: FocusPoint
): FocusPoint | null {
  if (box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0) {
    return null;
  }

  const scale = Math.max(box.width / image.width, box.height / image.height);
  const rendered = {
    width: image.width * scale,
    height: image.height * scale
  };
  const localX = click.x - (box.width - rendered.width) / 2;
  const localY = click.y - (box.height - rendered.height) / 2;

  if (localX < 0 || localX > rendered.width || localY < 0 || localY > rendered.height) {
    return null;
  }

  return {
    x: clampFocusCoordinate(Math.round((localX / rendered.width) * 127)),
    y: clampFocusCoordinate(Math.round((localY / rendered.height) * 127))
  };
}

function clampFocusCoordinate(value: number) {
  return Math.max(0, Math.min(127, value));
}
