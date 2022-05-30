import { config } from 'dotenv';
config();

import { Client, Intents } from 'discord.js';

const client = new Client({ intents: [Intents.FLAGS.GUILDS] });

client.on('ready', () => {
  console.log(`Logged in as ${client.user?.tag}!`);
});

client.login(process.env.DISCORD_TOKEN).then(() => {
  console.log('Discord login successful!');
}).catch((error) => {
  console.log(`Error during Discord login: ${error.message}`);
});