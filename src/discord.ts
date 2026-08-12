import {
  Client,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  Partials,
  SlashCommandBuilder,
  type DMChannel,
  type Message,
} from "discord.js";
import type { Connection } from "./connections.ts";
import { IntegralError } from "./errors.ts";
import { atomicWrite, readText } from "./fs.ts";

export interface DiscordMessage {
  id: string;
  text: string;
  userId: string;
  channelId: string;
  createdAt: string;
}

interface DiscordIngressState {
  lastMessageId?: string;
  accepted: string[];
}

export class DiscordIngressStore {
  private state: DiscordIngressState = { accepted: [] };
  constructor(private readonly file: string) {}
  async load(): Promise<void> {
    const raw = await readText(this.file);
    if (!raw) return;
    const parsed = JSON.parse(raw) as DiscordIngressState;
    if (!Array.isArray(parsed.accepted))
      throw new IntegralError("invalid Discord ingress state");
    this.state = parsed;
  }
  has(messageId: string): boolean {
    return this.state.accepted.includes(messageId);
  }
  position(): string | undefined {
    return this.state.lastMessageId;
  }
  async record(messageId: string): Promise<void> {
    if (this.has(messageId)) return;
    this.state.accepted.push(messageId);
    this.state.accepted = this.state.accepted.slice(-2_000);
    if (
      !this.state.lastMessageId ||
      BigInt(messageId) > BigInt(this.state.lastMessageId)
    )
      this.state.lastMessageId = messageId;
    await atomicWrite(this.file, `${JSON.stringify(this.state)}\n`);
  }
}

export function discordChunks(text: string, limit = 2_000): string[] {
  if (!text) return [];
  const result: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let end = rest.lastIndexOf("\n", limit);
    if (end < Math.floor(limit / 2)) end = rest.lastIndexOf(" ", limit);
    if (end < 1) end = limit;
    if (/^[\uDC00-\uDFFF]$/.test(rest[end]!)) end--;
    result.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\n/, "");
  }
  if (rest) result.push(rest);
  return result;
}

export interface DiscordListenerCallbacks {
  recoveryPosition(): string | undefined;
  accept(message: DiscordMessage): Promise<boolean>;
  unsupported(message: DiscordMessage): Promise<void>;
  command(
    name: string,
    subcommand: string | undefined,
    options: Record<string, string>,
  ): Promise<string>;
  failure(error: Error): void;
}

export interface DiscordListener {
  start(): Promise<void>;
  stop(): Promise<void>;
  reply(text: string): Promise<void>;
  typing(active: boolean): Promise<void>;
}

function normalized(message: Message): DiscordMessage {
  return {
    id: message.id,
    text: message.content,
    userId: message.author.id,
    channelId: message.channelId,
    createdAt: message.createdAt.toISOString(),
  };
}

export class DiscordJsListener implements DiscordListener {
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });
  private channel: DMChannel | undefined;
  private typingTimer: NodeJS.Timeout | undefined;
  private serial = Promise.resolve();
  constructor(
    private readonly connection: Connection,
    private readonly token: string,
    private readonly callbacks: DiscordListenerCallbacks,
  ) {
    if (
      connection.provider !== "discord" ||
      !connection.channelId ||
      !connection.userId
    )
      throw new IntegralError("Discord connection is incomplete");
  }
  async start(): Promise<void> {
    this.client.on("messageCreate", (message) => this.receive(message));
    this.client.on("interactionCreate", (interaction) => {
      if (
        !interaction.isChatInputCommand() ||
        interaction.channelId !== this.connection.channelId ||
        interaction.user.id !== this.connection.userId
      )
        return;
      void (async () => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          let subcommand: string | undefined;
          try {
            subcommand = interaction.options.getSubcommand(false) ?? undefined;
          } catch {
            subcommand = undefined;
          }
          const options: Record<string, string> = {};
          for (const option of interaction.options.data.flatMap(
            (value) => value.options ?? [value],
          ))
            if (typeof option.value === "string")
              options[option.name] = option.value;
          const chunks = discordChunks(
            await this.callbacks.command(
              interaction.commandName,
              subcommand,
              options,
            ),
          );
          await interaction.editReply(chunks.shift() ?? "Done.");
          for (const chunk of chunks)
            await interaction.followUp({
              content: chunk,
              flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
          await interaction.editReply(
            `Command failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
    });
    this.client.on("error", (error) => this.callbacks.failure(error));
    await this.client.login(this.token);
    const fetched = await this.client.channels.fetch(
      this.connection.channelId!,
    );
    if (!fetched?.isDMBased())
      throw new IntegralError("configured Discord channel is not a DM");
    this.channel = fetched as DMChannel;
    await this.registerCommands();
    await this.recover();
  }
  private async registerCommands(): Promise<void> {
    const direct = <
      T extends { setContexts(...contexts: InteractionContextType[]): T },
    >(
      builder: T,
    ) => builder.setContexts(InteractionContextType.BotDM);
    const commands = [
      direct(
        new SlashCommandBuilder()
          .setName("help")
          .setDescription("Show Discord commands"),
      ),
      direct(
        new SlashCommandBuilder()
          .setName("status")
          .setDescription("Show this conversation's status"),
      ),
      direct(
        new SlashCommandBuilder()
          .setName("model")
          .setDescription("Show or select this conversation's model")
          .addStringOption((option) =>
            option
              .setName("search")
              .setDescription("Terms used to find a model"),
          ),
      ),
      direct(
        new SlashCommandBuilder()
          .setName("queue")
          .setDescription("Manage this conversation's queue")
          .addSubcommand((command) =>
            command.setName("ls").setDescription("List queued messages"),
          )
          .addSubcommand((command) =>
            command
              .setName("edit")
              .setDescription("Edit a queued message")
              .addStringOption((option) =>
                option
                  .setName("id")
                  .setDescription("Queue message ID")
                  .setRequired(true),
              )
              .addStringOption((option) =>
                option
                  .setName("text")
                  .setDescription("Replacement text")
                  .setRequired(true),
              ),
          )
          .addSubcommand((command) =>
            command
              .setName("delete")
              .setDescription("Delete a queued message")
              .addStringOption((option) =>
                option
                  .setName("id")
                  .setDescription("Queue message ID")
                  .setRequired(true),
              ),
          ),
      ),
      direct(
        new SlashCommandBuilder()
          .setName("approvals")
          .setDescription("Inspect or decide this conversation's approvals")
          .addSubcommand((command) =>
            command.setName("ls").setDescription("List pending approvals"),
          )
          .addSubcommand((command) =>
            command
              .setName("show")
              .setDescription("Show an approval")
              .addStringOption((option) =>
                option
                  .setName("id")
                  .setDescription("Approval ID")
                  .setRequired(true),
              ),
          )
          .addSubcommand((command) =>
            command
              .setName("approve")
              .setDescription("Approve a request")
              .addStringOption((option) =>
                option
                  .setName("id")
                  .setDescription("Approval ID")
                  .setRequired(true),
              ),
          )
          .addSubcommand((command) =>
            command
              .setName("deny")
              .setDescription("Deny a request")
              .addStringOption((option) =>
                option
                  .setName("id")
                  .setDescription("Approval ID")
                  .setRequired(true),
              ),
          ),
      ),
    ];
    await this.client.application?.commands.set(
      commands.map((command) => command.toJSON()),
    );
  }
  private async recover(): Promise<void> {
    if (!this.channel) return;
    let after = this.callbacks.recoveryPosition(),
      hasMore = true;
    while (hasMore) {
      const messages = await this.channel.messages.fetch({
          limit: 100,
          ...(after ? { after } : {}),
        }),
        eligible = [...messages.values()]
          .filter(
            (message) =>
              message.author.id === this.connection.userId &&
              !message.author.bot,
          )
          .sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));
      for (const message of eligible) this.receive(message);
      await this.serial;
      const last = eligible.at(-1)?.id;
      hasMore = Boolean(last && last !== after && messages.size === 100);
      if (last) after = last;
    }
  }
  private receive(message: Message): void {
    if (
      message.channelId !== this.connection.channelId ||
      message.author.id !== this.connection.userId ||
      message.author.bot
    )
      return;
    const value = normalized(message);
    this.serial = this.serial
      .then(async () => {
        if (!value.text.trim()) await this.callbacks.unsupported(value);
        else await this.callbacks.accept(value);
      })
      .catch((error: unknown) =>
        this.callbacks.failure(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
  }
  async stop(): Promise<void> {
    if (this.typingTimer) clearInterval(this.typingTimer);
    await this.serial;
    await this.client.destroy();
  }
  async reply(text: string): Promise<void> {
    if (!this.channel) throw new IntegralError("Discord DM is unavailable");
    for (const chunk of discordChunks(text)) await this.channel.send(chunk);
  }
  async typing(active: boolean): Promise<void> {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = undefined;
    if (!active || !this.channel) return;
    await this.channel.sendTyping();
    this.typingTimer = setInterval(
      () => void this.channel?.sendTyping().catch(() => undefined),
      8_000,
    );
  }
}

export interface VerifiedDiscordConnection {
  applicationId: string;
  botUserId: string;
  userId: string;
  channelId: string;
}

export async function verifyDiscordBot(
  token: string,
  userId: string,
  fetcher: typeof fetch = fetch,
): Promise<VerifiedDiscordConnection> {
  const call = async (
    path: string,
    init?: RequestInit,
  ): Promise<Record<string, unknown>> => {
    const response = await fetcher(`https://discord.com/api/v10${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
        ...init?.headers,
      },
    });
    if (!response.ok)
      throw new IntegralError(
        `Discord verification failed (${response.status})`,
      );
    return (await response.json()) as Record<string, unknown>;
  };
  const [bot, application] = await Promise.all([
    call("/users/@me"),
    call("/oauth2/applications/@me"),
  ]);
  const dm = await call("/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: userId }),
  });
  for (const [label, value] of [
    ["bot user", bot.id],
    ["application", application.id],
    ["DM channel", dm.id],
  ] as Array<[string, unknown]>)
    if (typeof value !== "string")
      throw new IntegralError(`Discord did not return a ${label} ID`);
  return {
    applicationId: application.id as string,
    botUserId: bot.id as string,
    userId,
    channelId: dm.id as string,
  };
}
