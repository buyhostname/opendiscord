import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file
dotenv.config({ path: path.join(__dirname, '.env'), override: true });

const WEBHOOK_PORT = process.env.GIT_WEBHOOK_PORT || 4099;
const CHANGELOG_CHANNEL_ID = '1474467379692961926'; // Hardcoded changelog channel ID

// Discord client (minimal intents for just sending messages)
const discord = new Client({
    intents: [GatewayIntentBits.Guilds]
});

let changelogChannel = null;

// Post git commit to changelog
async function postGitCommit(commitData) {
    if (!changelogChannel) {
        console.error('Changelog channel not available');
        return false;
    }
    
    const { hash, message, author, branch, files, additions, deletions } = commitData;
    
    // Determine color based on commit type
    let color = 0x5865F2; // Default blurple
    const lowerMsg = message.toLowerCase();
    if (lowerMsg.startsWith('fix') || lowerMsg.includes('bug')) {
        color = 0xED4245; // Red for fixes
    } else if (lowerMsg.startsWith('add') || lowerMsg.startsWith('feat')) {
        color = 0x57F287; // Green for new features
    } else if (lowerMsg.startsWith('update') || lowerMsg.startsWith('refactor')) {
        color = 0xFEE75C; // Yellow for updates
    } else if (lowerMsg.startsWith('remove') || lowerMsg.startsWith('delete')) {
        color = 0xED4245; // Red for deletions
    }
    
    // Build file changes string
    let filesStr = 'No files detected';
    if (files && files.length > 0) {
        filesStr = files.slice(0, 15).map(f => `\`${f}\``).join('\n');
        if (files.length > 15) {
            filesStr += `\n... and ${files.length - 15} more`;
        }
    }
    
    // Build stats string
    let stats = '';
    if (additions !== undefined || deletions !== undefined) {
        stats = `+${additions || 0} / -${deletions || 0}`;
    }
    
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`Git Commit`)
        .setDescription(`\`\`\`${message}\`\`\``)
        .addFields(
            { name: 'Commit', value: `\`${hash.slice(0, 7)}\``, inline: true },
            { name: 'Branch', value: `\`${branch || 'main'}\``, inline: true },
            { name: 'Author', value: author || 'Unknown', inline: true }
        )
        .setTimestamp()
        .setFooter({ text: 'OpenDiscord Git Hook' });
    
    // Add files field if there are any
    if (files && files.length > 0) {
        embed.addFields({ name: `Files Changed (${files.length})`, value: filesStr, inline: false });
    }
    
    // Add stats if available
    if (stats) {
        embed.addFields({ name: 'Changes', value: stats, inline: true });
    }
    
    try {
        await changelogChannel.send({ embeds: [embed] });
        console.log(`Posted git commit ${hash.slice(0, 7)} to changelog`);
        return true;
    } catch (error) {
        console.error('Failed to post to changelog:', error.message);
        return false;
    }
}

// HTTP server to receive webhook requests
const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    if (req.method === 'POST' && req.url === '/git-commit') {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            try {
                const commitData = JSON.parse(body);
                
                if (!commitData.hash || !commitData.message) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing required fields: hash, message' }));
                    return;
                }
                
                const success = await postGitCommit(commitData);
                
                if (success) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to post to Discord' }));
                }
            } catch (error) {
                console.error('Error processing webhook:', error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            discord: changelogChannel ? 'connected' : 'disconnected',
            channel: CHANGELOG_CHANNEL_ID
        }));
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
});

// Discord ready event
discord.once('ready', async () => {
    console.log(`Git webhook Discord client logged in as ${discord.user.tag}`);
    
    // Get the changelog channel
    try {
        changelogChannel = await discord.channels.fetch(CHANGELOG_CHANNEL_ID);
        console.log(`Connected to changelog channel: #${changelogChannel.name}`);
    } catch (error) {
        console.error(`Failed to fetch changelog channel ${CHANGELOG_CHANNEL_ID}:`, error.message);
    }
    
    // Start HTTP server
    server.listen(WEBHOOK_PORT, '127.0.0.1', () => {
        console.log(`Git webhook server listening on http://127.0.0.1:${WEBHOOK_PORT}`);
        console.log(`POST /git-commit - Receive git commit notifications`);
        console.log(`GET /health - Health check`);
    });
});

// Error handling
discord.on('error', (error) => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

// Login to Discord
discord.login(process.env.DISCORD_BOT_TOKEN);
