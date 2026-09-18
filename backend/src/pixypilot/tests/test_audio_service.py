import struct

from pixypilot.domains.audio.service import (
    _parse_mic_muted,
    _parse_mic_volume,
    _parse_mic_volume_percent,
    _parse_pixy_card,
    _pcm_s16le_level,
)


def test_parse_pixy_card_from_arecord_output() -> None:
    output = """
card 1: Wireless [Arctis Nova Pro Wireless], device 0: USB Audio [USB Audio]
card 3: PIXY [EMEET PIXY], device 0: USB Audio [USB Audio]
"""

    assert _parse_pixy_card(output) == 3


def test_parse_mic_mute_and_volume_from_amixer_contents() -> None:
    output = """
numid=2,iface=MIXER,name='Mic Capture Switch'
  ; type=BOOLEAN,access=rw------,values=1
  : values=off
numid=3,iface=MIXER,name='Mic Capture Volume'
  ; type=INTEGER,access=rw---R--,values=1,min=0,max=10,step=0
  : values=7
"""

    assert _parse_mic_muted(output) is True
    assert _parse_mic_volume(output) == 7


def test_parse_mic_volume_percent_scales_to_control_bounds() -> None:
    # The PIXY exposes raw 0-10; the API speaks percent like PATCH /audio/volume.
    output = """
numid=3,iface=MIXER,name='Mic Capture Volume'
  ; type=INTEGER,access=rw---R--,values=1,min=0,max=10,step=0
  : values=7
"""

    assert _parse_mic_volume_percent(output) == 70


def test_parse_mic_volume_percent_handles_full_and_zero() -> None:
    output = """
numid=3,iface=MIXER,name='Mic Capture Volume'
  ; type=INTEGER,access=rw---R--,values=1,min=0,max=10,step=0
  : values=10
numid=4,iface=MIXER,name='Mic Capture Volume'
  ; type=INTEGER,access=rw---R--,values=1,min=0,max=10,step=0
  : values=0
"""

    assert _parse_mic_volume_percent(output) == 100


def test_parse_mic_volume_percent_falls_back_to_raw_without_bounds() -> None:
    output = """
numid=3,iface=MIXER,name='Mic Capture Volume'
  ; type=INTEGER,access=rw---R--,values=1
  : values=42
"""

    assert _parse_mic_volume_percent(output) == 42


def test_pcm_s16le_level_silence_is_zero() -> None:
    assert _pcm_s16le_level(b"\x00" * 4096) == 0


def test_pcm_s16le_level_full_scale_is_hundred() -> None:
    chunk = struct.pack("<2048h", *([32767] * 2048))

    assert _pcm_s16le_level(chunk) == 100


def test_pcm_s16le_level_scales_quiet_signal() -> None:
    # ~-30 dBFS RMS should land near the middle of the -60 dBFS floor scale.
    amplitude = round(32768 * 10 ** (-30 / 20))
    chunk = struct.pack("<2048h", *([amplitude, -amplitude] * 1024))
    level = _pcm_s16le_level(chunk)

    assert level is not None
    assert 45 <= level <= 55
