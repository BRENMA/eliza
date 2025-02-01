import {
    Client,
    elizaLogger,
    IAgentRuntime,
} from "@elizaos/core";
import { HumanPostClient } from "./post.ts";
import { validateTelegramConfig } from "./environment.ts";

/**
 * A manager that orchestrates all specialized Twitter logic:
 * - post: autonomous posting logic
 */

class HumanManager {
    post: HumanPostClient;

    constructor(runtime: IAgentRuntime) {
        this.post = new HumanPostClient(runtime, runtime.getSetting("TELEGRAM_BOT_TOKEN"));
    }
}

export const HumanClientInterface: Client = {
    async start(runtime: IAgentRuntime) {

        await validateTelegramConfig(runtime);

        const manager = new HumanManager(runtime);

        // Start the posting loop
        await manager.post.start();

        return manager;
    },

    async stop(_runtime: IAgentRuntime) {
        elizaLogger.warn("Human client does not support stopping yet");
    },
};

export default HumanClientInterface;
