import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  credentialFor,
  listConnections,
  loadConnections,
  removeConnection,
  removeCredential,
  saveConnection,
  validateConnection,
} from "../src/connections.ts";
import { fixture } from "./helpers.ts";

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

test("[CONFIG-3F7A81C6] [CONNECTION-4B8D73F1] MCP connections support only declared remote HTTP transports", () => {
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
  assert.throws(
    () =>
      validateConnection({
        name: "docs",
        kind: "mcp",
        url: "https://mcp.test",
        auth: "none",
        transport: "stdio",
      }),
    /transport/,
  );
});

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
