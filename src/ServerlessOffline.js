import updateNotifier from 'update-notifier'
import debugLog from './debugLog.js'
import serverlessLog, { logWarning, setLog } from './serverlessLog.js'
import {
  createDefaultApiKey,
  // hasHttpEvent,
  hasWebsocketEvent,
  satisfiesVersionRange,
} from './utils/index.js'
import {
  CUSTOM_OPTION,
  defaults,
  options as commandOptions,
  SERVER_SHUTDOWN_TIMEOUT,
} from './config/index.js'
import pkg from '../package.json'

export default class ServerlessOffline {
  constructor(serverless, options) {
    this._apiGateway = null
    this._apiGatewayWebSocket = null

    this._options = options
    this._provider = serverless.service.provider
    this._serverless = serverless
    this._service = serverless.service

    setLog((...args) => serverless.cli.log(...args))

    this.commands = {
      offline: {
        // add start nested options
        commands: {
          start: {
            lifecycleEvents: ['init', 'end'],
            options: commandOptions,
            usage:
              'Simulates API Gateway to call your lambda functions offline using backward compatible initialization.',
          },
        },
        lifecycleEvents: ['start'],
        options: commandOptions,
        usage: 'Simulates API Gateway to call your lambda functions offline.',
      },
    }

    this.hooks = {
      'offline:start:init': this.start.bind(this),
      'offline:start': this._startWithExplicitEnd.bind(this),
      'offline:start:end': this.end.bind(this),
    }
  }

  _printBlankLine() {
    if (process.env.NODE_ENV !== 'test') {
      console.log()
    }
  }

  // Entry point for the plugin (sls offline) when running 'sls offline start'
  async start() {
    // check if update is available
    updateNotifier({ pkg }).notify()

    this._verifyServerlessVersionCompatibility()

    this.mergeOptions()

    // TODO FIXME uncomment condition below
    // we can't do this just yet, because we always create endpoints for
    // lambda Invoke endpoints. we could potentially add a flag (not everyone
    // uses lambda invoke) and only add lambda invoke routes if flag is set
    //
    // if (hasHttpEvent(this._service.functions)) {
    await this._createApiGateway()
    await this._apiGateway.start()
    // }

    if (hasWebsocketEvent(this._service.functions)) {
      await this._createApiGatewayWebSocket()
      await this._apiGatewayWebSocket.start()
    }

    this.setupEvents()

    if (this._apiGateway) {
      // Not found handling
      // we have to create the 404 routes last, otherwise we could have
      // collisions with catch all routes, e.g. any (proxy+}
      this._apiGateway.create404Route()
    }

    if (process.env.NODE_ENV !== 'test') {
      await this._listenForTermination()
    }
  }

  /**
   * Entry point for the plugin (sls offline) when running 'sls offline'
   * The call to this.end() would terminate the process before 'offline:start:end' could be consumed
   * by downstream plugins. When running sls offline that can be expected, but docs say that
   * 'sls offline start' will provide the init and end hooks for other plugins to consume
   * */
  async _startWithExplicitEnd() {
    await this.start()
    this.end()
  }

  async _listenForTermination() {
    const command = await new Promise((resolve) => {
      process
        // SIGINT will be usually sent when user presses ctrl+c
        .on('SIGINT', () => resolve('SIGINT'))
        // SIGTERM is a default termination signal in many cases,
        // for example when "killing" a subprocess spawned in node
        // with child_process methods
        .on('SIGTERM', () => resolve('SIGTERM'))
    })

    serverlessLog(`Got ${command} signal. Offline Halting...`)
  }

  async _createApiGateway() {
    const { default: ApiGateway } = await import('./api-gateway/index.js')

    this._apiGateway = new ApiGateway(
      this._service,
      this._options,
      this._serverless.config,
    )

    await this._apiGateway.registerPlugins()
    // HTTP Proxy defined in Resource
    this._apiGateway.createResourceRoutes()
  }

  async _createApiGatewayWebSocket() {
    const { default: ApiGatewayWebSocket } = await import(
      './api-gateway-websocket/index.js'
    )

    this._apiGatewayWebSocket = new ApiGatewayWebSocket(
      this._service,
      this._options,
      this._serverless.config,
    )

    // await this._apiGatewayWebSocket.createServer()
  }

  mergeOptions() {
    // custom options
    const { [CUSTOM_OPTION]: customOptions } = this._service.custom || {}

    // merge options
    // order of Precedence: command line options, custom options, defaults.
    this._options = {
      apiKey: createDefaultApiKey(),
      ...defaults,
      ...customOptions,
      ...this._options,
    }

    // Parse CORS options
    this._options.corsAllowHeaders = this._options.corsAllowHeaders
      .replace(/\s/g, '')
      .split(',')
    this._options.corsAllowOrigin = this._options.corsAllowOrigin
      .replace(/\s/g, '')
      .split(',')
    this._options.corsExposedHeaders = this._options.corsExposedHeaders
      .replace(/\s/g, '')
      .split(',')

    if (this._options.corsDisallowCredentials) {
      this._options.corsAllowCredentials = false
    }

    this._options.corsConfig = {
      credentials: this._options.corsAllowCredentials,
      exposedHeaders: this._options.corsExposedHeaders,
      headers: this._options.corsAllowHeaders,
      origin: this._options.corsAllowOrigin,
    }

    serverlessLog(
      `Starting Offline: ${this._provider.stage}/${this._provider.region}.`,
    )
    debugLog('options:', this._options)
  }

  async end() {
    serverlessLog('Halting offline server')

    await this._apiGateway.stop(SERVER_SHUTDOWN_TIMEOUT)

    if (process.env.NODE_ENV !== 'test') {
      process.exit(0)
    }
  }

  setupEvents() {
    // for simple API Key authentication model
    if (this._provider.apiKeys) {
      serverlessLog(`Key with token: ${this._options.apiKey}`)

      if (this._options.noAuth) {
        serverlessLog(
          'Authorizers are turned off. You do not need to use x-api-key header.',
        )
      } else {
        serverlessLog('Remember to use x-api-key on the request headers')
      }
    }

    Object.entries(this._service.functions).forEach(
      ([functionName, functionObj]) => {
        // TODO re-activate?
        // serverlessLog(`Routes for ${functionName}:`)

        this._apiGateway.createLambdaInvokeRoutes(functionName, functionObj)

        functionObj.events.forEach((event) => {
          const { http, websocket } = event

          if (http) {
            this._apiGateway.createRoutes(functionName, functionObj, http)
          }

          if (websocket) {
            this._apiGatewayWebSocket.createEvent(
              functionName,
              functionObj,
              websocket,
            )
          }
        })
      },
    )
  }

  // TEMP FIXME quick fix to expose gateway server for testing, look for better solution
  getApiGatewayServer() {
    return this._apiGateway.getServer()
  }

  // TODO: missing tests
  _verifyServerlessVersionCompatibility() {
    const { version: currentVersion } = this._serverless
    const { serverless: requiredVersionRange } = pkg.peerDependencies

    const versionIsSatisfied = satisfiesVersionRange(
      currentVersion,
      requiredVersionRange,
    )

    if (!versionIsSatisfied) {
      logWarning(
        `"Serverless-Offline" requires "Serverless" version ${requiredVersionRange} but found version ${currentVersion}.
         Be aware that functionality might be limited or has serious bugs.
         To avoid any issues update "Serverless" to a later version.
        `,
      )
    }
  }
}
