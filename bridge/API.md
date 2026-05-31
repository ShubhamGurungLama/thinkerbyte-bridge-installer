# ThinkerByte Local Bridge API

Base URL: `http://127.0.0.1:19777`

## Security
- Listener: localhost only.
- CORS: allowlisted origins from `manifest.json`.
- Optional token mode: set `TBLAB_REQUIRE_TOKEN=1` and use `x-thinkerbyte-token`.

## Endpoints

### `GET /health`
Returns bridge availability, runtime engine, disk policy, and uptime.

### `GET /install-status`
Returns install/runtime readiness:
- bridge version
- runtime engine (`docker` / `podman`)
- runtime availability
- profile metadata

### `GET /images`
Returns known profiles + local image availability.

### `POST /images/pull`
Body:
```json
{ "profile": "alpine" }
```
Ensures base image exists locally.

### `POST /repair`
Runs auto-heal workflow:
- prune expired sessions
- remove orphan networks
- remove stopped containers
- image/volume prune according to policy

### `GET /sessions`
List active and recent sessions.

### `POST /sessions`
Body:
```json
{
  "profile": "alpine",
  "topology": "routed",
  "ttlMinutes": 90,
  "name": "net-lab-1",
  "resumeIfPossible": true
}
```
Creates a new disposable networking session.

### `POST /sessions/resume`
Body:
```json
{
  "profile": "alpine",
  "topology": "routed"
}
```
Resumes latest matching non-expired session if available.

### `POST /sessions/:id/start`
Starts a stopped session.

### `POST /sessions/:id/stop`
Stops a running session.

### `POST /sessions/:id/exec`
Body:
```json
{
  "node": "student",
  "command": "ip a"
}
```
Runs a command on a node and returns stdout/stderr/exit code.

### `DELETE /sessions/:id`
Destroys containers + networks for a session.
