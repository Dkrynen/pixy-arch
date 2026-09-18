from pixypilot.domains.virtualcam.models import VirtualCamStartRequest, VirtualCamTransform
from pixypilot.domains.virtualcam.service import build_ffmpeg_command, build_filter_chain


def test_filter_chain_defaults_to_scale_only() -> None:
    assert build_filter_chain(VirtualCamTransform(), 1920, 1080) == "scale=1920:1080"


def test_filter_chain_orders_mirror_rotate_zoom() -> None:
    transform = VirtualCamTransform(mirror=True, rotate=90, zoom=2.0)
    assert build_filter_chain(transform, 1080, 1920) == "hflip,transpose=1,crop=iw/2:ih/2,scale=1080:1920"


def test_filter_chain_180_uses_double_flip() -> None:
    transform = VirtualCamTransform(rotate=180)
    assert build_filter_chain(transform, 1920, 1080) == "hflip,vflip,scale=1920:1080"


def test_ffmpeg_command_uses_mjpeg_in_yuyv_out() -> None:
    request = VirtualCamStartRequest(transform=VirtualCamTransform(mirror=True))
    command = build_ffmpeg_command(request, "/dev/video0", "/dev/video10")
    assert command[command.index("-input_format") + 1] == "mjpeg"
    assert command[command.index("-pix_fmt") + 1] == "yuyv422"
    assert command[-2:] == ["yuyv422", "/dev/video10"] or command[-1] == "/dev/video10"
    assert "hflip" in command[command.index("-vf") + 1]
