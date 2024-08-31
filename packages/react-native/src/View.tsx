import { StoryContext, toId } from '@storybook/csf';
import { addons as managerAddons, Provider as ManagerProvider } from '@storybook/manager-api';
import { Provider } from '@storybook/manager';
import { addons as previewAddons } from '@storybook/preview-api';
import type { PreviewWithSelection } from '@storybook/preview-web';
import type { ReactRenderer } from '@storybook/react';
import { Theme, ThemeProvider, darkTheme, theme } from '@storybook/react-native-theming';
import type { PreparedStory, StoryId, StoryIndex } from '@storybook/types';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import OnDeviceUI from './components/OnDeviceUI';
import StoryView from './components/StoryView';
import { syncExternalUI, useSetStoryContext } from './hooks';
// TODO check this
import { createWebSocketChannel, type Channel } from '@storybook/channels';
import Events from '@storybook/core-events';
import dedent from 'dedent';
import deepmerge from 'deepmerge';
import { useColorScheme, ActivityIndicator, View as RNView, StyleSheet } from 'react-native';
import getHost from './rn-host-detect';

class ReactNativeProvider extends Provider {
  getElements() {}

  handleAPI() {}

  getConfig() {
    return {};
  }
}

const provider = new ReactNativeProvider();

const STORAGE_KEY = 'lastOpenedStory';

interface Storage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

type StoryKind = string;

type StoryName = string;

type InitialSelection =
  | `${StoryKind}--${StoryName}`
  | {
      /**
       * Kind is the default export name or the storiesOf("name") name
       */
      kind: StoryKind;

      /**
       * Name is the named export or the .add("name") name
       */
      name: StoryName;
    };

type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;

export type Params = {
  onDeviceUI?: boolean;
  // resetStorybook?: boolean; // TODO: Do we need this?
  enableWebsockets?: boolean;
  query?: string;
  host?: string;
  port?: number;
  secured?: boolean;
  initialSelection?: InitialSelection;
  shouldPersistSelection?: boolean;
  tabOpen?: number;
  isUIHidden?: boolean;
  isSplitPanelVisible?: boolean;
  shouldDisableKeyboardAvoidingView?: boolean;
  keyboardAvoidingViewVerticalOffset?: number;
  theme: DeepPartial<Theme>;
  storage?: Storage;
};

export class View {
  _storyIndex: StoryIndex;
  _setStory: (story: StoryContext<ReactRenderer>) => void = () => {};
  _forceRerender: () => void;
  _ready: boolean = false;
  _preview: PreviewWithSelection<ReactRenderer>;
  _asyncStorageStoryId: string;
  _webUrl: string;
  _storage: Storage;
  _channel: Channel;
  _idToPrepared: Record<string, PreparedStory<ReactRenderer>> = {};

  constructor(preview: PreviewWithSelection<ReactRenderer>, channel: Channel) {
    this._preview = preview;
    this._channel = channel;
  }

  _getInitialStory = async ({
    initialSelection,
    shouldPersistSelection = true,
  }: Partial<Params> = {}) => {
    if (initialSelection) {
      if (typeof initialSelection === 'string') {
        return { storySpecifier: initialSelection, viewMode: 'story' };
      } else {
        return {
          storySpecifier: toId(initialSelection.kind, initialSelection.name),
          viewMode: 'story',
        };
      }
    }

    if (shouldPersistSelection) {
      try {
        let value = this._asyncStorageStoryId;

        if (!value && this._storage != null) {
          value = await this._storage.getItem(STORAGE_KEY);

          this._asyncStorageStoryId = value;
        }

        const exists = value && Object.keys(this._storyIndex.entries).includes(value);

        if (!exists) console.log('Storybook: could not find persisted story');

        return { storySpecifier: exists ? value : '*', viewMode: 'story' };
      } catch (e) {
        console.warn('storybook-log: error reading from async storage', e);
      }
    }

    return { storySpecifier: '*', viewMode: 'story' };
  };

  _getServerChannel = (params: Partial<Params> = {}) => {
    const host = getHost(params.host || 'localhost');

    const port = `:${params.port || 7007}`;

    const query = params.query || '';

    const websocketType = params.secured ? 'wss' : 'ws';

    const url = `${websocketType}://${host}${port}/${query}`;

    return createWebSocketChannel({
      url,
      async: true,
      onError: async () => {},
    });
  };

  createPreparedStoryMapping = async () => {
    await Promise.all(
      Object.keys(this._storyIndex.entries).map(async (storyId: StoryId) => {
        this._idToPrepared[storyId] = await this._preview.storyStore.loadStory({ storyId });
      })
    );
  };

  getStorybookUI = (params: Partial<Params> = {}) => {
    const {
      shouldPersistSelection = true,
      onDeviceUI = true,
      enableWebsockets = false,
      storage,
    } = params;

    this._storage = storage;

    const initialStory = this._getInitialStory(params);

    if (enableWebsockets) {
      const channel = this._getServerChannel(params);
      managerAddons.setChannel(channel);
      previewAddons.setChannel(channel);
      this._channel = channel;
      // @ts-ignore FIXME
      this._preview.channel = channel;
      this._preview.setupListeners();
      channel.emit(Events.CHANNEL_CREATED);
      this._preview.initializeWithStoryIndex(this._storyIndex);
    }

    managerAddons.loadAddons({
      store: () => ({
        fromId: (id) => {
          if (!this._ready) {
            throw new Error('Storybook is not ready yet');
          }

          return this._preview.storyStore.getStoryContext(this._idToPrepared[id]);
        },

        getSelection: () => {
          return this._preview.currentSelection;
        },
        _channel: this._channel,
      }),
    });

    // eslint-disable-next-line consistent-this
    const self = this;

    // Sync the Storybook parameters (external) with app UI state (internal), to initialise them.
    syncExternalUI({
      isUIVisible: params.isUIHidden !== undefined ? !params.isUIHidden : undefined,
      isSplitPanelVisible: params.isSplitPanelVisible,
    });

    return () => {
      const setContext = useSetStoryContext();
      const colorScheme = useColorScheme();
      const [, forceUpdate] = useReducer((x) => x + 1, 0);
      const [ready, setReady] = useState(false);

      const appliedTheme = useMemo(
        () => deepmerge(colorScheme === 'dark' ? darkTheme : theme, params.theme ?? {}),
        [colorScheme]
      );

      useEffect(() => {
        this.createPreparedStoryMapping()
          .then(() => {
            this._ready = true;
            setReady(true);
          })
          .catch((e) => console.error(e));

        self._setStory = (newStory: StoryContext<ReactRenderer>) => {
          setContext(newStory);

          if (shouldPersistSelection && !storage) {
            // TODO: improve this warning to link to docs
            console.warn(dedent`Please set storage in getStorybookUI like this:
              const StorybookUIRoot = view.getStorybookUI({
                storage: {
                  getItem: AsyncStorage.getItem,
                  setItem: AsyncStorage.setItem,
                },
              });
            `);
          }

          if (shouldPersistSelection && !!this._storage) {
            this._storage.setItem(STORAGE_KEY, newStory.id).catch((e) => {
              console.warn('storybook-log: error writing to async storage', e);
            });
          }
        };

        self._forceRerender = () => forceUpdate();

        initialStory.then((story) => {
          self._preview.selectionStore.selectionSpecifier = story;

          self._preview.selectSpecifiedStory();
        });

        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      if (!ready) {
        return (
          <RNView
            style={{
              ...StyleSheet.absoluteFillObject,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <ActivityIndicator animating size={'large'} />
          </RNView>
        );
      }

      if (onDeviceUI) {
        return (
          // addons/links relies on the SELECT_STORY event, which uses the navigate method from ManagerProvider - https://github.com/storybookjs/storybook/blob/acd2b709e6f056085e86ce65e57ba0a09e59a4ab/code/core/src/manager-api/modules/stories.ts#L458
          // web version implementation: https://github.com/storybookjs/storybook/blob/acd2b709e6f056085e86ce65e57ba0a09e59a4ab/code/core/src/manager/index.tsx#L46
          <ManagerProvider
            docsOptions={{}}
            location={{}}
            navigate={() => {
              console.log('navigate');
            }}
            path="/"
            provider={provider}
          >
            <SafeAreaProvider>
              <ThemeProvider theme={appliedTheme as Theme}>
                <OnDeviceUI
                  storyIndex={self._storyIndex}
                  tabOpen={params.tabOpen}
                  shouldDisableKeyboardAvoidingView={params.shouldDisableKeyboardAvoidingView}
                  keyboardAvoidingViewVerticalOffset={params.keyboardAvoidingViewVerticalOffset}
                />
              </ThemeProvider>
            </SafeAreaProvider>
          </ManagerProvider>
        );
      } else {
        return <StoryView />;
      }
    };
  };
}
