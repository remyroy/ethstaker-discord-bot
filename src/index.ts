import { config } from 'dotenv';
config();

import {
  Client, GatewayIntentBits, userMention, channelMention,
  GuildMemberRoleManager, TextChannel, ModalBuilder, TextInputBuilder,
  TextInputStyle, ActionRowBuilder, ModalSubmitInteraction,
  CommandInteraction, ButtonBuilder, ButtonInteraction, ButtonStyle, EmbedBuilder, GuildMember } from 'discord.js';
import { ethers } from "ethers";
import { Database, RunResult } from 'sqlite3';

import { MessageFlags } from 'discord-api-types/v9';
import { DateTime, Duration } from 'luxon';
import { Mutex } from 'async-mutex';

import EventSource from 'eventsource';
import axios from 'axios';
import seedrandom from 'seedrandom';

const db = new Database('db.sqlite');
const quickNewRequest = Duration.fromObject({ days: 1 });
const maxTransactionCost = ethers.parseUnits("0.0001", "ether");
const cheapDepositCost = ethers.parseUnits("0.0001", "ether");
const cheapDepositCount = 2;
const minRelativeCheapDepositCount = 5;
const validatorDepositCost = ethers.parseUnits("32", "ether");

const newAccountDelay = Duration.fromObject({ days: 14 });
const joinedDiscordServerDelay = Duration.fromObject({ hours: 44 });

const verifiedNewAccountDelay = Duration.fromObject({ days: 7 });
const verifiedJoinedDiscordServerDelay = Duration.fromObject({ hours: 20 });

const cheapDepositHoleskyDelay = Duration.fromObject({ days: 20 });
const cheapDepositHoodiDelay = Duration.fromObject({ days: 20 });

const restrictedRoles = new Set<string>(process.env.ROLE_IDS?.split(','));
restrictedRoles.add(process.env.PASSPORT_ROLE_ID as string);

const passportScoreThreshold = Number(process.env.PASSPORT_SCORE_THRESHOLD);

const EPOCHS_PER_DAY = 225;
const MIN_PER_EPOCH_CHURN_LIMIT = 4;
const CHURN_LIMIT_QUOTIENT = 65536;
const MAX_PER_EPOCH_ACTIVATION_CHURN_LIMIT = 8;

const GITCOIN_PASSPORT_URL = 'https://passport.gitcoin.co/';

const PASSPORT_SCORE_URI = `https://api.scorer.gitcoin.co/registry/score/${process.env.GITCOIN_PASSPORT_SCORER_ID}/`;
const SUBMIT_PASSPORT_URI = 'https://api.scorer.gitcoin.co/registry/submit-passport';

const depositProxyContractHoleskyAddress = process.env.PROXY_HOLESKY_DEPOSIT_CONTRACT as string;
const depositProxyContractHoodiAddress = process.env.PROXY_HOODI_DEPOSIT_CONTRACT as string;
const depositProxyContractAbi = [
  "function balanceOf(address,uint256) view returns (uint256)",
  "function safeTransferFrom(address,address,uint256,uint256,bytes)",
];

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
  minEthers: bigint;
  requestAmount: bigint;
  wallet: ethers.Wallet;
  provider: ethers.Provider;
  transactionMutex: Mutex;
  needsVerification: boolean;
};

interface queueConfig {
  network: string;
  apiQueueUrl: string;
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function validator_churn_limit(active_validators?: number): number {
  let validators = 1;
  if (active_validators !== undefined){
    validators = active_validators;
  }
  return Math.max(MIN_PER_EPOCH_CHURN_LIMIT, Math.floor(validators / CHURN_LIMIT_QUOTIENT))
}

function churn_limit_per_day(churn_limit: number) {
  return churn_limit * EPOCHS_PER_DAY;
}

function get_validator_activation_churn_limit(network: string, active_validators?: number): number {
    return Math.min(MAX_PER_EPOCH_ACTIVATION_CHURN_LIMIT, validator_churn_limit(active_validators));
}

const main = function() {
  return new Promise<void>(async (mainResolve, mainReject) => {

    const mainnetProvider = new ethers.InfuraProvider('mainnet', process.env.INFURA_API_KEY);

    mainnetProvider.getBlockNumber()
    .then((currentBlockNumber) => {
      console.log(`Mainnet RPC provider is at block number ${currentBlockNumber}.`);
    });

    const holeskyProvider = new ethers.JsonRpcProvider(process.env.HOLESKY_RPC_ENDPOINT);
    const hoodiProvider = new ethers.JsonRpcProvider(process.env.HOODI_RPC_ENDPOINT);

    const holeskyTransactionMutex = new Mutex();
    const hoodiTransactionMutex = new Mutex();

    holeskyProvider.getBlockNumber()
    .then((currentBlockNumber) => {
      console.log(`Holesky RPC provider is at block number ${currentBlockNumber}.`);
    })
    .catch((error) => {
      console.log(`${error} while trying to get block number from Holesky provider.`);
    });

    hoodiProvider.getBlockNumber()
    .then((currentBlockNumber) => {
      console.log(`Hoodi RPC provider is at block number ${currentBlockNumber}.`);
    })
    .catch((error) => {
      console.log(`${error} while trying to get block number from Hoodi provider.`);
    });

    // Configuring the faucet commands
    const faucetCommandsConfig = new Map<string, networkConfig>();

    const holeskyWallet = new ethers.Wallet(process.env.FAUCET_PRIVATE_KEY as string, holeskyProvider);
    const hoodiWallet = new ethers.Wallet(process.env.FAUCET_PRIVATE_KEY as string, hoodiProvider);

    /*
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
      minEthers: validatorDepositCost + (maxTransactionCost * 2n),
      requestAmount: ethers.parseUnits("1", "ether"),
      wallet: new ethers.Wallet(process.env.FAUCET_PRIVATE_KEY as string, sepoliaProvider),
      provider: sepoliaProvider,
      transactionMutex: sepoliaTransactionMutex,
      needsVerification: true,
    });*/

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
        wallet.provider?.getBalance(wallet.getAddress()).then((balance) => {
          console.log(`${network} faucet wallet balance is ${ethers.formatEther(balance)}.`);
          if (balance < minEthers) {
            console.warn(`Not enough ${currency} to provide services for the ${network} faucet.`);
          } else {
            const remainingRequests = balance / requestAmount;
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

    queueCommandsConfig.set('queue-holesky', {
      network: 'Holesky',
      apiQueueUrl: 'https://holesky.beaconcha.in/api/v1/validators/queue'
    });

    const initDb = function(db: Database, faucetCommandsConfig: Map<string, networkConfig>) {
      return new Promise<void>(async (resolve, reject) => {
        db.serialize(() => {
          db.run(`CREATE TABLE IF NOT EXISTS passport (walletAddress TEXT PRIMARY KEY UNIQUE NOT NULL, userId TEXT NOT NULL);`, (error: Error | null) => {
            if (error !== null) {
              reject(error);
              return;
            }
          });

          db.run(`CREATE UNIQUE INDEX IF NOT EXISTS passport_walletAddress on passport ( walletAddress );`, (error: Error | null) => {
            if (error !== null) {
              reject(error);
              return;
            }
          });

          db.run(`CREATE TABLE IF NOT EXISTS passport_stamp (passport INTEGER NOT NULL, provider TEXT NOT NULL, hash TEXT NOT NULL);`, (error: Error | null) => {
            if (error !== null) {
              reject(error);
              return;
            }
          });

          db.run(`CREATE UNIQUE INDEX IF NOT EXISTS passport_stamp_provider_hash on passport_stamp ( provider, hash );`, (error: Error | null) => {
            if (error !== null) {
              reject(error);
              return;
            }
          });

          db.run(`CREATE TABLE IF NOT EXISTS cheap_deposit (walletAddress TEXT UNIQUE NOT NULL, userId TEXT UNIQUE NOT NULL, lastRequested INTEGER NOT NULL);`, (error: Error | null) => {
            if (error !== null) {
              reject(error);
              return;
            }
          });

          db.run(`CREATE UNIQUE INDEX IF NOT EXISTS cheap_deposit_walletAddress on passport ( walletAddress );`, (error: Error | null) => {
            if (error !== null) {
              reject(error);
              return;
            }
          });

          db.run(`CREATE UNIQUE INDEX IF NOT EXISTS cheap_deposit_userId on passport ( userId );`, (error: Error | null) => {
            if (error !== null) {
              reject(error);
              return;
            }
          });

          db.run(`CREATE TABLE IF NOT EXISTS cheap_deposit_holesky (walletAddress TEXT UNIQUE NOT NULL, userId TEXT UNIQUE NOT NULL, lastRequested INTEGER NOT NULL);`, (error: Error | null) => {
            if (error !== null) {
              reject(error);
              return;
            }
          });

          db.run(`CREATE UNIQUE INDEX IF NOT EXISTS cheap_deposit_holesky_walletAddress on cheap_deposit_holesky ( walletAddress );`, (error: Error | null) => {
            if (error !== null) {
              reject(error);
              return;
            }
          });

          db.run(`CREATE UNIQUE INDEX IF NOT EXISTS cheap_deposit_holesky_userId on cheap_deposit_holesky ( userId );`, (error: Error | null) => {
            if (error !== null) {
              reject(error);
              return;
            }
          });

          db.run(`CREATE TABLE IF NOT EXISTS cheap_deposit_hoodi (walletAddress TEXT UNIQUE NOT NULL, userId TEXT UNIQUE NOT NULL, lastRequested INTEGER NOT NULL);`, (error: Error | null) => {
            if (error !== null) {
              reject(error);
              return;
            }
          });

          db.run(`CREATE UNIQUE INDEX IF NOT EXISTS cheap_deposit_hoodi_walletAddress on cheap_deposit_hoodi ( walletAddress );`, (error: Error | null) => {
            if (error !== null) {
              reject(error);
              return;
            }
          });

          db.run(`CREATE UNIQUE INDEX IF NOT EXISTS cheap_deposit_hoodi_userId on cheap_deposit_hoodi ( userId );`, (error: Error | null) => {
            if (error !== null) {
              reject(error);
              return;
            }
          });

          let index = 0;
          faucetCommandsConfig.forEach((config, key, map) => {
            const tableName = config.requestTable;
            const lastOne = (index + 1 === map.size);
            db.run(`CREATE TABLE IF NOT EXISTS ${tableName} (userId TEXT PRIMARY KEY UNIQUE NOT NULL, lastRequested INTEGER NOT NULL, lastAddress TEXT NOT NULL);`, (error: Error | null) => {
              if (error !== null) {
                reject(error);
                return;
              }
            });
            db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${tableName}_userID on ${tableName} ( userID );`, (error: Error | null) => {
              if (error !== null) {
                reject(error);
                return;
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
                return;
              }

              if (!hasLastAddress) {
                db.run(`ALTER TABLE ${tableName} ADD COLUMN lastAddress TEXT NOT NULL DEFAULT '';`, (error: Error | null) => {
                  if (error !== null) {
                    reject(error);
                    return;
                  }
                  if (lastOne) {
                    resolve();
                  }
                });
              } else {
                if (lastOne) {
                  resolve();
                }
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

    interface lastCheapDepositRequest {
      walletAddress: string,
      lastRequested: number;
    }

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

    const getLastCheapDepositHoleskyRequest = function(userId: string) {
      return new Promise<lastCheapDepositRequest | null>(async (resolve, reject) => {
        db.get(`SELECT walletAddress, lastRequested from cheap_deposit_holesky WHERE userId = ?;`, userId, (error: Error | null, row: any ) => {
          if (error !== null) {
            reject(error);
            return;
          }
          if (row === undefined) {
            resolve(null);
          } else {
            const value = row as lastCheapDepositRequest;
            resolve(value);
          }
        });
      });
    };

    const isCheapDepositsHoleskyWalletAlreadyUsed = function(walletAddress: string, userId: string) {
      return new Promise<boolean>(async (resolve, reject) => {
        db.get(`SELECT walletAddress from cheap_deposit_holesky WHERE walletAddress = ? and userId != ?;`, walletAddress, userId, (error: Error | null, row: any ) => {
          if (error !== null) {
            reject(error);
            return;
          }
          if (row === undefined) {
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
    }

    const storeCheapDepositsHolesky = function(walletAddress: string, userId: string) {
      return new Promise<void>(async (resolve, reject) => {
        db.serialize(() => {
          let doInsert = true;
          db.get(`SELECT walletAddress, lastRequested from cheap_deposit_holesky WHERE userId = ?;`, userId, (error: Error | null, row: any ) => {
            if (error !== null) {
              reject(error);
              return;
            }
            if (row !== undefined) {
              doInsert = false;
            }

            const lastRequested = Math.floor(DateTime.utc().toMillis() / 1000);
            if (doInsert) {
              db.run(`INSERT INTO cheap_deposit_holesky(walletAddress, userId, lastRequested) VALUES(?, ?, ?);`, walletAddress, userId, lastRequested, (error: Error | null) => {
                if (error !== null) {
                  reject(error);
                  return;
                }
                resolve();
              });
            } else {
              db.run(`UPDATE cheap_deposit_holesky SET walletAddress = ?, lastRequested = ? WHERE userId = ?;`, walletAddress, lastRequested, userId, (error: Error | null) => {
                if (error !== null) {
                  reject(error);
                  return;
                }
                resolve();
              });
            }
          });
        });
      });
    };

    const getLastCheapDepositHoodiRequest = function(userId: string) {
      return new Promise<lastCheapDepositRequest | null>(async (resolve, reject) => {
        db.get(`SELECT walletAddress, lastRequested from cheap_deposit_hoodi WHERE userId = ?;`, userId, (error: Error | null, row: any ) => {
          if (error !== null) {
            reject(error);
            return;
          }
          if (row === undefined) {
            resolve(null);
          } else {
            const value = row as lastCheapDepositRequest;
            resolve(value);
          }
        });
      });
    };

    const isCheapDepositsHoodiWalletAlreadyUsed = function(walletAddress: string, userId: string) {
      return new Promise<boolean>(async (resolve, reject) => {
        db.get(`SELECT walletAddress from cheap_deposit_hoodi WHERE walletAddress = ? and userId != ?;`, walletAddress, userId, (error: Error | null, row: any ) => {
          if (error !== null) {
            reject(error);
            return;
          }
          if (row === undefined) {
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
    }

    const storeCheapDepositsHoodi = function(walletAddress: string, userId: string) {
      return new Promise<void>(async (resolve, reject) => {
        db.serialize(() => {
          let doInsert = true;
          db.get(`SELECT walletAddress, lastRequested from cheap_deposit_hoodi WHERE userId = ?;`, userId, (error: Error | null, row: any ) => {
            if (error !== null) {
              reject(error);
              return;
            }
            if (row !== undefined) {
              doInsert = false;
            }

            const lastRequested = Math.floor(DateTime.utc().toMillis() / 1000);
            if (doInsert) {
              db.run(`INSERT INTO cheap_deposit_hoodi(walletAddress, userId, lastRequested) VALUES(?, ?, ?);`, walletAddress, userId, lastRequested, (error: Error | null) => {
                if (error !== null) {
                  reject(error);
                  return;
                }
                resolve();
              });
            } else {
              db.run(`UPDATE cheap_deposit_hoodi SET walletAddress = ?, lastRequested = ? WHERE userId = ?;`, walletAddress, lastRequested, userId, (error: Error | null) => {
                if (error !== null) {
                  reject(error);
                  return;
                }
                resolve();
              });
            }
          });
        });
      });
    };

    const isPassportWalletAlreadyUsed = function(walletAddress: string) {
      return new Promise<boolean>(async (resolve, reject) => {
        db.get(`SELECT walletAddress from passport WHERE walletAddress = ?;`, walletAddress, (error: Error | null, row: any ) => {
          if (error !== null) {
            reject(error);
            return;
          }
          if (row === undefined) {
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
    };

    const storePassportWallet = function(walletAddress: string, userId: string) {
      return new Promise<number>(async (resolve, reject) => {
        db.serialize(() => {
          const callback = function (this: RunResult, error: Error | null) {
            if (error !== null) {
              reject(error);
            }
            resolve(this.lastID);
          };
          db.run(`INSERT INTO passport(walletAddress, userId) VALUES(?, ?);`, walletAddress, userId, callback);
        });
      });
    };

    const getLastRequest = function(userId: string, tableName: string) {
      return new Promise<lastRequest | null>(async (resolve, reject) => {
        db.get(`SELECT lastRequested, lastAddress from ${tableName} WHERE userId = ?;`, userId, (error: Error | null, row: any ) => {
          if (error !== null) {
            reject(error);
            return;
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
              return;
            }
            if (row !== undefined) {
              doInsert = false;
            }

            const lastRequested = Math.floor(DateTime.utc().toMillis() / 1000);
            if (doInsert) {
              db.run(`INSERT INTO ${tableName}(userId, lastRequested, lastAddress) VALUES(?, ?, ?);`, userId, lastRequested, address, (error: Error | null) => {
                if (error !== null) {
                  reject(error);
                  return;
                }
                resolve();
              });
            } else {
              db.run(`UPDATE ${tableName} SET lastRequested = ?, lastAddress = ? WHERE userId = ?;`, lastRequested, address, userId, (error: Error | null) => {
                if (error !== null) {
                  reject(error);
                  return;
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

      if (interaction.isCommand()) {
        handleCommandInteraction(interaction).catch(message => {
          console.log(`Command rejected: ${message}`);
        });
      } else if (interaction.isModalSubmit()) {
        handleModalSubmitInteraction(interaction).catch(message => {
          console.log(`Modal submission rejected: ${message}`);
        });
      } else if (interaction.isButton()) {
        handleButtonInteraction(interaction).catch(message => {
          console.log(`Button rejected: ${message}`);
        });
      }

    });

    const handleCommandInteraction = function(interaction: CommandInteraction) {
      return new Promise<void>(async (resolve, reject) => {

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
            reject('No permission to use this command.');
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
          const transactionMutex = config.transactionMutex;

          if (channelName !== undefined && channelName !== '') {
            const restrictChannel = interaction.guild?.channels.cache.find((channel) => channel.name === channelName);
            if (restrictChannel !== undefined) {
              if (interaction.channelId !== restrictChannel.id) {
                const channelMen = channelMention(restrictChannel.id);
                await interaction.reply({
                  content: `This is the wrong channel for this bot command (${commandName}). You should try in ${channelMen} for ${userMen}.`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                reject(`This is the wrong channel for this bot command (${commandName}). You should try in #${restrictChannel.name} for @${userTag} (${userId}).`);
                return;
              }
            }
          }

          // mutex on userId
          const existingRequest = config.existingRequest;

          if (existingRequest.get(userId) === true) {
            await interaction.reply({
              content: `You already have a pending request. Please wait until your request is completed for ${userMen}.`,
              allowedMentions: { parse: ['users'], repliedUser: false }
            });
            reject(`You already have a pending request. Please wait until your request is completed for @${userTag} (${userId}).`);
            return;
          } else {
            existingRequest.set(userId, true);
          }

          try {

            // Check for user role
            await interaction.reply({ content: 'Checking if you have the proper role...', ephemeral: true });
            if (config.needsVerification) {
              const hasRole = restrictedRoles.size === 0 || (interaction.member?.roles as GuildMemberRoleManager).cache.find((role) => restrictedRoles.has(role.id)) !== undefined;
              if (!hasRole) {
                const brightIdMention = channelMention(process.env.BRIGHTID_VERIFICATION_CHANNEL_ID as string);
                const passportVerificationMention = channelMention(process.env.PASSPORT_CHANNEL_ID as string);

                await interaction.followUp({
                  content: `You cannot use this command without the correct role. Join ${brightIdMention} or ${passportVerificationMention} to get started for ${userMen}.`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                reject(`You cannot use this command without the correct role for @${userTag} (${userId}).`);
                return;
              }
            }

            const userCreatedAt = interaction.user.createdTimestamp;
            const userExistDuration = DateTime.utc().toMillis() - userCreatedAt;

            const memberJoinedAt = (interaction.member as GuildMember).joinedTimestamp;
            const memberDuration = DateTime.utc().toMillis() - (memberJoinedAt as number);

            // Check for new accounts
            await interaction.editReply({
              content: `Checking if you have a new account...`
            });
            if (userExistDuration < newAccountDelay.toMillis()) {
              await interaction.followUp({
                content: `Your Discord account was just created. We need to ` +
                        `restrict access for this command (${commandName}) for new accounts ` +
                        `because of abuses. ` +
                        `Please try again in a few days for ${userMen}.`,
              });
              reject(`Your Discord account was just created. We need to restrict access for new accounts because of abuses. Please try again in a few days for ${userTag} (${userId})`);
              return;
            }

            // Check for new guild member
            await interaction.editReply({
              content: `Checking if you recently joined the EthStaker Discord server...`
            });
            if (memberDuration < joinedDiscordServerDelay.toMillis()) {
              await interaction.followUp({
                content: `You just joined the EthStaker Discord server. We need to ` +
                        `restrict access for this command (${commandName}) for members ` +
                        `who just joined because of abuses. ` +
                        `Please try again in a few days for ${userMen}.`,
              });
              reject(`You just joined the EthStaker Discord server. We need to restrict access for members who just joined because of abuses. Please try again in a few days for ${userTag} (${userId})`);
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
                await interaction.followUp({
                  content: `You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for ${userMen}.`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                reject(`You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for @${userTag} (${userId}).`);
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
              await interaction.followUp({
                content: `You cannot do another request this soon my friend. You will need to wait at least ${formattedDuration} before you can request again for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`You cannot do another request this soon my friend. You will need to wait at least ${formattedDuration} before you can request again for @${userTag} (${userId}).`);
              return;
            }

            // Potentially resolving the ENS address
            if (targetAddress.indexOf('.') >= 0) {
              await interaction.editReply(`Resolving ENS ${targetAddress}...`);
              try {
                const resolvedAddress = await mainnetProvider.resolveName(targetAddress);
                if (resolvedAddress === null) {
                  await interaction.followUp({
                    content: `No address found for ENS ${targetAddress} for ${userMen}.`,
                    allowedMentions: { parse: ['users'], repliedUser: false }
                  });
                  reject(`No address found for ENS ${targetAddress} for @${userTag} (${userId}).`);
                  return;
                }
                targetAddress = resolvedAddress;
              } catch (error) {
                await interaction.followUp({
                  content: `Error while trying to resolved ENS ${targetAddress} for ${userMen}. ${error}`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                reject(`Error while trying to resolved ENS ${targetAddress} for @${userTag} (${userId}). ${error}`);
                return;
              }
            } else {
              // Valid address check
              await interaction.editReply(`Checking if ${targetAddress} is a valid address...`);
              if (!ethers.isAddress(targetAddress)) {
                await interaction.followUp({
                  content: `The wallet address provided (${targetAddress}) is not valid for ${userMen}`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                reject(`The wallet address provided (${targetAddress}) is not valid for @${userTag} (${userId})`);
                return;
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
              if (targetBalance >= requestAmount) {
                await storeLastRequest(userId, targetAddress, tableName);

                const enoughReason = config.enoughReason;
                await interaction.followUp({
                  content: `You already have ${ethers.formatEther(targetBalance)} ${currency} in ${targetAddress}. ${enoughReason} for ${userMen}.`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                reject(`You already have ${ethers.formatEther(targetBalance)} ${currency} in ${targetAddress}. ${enoughReason} for @${userTag} (${userId}).`);
                return;
              }
              sendingAmount = requestAmount - targetBalance;
            } catch (error) {
              await interaction.followUp(`Error while trying to get balance from ${targetAddress} for ${userMen}. ${error}`);
              reject(`Error while trying to get balance from ${targetAddress} for @${userTag} (${userId}). ${error}`);
              return;
            }

            // Verify that we have enough currency left in the faucet
            const wallet = config.wallet;
            const network = config.network;
            const minNeeded = sendingAmount + maxTransactionCost;
            let faucetBalance = 0n;

            await interaction.editReply('Checking if we have enough fund for this request...');
            try {
              faucetBalance = await wallet.provider?.getBalance(wallet.getAddress()) as bigint;
              if (faucetBalance < minNeeded) {
                await interaction.followUp({
                  content: `The ${network} faucet is empty. Please contact an administrator to fill it up. From ${userMen}.`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                reject(`The ${network} faucet is empty. Please contact an administrator to fill it up. From @${userTag} (${userId}).`);
                return;
              }
            } catch (error) {
              await interaction.followUp(`Error while trying to get balance from the ${network} faucet for ${userMen}. ${error}`);
              reject(`Error while trying to get balance from the ${network} faucet for @${userTag} (${userId}). ${error}`);
              return;
            }

            // Send the currency
            await interaction.editReply(`Sending ${ethers.formatEther(sendingAmount)} ${currency} to ${targetAddress}...`);
            try {
              let transaction: ethers.TransactionResponse | null = null;
              let explorerTxURL: string | null = null;
              await transactionMutex.runExclusive(async () => {
                transaction = await wallet.sendTransaction({
                  to: targetAddress,
                  value: sendingAmount
                });

                if (transaction === null) {
                  await interaction.followUp(`Sending currency failed on ${network} faucet for ${userMen}.`);
                  reject(`Sending currency failed on ${network} faucet for @${userTag} (${userId}).`);
                  return;
                }
  
                transaction = transaction as unknown as ethers.TransactionResponse;
  
                const transactionHash = transaction.hash;
                const explorerTxRoot = config.explorerTxRoot;
                explorerTxURL = explorerTxRoot + transactionHash;
                await interaction.editReply(`${ethers.formatEther(sendingAmount)} ${currency} have been sent to ${targetAddress}. Explore that transaction on ${explorerTxURL}. Waiting for 1 confirm...`);
                await transaction.wait(1);
              });

              await storeLastRequest(userId, targetAddress, tableName);
              
              await interaction.editReply(`Transaction confirmed with 1 block confirmation.`);
              
              const remainingRequests = (faucetBalance - sendingAmount) / requestAmount;
              console.log(`${ethers.formatEther(sendingAmount)} ${currency} have been sent to ${targetAddress} for @${userTag} (${userId}).${newRequestPart}`);
              console.log(`There are ${remainingRequests} remaining requests with the current balance.`);

              await interaction.followUp({
                content: `${ethers.formatEther(sendingAmount)} ${currency} have been sent to ${targetAddress} for ${userMen}.${newRequestPart} Explore that transaction on ${explorerTxURL}\n\nThere are ${remainingRequests} remaining requests with the current balance.`,
                allowedMentions: { parse: ['users'], repliedUser: false },
                flags: MessageFlags.SuppressEmbeds });

            } catch (error) {
              console.log(`Error while trying to send ${ethers.formatEther(sendingAmount)} ${currency} to ${targetAddress} for @${userTag} (${userId}). ${error}`);
              console.log(error);
              await interaction.followUp(`Error while trying to send ${ethers.formatEther(sendingAmount)} ${currency} to ${targetAddress} for ${userMen}. ${error}`);
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

          try {
            await interaction.reply({ content: `Querying beaconcha.in API for ${network} queue details...`, ephemeral: true });
            const response = await axios.get(apiQueueUrl);
            if (response.status !== 200) {
              await interaction.followUp(`Unexpected status code from querying beaconcha.in API for ${network} queue details. Status code ${response.status} for ${userMen}.`);
              reject(`Unexpected status code from querying beaconcha.in API for ${network} queue details. Status code ${response.status} for @${userTag} (${userId}).`);
              return;
            }

            interface queueResponse {
              status: string,
              data: {
                beaconchain_entering: number,
                beaconchain_exiting: number,
                validatorscount?: number,
              }
            };

            const queryResponse = response.data as queueResponse;

            if (queryResponse.status !== "OK") {
              await interaction.followUp(`Unexpected body status from querying beaconcha.in API for ${network} queue details. Body status ${queryResponse.status} for ${userMen}.`);
              reject(`Unexpected body status from querying beaconcha.in API for ${network} queue details. Body status ${queryResponse.status} for @${userTag} (${userId}).`);
              return;
            }

            const activationNormalProcessingMsg = 'It should only take 16-24 hours for a new deposit to be processed and an associated validator to be activated.';
            const activationNormalProcessingMaxDuration = Duration.fromObject({ hours: 24 });

            let activationQueueMessage = `The **activation queue** is empty. ${activationNormalProcessingMsg}`;
            let exitQueueMessage = 'The **exit queue** is empty. It should only take a few minutes for a validator to leave the exit queue. The exit queue is only a small part of the full exit / withdrawal process. See [this diagram](https://files.ethstaker.cc/exit-process.png) for more details.';

            if (queryResponse.data.beaconchain_entering > 0) {
              const activationChurnLimit = get_validator_activation_churn_limit(network, queryResponse.data.validatorscount);
              const activationChurnPerDay = churn_limit_per_day(activationChurnLimit);

              const activationChurnText = `(churn limit is ${activationChurnLimit} per epoch or ${activationChurnPerDay} per day with ${queryResponse.data.validatorscount} validators)`;

              const activationDays = queryResponse.data.beaconchain_entering / activationChurnPerDay;
              let activationDuration = Duration.fromObject({ days: activationDays }).shiftTo('days', 'hours').normalize();
              if (activationDuration.days === 0) {
                activationDuration = activationDuration.shiftTo('hours', 'minutes');
              }
              const formattedActivationDuration = activationDuration.toHuman();

              if (activationDuration.toMillis() <= activationNormalProcessingMaxDuration.toMillis()) {
                activationQueueMessage = `There are **${queryResponse.data.beaconchain_entering} validators awaiting to be activated**. The queue should clear out in ${formattedActivationDuration} if there is no new deposit ${activationChurnText}. ${activationNormalProcessingMsg}`;
              } else {
                activationQueueMessage = `There are **${queryResponse.data.beaconchain_entering} validators awaiting to be activated**. It should take at least ${formattedActivationDuration} for a new deposit to be processed and an associated validator to be activated ${activationChurnText}.`;
              }
            }
            if (queryResponse.data.beaconchain_exiting > 0) {
              const exitChurnLimit = validator_churn_limit(queryResponse.data.validatorscount);
              const exitChurnPerDay = churn_limit_per_day(exitChurnLimit);

              const exitChurnText = `(churn limit is ${exitChurnLimit} per epoch or ${exitChurnPerDay} per day with ${queryResponse.data.validatorscount} validators)`;

              const exitDays = queryResponse.data.beaconchain_exiting / exitChurnPerDay;
              let exitDuration = Duration.fromObject({ days: exitDays }).shiftTo('days', 'hours').normalize();
              if (exitDuration.days === 0) {
                exitDuration = exitDuration.shiftTo('hours', 'minutes');
              }
              const formattedExitDuration = exitDuration.toHuman();

              exitQueueMessage = `There are **${queryResponse.data.beaconchain_exiting} validators awaiting to exit** the network. It should take at least ${formattedExitDuration} for a voluntary exit to be processed and an associated validator to leave the exit queue ${exitChurnText}. The exit queue is only a small part of the full exit / withdrawal process. See [this diagram](https://files.ethstaker.cc/exit-process.png) for more details.`;
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

        } else if (commandName === 'sepolia-eth-msg') {
          console.log(`${commandName} from ${userTag} (${userId})`);

          let targetUser = 'You';

          const inputUser = interaction.options.getUser('user', false);
          if (inputUser !== null) {
            targetUser = userMention(inputUser.id);
          }

          const msg = (
            `${targetUser} can use these online faucets https://faucetlink.to/sepolia to obtain ` +
            `Sepolia ETH for ${userMen}`
            );
          
          interaction.reply({
            content: msg,
            flags: MessageFlags.SuppressEmbeds
          });

        } else if (commandName === 'holesky-msg') {
          console.log(`${commandName} from ${userTag} (${userId})`);

          const cheapHoleskyValidatorMention = channelMention(process.env.CHEAP_HOLESKY_VALIDATOR_CHANNEL_ID as string);

          let targetUser = 'You';

          const inputUser = interaction.options.getUser('user', false);
          if (inputUser !== null) {
            targetUser = userMention(inputUser.id);
          }

          const msg = (
            `If you want to perform your Holesky validator deposit, use ` +
            `${cheapHoleskyValidatorMention} and the \`/cheap-holesky-deposit\` slash command ` +
            `(start typing the command and it will show up above your input box). This process ` +
            `will not directly give you any meaningful amount of Holesky ETH, but it will ` +
            `enable you to become a validator on Holesky for free. If you need ` +
            `Holesky ETH for any purpose, check out the great online faucets on ` +
            `<https://faucetlink.to/holesky> for ${targetUser}.`
            );
          
          interaction.reply({
            content: msg,
            flags: MessageFlags.SuppressEmbeds
          });

        } else if (commandName === 'hoodi-msg') {
          console.log(`${commandName} from ${userTag} (${userId})`);

          const cheapHoodiValidatorMention = channelMention(process.env.CHEAP_HOODI_VALIDATOR_CHANNEL_ID as string);

          let targetUser = 'You';

          const inputUser = interaction.options.getUser('user', false);
          if (inputUser !== null) {
            targetUser = userMention(inputUser.id);
          }

          const msg = (
            `If you want to perform your Hoodi validator deposit, use ` +
            `${cheapHoodiValidatorMention} and the \`/cheap-hoodi-deposit\` slash command ` +
            `(start typing the command and it will show up above your input box). This process ` +
            `will not directly give you any meaningful amount of Hoodi ETH, but it will ` +
            `enable you to become a validator on Hoodi for free. If you need ` +
            `Hoodi ETH for any purpose, check out this great online faucet on ` +
            `<https://hoodi-faucet.pk910.de/> for ${targetUser}.`
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
              await interaction.reply({
                content: `This is the wrong channel for this bot command (${commandName}). You should try in ${channelMen} for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`This is the wrong channel for this bot command (${commandName}). You should try in #${restrictChannel.name} for @${userTag} (${userId}).`);
              return;
            }
          }

          // Check if the user already has the role.
          const hasRole = (interaction.member?.roles as GuildMemberRoleManager).cache.find((role) => role.id === process.env.PASSPORT_ROLE_ID) !== undefined;
          if (hasRole) {
            await interaction.reply({
              content: `You already have the role associated with being verified with Gitcoin Passport. No need to verify again for ${userMen}.`,
            });
            reject(`User already has Passport verified role. ${userTag} (${userId})`);
            return;
          }

          const my_request = { requested_message: `My Discord user ${userTag} (${userId}) has access to this Gitcoin Passport address.` };
          const url_safe_string = encodeURIComponent( JSON.stringify( my_request ) );
          const base64_encoded = Buffer.from(url_safe_string).toString('base64').replace('+', '-').replace('/', '_').replace(/=+$/, '');
          const signer_is_url = `https://signer.is/#/sign/${ base64_encoded }`;

          const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(new ButtonBuilder()
              .setCustomId('sendSignature')
              .setStyle(ButtonStyle.Primary)
              .setLabel('Enter Signature'));

          await interaction.reply({
            content: `Create [your Gitcoin Passport](${GITCOIN_PASSPORT_URL}), add enough stamps in it and ` +
                     `prove you own that wallet address. Once you are done filling ` +
                     `your Gitcoin Passport, click on [this Signer.is link](${signer_is_url}) to sign a message ` +
                     `proving ownership, click the *Copy Link* button on Signer.is ` +
                     `and click the **Enter Signature** button to paste your signature URL.`,
            components: [row],
            ephemeral: true
          });

        } else if (commandName === 'cheap-holesky-deposit') {
          console.log(`${commandName} from ${userTag} (${userId})`);

          // Restrict command to channel
          const restrictChannel = interaction.guild?.channels.cache.find((channel) => channel.id === process.env.CHEAP_HOLESKY_VALIDATOR_CHANNEL_ID);
          if (restrictChannel !== undefined) {
            if (interaction.channelId !== restrictChannel.id) {
              const channelMen = channelMention(restrictChannel.id);
              await interaction.reply({
                content: `This is the wrong channel for this bot command (${commandName}). You should try in ${channelMen} for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`This is the wrong channel for this bot command (${commandName}). You should try in #${restrictChannel.name} for @${userTag} (${userId}).`);
              return;
            }
          }

          const userCreatedAt = interaction.user.createdTimestamp;
          const userExistDuration = DateTime.utc().toMillis() - userCreatedAt;
          const officialLinksMen = channelMention(process.env.OFFICIAL_LINKS_CHANNEL_ID as string);

          const memberJoinedAt = (interaction.member as GuildMember).joinedTimestamp;
          const memberDuration = DateTime.utc().toMillis() - (memberJoinedAt as number);

          // Check for user role
          await interaction.reply({ content: 'Checking if you have the proper role to speed up delay period...', ephemeral: true });
          const hasRole = restrictedRoles.size === 0 || (interaction.member?.roles as GuildMemberRoleManager).cache.find((role) => restrictedRoles.has(role.id)) !== undefined;
          if (!hasRole) {
            const brightIdMention = channelMention(process.env.BRIGHTID_VERIFICATION_CHANNEL_ID as string);
            const passportVerificationMention = channelMention(process.env.PASSPORT_CHANNEL_ID as string);

            // Check for new accounts
            await interaction.editReply({
              content: `Checking if you have a new account...`
            });
            if (userExistDuration < newAccountDelay.toMillis()) {
              await interaction.followUp({
                content: `Your Discord account was just created. We need to ` +
                        `restrict access for new accounts because of abuses. ` +
                        `Please try again in a few days. You can speed this up ` +
                        `by completing one of the verification processes in ` +
                        `${brightIdMention} or in ${passportVerificationMention}. ` +
                        `If you need ` +
                        `Holesky ETH, you should be using online faucets like ` +
                        `those you can find on <https://faucetlink.to/holesky>. ` +
                        `If you already have ` +
                        `32 Holesky ETH, you can use the official launchpad on ` +
                        `<https://holesky.launchpad.ethereum.org>.\n` +
                        `New accounts generally do not come directly asking for cheap deposits. ` +
                        `You might want to check out the guides and tools that exist for configuring ` +
                        `your machine to run a validator on Holesky in ${officialLinksMen} first for ${userMen}.`,
              });
              reject(`Your Discord account was just created. We need to restrict access for new accounts because of abuses. Please try again in a few days for ${userTag} (${userId})`);
              return;
            }

            // Check for new guild member
            await interaction.editReply({
              content: `Checking if you recently joined the EthStaker Discord server...`
            });
            if (memberDuration < joinedDiscordServerDelay.toMillis()) {
              await interaction.followUp({
                content: `You just joined the EthStaker Discord server. We need to ` +
                        `restrict access for members who just joined because of abuses. ` +
                        `Please try again in a few days. You can speed this up ` +
                        `by completing one of the verification processes in ` +
                        `${brightIdMention} or in ${passportVerificationMention}. ` +
                        `If you need ` +
                        `Holesky ETH, you should be using online faucets like ` +
                        `those you can find on <https://faucetlink.to/holesky>. ` +
                        `If you already have ` +
                        `32 Holesky ETH, you can use the official launchpad on ` +
                        `<https://holesky.launchpad.ethereum.org>.\n` +
                        `New members generally do not come directly asking for cheap deposits. ` +
                        `You might want to check out the guides and tools that exist for configuring ` +
                        `your machine to run a validator on Holesky in ${officialLinksMen} first for ${userMen}.`,
              });
              reject(`You just joined the EthStaker Discord server. We need to restrict access for members who just joined because of abuses. Please try again in a few days for ${userTag} (${userId})`);
              return;
            }
          } else {

            // Check for new accounts
            await interaction.editReply({
              content: `Checking if you have a new account...`
            });
            if (userExistDuration < verifiedNewAccountDelay.toMillis()) {
              await interaction.followUp({
                content: `Your Discord account was just created. We need to ` +
                        `restrict access for new accounts because of abuses. ` +
                        `Please try again in a few days. If you need ` +
                        `Holesky ETH, you should be using online faucets like ` +
                        `those you can find on <https://faucetlink.to/holesky>. ` +
                        `If you already have ` +
                        `32 Holesky ETH, you can use the official launchpad on ` +
                        `<https://holesky.launchpad.ethereum.org>.\n` +
                        `New accounts generally do not come directly asking for cheap deposits. ` +
                        `You might want to check out the guides and tools that exist for configuring ` +
                        `your machine to run a validator on Holesky in ${officialLinksMen} first for ${userMen}.`,
              });
              reject(`Your verified Discord account was just created. We need to restrict access for new accounts because of abuses. Please try again in a few days for ${userTag} (${userId})`);
              return;
            }

            // Check for new guild member
            await interaction.editReply({
              content: `Checking if you recently joined the EthStaker Discord server...`
            });
            if (memberDuration < verifiedJoinedDiscordServerDelay.toMillis()) {
              await interaction.followUp({
                content: `You just joined the EthStaker Discord server. We need to ` +
                        `restrict access for members who just joined because of abuses. ` +
                        `Please try again in a few days. If you need ` +
                        `Holesky ETH, you should be using online faucets like ` +
                        `those you can find on <https://faucetlink.to/holesky>. ` +
                        `If you already have ` +
                        `32 Holesky ETH, you can use the official launchpad on ` +
                        `<https://holesky.launchpad.ethereum.org>.\n` +
                        `New members generally do not come directly asking for cheap deposits. ` +
                        `You might want to check out the guides and tools that exist for configuring ` +
                        `your machine to run a validator on Holesky in ${officialLinksMen} first for ${userMen}.`,
              });
              reject(`You just joined the EthStaker Discord server with verification. We need to restrict access for members who just joined because of abuses. Please try again in a few days for ${userTag} (${userId})`);
              return;
            }

          }

          // Check if the user already has been given cheap deposits recently.
          await interaction.editReply({
            content: 'Checking if you are rate-limited...'
          });
          const lastRequest = await getLastCheapDepositHoleskyRequest(userId);
          let newRequestPart = '';
          if (lastRequest !== null) {
            const dtLastRequested = DateTime.fromMillis(lastRequest.lastRequested * 1000);
            const dtRequestAvailable = dtLastRequested.plus(cheapDepositHoleskyDelay);

            let durRequestAvailable = dtRequestAvailable.diff(DateTime.utc()).shiftTo('days', 'hours').normalize();
            if (durRequestAvailable.days === 0) {
              durRequestAvailable = durRequestAvailable.shiftTo('hours', 'minutes');
            }
            const formattedDuration = durRequestAvailable.toHuman();

            if (DateTime.utc() < dtRequestAvailable) {
              await interaction.followUp({
                content: `You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again. If you already have 32 Holesky ETH, you can use the official launchpad on <https://holesky.launchpad.ethereum.org> for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for @${userTag} (${userId}).`);
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

          const my_request = { requested_message: `My Discord user ${userTag} (${userId}) has access to this wallet address.` };
          const url_safe_string = encodeURIComponent( JSON.stringify( my_request ) );
          const base64_encoded = Buffer.from(url_safe_string).toString('base64').replace('+', '-').replace('/', '_').replace(/=+$/, '');
          const signer_is_url = `https://signer.is/#/sign/${ base64_encoded }`;

          const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(new ButtonBuilder()
              .setCustomId('sendSignatureForCheapDepositsHolesky')
              .setStyle(ButtonStyle.Primary)
              .setLabel('Enter Signature'));

          await interaction.editReply({
            content: `Click on [this Signer.is link](${signer_is_url}) and sign the requested message with the ` +
                     `wallet address you want to use to perform your deposit on Holesky to prove ` +
                     `ownership. Once you are done signing, click the *Copy Link* button on Signer.is ` +
                     `and click the **Enter Signature** button to paste your signature URL.`,
            components: [row]
          });
        
        } else if (commandName === 'cheap-hoodi-deposit') {
          console.log(`${commandName} from ${userTag} (${userId})`);

          // Restrict command to channel
          const restrictChannel = interaction.guild?.channels.cache.find((channel) => channel.id === process.env.CHEAP_HOODI_VALIDATOR_CHANNEL_ID);
          if (restrictChannel !== undefined) {
            if (interaction.channelId !== restrictChannel.id) {
              const channelMen = channelMention(restrictChannel.id);
              await interaction.reply({
                content: `This is the wrong channel for this bot command (${commandName}). You should try in ${channelMen} for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`This is the wrong channel for this bot command (${commandName}). You should try in #${restrictChannel.name} for @${userTag} (${userId}).`);
              return;
            }
          }

          const userCreatedAt = interaction.user.createdTimestamp;
          const userExistDuration = DateTime.utc().toMillis() - userCreatedAt;
          const officialLinksMen = channelMention(process.env.OFFICIAL_LINKS_CHANNEL_ID as string);

          const memberJoinedAt = (interaction.member as GuildMember).joinedTimestamp;
          const memberDuration = DateTime.utc().toMillis() - (memberJoinedAt as number);

          // Check for user role
          await interaction.reply({ content: 'Checking if you have the proper role to speed up delay period...', ephemeral: true });
          const hasRole = restrictedRoles.size === 0 || (interaction.member?.roles as GuildMemberRoleManager).cache.find((role) => restrictedRoles.has(role.id)) !== undefined;
          if (!hasRole) {
            const brightIdMention = channelMention(process.env.BRIGHTID_VERIFICATION_CHANNEL_ID as string);
            const passportVerificationMention = channelMention(process.env.PASSPORT_CHANNEL_ID as string);

            // Check for new accounts
            await interaction.editReply({
              content: `Checking if you have a new account...`
            });
            if (userExistDuration < newAccountDelay.toMillis()) {
              await interaction.followUp({
                content: `Your Discord account was just created. We need to ` +
                        `restrict access for new accounts because of abuses. ` +
                        `Please try again in a few days. You can speed this up ` +
                        `by completing one of the verification processes in ` +
                        `${brightIdMention} or in ${passportVerificationMention}. ` +
                        `If you need ` +
                        `Hoodi ETH, you should be using online faucets like ` +
                        `the one you can find on <https://hoodi-faucet.pk910.de>. ` +
                        `If you already have ` +
                        `32 Hoodi ETH, you can use the official launchpad on ` +
                        `<https://hoodi.launchpad.ethereum.org>.\n` +
                        `New accounts generally do not come directly asking for cheap deposits. ` +
                        `You might want to check out the guides and tools that exist for configuring ` +
                        `your machine to run a validator on Hoodi in ${officialLinksMen} first for ${userMen}.`,
              });
              reject(`Your Discord account was just created. We need to restrict access for new accounts because of abuses. Please try again in a few days for ${userTag} (${userId})`);
              return;
            }

            // Check for new guild member
            await interaction.editReply({
              content: `Checking if you recently joined the EthStaker Discord server...`
            });
            if (memberDuration < joinedDiscordServerDelay.toMillis()) {
              await interaction.followUp({
                content: `You just joined the EthStaker Discord server. We need to ` +
                        `restrict access for members who just joined because of abuses. ` +
                        `Please try again in a few days. You can speed this up ` +
                        `by completing one of the verification processes in ` +
                        `${brightIdMention} or in ${passportVerificationMention}. ` +
                        `If you need ` +
                        `Hoodi ETH, you should be using online faucets like ` +
                        `the one you can find on <https://hoodi-faucet.pk910.de>. ` +
                        `If you already have ` +
                        `32 Hoodi ETH, you can use the official launchpad on ` +
                        `<https://hoodi.launchpad.ethereum.org>.\n` +
                        `New members generally do not come directly asking for cheap deposits. ` +
                        `You might want to check out the guides and tools that exist for configuring ` +
                        `your machine to run a validator on Hoodi in ${officialLinksMen} first for ${userMen}.`,
              });
              reject(`You just joined the EthStaker Discord server. We need to restrict access for members who just joined because of abuses. Please try again in a few days for ${userTag} (${userId})`);
              return;
            }
          } else {

            // Check for new accounts
            await interaction.editReply({
              content: `Checking if you have a new account...`
            });
            if (userExistDuration < verifiedNewAccountDelay.toMillis()) {
              await interaction.followUp({
                content: `Your Discord account was just created. We need to ` +
                        `restrict access for new accounts because of abuses. ` +
                        `Please try again in a few days. If you need ` +
                        `Hoodi ETH, you should be using online faucets like ` +
                        `the one you can find on <https://hoodi-faucet.pk910.de>. ` +
                        `If you already have ` +
                        `32 Hoodi ETH, you can use the official launchpad on ` +
                        `<https://hoodi.launchpad.ethereum.org>.\n` +
                        `New accounts generally do not come directly asking for cheap deposits. ` +
                        `You might want to check out the guides and tools that exist for configuring ` +
                        `your machine to run a validator on Hoodi in ${officialLinksMen} first for ${userMen}.`,
              });
              reject(`Your verified Discord account was just created. We need to restrict access for new accounts because of abuses. Please try again in a few days for ${userTag} (${userId})`);
              return;
            }

            // Check for new guild member
            await interaction.editReply({
              content: `Checking if you recently joined the EthStaker Discord server...`
            });
            if (memberDuration < verifiedJoinedDiscordServerDelay.toMillis()) {
              await interaction.followUp({
                content: `You just joined the EthStaker Discord server. We need to ` +
                        `restrict access for members who just joined because of abuses. ` +
                        `Please try again in a few days. If you need ` +
                        `Hoodi ETH, you should be using online faucets like ` +
                        `the one you can find on <https://hoodi-faucet.pk910.de>. ` +
                        `If you already have ` +
                        `32 Hoodi ETH, you can use the official launchpad on ` +
                        `<https://hoodi.launchpad.ethereum.org>.\n` +
                        `New members generally do not come directly asking for cheap deposits. ` +
                        `You might want to check out the guides and tools that exist for configuring ` +
                        `your machine to run a validator on Hoodi in ${officialLinksMen} first for ${userMen}.`,
              });
              reject(`You just joined the EthStaker Discord server with verification. We need to restrict access for members who just joined because of abuses. Please try again in a few days for ${userTag} (${userId})`);
              return;
            }

          }

          // Check if the user already has been given cheap deposits recently.
          await interaction.editReply({
            content: 'Checking if you are rate-limited...'
          });
          const lastRequest = await getLastCheapDepositHoodiRequest(userId);
          let newRequestPart = '';
          if (lastRequest !== null) {
            const dtLastRequested = DateTime.fromMillis(lastRequest.lastRequested * 1000);
            const dtRequestAvailable = dtLastRequested.plus(cheapDepositHoodiDelay);

            let durRequestAvailable = dtRequestAvailable.diff(DateTime.utc()).shiftTo('days', 'hours').normalize();
            if (durRequestAvailable.days === 0) {
              durRequestAvailable = durRequestAvailable.shiftTo('hours', 'minutes');
            }
            const formattedDuration = durRequestAvailable.toHuman();

            if (DateTime.utc() < dtRequestAvailable) {
              await interaction.followUp({
                content: `You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again. If you already have 32 Hoodi ETH, you can use the official launchpad on <https://hoodi.launchpad.ethereum.org> for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for @${userTag} (${userId}).`);
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

          const my_request = { requested_message: `My Discord user ${userTag} (${userId}) has access to this wallet address.` };
          const url_safe_string = encodeURIComponent( JSON.stringify( my_request ) );
          const base64_encoded = Buffer.from(url_safe_string).toString('base64').replace('+', '-').replace('/', '_').replace(/=+$/, '');
          const signer_is_url = `https://signer.is/#/sign/${ base64_encoded }`;

          const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(new ButtonBuilder()
              .setCustomId('sendSignatureForCheapDepositsHoodi')
              .setStyle(ButtonStyle.Primary)
              .setLabel('Enter Signature'));

          await interaction.editReply({
            content: `Click on [this Signer.is link](${signer_is_url}) and sign the requested message with the ` +
                     `wallet address you want to use to perform your deposit on Hoodi to prove ` +
                     `ownership. Once you are done signing, click the *Copy Link* button on Signer.is ` +
                     `and click the **Enter Signature** button to paste your signature URL.`,
            components: [row]
          });
        
        } else {
          reject(`Unknown command: ${commandName}`);
        }

        resolve();

      });
    };

    interface signatureStructure {
      claimed_message: string,
      signed_message: string,
      claimed_signatory: string
    }

    const existingCheapDepositsHoleskyUserRequest = new Map<string, boolean>();
    const existingCheapDepositsHoleskyWalletRequest = new Map<string, boolean>();

    const existingCheapDepositsHoodiUserRequest = new Map<string, boolean>();
    const existingCheapDepositsHoodiWalletRequest = new Map<string, boolean>();

    const existingVerificationUserRequest = new Map<string, boolean>();
    const existingVerificationWalletRequest = new Map<string, boolean>();

    const handleModalSubmitInteraction = function(interaction: ModalSubmitInteraction) {
      return new Promise<void>(async (resolve, reject) => {

        const userTag = interaction.user.tag;
        const userId = interaction.user.id;
        const userMen = userMention(userId);

        if (interaction.customId === 'ownerVerify') {

          // Check if the user already has the role.
          const hasRole = (interaction.member?.roles as GuildMemberRoleManager).cache.find((role) => role.id === process.env.PASSPORT_ROLE_ID) !== undefined;
          if (hasRole) {
            await interaction.reply({
              content: `You already have the role associated with being verified with Gitcoin Passport. No need to verify again for ${userMen}.`,
            });
            reject(`User already has Passport verified role. ${userTag} (${userId})`);
            return;
          }

          // Mutex on User ID
          if (existingVerificationUserRequest.get(userId) === true) {
            await interaction.reply({
              content: `You already have a pending verification request. Please wait until your request is completed for ${userMen}.`,
              allowedMentions: { parse: ['users'], repliedUser: false }
            });
            reject(`You already have a pending verification request. Please wait until your request is completed for @${userTag} (${userId}).`);
            return;
          } else {
            existingVerificationUserRequest.set(userId, true);
          }

          try {

            const signature = interaction.fields.getTextInputValue('signatureInput');

            // Validate signature
            await interaction.reply({ content: `Validating signature...`, ephemeral: true});

            const signatureRegexMatch = signature.match(/https\:\/\/signer\.is(\/#)?\/verify\/(?<signature>[A-Za-z0-9=]+)/);
            if (signatureRegexMatch === null) {
              await interaction.followUp({
                content: `This is not a valid signature from Signer.is. Make sure to paste the full sharable link after signing the message. Clicking the *Copy link* button and pasting the result is the easiest way. Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signature. ${signature} ${userTag} (${userId})`);
              return;
            }

            const encodedSignature = signatureRegexMatch.groups?.signature;
            if (encodedSignature === undefined) {
              await interaction.followUp({
                content: `Unable to parse signature from Signer.is. Make sure to paste the full sharable link after signing the message. Clicking the *Copy link* button and pasting the result is the easiest way. Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signature. Unable to parse. ${signature} ${userTag} (${userId})`);
              return;
            }

            // Decode signature
            let signatureElements: any | null = null;
            try {
              signatureElements = JSON.parse(decodeURIComponent(Buffer.from(encodedSignature, 'base64').toString()));
            } catch (error) {
              await interaction.followUp({
                content: `Unable to parse signature JSON from Signer.is ${error}. Make sure to paste the full sharable link after signing the message. Clicking the *Copy link* button and pasting the result is the easiest way. Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signature. Unable to parse JSON. ${signature} ${error} ${userTag} (${userId})`);
              return;
            }
              
            const decodedSignature = signatureElements as signatureStructure;

            if (
              decodedSignature.claimed_message === undefined ||
              decodedSignature.claimed_signatory === undefined ||
              decodedSignature.signed_message === undefined
              ) {
              await interaction.followUp({
                content: `Unexpected structure in signature. Are you trying to meddle with the bot? Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Unexpected structure in signature. ${signatureElements} ${userTag} (${userId})`);
              return;
            }

            // Validate signed message
            await interaction.editReply({ content: `Verifying signed message...` });

            const messageRegexMatch = decodedSignature.claimed_message.match(/My Discord user .+? \((?<userId>[^\)]+)\) has access to this Gitcoin Passport address\./);
            if (messageRegexMatch === null) {
              await interaction.followUp({
                content: `The signature does not contain the correct signed message. Please try again using the Signer.is link provided for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signed message. ${decodedSignature.claimed_message} ${userTag} (${userId})`);
              return;
            }

            const signedMessageUserId = messageRegexMatch.groups?.userId;
            if (signedMessageUserId === undefined) {
              await interaction.followUp({
                content: `Unable to parse signed message from Signer.is. Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signed message. Unable to parse. ${decodedSignature.claimed_message} ${userTag} (${userId})`);
              return;
            }

            if (signedMessageUserId !== userId) {
              await interaction.followUp({
                content: `The user ID included in the signed message does not match your Discord user ID. Please try again using the Signer.is link provided for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`User ID mismatch from the signed message. Expected ${userId} but got ${signedMessageUserId}. ${userTag} (${userId})`);
              return;
            }

            const confirmedSignatory = ethers.verifyMessage( decodedSignature.claimed_message, decodedSignature.signed_message ).toLowerCase();
            const validSignature = confirmedSignatory.toLowerCase() === decodedSignature.claimed_signatory.toLowerCase();

            if (!validSignature) {
              await interaction.followUp({
                content: `This is not a valid signature from Signer.is. Please try again using the Signer.is link provided for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Not a valid signature after verifying the message for ${userTag} (${userId})`);
              return;
            }

            // Verify if that wallet address is valid
            await interaction.editReply({ content: `Verifying wallet address...` });
            
            if (!ethers.isAddress(decodedSignature.claimed_signatory)) {
              await interaction.followUp({
                content: `The included wallet address in your signature (${decodedSignature.claimed_signatory}) is not valid for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`The included wallet address in the signature (${decodedSignature.claimed_signatory}) is not valid for ${userTag} (${userId})`);
              return;
            }

            // Mutex on wallet address
            const uniformedAddress = ethers.getAddress(decodedSignature.claimed_signatory);

            if (existingVerificationWalletRequest.get(uniformedAddress) === true) {
              await interaction.followUp({
                content: `There is already a pending verification request for this wallet address (${uniformedAddress}). Please wait until that request is completed for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`There is already a pending verification request for this wallet address (${uniformedAddress}). Please wait until that request is completed for @${userTag} (${userId}).`);
              return;
            } else {
              existingVerificationWalletRequest.set(uniformedAddress, true);
            }

            try {

              // Verify if that wallet address is not already associated with another Discord user
              await interaction.editReply({ content: `Verifying if this wallet address was already used by another Discord user...` });

              const walletAlreadyUsed = await isPassportWalletAlreadyUsed(uniformedAddress);

              if (walletAlreadyUsed) {
                await interaction.followUp({
                  content: `This this wallet address (${uniformedAddress}) was already used with a different Discord user. Please try again with a different Gitcoin Passport for ${userMen}.`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                reject(`This this wallet address (${uniformedAddress}) was already used with a different Discord user. Please try again with a different Gitcoin Passport for @${userTag} (${userId}).`);
                return;
              }

              // Verify the associated Gitcoin Passport
              await interaction.editReply({ content: `Submitting your Gitcoin Passport for scoring...` });

              let keep_retrying = true;
              let retry_index = 0;
              const retry_count = 5;
              let retry_delay = 30;
              const retry_delay_increase = 15;
              let errorMsg = '';

              while (keep_retrying && retry_index < retry_count) {

                try {

                  // Submitting the address for verification
                  const submitResponse = await axios.post(SUBMIT_PASSPORT_URI,
                    {
                      'address': uniformedAddress,
                      'community': process.env.GITCOIN_PASSPORT_SCORER_ID
                    },
                    {
                    headers: {
                      'Content-Type': 'application/json',
                      'X-API-Key': process.env.GITCOIN_PASSPORT_API_KEY as string
                    }
                  });

                  if (submitResponse.status !== 200) {
                    retry_index = retry_index + 1
                    if (retry_index >= retry_count) {
                      break;
                    }
                    const retryMsg = `We will retry in ${retry_delay} seconds (retry index = ${retry_index}).`;
                    errorMsg = `Unexpected status code (${submitResponse.status}) from submitting your Gitcoin Passport for scoring.`;

                    await interaction.editReply({ content: `${errorMsg} ${retryMsg}` });

                    await new Promise(r => setTimeout(r, retry_delay * 1000));
                    retry_delay = retry_delay + retry_delay_increase;
                  } else {
                    keep_retrying = false
                  }
                }
                catch (e) {
                  retry_index = retry_index + 1
                  if (retry_index >= retry_count) {
                    break;
                  }
                  const retryMsg = `We will retry in ${retry_delay} seconds (retry index = ${retry_index}).`;
                  errorMsg = `Unexpected exception (${e}) from submitting your Gitcoin Passport for scoring.`;

                  await interaction.editReply({ content: `${errorMsg} ${retryMsg}` });

                  await new Promise(r => setTimeout(r, retry_delay * 1000));
                  retry_delay = retry_delay + retry_delay_increase;
                }

              }

              if (keep_retrying) {
                await interaction.followUp({
                  content: `We failed to submit your Gitcoin Passport for scoring (${errorMsg}) for ${userMen}.`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                reject(`We failed to submit your Gitcoin Passport for scoring (${errorMsg}) for @${userTag} (${userId}).`);
                return;
              }

              // Obtaining the score for that address
              await interaction.editReply({ content: `Obtaining your Gitcoin Passport score...` });

              keep_retrying = true;
              retry_index = 0;
              retry_delay = 30;
              errorMsg = '';

              const scorerUrl = PASSPORT_SCORE_URI.concat(uniformedAddress);
              
              let passportScore: number = 0.0;
              let passportAddress: string = '';

              while (keep_retrying && retry_index < retry_count) {

                try {

                  const scoringResponse = await axios.get(scorerUrl,
                    {
                      headers: {
                        'accept': 'application/json',
                        'X-API-Key': process.env.GITCOIN_PASSPORT_API_KEY as string
                      }
                  });

                  if (scoringResponse?.status !== 200) {
                    retry_index = retry_index + 1
                    if (retry_index >= retry_count) {
                      break;
                    }
                    const retryMsg = `We will retry in ${retry_delay} seconds (retry index = ${retry_index}).`;
                    errorMsg = `Unexpected status code (${scoringResponse?.status}) from obtaining your Gitcoin Passport score.`;

                    await interaction.editReply({ content: `${errorMsg} ${retryMsg}` });

                    await new Promise(r => setTimeout(r, retry_delay * 1000));
                    retry_delay = retry_delay + retry_delay_increase;
                    continue;
                  }

                  interface scoringResponse {
                      address: string,
                      score: string,
                      status: string,
                  };
    
                  let queryResponse = scoringResponse?.data as scoringResponse;
  
                  if (queryResponse.status !== "DONE") {
                    retry_index = retry_index + 1
                    if (retry_index >= retry_count) {
                      break;
                    }
                    const retryMsg = `We will retry in ${retry_delay} seconds (retry index = ${retry_index}).`;
                    errorMsg = `Unexpected status (${queryResponse.status}) from obtaining your Gitcoin Passport score.`;

                    await interaction.editReply({ content: `${errorMsg} ${retryMsg}` });

                    await new Promise(r => setTimeout(r, retry_delay * 1000));
                    retry_delay = retry_delay + retry_delay_increase;
                    continue;
                  } else {
                    passportScore = parseFloat(queryResponse.score);
                    passportAddress = queryResponse.address;

                    keep_retrying = false;
                  }

                }
                catch (e) {
                  retry_index = retry_index + 1
                  if (retry_index >= retry_count) {
                    break;
                  }
                  const retryMsg = `We will retry in ${retry_delay} seconds (retry index = ${retry_index}).`;
                  errorMsg = `Unexpected exception (${e}) from obtaining your Gitcoin Passport score.`;

                  await interaction.editReply({ content: `${errorMsg} ${retryMsg}` });

                  await new Promise(r => setTimeout(r, retry_delay * 1000));
                  retry_delay = retry_delay + retry_delay_increase;
                }

              }

              if (keep_retrying) {
                await interaction.followUp({
                  content: `We failed to obtain your Gitcoin Passport score (${errorMsg}) for ${userMen}.`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                reject(`We failed to obtain your Gitcoin Passport score (${errorMsg}) for @${userTag} (${userId}).`);
                return;
              }

              const formattedPassportScore = passportScore.toFixed(1);

              console.log(`Passport score ${formattedPassportScore} found for wallet address ${passportAddress}.`);
              

              if (passportScore < passportScoreThreshold) {
                await interaction.followUp({
                  content: `Your Gitcoin Passport score is too low (${formattedPassportScore} < ${passportScoreThreshold}). Keep adding stamps and try again. Stamps that give a better proof of your existance usually give a higher score for ${userMen}.`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                reject(`Your Gitcoin Passport score is too low (${formattedPassportScore} < ${passportScoreThreshold}). Keep adding stamps and try again. Stamps that give a better proof of your existance usually give a higher score for @${userTag} (${userId}).`);
                return;
              }

              // Assigning the Passport role
              await interaction.editReply({ content: `Assigning your new role...` });

              await (interaction.member?.roles as GuildMemberRoleManager).add(process.env.PASSPORT_ROLE_ID as string, 'Completed the Gitcoin Passport verification process.');

              // Storing the wallet address for associated Gitcoin Passport
              await interaction.editReply({ content: `Storing your Gitcoin Passport...` });

              await storePassportWallet(uniformedAddress, userId);

              await interaction.editReply({ content: `Completed.` });

              await interaction.followUp({
                content: `You are now verified with Gitcoin Passport (score: ${formattedPassportScore}) with wallet address ${uniformedAddress} for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });

            } finally {
              existingVerificationWalletRequest.delete(uniformedAddress);
            }

          } catch(err) {
            console.log('Error in Passport verification.');
            console.log(err);
          } finally {
            existingVerificationUserRequest.delete(userId);
          }

        } else if (interaction.customId === 'ownerCheapDepositsHoleskyVerify') {

          // Check if the user already has been given cheap deposits recently.
          const lastRequest = await getLastCheapDepositHoleskyRequest(userId);
          let newRequestPart = '';
          if (lastRequest !== null) {
            const dtLastRequested = DateTime.fromMillis(lastRequest.lastRequested * 1000);
            const dtRequestAvailable = dtLastRequested.plus(cheapDepositHoleskyDelay);

            let durRequestAvailable = dtRequestAvailable.diff(DateTime.utc()).shiftTo('days', 'hours').normalize();
            if (durRequestAvailable.days === 0) {
              durRequestAvailable = durRequestAvailable.shiftTo('hours', 'minutes');
            }
            const formattedDuration = durRequestAvailable.toHuman();

            if (DateTime.utc() < dtRequestAvailable) {
              await interaction.followUp({
                content: `You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for @${userTag} (${userId}).`);
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

          // Mutex on User ID
          if (existingCheapDepositsHoleskyUserRequest.get(userId) === true) {
            await interaction.reply({
              content: `You already have a pending cheap deposits request. Please wait until your request is completed for ${userMen}.`,
              allowedMentions: { parse: ['users'], repliedUser: false }
            });
            reject(`You already have a pending cheap deposits request. Please wait until your request is completed for @${userTag} (${userId}).`);
            return;
          } else {
            existingCheapDepositsHoleskyUserRequest.set(userId, true);
          }

          try {

            const signature = interaction.fields.getTextInputValue('signatureInput');

            // Validate signature
            await interaction.reply({ content: `Validating signature...`, ephemeral: true});
            
            const signatureRegexMatch = signature.match(/https\:\/\/signer\.is(\/#)?\/verify\/(?<signature>[A-Za-z0-9=]+)/);
            if (signatureRegexMatch === null) {
              await interaction.followUp({
                content: `This is not a valid signature from Signer.is. Make sure to paste the full sharable link after signing the message. Clicking the *Copy link* button and pasting the result is the easiest way. Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signature. ${signature} ${userTag} (${userId})`);
              return;
            }

            const encodedSignature = signatureRegexMatch.groups?.signature;
            if (encodedSignature === undefined) {
              await interaction.followUp({
                content: `Unable to parse signature from Signer.is. Make sure to paste the full sharable link after signing the message. Clicking the *Copy link* button and pasting the result is the easiest way. Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signature. Unable to parse. ${signature} ${userTag} (${userId})`);
              return;
            }

            // Decode signature
            let signatureElements: any | null = null;
            try {
              signatureElements = JSON.parse(decodeURIComponent(Buffer.from(encodedSignature, 'base64').toString()));
            } catch (error) {
              await interaction.followUp({
                content: `Unable to parse signature JSON from Signer.is ${error}. Make sure to paste the full sharable link after signing the message. Clicking the *Copy link* button and pasting the result is the easiest way. Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signature. Unable to parse JSON. ${signature} ${error} ${userTag} (${userId})`);
              return;
            }
              
            const decodedSignature = signatureElements as signatureStructure;

            if (
              decodedSignature.claimed_message === undefined ||
              decodedSignature.claimed_signatory === undefined ||
              decodedSignature.signed_message === undefined
              ) {
              await interaction.followUp({
                content: `Unexpected structure in signature. Are you trying to meddle with the bot? Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Unexpected structure in signature. ${signatureElements} ${userTag} (${userId})`);
              return;
            }

            // Validate signed message
            await interaction.editReply({ content: `Verifying signed message...` });

            const messageRegexMatch = decodedSignature.claimed_message.match(/My Discord user .+? \((?<userId>[^\)]+)\) has access to this wallet address\./);
            if (messageRegexMatch === null) {
              await interaction.followUp({
                content: `The signature does not contain the correct signed message. Please try again using the Signer.is link provided for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signed message. ${decodedSignature.claimed_message} ${userTag} (${userId})`);
              return;
            }

            const signedMessageUserId = messageRegexMatch.groups?.userId;
            if (signedMessageUserId === undefined) {
              await interaction.followUp({
                content: `Unable to parse signed message from Signer.is. Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signed message. Unable to parse. ${decodedSignature.claimed_message} ${userTag} (${userId})`);
              return;
            }

            if (signedMessageUserId !== userId) {
              await interaction.followUp({
                content: `The user ID included in the signed message does not match your Discord user ID. Please try again using the Signer.is link provided for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`User ID mismatch from the signed message. Expected ${userId} but got ${signedMessageUserId}. ${userTag} (${userId})`);
              return;
            }

            const confirmedSignatory = ethers.verifyMessage( decodedSignature.claimed_message, decodedSignature.signed_message ).toLowerCase();
            const validSignature = confirmedSignatory.toLowerCase() === decodedSignature.claimed_signatory.toLowerCase();

            if (!validSignature) {
              await interaction.followUp({
                content: `This is not a valid signature from Signer.is. Please try again using the Signer.is link provided for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Not a valid signature after verifying the message for ${userTag} (${userId})`);
              return;
            }

            // Verify if that wallet address is valid
            await interaction.editReply({ content: `Verifying wallet address...` });
            
            if (!ethers.isAddress(decodedSignature.claimed_signatory)) {
              await interaction.followUp({
                content: `The included wallet address in your signature (${decodedSignature.claimed_signatory}) is not valid for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`The included wallet address in the signature (${decodedSignature.claimed_signatory}) is not valid for ${userTag} (${userId})`);
              return;
            }

            // Mutex on wallet address
            const uniformedAddress = ethers.getAddress(decodedSignature.claimed_signatory);

            if (existingCheapDepositsHoleskyWalletRequest.get(uniformedAddress) === true) {
              await interaction.followUp({
                content: `There is already a pending cheap deposits request for this wallet address (${uniformedAddress}). Please wait until that request is completed for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`There is already a pending cheap deposits request for this wallet address (${uniformedAddress}). Please wait until that request is completed for @${userTag} (${userId}).`);
              return;
            } else {
              existingCheapDepositsHoleskyWalletRequest.set(uniformedAddress, true);
            }

            try {

              // Verify if that wallet address is not already associated with another Discord user
              await interaction.editReply({ content: `Verifying if this wallet address was already used by another Discord user...` });

              const walletAlreadyUsed = await isCheapDepositsHoleskyWalletAlreadyUsed(uniformedAddress, userId);

              if (walletAlreadyUsed) {
                await interaction.followUp({
                  content: `This this wallet address (${uniformedAddress}) was already used with a different Discord user. Please try again with a different wallet address for ${userMen}.`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                reject(`This this wallet address (${uniformedAddress}) was already used with a different Discord user. Please try again with a different wallet address for @${userTag} (${userId}).`);
                return;
              }

              // Top up the proxy contract
              await interaction.editReply({ content: `Ensuring there is enough funds on our contract...` });

              const targetMultiplier = BigInt(minRelativeCheapDepositCount) * BigInt(cheapDepositCount);

              const targetBalance = (validatorDepositCost * targetMultiplier) + (maxTransactionCost * targetMultiplier);
              const currentContractBalance = await holeskyProvider.getBalance(depositProxyContractHoleskyAddress);

              if (targetBalance > currentContractBalance) {
                const sendingAmount = targetBalance - currentContractBalance;

                console.log(`Refilling proxy contract. Our target: ${ethers.formatEther(targetBalance)}, ` +
                  `current balance: ${ethers.formatEther(currentContractBalance)}, ` +
                  `sending amount: ${ethers.formatEther(sendingAmount)}`);

                await holeskyTransactionMutex.runExclusive(async () => {
                  const transaction = await holeskyWallet.sendTransaction({
                    to: depositProxyContractHoleskyAddress,
                    value: sendingAmount
                  });

                  await transaction.wait(1);
                });
                
              }

              // Send tokens to user
              await interaction.editReply({ content: `Whitelisting the wallet address for ${cheapDepositCount} cheap deposits...` });

              const depositProxyContract = new ethers.Contract(depositProxyContractHoleskyAddress, depositProxyContractAbi, holeskyWallet);
              const targetTokenBalance = BigInt(cheapDepositCount);
              const currentTokenBalance = await depositProxyContract.balanceOf(uniformedAddress, 0) as bigint;
              if (currentTokenBalance < targetTokenBalance) {
                const sendingAmount = targetTokenBalance - currentTokenBalance;

                console.log(`Sending cheap deposits tokens to user (${uniformedAddress}). Our target: ${targetTokenBalance}, ` +
                  `current balance: ${currentTokenBalance}, ` +
                  `sending amount: ${sendingAmount}`);

                await holeskyTransactionMutex.runExclusive(async () => {
                  const transaction: ethers.TransactionResponse = await depositProxyContract.safeTransferFrom(
                    holeskyWallet.address, uniformedAddress, 0, sendingAmount, Buffer.from(''));
                  await transaction.wait(1);
                });
              }

              // Top up user wallet
              await interaction.editReply({ content: `Ensuring you have enough funds in that wallet for the ${cheapDepositCount} cheap deposits...` });

              const targetWalletBalance = (cheapDepositCost * BigInt(cheapDepositCount)) + (maxTransactionCost * BigInt(cheapDepositCount));
              const currentWalletBalance = await holeskyProvider.getBalance(uniformedAddress);

              if (targetWalletBalance > currentWalletBalance) {
                const sendingAmount = targetWalletBalance - currentWalletBalance;

                console.log(`Filling user wallet (${uniformedAddress}). Our target: ${ethers.formatEther(targetWalletBalance)}, ` +
                  `current balance: ${ethers.formatEther(currentWalletBalance)}, ` +
                  `sending amount: ${ethers.formatEther(sendingAmount)}`);

                await holeskyTransactionMutex.runExclusive(async () => {
                  const transaction = await holeskyWallet.sendTransaction({
                    to: uniformedAddress,
                    value: sendingAmount
                  });

                  await transaction.wait(1);
                });
              } else {
                console.log(`User wallet (${uniformedAddress}) is already funded. Our target: ${ethers.formatEther(targetWalletBalance)}, ` +
                  `current balance: ${ethers.formatEther(currentWalletBalance)}`);
              }

              // Storing the wallet address for the cheap deposits
              await interaction.editReply({ content: `Storing your information...` });

              await storeCheapDepositsHolesky(uniformedAddress, userId);

              await interaction.editReply({ content: `Completed.` });

              const officialLinksMen = channelMention(process.env.OFFICIAL_LINKS_CHANNEL_ID as string);

              await interaction.followUp({
                content: `You can now perform ${cheapDepositCount} cheap deposits on <https://holesky.launchpad.ethstaker.cc/> ` +
                `with your wallet address \`${uniformedAddress}\`. Make sure to check out the guides and tools for configuring your ` +
                `machine to run a validator on Holesky in ${officialLinksMen}.\n\nYou **must** set your withdrawal address to ` +
                `\`0x4D496CcC28058B1D74B7a19541663E21154f9c84\` and use a type 1 (regular, non-compounding) validator ` +
                `when creating your validator keys and your deposit file in order ` +
                `to use this process and to complete your deposit. This is only required for this launchpad. When on Mainnet, you ` +
                `should use a withdrawal address you control if you want to use one.\n\nPerforming this deposit transaction ` +
                `can cost more in gas than the actual cheap deposit cost of 0.0001 Holesky ETH during time of high gas ` +
                `price. If you end up in this situation, you can either try to obtain more Holesky ETH from ` +
                `<https://faucetlink.to/holesky>, you can wait until gas price come down (see <https://holesky.beaconcha.in/gasnow> ` +
                `to monitor gas price on Holesky) or you can broadcast your transaction with a custom low gas price and wait until ` +
                `it is picked up by the network for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              resolve();

            } finally {
              existingCheapDepositsHoleskyWalletRequest.delete(uniformedAddress);
            }

          } finally {
            existingCheapDepositsHoleskyUserRequest.delete(userId);
          }

        } else if (interaction.customId === 'ownerCheapDepositsHoodiVerify') {

          // Check if the user already has been given cheap deposits recently.
          const lastRequest = await getLastCheapDepositHoodiRequest(userId);
          let newRequestPart = '';
          if (lastRequest !== null) {
            const dtLastRequested = DateTime.fromMillis(lastRequest.lastRequested * 1000);
            const dtRequestAvailable = dtLastRequested.plus(cheapDepositHoodiDelay);

            let durRequestAvailable = dtRequestAvailable.diff(DateTime.utc()).shiftTo('days', 'hours').normalize();
            if (durRequestAvailable.days === 0) {
              durRequestAvailable = durRequestAvailable.shiftTo('hours', 'minutes');
            }
            const formattedDuration = durRequestAvailable.toHuman();

            if (DateTime.utc() < dtRequestAvailable) {
              await interaction.followUp({
                content: `You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for @${userTag} (${userId}).`);
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

          // Mutex on User ID
          if (existingCheapDepositsHoodiUserRequest.get(userId) === true) {
            await interaction.reply({
              content: `You already have a pending cheap deposits request. Please wait until your request is completed for ${userMen}.`,
              allowedMentions: { parse: ['users'], repliedUser: false }
            });
            reject(`You already have a pending cheap deposits request. Please wait until your request is completed for @${userTag} (${userId}).`);
            return;
          } else {
            existingCheapDepositsHoodiUserRequest.set(userId, true);
          }

          try {

            const signature = interaction.fields.getTextInputValue('signatureInput');

            // Validate signature
            await interaction.reply({ content: `Validating signature...`, ephemeral: true});
            
            const signatureRegexMatch = signature.match(/https\:\/\/signer\.is(\/#)?\/verify\/(?<signature>[A-Za-z0-9=]+)/);
            if (signatureRegexMatch === null) {
              await interaction.followUp({
                content: `This is not a valid signature from Signer.is. Make sure to paste the full sharable link after signing the message. Clicking the *Copy link* button and pasting the result is the easiest way. Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signature. ${signature} ${userTag} (${userId})`);
              return;
            }

            const encodedSignature = signatureRegexMatch.groups?.signature;
            if (encodedSignature === undefined) {
              await interaction.followUp({
                content: `Unable to parse signature from Signer.is. Make sure to paste the full sharable link after signing the message. Clicking the *Copy link* button and pasting the result is the easiest way. Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signature. Unable to parse. ${signature} ${userTag} (${userId})`);
              return;
            }

            // Decode signature
            let signatureElements: any | null = null;
            try {
              signatureElements = JSON.parse(decodeURIComponent(Buffer.from(encodedSignature, 'base64').toString()));
            } catch (error) {
              await interaction.followUp({
                content: `Unable to parse signature JSON from Signer.is ${error}. Make sure to paste the full sharable link after signing the message. Clicking the *Copy link* button and pasting the result is the easiest way. Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signature. Unable to parse JSON. ${signature} ${error} ${userTag} (${userId})`);
              return;
            }
              
            const decodedSignature = signatureElements as signatureStructure;

            if (
              decodedSignature.claimed_message === undefined ||
              decodedSignature.claimed_signatory === undefined ||
              decodedSignature.signed_message === undefined
              ) {
              await interaction.followUp({
                content: `Unexpected structure in signature. Are you trying to meddle with the bot? Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Unexpected structure in signature. ${signatureElements} ${userTag} (${userId})`);
              return;
            }

            // Validate signed message
            await interaction.editReply({ content: `Verifying signed message...` });

            const messageRegexMatch = decodedSignature.claimed_message.match(/My Discord user .+? \((?<userId>[^\)]+)\) has access to this wallet address\./);
            if (messageRegexMatch === null) {
              await interaction.followUp({
                content: `The signature does not contain the correct signed message. Please try again using the Signer.is link provided for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signed message. ${decodedSignature.claimed_message} ${userTag} (${userId})`);
              return;
            }

            const signedMessageUserId = messageRegexMatch.groups?.userId;
            if (signedMessageUserId === undefined) {
              await interaction.followUp({
                content: `Unable to parse signed message from Signer.is. Please try again for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Invalid signed message. Unable to parse. ${decodedSignature.claimed_message} ${userTag} (${userId})`);
              return;
            }

            if (signedMessageUserId !== userId) {
              await interaction.followUp({
                content: `The user ID included in the signed message does not match your Discord user ID. Please try again using the Signer.is link provided for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`User ID mismatch from the signed message. Expected ${userId} but got ${signedMessageUserId}. ${userTag} (${userId})`);
              return;
            }

            const confirmedSignatory = ethers.verifyMessage( decodedSignature.claimed_message, decodedSignature.signed_message ).toLowerCase();
            const validSignature = confirmedSignatory.toLowerCase() === decodedSignature.claimed_signatory.toLowerCase();

            if (!validSignature) {
              await interaction.followUp({
                content: `This is not a valid signature from Signer.is. Please try again using the Signer.is link provided for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`Not a valid signature after verifying the message for ${userTag} (${userId})`);
              return;
            }

            // Verify if that wallet address is valid
            await interaction.editReply({ content: `Verifying wallet address...` });
            
            if (!ethers.isAddress(decodedSignature.claimed_signatory)) {
              await interaction.followUp({
                content: `The included wallet address in your signature (${decodedSignature.claimed_signatory}) is not valid for ${userMen}`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`The included wallet address in the signature (${decodedSignature.claimed_signatory}) is not valid for ${userTag} (${userId})`);
              return;
            }

            // Mutex on wallet address
            const uniformedAddress = ethers.getAddress(decodedSignature.claimed_signatory);

            if (existingCheapDepositsHoodiWalletRequest.get(uniformedAddress) === true) {
              await interaction.followUp({
                content: `There is already a pending cheap deposits request for this wallet address (${uniformedAddress}). Please wait until that request is completed for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`There is already a pending cheap deposits request for this wallet address (${uniformedAddress}). Please wait until that request is completed for @${userTag} (${userId}).`);
              return;
            } else {
              existingCheapDepositsHoodiWalletRequest.set(uniformedAddress, true);
            }

            try {

              // Verify if that wallet address is not already associated with another Discord user
              await interaction.editReply({ content: `Verifying if this wallet address was already used by another Discord user...` });

              const walletAlreadyUsed = await isCheapDepositsHoodiWalletAlreadyUsed(uniformedAddress, userId);

              if (walletAlreadyUsed) {
                await interaction.followUp({
                  content: `This this wallet address (${uniformedAddress}) was already used with a different Discord user. Please try again with a different wallet address for ${userMen}.`,
                  allowedMentions: { parse: ['users'], repliedUser: false }
                });
                reject(`This this wallet address (${uniformedAddress}) was already used with a different Discord user. Please try again with a different wallet address for @${userTag} (${userId}).`);
                return;
              }

              // Top up the proxy contract
              await interaction.editReply({ content: `Ensuring there is enough funds on our contract...` });

              const targetMultiplier = BigInt(minRelativeCheapDepositCount) * BigInt(cheapDepositCount);

              const targetBalance = (validatorDepositCost * targetMultiplier) + (maxTransactionCost * targetMultiplier);
              const currentContractBalance = await hoodiProvider.getBalance(depositProxyContractHoodiAddress);

              if (targetBalance > currentContractBalance) {
                const sendingAmount = targetBalance - currentContractBalance;

                console.log(`Refilling proxy contract. Our target: ${ethers.formatEther(targetBalance)}, ` +
                  `current balance: ${ethers.formatEther(currentContractBalance)}, ` +
                  `sending amount: ${ethers.formatEther(sendingAmount)}`);

                await hoodiTransactionMutex.runExclusive(async () => {
                  const transaction = await hoodiWallet.sendTransaction({
                    to: depositProxyContractHoodiAddress,
                    value: sendingAmount
                  });

                  await transaction.wait(1);
                });
                
              }

              // Send tokens to user
              await interaction.editReply({ content: `Whitelisting the wallet address for ${cheapDepositCount} cheap deposits...` });

              const depositProxyContract = new ethers.Contract(depositProxyContractHoodiAddress, depositProxyContractAbi, hoodiWallet);
              const targetTokenBalance = BigInt(cheapDepositCount);
              const currentTokenBalance = await depositProxyContract.balanceOf(uniformedAddress, 0) as bigint;
              if (currentTokenBalance < targetTokenBalance) {
                const sendingAmount = targetTokenBalance - currentTokenBalance;

                console.log(`Sending cheap deposits tokens to user (${uniformedAddress}). Our target: ${targetTokenBalance}, ` +
                  `current balance: ${currentTokenBalance}, ` +
                  `sending amount: ${sendingAmount}`);

                await hoodiTransactionMutex.runExclusive(async () => {
                  const transaction: ethers.TransactionResponse = await depositProxyContract.safeTransferFrom(
                    hoodiWallet.address, uniformedAddress, 0, sendingAmount, Buffer.from(''));
                  await transaction.wait(1);
                });
              }

              // Top up user wallet
              await interaction.editReply({ content: `Ensuring you have enough funds in that wallet for the ${cheapDepositCount} cheap deposits...` });

              const targetWalletBalance = (cheapDepositCost * BigInt(cheapDepositCount)) + (maxTransactionCost * BigInt(cheapDepositCount));
              const currentWalletBalance = await hoodiProvider.getBalance(uniformedAddress);

              if (targetWalletBalance > currentWalletBalance) {
                const sendingAmount = targetWalletBalance - currentWalletBalance;

                console.log(`Filling user wallet (${uniformedAddress}). Our target: ${ethers.formatEther(targetWalletBalance)}, ` +
                  `current balance: ${ethers.formatEther(currentWalletBalance)}, ` +
                  `sending amount: ${ethers.formatEther(sendingAmount)}`);

                await hoodiTransactionMutex.runExclusive(async () => {
                  const transaction = await hoodiWallet.sendTransaction({
                    to: uniformedAddress,
                    value: sendingAmount
                  });

                  await transaction.wait(1);
                });
              } else {
                console.log(`User wallet (${uniformedAddress}) is already funded. Our target: ${ethers.formatEther(targetWalletBalance)}, ` +
                  `current balance: ${ethers.formatEther(currentWalletBalance)}`);
              }

              // Storing the wallet address for the cheap deposits
              await interaction.editReply({ content: `Storing your information...` });

              await storeCheapDepositsHoodi(uniformedAddress, userId);

              await interaction.editReply({ content: `Completed.` });

              const officialLinksMen = channelMention(process.env.OFFICIAL_LINKS_CHANNEL_ID as string);

              await interaction.followUp({
                content: `You can now perform ${cheapDepositCount} cheap deposits on <https://cheap.hoodi.launchpad.ethstaker.cc/> ` +
                `with your wallet address \`${uniformedAddress}\`. Make sure to check out the guides and tools for configuring your ` +
                `machine to run a validator on Hoodi in ${officialLinksMen}.\n\nYou **must** set your withdrawal address to ` +
                `\`0x4D496CcC28058B1D74B7a19541663E21154f9c84\` and use a type 1 (regular, non-compounding) validator ` +
                `when creating your validator keys and your deposit file in order ` +
                `to use this process and to complete your deposit. This is only required for this launchpad. When on Mainnet, you ` +
                `should use a withdrawal address you control if you want to use one.\n\nPerforming this deposit transaction ` +
                `can cost more in gas than the actual cheap deposit cost of 0.0001 Hoodi ETH during time of high gas ` +
                `price. If you end up in this situation, you can either try to obtain more Hoodi ETH from ` +
                `<https://hoodi-faucet.pk910.de>, you can wait until gas price come down (see <https://hoodi.beaconcha.in/gasnow> ` +
                `to monitor gas price on Hoodi) or you can broadcast your transaction with a custom low gas price and wait until ` +
                `it is picked up by the network for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              resolve();

            } finally {
              existingCheapDepositsHoodiWalletRequest.delete(uniformedAddress);
            }

          } finally {
            existingCheapDepositsHoodiUserRequest.delete(userId);
          }

        } else {
          reject(`Unknown modal submission: ${interaction.customId}`);
        }

      });
    };

    const handleButtonInteraction = function(interaction: ButtonInteraction) {
      return new Promise<void>(async (resolve, reject) => {

        const userTag = interaction.user.tag;
        const userId = interaction.user.id;
        const userMen = userMention(userId);

        if (interaction.customId === 'sendSignature') {

          // Check if the user already has the role.
          const hasRole = (interaction.member?.roles as GuildMemberRoleManager).cache.find((role) => role.id === process.env.PASSPORT_ROLE_ID) !== undefined;
          if (hasRole) {
            await interaction.reply({
              content: `You already have the role associated with being verified with Gitcoin Passport. No need to verify again for ${userMen}.`,
            });
            reject(`User already has Passport verified role. ${userTag} (${userId})`);
            return;
          }

          const modal = new ModalBuilder()
            .setCustomId('ownerVerify')
            .setTitle('Gitcoin Passport ownership verification');

          const signatureInput = new TextInputBuilder()
            .setCustomId('signatureInput')
            .setLabel("Paste your signature URL here.")
            .setStyle(TextInputStyle.Paragraph);

          const firstActionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(signatureInput);
          modal.addComponents(firstActionRow);

          await interaction.showModal(modal);

        } else if (interaction.customId === 'sendSignatureForCheapDepositsHolesky') {

          // Check if the user already has been given cheap deposits recently.
          const lastRequest = await getLastCheapDepositHoleskyRequest(userId);
          let newRequestPart = '';
          if (lastRequest !== null) {
            const dtLastRequested = DateTime.fromMillis(lastRequest.lastRequested * 1000);
            const dtRequestAvailable = dtLastRequested.plus(cheapDepositHoleskyDelay);

            let durRequestAvailable = dtRequestAvailable.diff(DateTime.utc()).shiftTo('days', 'hours').normalize();
            if (durRequestAvailable.days === 0) {
              durRequestAvailable = durRequestAvailable.shiftTo('hours', 'minutes');
            }
            const formattedDuration = durRequestAvailable.toHuman();

            if (DateTime.utc() < dtRequestAvailable) {
              await interaction.reply({
                content: `You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for @${userTag} (${userId}).`);
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

          const modal = new ModalBuilder()
            .setCustomId('ownerCheapDepositsHoleskyVerify')
            .setTitle('Wallet ownership');

          const signatureInput = new TextInputBuilder()
            .setCustomId('signatureInput')
            .setLabel("Paste your signature URL here.")
            .setStyle(TextInputStyle.Paragraph);

          const firstActionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(signatureInput);
          modal.addComponents(firstActionRow);

          await interaction.showModal(modal);

        } else if (interaction.customId === 'sendSignatureForCheapDepositsHoodi') {

          // Check if the user already has been given cheap deposits recently.
          const lastRequest = await getLastCheapDepositHoodiRequest(userId);
          let newRequestPart = '';
          if (lastRequest !== null) {
            const dtLastRequested = DateTime.fromMillis(lastRequest.lastRequested * 1000);
            const dtRequestAvailable = dtLastRequested.plus(cheapDepositHoodiDelay);

            let durRequestAvailable = dtRequestAvailable.diff(DateTime.utc()).shiftTo('days', 'hours').normalize();
            if (durRequestAvailable.days === 0) {
              durRequestAvailable = durRequestAvailable.shiftTo('hours', 'minutes');
            }
            const formattedDuration = durRequestAvailable.toHuman();

            if (DateTime.utc() < dtRequestAvailable) {
              await interaction.reply({
                content: `You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for ${userMen}.`,
                allowedMentions: { parse: ['users'], repliedUser: false }
              });
              reject(`You cannot do another request this soon. You will need to wait at least ${formattedDuration} before you can request again for @${userTag} (${userId}).`);
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

          const modal = new ModalBuilder()
            .setCustomId('ownerCheapDepositsHoodiVerify')
            .setTitle('Wallet ownership');

          const signatureInput = new TextInputBuilder()
            .setCustomId('signatureInput')
            .setLabel("Paste your signature URL here.")
            .setStyle(TextInputStyle.Paragraph);

          const firstActionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(signatureInput);
          modal.addComponents(firstActionRow);

          await interaction.showModal(modal);

        } else {
          reject(`Unknown button: ${interaction.customId}`);
        }

        resolve();

      });
    };

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
              current_epoch_target_attesting_gwei: number,
              previous_epoch_target_attesting_gwei: number,
              previous_epoch_head_attesting_gwei: number
            }
          };

          const queryResponse = response.data as globalResponse;
          const participationRateDate = DateTime.utc().toMillis();

          const prevParticipationRate = queryResponse.data.previous_epoch_target_attesting_gwei / queryResponse.data.current_epoch_active_gwei;
          const currParticipationRate = queryResponse.data.current_epoch_target_attesting_gwei / queryResponse.data.current_epoch_active_gwei;

          const fixedPrevParticipationRate = (prevParticipationRate * 100.0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';
          const fixedCurrParticipationRate = (currParticipationRate * 100.0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';

          const participationRate = prevParticipationRate;
          const fixedParticipationRate = fixedPrevParticipationRate;

          console.log(`Participation rate for epoch ${epoch - 1} is ${fixedPrevParticipationRate}. Temporary participation rate for ${epoch} is ${fixedCurrParticipationRate}.`);

          if (participationRate < twoThird) {
            participationRateAlertTriggering.below90 = true;
            participationRateAlertTriggering.below80 = true;
            participationRateAlertTriggering.below70 = true;
            if (!participationRateAlertTriggering.belowTwoThird) {
              participationRateAlertTriggering.belowTwoThird = true;

              const message = `🚨 Participation rate on Mainnet is below 2 / 3 (current: ${fixedParticipationRate} for epoch ${epoch - 1}). Finality is compromised. 🚨`;
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

              const message = `⚠️ Participation rate on Mainnet is below 70% (current: ${fixedParticipationRate} for epoch ${epoch - 1}). ⚠️`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
                console.log(error);
              });
            } else if (participationRateAlertTriggering.belowTwoThird) {
              participationRateAlertTriggering.belowTwoThird = false;

              const message = `⚠️ Participation rate on Mainnet is back above 2 / 3 (current: ${fixedParticipationRate} for epoch ${epoch - 1}). Finality should resume. ⚠️`;
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

              const message = `⚠️ Participation rate on Mainnet is below 80% (current: ${fixedParticipationRate} for epoch ${epoch - 1}). ⚠️`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
                console.log(error);
              });
            } else if (participationRateAlertTriggering.below70) {
              participationRateAlertTriggering.below70 = false;

              const message = `⚠️ Participation rate on Mainnet is back above 70% (current: ${fixedParticipationRate} for epoch ${epoch - 1}). ⚠️`;
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

              const message = `⚠️ Participation rate on Mainnet is below 90% (current: ${fixedParticipationRate} for epoch ${epoch - 1}). ⚠️`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
                console.log(error);
              });
            } else if (participationRateAlertTriggering.below80) {
              participationRateAlertTriggering.below80 = false;

              const message = `⚠️ Participation rate on Mainnet is back above 80% (current: ${fixedParticipationRate} for epoch ${epoch - 1}). ⚠️`;
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
              const message = `ℹ️ Participation rate on Mainnet is back above 90% (current: ${fixedParticipationRate} for epoch ${epoch - 1}). ℹ️`;
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

