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
    .setName('request-sepolia-eth')
    .setDescription('Request some funds for transactions on the Sepolia testnet to be transfered into your wallet.')
    .addStringOption(option => option
      .setName('address')
      .setDescription('A valid Ethereum address. It can be a full address or an ENS.')
      .setRequired(true)),
	new SlashCommandBuilder().setName('ping').setDescription('Replies with pong!'),
  new SlashCommandBuilder().setName('queue-mainnet')
    .setDescription('Get validators activation and exit queue details from Mainnet.'),
  new SlashCommandBuilder().setName('queue-goerli')
    .setDescription('Get validators activation and exit queue details from Goerli testnet.'),
  new SlashCommandBuilder().setName('queue-holesky')
    .setDescription('Get validators activation and exit queue details from Holesky testnet.'),
  new SlashCommandBuilder().setName('participation-mainnet')
    .setDescription('Get the current participation rate on Mainnet.'),
  new SlashCommandBuilder()
    .setName('participation-mainnet-auto')
    .setDescription('Auto post the current participation rate on Mainnet. Only for my master.')
    .addBooleanOption(option => option
      .setName('enabled')
      .setDescription('Enable or disable auto posting the participation rate.')
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName('goerli-msg')
    .setDescription('Explain how to do a validator deposit or get ETH on Goerli.')
    .addUserOption(option => option
      .setName('user')
      .setDescription('An optional user to ping with the message.')
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName('sepolia-eth-msg')
    .setDescription('Explain how to get Sepolia ETH to someone else.')
    .addUserOption(option => option
      .setName('user')
      .setDescription('An optional user to ping with the message.')
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName('verify-passport')
    .setDescription('Verify your Gitcoin Passport created on https://passport.gitcoin.co/.'),
  new SlashCommandBuilder()
    .setName('cheap-goerli-deposit')
    .setDescription('Obtain some cheap and easy Goerli validator deposits.'),
]
	.map(command => command.toJSON());

const rest = new REST({ version: '9' }).setToken(token);

const main = function() {
  return new Promise<void>(async (mainResolve, mainReject) => {

    // Delete existing commands
    await rest.get(Routes.applicationGuildCommands(clientId, guildId))
      .then(async (retCommands: unknown) => {
        const objCommands = retCommands as Array<object>;
        let k: keyof typeof retCommands;
        for (const k in objCommands) {
          const command = objCommands[k];
          const values = Object.values(command);
          const commandId = values[0];

          await rest.delete(Routes.applicationGuildCommand(clientId, guildId, commandId))
            .then(() => console.log(`Successfully deleted ${commandId}.`))
            .catch(console.error);

        }

        // Register new commands
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands })
          .then(() => console.log('Successfully registered application commands.'))
          .catch(console.error);
      });

  });
};

main();

