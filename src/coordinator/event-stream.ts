import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface ClientEvent {
  sequence: number;
  type: string;
  data: unknown;
}

export class ClientEventStream {
  readonly events = new EventEmitter();
  readonly attachments = new Set<string>();
  private currentSequence = 0;

  get sequence(): number {
    return this.currentSequence;
  }

  get attached(): number {
    return this.attachments.size;
  }

  broadcast(type: string, data: unknown): ClientEvent {
    const event = { sequence: ++this.currentSequence, type, data };
    this.events.emit("event", event);
    return event;
  }

  attach(
    request: IncomingMessage,
    response: ServerResponse,
    snapshot: () => unknown,
  ): void {
    const attachmentId = randomUUID();
    this.attachments.add(attachmentId);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-integral-attachment-id": attachmentId,
    });
    this.broadcast("chat.attached", { attached: this.attached });
    response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    const listener = (event: ClientEvent) =>
      response.write(
        `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
      );
    this.events.on("event", listener);
    request.once("close", () => {
      this.events.off("event", listener);
      this.attachments.delete(attachmentId);
      this.broadcast("chat.detached", { attached: this.attached });
    });
  }

  clear(): void {
    this.attachments.clear();
  }
}
