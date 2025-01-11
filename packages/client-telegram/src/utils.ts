import { Tweet } from "agent-twitter-client";
import { getEmbeddingZeroVector } from "@elizaos/core";
import { Content, Memory, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { ClientBase } from "./base";
import { elizaLogger } from "@elizaos/core";

export function cosineSimilarity(text1: string, text2: string, text3?: string): number {
    const preprocessText = (text: string) => text
        .toLowerCase()
        .replace(/[^\w\s'_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const getWords = (text: string) => {
        return text.split(' ').filter(word => word.length > 1);
    };

    const words1 = getWords(preprocessText(text1));
    const words2 = getWords(preprocessText(text2));
    const words3 = text3 ? getWords(preprocessText(text3)) : [];

    const freq1: { [key: string]: number } = {};
    const freq2: { [key: string]: number } = {};
    const freq3: { [key: string]: number } = {};

    words1.forEach(word => freq1[word] = (freq1[word] || 0) + 1);
    words2.forEach(word => freq2[word] = (freq2[word] || 0) + 1);
    if (words3.length) {
        words3.forEach(word => freq3[word] = (freq3[word] || 0) + 1);
    }

    const uniqueWords = new Set([...Object.keys(freq1), ...Object.keys(freq2), ...(words3.length ? Object.keys(freq3) : [])]);

    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;
    let magnitude3 = 0;

    uniqueWords.forEach(word => {
        const val1 = freq1[word] || 0;
        const val2 = freq2[word] || 0;
        const val3 = freq3[word] || 0;

        if (words3.length) {
            // For three-way, calculate pairwise similarities
            const sim12 = val1 * val2;
            const sim23 = val2 * val3;
            const sim13 = val1 * val3;

            // Take maximum similarity between any pair
            dotProduct += Math.max(sim12, sim23, sim13);
        } else {
            dotProduct += val1 * val2;
        }

        magnitude1 += val1 * val1;
        magnitude2 += val2 * val2;
        if (words3.length) {
            magnitude3 += val3 * val3;
        }
    });

    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);
    magnitude3 = words3.length ? Math.sqrt(magnitude3) : 1;

    if (magnitude1 === 0 || magnitude2 === 0 || (words3.length && magnitude3 === 0)) return 0;

    // For two texts, use original calculation
    if (!words3.length) {
        return dotProduct / (magnitude1 * magnitude2);
    }

    // For three texts, use max magnitude pair to maintain scale
    const maxMagnitude = Math.max(
        magnitude1 * magnitude2,
        magnitude2 * magnitude3,
        magnitude1 * magnitude3
    );

    return dotProduct / maxMagnitude;
}

export function escapeMarkdown(text: string): string {
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

/**
 * Splits a message into chunks that fit within Telegram's message length limit
 */
export function splitMessage(text: string, maxLength: number = 4096): string[] {
    const chunks: string[] = [];
    let currentChunk = "";

    const lines = text.split("\n");
    for (const line of lines) {
        if (currentChunk.length + line.length + 1 <= maxLength) {
            currentChunk += (currentChunk ? "\n" : "") + line;
        } else {
            if (currentChunk) chunks.push(currentChunk);
            currentChunk = line;
        }
    }

    if (currentChunk) chunks.push(currentChunk);
    return chunks;
}

const MAX_TWEET_LENGTH = 280; // Updated to Twitter's current character limit

export const wait = (minTime: number = 1000, maxTime: number = 3000) => {
    const waitTime =
        Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
    return new Promise((resolve) => setTimeout(resolve, waitTime));
};

export const isValidTweet = (tweet: Tweet): boolean => {
    // Filter out tweets with too many hashtags, @s, or $ signs, probably spam or garbage
    const hashtagCount = (tweet.text?.match(/#/g) || []).length;
    const atCount = (tweet.text?.match(/@/g) || []).length;
    const dollarSignCount = (tweet.text?.match(/\$/g) || []).length;
    const totalCount = hashtagCount + atCount + dollarSignCount;

    return (
        hashtagCount <= 1 &&
        atCount <= 2 &&
        dollarSignCount <= 1 &&
        totalCount <= 3
    );
};

export async function buildConversationThread(
    tweet: Tweet,
    client: ClientBase,
    maxReplies: number = 10
): Promise<Tweet[]> {
    const thread: Tweet[] = [];
    const visited: Set<string> = new Set();

    async function processThread(currentTweet: Tweet, depth: number = 0) {
        if (!currentTweet || depth >= maxReplies) {
            return;
        }

        if (visited.has(currentTweet.id)) {
            return;
        }

        visited.add(currentTweet.id);
        thread.unshift(currentTweet);

        // Handle memory storage
        const memory = await client.runtime.messageManager.getMemoryById(
            stringToUuid(currentTweet.id + "-" + client.runtime.agentId)
        );
        if (!memory) {
            const roomId = stringToUuid(
                currentTweet.conversationId + "-" + client.runtime.agentId
            );
            const userId = stringToUuid(currentTweet.userId);

            await client.runtime.ensureConnection(
                userId,
                roomId,
                currentTweet.username,
                currentTweet.name,
                "twitter"
            );

            await client.runtime.messageManager.createMemory({
                id: stringToUuid(
                    currentTweet.id + "-" + client.runtime.agentId
                ),
                agentId: client.runtime.agentId,
                content: {
                    text: currentTweet.text,
                    source: "twitter",
                    url: currentTweet.permanentUrl,
                    inReplyTo: currentTweet.inReplyToStatusId
                        ? stringToUuid(
                              currentTweet.inReplyToStatusId +
                                  "-" +
                                  client.runtime.agentId
                          )
                        : undefined,
                },
                createdAt: currentTweet.timestamp * 1000,
                roomId,
                userId:
                    currentTweet.userId === client.profile.id
                        ? client.runtime.agentId
                        : stringToUuid(currentTweet.userId),
                embedding: getEmbeddingZeroVector(),
            });
        }

        if (currentTweet.inReplyToStatusId) {
            try {
                const parentTweet = await client.twitterClient.getTweet(
                    currentTweet.inReplyToStatusId
                );
                if (parentTweet) {
                    await processThread(parentTweet, depth + 1);
                }
            } catch (error) {
                elizaLogger.error("Error fetching parent tweet:", error);
            }
        }
    }

    await processThread(tweet, 0);

    elizaLogger.debug("Final thread built:", {
        totalTweets: thread.length,
        tweetIds: thread.map((t) => ({
            id: t.id,
            text: t.text?.slice(0, 50),
        })),
    });

    return thread;
}

export async function sendTweet(
    client: ClientBase,
    content: Content,
    roomId: UUID,
    twitterUsername: string,
    inReplyTo: string
): Promise<Memory[]> {
    const tweetChunks = splitTweetContent(content.text);
    const sentTweets: Tweet[] = [];
    let previousTweetId = inReplyTo;

    for (const chunk of tweetChunks) {
        const result = await client.requestQueue.add(
            async () =>
                await client.twitterClient.sendTweet(
                    chunk.trim(),
                    previousTweetId
                )
        );
        const body = await result.json();

        // if we have a response
        if (body?.data?.create_tweet?.tweet_results?.result) {
            // Parse the response
            const tweetResult = body.data.create_tweet.tweet_results.result;
            const finalTweet: Tweet = {
                id: tweetResult.rest_id,
                text: tweetResult.legacy.full_text,
                conversationId: tweetResult.legacy.conversation_id_str,
                timestamp:
                    new Date(tweetResult.legacy.created_at).getTime() / 1000,
                userId: tweetResult.legacy.user_id_str,
                inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
                permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
                hashtags: [],
                mentions: [],
                photos: [],
                thread: [],
                urls: [],
                videos: [],
            };
            sentTweets.push(finalTweet);
            previousTweetId = finalTweet.id;
        } else {
            console.error("Error sending tweet:", {
                chunk,
                response: body,
                error: body?.errors?.[0] || "Unknown error",
                previousTweetId,
            });
            throw new Error(
                `Failed to send tweet: ${JSON.stringify(body?.errors?.[0] || "Unknown error")}`
            );
        }

        // Wait a bit between tweets to avoid rate limiting issues
        await wait(1000, 2000);
    }

    const memories: Memory[] = sentTweets.map((tweet) => ({
        id: stringToUuid(tweet.id + "-" + client.runtime.agentId),
        agentId: client.runtime.agentId,
        userId: client.runtime.agentId,
        content: {
            text: tweet.text,
            source: "twitter",
            url: tweet.permanentUrl,
            inReplyTo: tweet.inReplyToStatusId
                ? stringToUuid(
                      tweet.inReplyToStatusId + "-" + client.runtime.agentId
                  )
                : undefined,
        },
        roomId,
        embedding: getEmbeddingZeroVector(),
        createdAt: tweet.timestamp * 1000,
    }));

    return memories;
}

function splitTweetContent(content: string): string[] {
    const maxLength = MAX_TWEET_LENGTH;
    const paragraphs = content.split("\n\n").map((p) => p.trim());
    const tweets: string[] = [];
    let currentTweet = "";

    for (const paragraph of paragraphs) {
        if (!paragraph) continue;

        if ((currentTweet + "\n\n" + paragraph).trim().length <= maxLength) {
            if (currentTweet) {
                currentTweet += "\n\n" + paragraph;
            } else {
                currentTweet = paragraph;
            }
        } else {
            if (currentTweet) {
                tweets.push(currentTweet.trim());
            }
            if (paragraph.length <= maxLength) {
                currentTweet = paragraph;
            } else {
                // Split long paragraph into smaller chunks
                const chunks = splitParagraph(paragraph, maxLength);
                tweets.push(...chunks.slice(0, -1));
                currentTweet = chunks[chunks.length - 1];
            }
        }
    }

    if (currentTweet) {
        tweets.push(currentTweet.trim());
    }

    return tweets;
}

function splitParagraph(paragraph: string, maxLength: number): string[] {
    // eslint-disable-next-line
    const sentences = paragraph.match(/[^\.!\?]+[\.!\?]+|[^\.!\?]+$/g) || [
        paragraph,
    ];
    const chunks: string[] = [];
    let currentChunk = "";

    for (const sentence of sentences) {
        if ((currentChunk + " " + sentence).trim().length <= maxLength) {
            if (currentChunk) {
                currentChunk += " " + sentence;
            } else {
                currentChunk = sentence;
            }
        } else {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
            }
            if (sentence.length <= maxLength) {
                currentChunk = sentence;
            } else {
                // Split long sentence into smaller pieces
                const words = sentence.split(" ");
                currentChunk = "";
                for (const word of words) {
                    if (
                        (currentChunk + " " + word).trim().length <= maxLength
                    ) {
                        if (currentChunk) {
                            currentChunk += " " + word;
                        } else {
                            currentChunk = word;
                        }
                    } else {
                        if (currentChunk) {
                            chunks.push(currentChunk.trim());
                        }
                        currentChunk = word;
                    }
                }
            }
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

export function truncateToCompleteSentence(text: string): string {
    // Define sentence ending punctuation
    const sentenceEndings = [".", "!", "?"];

    // If text is shorter than 280 characters, return as is
    if (text.length <= 280) {
        return text;
    }

    // Find the last sentence ending before 280 characters
    let lastIndex = -1;
    for (const ending of sentenceEndings) {
        const index = text.lastIndexOf(ending, 280);
        if (index > lastIndex) {
            lastIndex = index;
        }
    }

    // If we found a sentence ending, truncate there
    if (lastIndex !== -1) {
        return text.substring(0, lastIndex + 1).trim();
    }

    // If no sentence ending found, truncate at last space before 280
    const lastSpace = text.lastIndexOf(" ", 280);
    if (lastSpace !== -1) {
        return text.substring(0, lastSpace).trim() + "...";
    }

    // If no space found, just truncate at 280 with ellipsis
    return text.substring(0, 277).trim() + "...";
}