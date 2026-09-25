import cv2
import numpy as np

from pixypilot.domains.whiteboard.detector import detect_quad, quads_close, warp_to_quad


def _scene() -> np.ndarray:
    # Dark desk with a bright rotated "whiteboard" rectangle in the middle.
    frame = np.full((720, 1280, 3), 30, dtype=np.uint8)
    quad = np.array([[300, 150], [950, 200], [900, 600], [350, 550]], dtype=np.int32)
    cv2.fillConvexPoly(frame, quad, (230, 230, 225))
    cv2.putText(frame, "WHITEBOARD", (400, 380), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (20, 20, 20), 5)
    return frame


def test_detect_quad_finds_whiteboard_corners() -> None:
    quad = detect_quad(_scene())
    assert quad is not None
    assert quad.shape == (4, 2)
    xs, ys = quad[:, 0], quad[:, 1]
    assert 250 < xs.min() < 400 and 850 < xs.max() < 1000
    assert 100 < ys.min() < 250 and 500 < ys.max() < 650


def test_detect_quad_returns_none_without_board() -> None:
    assert detect_quad(np.full((720, 1280, 3), 30, dtype=np.uint8)) is None


def test_warp_to_quad_outputs_requested_size() -> None:
    frame = _scene()
    quad = detect_quad(frame)
    out = warp_to_quad(frame, quad, 1280, 720)
    assert out.shape == (720, 1280, 3)
    # The warped board should fill most of the frame with bright pixels.
    assert (cv2.cvtColor(out, cv2.COLOR_BGR2GRAY) > 150).mean() > 0.7


def test_quads_close_tolerates_jitter() -> None:
    a = np.array([[0, 0], [100, 0], [100, 100], [0, 100]], dtype=np.float32)
    b = a + 5
    c = a.copy()
    c[0] += 100
    assert quads_close(a, b)
    assert not quads_close(a, c)
    assert not quads_close(a, None)
