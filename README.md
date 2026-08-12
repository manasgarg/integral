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

To attach one private Discord DM as a separate conversation, create a Discord
bot with the Message Content intent, copy the target user's numeric Discord ID,
and run:

```console
printf '%s\n' "$DISCORD_BOT_TOKEN" | node bin/integral.js connection add discord --user-id <discord-user-id> --credential-stdin
node bin/integral.js server start
```

Integral verifies and stores the application, bot, user, and DM identities. The
token remains host-side; Discord history, queue, model selection, and Pi session
state are isolated from the default terminal conversation.

Development contract: [`behavior/`](behavior/README.md). Full check: `npm run check`.
