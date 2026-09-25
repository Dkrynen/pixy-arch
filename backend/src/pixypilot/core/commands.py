import asyncio
from dataclasses import dataclass


@dataclass(frozen=True)
class CommandResult:
    stdout: str
    stderr: str
    returncode: int


class CommandError(RuntimeError):
    def __init__(self, argv: list[str], result: CommandResult) -> None:
        message = f"Command failed ({result.returncode}): {' '.join(argv)}"
        if result.stderr:
            message = f"{message}\n{result.stderr.strip()}"
        super().__init__(message)
        self.argv = argv
        self.result = result


class AsyncCommandRunner:
    async def run(self, argv: list[str]) -> CommandResult:
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            # A missing tool (alsa-utils, pipewire, ...) is an ordinary command
            # failure: callers that degrade on CommandError keep degrading.
            raise CommandError(
                argv,
                CommandResult(stdout="", stderr=f"{argv[0]}: command not found", returncode=127),
            ) from exc
        stdout, stderr = await process.communicate()
        result = CommandResult(
            stdout=stdout.decode("utf-8", errors="replace"),
            stderr=stderr.decode("utf-8", errors="replace"),
            returncode=process.returncode,
        )
        if process.returncode != 0:
            raise CommandError(argv, result)
        return result
