import { config } from 'dotenv';
config();

import { SlashCommandBuilder } from '@discordjs/builders';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v9';

const clientId = process.env.DISCORD_CLIENT_ID as string;
const guildId = process.env.DISCORD_GUILD_ID as string;
const token = process.env.DISCORD_TOKEN as string;

const commands = [
	new SlashCommandBuilder()
    .setName('request-goeth')
    .setDescription('Request 32.5 Goerli ETH (GoETH) to be transfered into your wallet.')
    .addStringOption(option => option
      .setName('address')
      .setDescription('A valid Ethereum address. It can be a full address or an ENS.')
      .setRequired(true)),
	new SlashCommandBuilder().setName('ping').setDescription('Replies with pong!'),
]
	.map(command => command.toJSON());

const rest = new REST({ version: '9' }).setToken(token);

// Delete existing commands
/*rest.get(Routes.applicationGuildCommands(clientId, guildId))
  .then((retCommands: unknown) => {
    const objCommands = retCommands as Array<object>;
    let k: keyof typeof retCommands;
    for (const k in objCommands) {
      const command = objCommands[k];
      console.log(command);
      const values = Object.values(command);
      const commandId = values[0];

      rest.delete(Routes.applicationGuildCommand(clientId, guildId, commandId))
        .then(() => console.log(`Successfully deleted ${commandId}.`))
        .catch(console.error);

    }
  });*/

// Register new commands
rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands })
	.then(() => console.log('Successfully registered application commands.'))
	.catch(console.error);