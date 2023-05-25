import { ConnectExtension } from '@magic-ext/connect';
import {
  InstanceWithExtensions,
  MagicSDKAdditionalConfiguration,
  SDKBase,
} from '@magic-sdk/provider';
import { normalizeChainId } from '@wagmi/core';
import { Magic } from 'magic-sdk';
import { Address, Chain, UserRejectedRequestError } from 'wagmi';

import { MagicConnector, MagicOptions } from './magicConnector.js';

interface MagicConnectOptions extends MagicOptions {
  magicSdkConfiguration?: MagicSDKAdditionalConfiguration;
}

const CONNECT_TIME_KEY = 'wagmi-magic-connector.connect.time';
const CONNECT_DURATION = 604800000; // 7 days in milliseconds

export class MagicConnectConnector extends MagicConnector {
  magicSDK?: InstanceWithExtensions<SDKBase, ConnectExtension[]>;

  magicSdkConfiguration: MagicConnectOptions['magicSdkConfiguration'];

  constructor(config: { chains?: Chain[]; options: MagicConnectOptions }) {
    super(config);
    this.magicSdkConfiguration = config.options.magicSdkConfiguration;
  }

  async connect({ chainId }: { chainId?: number } = {}) {
    if (!this.magicOptions.apiKey)
      throw new Error('Magic API Key is not provided.');
    try {
      const provider = await this.getProvider();

      if (provider.on) {
        provider.on('accountsChanged', this.onAccountsChanged);
        provider.on('chainChanged', this.onChainChanged);
        provider.on('disconnect', this.onDisconnect);
      }

      // Check if there is a user logged in
      const isAuthenticated = await this.isAuthorized();

      // Check if we have a chainId, in case of error just assign 0 for legacy
      let id: number;
      let unsupported: boolean;
      try {
        id = await this.getChainId();
        unsupported = this.isChainUnsupported(id);
        if (chainId && id !== chainId) {
          const chain = await this.switchChain(chainId);
          id = chain.id;
          unsupported = this.isChainUnsupported(id);
        }
      } catch (e) {
        id = 0;
        unsupported = false;
      }

      // if there is a user logged in, return the user
      if (isAuthenticated) {
        return {
          provider,
          chain: {
            id,
            unsupported,
          },
          account: await this.getAccount(),
        };
      }

      // open the modal and process the magic login steps
      if (!this.isModalOpen) {
        const magic = this.getMagicSDK();
        // LOGIN WITH MAGIC LINK WITH EMAIL
        const accounts = await magic.wallet.connectWithUI();

        let account = accounts[0] as Address;

        if (!account.startsWith('0x')) account = `0x${account}`;

        // As we have no way to know if a user is connected to Magic Connect we store a connect timestamp
        // in local storage
        window.localStorage.setItem(
          CONNECT_TIME_KEY,
          String(new Date().getTime())
        );

        // switch to chain if provided
        id = await this.getChainId();
        unsupported = this.isChainUnsupported(id);
        if (chainId && id !== chainId) {
          const chain = await this.switchChain(chainId);
          id = chain.id;
          unsupported = this.isChainUnsupported(id);
        }

        return {
          account,
          chain: {
            id,
            unsupported,
          },
          provider,
        };
      }
      throw new UserRejectedRequestError('User rejected request');
    } catch (error) {
      // try removing the localStorage item we check to see if a user is logged in
      // on an error.
      this.disconnect();
      console.log(error);
      throw new UserRejectedRequestError('Something went wrong');
    }
  }

  async getChainId(): Promise<number> {
    const networkOptions = this.magicSdkConfiguration?.network;
    if (networkOptions === 'mainnet') {
      return 1;
    } else if (networkOptions === 'goerli') {
      return 5;
    } else if (typeof networkOptions === 'object') {
      const chainID = networkOptions.chainId;
      if (chainID) {
        return normalizeChainId(chainID);
      }
    }
    throw new Error('Chain ID is not defined');
  }

  getMagicSDK(): InstanceWithExtensions<SDKBase, ConnectExtension[]> {
    if (!this.magicSDK) {
      this.magicSDK = new Magic(this.magicOptions.apiKey, {
        ...this.magicSdkConfiguration,
        extensions: [new ConnectExtension()],
      });
    }

    return this.magicSDK;
  }

  // Overrides isAuthorized because Connect opens overlay whenever we interact with one of its methods.
  // Moreover, there is currently no proper way to know if a user is currently logged in to Magic Connect.
  // So we use a local storage state to handle this information.
  // TODO Once connect API grows, integrate it
  async isAuthorized() {
    if (localStorage.getItem(CONNECT_TIME_KEY) === null) {
      return false;
    }
    return (
      parseInt(window.localStorage.getItem(CONNECT_TIME_KEY)) +
        CONNECT_DURATION >
      new Date().getTime()
    );
  }

  // Overrides disconnect because there is currently no proper way to disconnect a user from Magic
  // Connect.
  // So we use a local storage state to handle this information.
  async disconnect(): Promise<void> {
    window.localStorage.removeItem(CONNECT_TIME_KEY);
  }
}
