import cv2
import numpy as np

DETECT_WIDTH = 640
MIN_AREA_RATIO = 0.15


def _order_points(points: np.ndarray) -> np.ndarray:
    # tl, tr, br, bl ordering by sum/difference of x+y and x-y.
    rect = np.zeros((4, 2), dtype=np.float32)
    sums = points.sum(axis=1)
    diffs = np.diff(points, axis=1).ravel()
    rect[0] = points[np.argmin(sums)]
    rect[2] = points[np.argmax(sums)]
    rect[1] = points[np.argmin(diffs)]
    rect[3] = points[np.argmax(diffs)]
    return rect


def detect_quad(frame: np.ndarray) -> np.ndarray | None:
    height, width = frame.shape[:2]
    scale = DETECT_WIDTH / width
    small = cv2.resize(frame, (DETECT_WIDTH, int(height * scale))) if scale < 1.0 else frame
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    edges = cv2.dilate(edges, None, iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = small.shape[0] * small.shape[1]
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        area = cv2.contourArea(contour)
        if area < frame_area * MIN_AREA_RATIO:
            break
        approx = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            quad = approx.reshape(4, 2).astype(np.float32)
            if scale < 1.0:
                quad /= scale
            return _order_points(quad)
    return None


def warp_to_quad(frame: np.ndarray, quad: np.ndarray, out_width: int, out_height: int) -> np.ndarray:
    destination = np.array(
        [[0, 0], [out_width - 1, 0], [out_width - 1, out_height - 1], [0, out_height - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(quad, destination)
    return cv2.warpPerspective(frame, matrix, (out_width, out_height))


def quads_close(a: np.ndarray | None, b: np.ndarray | None, tolerance: float = 40.0) -> bool:
    if a is None or b is None:
        return False
    return bool(np.all(np.abs(a - b) < tolerance))
