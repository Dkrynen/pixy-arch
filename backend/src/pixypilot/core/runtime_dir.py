import os
import stat
import tempfile
from pathlib import Path


def runtime_dir() -> Path:
    """Private per-user directory for scratch files that fixed names must not
    expose: $XDG_RUNTIME_DIR/pixypilot, else <tmp>/pixypilot-<uid>.

    A fixed name under the shared /tmp could be pre-created (or symlinked) by
    another user, so the directory must be ours, a real directory, and 0700.
    Raises OSError when that cannot be guaranteed.
    """
    xdg_runtime = os.environ.get("XDG_RUNTIME_DIR", "").strip()
    if xdg_runtime and Path(xdg_runtime).is_absolute():
        path = Path(xdg_runtime) / "pixypilot"
    else:
        path = Path(tempfile.gettempdir()) / f"pixypilot-{os.getuid()}"
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise PermissionError(f"{path} is not a directory owned by this user")
    if stat.S_IMODE(info.st_mode) != 0o700:
        path.chmod(0o700)
    return path
