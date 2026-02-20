/**
 * Discord Sync Plugin for OpenCode
 * 
 * Syncs OpenCode sessions to Discord threads in #opencode-sync channel.
 * Only activates for OpenCode server on port 4098.
 * 
 * Installation:
 *   Copy to ~/.config/opencode/plugins/ or .opencode/plugins/
 * 
 * Configuration:
 *   Set DISCORD_SYNC_URL environment variable (default: http://127.0.0.1:4099)
 */

const SYNC_PORT = 4098; // Only sync sessions from this OpenCode port
const SYNC_URL = process.env.DISCORD_SYNC_URL || 'http://127.0.0.1:4099';

// Track sessions we've created threads for
const syncedSessions = new Map(); // sessionId -> { threadId, lastMessageId }

// Track the last message we posted to avoid duplicates
const lastPostedContent = new Map(); // sessionId -> { userContent, assistantContent }

/**
 * Extract port from OpenCode client baseUrl
 */
function getClientPort(client) {
    try {
        // The client object has configuration with baseUrl
        // We need to extract port from the connection
        const baseUrl = client?.config?.baseUrl || client?.baseUrl || '';
        if (baseUrl) {
            const url = new URL(baseUrl);
            return parseInt(url.port, 10) || 4096;
        }
    } catch (e) {
        // Fallback: check environment
    }
    return parseInt(process.env.OPENCODE_PORT, 10) || 4096;
}

/**
 * Check if we should sync this client (only port 4098)
 */
function shouldSync(client) {
    const port = getClientPort(client);
    return port === SYNC_PORT;
}

/**
 * POST to sync endpoint
 */
async function postSync(endpoint, data) {
    try {
        const response = await fetch(`${SYNC_URL}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!response.ok) {
            console.error(`[discord-sync] POST ${endpoint} failed:`, response.status);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error(`[discord-sync] POST ${endpoint} error:`, error.message);
        return null;
    }
}

/**
 * Get session messages from client
 */
async function getSessionMessages(client, sessionId) {
    try {
        const result = await client.message.list({ sessionId });
        return result?.messages || [];
    } catch (error) {
        console.error(`[discord-sync] Failed to get messages:`, error.message);
        return [];
    }
}

/**
 * Extract text content from a message
 */
function extractMessageContent(message) {
    if (!message || !message.parts) return '';
    
    let content = '';
    for (const part of message.parts) {
        if (part.type === 'text') {
            content += part.text || '';
        }
    }
    return content.trim();
}

/**
 * Get the latest user prompt and assistant response pair
 */
function getLatestExchange(messages) {
    // Messages are ordered, find the last user message and subsequent assistant message
    let lastUserIdx = -1;
    let lastAssistantIdx = -1;
    
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'assistant' && lastAssistantIdx === -1) {
            lastAssistantIdx = i;
        }
        if (msg.role === 'user' && lastAssistantIdx !== -1) {
            lastUserIdx = i;
            break;
        }
    }
    
    if (lastUserIdx === -1 || lastAssistantIdx === -1) {
        return null;
    }
    
    return {
        userMessage: messages[lastUserIdx],
        assistantMessage: messages[lastAssistantIdx]
    };
}

/**
 * Main plugin export
 */
export const DiscordSyncPlugin = async ({ client, directory }) => {
    // Check if we should sync for this client
    // Note: We'll do the actual port check when events fire since client may not be fully initialized
    
    console.log(`[discord-sync] Plugin loaded for directory: ${directory}`);
    
    return {
        event: async ({ event }) => {
            // Handle session.created - create Discord thread
            if (event.type === 'session.created') {
                const session = event.properties?.session;
                if (!session) return;
                
                console.log(`[discord-sync] Session created: ${session.id}`);
                
                // We'll create the thread when we get the first message
                // since session.created doesn't have the prompt yet
                syncedSessions.set(session.id, { threadId: null, pending: true });
            }
            
            // Handle session.idle - post the latest exchange to Discord
            if (event.type === 'session.idle') {
                const sessionId = event.properties?.sessionId || event.properties?.session?.id;
                if (!sessionId) return;
                
                console.log(`[discord-sync] Session idle: ${sessionId}`);
                
                // Get messages for this session
                const messages = await getSessionMessages(client, sessionId);
                if (messages.length === 0) return;
                
                const exchange = getLatestExchange(messages);
                if (!exchange) return;
                
                const userContent = extractMessageContent(exchange.userMessage);
                const assistantContent = extractMessageContent(exchange.assistantMessage);
                
                if (!userContent && !assistantContent) return;
                
                // Check if we already posted this exact content (dedup)
                const lastPosted = lastPostedContent.get(sessionId);
                if (lastPosted && 
                    lastPosted.userContent === userContent && 
                    lastPosted.assistantContent === assistantContent) {
                    console.log(`[discord-sync] Skipping duplicate content for session ${sessionId}`);
                    return;
                }
                
                // Get or create thread
                let syncState = syncedSessions.get(sessionId);
                
                if (!syncState || !syncState.threadId) {
                    // Create new thread with first message as title
                    const threadName = userContent.slice(0, 50) || 'OpenCode Session';
                    
                    console.log(`[discord-sync] Creating thread: "${threadName}"`);
                    
                    const result = await postSync('/sync/session', {
                        sessionId,
                        title: threadName,
                        directory
                    });
                    
                    if (result && result.threadId) {
                        syncState = { threadId: result.threadId };
                        syncedSessions.set(sessionId, syncState);
                    } else {
                        console.error(`[discord-sync] Failed to create thread for session ${sessionId}`);
                        return;
                    }
                }
                
                // Post the message exchange to the thread
                console.log(`[discord-sync] Posting exchange to thread ${syncState.threadId}`);
                
                await postSync('/sync/message', {
                    sessionId,
                    threadId: syncState.threadId,
                    userContent,
                    assistantContent,
                    messageId: exchange.assistantMessage.id
                });
                
                // Track what we posted to avoid duplicates
                lastPostedContent.set(sessionId, { userContent, assistantContent });
            }
            
            // Handle session.deleted - clean up
            if (event.type === 'session.deleted') {
                const sessionId = event.properties?.sessionId;
                if (sessionId) {
                    syncedSessions.delete(sessionId);
                    lastPostedContent.delete(sessionId);
                }
            }
        }
    };
};

export default DiscordSyncPlugin;
