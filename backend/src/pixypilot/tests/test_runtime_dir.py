import os

import pytest

from pixypilot.core import runtime_dir as runtime_dir_module
from pixypilot.core.runtime_dir import runtime_dir


def test_runtime_dir_prefers_xdg_runtime_dir(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))

    path = runtime_dir()

    assert path == tmp_path / "pixypilot"
    assert (path.stat().st_mode & 0o777) == 0o700


def test_runtime_dir_falls_back_to_per_user_tmp(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    monkeypatch.setattr(runtime_dir_module.tempfile, "gettempdir", lambda: str(tmp_path))

    path = runtime_dir()

    assert path == tmp_path / f"pixypilot-{os.getuid()}"
    assert (path.stat().st_mode & 0o777) == 0o700


def test_runtime_dir_tightens_loose_permissions(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    (tmp_path / "pixypilot").mkdir(mode=0o777)
    (tmp_path / "pixypilot").chmod(0o777)

    assert (runtime_dir().stat().st_mode & 0o777) == 0o700


def test_runtime_dir_refuses_a_planted_symlink(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    monkeypatch.setattr(runtime_dir_module.tempfile, "gettempdir", lambda: str(tmp_path))
    target = tmp_path / "attacker"
    target.mkdir()
    os.symlink(target, tmp_path / f"pixypilot-{os.getuid()}")

    with pytest.raises(PermissionError):
        runtime_dir()
