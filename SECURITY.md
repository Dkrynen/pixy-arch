# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue.

Include what an attacker could do, the steps to reproduce it, and the version or commit you tested. You should get a reply within a week.

## Security model

Pixy Arch controls a camera and a microphone, so it is designed to stay local:

- The backend listens on `127.0.0.1` by default and has **no authentication**. Any program running as any user on the same computer can use the API.
- Browser requests from other websites are refused: cross-site and cross-origin requests are rejected using the `Sec-Fetch-Site` and `Origin` headers, and Host headers that aren't an IP address, `localhost`, this computer's name, or a name in `server.allowed_hosts` are rejected (blocks DNS rebinding).
- Settings changed through the API can't point the app at arbitrary files. File locations the app writes to (`storage.presets`, `frontend.dist`) can only be set in the config file, and device paths must be real `/dev/videoN` or `/dev/hidrawN` nodes.
- Binding to `0.0.0.0` exposes the camera and microphone to your whole network. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#network-access).
- The only outbound network request is the optional firmware update check, which fetches EMEET's public update manifest. There is no telemetry.

Findings that bypass the browser protections, let a network client read or write files, or run commands are in scope.
