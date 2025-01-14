import { Message } from "@telegraf/types";
import { Context, Telegraf } from "telegraf";
import { IAgentRuntime, elizaLogger, UUID, Content } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";

interface MessageContext {
    content: string;
    timestamp: number;
}

export type InterestChats = {
    [key: string]: {
        currentHandler: string | undefined;
        lastMessageSent: number;
        messages: { userId: UUID; userName: string; content: Content }[];
        previousContext?: MessageContext;
        contextSimilarityThreshold?: number;
    };
};

export class MessageManager {
    public bot: Telegraf<Context>;
    private runtime: IAgentRuntime;
    private teamMemberUsernames: Map<string, string> = new Map();
    private interestChats: InterestChats = {};

    constructor(bot: Telegraf<Context>, runtime: IAgentRuntime) {
        this.bot = bot;
        this.runtime = runtime;

        this._initializeTeamMemberUsernames().catch((error) =>
            elizaLogger.error(
                "Error initializing team member usernames:",
                error
            )
        );
    }

    private async _initializeTeamMemberUsernames(): Promise<void> {
        if (!this.runtime.character.clientConfig?.telegram?.isPartOfTeam)
            return;

        const teamAgentIds = this.runtime.character.clientConfig.telegram.teamAgentIds || [];

        for (const id of teamAgentIds) {
            try {
                const chat = await this.bot.telegram.getChat(id);
                if ("username" in chat && chat.username) {
                    this.teamMemberUsernames.set(id, chat.username);
                    elizaLogger.info(
                        `Cached username for team member ${id}: ${chat.username}`
                    );
                }
            } catch (error) {
                elizaLogger.error(
                    `Error getting username for team member ${id}:`,
                    error
                );
            }
        }
    }

    private splitMessage(text: string): string[] {
        const chunks: string[] = [];
        let currentChunk = "";

        const lines = text.split("\n");
        for (const line of lines) {
            if (currentChunk.length + line.length + 1 <= 4096) {
                currentChunk += (currentChunk ? "\n" : "") + line;
            } else {
                if (currentChunk) chunks.push(currentChunk);
                currentChunk = line;
            }
        }

        if (currentChunk) chunks.push(currentChunk);
        return chunks;
    }

    // Send long messages in chunks
    private async sendMessageInChunks(
        ctx: Context,
        content: Content,
        replyToMessageId?: number
    ): Promise<Message.TextMessage[]> {

        const chunks = this.splitMessage(content.text);
        const sentMessages: Message.TextMessage[] = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = escapeMarkdown(chunks[i]);
            const sentMessage = (await ctx.telegram.sendMessage(
                ctx.chat.id,
                chunk,
                {
                    reply_parameters:
                        i === 0 && replyToMessageId
                            ? { message_id: replyToMessageId }
                            : undefined,
                    parse_mode: "Markdown",
                }
            )) as Message.TextMessage;

            sentMessages.push(sentMessage);
        }

        return sentMessages;
    }

    private extractTweetCount(text: string): number | undefined {
        // Match patterns like "generate 5 tweets" or "5 tweets"
        const match = text.toLowerCase().match(/(\d+)\s*tweets?/);
        return match ? parseInt(match[1]) : undefined;
    }

    // Main handler for incoming messages
    public async handleMessage(ctx: Context, content: string): Promise<{ id: UUID }> {
        if (!ctx.message || !ctx.from || !content) {
            return { id: undefined as unknown as UUID }; // Exit if no message or sender info
        }

        if (
            this.runtime.character.clientConfig?.telegram
                ?.shouldIgnoreBotMessages &&
            ctx.from.is_bot
        ) {
            return { id: undefined as unknown as UUID };
        }
        if (
            this.runtime.character.clientConfig?.telegram
                ?.shouldIgnoreDirectMessages &&
            ctx.chat?.type === "private"
        ) {
            return { id: undefined as unknown as UUID };
        }

        const message = ctx.message;
        const chatId = ctx.chat?.id.toString();
        const messageText = content;

        // Add team handling at the start
        if (
            this.runtime.character.clientConfig?.telegram?.isPartOfTeam &&
            !this.runtime.character.clientConfig?.telegram
                ?.shouldRespondOnlyToMentions
        ) {
            // Non-leader team member showing interest based on keywords
            this.interestChats[chatId] = {
                currentHandler: this.bot.botInfo?.id.toString(),
                lastMessageSent: Date.now(),
                messages: [],
            };

            // Update message tracking
            if (this.interestChats[chatId]) {
                this.interestChats[chatId].messages.push({
                    userId: stringToUuid(ctx.from.id.toString()),
                    userName:
                        ctx.from.username ||
                        ctx.from.first_name ||
                        "Unknown User",
                    content: { text: messageText, source: "telegram" },
                });
            }
        }

        try {
            // Convert IDs to UUIDs
            const userId = stringToUuid(ctx.from.id.toString()) as UUID;

            // Get user name
            const userName = ctx.from.username || ctx.from.first_name || "Unknown User";

            // Get chat ID
            const chatId = stringToUuid(
                ctx.chat?.id.toString() + "-" + this.runtime.agentId
            ) as UUID;

            // Get room ID
            const roomId = chatId;

            // Ensure connection
            await this.runtime.ensureConnection(
                userId,
                roomId,
                userName,
                userName,
                "telegram"
            );

            // Create content
            const fullContent: Content = {
                text: content,
                source: "telegram",
                inReplyTo:
                    "reply_to_message" in message && message.reply_to_message
                        ? stringToUuid(
                              message.reply_to_message.message_id.toString() +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
            };

            // Send response in chunks
            const sentMessages = await this.sendMessageInChunks(
                ctx,
                fullContent,
                message.message_id
            );

            console.log(sentMessages)

            return {
                id: stringToUuid(message.message_id.toString() + "-" + this.runtime.agentId),
            }
        } catch (error) {
            elizaLogger.error("❌ Error handling message:", error);
            elizaLogger.error("Error sending message:", error);
            return { id: undefined as unknown as UUID };
        }
    }
}

function escapeMarkdown(text: string): string {
    // Don't escape if it's a code block
    if (text.startsWith('```') && text.endsWith('```')) {
        return text;
    }

    // Split the text by code blocks
    const parts = text.split(/(```[\s\S]*?```)/g);

    return parts.map((part, index) => {
        // If it's a code block (odd indices in the split result will be code blocks)
        if (index % 2 === 1) {
            return part;
        }
        // For regular text, only escape characters that need escaping in Markdown
        return part
            // First preserve any intended inline code spans
            .replace(/`.*?`/g, match => match)
            // Then only escape the minimal set of special characters that need escaping in Markdown mode
            .replace(/([*_`\\])/g, '\\$1');
    }).join('');
}
