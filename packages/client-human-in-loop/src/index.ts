import {
    Client,
    elizaLogger,
    IAgentRuntime,
} from "@elizaos/core";
import { ClientBase } from "./base.ts";
import { validateTwitterConfig, TwitterConfig } from "./environment.ts";
import { HumanPostClient } from "./post.ts";
import { validateTelegramConfig } from "./environment.ts";

/**
 * A manager that orchestrates all specialized Twitter logic:
 * - client: base operations (login, timeline caching, etc.)
 * - post: autonomous posting logic
 */

class HumanManager {
    client: ClientBase;
    post: HumanPostClient;

    constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig) {
        // Pass twitterConfig to the base client
        this.client = new ClientBase(runtime, twitterConfig);

        // core tweet logic
        this.post = new HumanPostClient(this.client, runtime, runtime.getSetting("TELEGRAM_BOT_TOKEN"));
    }
}

export const HumanClientInterface: Client = {
    async start(runtime: IAgentRuntime) {

        await validateTelegramConfig(runtime);
        const twitterConfig: TwitterConfig = await validateTwitterConfig(runtime);

        elizaLogger.log("Human client started");

        const manager = new HumanManager(runtime, twitterConfig);

        // Start the posting loop
        await manager.post.start();

        return manager;
    },

    async stop(_runtime: IAgentRuntime) {
        elizaLogger.warn("Human client does not support stopping yet");
    },
};

export default HumanClientInterface;
