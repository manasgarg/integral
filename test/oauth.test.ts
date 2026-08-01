import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationCodeFromInput,
  oauthAccess,
  runGenericOAuth,
  runModelOAuth,
} from "../src/oauth.ts";
import { validateConnection } from "../src/connections.ts";
import { fixture } from "./helpers.ts";

test("[BOX-E1F472A1] model OAuth loads Pi from the refreshed deployment runtime", async (t) => {
  const paths = await fixture(t),
    shown: string[] = [],
    calls: string[] = [],
    serialized = await runModelOAuth(
      paths,
      "openai-codex",
      "oauth",
      { show: (message) => shown.push(message), prompt: async () => "" },
      {
        ensure: async () => ({
          version: "1.2.3",
          packageRoot: "/runtime/pi",
          warning: "offline; using cache",
        }),
        load: async (resolution) => {
          calls.push(`${resolution.version}:${resolution.packageRoot}`);
          return {
            ModelRuntime: {
              create: async () => ({
                async login(_provider, _type, interaction) {
                  calls.push("login");
                  interaction.notify({
                    type: "progress",
                    message: "authorizing",
                  });
                  return {
                    type: "oauth" as const,
                    access: "access",
                    refresh: "refresh",
                    expires: 123,
                  };
                },
                getAuth: async () => undefined,
              }),
            },
          };
        },
      },
    );
  assert.deepEqual(calls, ["1.2.3:/runtime/pi", "login"]);
  assert.match(shown[0]!, /Warning: offline; using cache/);
  assert.equal(shown[1], "authorizing");
  assert.equal(JSON.parse(serialized).access, "access");
});

test("[CONNECTION-512D9A25] generic device-code authentication runs authorization and token exchange without exposing the token to UI", async () => {
  const connection = validateConnection({
    name: "device",
    kind: "http",
    url: "https://api.test",
    auth: "device-code",
    authorization_url: "https://login.test/auth",
    device_authorization_url: "https://login.test/device",
    token_url: "https://login.test/token",
    client_id: "public",
  });
  const shown: string[] = [];
  let requestNumber = 0;
  const request = (async () => {
    requestNumber++;
    if (requestNumber === 1)
      return new Response(
        JSON.stringify({
          device_code: "device-secret",
          user_code: "ABCD",
          verification_uri: "https://login.test/activate",
          interval: 0,
        }),
        { status: 200 },
      );
    return new Response(
      JSON.stringify({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        expires_in: 3600,
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const stored = await runGenericOAuth(
    connection,
    { show: (message) => shown.push(message), prompt: async () => "" },
    request,
  );
  assert.equal(oauthAccess(stored), "access-secret");
  assert.match(shown[0]!, /ABCD/);
  assert.doesNotMatch(
    shown.join(""),
    /access-secret|refresh-secret|device-secret/,
  );
});

test("[CONNECTION-0FB2F92A] OAuth credential serialization yields only the current access value to trusted gateway code", () => {
  const raw = JSON.stringify({
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: Date.now() + 1000,
  });
  assert.equal(oauthAccess(raw), "access");
  assert.equal(oauthAccess("not-json"), undefined);
});

test("[CONNECTION-6D2A9F84] generic OAuth prints its URL and completes from a pasted redirect without a browser", async () => {
  const connection = validateConnection({
    name: "headless",
    kind: "http",
    url: "https://api.test",
    auth: "oauth",
    authorization_url: "https://login.test/authorize",
    token_url: "https://login.test/token",
    client_id: "public",
  });
  const shown: string[] = [];
  let callbackClosed = false;
  const request = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.body instanceof URLSearchParams);
    const form = init.body;
    assert.equal(form.get("code"), "redirect-code");
    return new Response(
      JSON.stringify({ access_token: "headless-access", expires_in: 3600 }),
      { status: 200 },
    );
  }) as typeof fetch;
  const stored = await runGenericOAuth(
    connection,
    {
      show: (message) => shown.push(message),
      prompt: async (message) => {
        assert.match(
          message,
          /Paste the authorization code or full redirect URL/,
        );
        const authorization = new URL(shown[0]!.split("\n").at(-1)!);
        assert.equal(authorization.origin, "https://login.test");
        return `https://remote-browser.test/callback?code=redirect-code&state=${authorization.searchParams.get("state")}`;
      },
    },
    request,
    async () => ({
      redirect: "http://127.0.0.1:7654/callback",
      code: new Promise<string>(() => undefined),
      close: async () => {
        callbackClosed = true;
      },
    }),
  );
  assert.equal(oauthAccess(stored), "headless-access");
  assert.match(shown[0]!, /https:\/\/login\.test\/authorize/);
  assert.equal(callbackClosed, true);

  assert.equal(
    authorizationCodeFromInput(" pasted-code ", "expected"),
    "pasted-code",
  );
  assert.equal(
    authorizationCodeFromInput(
      "http://127.0.0.1/callback?code=url-code&state=expected",
      "expected",
    ),
    "url-code",
  );
  assert.throws(
    () =>
      authorizationCodeFromInput(
        "http://127.0.0.1/callback?code=url-code&state=wrong",
        "expected",
      ),
    /state mismatch/,
  );
});
