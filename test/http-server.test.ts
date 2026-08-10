import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { IntegralError } from "../src/errors.ts";
import { readJsonObject, readRequestBody } from "../src/http-server.ts";

function request(
  chunks: Array<string | Buffer>,
  contentLength?: number,
): import("node:http").IncomingMessage {
  const value = Readable.from(
    chunks,
  ) as unknown as import("node:http").IncomingMessage;
  value.headers =
    contentLength === undefined
      ? {}
      : { "content-length": String(contentLength) };
  return value;
}

async function rejectsWithStatus(
  action: Promise<unknown>,
  status: number,
): Promise<void> {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof IntegralError);
    assert.equal(error.exitCode, status);
    assert.doesNotMatch(error.message, /secret-body-value/);
    return true;
  });
}

/* @covers SERVER-A3D17B0F
Given an Integral component endpoint accepts a JSON object
	When a request body exceeds that route's explicit byte limit
		Then the component rejects it with HTTP 413
			And does not invoke the route mutation
			And does not retain or parse the oversized body
*/
test("[SERVER-A3D17B0F] JSON ingress rejects declared and streamed oversize bodies before parsing", async () => {
  await rejectsWithStatus(readRequestBody(request([], 101), 100), 413);
  await rejectsWithStatus(
    readRequestBody(request([Buffer.alloc(60), Buffer.alloc(41)]), 100),
    413,
  );
});

/* @covers SERVER-A3D17B0F
Given an Integral component endpoint accepts a JSON object
	When a non-empty body is malformed JSON, a scalar, or an array
		Then the component rejects it with HTTP 400
			And does not invoke the route mutation
			And does not echo the body in the response or diagnostics
	When the route permits an empty request object and the body is empty
		Then the component interprets it as an empty object
			And applies the route's ordinary field validation
*/
test("[SERVER-A3D17B0F] JSON ingress accepts empty objects and rejects malformed or non-object values without echoing input", async () => {
  assert.deepEqual(await readJsonObject(request([])), {});
  assert.deepEqual(await readJsonObject(request(['{"ok":true}'])), {
    ok: true,
  });
  for (const body of ["secret-body-value{", "[]", '"scalar"', "null"])
    await rejectsWithStatus(readJsonObject(request([body])), 400);
});
