# NOPEntel

NOPEntel is a small local web app for watching OpenTelemetry-like agent
telemetry in real time.

The app tails the local collector JSONL file, stores flattened events in SQLite,
and streams updates to the browser with Server-Sent Events.

The current known local producers are:

- `codex_exec` as Codex
- `codex_cli_rs` as Codex
- `codex-app-server` as Codex / Codex Desktop
- `claude-code` as Claude Code

## Run

```bash
python3 server.py
```

Open:

```text
http://127.0.0.1:8765
```

## Options

```bash
python3 server.py --help
```

Defaults:

- OTel source: `~/.codex/otel/logs/codex-otel.json`
- SQLite DB: `./data/nopentel.sqlite`
- Bind address: `127.0.0.1`
- Port: `8765`

## Notes

- The dashboard does not redact consumed OTel data. It stores the full local
  telemetry object and fetches it only when you click a specific event or call.
- Prompt, response, and tool payloads are intentionally inspectable in the
  click-through object detail view.
- Codex Desktop chats that have no project/cwd session metadata are shown as
  `Codex App Chat` instead of `(unknown project)`.
- This is a local operational tool, not an authenticated multi-user service.
