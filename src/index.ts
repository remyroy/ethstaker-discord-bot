import { config } from 'dotenv';
config();

import { Client, Intents, Formatters, GuildMemberRoleManager } from 'discord.js';
import { providers, utils, Wallet } from 'ethers';
import { Database } from 'sqlite3';
import { MessageFlags } from 'discord-api-types/v9';
import { DateTime, Duration } from 'luxon';

const minEthers = utils.parseUnits("33.0", "ether");
const requestAmount = utils.parseUnits("32.5", "ether");
const db = new Database('db.sqlite');
const quickNewRequest = Duration.fromObject({ days: 1 });

const goerliRateLimitDuration = Duration.fromObject({ weeks: 3 });
const ropstenRateLimitDuration = Duration.fromObject({ days: 4 });

const goerliExplorerTxRoot = 'https://goerli.etherscan.io/tx/';
const ropstenExplorerTxRoot = 'https://ropsten.etherscan.io/tx/';

const existingGoerliRequest = new Map<string, boolean>();
const existingRopstenRequest = new Map<string, boolean>();

const initDb = function(db: Database) {
  return new Promise<void>(async (resolve, reject) => {
    db.serialize(() => {
      db.run('CREATE TABLE IF NOT EXISTS request (userId TEXT PRIMARY KEY UNIQUE NOT NULL, lastRequested INTEGER NOT NULL);', (error: Error | null) => {
        if (error !== null) {
          reject(error);
        }
      });
      db.run('CREATE UNIQUE INDEX IF NOT EXISTS request_userID on request ( userID );', (error: Error | null) => {
        if (error !== null) {
          reject(error);
        }
        resolve();
      });
      db.run('CREATE TABLE IF NOT EXISTS request_ropsten (userId TEXT PRIMARY KEY UNIQUE NOT NULL, lastRequested INTEGER NOT NULL);', (error: Error | null) => {
        if (error !== null) {
          reject(error);
        }
      });
      db.run('CREATE UNIQUE INDEX IF NOT EXISTS request_ropsten_userID on request_ropsten ( userID );', (error: Error | null) => {
        if (error !== null) {
          reject(error);
        }
        resolve();
      });
    });
  });
};

initDb(db)
.then(() => {
  console.log('Database initialized successful!');
}).catch((reason) => {
  console.error('Could not initialize database.');
  console.error(reason);
});

const getGoerliLastRequested = function(userId: string) {
  return new Promise<number | null>(async (resolve, reject) => {
    db.get('SELECT lastRequested from request WHERE userId = ?;', userId, (error: Error | null, rows: object | undefined ) => {
      if (error !== null) {
        reject(error);
      }
      if (rows === undefined) {
        resolve(null);
      } else {
        const lastRequested = Object.values(rows)[0] as number;
        resolve(lastRequested);
      }
    });
  });
};

const storeGoerliLastRequested = function(userId: string) {
  return new Promise<void>(async (resolve, reject) => {
    db.serialize(() => {
      let doInsert = true;
      db.get('SELECT lastRequested from request WHERE userId = ?;', userId, (error: Error | null, rows: object | undefined ) => {
        if (error !== null) {
          reject(error);
        }
        if (rows !== undefined) {
          doInsert = false;
        }

        const lastRequested = Math.floor(DateTime.utc().toMillis() / 1000);
        if (doInsert) {
          db.run('INSERT INTO request(userId, lastRequested) VALUES(?, ?);', userId, lastRequested, (error: Error | null) => {
            if (error !== null) {
              reject(error);
            }
            resolve();
          });
        } else {
          db.run('UPDATE request SET lastRequested = ? WHERE userId = ?;', lastRequested, userId, (error: Error | null) => {
            if (error !== null) {
              reject(error);
            }
            resolve();
          });
        }
      });
    });
  });
};

const getRopstenLastRequested = function(userId: string) {
  return new Promise<number | null>(async (resolve, reject) => {
    db.get('SELECT lastRequested from request_ropsten WHERE userId = ?;', userId, (error: Error | null, rows: object | undefined ) => {
      if (error !== null) {
        reject(error);
      }
      if (rows === undefined) {
        resolve(null);
      } else {
        const lastRequested = Object.values(rows)[0] as number;
        resolve(lastRequested);
      }
    });
  });
};

const storeRopstenLastRequested = function(userId: string) {
  return new Promise<void>(async (resolve, reject) => {
    db.serialize(() => {
      let doInsert = true;
      db.get('SELECT lastRequested from request_ropsten WHERE userId = ?;', userId, (error: Error | null, rows: object | undefined ) => {
        if (error !== null) {
          reject(error);
        }
        if (rows !== undefined) {
          doInsert = false;
        }

        const lastRequested = Math.floor(DateTime.utc().toMillis() / 1000);
        if (doInsert) {
          db.run('INSERT INTO request_ropsten(userId, lastRequested) VALUES(?, ?);', userId, lastRequested, (error: Error | null) => {
            if (error !== null) {
              reject(error);
            }
            resolve();
          });
        } else {
          db.run('UPDATE request_ropsten SET lastRequested = ? WHERE userId = ?;', lastRequested, userId, (error: Error | null) => {
            if (error !== null) {
              reject(error);
            }
            resolve();
          });
        }
      });
    });
  });
};

const goerliProvider = new providers.InfuraProvider(providers.getNetwork('goerli'), process.env.INFURA_API_KEY);
const ropstenProvider = new providers.InfuraProvider(providers.getNetwork('ropsten'), process.env.INFURA_API_KEY);
const mainnetProvider = new providers.InfuraProvider(providers.getNetwork('mainnet'), process.env.INFURA_API_KEY);

goerliProvider.getBlockNumber()
.then((currentBlockNumber) => {
  console.log(`Goerli RPC provider is at block number ${currentBlockNumber}.`);
});
ropstenProvider.getBlockNumber()
.then((currentBlockNumber) => {
  console.log(`Ropsten RPC provider is at block number ${currentBlockNumber}.`);
});
mainnetProvider.getBlockNumber()
.then((currentBlockNumber) => {
  console.log(`Mainnet RPC provider is at block number ${currentBlockNumber}.`);
});

const goerliWallet = new Wallet(process.env.FAUCET_PRIVATE_KEY as string, goerliProvider);
goerliWallet.getAddress()
.then((address) => {
  console.log(`Goerli faucet wallet loaded at address ${address}.`);
  goerliWallet.getBalance().then((balance) => {
    console.log(`Goerli faucet wallet balance is ${utils.formatEther(balance)}.`);
    if (balance.lt(minEthers)) {
      console.warn('Not enough ethers to provide services for Goerli faucet.');
    } else {
      const remainingRequests = balance.div(requestAmount);
      console.log(`There are ${remainingRequests} potential remaining requests for Goerli faucet.`)
    }
  });
});

const ropstenWallet = new Wallet(process.env.FAUCET_PRIVATE_KEY as string, ropstenProvider);
ropstenWallet.getAddress()
.then((address) => {
  console.log(`Ropsten faucet wallet loaded at address ${address}.`);
  ropstenWallet.getBalance().then((balance) => {
    console.log(`Ropsten faucet wallet balance is ${utils.formatEther(balance)}.`);
    if (balance.lt(minEthers)) {
      console.warn('Not enough ethers to provide services for Ropsten faucet.');
    } else {
      const remainingRequests = balance.div(requestAmount);
      console.log(`There are ${remainingRequests} potential remaining requests for Ropsten faucet.`)
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
  const userTag = interaction.user.tag;
  const userId = interaction.user.id;
  const userMention = Formatters.userMention(userId);

	if (commandName === 'ping') {
    console.log(`Ping from ${userTag} (${userId})!`);
		await interaction.reply('Pong!');
	} else if (commandName === 'request-goeth') {
    let targetAddress = interaction.options.getString('address', true);
    console.log(`request-goeth from ${userTag} (${userId}) to ${targetAddress}!`);

    if (process.env.GOERLI_CHANNEL_NAME !== undefined && process.env.GOERLI_CHANNEL_NAME !== '') {
      const restrictChannel = interaction.guild?.channels.cache.find((channel) => channel.name === process.env.GOERLI_CHANNEL_NAME);
      if (restrictChannel !== undefined) {
        if (interaction.channelId !== restrictChannel.id) {
          const channelMention = Formatters.channelMention(restrictChannel.id);
          console.log(`This is the wrong channel for this bot command (${commandName}). You should try in #${restrictChannel.name} for @${userTag} (${userId}).`);
          await interaction.reply({
            content: `This is the wrong channel for this bot command (${commandName}). You should try in ${channelMention} for ${userMention}.`,
            allowedMentions: { parse: ['users'], repliedUser: false }
          });
          return;
        }
      }
    }

    // mutex on userId
    if (existingGoerliRequest.get(userId) === true) {
      console.log(`You already have a pending request. Please wait until your request is completed for @${userTag} (${userId}).`);
      await interaction.reply({
        content: `You already have a pending request. Please wait until your request is completed for ${userMention}.`,
        allowedMentions: { parse: ['users'], repliedUser: false }
      });
      return;
    } else {
      existingGoerliRequest.set(userId, true);
    }

    // Check for user role
    await interaction.reply({ content: 'Checking if you have the proper role...', ephemeral: true });
    const restrictRole = interaction.guild?.roles.cache.find((role) => role.name === process.env.ROLE_NAME);
    const hasRole = restrictRole === undefined || (interaction.member?.roles as GuildMemberRoleManager).cache.find((role) => role.id === restrictRole?.id) !== undefined;
    if (!hasRole) {
      console.log(`You cannot use this command without the ${restrictRole?.name} role for @${userTag} (${userId}).`);
      await interaction.followUp({
        content: `You cannot use this command without the ${restrictRole?.name} role for ${userMention}.`,
        allowedMentions: { parse: ['users'], repliedUser: false }
      });
      existingGoerliRequest.delete(userId);
      return;
    }

    // Check the rate limit for this user
    await interaction.editReply('Checking if you are rate-limited...');
    const lastRequested = await getGoerliLastRequested(userId);
    let newRequestPart = '';
    if (lastRequested !== null) {
      const dtLastRequested = DateTime.fromMillis(lastRequested * 1000);
      const dtRequestAvailable = dtLastRequested.plus(goerliRateLimitDuration);
      
      const durRequestAvailable = dtRequestAvailable.diff(DateTime.utc()).shiftTo('days', 'hours').normalize();
      const formattedDuration = durRequestAvailable.toHuman();

      if (DateTime.utc() < dtRequestAvailable) {
        console.log(`You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for @${userTag} (${userId}).`);
        await interaction.followUp({
          content: `You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for ${userMention}.`,
          allowedMentions: { parse: ['users'], repliedUser: false }
        });
        existingGoerliRequest.delete(userId);
        return;
      } else {
        newRequestPart = ` Your new request was available ${formattedDuration} ago.`;
        if (durRequestAvailable.toMillis() <= quickNewRequest.toMillis()) {
          newRequestPart = newRequestPart.concat(` That was a quick new request! You should consider leaving some for the others.`);
        }
      }
    }

    // Potentially resolving the ENS address
    if (targetAddress.indexOf('.') >= 0) {
      await interaction.editReply(`Resolving ENS ${targetAddress}...`);
      try {
        const resolvedAddress = await mainnetProvider.resolveName(targetAddress);
        if (resolvedAddress === null) {
          console.log(`No address found for ENS ${targetAddress} for @${userTag} (${userId}).`);
          await interaction.followUp({
            content: `No address found for ENS ${targetAddress} for ${userMention}.`,
            allowedMentions: { parse: ['users'], repliedUser: false }
          });
          existingGoerliRequest.delete(userId);
          return;
        }
        targetAddress = resolvedAddress;
      } catch (error) {
        console.log(`Error while trying to resolved ENS ${targetAddress} for @${userTag} (${userId}). ${error}`);
        await interaction.followUp({
          content: `Error while trying to resolved ENS ${targetAddress} for ${userMention}. ${error}`,
          allowedMentions: { parse: ['users'], repliedUser: false }
        });
        existingGoerliRequest.delete(userId);
        return;
      }
    } else {
      // Valid address check
      await interaction.editReply(`Checking if ${targetAddress} is a valid address...`);
      if (!utils.isAddress(targetAddress)) {
        console.log(`The wallet address provided (${targetAddress}) is not valid for @${userTag} (${userId})`);
        await interaction.followUp({
          content: `The wallet address provided (${targetAddress}) is not valid for ${userMention}`,
          allowedMentions: { parse: ['users'], repliedUser: false }
        });
        existingGoerliRequest.delete(userId);
        return
      }
    }

    // Verify that the targetAddress balance does not already have enough GoETH
    await interaction.editReply('Checking if you already have enough GoETH...');
    const targetBalance = await goerliProvider.getBalance(targetAddress);
    if (targetBalance.gte(requestAmount)) {
      await storeGoerliLastRequested(userId);

      console.log(`You already have ${utils.formatEther(targetBalance)} GoETH in ${targetAddress}. It should be plenty already for a validator deposit for @${userTag} (${userId}).`);
      await interaction.followUp({
        content: `You already have ${utils.formatEther(targetBalance)} GoETH in ${targetAddress}. It should be plenty already for a validator deposit for ${userMention}.`,
        allowedMentions: { parse: ['users'], repliedUser: false }
      });
      existingGoerliRequest.delete(userId);
      return;
    }

    // Verify that we have enough GoETH left in the faucet
    await interaction.editReply('Checking if we have enough fund for this request...');
    const faucetBalance = await goerliWallet.getBalance();
    if (faucetBalance.lt(minEthers)) {
      console.log(`The faucet is empty. Please contact an administrator to fill it up. From @${userTag} (${userId}).`);
      await interaction.followUp({
        content: `The faucet is empty. Please contact an administrator to fill it up. From ${userMention}.`,
        allowedMentions: { parse: ['users'], repliedUser: false }
      });
      existingGoerliRequest.delete(userId);
      return;
    }

    // Send the GoETH
    await interaction.editReply(`Sending ${utils.formatEther(requestAmount)} GoETH to ${targetAddress}...`);
    try {
      const transaction = await goerliWallet.sendTransaction({
        to: targetAddress,
        value: requestAmount
      });
      
      await storeGoerliLastRequested(userId);

      const transactionHash = transaction.hash;
      const explorerTxURL = goerliExplorerTxRoot + transactionHash;
      await interaction.editReply(`${utils.formatEther(requestAmount)} GoETH have been sent to ${targetAddress}. Explore that transaction on ${explorerTxURL}. Waiting for 1 confirm...`);
      await transaction.wait(1);
      await interaction.editReply(`Transaction confirmed with 1 block confirmation.`);
      
      const remainingRequests = faucetBalance.div(requestAmount).sub(1);
      console.log(`${utils.formatEther(requestAmount)} GoETH have been sent to ${targetAddress} for @${userTag} (${userId}).${newRequestPart}`);
      console.log(`There are ${remainingRequests} remaining requests with the current balance.`);

      await interaction.followUp({
        content: `${utils.formatEther(requestAmount)} GoETH have been sent to ${targetAddress} for ${userMention}.${newRequestPart} Explore that transaction on ${explorerTxURL}\n\nThere are ${remainingRequests} remaining requests with the current balance.`,
        allowedMentions: { parse: ['users'], repliedUser: false },
        flags: MessageFlags.SuppressEmbeds });
      
        existingGoerliRequest.delete(userId);

    } catch (error) {
      console.log(`Error while trying to send ${utils.formatEther(requestAmount)} GoETH to ${targetAddress} for @${userTag} (${userId}). ${error}`);
      await interaction.followUp(`Error while trying to send ${utils.formatEther(requestAmount)} GoETH to ${targetAddress} for ${userMention}. ${error}`);
      existingGoerliRequest.delete(userId);
      return;
    }
  } else if (commandName === 'request-ropsten-eth') {
    let targetAddress = interaction.options.getString('address', true);
    console.log(`request-ropsten-eth from ${userTag} (${userId}) to ${targetAddress}!`);

    if (process.env.ROPSTEN_CHANNEL_NAME !== undefined && process.env.ROPSTEN_CHANNEL_NAME !== '') {
      const restrictChannel = interaction.guild?.channels.cache.find((channel) => channel.name === process.env.ROPSTEN_CHANNEL_NAME);
      if (restrictChannel !== undefined) {
        if (interaction.channelId !== restrictChannel.id) {
          const channelMention = Formatters.channelMention(restrictChannel.id);
          console.log(`This is the wrong channel for this bot command (${commandName}). You should try in #${restrictChannel.name} for @${userTag} (${userId}).`);
          await interaction.reply({
            content: `This is the wrong channel for this bot command (${commandName}). You should try in ${channelMention} for ${userMention}.`,
            allowedMentions: { parse: ['users'], repliedUser: false }
          });
          return;
        }
      }
    }

    // mutex on userId
    if (existingRopstenRequest.get(userId) === true) {
      console.log(`You already have a pending request. Please wait until your request is completed for @${userTag} (${userId}).`);
      await interaction.reply({
        content: `You already have a pending request. Please wait until your request is completed for ${userMention}.`,
        allowedMentions: { parse: ['users'], repliedUser: false }
      });
      return;
    } else {
      existingRopstenRequest.set(userId, true);
    }

    // Check for user role
    await interaction.reply({ content: 'Checking if you have the proper role...', ephemeral: true });
    const restrictRole = interaction.guild?.roles.cache.find((role) => role.name === process.env.ROLE_NAME);
    const hasRole = restrictRole === undefined || (interaction.member?.roles as GuildMemberRoleManager).cache.find((role) => role.id === restrictRole?.id) !== undefined;
    if (!hasRole) {
      console.log(`You cannot use this command without the ${restrictRole?.name} role for @${userTag} (${userId}).`);
      await interaction.followUp({
        content: `You cannot use this command without the ${restrictRole?.name} role for ${userMention}.`,
        allowedMentions: { parse: ['users'], repliedUser: false }
      });
      existingRopstenRequest.delete(userId);
      return;
    }

    // Check the rate limit for this user
    await interaction.editReply('Checking if you are rate-limited...');
    const lastRequested = await getRopstenLastRequested(userId);
    let newRequestPart = '';
    if (lastRequested !== null) {
      const dtLastRequested = DateTime.fromMillis(lastRequested * 1000);
      const dtRequestAvailable = dtLastRequested.plus(ropstenRateLimitDuration);
      
      const durRequestAvailable = dtRequestAvailable.diff(DateTime.utc()).shiftTo('days', 'hours').normalize();
      const formattedDuration = durRequestAvailable.toHuman();

      if (DateTime.utc() < dtRequestAvailable) {
        console.log(`You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for @${userTag} (${userId}).`);
        await interaction.followUp({
          content: `You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for ${userMention}.`,
          allowedMentions: { parse: ['users'], repliedUser: false }
        });
        existingRopstenRequest.delete(userId);
        return;
      } else {
        newRequestPart = ` Your new request was available ${formattedDuration} ago.`;
        if (durRequestAvailable.toMillis() <= quickNewRequest.toMillis()) {
          newRequestPart = newRequestPart.concat(` That was a quick new request! You should consider leaving some for the others.`);
        }
      }
    }

    // Potentially resolving the ENS address
    if (targetAddress.indexOf('.') >= 0) {
      await interaction.editReply(`Resolving ENS ${targetAddress}...`);
      try {
        const resolvedAddress = await mainnetProvider.resolveName(targetAddress);
        if (resolvedAddress === null) {
          console.log(`No address found for ENS ${targetAddress} for @${userTag} (${userId}).`);
          await interaction.followUp({
            content: `No address found for ENS ${targetAddress} for ${userMention}.`,
            allowedMentions: { parse: ['users'], repliedUser: false }
          });
          existingRopstenRequest.delete(userId);
          return;
        }
        targetAddress = resolvedAddress;
      } catch (error) {
        console.log(`Error while trying to resolved ENS ${targetAddress} for @${userTag} (${userId}). ${error}`);
        await interaction.followUp({
          content: `Error while trying to resolved ENS ${targetAddress} for ${userMention}. ${error}`,
          allowedMentions: { parse: ['users'], repliedUser: false }
        });
        existingRopstenRequest.delete(userId);
        return;
      }
    } else {
      // Valid address check
      await interaction.editReply(`Checking if ${targetAddress} is a valid address...`);
      if (!utils.isAddress(targetAddress)) {
        console.log(`The wallet address provided (${targetAddress}) is not valid for @${userTag} (${userId})`);
        await interaction.followUp({
          content: `The wallet address provided (${targetAddress}) is not valid for ${userMention}`,
          allowedMentions: { parse: ['users'], repliedUser: false }
        });
        existingRopstenRequest.delete(userId);
        return
      }
    }

    // Verify that the targetAddress balance does not already have enough Ropsten ETH
    await interaction.editReply('Checking if you already have enough Ropsten ETH...');
    const targetBalance = await ropstenProvider.getBalance(targetAddress);
    if (targetBalance.gte(requestAmount)) {
      await storeRopstenLastRequested(userId);

      console.log(`You already have ${utils.formatEther(targetBalance)} Ropsten ETH in ${targetAddress}. It should be plenty already for a validator deposit for @${userTag} (${userId}).`);
      await interaction.followUp({
        content: `You already have ${utils.formatEther(targetBalance)} Ropsten ETH in ${targetAddress}. It should be plenty already for a validator deposit for ${userMention}.`,
        allowedMentions: { parse: ['users'], repliedUser: false }
      });
      existingRopstenRequest.delete(userId);
      return;
    }

    // Verify that we have enough Ropsten ETH left in the faucet
    await interaction.editReply('Checking if we have enough fund for this request...');
    const faucetBalance = await ropstenWallet.getBalance();
    if (faucetBalance.lt(minEthers)) {
      console.log(`The faucet is empty. Please contact an administrator to fill it up. From @${userTag} (${userId}).`);
      await interaction.followUp({
        content: `The faucet is empty. Please contact an administrator to fill it up. From ${userMention}.`,
        allowedMentions: { parse: ['users'], repliedUser: false }
      });
      existingRopstenRequest.delete(userId);
      return;
    }

    // Send the Ropsten ETH
    await interaction.editReply(`Sending ${utils.formatEther(requestAmount)} Ropsten ETH to ${targetAddress}...`);
    try {
      const transaction = await ropstenWallet.sendTransaction({
        to: targetAddress,
        value: requestAmount
      });
      
      await storeRopstenLastRequested(userId);

      const transactionHash = transaction.hash;
      const explorerTxURL = ropstenExplorerTxRoot + transactionHash;
      await interaction.editReply(`${utils.formatEther(requestAmount)} Ropsten ETH have been sent to ${targetAddress}. Explore that transaction on ${explorerTxURL}. Waiting for 1 confirm...`);
      await transaction.wait(1);
      await interaction.editReply(`Transaction confirmed with 1 block confirmation.`);
      
      const remainingRequests = faucetBalance.div(requestAmount).sub(1);
      console.log(`${utils.formatEther(requestAmount)} Ropsten ETH have been sent to ${targetAddress} for @${userTag} (${userId}).${newRequestPart}`);
      console.log(`There are ${remainingRequests} remaining requests with the current balance.`);

      await interaction.followUp({
        content: `${utils.formatEther(requestAmount)} Ropsten ETH have been sent to ${targetAddress} for ${userMention}.${newRequestPart} Explore that transaction on ${explorerTxURL}\n\nThere are ${remainingRequests} remaining requests with the current balance.`,
        allowedMentions: { parse: ['users'], repliedUser: false },
        flags: MessageFlags.SuppressEmbeds });
      
        existingRopstenRequest.delete(userId);

    } catch (error) {
      console.log(`Error while trying to send ${utils.formatEther(requestAmount)} Ropsten ETH to ${targetAddress} for @${userTag} (${userId}). ${error}`);
      await interaction.followUp(`Error while trying to send ${utils.formatEther(requestAmount)} Ropsten ETH to ${targetAddress} for ${userMention}. ${error}`);
      existingRopstenRequest.delete(userId);
      return;
    }
	}
});

client.login(process.env.DISCORD_TOKEN).then(() => {
  console.log('Discord login successful!');
}).catch((error) => {
  console.log(`Error during Discord login: ${error.message}`);
});