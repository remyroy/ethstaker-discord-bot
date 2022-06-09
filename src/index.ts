import { config } from 'dotenv';
config();

import { Client, Intents, Formatters, GuildMemberRoleManager } from 'discord.js';
import { BigNumber, providers, utils, Wallet } from 'ethers';
import { Database } from 'sqlite3';
import { MessageFlags } from 'discord-api-types/v9';
import { DateTime, Duration } from 'luxon';

const db = new Database('db.sqlite');
const quickNewRequest = Duration.fromObject({ days: 1 });
const maxTransactionCost = utils.parseUnits("0.25", "ether");
const validatorDepositCost = utils.parseUnits("32", "ether");

interface networkConfig {
  network: string;
  currency: string;
  command: string;
  channel?: string;
  enoughReason: string;
  requestTable: string;
  rateLimitDuration: Duration;
  explorerTxRoot: string;
  existingRequest: Map<string, boolean>;
  minEthers: BigNumber;
  requestAmount: BigNumber;
  wallet: Wallet;
  provider: providers.Provider;
};

const main = function() {
  return new Promise<void>(async (resolve, reject) => {

    const mainnetProvider = new providers.InfuraProvider(providers.getNetwork('mainnet'), process.env.INFURA_API_KEY);

    mainnetProvider.getBlockNumber()
    .then((currentBlockNumber) => {
      console.log(`Mainnet RPC provider is at block number ${currentBlockNumber}.`);
    });

    const goerliProvider = new providers.InfuraProvider(providers.getNetwork('goerli'), process.env.INFURA_API_KEY);
    const ropstenProvider = new providers.InfuraProvider(providers.getNetwork('ropsten'), process.env.INFURA_API_KEY);

    goerliProvider.getBlockNumber()
    .then((currentBlockNumber) => {
      console.log(`Goerli RPC provider is at block number ${currentBlockNumber}.`);
    });
    ropstenProvider.getBlockNumber()
    .then((currentBlockNumber) => {
      console.log(`Ropsten RPC provider is at block number ${currentBlockNumber}.`);
    });

    // Configuring the commands
    const commandsConfig = new Map<string, networkConfig>();

    commandsConfig.set('request-goeth', {
      network: 'Goerli',
      currency: 'GoETH',
      command: 'request-goeth',
      channel: process.env.GOERLI_CHANNEL_NAME,
      enoughReason: 'It should be plenty already for a validator deposit',
      requestTable: 'request',
      rateLimitDuration: Duration.fromObject({ weeks: 3 }),
      explorerTxRoot: 'https://goerli.etherscan.io/tx/',
      existingRequest: new Map<string, boolean>(),
      minEthers: validatorDepositCost.add(maxTransactionCost.mul(2)),
      requestAmount: validatorDepositCost.add(maxTransactionCost),
      wallet: new Wallet(process.env.FAUCET_PRIVATE_KEY as string, goerliProvider),
      provider: goerliProvider,
    });

    commandsConfig.set('request-ropsten-eth', {
      network: 'Ropsten',
      currency: 'Ropsten ETH',
      command: 'request-ropsten-eth',
      channel: process.env.ROPSTEN_CHANNEL_NAME,
      enoughReason: 'It should be plenty already for a validator deposit',
      requestTable: 'request_ropsten',
      rateLimitDuration: Duration.fromObject({ days: 4 }),
      explorerTxRoot: 'https://ropsten.etherscan.io/tx/',
      existingRequest: new Map<string, boolean>(),
      minEthers: validatorDepositCost.add(maxTransactionCost.mul(2)),
      requestAmount: validatorDepositCost.add(maxTransactionCost),
      wallet: new Wallet(process.env.FAUCET_PRIVATE_KEY as string, ropstenProvider),
      provider: ropstenProvider,
    });

    // Logging faucet wallet balance and remaining requests
    commandsConfig.forEach((config, key, map) => {
      const wallet = config.wallet;
      const currency = config.currency;
      const network = config.network;
      const minEthers = config.minEthers;
      const requestAmount = config.requestAmount;

      wallet.getAddress()
      .then((address) => {
        console.log(`${network} faucet wallet loaded at address ${address}.`);
        wallet.getBalance().then((balance) => {
          console.log(`${network} faucet wallet balance is ${utils.formatEther(balance)}.`);
          if (balance.lt(minEthers)) {
            console.warn(`Not enough ${currency} to provide services for the ${network} faucet.`);
          } else {
            const remainingRequests = balance.div(requestAmount);
            console.log(`There are ${remainingRequests} potential remaining requests for the ${network} faucet.`)
          }
        });
      });
    });

    const initDb = function(db: Database, commandsConfig: Map<string, networkConfig>) {
      return new Promise<void>(async (resolve, reject) => {
        db.serialize(() => {
          let index = 0;
          commandsConfig.forEach((config, key, map) => {
            const tableName = config.requestTable;
            const lastOne = (index + 1 === map.size);
            db.run(`CREATE TABLE IF NOT EXISTS ${tableName} (userId TEXT PRIMARY KEY UNIQUE NOT NULL, lastRequested INTEGER NOT NULL, lastAddress TEXT NOT NULL);`, (error: Error | null) => {
              if (error !== null) {
                reject(error);
              }
            });
            db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${tableName}_userID on ${tableName} ( userID );`, (error: Error | null) => {
              if (error !== null) {
                reject(error);
              }
            });
            
            interface columnDef {
              name: string
            };

            let hasLastAddress = false;
            db.each(`PRAGMA table_info(${tableName});`, (error: Error | null, row: any ) => {
              const column = row as columnDef;
              if (column.name === 'lastAddress') {
                hasLastAddress = true;
              }
            }, (error: Error | null, count: number) => {
              if (error !== null) {
                reject(error);
              }

              if (!hasLastAddress) {
                db.run(`ALTER TABLE ${tableName} ADD COLUMN lastAddress TEXT NOT NULL DEFAULT '';`, (error: Error | null) => {
                  if (error !== null) {
                    reject(error);
                  }
                  if (lastOne) {
                    resolve();
                  }
                });
              } else if (lastOne) {
                resolve();
              }
            });
            index = index + 1;
          });
        });
      });
    };

    initDb(db, commandsConfig)
    .then(() => {
      console.log('Database initialized successful!');
    }).catch((reason) => {
      console.error('Could not initialize database.');
      console.error(reason);
    });

    interface lastRequest {
      lastRequested: number;
      lastAddress: string;
    };

    const getLastRequest = function(userId: string, tableName: string) {
      return new Promise<lastRequest | null>(async (resolve, reject) => {
        db.get(`SELECT lastRequested, lastAddress from ${tableName} WHERE userId = ?;`, userId, (error: Error | null, row: any ) => {
          if (error !== null) {
            reject(error);
          }
          if (row === undefined) {
            resolve(null);
          } else {
            const value = row as lastRequest;
            resolve(value);
          }
        });
      });
    };

    const storeLastRequest = function(userId: string, address: string, tableName: string) {
      return new Promise<void>(async (resolve, reject) => {
        db.serialize(() => {
          let doInsert = true;
          db.get(`SELECT lastRequested, lastAddress from ${tableName} WHERE userId = ?;`, userId, (error: Error | null, row: any ) => {
            if (error !== null) {
              reject(error);
            }
            if (row !== undefined) {
              doInsert = false;
            }

            const lastRequested = Math.floor(DateTime.utc().toMillis() / 1000);
            if (doInsert) {
              db.run(`INSERT INTO ${tableName}(userId, lastRequested, lastAddress) VALUES(?, ?, ?);`, userId, lastRequested, address, (error: Error | null) => {
                if (error !== null) {
                  reject(error);
                }
                resolve();
              });
            } else {
              db.run(`UPDATE ${tableName} SET lastRequested = ?, lastAddress = ? WHERE userId = ?;`, lastRequested, address, userId, (error: Error | null) => {
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
      } else if (commandsConfig.has(commandName)) {
        let targetAddress = interaction.options.getString('address', true);
        console.log(`${commandName} from ${userTag} (${userId}) to ${targetAddress}!`);

        const config = commandsConfig.get(commandName) as networkConfig;
        const channelName = config.channel;

        if (channelName !== undefined && channelName !== '') {
          const restrictChannel = interaction.guild?.channels.cache.find((channel) => channel.name === channelName);
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
        const existingRequest = config.existingRequest;

        if (existingRequest.get(userId) === true) {
          console.log(`You already have a pending request. Please wait until your request is completed for @${userTag} (${userId}).`);
          await interaction.reply({
            content: `You already have a pending request. Please wait until your request is completed for ${userMention}.`,
            allowedMentions: { parse: ['users'], repliedUser: false }
          });
          return;
        } else {
          existingRequest.set(userId, true);
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
          existingRequest.delete(userId);
          return;
        }

        // Check the rate limit for this user
        const tableName = config.requestTable;
        const rateLimitDuration = config.rateLimitDuration;

        await interaction.editReply('Checking if you are rate-limited...');
        const lastRequest = await getLastRequest(userId, tableName);
        let newRequestPart = '';
        if (lastRequest !== null) {
          const dtLastRequested = DateTime.fromMillis(lastRequest.lastRequested * 1000);
          const dtRequestAvailable = dtLastRequested.plus(rateLimitDuration);
          
          const durRequestAvailable = dtRequestAvailable.diff(DateTime.utc()).shiftTo('days', 'hours').normalize();
          const formattedDuration = durRequestAvailable.toHuman();

          if (DateTime.utc() < dtRequestAvailable) {
            console.log(`You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for @${userTag} (${userId}).`);
            await interaction.followUp({
              content: `You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for ${userMention}.`,
              allowedMentions: { parse: ['users'], repliedUser: false }
            });
            existingRequest.delete(userId);
            return;
          } else {
            const negDurRequestAvailable = durRequestAvailable.negate().shiftTo('days', 'hours').normalize();
            const newRequestFormattedDuration = negDurRequestAvailable.toHuman();
            newRequestPart = ` Your new request was available ${newRequestFormattedDuration} ago.`;
            if (negDurRequestAvailable.toMillis() <= quickNewRequest.toMillis()) {
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
              existingRequest.delete(userId);
              return;
            }
            targetAddress = resolvedAddress;
          } catch (error) {
            console.log(`Error while trying to resolved ENS ${targetAddress} for @${userTag} (${userId}). ${error}`);
            await interaction.followUp({
              content: `Error while trying to resolved ENS ${targetAddress} for ${userMention}. ${error}`,
              allowedMentions: { parse: ['users'], repliedUser: false }
            });
            existingRequest.delete(userId);
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
            existingRequest.delete(userId);
            return
          }
        }

        // Verify that the targetAddress balance does not already have enough currency
        const currency = config.currency;
        const provider = config.provider;
        const requestAmount = config.requestAmount;
        let sendingAmount = requestAmount;

        await interaction.editReply(`Checking if you already have enough ${currency}...`);
        try {
          const targetBalance = await provider.getBalance(targetAddress);
          if (targetBalance.gte(requestAmount)) {
            await storeLastRequest(userId, targetAddress, tableName);

            const enoughReason = config.enoughReason;
            console.log(`You already have ${utils.formatEther(targetBalance)} ${currency} in ${targetAddress}. ${enoughReason} for @${userTag} (${userId}).`);
            await interaction.followUp({
              content: `You already have ${utils.formatEther(targetBalance)} ${currency} in ${targetAddress}. ${enoughReason} for ${userMention}.`,
              allowedMentions: { parse: ['users'], repliedUser: false }
            });
            existingRequest.delete(userId);
            return;
          }
          sendingAmount = requestAmount.sub(targetBalance);
        } catch (error) {
          console.log(`Error while trying to get balance from ${targetAddress} for @${userTag} (${userId}). ${error}`);
          await interaction.followUp(`Error while trying to get balance from ${targetAddress} for ${userMention}. ${error}`);
          existingRequest.delete(userId);
          return;
        }

        // Verify that we have enough currency left in the faucet
        const wallet = config.wallet;
        const network = config.network;
        const minNeeded = sendingAmount.add(maxTransactionCost);
        let faucetBalance = BigNumber.from(0);

        await interaction.editReply('Checking if we have enough fund for this request...');
        try {
          faucetBalance = await wallet.getBalance();
          if (faucetBalance.lt(minNeeded)) {
            console.log(`The ${network} faucet is empty. Please contact an administrator to fill it up. From @${userTag} (${userId}).`);
            await interaction.followUp({
              content: `The ${network} faucet is empty. Please contact an administrator to fill it up. From ${userMention}.`,
              allowedMentions: { parse: ['users'], repliedUser: false }
            });
            existingRequest.delete(userId);
            return;
          }
        } catch (error) {
          console.log(`Error while trying to get balance from the ${network} faucet for @${userTag} (${userId}). ${error}`);
          await interaction.followUp(`Error while trying to get balance from the ${network} faucet for ${userMention}. ${error}`);
          existingRequest.delete(userId);
          return;
        }

        // Send the currency
        await interaction.editReply(`Sending ${utils.formatEther(sendingAmount)} ${currency} to ${targetAddress}...`);
        try {
          const transaction = await wallet.sendTransaction({
            to: targetAddress,
            value: sendingAmount
          });
          
          await storeLastRequest(userId, targetAddress, tableName);

          const transactionHash = transaction.hash;
          const explorerTxRoot = config.explorerTxRoot;
          const explorerTxURL = explorerTxRoot + transactionHash;
          await interaction.editReply(`${utils.formatEther(sendingAmount)} ${currency} have been sent to ${targetAddress}. Explore that transaction on ${explorerTxURL}. Waiting for 1 confirm...`);
          await transaction.wait(1);
          await interaction.editReply(`Transaction confirmed with 1 block confirmation.`);
          
          const remainingRequests = faucetBalance.sub(sendingAmount).div(requestAmount);
          console.log(`${utils.formatEther(sendingAmount)} ${currency} have been sent to ${targetAddress} for @${userTag} (${userId}).${newRequestPart}`);
          console.log(`There are ${remainingRequests} remaining requests with the current balance.`);

          await interaction.followUp({
            content: `${utils.formatEther(sendingAmount)} ${currency} have been sent to ${targetAddress} for ${userMention}.${newRequestPart} Explore that transaction on ${explorerTxURL}\n\nThere are ${remainingRequests} remaining requests with the current balance.`,
            allowedMentions: { parse: ['users'], repliedUser: false },
            flags: MessageFlags.SuppressEmbeds });
          
            existingRequest.delete(userId);

        } catch (error) {
          console.log(`Error while trying to send ${utils.formatEther(sendingAmount)} ${currency} to ${targetAddress} for @${userTag} (${userId}). ${error}`);
          await interaction.followUp(`Error while trying to send ${utils.formatEther(sendingAmount)} ${currency} to ${targetAddress} for ${userMention}. ${error}`);
          existingRequest.delete(userId);
          return;
        }
      }
    });

    client.login(process.env.DISCORD_TOKEN).then(() => {
      console.log('Discord login successful!');
    }).catch((error) => {
      console.log(`Error during Discord login: ${error.message}`);
    });

  });
};

main();

