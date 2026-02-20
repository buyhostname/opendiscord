import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Welcome message and feature overview'),
    
    new SlashCommandBuilder()
        .setName('new')
        .setDescription('Create a new chat session'),
    
    new SlashCommandBuilder()
        .setName('sessions')
        .setDescription('List your recent sessions'),
    
    new SlashCommandBuilder()
        .setName('model')
        .setDescription('Show or set the current AI model')
        .addStringOption(option =>
            option.setName('model_id')
                .setDescription('Model ID to switch to (optional)')
                .setRequired(false)
        ),
    
    new SlashCommandBuilder()
        .setName('models')
        .setDescription('Browse and select available AI models'),
    
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show help information'),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

async function deployCommands() {
    try {
        console.log(`Started refreshing ${commands.length} application (/) commands.`);

        // Register commands globally (works in all servers the bot is in)
        const data = await rest.put(
            Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
            { body: commands },
        );

        console.log(`Successfully reloaded ${data.length} application (/) commands.`);
        
        // Also register to specific guild for instant availability during development
        if (process.env.DISCORD_GUILD_ID) {
            await rest.put(
                Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
                { body: commands },
            );
            console.log(`Also registered commands to guild ${process.env.DISCORD_GUILD_ID} for instant availability.`);
        }
    } catch (error) {
        console.error('Error deploying commands:', error);
    }
}

deployCommands();
