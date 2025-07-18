import { Database } from '../db/database';
import { LocalMeta, ModelBase, ModelCfg } from '../pfapi.model';
import { pfLog } from '../util/log';
import { getEnvironmentId } from '../util/get-environment-id';
import { DBNames } from '../pfapi.const';
import {
  ClientIdNotFoundError,
  InvalidMetaError,
  MetaNotReadyError,
} from '../errors/errors';
import { validateLocalMeta } from '../util/validate-local-meta';
import { PFEventEmitter } from '../util/events';
import { devError } from '../../../util/dev-error';
import { incrementVectorClock } from '../util/vector-clock';
import { getVectorClock, setVectorClock } from '../util/backwards-compat';

export const DEFAULT_META_MODEL: LocalMeta = {
  crossModelVersion: 1,
  revMap: {},
  lastUpdate: 0,
  metaRev: null,
  lastSyncedUpdate: null,
  localLamport: 0,
  lastSyncedLamport: null,
  vectorClock: {},
  lastSyncedVectorClock: null,
};

/**
 * Manages metadata for model synchronization and versioning.
 * Handles client identification and provides meta information for the synchronization process.
 */
export class MetaModelCtrl {
  private static readonly L = 'MetaModelCtrl';

  static readonly META_MODEL_ID = DBNames.MetaModel;
  static readonly META_MODEL_REMOTE_FILE_NAME = DBNames.MetaModel;
  static readonly CLIENT_ID = DBNames.ClientId;
  static readonly META_FILE_LOCK_CONTENT_PREFIX = 'SYNC_IN_PROGRESS__' as const;

  private _metaModelInMemory?: LocalMeta;
  private _clientIdInMemory?: string;

  /**
   * Creates a new MetaModelCtrl instance
   *
   * @param _db Database instance for storage operations
   * @param _ev Event emitter for broadcasting model changes
   * @param crossModelVersion The cross-model version number
   */
  constructor(
    private readonly _db: Database,
    private readonly _ev: PFEventEmitter,
    public crossModelVersion: number,
  ) {
    //
    this._initClientId();
    this.load().then((v) => {
      this._metaModelInMemory = v;
    });
  }

  /**
   * Updates the revision for a specific model
   *
   * @param modelId The ID of the model to update
   * @param modelCfg Configuration for the model
   * @param isIgnoreDBLock Whether to ignore database locks
   * @throws {MetaNotReadyError} When metamodel is not loaded yet
   */
  async updateRevForModel<MT extends ModelBase>(
    modelId: string,
    modelCfg: ModelCfg<MT>,
    isIgnoreDBLock = false,
  ): Promise<void> {
    pfLog(2, `${MetaModelCtrl.L}.${this.updateRevForModel.name}()`, modelId, {
      modelCfg,
      inMemory: this._metaModelInMemory,
    });
    if (modelCfg.isLocalOnly) {
      return;
    }

    const metaModel = this._getMetaModelOrThrow(modelId, modelCfg);
    const timestamp = Date.now();

    // Get client ID for vector clock
    const clientId = await this.loadClientId();

    // Create action string (max 100 chars)
    const actionStr = `${modelId} => ${new Date(timestamp).toISOString()}`;
    const lastUpdateAction =
      actionStr.length > 100 ? actionStr.substring(0, 97) + '...' : actionStr;

    // Update vector clock - migrate from Lamport if needed
    let currentVectorClock = getVectorClock(metaModel, clientId);
    if (!currentVectorClock && metaModel.localLamport > 0) {
      // First time creating vector clock - migrate from Lamport timestamp
      currentVectorClock = { [clientId]: metaModel.localLamport };
      pfLog(
        2,
        `${MetaModelCtrl.L}.${this.updateRevForModel.name}() migrating Lamport to vector clock`,
        {
          clientId,
          localLamport: metaModel.localLamport,
          newVectorClock: currentVectorClock,
        },
      );
    }

    const newVectorClock = incrementVectorClock(currentVectorClock || {}, clientId);

    const updatedMeta = {
      ...metaModel,
      lastUpdate: timestamp,
      lastUpdateAction,
      localLamport: this._incrementLamport(metaModel.localLamport || 0),

      ...(modelCfg.isMainFileModel
        ? {}
        : {
            revMap: {
              ...metaModel.revMap,
              [modelId]: timestamp.toString(),
            },
          }),
      // as soon as we save a related model, we are using the local crossModelVersion (while other updates might be from importing remote data)
      crossModelVersion: this.crossModelVersion,
    };

    // Set vector clock using backwards compatibility helper
    setVectorClock(updatedMeta, newVectorClock, clientId);

    await this.save(updatedMeta, isIgnoreDBLock);
  }

  /**
   * Saves the metamodel to storage
   *
   * @param metaModel The metamodel to save
   * @param isIgnoreDBLock Whether to ignore database locks
   * @returns Promise that resolves when the save completes
   * @throws {InvalidMetaError} When metamodel is invalid
   */
  save(metaModel: LocalMeta, isIgnoreDBLock = false): Promise<unknown> {
    pfLog(2, `${MetaModelCtrl.L}.${this.save.name}()`, {
      metaModel,
      lastSyncedUpdate: metaModel.lastSyncedUpdate,
      lastUpdate: metaModel.lastUpdate,
      isIgnoreDBLock,
    });
    if (typeof metaModel.lastUpdate !== 'number') {
      return Promise.reject(
        new InvalidMetaError(
          `${MetaModelCtrl.L}.${this.save.name}()`,
          'lastUpdate not found',
        ),
      );
    }

    // NOTE: in order to not mess up separate model updates started at the same time, we need to update synchronously as well
    this._metaModelInMemory = validateLocalMeta(metaModel);
    this._ev.emit('metaModelChange', metaModel);
    this._ev.emit('syncStatusChange', 'UNKNOWN_OR_CHANGED');

    // Add detailed logging before saving
    pfLog(2, `${MetaModelCtrl.L}.${this.save.name}() about to save to DB:`, {
      id: MetaModelCtrl.META_MODEL_ID,
      lastSyncedUpdate: metaModel.lastSyncedUpdate,
      lastUpdate: metaModel.lastUpdate,
      willMatch: metaModel.lastSyncedUpdate === metaModel.lastUpdate,
    });

    const savePromise = this._db.save(
      MetaModelCtrl.META_MODEL_ID,
      metaModel,
      isIgnoreDBLock,
    );

    // Log after save completes
    savePromise
      .then(() => {
        pfLog(
          2,
          `${MetaModelCtrl.L}.${this.save.name}() DB save completed successfully`,
          metaModel.localLamport,
          metaModel,
        );
      })
      .catch((error) => {
        devError('DB save for meta file failed');
        pfLog(0, `${MetaModelCtrl.L}.${this.save.name}() DB save failed`, error);
      });

    return savePromise;
  }

  /**
   * Loads the metamodel from storage
   *
   * @returns Promise that resolves to the loaded metamodel
   * @throws {InvalidMetaError} When loaded data is invalid
   */
  async load(): Promise<LocalMeta> {
    pfLog(3, `${MetaModelCtrl.L}.${this.load.name}()`, this._metaModelInMemory);

    if (this._metaModelInMemory) {
      return this._metaModelInMemory;
    }

    const data = (await this._db.load(MetaModelCtrl.META_MODEL_ID)) as LocalMeta;

    // Add debug logging
    pfLog(2, `${MetaModelCtrl.L}.${this.load.name}() loaded from DB:`, {
      data,
      hasData: !!data,
      lastSyncedUpdate: data?.lastSyncedUpdate,
      lastUpdate: data?.lastUpdate,
    });

    // Initialize if not found
    if (!data) {
      this._metaModelInMemory = {
        ...DEFAULT_META_MODEL,
        crossModelVersion: this.crossModelVersion,
      };
      pfLog(2, `${MetaModelCtrl.L}.${this.load.name}() initialized with defaults`);
      return this._metaModelInMemory;
    }
    if (!data.revMap) {
      throw new InvalidMetaError('loadMetaModel: revMap not found');
    }

    // Log the loaded data
    pfLog(2, `${MetaModelCtrl.L}.${this.load.name}() loaded valid data:`, {
      lastUpdate: data.lastUpdate,
      lastSyncedUpdate: data.lastSyncedUpdate,
      metaRev: data.metaRev,
      hasRevMap: !!data.revMap,
      revMapKeys: Object.keys(data.revMap || {}),
    });

    // Ensure Lamport fields are initialized for old data
    if (data.localLamport === undefined) {
      data.localLamport = 0;
    }
    if (data.lastSyncedLamport === undefined) {
      data.lastSyncedLamport = null;
    }

    this._metaModelInMemory = data;
    return data;
  }

  /**
   * Loads the client ID from storage
   *
   * @returns Promise that resolves to the client ID
   * @throws {ClientIdNotFoundError} When client ID is not found
   */
  async loadClientId(): Promise<string> {
    if (this._clientIdInMemory) {
      return this._clientIdInMemory;
    }

    const clientId = await this._db.load(MetaModelCtrl.CLIENT_ID);
    if (typeof clientId !== 'string') {
      throw new ClientIdNotFoundError();
    }

    this._clientIdInMemory = clientId;
    return clientId;
  }

  /**
   * Initializes the client ID
   */
  private async _initClientId(): Promise<void> {
    try {
      await this.loadClientId();
    } catch (e) {
      if (e instanceof ClientIdNotFoundError) {
        const clientId = this._generateClientId();
        pfLog(2, `${MetaModelCtrl.L} Create clientId ${clientId}`);
        await this._saveClientId(clientId);
      } else {
        pfLog(0, `${MetaModelCtrl.L} Error initializing clientId:`, e);
      }
    }
  }

  /**
   * Gets the metamodel or throws an error if not ready
   */
  private _getMetaModelOrThrow<MT extends ModelBase>(
    modelId: string,
    modelCfg: ModelCfg<MT>,
  ): LocalMeta {
    const metaModel = this._metaModelInMemory;
    if (!metaModel) {
      throw new MetaNotReadyError(modelId, modelCfg);
    }
    return metaModel;
  }

  /**
   * Saves the client ID to storage
   *
   * @param clientId Client ID to save
   * @returns Promise that resolves when the save completes
   */
  private _saveClientId(clientId: string): Promise<unknown> {
    pfLog(2, `${MetaModelCtrl.L}.${this._saveClientId.name}()`, clientId);
    this._clientIdInMemory = clientId;
    return this._db.save(MetaModelCtrl.CLIENT_ID, clientId, true);
  }

  /**
   * Generates a new client ID
   *
   * @returns Generated client ID
   */
  private _generateClientId(): string {
    pfLog(2, `${MetaModelCtrl.L}.${this._generateClientId.name}()`);
    return getEnvironmentId() + '_' + Date.now();
  }

  /**
   * Safely increments Lamport timestamp with overflow protection
   *
   * @param current Current Lamport value
   * @returns Incremented value
   */
  private _incrementLamport(current: number): number {
    // Reset if approaching max safe integer
    if (current >= Number.MAX_SAFE_INTEGER - 1000) {
      pfLog(1, `${MetaModelCtrl.L} Lamport counter overflow protection triggered`);
      return 1;
    }
    return current + 1;
  }
}
