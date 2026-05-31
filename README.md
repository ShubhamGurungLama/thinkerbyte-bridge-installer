# thinkerbyte-bridge-installer

Installer bundle for ThinkerByte Local Bridge.

## Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/ShubhamGurungLama/thinkerbyte-bridge-installer/main/bridge/install.sh | bash
```

## Windows (PowerShell)

```powershell
iwr https://raw.githubusercontent.com/ShubhamGurungLama/thinkerbyte-bridge-installer/main/bridge/install.ps1 -UseBasicParsing | iex
```

## Local bridge health

```bash
curl -fsS http://127.0.0.1:19777/health
```
