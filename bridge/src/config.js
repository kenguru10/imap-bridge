import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const configPath = process.env.CONFIG_PATH || join(__dirname, '..', 'config.json');

if (!existsSync(configPath)) {
  throw new Error(`Config file not found: ${configPath}`);
}

const raw = readFileSync(configPath, 'utf8');
const config = JSON.parse(raw);

export default config;
