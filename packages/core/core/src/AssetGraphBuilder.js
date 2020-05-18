// @flow strict-local

import type {AbortSignal} from 'abortcontroller-polyfill/dist/cjs-ponyfill';
import type {FilePath} from '@parcel/types';
import type WorkerFarm, {Handle} from '@parcel/workers';
import type {Event} from '@parcel/watcher';
import type {
  Asset,
  AssetGraphNode,
  AssetGroup,
  AssetRequestInput,
  AssetRequestResult,
  Dependency,
  Entry,
  ParcelOptions,
  ValidationOpts,
} from './types';
import type {RunRequestOpts} from './RequestTracker';
import type {EntryRequest, EntryResult} from './requests/EntryRequest';
import type {TargetRequest} from './requests/TargetRequest';
import type {DepPathRequest} from './requests/PathRequest';
import type {AssetRequest} from './requests/AssetRequest';

import EventEmitter from 'events';
import nullthrows from 'nullthrows';
import path from 'path';
import {md5FromObject, md5FromString, PromiseQueue} from '@parcel/utils';
import AssetGraph from './AssetGraph';
import RequestTracker, {
  RequestGraph,
  generateRequestId,
} from './RequestTracker';
import {PARCEL_VERSION} from './constants';
import ParcelConfig from './ParcelConfig';

import createParcelConfigRequest from './requests/ParcelConfigRequest';
import createEntryRequest from './requests/EntryRequest';
import TargetRequestRunner from './requests/TargetRequest';
import createAssetRequest from './requests/AssetRequest';
import DepPathRequestRunner from './requests/PathRequest';

import Validation from './Validation';
import {report} from './ReporterRunner';

import dumpToGraphViz from './dumpGraphToGraphViz';

type Opts = {|
  options: ParcelOptions,
  optionsRef: number,
  name: string,
  entries?: Array<string>,
  assetGroups?: Array<AssetGroup>,
  workerFarm: WorkerFarm,
|};

type AssetGraphBuildRequest = EntryRequest | TargetRequest | DepPathRequest;

export default class AssetGraphBuilder extends EventEmitter {
  assetGraph: AssetGraph;
  requestGraph: RequestGraph;
  requestTracker: RequestTracker;
  targetRequestRunner: TargetRequestRunner;
  depPathRequestRunner: DepPathRequestRunner;
  assetRequests: Array<AssetGroup>;
  runValidate: ValidationOpts => Promise<void>;
  queue: PromiseQueue<mixed>;
  rejected: Map<string, mixed>;

  changedAssets: Map<string, Asset> = new Map();
  options: ParcelOptions;
  optionsRef: number;
  config: ParcelConfig;
  configRef: number;
  workerFarm: WorkerFarm;
  cacheKey: string;
  entries: ?Array<string>;
  initialAssetGroups: ?Array<AssetGroup>;

  handle: Handle;

  async init({
    options,
    optionsRef,
    entries,
    name,
    assetGroups,
    workerFarm,
  }: Opts) {
    this.options = options;
    this.optionsRef = optionsRef;
    this.entries = entries;
    this.initialAssetGroups = assetGroups;
    this.workerFarm = workerFarm;
    this.assetRequests = [];

    // TODO: changing these should not throw away the entire graph.
    // We just need to re-run target resolution.
    let {hot, publicUrl, distDir, minify, scopeHoist} = options;
    this.cacheKey = md5FromObject({
      parcelVersion: PARCEL_VERSION,
      name,
      options: {hot, publicUrl, distDir, minify, scopeHoist},
      entries,
    });

    this.queue = new PromiseQueue();

    this.runValidate = workerFarm.createHandle('runValidate');
    this.handle = workerFarm.createReverseHandle(() => {
      // Do nothing, this is here because there is a bug in `@parcel/workers`
    });

    let changes = await this.readFromCache();
    if (!changes) {
      this.assetGraph = new AssetGraph();
      this.requestGraph = new RequestGraph();
    }

    this.assetGraph.initOptions({
      onNodeRemoved: node => this.handleNodeRemovedFromAssetGraph(node),
    });

    this.requestTracker = new RequestTracker({
      graph: this.requestGraph,
      farm: workerFarm,
      options: this.options,
    });
    let tracker = this.requestTracker;
    this.targetRequestRunner = new TargetRequestRunner({tracker});

    if (changes) {
      this.requestGraph.invalidateUnpredictableNodes();
      this.requestTracker.respondToFSEvents(changes);
    } else {
      this.assetGraph.initialize({
        entries,
        assetGroups,
      });
    }
  }

  async setupConfigStuff() {
    let {config, configRef} = nullthrows(
      await this.requestTracker.runRequest(createParcelConfigRequest()),
    );

    // This should not be necessary once sub requests are supported
    if (configRef !== this.configRef) {
      this.configRef = configRef;
      this.config = new ParcelConfig(
        config,
        this.options.packageManager,
        this.options.autoinstall,
      );
      let {requestTracker: tracker} = this;
      this.depPathRequestRunner = new DepPathRequestRunner({tracker});
    }
  }

  async build(
    signal?: AbortSignal,
  ): Promise<{|
    assetGraph: AssetGraph,
    changedAssets: Map<string, Asset>,
  |}> {
    await this.setupConfigStuff();

    this.rejected = new Map();

    let root = this.assetGraph.getRootNode();
    if (!root) {
      throw new Error('A root node is required to traverse');
    }

    let visited = new Set([root.id]);

    const visit = node => {
      let request = this.getCorrespondingRequest(node);
      if (!node.complete && !node.deferred && request != null) {
        // $FlowFixMe
        this.queueRequest(request, {
          signal,
        }).then(() => visitChildren(node));
      } else {
        visitChildren(node);
      }
    };

    const visitChildren = node => {
      for (let child of this.assetGraph.getNodesConnectedFrom(node)) {
        if (
          (!visited.has(child.id) || child.hasDeferred) &&
          this.assetGraph.shouldVisitChild(node, child)
        ) {
          visited.add(child.id);
          visit(child);
        }
      }
    };

    visit(root);
    await this.queue.run();

    let errors = [];
    for (let [requestId, error] of this.rejected) {
      // ? Is this still needed?
      if (this.requestTracker.isTracked(requestId)) {
        errors.push(error);
      }
    }

    if (errors.length) {
      throw errors[0]; // TODO: eventually support multiple errors since requests could reject in parallel
    }

    dumpToGraphViz(this.assetGraph, 'AssetGraph');
    // $FlowFixMe Added in Flow 0.121.0 upgrade in #4381
    dumpToGraphViz(this.requestGraph, 'RequestGraph');

    let changedAssets = this.changedAssets;
    this.changedAssets = new Map();
    return {assetGraph: this.assetGraph, changedAssets: changedAssets};
  }

  async validate(): Promise<void> {
    let trackedRequestsDesc = this.assetRequests.filter(request => {
      return this.config.getValidatorNames(request.filePath).length > 0;
    });

    // Schedule validations on workers for all plugins that implement the one-asset-at-a-time "validate" method.
    let promises = trackedRequestsDesc.map(request =>
      this.runValidate({
        requests: [request],
        optionsRef: this.optionsRef,
        configRef: this.configRef,
      }),
    );

    // Skip sending validation requests if no validators were configured
    if (trackedRequestsDesc.length === 0) {
      return;
    }

    // Schedule validations on the main thread for all validation plugins that implement "validateAll".
    promises.push(
      new Validation({
        requests: trackedRequestsDesc,
        options: this.options,
        config: this.config,
        report,
        dedicatedThread: true,
      }).run(),
    );

    this.assetRequests = [];
    await Promise.all(promises);
  }

  queueRequest(request: AssetGraphBuildRequest, runOpts: RunRequestOpts) {
    return this.queue.add(async () => {
      if (this.rejected.size > 0) {
        return;
      }

      try {
        await this.runRequest(request, runOpts);
      } catch (e) {
        this.rejected.set(request.id, e);
      }
    });
  }

  // TODO: this should be removed after refactor
  // $FlowFixMe
  runRequest(request: any, runOpts: RunRequestOpts) {
    switch (request.type) {
      case 'entry_request':
        return this.runEntryRequest(request);
      case 'target_request':
        return this.runTargetRequest(request.request, request.id, runOpts);
      case 'dep_path_request':
        return this.runDepPathRequest(request.request, request.id, runOpts);
      case 'asset_request':
        return this.runAssetRequest(request);
    }
  }

  async runEntryRequest(request: EntryRequest) {
    let result = await this.requestTracker.runRequest<
      FilePath,
      EntryResult,
      EntryRequest,
    >(request);
    // TODO: shouldn't need this check, improve request graph types
    if (result != null) {
      this.assetGraph.resolveEntry(request.input, result.entries, request.id);
    }
  }

  async runTargetRequest(
    request: Entry,
    requestId: string,
    runOpts: RunRequestOpts,
  ) {
    let result = await this.targetRequestRunner.runRequest({
      request,
      ...runOpts,
    });
    if (result != null) {
      this.assetGraph.resolveTargets(request, result.targets, requestId);
    }
  }

  async runDepPathRequest(
    request: Dependency,
    requestId: string,
    runOpts: RunRequestOpts,
  ) {
    let result = await this.depPathRequestRunner.runRequest({
      request,
      extras: {
        config: this.config,
      },
      ...runOpts,
    });
    this.assetGraph.resolveDependency(request, result, requestId);
  }

  async runAssetRequest(request: AssetRequest) {
    // eslint-disable-next-line no-unused-vars
    let {configRef, optionsRef, ...assetGroup} = request.input;
    this.assetRequests.push(assetGroup);
    let assets = await this.requestTracker.runRequest<
      AssetRequestInput,
      AssetRequestResult,
      AssetRequest,
    >(request);

    if (assets != null) {
      for (let asset of assets) {
        this.changedAssets.set(asset.id, asset);
      }
      this.assetGraph.resolveAssetGroup(assetGroup, assets, request.id);
    }
  }

  getCorrespondingRequest(node: AssetGraphNode) {
    let requestNode =
      node.correspondingRequest != null
        ? this.requestGraph.getNode(node.correspondingRequest)
        : null;
    if (
      requestNode != null &&
      this.requestTracker.hasValidResult(requestNode.id)
    ) {
      return null;
    }
    switch (node.type) {
      case 'entry_specifier': {
        return createEntryRequest(node.value);
      }
      case 'entry_file': {
        let type = 'target_request';
        return {
          type,
          request: node.value,
          id: generateRequestId(type, node.value),
        };
      }
      case 'dependency': {
        let type = 'dep_path_request';
        return {
          type,
          request: node.value,
          id: generateRequestId(type, node.value),
        };
      }
      case 'asset_group': {
        return createAssetRequest({
          ...node.value,
          configRef: this.configRef,
          optionsRef: this.optionsRef,
        });
      }
    }
  }

  handleNodeRemovedFromAssetGraph(node: AssetGraphNode) {
    let request = this.getCorrespondingRequest(node);
    if (request != null && this.requestTracker.isTracked(request.id)) {
      this.requestTracker.untrackRequest(request.id);
    }
  }

  respondToFSEvents(events: Array<Event>) {
    return this.requestGraph.respondToFSEvents(events);
  }

  getWatcherOptions() {
    let vcsDirs = ['.git', '.hg'].map(dir =>
      path.join(this.options.projectRoot, dir),
    );
    let ignore = [this.options.cacheDir, ...vcsDirs];
    return {ignore};
  }

  getCacheKeys() {
    let assetGraphKey = md5FromString(`${this.cacheKey}:assetGraph`);
    let requestGraphKey = md5FromString(`${this.cacheKey}:requestGraph`);
    let snapshotKey = md5FromString(`${this.cacheKey}:snapshot`);
    return {assetGraphKey, requestGraphKey, snapshotKey};
  }

  async readFromCache(): Promise<?Array<Event>> {
    if (this.options.disableCache) {
      return null;
    }

    let {assetGraphKey, requestGraphKey, snapshotKey} = this.getCacheKeys();
    let assetGraph = await this.options.cache.get(assetGraphKey);
    let requestGraph = await this.options.cache.get(requestGraphKey);

    if (assetGraph && requestGraph) {
      this.assetGraph = assetGraph;
      this.requestGraph = requestGraph;

      let opts = this.getWatcherOptions();
      let snapshotPath = this.options.cache._getCachePath(snapshotKey, '.txt');
      return this.options.inputFS.getEventsSince(
        this.options.projectRoot,
        snapshotPath,
        opts,
      );
    }

    return null;
  }

  async writeToCache() {
    if (this.options.disableCache) {
      return;
    }

    let {assetGraphKey, requestGraphKey, snapshotKey} = this.getCacheKeys();
    await this.options.cache.set(assetGraphKey, this.assetGraph);
    await this.options.cache.set(requestGraphKey, this.requestGraph);

    let opts = this.getWatcherOptions();
    let snapshotPath = this.options.cache._getCachePath(snapshotKey, '.txt');
    await this.options.inputFS.writeSnapshot(
      this.options.projectRoot,
      snapshotPath,
      opts,
    );
  }
}
