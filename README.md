# OpenDiscord

Discord bot that connects to OpenCode AI server, enabling AI chat via Discord DMs with support for text, voice, and images. Changes are logged to a changelog channel.

## Features

- **Text messages** - Chat with AI models via DM
- **Voice messages** - Transcribed via OpenAI Whisper and sent to AI
- **Images** - AI vision analysis with optional captions
- **Model switching** - Browse and select from available AI models
- **Session management** - Create and switch between chat sessions
- **Changelog** - All codebase changes posted to a dedicated channel
- **Role-based access** - Admin and edit roles control who can use the bot

## Quick Start

Deploy on [hoston.ai](https://hoston.ai) - paste this:

```
copy this project and setup https://github.com/buyhostname/opendiscord
```

## Manual Setup

1. Create a Discord application at https://discord.com/developers/applications
2. Add a bot and get the token
3. Enable Message Content Intent and Server Members Intent
4. Invite bot to your server with proper permissions
5. Clone this repo and configure `.env`
6. Run `npm install && npm run deploy && npm run client`

See [AGENTS.md](AGENTS.md) for detailed step-by-step instructions.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DISCORD_BOT_TOKEN` | Bot token from Developer Portal | Yes |
| `DISCORD_CLIENT_ID` | Application ID | Yes |
| `DISCORD_GUILD_ID` | Your server's ID | Yes |
| `DISCORD_CHANGELOG_CHANNEL` | Channel for logging changes | No (default: changelog) |
| `DISCORD_ADMIN_ROLE` | Admin role name | No (default: admin) |
| `DISCORD_EDIT_ROLE` | Edit role name | No (default: edit) |
| `OPENCODE_HOST` | OpenCode server host | No (default: 127.0.0.1) |
| `OPENCODE_PORT` | OpenCode server port | No (default: 4097) |
| `OPENCODE_MODEL` | Default AI model | No |
| `SESSION_SECRET` | Session secret | Yes |
| `OPENAI_API_KEY` | OpenAI API key for Whisper | No (required for voice) |

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and feature overview |
| `/new` | Create a new chat session |
| `/sessions` | List recent sessions |
| `/model` | Show/set current AI model |
| `/models` | Browse available models with buttons |
| `/help` | Show help information |

## How It Works

1. Users DM the bot with text, voice, or images
2. Bot verifies user is in the configured server with proper role
3. Messages are forwarded to OpenCode AI server
4. Responses are sent back to the user
5. Any codebase changes are logged to the changelog channel

## Requirements

- Node.js 18+
- OpenCode server running
- Discord bot with proper intents enabled

## Running with PM2

```bash
pm2 start "npm run server" --name "opendiscord-server" --time
pm2 start "npm run client" --name "opendiscord-client" --time
```

## License

MIT
