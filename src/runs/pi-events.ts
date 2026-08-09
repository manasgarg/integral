import type { PiProtocolEvent } from "../container/pi-protocol.ts";

export function isToolEvent(type: string): boolean {
  return /tool.*(?:start|end|result|execution)|(?:start|end|result).*tool/i.test(
    type,
  );
}

export function toolEventType(type: string): string {
  if (/start/i.test(type)) return "tool-start";
  if (/end|result/i.test(type)) return "tool-result";
  return "tool-event";
}

export function toolIdentity(event: PiProtocolEvent): string | undefined {
  for (const key of ["toolCallId", "tool_call_id", "callId", "id"]) {
    const value = event[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function isFailureEvent(event: PiProtocolEvent): boolean {
  return (
    event.success === false ||
    typeof event.error === "string" ||
    (typeof event.type === "string" &&
      /error|fail|reject|timeout/i.test(event.type))
  );
}
