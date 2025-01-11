import { elizaLogger } from "@elizaos/core";
import { Client, IAgentRuntime } from "@elizaos/core";
import { TelegramClient } from "./telegramClient.ts";
import { validateTelegramConfig } from "./environment.ts";
import { ClientBase } from "./base.ts";
import { TwitterPostClient } from "./post.ts";
import { TwitterInteractionClient } from "./interactions.ts";
import { validateTwitterConfig, TwitterConfig } from "./environment.ts";
import { Context, Telegraf } from "telegraf";
import { MessageManager } from "./messageManager.ts";

class TwitterManager {
    client: ClientBase;
    post: TwitterPostClient;
    interaction: TwitterInteractionClient;
    bot: Telegraf<Context>;
    runtime: IAgentRuntime;
    messageManager: MessageManager;

    constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig,  botToken: string) {
        // Pass twitterConfig to the base client
        this.client = new ClientBase(runtime, twitterConfig);

        // Posting logic
        this.post = new TwitterPostClient(this.client, runtime);

        // Mentions and interactions
        this.interaction = new TwitterInteractionClient(this.client, runtime);
    }
}

export const TelegramClientInterface: Client = {
    start: async (runtime: IAgentRuntime) => {
        await validateTelegramConfig(runtime);
        const twitterConfig: TwitterConfig = await validateTwitterConfig(runtime);

        const manager = new TwitterManager(runtime, twitterConfig, runtime.getSetting("TELEGRAM_BOT_TOKEN"));

        await manager.client.init();

        // start posting loop
        await manager.post.start();

        return manager;
    },
    stop: async (_runtime: IAgentRuntime) => {
        elizaLogger.warn("Telegram/Twitter client does not support stopping yet");
    },
};

export default TelegramClientInterface;
