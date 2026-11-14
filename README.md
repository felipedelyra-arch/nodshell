# NodShell

A desktop cockpit for coding agents. Every node on an infinite canvas is a real terminal running [Claude Code](https://claude.com/claude-code); agents are grouped by role, wired together with edges, and coordinated by an Orchestrator node.

Linux only for now.

## Features

- **Real terminals on a canvas.** Each card is a PTY running Claude Code (or a plain shell), with live status taken from the CLI's own hooks: running, resting, needs you.
- **Squads.** One click creates an Orchestrator plus four groups of two agents (Frontend, Backend, Testers, Reviewers), each agent in its own git worktree and branch.
- **Flows.** Draw an edge between agents or groups: when the source finishes a turn, its last message is delivered to the target through a template. Hop, loop and burst guards stop runaway chains, and Pause all freezes every flow and process.
- **Delegation.** The Orchestrator talks to its squad through a local MCP bridge (`list_agents`, `send_message`, `spawn_agent`, ...). Spawning a new agent always asks you first.
- **Command bar.** `@name` or `@group` routes a prompt; without a prefix it goes to the Orchestrator. Optional push-to-talk dictation types into the field and never sends on its own.
- **Loops and handoff.** Repeat a prompt on a schedule, on idleness or on console output until a goal is reached; hand a task to another agent with a briefing you review before it is sent.
- **Board tools.** Free drawing, shapes, text notes, images and sandboxed web tiles (http/https only) for live previews.
- **Persistence.** Boards are saved per repository; reopening relaunches each agent and offers to resume its conversation.

## Requirements

- Linux x64
- `git`
- Claude Code installed and signed in (`claude` on your `PATH` or in `~/.local/bin`)

## Install

Download the latest package from the [Releases](https://github.com/felipedelyra-arch/nodshell/releases) page.

**Debian / Ubuntu**

```sh
sudo apt install ./nodshell-0.1.1-amd64.deb
```

**AppImage**

```sh
chmod +x nodshell-0.1.1-x86_64.AppImage
./nodshell-0.1.1-x86_64.AppImage
```

The AppImage needs FUSE 2 (`libfuse2`, or `libfuse2t64` on recent Ubuntu releases).

## Getting started

1. Pick a git repository with the project dropdown in the top bar.
2. Open **Presets → Layouts → Squad** for a full squad, or use **Spawn 4** / **New console** for a few stand-alone terminals. A squad is optional.
3. Answer Claude Code's "trust this folder" prompt in each terminal. The app never answers it for you.
4. Type a goal in the command bar and press Enter.

## Dictation (optional)

Dictation uses a local [whisper.cpp](https://github.com/ggml-org/whisper.cpp) build; audio never leaves the machine and is never written to disk. Without it the microphone button stays disabled.

Build whisper.cpp and download a model, then either place them at the default location or point the app at them:

| | Default | Override |
|---|---|---|
| Binary | `~/.local/share/whisper.cpp/src/build/bin/whisper-cli` | `NODSHELL_WHISPER_BIN` |
| Model | `~/.local/share/whisper.cpp/models/ggml-base.bin` | `NODSHELL_WHISPER_MODEL` |

## Security model

- The renderer is sandboxed with context isolation and a strict CSP; it never sees file paths, tokens or processes. All input crossing the IPC boundary is validated.
- Agents are spawned with an argument array, never through a shell. Permission bypass is off by default and flagged on the card when enabled.
- The hook listener and the MCP bridge use a private Unix socket (mode 0600) with a random token per agent. Nothing listens on the network.
- Automatic messages are only typed into an agent that is idle, never into one showing a permission prompt.
- Web tiles run in an isolated in-memory session with every permission denied.

**Known limit:** all agents run as your OS user. An agent with shell access can read another agent's files and tokens. Run agents only on repositories and with permissions you would trust a single agent with.

## Development

```sh
npm install
npm run dev        # run with hot reload
npm run typecheck && npm run lint
npm run test && npm run test:db
npm run build && npm run test:e2e
npm run dist       # build the AppImage and .deb into dist/
```

Stack: Electron, React, TypeScript, Tailwind, React Flow, xterm.js, node-pty, SQLite.

## License

[MIT](LICENSE)
