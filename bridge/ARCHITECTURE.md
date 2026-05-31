# ThinkerByte Local Helper Architecture (Tier B)

## Goal
Run real networking/cyber labs locally while browser is only UI/control.

## Components
1. Browser UI (`experiment.html`)
2. Local Bridge (`bridge/agent/bridge-agent.js`)
3. Local container runtime (`docker` or `podman`)
4. Image profile catalog (`bridge/images/*.json`)

## Runtime Flow
1. Browser calls `/health`.
2. If missing, UI shows OS install command.
3. User selects profile (`alpine`, `debian`, `fedora`).
4. UI calls `/images/pull` and `/sessions`.
5. Bridge creates isolated topology and returns node map.
6. Resume mode can reopen latest valid session for same profile/topology.
7. Session ends/TTL expiry -> bridge destroys resources.

## Topology Templates
- `single`: one node (`student`).
- `lan`: `student`, `server`, `capture` on one network.
- `routed`: `student` <-> `router` <-> `server` with capture node.

## Disk/Bloat Controls
- TTL destroy for inactive sessions.
- Max concurrent session cap.
- Prune stopped containers and orphan networks.
- Prune unused images/volumes by policy window.
- Remove old ThinkerByte runtime-image versions automatically.

## Security
- Localhost bind only.
- Origin allowlist.
- Optional token mode.
- No remote bind and no cloud exec plane.

## Branding
All profile sessions print `ThinkerByte Lab` and use `thinkerbyte-*` hostnames/prompts.
