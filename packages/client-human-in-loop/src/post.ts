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

// telegram imports
import { Context, Telegraf } from "telegraf";
import { MessageManager } from "./messageManager.ts";
import { message } from "telegraf/filters";

const twitterPostTemplateShortForm = `
You are {{agentName}}. ONLY speak in the following style:

Your personality:
{{bio}}
{{lore}}

POST ELEMENTS YOU MUST FOLLOW:

Emotional Impact Analysis:
1. Core emotion being triggered
2. Authenticity level
3. Controversy potential
4. Relatability factor

Engagement Amplifiers:
- Pattern interrupts
- Open loops
- Universal truths
- Contrarian takes
- Hot takes
- Storytelling hooks

Viral Elements Required:
1. First line hook
2. Unexpected twist
3. Memorable insight
4. Discussion starter
5. Share motivation

Voice & Style:
- Personal yet authoritative
- Bold yet authentic
- Casual yet profound
- Raw yet polished

Core Rules:
1. Must evoke strong emotion
2. Must provide unique insight
3. Must compel sharing
4. Must start conversations

Formatting Rules:
- Short, punchy sentences
- Strategic line breaks
- Power words
- No weak qualifiers
- End with punch

RESPONSE REQUIREMENTS:
1. MUST be under {{tweetLength}} characters
2. Focus on one clear thought
3. Never be racist, sexist, or homophobic
 

YOUR RESPONSE MUST BE CONSISTENT WITH THE TONE AND STYLE OF YOUR MEMORIES
{{characterPostExamples}}

YOU MUST FOLLOW ALL OF THESE WRITING RULES:
{{stylePost}}

Be a thought leader and craft a post that is as interesting, entertaining, and engaging as possible
The post must be a bit under {{tweetLength}} characters long and be about {{suggestedTopic}}.
Make sure the post follows the formatting and core rules.
Don't hold back, really be {{characterName}} to the max. Get people talking.
`;

const twitterPostTemplateLongForm = `
YOUR MISSION: Create a comprehensive long-form Twitter thread.

You are {{agentName}}. ONLY speak in the following style:

Your personality:
{{bio}}
{{lore}}

You must create a comprehensive long-form Twitter thread that is as interesting, entertaining, and engaging as possible. The thread must be a bit under {{tweetLength}} characters long and be about {{suggestedTopic}}.

Make sure the thread follows the formatting and core rules.

RESPONSE REQUIREMENTS:
1. MUST be under {{tweetLength}} characters
2. Focus on one clear thought
3. Never be racist, sexist, or homophobic
4. Do NOT use section headers or labels - write naturally
5. Never number points or steps

YOUR RESPONSE MUST BE CONSISTENT WITH THE TONE AND STYLE OF YOUR MEMORIES
{{characterPostExamples}}

YOU MUST FOLLOW ALL OF THESE WRITING RULES:
{{stylePost}}

Be a thought leader and craft a comprehensive long-form Twitter thread that is as interesting, entertaining, and engaging as possible.
The thread must be a bit under {{tweetLength}} characters long and be about {{suggestedTopic}}.
Make sure the thread follows the formatting and core rules.
Don't hold back, really be {{characterName}} to the max. Get people talking.
`;

const NUMBER_OF_TWEETS_TO_GENERATE = 3;

export class HumanPostClient {
    runtime: IAgentRuntime;
    private lastFiveTopics: string[] = [];

    // telegram
    private bot: Telegraf<Context>;
    private messageManager: MessageManager;

    constructor(runtime: IAgentRuntime, botToken: string) {
        this.runtime = runtime;
 
        // telegram setup
        this.bot = new Telegraf(botToken);
        this.messageManager = new MessageManager(this.bot, this.runtime);
    }

    private readonly themeAnalysisPrompt = `
        Analyze this interview I did:
        {{content}}

        Identify the top 5 themes or topics being discussed.
        Return only the themes, one per line.
    `;

    private readonly topicSelectionPrompt = `
        These themes are trending among my followers:
        {{themes}}

        My last five topics were:
        {{lastFiveTopics}}

        Select ONE topic that would be most engaging to tweet about.
        Consider:
        1. Current relevance
        2. Potential for engagement
        3. Alignment with my expertise
        4. Must be semantically different from last five topics
        5. Connection to {{characterName}}'s interests

        IMPORTANT: Return ONLY the selected topic as a single line, without any explanation.
        Example response: "DeFi innovation"
    `;

    async start() {
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
     
                        await this.generateTweetsForApproval(ctx, NUMBER_OF_TWEETS_TO_GENERATE, fileContent);

                    } catch (error) {
                        elizaLogger.error('❌ Error processing file:', error);
                        await ctx.reply('Sorry, I encountered an error while processing your file.');
                        return;
                    }
                } else {
                    elizaLogger.log(`no document in message`)
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

    async postTweet(
        ctx: Context,
        runtime: IAgentRuntime,
        cleanedContent: string,
        roomId: UUID,
    ) {
        try {
            elizaLogger.log(`Posting new tweet:\n`);

            const result = await this.messageManager.handleMessage(ctx, cleanedContent);

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

    private async analyzeInterviewDocument(content: string): Promise<string[]> {
        try {
            elizaLogger.info(`[ContentAnalyzer] Analyzing document for themes`);

            const context = this.themeAnalysisPrompt.replace(
                "{{content}}",
                content
            );

            elizaLogger.info("[ContentAnalyzer] Analyzing interview for themes");
            const response = await generateText({
                runtime: this.runtime,
                context,
                modelClass: "medium",
            });

            const themes = response
                .split("\n")
                .filter((theme) => theme.trim().length > 0);
            elizaLogger.info(
                `[ContentAnalyzer] Identified ${themes.length} themes. \n Themes: ${themes.join(
                    ", "
                )}`
            );
            return themes;
        } catch (error) {
            elizaLogger.error(
                "[ContentAnalyzer] Error analyzing document:",
                error
            );
            throw error;
        }
    }

    private async extractTopic(themes: string): Promise<string | null> {
        if (!this.runtime) {
            return null;
        }

        try {
            elizaLogger.info(
                "Current topic history:",
                this.lastFiveTopics
            );

            const lastTopics =
                this.lastFiveTopics.length > 0
                    ? this.lastFiveTopics.join("\n")
                    : "No previous topics";

            const context = this.topicSelectionPrompt
                .replace("{{themes}}", themes)
                .replace("{{lastFiveTopics}}", lastTopics)
                .replace(/{{characterName}}/g, this.runtime.character.name);

            elizaLogger.info("Selecting topic");
            const response = await generateText({
                runtime: this.runtime,
                context,
                modelClass: "medium",
            });

            // Extract just the topic, removing any explanation
            const selectedTopic = response.split("\n")[0].trim();

            elizaLogger.info(`Selected topic: "${selectedTopic}"`);
            elizaLogger.info("Previous topics:", this.lastFiveTopics);

            // Update lastFiveTopics and save to cache
            this.lastFiveTopics.push(selectedTopic);
            if (this.lastFiveTopics.length > 5) {
                this.lastFiveTopics.shift();
            }

            elizaLogger.info(
                "Updated topic history:",
                this.lastFiveTopics
            );
            return selectedTopic;
        } catch (error) {
            elizaLogger.error(
                "Error extracting topic:",
                error
            );
            return null;
        }
    }
   
    private async generateNewTweet(topic: string) {
        elizaLogger.log(`Generating tweet for topic: "${topic}"`);

        try {
            const roomId = stringToUuid(
                "twitter_generate_room-40IQ"
            );
            elizaLogger.info(`Room ID: ${roomId}`);

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: topic,
                        action: "",
                    },
                },
                {
                    suggestedTopic: topic,
                }
            );

            elizaLogger.info(`Composed state:\n${state}`);

            const allowedTweetLenghts = ["140", "250", "2000"];
            const randomTweetLength = Math.floor(Math.random() * allowedTweetLenghts.length);
            const twitterPostTemplate = allowedTweetLenghts[randomTweetLength] === "2000" 
              ? twitterPostTemplateLongForm.replace("{{tweetLength}}", allowedTweetLenghts[randomTweetLength]) 
              : twitterPostTemplateShortForm.replace("{{tweetLength}}", allowedTweetLenghts[randomTweetLength]);

            const context = composeContext({
                state,
                template: twitterPostTemplate,
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
            // const maxTweetLength = MAX_TWEET_LENGTH;
            // if (maxTweetLength) {
            //     cleanedContent = truncateToCompleteSentence(
            //         cleanedContent,
            //         maxTweetLength
            //     );
            // }

            const removeQuotes = (str: string) =>
                str.replace(/^['"](.*)['"]$/, "$1");

            const fixNewLines = (str: string) => str.replaceAll(/\\n/g, "\n\n"); //ensures double spaces

            // Final cleaning
            cleanedContent = removeQuotes(fixNewLines(cleanedContent));
            elizaLogger.log(`Generated tweet:\n ${cleanedContent}`);

            return {
                cleanedContent: cleanedContent,
                newTweetContent: newTweetContent,
            };
        } catch (error) {
            elizaLogger.error("Error generating new tweet:", error);
            return undefined;
        }
    }

    private async generateTweetsForApproval(ctx: Context, numberOfTweets: number, fileContext: string) {
        let tweetsGenerated = 0;

        const themes = await this.analyzeInterviewDocument(fileContext);

        while (tweetsGenerated < numberOfTweets) {

            const topic = await this.extractTopic(themes.join("\n"));
            elizaLogger.log(`Selected topic: ${topic}`);

            const {cleanedContent, newTweetContent} = await this.generateNewTweet(topic);
            elizaLogger.log(`Generated tweet for approval:\n ${cleanedContent}`);

            if (cleanedContent) {
                await this.postTweet(
                    ctx,
                    this.runtime,
                    cleanedContent,
                    stringToUuid("twitter_generate_room-40IQ"),
                );

                tweetsGenerated++;
                elizaLogger.log(`Generated tweet ${tweetsGenerated} of ${numberOfTweets} for approval`);
            }
        }
        elizaLogger.log(`Completed generating ${numberOfTweets} tweets for approval`);
    }

    async stop() {
        elizaLogger.log("Stopping Telegram bot...");
        await this.bot.stop();
        elizaLogger.log("Telegram bot stopped");
    }
}
