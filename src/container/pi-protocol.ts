export type PiProtocolEvent = Record<string, unknown>;

export type PiProtocolResult =
  | { type: "text"; text: string }
  | { type: "complete" }
  | { type: "rejected"; error: string }
  | { type: "ignored" };

export function interpretPiProtocol(line: string): PiProtocolResult {
  let event: PiProtocolEvent;
  try {
    event = JSON.parse(line) as PiProtocolEvent;
  } catch {
    return { type: "ignored" };
  }
  return interpretPiEvent(event);
}

export function interpretPiEvent(event: PiProtocolEvent): PiProtocolResult {
  if (
    event.type === "response" &&
    event.command === "prompt" &&
    event.success === false
  )
    return {
      type: "rejected",
      error:
        typeof event.error === "string"
          ? `Pi rejected prompt: ${event.error}`
          : "Pi rejected prompt",
    };
  if (event.type === "message_update") {
    const delta = event.assistantMessageEvent as
      Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.delta === "string")
      return { type: "text", text: delta.delta };
  }
  return event.type === "agent_end" && event.willRetry !== true
    ? { type: "complete" }
    : { type: "ignored" };
}
