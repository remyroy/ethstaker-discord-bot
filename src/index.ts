import { config } from 'dotenv';
config();

import { Client, Intents } from 'discord.js';
import { providers, utils, Wallet } from 'ethers';

const minEthers = utils.parseUnits("33.0", "ether");
const requestAmount = utils.parseUnits("32.5", "ether");
const explorerTxRoot = 'https://goerli.etherscan.io/tx/';

const goerliProvider = new providers.InfuraProvider(providers.getNetwork('goerli'), process.env.INFURA_API_KEY);
const mainnetProvider = new providers.InfuraProvider(providers.getNetwork('mainnet'), process.env.INFURA_API_KEY);

goerliProvider.getBlockNumber()
  .then((currentBlockNumber) => {
    console.log(`Goerli RPC provider is at block number ${currentBlockNumber}.`);
});
const wallet = new Wallet(process.env.FAUCET_PRIVATE_KEY as string, goerliProvider);
wallet.getAddress()
  .then((address) => {
    console.log(`Faucet wallet loaded at address ${address}.`);
    wallet.getBalance().then((balance) => {
      console.log(`Faucet wallet balance is ${utils.formatEther(balance)}.`);
      if (balance < minEthers) {
        console.warn('Not enough ethers to provide services.');
      }
    });
});

const client = new Client({ intents: [Intents.FLAGS.GUILDS] });

client.on('ready', () => {
  console.log(`Logged in as ${client.user?.tag}!`);
});

client.on('interactionCreate', async interaction => {
	if (!interaction.isCommand()) return;

	const { commandName } = interaction;

	if (commandName === 'ping') {
    const userTag = interaction.user.tag;
    const userId = interaction.user.id;
    console.log(`Ping from ${userTag} (${userId})!`);
		await interaction.reply('Pong!');
	} else if (commandName === 'request-goeth') {
    let targetAddress = interaction.options.getString('address', true);
    const userTag = interaction.user.tag;
    const userId = interaction.user.id;
    console.log(`Request-goeth from ${userTag} (${userId}) to ${targetAddress}!`);

    // TODO: Check the rate limit for this user

    // Verify that we have enough GoETH left in the faucet
    await interaction.reply({ content: 'Checking if we have enough fund for this request...', ephemeral: true });
    const faucetBalance = await wallet.getBalance();
    if (faucetBalance < minEthers) {
      console.log(`The faucet is empty. Please contact an administrator to fill it up. From @${userTag} (${userId}).`);
      await interaction.followUp('The faucet is empty. Please contact an administrator to fill it up.');
      return;
    }

    // Potentially resolving the address
    if (targetAddress.indexOf('.') >= 0) {
      await interaction.editReply(`Resolving ENS ${targetAddress}...`);
      try {
        const resolvedAddress = await mainnetProvider.resolveName(targetAddress);
        if (resolvedAddress === null) {
          console.log(`No address found for ENS ${targetAddress} for @${userTag} (${userId}).`);
          await interaction.followUp(`No address found for ENS ${targetAddress} for @${userTag}.`);
          return;
        }
        targetAddress = resolvedAddress;
      } catch (error) {
        console.log(`Error while trying to resolved ENS ${targetAddress} for @${userTag} (${userId}). ${error}`);
        await interaction.followUp(`Error while trying to resolved ENS ${targetAddress} for @${userTag}. ${error}`);
        return;
      }
    }

    // Send the funds
    await interaction.editReply(`Sending 32.5 GoETH to ${targetAddress}...`);
    try {
      const transaction = await wallet.sendTransaction({
        to: targetAddress,
        value: requestAmount
      });
      const transactionHash = transaction.hash;
      const explorerTxURL = explorerTxRoot + transactionHash;
      await interaction.editReply(`32.5 GoETH have been sent to ${targetAddress} with transaction hash ${transactionHash} (explore with ${explorerTxURL}). Waiting for 1 confirm...`);
      await transaction.wait(1);
      await interaction.editReply(`Transaction confirmed with 1 block confirmation.`);
      console.log(`32.5 GoETH have been sent to ${targetAddress} for @${userTag} (${userId}).`);
      await interaction.followUp(`32.5 GoETH have been sent to ${targetAddress} for @${userTag}. Explore that transaction on ${explorerTxURL}`);
    } catch (error) {
      console.log(`Error while trying to send 32.5 GoETH to ${targetAddress} for @${userTag} (${userId}). ${error}`);
      await interaction.followUp(`Error while trying to send 32.5 GoETH to ${targetAddress} for @${userTag}. ${error}`);
      return;
    }
	}
});

client.login(process.env.DISCORD_TOKEN).then(() => {
  console.log('Discord login successful!');
}).catch((error) => {
  console.log(`Error during Discord login: ${error.message}`);
});