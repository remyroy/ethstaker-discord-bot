import { config } from 'dotenv';
config();

import { Client, GatewayIntentBits, Formatters, TextChannel } from 'discord.js';
import EventSource from 'eventsource';
import axios from 'axios';

const main = function() {
  return new Promise<void>(async (mainResolve, mainReject) => {

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.on('ready', () => {
      console.log(`Logged in as ${client.user?.tag}!`);
    });

    client.login(process.env.DISCORD_TOKEN).then(() => {
      console.log('Discord login successful!');
    }).catch((error) => {
      console.log(`Error during Discord login: ${error.message}`);
    });

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

    let participationRateAlertTriggering = {
      below90: false,
      below80: false,
      below70: false,
      belowTwoThird: false,
    };

    let currentParticipationRate: number | null = null;
    let currentParticipationRateEpoch: number | null = null;
    const twoThird = 2 / 3;

    let rateTestIndex = 0;
    const rateTests = [0.8491, 0.8501, 0.7729, 0.7683, 0.8357, 0.3412, 0.6841, 0.7158, 0.9518, 0.9638];

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

          const participationRate = queryResponse.data.previous_epoch_target_attesting_gwei / queryResponse.data.previous_epoch_active_gwei;
          const fixedParticipationRate = (participationRate * 100.0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';

          console.log(`Participation rate for epoch ${epoch} is ${fixedParticipationRate}.`);

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
              });
            } else if (participationRateAlertTriggering.belowTwoThird) {
              participationRateAlertTriggering.belowTwoThird = false;

              const message = `⚠️ Participation rate on Mainnet is back above 2 / 3 (current: ${fixedParticipationRate} for epoch ${epoch}). Finality should resume. ⚠️`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
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
              });
            } else if (participationRateAlertTriggering.below70) {
              participationRateAlertTriggering.below70 = false;

              const message = `⚠️ Participation rate on Mainnet is back above 70% (current: ${fixedParticipationRate} for epoch ${epoch}). ⚠️`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
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
              });
            } else if (participationRateAlertTriggering.below80) {
              participationRateAlertTriggering.below80 = false;

              const message = `⚠️ Participation rate on Mainnet is back above 80% (current: ${fixedParticipationRate} for epoch ${epoch}). ⚠️`;
              console.log(message);
              alertOnDiscord(message).catch((error) => {
                console.log(`Unable to send alert on discord. ${error}`);
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
              });
            }
            participationRateAlertTriggering.below90 = false;
            participationRateAlertTriggering.below80 = false;
            participationRateAlertTriggering.below70 = false;
            participationRateAlertTriggering.belowTwoThird = false;
          }

          currentParticipationRate = participationRate;
          currentParticipationRateEpoch = epoch;

        } catch (error) {
          console.log(`Error while trying to query Validator Inclusion API for epoch ${epoch} details. ${error}`);
        }
      });
    };

    const beaconNodeApiEndpoint = process.env.BEACON_API_ENDPOINT as string;
    const eventsRestEndpoint = '/eth/v1/events?topics=head,finalized_checkpoint';
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

    const finalizedCheckpointEventReceived = async function(evt: MessageEvent<any>) {
      console.log('finalized_checkpoint event');
      console.log(evt.data);
    };

    const headEventReceived = async function(evt: MessageEvent<any>) {
      const eventData = JSON.parse(evt.data) as headEvent;
      if (eventData.epoch_transition) {
        const epoch = eventData.slot / 32;
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

          attSlashings.forEach((attSlashing) => {
            const indices1 = new Set<number>(attSlashing.attestation_1.attesting_indices);
            const indices2 = new Set<number>(attSlashing.attestation_2.attesting_indices);
            const intersection = new Set<number>([...indices1].filter(x => indices2.has(x)));

            intersection.forEach((validatorIndex) => {
              console.log(`Attestation slashing for validator ${validatorIndex} at slot ${slot}`);
              const exploreChainUrl = `${validatorRoot}${validatorIndex}`;
              attestationSlashingsMessage = attestationSlashingsMessage + `\n- Validator **${validatorIndex}** was part of an *attestation slashing*. Explore this validator on <${exploreChainUrl}>`;
            });
          });
        }

        if (propSlashings.length > 0) {
          // We have proposer slashings
          console.log('Proposer slashings');
          foundSlashings = true;

          propSlashings.forEach((propSlashings) => {
            const index1 = propSlashings.signed_header_1.message.proposer_index;
            const index2 = propSlashings.signed_header_2.message.proposer_index;
            const validatorIndex = index1;
            if (index1 === index2) {
              console.log(`Proposer slashing for validator ${validatorIndex} at slot ${slot}`);
              const exploreChainUrl = `${validatorRoot}${validatorIndex}`;
              proposerSlashingMessage = proposerSlashingMessage + `\n- Validator **${validatorIndex}** was part of a *proposer slashing*. Explore this validator on <${exploreChainUrl}>`;
            }
          });
        }

        if (foundSlashings) {
          const message = `🚨 We just found **slashings** on Mainnet at slot ${slot} 🚨\n${attestationSlashingsMessage}${proposerSlashingMessage}`;
          alertOnDiscord(message).catch((error) => {
            console.log(`Unable to send alert on discord. ${error}`);
          });
        }

      } catch (error) {
        console.log(`Error while trying to query beacon node API for ${bnBlockUrl}. ${error}`);
      }

    };
    const headEventError = function(evt: MessageEvent<any>) {
      console.log('EventSource Error');
      console.log(evt);
      bnEvents.close();

      bnEvents = new EventSource(bnEventsUrl);
      bnEvents.addEventListener('head', headEventReceived);
      bnEvents.addEventListener('finalized_checkpoint', finalizedCheckpointEventReceived);
      bnEvents.onerror = headEventError;
    };

    bnEvents.addEventListener('head', headEventReceived);
    bnEvents.addEventListener('finalized_checkpoint', finalizedCheckpointEventReceived);
    bnEvents.onerror = headEventError;

  });
};

main();