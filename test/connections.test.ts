import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  credentialFor,
  clearConnectionDegraded,
  listConnections,
  loadConnections,
  markConnectionDegraded,
  removeConnection,
  removeCredential,
  saveConnection,
  validateConnection,
} from "../src/connections.ts";
import { fixture } from "./helpers.ts";

/* @covers CONFIG-48C2D7A1
Given a connection file may define `name`, `kind`, `provider`, `url`, `auth`, `path`, `branch`, `mount`, `command`, `args`, `env`, `secret_env`, and `allowed_urls`
	When integral validates the connection
		Then `name` must contain at most 64 filesystem-safe letters, numbers, dots, underscores, or hyphens
			And must start with a letter or number
			And must be unique across loaded connection files
			And `kind` accepts only `model`, `http`, `mcp`, `email`, `host-repo`, or `host-store`
			And `provider` is required for `model` and must name a catalog provider
			And `provider` is required for `email` and must name an email provider
			And `url` is required for `http` and remote `mcp` connections and must use HTTP or HTTPS
			And `command` is required for stdio `mcp` connections
			And `url` and `command` cannot be used together
			And `auth` accepts only `oauth`, `device-code`, `key`, or `none`
			And generic connections must declare `auth` explicitly
			And `host-repo` requires an absolute `path`, accepts an optional `branch`, and has no authentication metadata
			And `host-store` requires an absolute `path` and has no authentication or branch metadata
			And `mount` is required only for host resources and uses the common agent-visible mount-path validation
			And model connections use the catalog auth default when `auth` is omitted
			And unknown connection options are rejected
*/
/* @covers CONNECTION-46E90D69
Given no connection exists for the selected provider
	When the user runs `integral connection add <provider>`
		And provider authentication succeeds
		Then integral stores the credential in the host control-plane area
			And creates a model connection named after the provider
			And makes the credential file readable only by its owner
			And makes the connection available to new chat sessions
			And identifies the connection without printing secret values
*/
/* @covers CONNECTION-9C7A41E2
Given the user wants to choose a connection name
	When the user runs `integral connection add <entry> --name <name>`
		And the selected authentication setup succeeds
		Then integral stores the connection and any credential under the requested name
			And reports the provider or type separately from the connection name
			And lets later `connection ls` and `connection rm` address that name
*/
test("[CONFIG-48C2D7A1] [CONNECTION-46E90D69] [CONNECTION-9C7A41E2] model declarations use catalog providers and protected host credentials", async (t) => {
  const paths = await fixture(t);
  const connection = validateConnection({
    name: "work",
    kind: "model",
    provider: "anthropic",
    auth: "key",
  });
  await saveConnection(paths, connection, "top-secret");
  const rows = await listConnections(paths);
  assert.equal(rows[0]?.name, "work");
  assert.equal(rows[0]?.state, "active");
  const declaration = await readFile(
    join(paths.connections, "work.toml"),
    "utf8",
  );
  assert.doesNotMatch(declaration, /top-secret/);
  assert.equal(await credentialFor(paths, "work"), "top-secret");
  assert.equal(
    (await stat(join(paths.credentials, "work"))).mode & 0o777,
    0o600,
  );
});

/* @covers CONFIG-61F3D8B2
Given the user successfully adds a connection named `<name>`
	When integral persists its non-secret declaration
		Then it writes `<INTEGRAL_HOME>/config/connections/<name>.toml` atomically
			And stores the provider or type, endpoint policy, auth method, and non-secret metadata
			And stores credential material only under the protected data area
			And requires the file stem and declared connection name to agree
*/
/* @covers CONFIG-AC42E7D9
Given a connection declaration contains valid operator-edited non-secret options
	When the user rotates its credential by adding that connection again
		Then integral replaces only credential material
			And leaves the connection file bytes unchanged
			And does not overwrite operator edits with catalog defaults
*/
/* @covers CONNECTION-634C2DA7
Given a connection with one or more stored credentials already exists
	When the user adds the same entry and connection name again
		And authentication or stdio secret collection succeeds
		Then integral replaces the stored credentials atomically
			And preserves the connection's name and non-secret configuration
			And requires the kind, provider, authentication method, and declared stdio secret names to match
			And new model or stdio requests use the replacement credentials
			And advances the connection generation
			And the command reports rotation rather than duplicate creation
	When the existing connection uses no authentication and declares no secret environment values
		Then integral refuses to treat another add as credential rotation
*/
test("[CONFIG-61F3D8B2] [CONFIG-AC42E7D9] [CONNECTION-634C2DA7] rotation changes only the credential and advances generation", async (t) => {
  const paths = await fixture(t),
    c = validateConnection({
      name: "model",
      kind: "model",
      provider: "anthropic",
      auth: "key",
    });
  await saveConnection(paths, c, "old");
  const file = join(paths.connections, "model.toml");
  await writeFile(file, `${await readFile(file, "utf8")}# operator note\n`);
  const before = await readFile(file, "utf8");
  const rotated = await saveConnection(paths, c, "new");
  assert.equal(rotated.rotated, true);
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal(await credentialFor(paths, "model"), "new");
  assert.equal(rotated.generation, 2);
});

/* @covers CONFIG-82E6A3F5
Given an `http` connection file may define `url`, `methods`, and `path_prefix`
	When the gateway compiles that connection
		Then the URL defines its allowed scheme, host, and port
			And `methods` is a non-empty list of HTTP methods or `*`
			And omitted `methods` defaults to `*`
			And `path_prefix` may only narrow the URL's normalized path
			And requests outside the compiled boundary remain denied
*/
/* @covers CONFIG-D17B4C90
Given a connection uses `auth = "key"`
	And its file may define `header` and `scheme`
	When integral validates the connection
		Then `header` defaults to `Authorization`
			And `scheme` defaults to `Bearer`
			And neither option may contain carriage returns or newlines
			And the actual key remains in protected credential storage
*/
test("[CONFIG-82E6A3F5] [CONFIG-D17B4C90] [CONNECTION-A61E2C9D] HTTP boundaries normalize URL, methods, path, and key injection metadata", () => {
  const c = validateConnection({
    name: "api",
    kind: "http",
    url: "https://example.test/v1",
    auth: "key",
    methods: ["get", "POST"],
    path_prefix: "/v1/private",
  });
  assert.equal(c.url, "https://example.test/v1");
  assert.deepEqual(c.methods, ["GET", "POST"]);
  assert.equal(c.header, "Authorization");
  assert.equal(c.scheme, "Bearer");
  assert.throws(
    () =>
      validateConnection({
        name: "api",
        kind: "http",
        url: "https://example.test/v1",
        auth: "key",
        path_prefix: "/other",
      }),
    /only narrow/,
  );
});

test("[CONNECTION-12C87631] GitHub uses one protected connection with its exact API and Git hosts", async (t) => {
  const paths = await fixture(t),
    github = validateConnection({
      name: "github",
      kind: "http",
      provider: "github",
      auth: "key",
      hosts: ["api.github.com", "github.com"],
    });
  assert.deepEqual(github.hosts, ["api.github.com", "github.com"]);
  await saveConnection(paths, github, "github-secret");
  const declaration = await readFile(
    join(paths.connections, "github.toml"),
    "utf8",
  );
  assert.match(declaration, /provider = "github"/);
  assert.match(declaration, /hosts = \["api\.github\.com", "github\.com"\]/);
  assert.doesNotMatch(declaration, /github-secret/);
  assert.equal(await credentialFor(paths, "github"), "github-secret");
  assert.throws(
    () =>
      validateConnection({
        name: "github",
        kind: "http",
        provider: "github",
        auth: "key",
        hosts: ["evil.test"],
      }),
    /GitHub hosts/,
  );
});

/* @covers CONFIG-6A90E2D4
Given a generic HTTP connection uses `auth = "oauth"` or `auth = "device-code"`
	Or an MCP connection supplies explicit OAuth compatibility overrides
	When integral validates its non-secret authentication metadata
		Then OAuth requires `authorization_url`, `token_url`, and `client_id`
			And device-code additionally requires `device_authorization_url`
			And `scopes` is an optional list of scope strings
			And endpoint URLs must use HTTPS unless they target loopback
			And client secrets and tokens remain outside configuration files
Given an MCP connection does not supply explicit OAuth compatibility overrides
	When integral validates its non-secret authentication metadata
		Then OAuth endpoint, client-registration, and scope fields may be absent
			And integral obtains them through standardized MCP authorization discovery before activating the connection
*/
test("[CONFIG-6A90E2D4] OAuth and device-code metadata is complete, HTTPS-only except loopback, and contains no tokens", () => {
  const raw = {
    name: "remote",
    kind: "http",
    url: "https://api.test",
    auth: "oauth",
    authorization_url: "https://login.test/auth",
    token_url: "https://login.test/token",
    client_id: "public",
    scopes: ["read"],
  };
  assert.equal(validateConnection(raw).clientId, "public");
  assert.throws(
    () =>
      validateConnection({
        ...raw,
        authorization_url: "http://login.test/auth",
      }),
    /must use HTTPS/,
  );
  assert.throws(
    () => validateConnection({ ...raw, auth: "device-code" }),
    /device_authorization_url/,
  );
});

/* @covers CONFIG-3F7A81C6
Given an `mcp` connection file may define `transport`
	When integral validates the connection
		Then `transport` accepts only `streamable-http`, `sse`, or `stdio`
			And its absence with a URL causes integral to detect the remote transport from the endpoint
			And `streamable-http` or `sse` forces that remote transport as a compatibility override
			And `stdio` requires `command` and forbids `url`
			And integral still negotiates the protocol and discovers tools before activating the connection
			And integral registers each discovered tool with a deterministic connection namespace
			And the gateway applies the connection's remote HTTP boundary and authentication when applicable
*/
/* @covers CONFIG-02905B6E
Given an `mcp` connection uses `transport = "stdio"`
	When integral validates the connection
		Then `command` is one non-empty executable name or absolute image path
			And `args` is an optional ordered list of literal strings
			And `env` is an optional table of non-secret string values
			And `secret_env` is an optional list of unique environment-variable names whose values exist only in credential storage
			And every environment-variable name matches `[A-Za-z_][A-Za-z0-9_]*`
			And `allowed_urls` is an optional list of normalized HTTP or HTTPS boundaries
			And `auth` must be `none` because MCP transport authorization does not apply to stdio
			And OAuth metadata, HTTP header policy, and remote transport options are rejected
			And missing secret values leave the connection disabled without exposing their names as values
	When `command` or `args` contain shell syntax
		Then integral preserves them as literal process arguments or names
			And never evaluates them through a shell
*/
test("[CONFIG-3F7A81C6] [CONFIG-02905B6E] [CONNECTION-0EF2CF89] MCP declarations support remote and isolated stdio transports", () => {
  assert.equal(
    validateConnection({
      name: "docs",
      kind: "mcp",
      url: "https://mcp.test",
      auth: "none",
    }).transport,
    "streamable-http",
  );
  assert.equal(
    validateConnection({
      name: "docs",
      kind: "mcp",
      url: "https://mcp.test",
      auth: "none",
      transport: "sse",
    }).transport,
    "sse",
  );
  const stdio = validateConnection({
    name: "local-docs",
    kind: "mcp",
    auth: "none",
    transport: "stdio",
    command: "node",
    args: ["server.js", "--literal=$(false)"],
    env: { CACHE_DIR: "/tmp/cache" },
    secret_env: ["API_TOKEN"],
    allowed_urls: ["https://api.example.test/v1"],
  });
  assert.deepEqual(stdio, {
    name: "local-docs",
    kind: "mcp",
    auth: "none",
    transport: "stdio",
    command: "node",
    args: ["server.js", "--literal=$(false)"],
    env: { CACHE_DIR: "/tmp/cache" },
    secretEnv: ["API_TOKEN"],
    allowedUrls: ["https://api.example.test/v1"],
  });
  assert.throws(
    () =>
      validateConnection({
        name: "bad",
        kind: "mcp",
        auth: "none",
        transport: "stdio",
        command: "server",
        url: "https://mcp.test",
      }),
    /command instead of url/,
  );
  assert.throws(
    () =>
      validateConnection({
        name: "bad",
        kind: "mcp",
        auth: "key",
        transport: "stdio",
        command: "server",
      }),
    /no transport authentication/,
  );
});

/* @covers CONNECTION-5833EDC7
Given zero or more connections have been configured
	When the user runs `integral connection ls`
		Then integral lists every connection by name
			And shows its provider or generic type
			And shows its authentication method
			And shows `active` when its credential is usable
			And shows `active` for a valid no-auth connection
			And treats OAuth as usable when its access token is unexpired or it has a refresh token
			And shows `DISABLED (no secret)` when a credentialed connection has no credential
			And shows `DISABLED (no secret)` when a stdio connection is missing any declared secret environment value
			And shows `DISABLED (no secret)` for malformed or expired OAuth without a refresh token
			And does not print secret values
*/
test("[CONNECTION-5833EDC7] [CONNECTION-634C2DA7] stdio secret environments are stored together and required for activation", async (t) => {
  const paths = await fixture(t),
    connection = validateConnection({
      name: "local",
      kind: "mcp",
      auth: "none",
      transport: "stdio",
      command: "server",
      secret_env: ["TOKEN", "SECONDARY"],
    }),
    credential = JSON.stringify({
      type: "stdio-env",
      values: { TOKEN: "one", SECONDARY: "two" },
    });
  await saveConnection(paths, connection, credential);
  assert.equal((await listConnections(paths))[0]?.state, "active");
  await removeCredential(paths, "local");
  assert.equal(
    (await listConnections(paths))[0]?.state,
    "DISABLED (no secret)",
  );
  await saveConnection(paths, connection, credential);
  assert.equal((await listConnections(paths))[0]?.state, "active");
});

/* @covers CONNECTION-8F14C3B7
Given the user is adding a generic HTTP or remote MCP connection
	When its name is missing or already used
		Then integral rejects setup without changing stored connections
	When its URL is missing, malformed, or uses an unsupported scheme
		Then integral rejects setup without changing stored connections
	When explicitly configured authentication metadata is incomplete
		Then integral rejects setup without storing partial credentials
*/
test("[CONNECTION-8F14C3B7] invalid generic declarations leave storage unchanged", async (t) => {
  const paths = await fixture(t);
  assert.throws(
    () =>
      validateConnection({
        name: "bad/name",
        kind: "http",
        url: "ftp://host",
        auth: "none",
      }),
    /filesystem-safe/,
  );
  assert.deepEqual((await loadConnections(paths)).connections, []);
});

/* @covers CONNECTION-475E6AE7
Given zero or more connections have been configured
	When the user runs `integral connection ls --json`
		Then integral writes a machine-readable JSON array to stdout
			And represents the same names, types, auth methods, and states as the human view
			And does not include secret values
*/
test("[CONNECTION-5833EDC7] [CONNECTION-475E6AE7] missing credentials disable records without revealing values", async (t) => {
  const paths = await fixture(t),
    c = validateConnection({
      name: "api",
      kind: "http",
      url: "http://localhost:99",
      auth: "key",
    });
  await saveConnection(paths, c, "value");
  await removeCredential(paths, "api");
  const rows = await listConnections(paths);
  assert.equal(rows[0]?.state, "DISABLED (no secret)");
  assert.doesNotMatch(JSON.stringify(rows), /value/);
});

/* @covers MCP-6F5CFA0E
Given multiple MCP connections are configured
	When one server is unreachable, unauthorized, malformed, protocol-incompatible, or its stdio process exits
		Then integral marks only that connection unavailable or degraded
			And identifies the failing stage in `integral connection ls`
			And keeps its credentials secret
			And continues provisioning tools from healthy connections
	When the failing server later passes authorization, negotiation, and tool discovery
		Then integral returns the connection to active
			And makes its tools available no later than the next Pi turn
			And does not require the connection to be recreated
*/
test("[MCP-6F5CFA0E] one MCP connection reports a bounded failing stage and recovers without affecting healthy connections", async (t) => {
  const paths = await fixture(t);
  for (const name of ["healthy", "failing"])
    await saveConnection(
      paths,
      validateConnection({
        name,
        kind: "mcp",
        url: `https://${name}.example.test/mcp`,
        auth: "none",
      }),
    );
  await markConnectionDegraded(paths, "failing", "discovery");
  let rows = await listConnections(paths);
  assert.equal(rows.find((row) => row.name === "healthy")?.state, "active");
  assert.deepEqual(
    rows
      .filter((row) => row.name === "failing")
      .map((row) => [row.state, row.availabilityReason]),
    [["degraded", "discovery"]],
  );
  assert.doesNotMatch(JSON.stringify(rows), /credential|secret/i);
  await clearConnectionDegraded(paths, "failing");
  rows = await listConnections(paths);
  assert.equal(rows.find((row) => row.name === "failing")?.state, "active");
});

/* @covers CONNECTION-741C2F56
Given a connection with one or more stored credentials exists
	And the terminal is interactive
	When the user runs `integral connection rm <name>`
		Then integral describes the credentials and connection record to be removed without printing secret values
			And asks for confirmation before removing the credentials
	When the user declines credential removal
		Then integral leaves the credentials and connection unchanged
	When the user confirms credential removal
		Then integral removes every credential owned by the connection
			And asks separately whether to remove the connection record
	When the user declines connection-record removal
		Then integral retains the connection record
			And `connection ls` shows it as `DISABLED (no secret)`
	When the user confirms connection-record removal
		Then integral removes the connection record
			And prevents new chats from selecting the removed connection
*/
test("[CONNECTION-741C2F56] [CONNECTION-E73B40C6] removal can delete credentials separately or remove an entire no-auth record", async (t) => {
  const paths = await fixture(t);
  const keyed = validateConnection({
    name: "keyed",
    kind: "http",
    url: "https://a.test",
    auth: "key",
  });
  await saveConnection(paths, keyed, "key");
  await removeCredential(paths, "keyed");
  assert.equal(
    (await listConnections(paths))[0]?.state,
    "DISABLED (no secret)",
  );
  const open = validateConnection({
    name: "open",
    kind: "http",
    url: "https://b.test",
    auth: "none",
  });
  await saveConnection(paths, open);
  await removeConnection(paths, "open");
  assert.deepEqual(
    (await listConnections(paths)).map((c) => c.name),
    ["keyed"],
  );
});

/* @covers CONFIG-58A1E7C3
Given server components are running
	When `integral connection add` or `integral connection rm` commits a valid declaration change
		Then integral assigns the connection snapshot a new monotonic generation
			And the gateway reloads all currently valid declarations and credentials
			And the coordinator mirrors the committed generation in component state
			And the runner reads current connections when it creates a Pi session
			And each component publishes the generation it has observed
			And the runner does not claim new messages while component generations disagree
			And no component observes a partially written connection declaration
	When a valid manual declaration edit changes the gateway's connection snapshot
		Then the gateway detects the changed snapshot
			And advances the generation when the CLI has not already done so
*/
/* @covers CONFIG-B6D29F40
Given server components have a last known valid connection snapshot
	When a manual connection-file edit makes the connection configuration invalid
		Then the gateway continues using declarations that still validate
			And excludes the invalid declaration from its active candidates
			And publishes degraded health with the file error
			And the gateway does not admit new access from the invalid declaration
			And the runner does not claim new work while gateway health is degraded
	When the files become valid again
		Then components adopt the next complete connection generation
*/
test("[CONFIG-58A1E7C3] [CONFIG-B6D29F40] connection snapshots are complete generations and invalid files fail closed", async (t) => {
  const paths = await fixture(t),
    c = validateConnection({
      name: "ok",
      kind: "http",
      url: "https://a.test",
      auth: "none",
    });
  const saved = await saveConnection(paths, c);
  assert.equal(saved.generation, 1);
  await writeFile(
    join(paths.connections, "bad.toml"),
    "name='different'\nkind='http'\nurl='https://b.test'\nauth='none'\n",
  );
  const loaded = await loadConnections(paths);
  assert.deepEqual(
    loaded.connections.map((x) => x.name),
    ["ok"],
  );
  assert.match(loaded.errors[0]!, /does not match/);
});

test("[CONFIG-0C6A91E4] literal credential fields in connection configuration are rejected", () => {
  assert.throws(
    () =>
      validateConnection({
        name: "x",
        kind: "http",
        url: "https://x.test",
        auth: "key",
        api_key: "oops",
      }),
    /credentials must be stored/,
  );
});

test("[EMAIL-B765A312] Gmail derives OAuth endpoints and least-privilege scopes from its capabilities", () => {
  const connection = validateConnection({
    name: "work-mail",
    kind: "email",
    provider: "gmail",
    auth: "oauth",
    account: "me@example.com",
    client_id: "public-client",
    capabilities: ["read", "search", "send"],
    allowed_recipients: ["colleague@example.com", "*@company.example"],
  });
  assert.equal(
    connection.authorizationUrl,
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  assert.equal(connection.tokenUrl, "https://oauth2.googleapis.com/token");
  assert.deepEqual(connection.scopes, [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ]);
  assert.equal(connection.account, "me@example.com");
});

test("[EMAIL-B765A312] Mailgun is a send-only regional provider with a fixed domain From identity", () => {
  const connection = validateConnection({
    name: "transactional",
    kind: "email",
    provider: "mailgun",
    auth: "key",
    capabilities: ["send"],
    domain: "mg.example.com",
    from_address: "robot@mg.example.com",
    region: "eu",
    allowed_recipients: ["*@example.com"],
  });
  assert.equal(connection.domain, "mg.example.com");
  assert.equal(connection.fromAddress, "robot@mg.example.com");
  assert.equal(connection.region, "eu");
  assert.throws(
    () =>
      validateConnection({
        name: "bad",
        kind: "email",
        provider: "mailgun",
        auth: "key",
        capabilities: ["read"],
        domain: "mg.example.com",
        from_address: "robot@mg.example.com",
      }),
    /mailgun capabilities.*send/,
  );
});

test("[EMAIL-B765A312] send capability requires a valid explicit recipient policy", () => {
  const base = {
    name: "mail",
    kind: "email",
    provider: "gmail",
    auth: "oauth",
    account: "me@example.com",
    client_id: "public-client",
    capabilities: ["send"],
  };
  assert.throws(() => validateConnection(base), /requires allowed_recipients/);
  assert.throws(
    () => validateConnection({ ...base, allowed_recipients: ["example.com"] }),
    /email addresses or \*@domain/,
  );
  assert.throws(
    () => validateConnection({ ...base, allowed_recipients: ["*"] }),
    /email addresses or \*@domain/,
  );
});
