# Automatic Doctor

Run the local installation and bridge check before initiating reasoning:

```bash
node skills/agent-bridge-chatgpt/scripts/doctor.mjs --json
```

Continue only when it returns `READY`.

- Report `MISSING_RUNTIME` when Node.js 18 or newer is unavailable.
- Report `INVALID_INSTALLATION` when required files are missing.
- Inspect `bridge.status` in the JSON report:
  - `READY`: Browser tab is actively connected and ready to receive reasoning tasks.
  - `NEEDS_BROWSER_CONNECTION`: Bridge server is up, waiting for user to open `https://chatgpt.com/`.
  - `NOT_RUNNING`: Local bridge server is not currently running (will be automatically launched on demand during send).
