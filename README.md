# ∮ Integral

Integral is a durable terminal conversation with Pi, isolated in Docker behind a default-deny credential gateway.

```console
npm install
npm run build
node bin/integral.js connection add anthropic
node bin/integral.js server start
```

Then, in another terminal:

```console
node bin/integral.js talk
```

Set `INTEGRAL_HOME` to choose a deployment; it defaults to `$HOME/.integral`.

Development contract: [`behavior/`](behavior/README.md). Full check: `npm run check`.
