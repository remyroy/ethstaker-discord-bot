import { config } from 'dotenv';
config();

import { Client, GatewayIntentBits, userMention, channelMention, GuildMemberRoleManager, TextChannel, ActionRowBuilder } from 'discord.js';
import { BigNumber, providers, utils, Wallet } from 'ethers';
import { Database } from 'sqlite3';
import { MessageFlags } from 'discord-api-types/v9';
import { DateTime, Duration } from 'luxon';

import EventSource from 'eventsource';
import axios from 'axios';
import seedrandom from 'seedrandom';

const db = new Database('db.sqlite');
const quickNewRequest = Duration.fromObject({ days: 1 });
const maxTransactionCost = utils.parseUnits("0.02", "ether");
const validatorDepositCost = utils.parseUnits("32", "ether");

const restrictedRoles = new Set<string>(process.env.ROLE_IDS?.split(','));

const EPOCHS_PER_DAY = 225;
const MIN_PER_EPOCH_CHURN_LIMIT = 4;
const CHURN_LIMIT_QUOTIENT = 65536;

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

interface queueConfig {
  network: string;
  apiQueueUrl: string;
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function churn_per_day(active_validators: number) {
  return Math.max(MIN_PER_EPOCH_CHURN_LIMIT, Math.floor(active_validators / CHURN_LIMIT_QUOTIENT)) * EPOCHS_PER_DAY;
}

const main = function() {
  return new Promise<void>(async (mainResolve, mainReject) => {

    const mainnetProvider = new providers.InfuraProvider(providers.getNetwork('mainnet'), process.env.INFURA_API_KEY);

    mainnetProvider.getBlockNumber()
    .then((currentBlockNumber) => {
      console.log(`Mainnet RPC provider is at block number ${currentBlockNumber}.`);
    });

    const goerliProvider = new providers.InfuraProvider(providers.getNetwork('goerli'), process.env.INFURA_API_KEY);
    const ropstenProvider = new providers.InfuraProvider(providers.getNetwork('ropsten'), process.env.INFURA_API_KEY);
    const sepoliaProvider = new providers.JsonRpcProvider(`https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`);

    goerliProvider.getBlockNumber()
    .then((currentBlockNumber) => {
      console.log(`Goerli RPC provider is at block number ${currentBlockNumber}.`);
    });
    ropstenProvider.getBlockNumber()
    .then((currentBlockNumber) => {
      console.log(`Ropsten RPC provider is at block number ${currentBlockNumber}.`);
    });
    sepoliaProvider.getBlockNumber()
    .then((currentBlockNumber) => {
      console.log(`Sepolia RPC provider is at block number ${currentBlockNumber}.`);
    });

    // Configuring the faucet commands
    const faucetCommandsConfig = new Map<string, networkConfig>();

    faucetCommandsConfig.set('request-goeth', {
      network: 'Goerli',
      currency: 'GoETH',
      command: 'request-goeth',
      channel: process.env.GOERLI_CHANNEL_NAME,
      enoughReason: 'It should be plenty already for a validator deposit',
      requestTable: 'request',
      rateLimitDuration: Duration.fromObject({ days: 4 * 7 }),
      explorerTxRoot: 'https://goerli.etherscan.io/tx/',
      existingRequest: new Map<string, boolean>(),
      minEthers: validatorDepositCost.add(maxTransactionCost.mul(2)),
      requestAmount: validatorDepositCost.add(maxTransactionCost),
      wallet: new Wallet(process.env.FAUCET_PRIVATE_KEY as string, goerliProvider),
      provider: goerliProvider,
    });

    faucetCommandsConfig.set('request-ropsten-eth', {
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

    faucetCommandsConfig.set('request-sepolia-eth', {
      network: 'Sepolia',
      currency: 'Sepolia ETH',
      command: 'request-sepolia-eth',
      channel: process.env.SEPOLIA_CHANNEL_NAME,
      enoughReason: 'It should be plenty already for a few transactions',
      requestTable: 'request_sepolia',
      rateLimitDuration: Duration.fromObject({ days: 7 }),
      explorerTxRoot: 'https://sepolia.etherscan.io/tx/',
      existingRequest: new Map<string, boolean>(),
      minEthers: validatorDepositCost.add(maxTransactionCost.mul(2)),
      requestAmount: utils.parseUnits("1", "ether"),
      wallet: new Wallet(process.env.FAUCET_PRIVATE_KEY as string, sepoliaProvider),
      provider: sepoliaProvider,
    });

    // Logging faucet wallet balance and remaining requests
    faucetCommandsConfig.forEach((config, key, map) => {
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

    // Configuring the queue commands
    const queueCommandsConfig = new Map<string, queueConfig>();

    queueCommandsConfig.set('queue-mainnet', {
      network: 'Mainnet',
      apiQueueUrl: 'https://beaconcha.in/api/v1/validators/queue'
    });

    queueCommandsConfig.set('queue-goerli', {
      network: 'Goerli',
      apiQueueUrl: 'https://goerli.beaconcha.in/api/v1/validators/queue'
    });

    queueCommandsConfig.set('queue-ropsten', {
      network: 'Ropsten',
      apiQueueUrl: 'https://ropsten.beaconcha.in/api/v1/validators/queue'
    });

    const initDb = function(db: Database, faucetCommandsConfig: Map<string, networkConfig>) {
      return new Promise<void>(async (resolve, reject) => {
        db.serialize(() => {
          let index = 0;
          faucetCommandsConfig.forEach((config, key, map) => {
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

    initDb(db, faucetCommandsConfig)
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

    let participationRateAutoPost = false;
    let participationRateAutoPostChannel: TextChannel | null = null;

    let currentParticipationRate: number | null = null;
    let previousParticipationRate: number | null = null;
    let currentParticipationRateEpoch: number | null = null;
    let currentParticipationRateDate: number | null = null;
    const twoThird = 2 / 3;

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

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.on('ready', () => {
      console.log(`Logged in as ${client.user?.tag}!`);
    });

    client.on('error', (error: Error) => {
      console.log(`Discord client error: ${error}`);
      console.log(error);
    });

    client.on('interactionCreate', async interaction => {
      if (!interaction.isCommand()) return;

      const { commandName } = interaction;
      const userTag = interaction.user.tag;
      const userId = interaction.user.id;
      const userMen = userMention(userId);

      if (commandName === 'ping') {
        console.log(`Ping from ${userTag} (${userId})!`);
        await interaction.reply('Pong!');
      } else if (commandName === 'participation-mainnet-auto') {

        // Check if it's my master
        if (userId !== process.env.MASTER_USER_ID) {
          await interaction.reply({
            content: `You cannot use this command (${commandName}). You are not my master for ${userMen}.`,
            allowedMentions: { parse: ['users'], repliedUser: false }
          });
          return;
        }

        const enabled = interaction.options.get('enabled', true).value as boolean;

        participationRateAutoPost = enabled;
        if (participationRateAutoPost) {
          participationRateAutoPostChannel = client.channels.cache.find((channel) => channel.id === interaction.channelId) as TextChannel;
          const participationRateAutoPostChannelMention = channelMention(interaction.channelId);

          await interaction.reply({
            content: `Participation rate auto post for Mainnet enabled on ${participationRateAutoPostChannelMention} for ${userMen}.`,
            allowedMentions: { parse: ['users'], repliedUser: false }
          });
        } else {
          await interaction.reply({
            content: `Participation rate auto post for Mainnet disabled for ${userMen}.`,
            allowedMentions: { parse: ['users'], repliedUser: false }
          });
        }
        return;

      } else if (commandName === 'participation-mainnet') {
        console.log(`${commandName} from ${userTag} (${userId})`);

        const message = participationRateMessage(userTag, userId, userMen);
        await interaction.reply({
          content: message,
          allowedMentions: { parse: ['users'], repliedUser: false }
        });

      } else if (faucetCommandsConfig.has(commandName)) {
        let targetAddress = interaction.options.get('address', true).value as string;
        console.log(`${commandName} from ${userTag} (${userId}) to ${targetAddress}!`);

        const config = faucetCommandsConfig.get(commandName) as networkConfig;
        const channelName = config.channel;

        if (channelName !== undefined && channelName !== '') {
          const restrictChannel = interaction.guild?.channels.cache.find((channel) => channel.name === channelName);
          if (restrictChannel !== undefined) {
            if (interaction.channelId !== restrictChannel.id) {
              const channelMen = channelMention(restrictChannel.id);
              console.log(`This is the wrong channel for this bot command (${commandName}). You should try in #${restrictChannel.name} for @${userTag} (${userId}).`);
              await interaction.reply({
                content: `This is the wrong channel for this bot command (${commandName}). You should try in ${channelMen} for ${userMen}.`,
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
            content: `You already have a pending request. Please wait until your request is completed for ${userMen}.`,
            allowedMentions: { parse: ['users'], repliedUser: false }
          });
          return;
        } else {
          existingRequest.set(userId, true);
        }

        try {

          // Check for user role
          await interaction.reply({ content: 'Checking if you have the proper role...', ephemeral: true });
          const hasRole = restrictedRoles.size === 0 || (interaction.member?.roles as GuildMemberRoleManager).cache.find((role) => restrictedRoles.has(role.id)) !== undefined;
          if (!hasRole) {
            const brightIdMention = channelMention(process.env.BRIGHTID_VERIFICATION_CHANNEL_ID as string);

            console.log(`You cannot use this command without the correct role for @${userTag} (${userId}).`);
            await interaction.followUp({
              content: `You cannot use this command without the correct role. Join ${brightIdMention} to get started for ${userMen}.`,
              allowedMentions: { parse: ['users'], repliedUser: false }
            });
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
            
            let durRequestAvailable = dtRequestAvailable.diff(DateTime.utc()).shiftTo('days', 'hours').normalize();
            if (durRequestAvailable.days === 0) {
              durRequestAvailable = durRequestAvailable.shiftTo('hours', 'minutes');
            }
            const formattedDuration = durRequestAvailable.toHuman();

            if (DateTime.utc() < dtRequestAvailable) {
              console.log(`You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for @${userTag} (${userId}).`);
              await interaction.followUp({
                content: `You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              return;
            } else {
              let negDurRequestAvailable = durRequestAvailable.negate().shiftTo('days', 'hours').normalize();
              if (negDurRequestAvailable.days === 0) {
                negDurRequestAvailable = negDurRequestAvailable.shiftTo('hours', 'minutes');
              }
              const newRequestFormattedDuration = negDurRequestAvailable.toHuman();

              newRequestPart = ` Your new request was available ${newRequestFormattedDuration} ago.`;
              if (negDurRequestAvailable.toMillis() <= quickNewRequest.toMillis()) {
                newRequestPart = newRequestPart.concat(` That was a quick new request! You should consider leaving some for the others.`);
              }
            }
          }

          // Check for farmer role
          const hasFarmerRole = (interaction.member?.roles as GuildMemberRoleManager).cache.find((role) => role.id.trim() === process.env.FARMER_ROLE_ID?.trim()) !== undefined;
          if (hasFarmerRole) {

            const rng = seedrandom(userId);
            const rateLimitDays = rateLimitDuration.shiftTo('days').days;
            const randomDate = DateTime.fromMillis(rng() * rateLimitDays * 24 * 60 * 60 * 1000).set({ year: 3000 });
            let durRandom = randomDate.diff(DateTime.utc()).shiftTo('days', 'hours').normalize();
            durRandom = durRandom.set({ days: durRandom.days % rateLimitDays });
            if (durRandom.days === 0) {
              durRandom = durRandom.shiftTo('hours', 'minutes');
            }

            const formattedDuration = durRandom.toHuman();
            console.log(`You cannot do another request this soon my friend. You will need to wait at least ${formattedDuration} before you can request again for @${userTag} (${userId}).`);
              await interaction.followUp({
                content: `You cannot do another request this soon my friend. You will need to wait at least ${formattedDuration} before you can request again for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
            return;
          }

          // Potentially resolving the ENS address
          if (targetAddress.indexOf('.') >= 0) {
            await interaction.editReply(`Resolving ENS ${targetAddress}...`);
            try {
              const resolvedAddress = await mainnetProvider.resolveName(targetAddress);
              if (resolvedAddress === null) {
                console.log(`No address found for ENS ${targetAddress} for @${userTag} (${userId}).`);
                await interaction.followUp({
                  content: `No address found for ENS ${targetAddress} for ${userMen}.`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                return;
              }
              targetAddress = resolvedAddress;
            } catch (error) {
              console.log(`Error while trying to resolved ENS ${targetAddress} for @${userTag} (${userId}). ${error}`);
              console.log(error);
              await interaction.followUp({
                content: `Error while trying to resolved ENS ${targetAddress} for ${userMen}. ${error}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              return;
            }
          } else {
            // Valid address check
            await interaction.editReply(`Checking if ${targetAddress} is a valid address...`);
            if (!utils.isAddress(targetAddress)) {
              console.log(`The wallet address provided (${targetAddress}) is not valid for @${userTag} (${userId})`);
              await interaction.followUp({
                content: `The wallet address provided (${targetAddress}) is not valid for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
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
                content: `You already have ${utils.formatEther(targetBalance)} ${currency} in ${targetAddress}. ${enoughReason} for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              return;
            }
            sendingAmount = requestAmount.sub(targetBalance);
          } catch (error) {
            console.log(`Error while trying to get balance from ${targetAddress} for @${userTag} (${userId}). ${error}`);
            console.log(error);
            await interaction.followUp(`Error while trying to get balance from ${targetAddress} for ${userMen}. ${error}`);
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
                content: `The ${network} faucet is empty. Please contact an administrator to fill it up. From ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              return;
            }
          } catch (error) {
            console.log(`Error while trying to get balance from the ${network} faucet for @${userTag} (${userId}). ${error}`);
            console.log(error);
            await interaction.followUp(`Error while trying to get balance from the ${network} faucet for ${userMen}. ${error}`);
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
              content: `${utils.formatEther(sendingAmount)} ${currency} have been sent to ${targetAddress} for ${userMen}.${newRequestPart} Explore that transaction on ${explorerTxURL}\n\nThere are ${remainingRequests} remaining requests with the current balance.`,
              allowedMentions: { parse: ['users'], repliedUser: false },
              flags: MessageFlags.SuppressEmbeds });

          } catch (error) {
            console.log(`Error while trying to send ${utils.formatEther(sendingAmount)} ${currency} to ${targetAddress} for @${userTag} (${userId}). ${error}`);
            console.log(error);
            await interaction.followUp(`Error while trying to send ${utils.formatEther(sendingAmount)} ${currency} to ${targetAddress} for ${userMen}. ${error}`);
          }

        } catch (error) {
          console.log(`Unexpected error while using the ${commandName} command for @${userTag} (${userId}). ${error}`);
          console.log(error);
          await interaction.followUp(`Unexpected error while using the ${commandName} command for ${userMen}. ${error}`);
        }
        finally {
          existingRequest.delete(userId);
        }

      } else if (queueCommandsConfig.has(commandName)) {
        console.log(`${commandName} from ${userTag} (${userId})`);

        const config = queueCommandsConfig.get(commandName) as queueConfig;
        const network = config.network;
        const apiQueueUrl = config.apiQueueUrl;

        // TODO: Get the actual number of active validators
        const activeValidators = 1;
        const churnPerDay = churn_per_day(activeValidators);

        try {
          await interaction.reply({ content: `Querying beaconcha.in API for ${network} queue details...`, ephemeral: true });
          const response = await axios.get(apiQueueUrl);
          if (response.status !== 200) {
            console.log(`Unexpected status code from querying beaconcha.in API for ${network} queue details. Status code ${response.status} for @${userTag} (${userId}).`);
            await interaction.followUp(`Unexpected status code from querying beaconcha.in API for ${network} queue details. Status code ${response.status} for ${userMen}.`);
            return;
          }

          interface queueResponse {
            status: string,
            data: {
              beaconchain_entering: number,
              beaconchain_exiting: number
            }
          };

          const queryResponse = response.data as queueResponse;

          if (queryResponse.status !== "OK") {
            console.log(`Unexpected body status from querying beaconcha.in API for ${network} queue details. Body status ${queryResponse.status} for @${userTag} (${userId}).`);
            await interaction.followUp(`Unexpected body status from querying beaconcha.in API for ${network} queue details. Body status ${queryResponse.status} for ${userMen}.`);
            return;
          }

          const activationNormalProcessingMsg = 'It should only take 16-24 hours for a new deposit to be processed and an associated validator to be activated.';
          const activationNormalProcessingMaxDuration = Duration.fromObject({ hours: 24 });

          let activationQueueMessage = `The **activation queue** is empty. ${activationNormalProcessingMsg}`;
          let exitQueueMessage = 'The **exit queue** is empty. It should only take a few minutes for a validator to complete a voluntary exit.';

          if (queryResponse.data.beaconchain_entering > 0) {
            const activationDays = queryResponse.data.beaconchain_entering / churnPerDay;
            let activationDuration = Duration.fromObject({ days: activationDays }).shiftTo('days', 'hours').normalize();
            if (activationDuration.days === 0) {
              activationDuration = activationDuration.shiftTo('hours', 'minutes');
            }
            const formattedActivationDuration = activationDuration.toHuman();

            if (activationDuration.toMillis() <= activationNormalProcessingMaxDuration.toMillis()) {
              activationQueueMessage = `There are **${queryResponse.data.beaconchain_entering} validators awaiting to be activated**. The queue should clear out in ${formattedActivationDuration} if there is no new deposit. ${activationNormalProcessingMsg}`;
            } else {
              activationQueueMessage = `There are **${queryResponse.data.beaconchain_entering} validators awaiting to be activated**. It should take at least ${formattedActivationDuration} for a new deposit to be processed and an associated validator to be activated.`;
            }
          }
          if (queryResponse.data.beaconchain_exiting > 0) {
            const exitDays = queryResponse.data.beaconchain_exiting / churnPerDay;
            let exitDuration = Duration.fromObject({ days: exitDays }).shiftTo('days', 'hours').normalize();
            if (exitDuration.days === 0) {
              exitDuration = exitDuration.shiftTo('hours', 'minutes');
            }
            const formattedExitDuration = exitDuration.toHuman();

            exitQueueMessage = `There are **${queryResponse.data.beaconchain_exiting} validators awaiting to exit** the network. It should take at least ${formattedExitDuration} for a voluntary exit to be processed and an associated validator to leave the network.`;
          }

          console.log(`Current queue details for ${network} for @${userTag} (${userId})\n\n- ${activationQueueMessage}\n- ${exitQueueMessage}`);

          await interaction.followUp({
            content: `Current queue details for **${network}** for ${userMen}\n\n- ${activationQueueMessage}\n- ${exitQueueMessage}`,
            allowedMentions: { parse: ['users'], repliedUser: false },
            flags: MessageFlags.SuppressEmbeds });
          
        } catch (error) {
          console.log(`Error while trying to query beaconcha.in API for ${network} queue details for @${userTag} (${userId}). ${error}`);
          console.log(error);
          await interaction.followUp(`Error while trying to query beaconcha.in API for ${network} queue details for ${userMen}. ${error}`);
        }

      } else if (commandName === 'goeth-msg') {
        console.log(`${commandName} from ${userTag} (${userId})`);

        const channelName = process.env.GOERLI_CHANNEL_NAME;
        let channelMen = '';

        if (channelName !== undefined && channelName !== '') {
          const requestChannel = interaction.guild?.channels.cache.find((channel) => channel.name === channelName);
          if (requestChannel !== undefined) {
            channelMen = channelMention(requestChannel.id);
          }
        }

        const brightIdMention = channelMention(process.env.BRIGHTID_VERIFICATION_CHANNEL_ID as string);

        let targetUser = 'You';

        const inputUser = interaction.options.getUser('user', false);
        if (inputUser !== null) {
          targetUser = userMention(inputUser.id);
        }

        const msg = (
          `${targetUser} can request Goerli ETH to run a validator on Goerli on ${channelMen}` +
          ` but first, you will need to be BrightID verified in ${brightIdMention}. Alternatively` +
          ` you can use these online faucets https://faucetlink.to/goerli for ${userMen}`
          );
        
        interaction.reply({
          content: msg,
          flags: MessageFlags.SuppressEmbeds
        });

      } else if (commandName === 'ropsten-eth-msg') {
        console.log(`${commandName} from ${userTag} (${userId})`);

        const channelName = process.env.ROPSTEN_CHANNEL_NAME;
        let channelMen = '';

        if (channelName !== undefined && channelName !== '') {
          const requestChannel = interaction.guild?.channels.cache.find((channel) => channel.name === channelName);
          if (requestChannel !== undefined) {
            channelMen = channelMention(requestChannel.id);
          }
        }

        const brightIdMention = channelMention(process.env.BRIGHTID_VERIFICATION_CHANNEL_ID as string);

        let targetUser = 'You';

        const inputUser = interaction.options.getUser('user', false);
        if (inputUser !== null) {
          targetUser = userMention(inputUser.id);
        }

        const msg = (
          `${targetUser} can request Ropsten ETH to run a validator on Ropsten on ${channelMen}` +
          ` but first, you will need to be BrightID verified in ${brightIdMention}. Alternatively` +
          ` you can use these online faucets https://faucetlink.to/ropsten for ${userMen}`
          );
        
        interaction.reply({
          content: msg,
          flags: MessageFlags.SuppressEmbeds
        });

      } else if (commandName === 'sepolia-eth-msg') {
        console.log(`${commandName} from ${userTag} (${userId})`);

        const channelName = process.env.SEPOLIA_CHANNEL_NAME;
        let channelMen = '';

        if (channelName !== undefined && channelName !== '') {
          const requestChannel = interaction.guild?.channels.cache.find((channel) => channel.name === channelName);
          if (requestChannel !== undefined) {
            channelMen = channelMention(requestChannel.id);
          }
        }

        const brightIdMention = channelMention(process.env.BRIGHTID_VERIFICATION_CHANNEL_ID as string);

        let targetUser = 'You';

        const inputUser = interaction.options.getUser('user', false);
        if (inputUser !== null) {
          targetUser = userMention(inputUser.id);
        }

        const msg = (
          `${targetUser} can request Sepolia ETH to test transactions on the Sepolia testnet on ${channelMen}` +
          ` but first, you will need to be BrightID verified in ${brightIdMention}. Alternatively` +
          ` you can use these online faucets https://faucetlink.to/sepolia for ${userMen}`
          );
        
        interaction.reply({
          content: msg,
          flags: MessageFlags.SuppressEmbeds
        });

      } else if (commandName === 'verify-passport') {
        console.log(`${commandName} from ${userTag} (${userId})`);

        // Restrict command to channel
        const restrictChannel = interaction.guild?.channels.cache.find((channel) => channel.id === process.env.PASSPORT_CHANNEL_ID);
        if (restrictChannel !== undefined) {
          if (interaction.channelId !== restrictChannel.id) {
            const channelMen = channelMention(restrictChannel.id);
            console.log(`This is the wrong channel for this bot command (${commandName}). You should try in #${restrictChannel.name} for @${userTag} (${userId}).`);
            await interaction.reply({
              content: `This is the wrong channel for this bot command (${commandName}). You should try in ${channelMen} for ${userMen}.`,
              allowedMentions: { parse: ['users'], repliedUser: false }
            });
            return;
          }
        }

        await interaction.reply({ content: 'Building signing URL...', ephemeral: true });

        const my_request = { requested_message: `My Discord user ${userTag} (${userId}) has access to this Gitcoin Passport address.` };
        const url_safe_string = encodeURIComponent( JSON.stringify( my_request ) );
        const base64_encoded = url_safe_string;
        const signer_is_url = `https://signer.is/#/sign/${ base64_encoded }`;

        /*const row = new ActionRowBuilder()
          .addComponents(new )

        await interaction.editReply({
          content: 'Sign a message to prove you own a wallet address associated with your Gitcoin Passport.',
          components: [row]
        });*/

      }
    });

    const discordLogin = function() {
      return new Promise<void>(async (resolve, reject) => {
        client.login(process.env.DISCORD_TOKEN).then(() => {
          console.log('Discord login successful!');
          resolve();
        }).catch((error: Error) => {
          console.log(`Error during Discord login: ${error.message} (${error})`);
          console.log('Retrying login in 5 seconds...')
          delay(5000).then(() => discordLogin());
          reject();
        });
      });
    };

    discordLogin();

    let alertChannel: TextChannel | null = null;

    const alertOnDiscord = function(message: string) {
      return new Promise<void>(async (resolve, reject) => {

        if (alertChannel === null) {
          alertChannel = client.channels.cache.find((channel) => channel.id === process.env.ALERT_CHANNEL_ID) as TextChannel;
        }

        await alertChannel.send(message);
        resolve();
      });
    };

    const participationRateMessage = function(userTag: string, userId: string, userMen: string) {
      if (currentParticipationRate !== null && currentParticipationRateEpoch !== null && currentParticipationRateDate !== null && previousParticipationRate != null) {
        const prevfixedParticipationRate = (previousParticipationRate * 100.0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';
        const currentFixedParticipationRate = (currentParticipationRate * 100.0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';

        const dtLastChecked = DateTime.fromMillis(currentParticipationRateDate as number);
        let durLastChecked = DateTime.utc().diff(dtLastChecked).shiftTo('minutes', 'seconds').normalize();
        if (durLastChecked.minutes === 0) {
          durLastChecked = durLastChecked.shiftTo('seconds');
        }

        const participationRateDuration = durLastChecked.toHuman();

        console.log(`Participation rate for epoch ${currentParticipationRateEpoch - 1} (${participationRateDuration} ago) is ${prevfixedParticipationRate} on Mainnet. Current participation rate for epoch ${currentParticipationRateEpoch} is ${currentFixedParticipationRate} (this is subject to change and probably incomplete as validators can continue to include attestations for the *current* epoch in the *next* epoch) on Mainnet for @${userTag} (${userId}).`);
        return `Participation rate for epoch **${currentParticipationRateEpoch - 1}** (${participationRateDuration} ago) is **${prevfixedParticipationRate}** on Mainnet. Current participation rate for epoch ${currentParticipationRateEpoch} is ${currentFixedParticipationRate} (this is subject to change and probably incomplete as validators can continue to include attestations for the *current* epoch in the *next* epoch) on Mainnet for ${userMen}.`;
      } else {
        console.log(`We don't have the current participation rate for Mainnet. It should be available in a few minutes if you want to retry for @${userTag} (${userId}).`);
        return `We don't have the current participation rate for Mainnet. It should be available in a few minutes if you want to retry for ${userMen}.`;
      }
    }

    const autoPostParticipationRate = function() {
      return new Promise<void>(async (resolve, reject) => {
        if (participationRateAutoPost && participationRateAutoPostChannel !== null) {
          const message = participationRateMessage('', process.env.MASTER_USER_ID as string, userMention(process.env.MASTER_USER_ID as string));
          await participationRateAutoPostChannel.send({
            content: message,
            allowedMentions: { parse: ['users'], repliedUser: false }
          });
        }
        resolve();
      });
    };

    let participationRateAlertTriggering = {
      below90: false,
      below80: false,
      below70: false,
      belowTwoThird: false,
    };

    const checkParticipationRate = function (epoch: number) {
      return new Promise<void>(async (resolve, reject) => {
        // Query lighthouse Validator Inclusion APIs
        try {
          const beaconNodeApiEndpoint = process.env.BEACON_API_ENDPOINT as string;
          const validatorInclusionRestEndpoint = `/lighthouse/validator_inclusion/${epoch}/global`;
          const validatorInclusionUrl = beaconNodeApiEndpoint.concat(validatorInclusionRestEndpoint);
          const response = await axios.get(validatorInclusionUrl,
            { headers: {'accept': 'application/json'} });

          if (response.status !== 200) {
            console.log(`Unexpected status code from querying Validator Inclusion API for epoch ${epoch} details. Status code ${response.status}.`);
            return;
          }

          interface globalResponse {
            data: {
              current_epoch_active_gwei: number,
              previous_epoch_active_gwei: number,
              current_epoch_target_attesting_gwei: number,
              previous_epoch_target_attesting_gwei: number,
              previous_epoch_head_attesting_gwei: number
            }
          };

          const queryResponse = response.data as globalResponse;
          const participationRateDate = DateTime.utc().toMillis();

          const prevParticipationRate = queryResponse.data.previous_epoch_target_attesting_gwei / queryResponse.data.previous_epoch_active_gwei;
          const currParticipationRate = queryResponse.data.current_epoch_target_attesting_gwei / queryResponse.data.current_epoch_active_gwei;

          const fixedPrevParticipationRate = (prevParticipationRate * 100.0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';
          const fixedCurrParticipationRate = (currParticipationRate * 100.0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';

          const participationRate = prevParticipationRate;
          const fixedParticipationRate = fixedPrevParticipationRate;

          console.log(`Participation rate for epoch ${epoch -1} is ${fixedPrevParticipationRate}. Temporary participation rate for ${epoch} is ${fixedCurrParticipationRate}.`);

          if (participationRate < twoThird) {
            participationRateAlertTriggering.below90 = true;
            participationRateAlertTriggering.below80 = true;
            participationRateAlertTriggering.below70 = true;
            if (!participationRateAlertTriggering.belowTwoThird) {
              participationRateAlertTriggering.belowTwoThird = true;

              const message = `🚨 Participation rate on Mainnet is below 2 / 3 (current: ${fixedParticipationRate} for epoch ${epoch}). Finality is compromised. 🚨`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
                console.log(error);
              });
            }
          } else if (participationRate < 0.7) {
            participationRateAlertTriggering.below90 = true;
            participationRateAlertTriggering.below80 = true;
            if (!participationRateAlertTriggering.below70) {
              participationRateAlertTriggering.below70 = true;

              const message = `⚠️ Participation rate on Mainnet is below 70% (current: ${fixedParticipationRate} for epoch ${epoch}). ⚠️`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
                console.log(error);
              });
            } else if (participationRateAlertTriggering.belowTwoThird) {
              participationRateAlertTriggering.belowTwoThird = false;

              const message = `⚠️ Participation rate on Mainnet is back above 2 / 3 (current: ${fixedParticipationRate} for epoch ${epoch}). Finality should resume. ⚠️`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
                console.log(error);
              });
            }
          } else if (participationRate < 0.8) {
            participationRateAlertTriggering.below90 = true;
            if (!participationRateAlertTriggering.below80) {
              participationRateAlertTriggering.below80 = true;

              const message = `⚠️ Participation rate on Mainnet is below 80% (current: ${fixedParticipationRate} for epoch ${epoch}). ⚠️`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
                console.log(error);
              });
            } else if (participationRateAlertTriggering.below70) {
              participationRateAlertTriggering.below70 = false;

              const message = `⚠️ Participation rate on Mainnet is back above 70% (current: ${fixedParticipationRate} for epoch ${epoch}). ⚠️`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
                console.log(error);
              });
            }

            participationRateAlertTriggering.belowTwoThird = false;

          } else if (participationRate < 0.9) {
            if (!participationRateAlertTriggering.below90) {
              participationRateAlertTriggering.below90 = true;

              const message = `⚠️ Participation rate on Mainnet is below 90% (current: ${fixedParticipationRate} for epoch ${epoch}). ⚠️`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
                console.log(error);
              });
            } else if (participationRateAlertTriggering.below80) {
              participationRateAlertTriggering.below80 = false;

              const message = `⚠️ Participation rate on Mainnet is back above 80% (current: ${fixedParticipationRate} for epoch ${epoch}). ⚠️`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
                console.log(error);
              });
            }

            participationRateAlertTriggering.below70 = false;
            participationRateAlertTriggering.belowTwoThird = false;

          } else {
            if (participationRateAlertTriggering.below90) {
              const message = `ℹ️ Participation rate on Mainnet is back above 90% (current: ${fixedParticipationRate} for epoch ${epoch}). ℹ️`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
                console.log(error);
              });
            }
            participationRateAlertTriggering.below90 = false;
            participationRateAlertTriggering.below80 = false;
            participationRateAlertTriggering.below70 = false;
            participationRateAlertTriggering.belowTwoThird = false;
          }

          previousParticipationRate = prevParticipationRate;
          currentParticipationRate = currParticipationRate;
          currentParticipationRateEpoch = epoch;
          currentParticipationRateDate = participationRateDate;

          await autoPostParticipationRate();

        } catch (error) {
          console.log(`Error while trying to query Validator Inclusion API for epoch ${epoch} details. ${error}`);
          console.log(error);
        }
      });
    };

    const beaconNodeApiEndpoint = process.env.BEACON_API_ENDPOINT as string;
    const eventsRestEndpoint = '/eth/v1/events?topics=head';
    const bnEventsUrl = beaconNodeApiEndpoint.concat(eventsRestEndpoint);

    interface headEvent {
      slot: number,
      block: string,
      state: string,
      epoch_transition: boolean
    }

    interface indexedAttestation {
      attesting_indices: Array<number>
    }

    interface signedBeaconBlockHeader {
      message: {
        proposer_index: number
      }
    }

    interface attesterSlashing {
      attestation_1: indexedAttestation,
      attestation_2: indexedAttestation
    }

    interface proposerSlashing {
      signed_header_1: signedBeaconBlockHeader,
      signed_header_2: signedBeaconBlockHeader
    }

    interface beaconBlock {
      version: string
      data: {
        message: {
          slot: number,
          proposer_index: number,
          body: {
            proposer_slashings: Array<proposerSlashing>,
            attester_slashings: Array<attesterSlashing>
          }
        }
      }
    }

    let bnEvents = new EventSource(bnEventsUrl);

    const headEventReceived = async function(evt: MessageEvent<any>) {
      const eventData = JSON.parse(evt.data) as headEvent;
      if (eventData.epoch_transition) {
        const epoch = Math.floor(eventData.slot / 32);
        console.log(`Epoch transition on slot ${eventData.slot} for epoch ${epoch}.`);

        const previousEpoch = epoch - 1;
        checkParticipationRate(previousEpoch);
      }
      
      const bnBlockUrl = beaconNodeApiEndpoint.concat(`/eth/v2/beacon/blocks/${eventData.slot}`);
      
      const validatorRoot = 'https://beaconcha.in/validator/';

      try {
        const response = await axios.get(bnBlockUrl, { headers: {'accept': 'application/json'} });
        if (response.status !== 200) {
          console.log(`Unexpected status code from querying beacon node API for ${bnBlockUrl}. Status code ${response.status}.`);
          return;
        }
        
        const block = response.data as beaconBlock;
        const slot = block.data.message.slot;

        const attSlashings = block.data.message.body.attester_slashings;
        const propSlashings = block.data.message.body.proposer_slashings;

        let foundSlashings = false;
        let attestationSlashingsMessage = '';
        let proposerSlashingMessage = '';

        if (attSlashings.length > 0) {
          // We have attestation slashings
          console.log('Attestation slashings');
          foundSlashings = true;

          let attSlashingCount = 0;
          attSlashings.forEach((attSlashing) => {
            const indices1 = new Set<number>(attSlashing.attestation_1.attesting_indices);
            const indices2 = new Set<number>(attSlashing.attestation_2.attesting_indices);
            const intersection = new Set<number>([...indices1].filter(x => indices2.has(x)));

            intersection.forEach((validatorIndex) => {
              if (attSlashingCount == 5) {
                attestationSlashingsMessage = attestationSlashingsMessage + `\n[...]`
              }
              if (attSlashingCount >= 5) {
                return;
              } else {
                console.log(`Attestation slashing for validator ${validatorIndex} at slot ${slot}`);
                const exploreChainUrl = `${validatorRoot}${validatorIndex}`;
                attestationSlashingsMessage = attestationSlashingsMessage + `\n- Validator **${validatorIndex}** was part of an *attestation slashing*. Explore this validator on <${exploreChainUrl}>`;
              }
              attSlashingCount = attSlashingCount + 1;
            });
          });
        }

        let propSlashingCount = 0;
        if (propSlashings.length > 0) {
          // We have proposer slashings
          console.log('Proposer slashings');
          foundSlashings = true;

          propSlashings.forEach((propSlashings) => {
            const index1 = propSlashings.signed_header_1.message.proposer_index;
            const index2 = propSlashings.signed_header_2.message.proposer_index;
            const validatorIndex = index1;
            if (index1 === index2) {
              if (propSlashingCount == 5) {
                proposerSlashingMessage = proposerSlashingMessage + `\n[...]`
              }
              if (propSlashingCount >= 5) {
                return;
              } else {
                console.log(`Proposer slashing for validator ${validatorIndex} at slot ${slot}`);
                const exploreChainUrl = `${validatorRoot}${validatorIndex}`;
                proposerSlashingMessage = proposerSlashingMessage + `\n- Validator **${validatorIndex}** was part of a *proposer slashing*. Explore this validator on <${exploreChainUrl}>`;
              }
              propSlashingCount = propSlashingCount + 1;
            }
          });
        }

        if (foundSlashings) {
          const message = `🚨 We just found **slashings** on Mainnet at slot ${slot} 🚨\n${attestationSlashingsMessage}${proposerSlashingMessage}`;
          alertOnDiscord(message).catch((error) => {
            console.log(`Unable to send alert on discord. ${error}`);
            console.log(error);
          });
        }

      } catch (error) {
        console.log(`Error while trying to query beacon node API for ${bnBlockUrl}. ${error}`);
        console.log(error);
      }

    };
    const headEventError = function(evt: MessageEvent<any>) {
      console.log('EventSource Error');
      console.log(evt);
      bnEvents.close();

      console.log('Retrying event source in 5 seconds...')
      delay(5000).then(() => {
        bnEvents = new EventSource(bnEventsUrl);
        bnEvents.addEventListener('head', headEventReceived);
        bnEvents.onerror = headEventError;
      });
    };

    bnEvents.addEventListener('head', headEventReceived);
    bnEvents.onerror = headEventError;

  });
};

main();

