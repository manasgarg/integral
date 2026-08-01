# rr

`rr` is a single-user terminal chat system that runs Pi in a locked-down Docker
container. A coordinator owns one durable conversation and message queue, a
runner owns the warm Pi RPC container, and a default-deny gateway injects host
credentials only for configured connection boundaries.

## Requirements

- Node.js 24 or newer
- Docker, for the runner or combined server
- OpenSSL, for the local gateway CA

## Install and start

```console
npm install
npm run build
node bin/rr.js connection add anthropic
node bin/rr.js server start
```

In another terminal:

```console
node bin/rr.js talk
```

Set `RR_HOME` to an absolute path to select a deployment. It defaults to
`$HOME/.rr`. Run `rr config init` for a documented starter configuration, and
`rr server start --component coordinator|runner|gateway` to operate the three
components as separate foreground processes.

## Development

Behavior contracts are grouped under [`behavior/`](behavior/README.md). Every
automated test names the behavior ID it covers. Run the complete gate with:

```console
npm run check
```
