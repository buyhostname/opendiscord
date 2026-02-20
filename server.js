import 'dotenv/config';
import { createOpencodeServer } from '@opencode-ai/sdk/server';

const hostname = process.env.OPENCODE_HOST || '127.0.0.1';
const port = parseInt(process.env.OPENCODE_PORT) || 4096;

async function start() {
    const model = process.env.OPENCODE_MODEL || 'opencode/minimax-m2.5-free';
    console.log(`Starting OpenCode server on ${hostname}:${port} with model: ${model}...`);
    
    try {
        const server = await createOpencodeServer({
            hostname,
            port,
            timeout: 30000,
            model
        });
        
        console.log(`OpenCode server listening on ${server.url}`);
        
        // Keep process alive
        process.on('SIGINT', () => {
            console.log('Shutting down OpenCode server...');
            server.close();
            process.exit(0);
        });
        
        process.on('SIGTERM', () => {
            console.log('Shutting down OpenCode server...');
            server.close();
            process.exit(0);
        });
        
    } catch (error) {
        console.error('Failed to start OpenCode server:', error.message);
        process.exit(1);
    }
}

start();
