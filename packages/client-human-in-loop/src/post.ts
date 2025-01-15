import { Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateText,
    getEmbeddingZeroVector,
    IAgentRuntime,
    ModelClass,
    stringToUuid,
    UUID,
} from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { ClientBase } from "./base.ts";
import { postActionResponseFooter } from "@elizaos/core";
import { generateTweetActions } from "@elizaos/core";
import { IImageDescriptionService, ServiceType } from "@elizaos/core";
import { buildConversationThread } from "./utils.ts";
import { twitterMessageHandlerTemplate } from "./interactions.ts";
import { DEFAULT_MAX_TWEET_LENGTH } from "./environment.ts";

// telegram imports
import { Context, Telegraf } from "telegraf";
import { MessageManager } from "./messageManager.ts";
import { message } from "telegraf/filters";
import * as fs from 'fs';
import * as path from 'path';

const twitterPostTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should be 1, 2, or 3 sentences (choose the length at random).
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than {{maxTweetLength}}. No emojis. Use \\n\\n (double spaces) between statements if there are multiple statements in your response.
Your response must be about the following text:
{{fileContent}}`;

interface PendingTweet {
    cleanedContent: string;
    roomId: UUID;
    newTweetContent: string;
    twitterUsername: string;
    timestamp: number;
}

/**
 * Truncate text to fit within the Twitter character limit, ensuring it ends at a complete sentence.
 */
function truncateToCompleteSentence(
    text: string,
    maxTweetLength: number
): string {
    if (text.length <= maxTweetLength) {
        return text;
    }

    // Attempt to truncate at the last period within the limit
    const lastPeriodIndex = text.lastIndexOf(".", maxTweetLength - 1);
    if (lastPeriodIndex !== -1) {
        const truncatedAtPeriod = text.slice(0, lastPeriodIndex + 1).trim();
        if (truncatedAtPeriod.length > 0) {
            return truncatedAtPeriod;
        }
    }

    // If no period, truncate to the nearest whitespace within the limit
    const lastSpaceIndex = text.lastIndexOf(" ", maxTweetLength - 1);
    if (lastSpaceIndex !== -1) {
        const truncatedAtSpace = text.slice(0, lastSpaceIndex).trim();
        if (truncatedAtSpace.length > 0) {
            return truncatedAtSpace + "...";
        }
    }

    // Fallback: Hard truncate and add ellipsis
    const hardTruncated = text.slice(0, maxTweetLength - 3).trim();
    return hardTruncated + "...";
}

export class TwitterPostClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    twitterUsername: string;
    private isProcessing: boolean = false;
    private lastProcessTime: number = 0;
    private stopProcessingActions: boolean = false;
    private isDryRun: boolean;
    // telegram
    private bot: Telegraf<Context>;
    private messageManager: MessageManager;

    constructor(client: ClientBase, runtime: IAgentRuntime, botToken: string) {
        this.client = client;
        this.runtime = runtime;
        this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
        this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;

        // Log configuration on initialization
        elizaLogger.log("Twitter Client Configuration:");
        elizaLogger.log(`- Username: ${this.twitterUsername}`);
        elizaLogger.log(`- Dry Run Mode: ${this.isDryRun ? "enabled" : "disabled"}`);
        elizaLogger.log(
            `- Post Interval: ${this.client.twitterConfig.POST_INTERVAL_MIN}-${this.client.twitterConfig.POST_INTERVAL_MAX} minutes`
        );
        elizaLogger.log(
            `- Action Processing: ${this.client.twitterConfig.ENABLE_ACTION_PROCESSING ? "enabled" : "disabled"}`
        );
        elizaLogger.log(
            `- Action Interval: ${this.client.twitterConfig.ACTION_INTERVAL} minutes`
        );
        elizaLogger.log(
            `- Post Immediately: ${this.client.twitterConfig.POST_IMMEDIATELY ? "enabled" : "disabled"}`
        );
        elizaLogger.log(
            `- Search Enabled: ${this.client.twitterConfig.TWITTER_SEARCH_ENABLE ? "enabled" : "disabled"}`
        );

        const targetUsers = this.client.twitterConfig.TWITTER_TARGET_USERS;
        if (targetUsers) {
            elizaLogger.log(`- Target Users: ${targetUsers}`);
        }

        if (this.isDryRun) {
            elizaLogger.log(
                "Twitter client initialized in dry run mode - no actual tweets should be posted"
            );
        }

        // telegram setup
        this.bot = new Telegraf(botToken);
        this.messageManager = new MessageManager(this.bot, this.runtime);
    }

    async start() {
        if (!this.client.profile) {
            await this.client.init();
        }

        await this.initializeBot();
        this.setupMessageHandlers();
        this.setupShutdownHandlers();
    }

    private async initializeBot(): Promise<void> {
        this.bot.launch({ dropPendingUpdates: true });
        elizaLogger.log("✨ Telegram bot successfully launched and is running!");

        const botInfo = await this.bot.telegram.getMe();
        this.bot.botInfo = botInfo;
        elizaLogger.success(`Bot username: @${botInfo.username}`);

        this.messageManager.bot = this.bot;
    }

    private setupMessageHandlers(): void {
        elizaLogger.log("Setting up message handler...");

        this.bot.on(message("new_chat_members"), async (ctx) => {
            try {
                const newMembers = ctx.message.new_chat_members;
                const isBotAdded = newMembers.some(
                    (member) => member.id === ctx.botInfo.id
                );

                if (isBotAdded && !(await this.isGroupAuthorized(ctx))) {
                    return;
                }
            } catch (error) {
                elizaLogger.error("Error handling new chat members:", error);
            }
        });

        this.bot.on("message", async (ctx) => {
            try {
                // Check group authorization first
                if (!(await this.isGroupAuthorized(ctx))) {
                    return;
                }

                if ('document' in ctx.message && ctx.message.document?.file_name) {
                    elizaLogger.log('📎 Received document message:', ctx.message.document.file_name);

                    try {
                        const fileName = ctx.message.document.file_name.toLowerCase();

                        if (!fileName.endsWith('.txt')) {
                            await ctx.reply('Sorry, I can only process TXT files.');
                            return;
                        }

                        const file = await ctx.telegram.getFile(ctx.message.document.file_id);
                        const filePath = file.file_path;
                        if (!filePath) {
                            throw new Error('Could not get file path');
                        }

                        const botToken = this.runtime.getSetting("TELEGRAM_BOT_TOKEN");
                        const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
                        const response = await fetch(fileUrl);

                        if (!response.ok) {
                            throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
                        }

                        const buffer = Buffer.from(await response.arrayBuffer());
                        const fileContent = buffer.toString('utf-8');

                        if (!fileContent.trim()) {
                            await ctx.reply('The file appears to be empty.');
                            return;
                        }

                        elizaLogger.log('📄 Successfully extracted text from file', fileContent);
                        // Now fileContent contains the text from the TXT file
                        // You can process it further here

                        await this.generateTweetsForApproval(ctx, 1, fileContent);

                    } catch (error) {
                        elizaLogger.error('❌ Error processing file:', error);
                        await ctx.reply('Sorry, I encountered an error while processing your file.');
                        return;
                    }
                } else {

                    //const numberOfTweetsRequested = await generateText({
                    //    runtime: this.runtime,
                    //    prompt: "how many tweets does this message request",
                    //    modelClass: ModelClass.SMALL,
                    //});

                    const messageText = "text" in ctx.message ? ctx.message.text : "caption" in ctx.message ? (ctx.message as any).caption : "";
                    const numberOfTweetsRequested = Number(messageText);

                    elizaLogger.log(`Working on ${messageText} tweets...`);

                    if (!isNaN(numberOfTweetsRequested) && numberOfTweetsRequested > 0) {
                        await this.generateTweetsForApproval(ctx, numberOfTweetsRequested);
                    }
                }
            } catch (error) {
                elizaLogger.error("❌ Error handling message:", error);
                if (error?.response?.error_code !== 403) {
                    try {
                        await ctx.reply(
                            "An error occurred while processing your message."
                        );
                    } catch (replyError) {
                        elizaLogger.error(
                            "Failed to send error message:",
                            replyError
                        );
                    }
                }
            }
        });

        //this.bot.on("document", async (ctx) => {
        //    elizaLogger.log(
        //        "📎 Received document message:",
        //        ctx.message.document.file_name
        //    );
        //});

        this.bot.catch((err, ctx) => {
            elizaLogger.error(`❌ Telegram Error for ${ctx.updateType}:`, err);
            ctx.reply("An unexpected error occurred. Please try again later.");
        });
    }

    private setupShutdownHandlers(): void {
        const shutdownHandler = async (signal: string) => {
            elizaLogger.log(
                `⚠️ Received ${signal}. Shutting down Telegram bot gracefully...`
            );
            try {
                await this.stop();
                elizaLogger.log("🛑 Telegram bot stopped gracefully");
            } catch (error) {
                elizaLogger.error(
                    "❌ Error during Telegram bot shutdown:",
                    error
                );
                throw error;
            }
        };

        process.once("SIGINT", () => shutdownHandler("SIGINT"));
        process.once("SIGTERM", () => shutdownHandler("SIGTERM"));
        process.once("SIGHUP", () => shutdownHandler("SIGHUP"));
    }

    private async isGroupAuthorized(ctx: Context): Promise<boolean> {
        const config = this.runtime.character.clientConfig?.telegram;
        if (ctx.from?.id === ctx.botInfo?.id) {
            return false;
        }

        if (!config?.shouldOnlyJoinInAllowedGroups) {
            return true;
        }

        const allowedGroups = config.allowedGroupIds || [];
        const currentGroupId = ctx.chat.id.toString();

        if (!allowedGroups.includes(currentGroupId)) {
            elizaLogger.info(`Unauthorized group detected: ${currentGroupId}`);
            try {
                await ctx.reply("Not authorized. Leaving.");
                await ctx.leaveChat();
            } catch (error) {
                elizaLogger.error(
                    `Error leaving unauthorized group ${currentGroupId}:`,
                    error
                );
            }
            return false;
        }

        return true;
    }

    async removePostedTweetFromQueue(
        client: ClientBase,
        postedTweet: PendingTweet
    ) {
        const cacheKey = `twitter/${client.profile.username}/tweetQueue`;
        const tweetQueue = await this.runtime.cacheManager.get<PendingTweet[]>(cacheKey) || [];

        // Remove the posted tweet from the queue
        const updatedQueue = tweetQueue.filter(tweet =>
            tweet.timestamp !== postedTweet.timestamp ||
            tweet.newTweetContent !== postedTweet.newTweetContent
        );

        // Update the cache with the filtered queue
        await this.runtime.cacheManager.set(cacheKey, updatedQueue);

        elizaLogger.log(`Removed posted tweet from queue. Remaining tweets: ${updatedQueue.length}`);
    }

    async sendStandardTweet(
        client: ClientBase,
        content: string,
        tweetId?: string
    ) {
        try {
            const standardTweetResult = await client.requestQueue.add(
                async () =>
                    await client.twitterClient.sendTweet(content, tweetId)
            );
            const body = await standardTweetResult.json();
            if (!body?.data?.create_tweet?.tweet_results?.result) {
                console.error("Error sending tweet; Bad response:", body);
                return;
            }
            return body.data.create_tweet.tweet_results.result;
        } catch (error) {
            elizaLogger.error("Error sending standard Tweet:", error);
            throw error;
        }
    }

    async postTweet(
        ctx: Context,
        runtime: IAgentRuntime,
        client: ClientBase,
        cleanedContent: string,
        roomId: UUID,
        newTweetContent: string,
        twitterUsername: string
    ) {
        try {
            elizaLogger.log(`Posting new tweet:\n`);

            const result = await this.messageManager.handleMessage(ctx, cleanedContent);

            const cacheKey = `twitter/${client.profile.username}/tweetQueue`;
            let tweetQueue = await runtime.cacheManager.get<PendingTweet[]>(cacheKey);

            elizaLogger.log(`Saving tweet to queue:\n ${tweetQueue}`);

            const newPendingTweet = {
                cleanedContent,
                newTweetContent,
                roomId,
                twitterUsername,
                timestamp: Date.now(),
            };

            if (!tweetQueue) {
                await runtime.cacheManager.set(
                    cacheKey,
                    [newPendingTweet]
                )
            } else {
                await runtime.cacheManager.set(
                    cacheKey,
                    [...tweetQueue, newPendingTweet]
                )
            }

            await runtime.messageManager.createMemory({
                id: result.id,
                userId: runtime.agentId,
                agentId: runtime.agentId,
                content: {
                    text: cleanedContent,
                    source: "telegram",
                },
                roomId,
                embedding: getEmbeddingZeroVector(),
                createdAt: Date.now(),
            });
        } catch (error) {
            elizaLogger.error("Error sending tweet:", error);
        }
    }

    /**
     * Generates a new tweet content. If isDryRun is true, only logs what would have been generated.
     * @returns The generated and cleaned tweet content, or undefined if generation fails
     */
    private async generateNewTweet(optionalFileContext?: string) {
        elizaLogger.log("Generating new tweet");

        try {
            const roomId = stringToUuid(
                "twitter_generate_room-" + this.client.profile.username
            );
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.client.profile.username,
                this.runtime.character.name,
                "twitter"
            );

            const topics = this.runtime.character.topics.join(", ");

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: topics || "",
                        action: "TWEET",
                    },
                },
                {
                    twitterUserName: this.client.profile.username,
                    fileContent: optionalFileContext,
                }
            );

            const context = composeContext({
                state,
                template: twitterPostTemplate //this.runtime.character.templates?.twitterPostTemplate || twitterPostTemplate,
            });

            elizaLogger.log("generate post prompt:\n" + context);

            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            // First attempt to clean content
            let cleanedContent = "";

            // Try parsing as JSON first
            try {
                const parsedResponse = JSON.parse(newTweetContent);
                if (parsedResponse.text) {
                    cleanedContent = parsedResponse.text;
                } else if (typeof parsedResponse === "string") {
                    cleanedContent = parsedResponse;
                }
            } catch (error) {
                error.linted = true; // make linter happy since catch needs a variable
                // If not JSON, clean the raw content
                cleanedContent = newTweetContent
                    .replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "") // Remove JSON-like wrapper
                    .replace(/^['"](.*)['"]$/g, "$1") // Remove quotes
                    .replace(/\\"/g, '"') // Unescape quotes
                    .replace(/\\n/g, "\n\n") // Unescape newlines, ensures double spaces
                    .trim();
            }

            if (!cleanedContent) {
                elizaLogger.error(
                    "Failed to extract valid content from response:",
                    {
                        rawResponse: newTweetContent,
                        attempted: "JSON parsing",
                    }
                );
                return;
            }

            // Truncate the content to the maximum tweet length specified in the environment settings, ensuring the truncation respects sentence boundaries.
            const maxTweetLength = this.client.twitterConfig.MAX_TWEET_LENGTH
            if (maxTweetLength) {
                cleanedContent = truncateToCompleteSentence(
                    cleanedContent,
                    maxTweetLength
                );
            }

            const removeQuotes = (str: string) =>
                str.replace(/^['"](.*)['"]$/, "$1");

            const fixNewLines = (str: string) => str.replaceAll(/\\n/g, "\n\n"); //ensures double spaces

            // Final cleaning
            cleanedContent = removeQuotes(fixNewLines(cleanedContent));
            elizaLogger.log(`Generated tweet:\n ${cleanedContent}`);

            if (this.isDryRun) {
                elizaLogger.info(
                    `Dry run: would have posted tweet: ${cleanedContent}`
                );

                return {
                    cleanedContent: cleanedContent,
                    newTweetContent: newTweetContent,
                };
            }

            return {
                cleanedContent: cleanedContent,
                newTweetContent: newTweetContent,
            };
        } catch (error) {
            elizaLogger.error("Error generating new tweet:", error);
            return undefined;
        }
    }

    private async generateTweetsForApproval(ctx: Context, numberOfTweets: number, optionalFileContext?: string) {
        let tweetsGenerated = 0;

        while (tweetsGenerated < numberOfTweets) {
            const {cleanedContent, newTweetContent} = await this.generateNewTweet(optionalFileContext);
            elizaLogger.log(`Generated tweet for approval:\n ${cleanedContent}`);

            if (cleanedContent) {
                await this.postTweet(
                    ctx,
                    this.runtime,
                    this.client,
                    cleanedContent,
                    stringToUuid("twitter_generate_room-" + this.client.profile.username),
                    newTweetContent,
                    this.twitterUsername
                );

                tweetsGenerated++;
                elizaLogger.log(`Generated tweet ${tweetsGenerated} of ${numberOfTweets} for approval`);
            }
        }
        elizaLogger.log(`Completed generating ${numberOfTweets} tweets for approval`);
    }

    private async scheduleTweetsPosting(numberOfTweets: number) {
        let tweetsPosted = 0;

        const postNextTweet = async () => {
            if (tweetsPosted >= numberOfTweets) {
                elizaLogger.log(`Completed posting ${numberOfTweets} tweets`);
                return;
            }

            const lastPost = await this.runtime.cacheManager.get<{
                timestamp: number;
            }>("twitter/" + this.twitterUsername + "/lastPost");

            const lastPostTimestamp = lastPost?.timestamp ?? 0;
            const minMinutes = this.client.twitterConfig.POST_INTERVAL_MIN;
            const maxMinutes = this.client.twitterConfig.POST_INTERVAL_MAX;
            const randomMinutes =
                Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
                minMinutes;
            const delay = randomMinutes * 60 * 1000;

            if (Date.now() > lastPostTimestamp + delay) {
                // Here you would implement the actual posting of the approved tweet
                //await this.postTweet(
                //    this.runtime,
                //    this.client,
                //    cleanedContent,
                //    stringToUuid("twitter_generate_room-" + this.client.profile.username),
                //    newTweetContent,
                //    this.twitterUsername
                //);

                tweetsPosted++;
                elizaLogger.log(`Posted tweet ${tweetsPosted} of ${numberOfTweets}`);
            }

            if (tweetsPosted < numberOfTweets) {
                setTimeout(() => {
                    postNextTweet();
                }, delay);
                elizaLogger.log(`Next tweet (${tweetsPosted + 1}/${numberOfTweets}) scheduled in ${randomMinutes} minutes`);
            }
        };

        postNextTweet();
    }

    async stop() {
        this.stopProcessingActions = true;
    }
}
