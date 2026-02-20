import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import http from 'http';
import {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType
} from 'discord.js';
import { createOpencodeClient } from '@opencode-ai/sdk/client';
import OpenAI from 'openai';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file fresh (override any cached values)
dotenv.config({ path: path.join(__dirname, '.env'), override: true });

// OpenCode client - connects to running server
const opencode = createOpencodeClient({
    baseUrl: `http://${process.env.OPENCODE_HOST || '127.0.0.1'}:${process.env.OPENCODE_PORT || 4096}`,
    timeout: 600000 // 10 minutes timeout for long operations
});

console.log(`OpenCode client connecting to http://${process.env.OPENCODE_HOST || '127.0.0.1'}:${process.env.OPENCODE_PORT || 4096}`);

// OpenAI client for Whisper voice transcription
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Discord client setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions, // For adding reactions to messages
    ],
    partials: [
        Partials.Channel, // Required for DM support
        Partials.Message,
        Partials.Thread, // Required for thread support
    ],
});

// Store active sessions (userId -> sessionId mapping)
const userSessions = new Map();

// Store user model preferences (userId -> modelId mapping)
const userModels = new Map();

// Track threads where the bot should auto-respond (threads created on bot messages)
// Set of thread IDs
const subscribedThreads = new Set();

// Store models temporarily for button lookups (indexed by interaction message)
// Key: interactionId or messageId, Value: Map of buttonIndex -> model
let modelButtonMaps = new Map();

// Track bot start time to ignore old messages
const botStartTime = Date.now();

// ============================================
// OpenCode Sync - Session/Thread Mappings
// ============================================
// Maps OpenCode sessionId -> Discord threadId
const sessionToThread = new Map();
// Maps Discord threadId -> OpenCode sessionId  
const threadToSession = new Map();
// Sync channel reference (will be populated on ready)
let syncChannel = null;
const SYNC_CHANNEL_NAME = process.env.DISCORD_SYNC_CHANNEL || 'opencode-sync';
// Track last posted content to avoid duplicates (sessionId -> { userContent, assistantContent })
const lastPostedContent = new Map();
// Track sessions initiated from Discord (these should NOT be synced back to Discord)
const discordInitiatedSessions = new Set();

// Parse allowed users whitelist from environment
const allowedUsers = process.env.DISCORD_ALLOWED_USERS
    ? process.env.DISCORD_ALLOWED_USERS.split(',').map(id => id.trim()).filter(id => id && id !== '0')
    : [];

if (allowedUsers.length > 0) {
    console.log(`User whitelist enabled: ${allowedUsers.length} user(s) allowed`);
} else {
    console.log('No users in whitelist - first user to message will become admin');
}

// Add user to .env file and exit (for first-time setup)
function addUserToEnvAndExit(userId) {
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    
    // Read existing .env if it exists
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
    }
    
    // Check if DISCORD_ALLOWED_USERS already exists (not commented out)
    const envVarRegex = /^DISCORD_ALLOWED_USERS=.*$/m;
    if (envVarRegex.test(envContent)) {
        // Replace the existing line
        envContent = envContent.replace(
            envVarRegex,
            `DISCORD_ALLOWED_USERS=${userId}`
        );
    } else {
        // Append to the file
        envContent += `\n# User whitelist - only these user IDs can use the bot\nDISCORD_ALLOWED_USERS=${userId}\n`;
    }
    
    fs.writeFileSync(envPath, envContent);
    console.log(`Added user ${userId} to .env as admin. Exiting for restart...`);
    process.exit(0);
}

// Get the configured guild
async function getGuild() {
    const guildId = process.env.DISCORD_GUILD_ID;
    if (!guildId) {
        console.error('DISCORD_GUILD_ID is not set');
        return null;
    }
    
    try {
        return await client.guilds.fetch(guildId);
    } catch (error) {
        console.error(`Failed to fetch guild ${guildId}:`, error.message);
        return null;
    }
}

// Check if a user has a specific role
async function userHasRole(userId, roleName) {
    const guild = await getGuild();
    if (!guild) return false;
    
    try {
        const member = await guild.members.fetch(userId);
        return member.roles.cache.some(role => 
            role.name.toLowerCase() === roleName.toLowerCase() ||
            role.id === roleName
        );
    } catch (error) {
        // User not in guild or other error
        return false;
    }
}

// Check if a user is a member of the configured guild
async function isGuildMember(userId) {
    const guild = await getGuild();
    if (!guild) return false;
    
    try {
        await guild.members.fetch(userId);
        return true;
    } catch (error) {
        return false;
    }
}

// Check if a user is authorized to use the bot
// Returns: { authorized: boolean, isAdmin: boolean, reason?: string }
async function checkUserAuthorized(userId) {
    // First check if user is in the guild
    const isMember = await isGuildMember(userId);
    if (!isMember) {
        return {
            authorized: false,
            isAdmin: false,
            reason: 'You must be a member of the server to use this bot.'
        };
    }
    
    // If no allowlist configured, first user becomes admin
    if (allowedUsers.length === 0) {
        return {
            authorized: true,
            isAdmin: true,
            isFirstUser: true
        };
    }
    
    // Check if user is in whitelist
    if (allowedUsers.includes(String(userId))) {
        const isAdmin = await userHasRole(userId, process.env.DISCORD_ADMIN_ROLE || 'admin');
        return { authorized: true, isAdmin };
    }
    
    // Check if user has admin or edit role
    const hasAdminRole = await userHasRole(userId, process.env.DISCORD_ADMIN_ROLE || 'admin');
    const hasEditRole = await userHasRole(userId, process.env.DISCORD_EDIT_ROLE || 'edit');
    
    if (hasAdminRole || hasEditRole) {
        return { authorized: true, isAdmin: hasAdminRole };
    }
    
    return {
        authorized: false,
        isAdmin: false,
        reason: `You need the **${process.env.DISCORD_EDIT_ROLE || 'edit'}** or **${process.env.DISCORD_ADMIN_ROLE || 'admin'}** role to use this bot.\n\nYour user ID: \`${userId}\``
    };
}

// Get the current model for a user (falls back to env default)
function getUserModel(userId) {
    return userModels.get(userId) || process.env.OPENCODE_MODEL || 'opencode/minimax-m2.5-free';
}

// Parse model ID string (provider/model) into { providerID, modelID } object
function parseModelId(modelStr) {
    const [providerID, ...rest] = modelStr.split('/');
    const modelID = rest.join('/'); // Handle model IDs that may contain '/'
    return { providerID, modelID };
}

// Dynamic model loading
async function getAvailableModels() {
    try {
        const { data } = await opencode.config.providers();
        const models = [];
        
        for (const provider of data.providers) {
            if (provider.models && typeof provider.models === 'object') {
                for (const modelId of Object.keys(provider.models)) {
                    models.push({
                        id: `${provider.id}/${modelId}`,
                        name: `${provider.name} ${modelId}`
                    });
                }
            }
        }
        
        console.log(`Loaded ${models.length} models from OpenCode server`);
        return models;
    } catch (error) {
        console.error('Error loading models:', error);
        return [];
    }
}

// Send prompt to OpenCode and get response
async function sendPrompt(sessionId, parts, modelObj) {
    try {
        const result = await opencode.session.prompt({
            path: { id: sessionId },
            body: { 
                parts,
                model: modelObj
            }
        });
        
        if (result?.error) {
            throw new Error(`OpenCode API error: ${JSON.stringify(result.error)}`);
        }
        
        return result?.data;
    } catch (error) {
        throw error;
    }
}

// Extract text from OpenCode response
function extractResponseText(response) {
    let responseText = '';
    
    if (response && response.parts) {
        responseText = response.parts
            .filter(p => p.type === 'text')
            .map(p => p.text)
            .join('\n');
    } else if (response && response.content) {
        if (typeof response.content === 'string') {
            responseText = response.content;
        } else if (Array.isArray(response.content)) {
            responseText = response.content
                .filter(p => p.type === 'text')
                .map(p => p.text)
                .join('\n');
        }
    }
    
    return responseText;
}

// Parse file changes from AI response
function parseFileChanges(responseText) {
    const files = [];
    
    // Look for common patterns indicating file operations
    const patterns = [
        /(?:created|wrote|edited|modified|updated|deleted|removed)\s+(?:file\s+)?[`"]?([^\s`"]+\.[a-zA-Z]+)[`"]?/gi,
        /(?:file|path):\s*[`"]?([^\s`"]+\.[a-zA-Z]+)[`"]?/gi,
        /```(?:diff|patch)[\s\S]*?(?:---|\+\+\+)\s+([^\s]+)/gi,
    ];
    
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(responseText)) !== null) {
            const file = match[1];
            if (file && !files.includes(file) && !file.startsWith('http')) {
                files.push(file);
            }
        }
    }
    
    return files;
}

// Post to changelog channel
async function postChangelog(userId, taskSummary, filesChanged, action = 'update') {
    const guild = await getGuild();
    if (!guild) return;
    
    const channelName = process.env.DISCORD_CHANGELOG_CHANNEL || 'changelog';
    
    // Find changelog channel by name or ID
    let channel = guild.channels.cache.find(ch => 
        ch.name === channelName || ch.id === channelName
    );
    
    // Create channel if it doesn't exist
    if (!channel) {
        try {
            channel = await guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                topic: 'Codebase changes made via OpenDiscord bot',
                reason: 'OpenDiscord changelog channel'
            });
            console.log(`Created changelog channel: #${channelName}`);
        } catch (error) {
            console.error('Failed to create changelog channel:', error.message);
            return;
        }
    }
    
    // Determine color and title based on action
    let color = 0x5865F2; // Discord blurple (default)
    let title = 'Codebase Update';
    let emoji = '';
    
    if (action === 'create') {
        color = 0x57F287; // Green
        title = 'Files Created';
        emoji = '+';
    } else if (action === 'edit') {
        color = 0xFEE75C; // Yellow
        title = 'Files Modified';
        emoji = '~';
    } else if (action === 'delete') {
        color = 0xED4245; // Red
        title = 'Files Deleted';
        emoji = '-';
    }
    
    // Create changelog embed
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(taskSummary.length > 2000 ? taskSummary.slice(0, 2000) + '...' : taskSummary)
        .addFields(
            { name: 'Initiated by', value: `<@${userId}>`, inline: true },
            { name: 'Files Changed', value: filesChanged.length > 0 ? filesChanged.slice(0, 10).map(f => `\`${emoji}${f}\``).join('\n') : 'No files detected', inline: true }
        )
        .setTimestamp()
        .setFooter({ text: 'OpenDiscord' });
    
    try {
        await channel.send({ embeds: [embed] });
        console.log(`Posted changelog for user ${userId}: ${filesChanged.length} files`);
    } catch (error) {
        console.error('Failed to post changelog:', error.message);
    }
    
    return channel;
}

// Ensure changelog channel exists on startup
async function ensureChangelogChannel() {
    const guild = await getGuild();
    if (!guild) return null;
    
    const channelName = process.env.DISCORD_CHANGELOG_CHANNEL || 'changelog';
    
    // Find changelog channel by name or ID
    let channel = guild.channels.cache.find(ch => 
        ch.name === channelName || ch.id === channelName
    );
    
    // Create channel if it doesn't exist
    if (!channel) {
        try {
            channel = await guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                topic: 'Codebase changes made via OpenDiscord bot',
                reason: 'OpenDiscord changelog channel'
            });
            console.log(`Created changelog channel on startup: #${channelName}`);
            
            // Send welcome message
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('OpenDiscord Changelog')
                .setDescription('This channel logs all codebase changes made through the OpenDiscord bot.\n\nEach entry includes:\n- Who initiated the change\n- Summary of what was done\n- Files that were modified')
                .setTimestamp()
                .setFooter({ text: 'OpenDiscord initialized' });
            
            await channel.send({ embeds: [embed] });
        } catch (error) {
            console.error('Failed to create changelog channel on startup:', error.message);
            return null;
        }
    }
    
    console.log(`Changelog channel ready: #${channel.name}`);
    return channel;
}

// Ensure #opencode-sync channel exists for OpenCode session sync
async function ensureSyncChannel() {
    const guild = await getGuild();
    if (!guild) return null;
    
    // Find sync channel by name or ID
    let channel = guild.channels.cache.find(ch => 
        ch.name === SYNC_CHANNEL_NAME || ch.id === SYNC_CHANNEL_NAME
    );
    
    // Create channel if it doesn't exist
    if (!channel) {
        try {
            channel = await guild.channels.create({
                name: SYNC_CHANNEL_NAME,
                type: ChannelType.GuildText,
                topic: 'OpenCode terminal session sync - threads mirror conversations',
                reason: 'OpenCode sync channel for terminal sessions'
            });
            console.log(`Created sync channel: #${SYNC_CHANNEL_NAME}`);
            
            // Send welcome message
            const embed = new EmbedBuilder()
                .setColor(0x00D26A)
                .setTitle('OpenCode Session Sync')
                .setDescription('This channel syncs OpenCode terminal sessions to Discord threads.\n\n' +
                    '**How it works:**\n' +
                    '• Each OpenCode session creates a thread here\n' +
                    '• User prompts and AI responses are posted to the thread\n' +
                    '• Reply in a thread to send messages back to OpenCode\n\n' +
                    '*Only sessions from the configured OpenCode server (port 4098) are synced.*')
                .setTimestamp()
                .setFooter({ text: 'OpenCode Sync initialized' });
            
            await channel.send({ embeds: [embed] });
        } catch (error) {
            console.error('Failed to create sync channel:', error.message);
            return null;
        }
    }
    
    console.log(`Sync channel ready: #${channel.name}`);
    syncChannel = channel;
    return channel;
}

// Create a thread in the sync channel for an OpenCode session
async function createSyncThread(sessionId, title, directory) {
    if (!syncChannel) {
        syncChannel = await ensureSyncChannel();
    }
    if (!syncChannel) {
        console.error('Cannot create sync thread: sync channel not available');
        return null;
    }
    
    try {
        // Create starter message for the thread
        const embed = new EmbedBuilder()
            .setColor(0x00D26A)
            .setTitle(title.slice(0, 100) || 'OpenCode Session')
            .setDescription(`Session: \`${sessionId.slice(0, 8)}...\`\nDirectory: \`${directory || 'unknown'}\``)
            .setTimestamp()
            .setFooter({ text: 'Reply to this thread to send messages to OpenCode' });
        
        const starterMessage = await syncChannel.send({ embeds: [embed] });
        
        // Create thread from the message
        const thread = await starterMessage.startThread({
            name: title.slice(0, 100) || 'OpenCode Session',
            autoArchiveDuration: 1440, // 24 hours
            reason: `OpenCode session sync: ${sessionId}`
        });
        
        // Store mappings
        sessionToThread.set(sessionId, thread.id);
        threadToSession.set(thread.id, sessionId);
        
        // Subscribe to thread for replies
        subscribedThreads.add(thread.id);
        
        console.log(`Created sync thread: ${thread.name} (${thread.id}) for session ${sessionId.slice(0, 8)}`);
        return thread;
    } catch (error) {
        console.error('Failed to create sync thread:', error.message);
        return null;
    }
}

// Post a message exchange to a sync thread
async function postToSyncThread(threadId, userContent, assistantContent) {
    try {
        const thread = await client.channels.fetch(threadId);
        if (!thread || !thread.isThread()) {
            console.error('Invalid thread ID:', threadId);
            return false;
        }
        
        // Format user message
        if (userContent) {
            const userParts = splitMessage(userContent, 1900);
            for (let i = 0; i < userParts.length; i++) {
                const content = i === 0 
                    ? `**User:**\n${userParts[i]}`
                    : userParts[i];
                await thread.send(content);
            }
        }
        
        // Format assistant message
        if (assistantContent) {
            const assistantParts = splitMessage(assistantContent, 1900);
            for (let i = 0; i < assistantParts.length; i++) {
                const content = i === 0
                    ? `**Assistant:**\n${assistantParts[i]}`
                    : assistantParts[i];
                await thread.send(content);
            }
        }
        
        return true;
    } catch (error) {
        console.error('Failed to post to sync thread:', error.message);
        return false;
    }
}

// Handle a message from Discord thread -> forward to OpenCode
async function handleSyncThreadReply(threadId, userMessage, content) {
    const sessionId = threadToSession.get(threadId);
    if (!sessionId) {
        console.error('No session found for thread:', threadId);
        return;
    }
    
    console.log(`Forwarding thread reply to OpenCode session ${sessionId.slice(0, 8)}: "${content.slice(0, 50)}..."`);
    
    try {
        // Show typing indicator
        await userMessage.channel.sendTyping();
        
        // Get model for user (or use default)
        const userId = userMessage.author.id;
        const userModel = getUserModel(userId);
        const modelObj = parseModelId(userModel);
        
        // Use the same sendPrompt function as main handler
        const parts = [{ type: 'text', text: content }];
        const response = await sendPrompt(sessionId, parts, modelObj);
        
        console.log(`Got response from OpenCode for thread reply`);
        
        // Extract response text using same function as main handler
        const fullResponse = extractResponseText(response);
        
        // Post the response to the thread
        if (fullResponse) {
            const responseParts = splitMessage(fullResponse, 1900);
            for (let i = 0; i < responseParts.length; i++) {
                const prefix = i === 0 ? '**Assistant:**\n' : '';
                await userMessage.channel.send(prefix + responseParts[i]);
            }
        } else {
            await userMessage.channel.send('*No response from AI*');
        }
    } catch (error) {
        console.error('Failed to forward to OpenCode:', error.message);
        await userMessage.channel.send(`*Error: ${error.message}*`);
    }
}

// ============================================
// Global Event Subscription for Session Sync
// ============================================

/**
 * Extract text content from a message
 */
function extractMessageContent(message) {
    if (!message) return '';
    // Parts can be at message.parts or message.info might not have parts
    const parts = message.parts || [];
    if (parts.length === 0) return '';
    
    let content = '';
    for (const part of parts) {
        if (part.type === 'text') {
            content += part.text || '';
        }
    }
    return content.trim();
}

/**
 * Get the latest user prompt and assistant response pair from messages
 */
function getLatestExchange(messages) {
    let lastUserIdx = -1;
    let lastAssistantIdx = -1;
    
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        // Role can be at msg.role or msg.info.role depending on API response
        const role = msg.role || msg.info?.role;
        if (role === 'assistant' && lastAssistantIdx === -1) {
            lastAssistantIdx = i;
        }
        if (role === 'user' && lastAssistantIdx !== -1) {
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
 * Handle session.idle event - sync terminal session to Discord
 */
async function handleSessionIdle(sessionId) {
    // Skip sessions initiated from Discord (they're already in Discord)
    if (discordInitiatedSessions.has(sessionId)) {
        console.log(`Skipping sync for Discord-initiated session: ${sessionId.slice(0, 8)}`);
        return;
    }
    
    console.log(`Session idle event for: ${sessionId.slice(0, 8)}`);
    
    try {
        // Get messages for this session
        const messagesResult = await opencode.session.messages({
            path: { id: sessionId }
        });
        
        // Debug: log raw result structure
        console.log(`Messages result keys: ${Object.keys(messagesResult || {}).join(', ')}`);
        
        // Messages might be in .data or directly in the result
        let messages = messagesResult.data || messagesResult || [];
        if (!Array.isArray(messages)) {
            // If it's an object with values, try to get the array
            if (typeof messages === 'object') {
                messages = Object.values(messages);
            }
        }
        
        console.log(`Session ${sessionId.slice(0, 8)} has ${messages.length} messages`);
        if (messages.length === 0) {
            console.log(`No messages in session ${sessionId.slice(0, 8)}`);
            return;
        }
        
        // Debug: log message roles (check structure)
        const roles = messages.map(m => m.role || m.info?.role || '?').join(', ');
        console.log(`Message roles (first 10): ${roles.split(', ').slice(0, 10).join(', ')}`);
        
        // Debug: log first message structure
        if (messages.length > 0) {
            console.log(`First message keys: ${Object.keys(messages[0]).join(', ')}`);
        }
        console.log(`Message roles: ${roles}`);
        
        const exchange = getLatestExchange(messages);
        if (!exchange) {
            console.log(`No complete exchange in session ${sessionId.slice(0, 8)}`);
            return;
        }
        
        const userContent = extractMessageContent(exchange.userMessage);
        const assistantContent = extractMessageContent(exchange.assistantMessage);
        
        if (!userContent && !assistantContent) {
            return;
        }
        
        // Check if we already posted this exact content (dedup)
        const lastPosted = lastPostedContent.get(sessionId);
        if (lastPosted && 
            lastPosted.userContent === userContent && 
            lastPosted.assistantContent === assistantContent) {
            console.log(`Already posted this content for session ${sessionId.slice(0, 8)}`);
            return;
        }
        
        // Get or create thread for this session
        let threadId = sessionToThread.get(sessionId);
        
        if (!threadId) {
            const threadName = userContent.slice(0, 50) || 'OpenCode Session';
            console.log(`Creating sync thread: "${threadName}" for session ${sessionId.slice(0, 8)}`);
            
            const thread = await createSyncThread(sessionId, threadName, process.cwd());
            if (!thread) {
                console.error('Failed to create sync thread');
                return;
            }
            threadId = thread.id;
        }
        
        // Post the message exchange to the thread
        console.log(`Posting to thread ${threadId} for session ${sessionId.slice(0, 8)}`);
        await postToSyncThread(threadId, userContent, assistantContent);
        
        // Track what we posted to avoid duplicates
        lastPostedContent.set(sessionId, { userContent, assistantContent });
        
    } catch (error) {
        console.error(`Failed to sync session ${sessionId.slice(0, 8)}:`, error.message);
    }
}

/**
 * Start global event subscription to sync terminal sessions to Discord
 */
async function startGlobalEventSubscription() {
    console.log('Starting global event subscription for session sync...');
    
    try {
        const eventStream = await opencode.global.event();
        
        console.log('Global event subscription established');
        
        // Process events from the stream
        for await (const event of eventStream.stream) {
            try {
                // Events come wrapped in { payload: { type, properties } }
                const payload = event?.payload || event;
                const eventType = payload?.type;
                
                // Debug: log events (skip frequent ones like deltas)
                if (eventType && !['message.part.delta', 'message.part.updated'].includes(eventType)) {
                    console.log(`[SYNC] Event: ${eventType}`, JSON.stringify(payload.properties || {}).slice(0, 200));
                }
                
                // Handle session becoming idle (via session.status event)
                // session.status has: { sessionID, status: { type: "idle" | "busy" } }
                if (eventType === 'session.status') {
                    const sessionId = payload.properties?.sessionID;
                    const statusType = payload.properties?.status?.type;
                    if (sessionId && statusType === 'idle') {
                        console.log(`[SYNC] Session ${sessionId.slice(0, 8)} became idle`);
                        // Use setTimeout to avoid blocking the event loop
                        setTimeout(() => handleSessionIdle(sessionId), 100);
                    }
                }
                
                // Handle session.deleted - clean up mappings
                if (eventType === 'session.deleted') {
                    const sessionId = payload.properties?.sessionId;
                    if (sessionId) {
                        sessionToThread.delete(sessionId);
                        lastPostedContent.delete(sessionId);
                        discordInitiatedSessions.delete(sessionId);
                        // Note: we don't delete threadToSession so replies still work
                    }
                }
            } catch (eventError) {
                console.error('Error processing event:', eventError.message);
            }
        }
    } catch (error) {
        console.error('Global event subscription failed:', error.message);
        // Retry after delay
        console.log('Retrying event subscription in 10 seconds...');
        setTimeout(startGlobalEventSubscription, 10000);
    }
}

// Split long messages for Discord (2000 char limit)
function splitMessage(text, maxLength = 1900) {
    if (text.length <= maxLength) return [text];
    
    const parts = [];
    let remaining = text;
    
    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            parts.push(remaining);
            break;
        }
        
        // Try to split at newline
        let splitIndex = remaining.lastIndexOf('\n', maxLength);
        if (splitIndex === -1 || splitIndex < maxLength / 2) {
            // Try to split at space
            splitIndex = remaining.lastIndexOf(' ', maxLength);
        }
        if (splitIndex === -1 || splitIndex < maxLength / 2) {
            // Force split
            splitIndex = maxLength;
        }
        
        parts.push(remaining.slice(0, splitIndex));
        remaining = remaining.slice(splitIndex).trim();
    }
    
    return parts;
}

// Transcribe voice message using Whisper
async function transcribeVoice(audioBuffer, mimeType) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY not configured for voice transcription');
    }
    
    // Save to temp file
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp3') ? 'mp3' : 'wav';
    const tempFile = path.join(os.tmpdir(), `voice_${Date.now()}.${ext}`);
    fs.writeFileSync(tempFile, audioBuffer);
    
    try {
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFile),
            model: 'whisper-1',
        });
        
        return transcription.text;
    } finally {
        // Clean up temp file
        try {
            fs.unlinkSync(tempFile);
        } catch (e) {
            // Ignore cleanup errors
        }
    }
}

// Handle slash command interactions
client.on('interactionCreate', async (interaction) => {
    // Handle button interactions
    if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
        return;
    }
    
    if (!interaction.isChatInputCommand()) return;
    
    const userId = interaction.user.id;
    
    // Check authorization first (works in both DMs and public channels)
    const auth = await checkUserAuthorized(userId);
    
    // Handle first user setup
    if (auth.isFirstUser) {
        await interaction.reply(
            `You are the first user to message this bot.\n\n` +
            `Adding you as admin (user ID: ${userId}).\n\n` +
            `The bot will restart now. Please message again in a few seconds.`
        );
        addUserToEnvAndExit(userId);
        return;
    }
    
    if (!auth.authorized) {
        await interaction.reply({
            content: auth.reason,
            ephemeral: true
        });
        return;
    }
    
    const { commandName } = interaction;
    
    try {
        switch (commandName) {
            case 'start':
                await handleStartCommand(interaction);
                break;
            case 'new':
                await handleNewCommand(interaction);
                break;
            case 'sessions':
                await handleSessionsCommand(interaction);
                break;
            case 'model':
                await handleModelCommand(interaction);
                break;
            case 'models':
                await handleModelsCommand(interaction);
                break;
            case 'help':
                await handleHelpCommand(interaction);
                break;
            default:
                await interaction.reply('Unknown command');
        }
    } catch (error) {
        console.error(`Error handling command ${commandName}:`, error);
        const errorMessage = `Error: ${error.message}`;
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(errorMessage);
        } else {
            await interaction.reply(errorMessage);
        }
    }
});

// Command handlers
async function handleStartCommand(interaction) {
    const userId = interaction.user.id;
    const currentModel = getUserModel(userId);
    
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Welcome to OpenDiscord!')
        .setDescription('I connect you to OpenCode AI assistant.')
        .addFields(
            { name: 'Current Model', value: `\`${currentModel}\``, inline: false },
            { name: 'Commands', value: 
                '`/new` - Start a new session\n' +
                '`/sessions` - List your sessions\n' +
                '`/models` - Browse available models\n' +
                '`/model` - Show/set current model\n' +
                '`/help` - Show help'
            },
            { name: 'Features', value:
                '**Text messages** - Chat with the AI\n' +
                '**Voice messages** - Send voice to transcribe and chat\n' +
                '**Images** - Send images with optional description for AI analysis'
            }
        )
        .setFooter({ text: 'Just send me any message to start chatting!' });
    
    await interaction.reply({ embeds: [embed] });
}

async function handleNewCommand(interaction) {
    const userId = interaction.user.id;
    
    await interaction.deferReply();
    
    try {
        const { data: newSession } = await opencode.session.create({});
        userSessions.set(userId, newSession.id);
        // Mark as Discord-initiated so we don't sync back to Discord
        discordInitiatedSessions.add(newSession.id);
        
        await interaction.editReply(
            `New session created!\n\n` +
            `Session ID: \`${newSession.id}\`\n\n` +
            `Send me a message to start chatting.`
        );
    } catch (error) {
        await interaction.editReply(`Error creating session: ${error.message}`);
    }
}

async function handleSessionsCommand(interaction) {
    await interaction.deferReply();
    
    try {
        const { data: sessions } = await opencode.session.list();
        
        if (!sessions || sessions.length === 0) {
            await interaction.editReply('No sessions found. Use `/new` to create one.');
            return;
        }
        
        const sessionList = sessions.slice(0, 10).map((s, i) => 
            `${i + 1}. \`${s.id.slice(0, 8)}...\` - ${s.title || 'Untitled'}`
        ).join('\n');
        
        const currentSession = userSessions.get(interaction.user.id);
        
        await interaction.editReply(
            `**Recent sessions:**\n\n${sessionList}\n\n` +
            `Current: \`${currentSession ? currentSession.slice(0, 8) + '...' : 'none'}\``
        );
    } catch (error) {
        await interaction.editReply(`Error listing sessions: ${error.message}`);
    }
}

async function handleModelCommand(interaction) {
    const userId = interaction.user.id;
    const modelArg = interaction.options.getString('model_id');
    const currentModel = getUserModel(userId);
    
    if (modelArg) {
        await interaction.deferReply();
        
        const models = await getAvailableModels();
        const model = models.find(m => 
            m.id === modelArg || 
            m.name.toLowerCase().includes(modelArg.toLowerCase())
        );
        
        if (model) {
            userModels.set(userId, model.id);
            await interaction.editReply(
                `**Model set to:** ${model.name}\n\n` +
                `ID: \`${model.id}\`\n\n` +
                `Your next message will use this model.`
            );
        } else {
            await interaction.editReply(
                `Model "${modelArg}" not found in the available list.\n\n` +
                `Run \`/models\` to see all available models.`
            );
        }
    } else {
        await interaction.reply(
            `**Current Model:**\n\`${currentModel}\`\n\n` +
            `Run \`/models\` to see and select other models.\n` +
            `Or use \`/model model_id:<model-id>\` to set a specific model.`
        );
    }
}

async function handleModelsCommand(interaction) {
    await interaction.deferReply();
    
    const userId = interaction.user.id;
    const currentModel = getUserModel(userId);
    const filter = interaction.options?.getString('filter')?.toLowerCase() || '';
    
    let models = await getAvailableModels();
    
    // Apply filter if provided
    if (filter) {
        models = models.filter(m => 
            m.name.toLowerCase().includes(filter) || 
            m.id.toLowerCase().includes(filter)
        );
    }
    
    if (models.length === 0) {
        const msg = filter 
            ? `No models found matching "${filter}". Try a different filter.`
            : 'Unable to load models. Please try again later.';
        await interaction.editReply(msg);
        return;
    }
    
    // Create a button map for this interaction (maps button index -> model)
    const buttonMap = new Map();
    
    // Create buttons for first 25 models (Discord limit)
    const rows = [];
    const pageSize = 5; // 5 buttons per row
    const maxButtons = 20; // 4 rows of 5 buttons
    
    for (let i = 0; i < Math.min(models.length, maxButtons); i += pageSize) {
        const row = new ActionRowBuilder();
        
        for (let j = i; j < Math.min(i + pageSize, models.length, maxButtons); j++) {
            const model = models[j];
            const isSelected = model.id === currentModel;
            
            // Store model in button map
            buttonMap.set(j, model);
            
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`model_${j}`)
                    .setLabel(model.name.slice(0, 80))
                    .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary)
            );
        }
        
        rows.push(row);
    }
    
    // Add navigation if more models (store remaining models for pagination)
    if (models.length > maxButtons) {
        // Store all models for pagination
        for (let j = maxButtons; j < models.length; j++) {
            buttonMap.set(j, models[j]);
        }
        
        const navRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('models_page_1')
                    .setLabel(`More models (${maxButtons + 1}-${Math.min(models.length, maxButtons * 2)})`)
                    .setStyle(ButtonStyle.Primary)
            );
        rows.push(navRow);
    }
    
    const filterMsg = filter ? ` matching "${filter}"` : '';
    const reply = await interaction.editReply({
        content: `**Available Models${filterMsg}** (${models.length} total)\n\nTap a model to select it.\n\nCurrent: \`${currentModel}\``,
        components: rows
    });
    
    // Store the button map keyed by the interaction ID
    modelButtonMaps.set(interaction.id, buttonMap);
    
    // Clean up old maps after 10 minutes
    setTimeout(() => modelButtonMaps.delete(interaction.id), 10 * 60 * 1000);
}

async function handleHelpCommand(interaction) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('OpenDiscord Help')
        .setDescription('This bot connects you to OpenCode AI assistant.')
        .addFields(
            { name: 'Commands', value:
                '`/start` - Welcome message\n' +
                '`/new` - Start a new chat session\n' +
                '`/sessions` - List recent sessions\n' +
                '`/model` - Show current model and set a new one\n' +
                '`/models` - Browse and select available models\n' +
                '`/help` - Show this help'
            },
            { name: 'Features', value:
                '**Text Messages** - Send any text to chat with the AI\n' +
                '**Voice Messages** - Send a voice note to transcribe and chat\n' +
                '**Images** - Send images with optional description for AI analysis'
            },
            { name: 'How to use', value:
                '- Send text messages to chat with OpenCode AI\n' +
                '- Send voice messages to transcribe and get AI responses\n' +
                '- Send images with optional captions for AI image analysis'
            },
            { name: 'Tips', value:
                '- Use `/new` to start fresh\n' +
                '- Long responses may be split into multiple messages\n' +
                '- Voice messages are transcribed using OpenAI Whisper'
            }
        );
    
    await interaction.reply({ embeds: [embed] });
}

// Handle button interactions
async function handleButtonInteraction(interaction) {
    const userId = interaction.user.id;
    const customId = interaction.customId;
    
    // Handle model selection
    if (customId.startsWith('model_')) {
        const idx = parseInt(customId.replace('model_', ''), 10);
        
        // Try to find the model from stored button maps
        // Check by message reference (the original interaction that created the buttons)
        let model = null;
        
        // Look through all button maps to find one that has this index
        for (const [interactionId, buttonMap] of modelButtonMaps) {
            if (buttonMap.has(idx)) {
                model = buttonMap.get(idx);
                break;
            }
        }
        
        if (model) {
            userModels.set(userId, model.id);
            
            await interaction.update({
                content: `**Model Changed**\n\n**${model.name}**\n\`${model.id}\`\n\nYour next message will use this model.`,
                components: []
            });
        } else {
            await interaction.reply({
                content: 'Model selection expired. Please run `/models` again.',
                ephemeral: true
            });
        }
        return;
    }
    
    // Handle pagination
    if (customId.startsWith('models_page_')) {
        const page = parseInt(customId.replace('models_page_', ''), 10);
        const pageSize = 20;
        const start = page * pageSize;
        const currentModel = getUserModel(userId);
        
        const models = await getAvailableModels();
        const pageModels = models.slice(start, start + pageSize);
        
        // Create a new button map for this page
        const buttonMap = new Map();
        
        const rows = [];
        const buttonsPerRow = 5;
        
        for (let i = 0; i < pageModels.length; i += buttonsPerRow) {
            const row = new ActionRowBuilder();
            
            for (let j = i; j < Math.min(i + buttonsPerRow, pageModels.length); j++) {
                const model = pageModels[j];
                const globalIdx = start + j;
                const isSelected = model.id === currentModel;
                
                // Store in button map
                buttonMap.set(globalIdx, model);
                
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`model_${globalIdx}`)
                        .setLabel(model.name.slice(0, 80))
                        .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary)
                );
            }
            
            rows.push(row);
        }
        
        // Add navigation
        const navRow = new ActionRowBuilder();
        
        if (page > 0) {
            navRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`models_page_${page - 1}`)
                    .setLabel('Previous')
                    .setStyle(ButtonStyle.Primary)
            );
        }
        
        if (start + pageSize < models.length) {
            navRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`models_page_${page + 1}`)
                    .setLabel('Next')
                    .setStyle(ButtonStyle.Primary)
            );
        }
        
        if (navRow.components.length > 0) {
            rows.push(navRow);
        }
        
        await interaction.update({
            content: `**Available Models** (${models.length} total, showing ${start + 1}-${Math.min(start + pageSize, models.length)})\n\nTap a model to select it.\n\nCurrent: \`${currentModel}\``,
            components: rows
        });
        
        // Store button map for this interaction
        modelButtonMaps.set(interaction.id, buttonMap);
        setTimeout(() => modelButtonMaps.delete(interaction.id), 10 * 60 * 1000);
    }
}

// Handle regular DM messages
client.on('messageCreate', async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;
    
    // Handle DMs, mentions in public channels, or messages in subscribed threads
    const isDM = message.channel.isDMBased();
    const isMentioned = message.mentions.has(client.user);
    const isInSubscribedThread = message.channel.isThread() && subscribedThreads.has(message.channel.id);
    
    // If not a DM, not mentioned, and not in a subscribed thread, ignore
    if (!isDM && !isMentioned && !isInSubscribedThread) return;
    
    // Ignore messages from before bot start
    if (message.createdTimestamp < botStartTime) return;
    
    const userId = message.author.id;
    
    // Check authorization
    const auth = await checkUserAuthorized(userId);
    
    // Handle first user setup
    if (auth.isFirstUser) {
        await message.reply(
            `You are the first user to message this bot.\n\n` +
            `Adding you as admin (user ID: ${userId}).\n\n` +
            `The bot will restart now. Please message again in a few seconds.`
        );
        addUserToEnvAndExit(userId);
        return;
    }
    
    if (!auth.authorized) {
        await message.reply(auth.reason);
        return;
    }
    
    // Check if this is a reply in a sync thread (OpenCode session sync)
    if (message.channel.isThread() && threadToSession.has(message.channel.id)) {
        // This is a sync thread - forward to OpenCode instead of normal handling
        const content = message.content?.trim();
        if (content) {
            await message.react('⏳');
            try {
                await handleSyncThreadReply(message.channel.id, message, content);
                await message.reactions.cache.get('⏳')?.remove();
                await message.react('✅');
            } catch (error) {
                await message.reactions.cache.get('⏳')?.remove();
                await message.react('❌');
                console.error('Error handling sync thread reply:', error);
            }
        }
        return;
    }
    
    // Check for voice messages
    const voiceAttachment = message.attachments.find(att => 
        att.contentType?.startsWith('audio/') ||
        att.name?.endsWith('.ogg') ||
        att.name?.endsWith('.mp3') ||
        att.name?.endsWith('.wav') ||
        att.name?.endsWith('.m4a')
    );
    
    // Check for image attachments
    const imageAttachments = message.attachments.filter(att =>
        att.contentType?.startsWith('image/')
    );
    
    try {
        // Add hourglass reaction to show we're processing
        await message.react('⏳');
        
        // Get or create session
        let sessionId = userSessions.get(userId);
        
        if (!sessionId) {
            const { data: newSession } = await opencode.session.create({});
            sessionId = newSession.id;
            userSessions.set(userId, sessionId);
            // Mark as Discord-initiated so we don't sync back to Discord
            discordInitiatedSessions.add(sessionId);
        }
        
        // Handle voice message
        if (voiceAttachment) {
            await handleVoiceMessage(message, voiceAttachment, sessionId);
            return;
        }
        
        // Handle image message
        if (imageAttachments.size > 0) {
            await handleImageMessage(message, imageAttachments, sessionId);
            return;
        }
        
        // Handle text message
        if (message.content) {
            await handleTextMessage(message, sessionId);
        }
        
    } catch (error) {
        console.error('Error processing message:', error);
        // Remove hourglass on error
        try {
            await message.reactions.cache.get('⏳')?.users.remove(client.user.id);
        } catch (e) { /* ignore */ }
        await message.reply(`Error: ${error.message}`);
    }
});

// Handle text messages
async function handleTextMessage(message, sessionId) {
    const userId = message.author.id;
    // Strip bot mention from message content if present
    let text = message.content.replace(/<@!?\d+>/g, '').trim();
    
    // If message is empty after stripping mentions, ignore
    if (!text) return;
    
    // Send typing indicator
    await message.channel.sendTyping();
    
    // Send message to OpenCode
    const userModel = getUserModel(userId);
    const modelObj = parseModelId(userModel);
    
    const response = await sendPrompt(
        sessionId,
        [{ type: 'text', text }],
        modelObj
    );
    
    console.log(`Prompt with model ${userModel}, response received`);
    
    const responseText = extractResponseText(response);
    
    if (responseText) {
        // Only send the last section of the response (users don't read all details)
        const parts = splitMessage(responseText);
        const lastPart = parts[parts.length - 1];
        const prefix = parts.length > 1 ? `... (${parts.length - 1} sections omitted)\n\n` : '';
        await message.reply(prefix + lastPart);
        
        // Parse file changes and post to changelog
        const filesChanged = parseFileChanges(responseText);
        if (filesChanged.length > 0) {
            // Create a brief summary (first 200 chars of response)
            const summary = responseText.slice(0, 200) + (responseText.length > 200 ? '...' : '');
            await postChangelog(userId, summary, filesChanged);
        }
    } else {
        await message.reply('No response received. Please try again.');
    }
    
    // Remove hourglass reaction after completion
    try {
        await message.reactions.cache.get('⏳')?.users.remove(client.user.id);
    } catch (e) { /* ignore */ }
}

// Handle voice messages
async function handleVoiceMessage(message, attachment, sessionId) {
    const userId = message.author.id;
    
    if (!process.env.OPENAI_API_KEY) {
        await message.reply('Voice input is not configured. Please add OPENAI_API_KEY to the environment.');
        return;
    }
    
    // Send typing indicator
    await message.channel.sendTyping();
    
    // Download the voice file
    const response = await fetch(attachment.url);
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    
    // Transcribe
    const transcribedText = await transcribeVoice(audioBuffer, attachment.contentType || 'audio/ogg');
    
    if (!transcribedText || transcribedText.trim().length === 0) {
        await message.reply('Could not transcribe the voice message. Please try again.');
        return;
    }
    
    // Show transcription
    await message.reply(`**Voice Transcription:**\n*${transcribedText}*`);
    
    // Send typing indicator again
    await message.channel.sendTyping();
    
    // Send to OpenCode
    const userModel = getUserModel(userId);
    const modelObj = parseModelId(userModel);
    
    const aiResponse = await sendPrompt(
        sessionId,
        [{ type: 'text', text: transcribedText }],
        modelObj
    );
    
    const responseText = extractResponseText(aiResponse);
    
    if (responseText) {
        // Only send the last section of the response (users don't read all details)
        const parts = splitMessage(responseText);
        const lastPart = parts[parts.length - 1];
        const prefix = parts.length > 1 ? `... (${parts.length - 1} sections omitted)\n\n` : '';
        await message.reply(prefix + lastPart);
        
        // Parse file changes and post to changelog
        const filesChanged = parseFileChanges(responseText);
        if (filesChanged.length > 0) {
            const summary = responseText.slice(0, 200) + (responseText.length > 200 ? '...' : '');
            await postChangelog(userId, summary, filesChanged);
        }
    } else {
        await message.reply('No response received. Please try again.');
    }
    
    // Remove hourglass reaction after completion
    try {
        await message.reactions.cache.get('⏳')?.users.remove(client.user.id);
    } catch (e) { /* ignore */ }
}

// Handle image messages
async function handleImageMessage(message, imageAttachments, sessionId) {
    const userId = message.author.id;
    const caption = message.content || 'What do you see in this image?';
    
    console.log(`[IMAGE] Received ${imageAttachments.size} image(s) from user ${userId}`);
    console.log(`[IMAGE] Caption: "${caption}"`);
    
    // Send typing indicator
    await message.channel.sendTyping();
    
    // Prepare message parts - text first, then images (order matters for vision models)
    const parts = [];
    parts.push({ type: 'text', text: caption });
    console.log(`[IMAGE] Added text part: "${caption}"`);
    
    // Ensure uploads directory exists
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    // Add images
    const MAX_IMAGE_SIZE = 1024 * 1024; // 1MB max to avoid 413 errors from AI providers
    const MAX_DIMENSION = 2048; // Max width/height for resizing
    
    for (const [, attachment] of imageAttachments) {
        console.log(`[IMAGE] Processing attachment: ${attachment.name}, type: ${attachment.contentType}, size: ${attachment.size} bytes`);
        
        // Download image from Discord CDN
        console.log(`[IMAGE] Downloading from: ${attachment.url.substring(0, 80)}...`);
        const response = await fetch(attachment.url);
        let imageBuffer = Buffer.from(await response.arrayBuffer());
        console.log(`[IMAGE] Downloaded ${imageBuffer.length} bytes`);
        
        // Resize if image is too large
        if (imageBuffer.length > MAX_IMAGE_SIZE) {
            console.log(`[IMAGE] Image too large (${imageBuffer.length} bytes), resizing...`);
            try {
                // Get image metadata
                const metadata = await sharp(imageBuffer).metadata();
                console.log(`[IMAGE] Original dimensions: ${metadata.width}x${metadata.height}`);
                
                // Calculate new dimensions maintaining aspect ratio
                let newWidth = metadata.width;
                let newHeight = metadata.height;
                
                if (newWidth > MAX_DIMENSION || newHeight > MAX_DIMENSION) {
                    if (newWidth > newHeight) {
                        newHeight = Math.round(newHeight * (MAX_DIMENSION / newWidth));
                        newWidth = MAX_DIMENSION;
                    } else {
                        newWidth = Math.round(newWidth * (MAX_DIMENSION / newHeight));
                        newHeight = MAX_DIMENSION;
                    }
                }
                
                // Resize and compress - always output as JPEG for better compression
                imageBuffer = await sharp(imageBuffer)
                    .resize(newWidth, newHeight, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 80 })
                    .toBuffer();
                
                console.log(`[IMAGE] Resized to ${newWidth}x${newHeight}, new size: ${imageBuffer.length} bytes`);
            } catch (resizeError) {
                console.log(`[IMAGE] Resize failed: ${resizeError.message}, using original`);
            }
        }
        
        // Save to uploads folder with unique filename
        // Use jpeg extension if we resized (since we convert to jpeg)
        const wasResized = imageBuffer.length <= MAX_IMAGE_SIZE && attachment.size > MAX_IMAGE_SIZE;
        const ext = wasResized ? 'jpeg' : (attachment.contentType?.split('/')[1] || 'png');
        const fileName = `image_${userId}_${Date.now()}.${ext}`;
        const uploadPath = path.join(uploadsDir, fileName);
        fs.writeFileSync(uploadPath, imageBuffer);
        console.log(`[IMAGE] Saved to: ${uploadPath}`);
        
        // Determine MIME type
        const mimeType = wasResized ? 'image/jpeg' : (attachment.contentType || (ext === 'png' ? 'image/png' : 'image/jpeg'));
        const fileUrl = `file://${uploadPath}`;
        console.log(`[IMAGE] Using file URL: ${fileUrl}, MIME type: ${mimeType}`);
        
        parts.push({
            type: 'file',
            mime: mimeType,
            url: fileUrl,
            filename: fileName
        });
        console.log(`[IMAGE] Added file part to request`);
    }
    
    // Send to OpenCode
    const userModel = getUserModel(userId);
    const modelObj = parseModelId(userModel);
    console.log(`[IMAGE] User model: ${userModel}`);
    console.log(`[IMAGE] Session ID: ${sessionId}`);
    console.log(`[IMAGE] Sending ${parts.length} parts to OpenCode...`);
    
    const aiResponse = await sendPrompt(sessionId, parts, modelObj);
    console.log(`[IMAGE] OpenCode response received`);
    
    const responseText = extractResponseText(aiResponse);
    
    if (responseText && responseText.trim()) {
        // Only send the last section of the response (users don't read all details)
        const msgParts = splitMessage(responseText);
        const lastPart = msgParts[msgParts.length - 1];
        const prefix = msgParts.length > 1 ? `... (${msgParts.length - 1} sections omitted)\n\n` : '';
        await message.reply(prefix + lastPart);
        
        // Parse file changes and post to changelog
        const filesChanged = parseFileChanges(responseText);
        if (filesChanged.length > 0) {
            const summary = responseText.slice(0, 200) + (responseText.length > 200 ? '...' : '');
            await postChangelog(userId, summary, filesChanged);
        }
    } else {
        console.log(`[IMAGE] Empty response from AI - model may not support vision`);
        await message.reply('The AI model returned an empty response. This model may not support image analysis. Try using a vision-capable model with `/model`.');
    }
    
    // Remove hourglass reaction after completion
    try {
        await message.reactions.cache.get('⏳')?.users.remove(client.user.id);
    } catch (e) { /* ignore */ }
}

// Bot ready event
client.once('ready', async () => {
    console.log(`Discord bot logged in as ${client.user.tag}`);
    console.log(`Bot is in ${client.guilds.cache.size} guild(s)`);
    
    // Log guild info
    const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
    if (guild) {
        console.log(`Connected to guild: ${guild.name} (${guild.id})`);
        
        // Ensure changelog channel exists
        await ensureChangelogChannel();
        
        // Ensure sync channel exists for OpenCode session sync
        await ensureSyncChannel();
        
        // Start global event subscription for terminal session sync
        startGlobalEventSubscription();
    } else {
        console.warn(`Warning: Could not find guild with ID ${process.env.DISCORD_GUILD_ID}`);
    }
    
    // Start git webhook server (also handles sync endpoints)
    startGitWebhookServer();
});

// Handle thread creation - subscribe to threads created on bot messages
client.on('threadCreate', async (thread) => {
    try {
        // Fetch the parent message that the thread was created on
        if (thread.parentId) {
            const parentChannel = thread.parent;
            if (parentChannel && thread.id) {
                // The thread's ID is also the starter message's ID in Discord
                // We need to check if the starter message was from this bot
                try {
                    const starterMessage = await thread.fetchStarterMessage();
                    if (starterMessage && starterMessage.author.id === client.user.id) {
                        subscribedThreads.add(thread.id);
                        console.log(`Subscribed to thread: ${thread.name} (${thread.id})`);
                        
                        // Join the thread to ensure we receive messages
                        if (thread.joinable) {
                            await thread.join();
                        }
                    }
                } catch (err) {
                    // If we can't fetch starter message, check if it's a reply thread to bot
                    console.log(`Could not fetch starter message for thread ${thread.id}:`, err.message);
                }
            }
        }
    } catch (error) {
        console.error('Error handling thread creation:', error);
    }
});

// Git webhook server for changelog notifications
const GIT_WEBHOOK_PORT = process.env.GIT_WEBHOOK_PORT || 4099;
const CHANGELOG_CHANNEL_ID = '1474467379692961926';

async function postGitCommit(commitData) {
    let channel;
    try {
        channel = await client.channels.fetch(CHANGELOG_CHANNEL_ID);
    } catch (error) {
        console.error(`Failed to fetch changelog channel:`, error.message);
        return false;
    }
    
    const { hash, message, author, branch, files } = commitData;
    
    // Color based on commit type
    let color = 0x5865F2;
    const lowerMsg = message.toLowerCase();
    if (lowerMsg.startsWith('fix') || lowerMsg.includes('bug')) {
        color = 0xED4245;
    } else if (lowerMsg.startsWith('add') || lowerMsg.startsWith('feat')) {
        color = 0x57F287;
    } else if (lowerMsg.startsWith('update') || lowerMsg.startsWith('refactor')) {
        color = 0xFEE75C;
    }
    
    let filesStr = 'No files detected';
    if (files && files.length > 0) {
        filesStr = files.slice(0, 15).map(f => `\`${f}\``).join('\n');
        if (files.length > 15) filesStr += `\n... and ${files.length - 15} more`;
    }
    
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('Git Commit')
        .setDescription(`\`\`\`${message}\`\`\``)
        .addFields(
            { name: 'Commit', value: `\`${hash.slice(0, 7)}\``, inline: true },
            { name: 'Branch', value: `\`${branch || 'main'}\``, inline: true },
            { name: 'Author', value: author || 'Unknown', inline: true }
        )
        .setTimestamp()
        .setFooter({ text: 'OpenDiscord Git Hook' });
    
    if (files && files.length > 0) {
        embed.addFields({ name: `Files (${files.length})`, value: filesStr, inline: false });
    }
    
    try {
        await channel.send({ embeds: [embed] });
        console.log(`Posted git commit ${hash.slice(0, 7)} to changelog`);
        return true;
    } catch (error) {
        console.error('Failed to post to changelog:', error.message);
        return false;
    }
}

function startGitWebhookServer() {
    // Helper to parse JSON body
    const parseBody = (req) => new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
    
    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
        
        // Health check
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', syncChannel: syncChannel?.id || null }));
            return;
        }
        
        // Git commit webhook
        if (req.method === 'POST' && req.url === '/git-commit') {
            try {
                const commitData = await parseBody(req);
                if (!commitData.hash || !commitData.message) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing hash or message' }));
                    return;
                }
                const success = await postGitCommit(commitData);
                res.writeHead(success ? 200 : 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success }));
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
            return;
        }
        
        // ============================================
        // OpenCode Sync Endpoints
        // ============================================
        
        // POST /sync/session - Create a new sync thread for an OpenCode session
        if (req.method === 'POST' && req.url === '/sync/session') {
            try {
                const data = await parseBody(req);
                const { sessionId, title, directory } = data;
                
                if (!sessionId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing sessionId' }));
                    return;
                }
                
                // Check if thread already exists for this session
                if (sessionToThread.has(sessionId)) {
                    const existingThreadId = sessionToThread.get(sessionId);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, threadId: existingThreadId, existing: true }));
                    return;
                }
                
                // Create new thread
                const thread = await createSyncThread(sessionId, title || 'OpenCode Session', directory);
                
                if (thread) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, threadId: thread.id }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to create thread' }));
                }
            } catch (error) {
                console.error('Error in /sync/session:', error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
            return;
        }
        
        // POST /sync/message - Post a message exchange to a sync thread
        if (req.method === 'POST' && req.url === '/sync/message') {
            try {
                const data = await parseBody(req);
                const { sessionId, threadId, userContent, assistantContent } = data;
                
                // Get thread ID from sessionId if not provided
                let targetThreadId = threadId;
                if (!targetThreadId && sessionId) {
                    targetThreadId = sessionToThread.get(sessionId);
                }
                
                if (!targetThreadId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing threadId or sessionId not mapped' }));
                    return;
                }
                
                const success = await postToSyncThread(targetThreadId, userContent, assistantContent);
                res.writeHead(success ? 200 : 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success }));
            } catch (error) {
                console.error('Error in /sync/message:', error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
            return;
        }
        
        // GET /sync/status - Get sync status and mappings (for debugging)
        if (req.method === 'GET' && req.url === '/sync/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                syncChannelId: syncChannel?.id || null,
                syncChannelName: syncChannel?.name || null,
                activeSessions: sessionToThread.size,
                sessions: Object.fromEntries(sessionToThread)
            }));
            return;
        }
        
        // 404 for unknown routes
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });
    
    server.listen(GIT_WEBHOOK_PORT, '127.0.0.1', () => {
        console.log(`Webhook server listening on http://127.0.0.1:${GIT_WEBHOOK_PORT}`);
        console.log(`  - POST /git-commit     - Git commit notifications`);
        console.log(`  - POST /sync/session   - Create sync thread for OpenCode session`);
        console.log(`  - POST /sync/message   - Post message to sync thread`);
        console.log(`  - GET  /sync/status    - Get sync status`);
        console.log(`  - GET  /health         - Health check`);
    });
}

// Error handling
client.on('error', (error) => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

// Login to Discord
client.login(process.env.DISCORD_BOT_TOKEN);
