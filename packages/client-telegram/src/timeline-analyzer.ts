import { Tweet } from "agent-twitter-client";
import { elizaLogger } from "@elizaos/core";
import { IAgentRuntime, generateText } from "@elizaos/core";

export class TimelineAnalyzer {
    private lastFiveTopics: string[] = [];

    constructor(private runtime?: IAgentRuntime) {}

    async init() {
        if (this.runtime) {
            await this.loadTopicsFromCache();
        }
    }

    private async loadTopicsFromCache() {
        if (!this.runtime) return;

        const cachedTopics = await this.runtime.cacheManager.get<string[]>(
            `twitter/${this.runtime.getSetting("TWITTER_USERNAME")}/lastFiveTopics`
        );
        if (cachedTopics) {
            this.lastFiveTopics = cachedTopics;
            elizaLogger.info(
                `[TimelineAnalyzer] Loaded topics from cache: ${cachedTopics.join(", ")}`
            );
        }
    }

    private async saveTopicsToCache() {
        if (!this.runtime) return;

        await this.runtime.cacheManager.set(
            `twitter/${this.runtime.getSetting("TWITTER_USERNAME")}/lastFiveTopics`,
            this.lastFiveTopics
        );
        elizaLogger.info(
            `[TimelineAnalyzer] Saved topics to cache: ${this.lastFiveTopics.join(", ")}`
        );
    }

    private readonly themeAnalysisPrompt = `
        Analyze these tweets from my followers:
        {{tweets}}

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

        If no theme is semantically different from the last five topics, select a random topic from:
        {{characterTopics}}

        IMPORTANT: Return ONLY the selected topic as a single line, without any explanation.
        Example response: "DeFi innovation"
    `;

    private async analyzeTimeline(tweets: Tweet[]): Promise<string[]> {
        if (!this.runtime) {
            throw new Error("Runtime not initialized");
        }

        try {
            const tweetsText = tweets.map((t) => t.text).join("\n");

            elizaLogger.info(
                `[TimelineAnalyzer] Analyzing tweets for themes: ${tweetsText}`
            );

            const context = this.themeAnalysisPrompt.replace(
                "{{tweets}}",
                tweetsText
            );

            elizaLogger.info("[TimelineAnalyzer] Analyzing tweets for themes");
            const response = await generateText({
                runtime: this.runtime,
                context,
                modelClass: "medium",
            });

            const themes = response
                .split("\n")
                .filter((theme) => theme.trim().length > 0);
            elizaLogger.info(
                `[TimelineAnalyzer] Identified ${themes.length} themes`
            );
            return themes;
        } catch (error) {
            elizaLogger.error(
                "[TimelineAnalyzer] Error analyzing tweets:",
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
                "[TimelineAnalyzer] Current topic history:",
                this.lastFiveTopics
            );

            const characterTopics = this.runtime.character.topics.join("\n");
            const lastTopics =
                this.lastFiveTopics.length > 0
                    ? this.lastFiveTopics.join("\n")
                    : "No previous topics";

            const context = this.topicSelectionPrompt
                .replace("{{themes}}", themes)
                .replace("{{lastFiveTopics}}", lastTopics)
                .replace("{{characterTopics}}", characterTopics)
                .replace(/{{characterName}}/g, this.runtime.character.name);

            elizaLogger.info("[TimelineAnalyzer] Selecting topic");
            const response = await generateText({
                runtime: this.runtime,
                context,
                modelClass: "medium",
            });

            // Extract just the topic, removing any explanation
            const selectedTopic = response.split("\n")[0].trim();

            elizaLogger.info(
                `[TimelineAnalyzer] Selected topic: "${selectedTopic}"`
            );
            elizaLogger.info(
                "[TimelineAnalyzer] Previous topics:",
                this.lastFiveTopics
            );

            // Update lastFiveTopics and save to cache
            this.lastFiveTopics.push(selectedTopic);
            if (this.lastFiveTopics.length > 5) {
                this.lastFiveTopics.shift();
            }
            await this.saveTopicsToCache();

            elizaLogger.info(
                "[TimelineAnalyzer] Updated topic history:",
                this.lastFiveTopics
            );
            return selectedTopic;
        } catch (error) {
            elizaLogger.error(
                "[TimelineAnalyzer] Error extracting topic:",
                error
            );
            return null;
        }
    }

    async analyzeTimelineForTopic(tweets: Tweet[]): Promise<string> {
        try {
            // 1. Analyze for themes
            const themes = await this.analyzeTimeline(tweets);

            // 2. Select final topic
            const topic = await this.extractTopic(themes.join("\n"));

            return topic || "Ethereum and AI agents"; // Fallback topic
        } catch (error) {
            elizaLogger.error(
                "[TimelineAnalyzer] Error in timeline analysis:",
                error
            );
            return "Ethereum and AI agents"; // Fallback topic
        }
    }
}