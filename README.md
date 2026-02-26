# MoQ Test Harness

Standalone test app for debugging MoQ (Media over QUIC) audio/video streaming. Connects to the public MoQ CDN relay — no auth required.

## Run

```bash
bun install
bun dev
```

Opens on `http://localhost:3001`.

## Test

1. Open two browser tabs to `http://localhost:3001`
2. Both tabs should show the same stream name (auto-generated, persisted in localStorage)
3. Click **Join** on both tabs
4. Enable **Mic** and **Spkr** on both tabs
5. Speak — check the RMS meters and event log for audio activity

To share a specific room, use the URL: `http://localhost:3001/my-room-name`

## CDN

Hardcoded to `https://us-east-1.relay.sylvan-b.com/` (US Central node). The MoQ CDN also has `euc.cdn.moq.dev` (Europe) and `sea.cdn.moq.dev` (Asia) — change in `src/TestCall.tsx` if needed.

## Stack

- SolidJS 1.9 + @solidjs/router
- @moq/lite, @moq/publish, @moq/watch, @moq/signals
- RSBuild with SWC loader for @moq/* packages
- Tailwind 4 + DaisyUI 5
