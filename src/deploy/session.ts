import * as path from 'node:path'
import { getLogger } from '..'
import { createMountedFs, getPublished, getDeploymentFs, getDataRepository, getDeploymentStore, readState, toFsFromIndex, createTempMountedFs, getFsFromHash, toFsFromHash, getProgramFs, getProgramHash, DataRepository } from '../artifacts'
import { getAuth } from '../auth'
import { getBackendClient } from '../backendClient'
import { isDataPointer } from '../build-fs/pointers'
import { getBuildTargetOrThrow, getFs } from '../execution'
import { createPackageService, importMapToManifest } from '../pm/packages'
import { createMergedView, getSelfDir } from '../pm/publish'
import { ImportMap, SourceInfo } from '../runtime/importMaps'
import { createContext, createSourceMapParser, createModuleLoader, BasicDataRepository } from '../runtime/loader'
import { resolveValue } from '../runtime/modules/serdes'
import { createBasicDataRepo, createModuleResolverForBundling } from '../runtime/rootLoader'
import { createCodeCache } from '../runtime/utils'
import { createTemplateService } from '../templates'
import { wrapWithProxy, memoize, getHash, createRwMutex, throwIfNotFileNotFoundError } from '../utils'
import { BuildTarget, getOrCreateDeployment, getDeploymentBuildDirectory, getV8CacheDirectory } from '../workspaces'
import { DeployOptions, SessionContext, createStatePersister, createZip, getTerraformPath, mapResource, parsePlan, startTerraformSession } from './deployment'
import { TfJson } from '../runtime/modules/terraform'
import { TfState } from './state'
import { printLine } from '../cli/ui'
import { formatWithOptions } from 'node:util'
import { getDeployables, getEntrypointsFile } from '../compiler/programBuilder'
import { ModuleLoader } from './server'
import { Fs, SyncFs } from '../system'
import { ModuleResolver } from '../runtime/resolver'
import { getServiceRegistry } from './registry'
import { getCurrentEnvFilePath, parseEnvFile } from '../runtime/env'

export async function loadBuildState(bt: BuildTarget, repo = getDataRepository()) {
    const mergedFs = await createMergedView(bt.programId, bt.deploymentId)
    const mountedFs = createTempMountedFs(mergedFs, bt.workingDirectory)
    const resolver = createModuleResolverForBundling(mountedFs, bt.workingDirectory)
    const pkgService = await createPackageService(resolver, repo)
    const { stores } = await pkgService.loadIndex() // 5ms on simple hello world no infra
    mountedFs.addMounts(stores)
    
    await setupPublished()

    return {
        repo,
        mountedFs: mountedFs as Fs & SyncFs,
        resolver: resolver as ModuleResolver,
        registerPointerDependencies: pkgService.registerPointerDependencies,
    }

    async function setupPublished() {
        if (!bt.deploymentId) {
            return
        }

        const procFs = getDeploymentFs(bt.deploymentId, bt.programId)
        const published = await getPublished(procFs)
        if (!published) {
            return
        }

        const deployables = (await getEntrypointsFile(getProgramFs(bt.programId)))?.deployables
        const programDeployables = new Set<string>(Object.values(deployables ?? {}).map(f => path.relative(bt.workingDirectory, f)))

        const importMap: ImportMap<SourceInfo> = {}
        for (const [k, v] of Object.entries(published)) {
            if (!programDeployables.has(k)) continue

            const m = await pkgService.getPublishedMappings2(k, v)
            if (m) {
                importMap[m[0]] = m[1]
            }
        }

        resolver.registerMapping(importMap, bt.workingDirectory)
    }
}

export async function getModuleLoader(wrapConsole = true): Promise<ModuleLoader> {
    const bt = getBuildTargetOrThrow()
    const repo = getDataRepository()
    const auth = getAuth()
    const fs = getFs()
    const backendClient = getBackendClient()

    const { mountedFs, resolver, registerPointerDependencies } = await loadBuildState(bt)

    function createConsoleWrap() {
        const printToConsole = (...args: any[]) => printLine(formatWithOptions({ colors: process.stdout.isTTY }, ...args))
        const logMethods = {
            log: printToConsole,
            warn: printToConsole,
            error: printToConsole,
            debug: printToConsole,
            // TODO: this is wrong, we don't emit a trace
            trace: printToConsole,
        }

        return wrapWithProxy(globalThis.console, logMethods)
    }


    const loaderContext = createContext(bt, backendClient, auth, wrapConsole ? createConsoleWrap() : undefined)

    const getSourceMapParser = memoize(async () => {
        const selfDir = await getSelfDir()
        const sourceMapParser = createSourceMapParser(mountedFs, resolver, bt.workingDirectory, selfDir ? [selfDir] : undefined)
        loaderContext.registerSourceMapParser(sourceMapParser)

        return sourceMapParser
    })

    const sourceMapParser = await getSourceMapParser()

    function createModuleLoader2(): ReturnType<SessionContext['createModuleLoader']> {
        const dataDir = repo.getDataDir()
        const codeCache = createCodeCache(fs, getV8CacheDirectory())

        const loader = createModuleLoader(
            mountedFs, 
            dataDir,
            resolver,
            {
                sourceMapParser,
                workingDirectory: bt.workingDirectory,
                codeCache,
                deserializer: resolveValue,
                dataRepository: createBasicDataRepo(repo),
            }            
        )

        async function loadModule(id: string, origin?: string) {
            if (isDataPointer(id)) {
                await registerPointerDependencies(id)
            }

            return loader(origin, loaderContext.ctx)(id)
        }

        return {
            loadModule,
            registerMapping: resolver.registerMapping,
            runWithContext: async <T>(namedContexts: Record<string, any>, fn: () => Promise<T> | T) => {
                return loaderContext.runWithNamedContexts(namedContexts, fn)
            },
        }
    }

    return createModuleLoader2()
}

// TODO: this isn't clean
async function maybeLoadEnvironmentVariables(fs: Pick<Fs, 'readFile'>) {
    const filePath = getCurrentEnvFilePath()
    getLogger().debug(`Trying to load environment variables from "${filePath}"`)

    const text = await fs.readFile(filePath, 'utf-8').catch(throwIfNotFileNotFoundError)
    if (!text) {
        return
    }

    const vars = parseEnvFile(text)
    for (const [k, v] of Object.entries(vars)) {
        process.env[k] = v
    }

    getLogger().debug(`Loaded environment variables: ${Object.keys(vars)}`)
}

export async function createSessionContext(programHash?: string): Promise<SessionContext> {
    const bt = getBuildTargetOrThrow()
    const deploymentId = await getOrCreateDeployment()
    const repo = getDataRepository()

    const resolvedProgramHash = programHash ?? (await repo.getHead(bt.programId))!.storeHash
    const tmpMountedFs = createTempMountedFs((await repo.getBuildFs(resolvedProgramHash)).index, bt.workingDirectory)

    const fs = tmpMountedFs
    const terraformPath = await getTerraformPath()
    const templateService = createTemplateService(fs, programHash)

    const workingDirectory = bt.workingDirectory

    function createModuleResolver2() {
        return createModuleResolverForBundling(fs, workingDirectory)
    }

    const resolver = createModuleResolver2()
    const auth = getAuth()
    const backendClient = getBackendClient()

    function createConsoleWrap() {
        const logEvent = getLogger().emitDeployLogEvent
        const logMethods = {
            log: (...args: any[]) => logEvent({ level: 'info', args, resource: loaderContext.getContext('resource') }),
            warn: (...args: any[]) => logEvent({ level: 'warn', args, resource: loaderContext.getContext('resource') }),
            error: (...args: any[]) => logEvent({ level: 'error', args, resource: loaderContext.getContext('resource') }),
            debug: (...args: any[]) => logEvent({ level: 'debug', args, resource: loaderContext.getContext('resource') }),
            trace: (...args: any[]) => logEvent({ level: 'trace', args, resource: loaderContext.getContext('resource') }),
        }
        
        return wrapWithProxy(globalThis.console, logMethods)
    }

    const consoleWrap = createConsoleWrap()
    const loaderContext = createContext({ deploymentId: deploymentId, programId: bt.programId }, backendClient, auth, consoleWrap)

    const getSourceMapParser = memoize(async () => {
        const selfDir = await getSelfDir()
        const sourceMapParser = createSourceMapParser(fs, resolver, workingDirectory, selfDir ? [selfDir] : undefined)
        loaderContext.registerSourceMapParser(sourceMapParser)

        return sourceMapParser
    })

    // XXX: only used for `internal/apps/github` atm
    await maybeLoadEnvironmentVariables(fs)

    const env = {
        SYNAPSE_ENV: bt.environmentName,
        ...(await templateService.getSecretBindings())
    }

    const sourceMapParser = await getSourceMapParser()

    const pkgService = await createPackageService(resolver, repo, programHash ? await toFsFromHash(programHash) : undefined)
    const { stores, importMap } = await pkgService.loadIndex()
    const mountedFs = await createMountedFs(deploymentId, workingDirectory, stores)
    tmpMountedFs.addMounts(stores)

    function createModuleLoader2(): ReturnType<SessionContext['createModuleLoader']> {
        const dataDir = repo.getDataDir()
        const codeCache = createCodeCache(fs, getV8CacheDirectory())

        const loader = createModuleLoader(
            mountedFs, 
            dataDir,
            resolver,
            {
                env,
                sourceMapParser,
                workingDirectory,
                codeCache,
                deserializer: resolveValue,
                dataRepository: createBasicDataRepo(repo),
            }            
        )

        async function loadModule(id: string, origin?: string) {
            if (isDataPointer(id)) {
                await pkgService.registerPointerDependencies(id)
            }

            return loader(origin, loaderContext.ctx)(id)
        }

        return {
            loadModule,
            registerMapping: resolver.registerMapping,
            runWithContext: async <T>(namedContexts: Record<string, any>, fn: () => Promise<T> | T) => {
                return loaderContext.runWithNamedContexts(namedContexts, fn)
            },
        }
    }

    const packageManifest = importMap ? importMapToManifest(importMap) : undefined

    return {
        dataDir: repo.getDataDir(),
        packageManifest: packageManifest ?? { roots: {}, dependencies: {}, packages: {} },
        packageService: pkgService,
        buildTarget: { ...bt, deploymentId: deploymentId, programHash },
        templateService,
        terraformPath,
        fs: mountedFs,
        processStore: getDeploymentStore(deploymentId, repo),
        backendClient,
        createModuleResolver: () => resolver,
        createModuleLoader: createModuleLoader2,
        createZip,
    }
} 

const sessions = new Map<string, ReturnType<typeof createSession>>()

export async function createSession(ctx: SessionContext, opt?: DeployOptions) {
    // These options need to be added when starting the session. They have no effect otherwise.
    const args: string[] = ['-auto-approve', '-refresh=false']
    if (opt?.parallelism) {
        args.push(`-parallelism=${opt.parallelism}`)
    }

    const programHash = ctx.buildTarget.programHash ?? await getProgramHash()
    if (!programHash) {
        throw new Error(`Missing program hash from build target: ${JSON.stringify(ctx.buildTarget, undefined, 4)}`)
    }

    const session = await startTerraformSession(ctx, args, opt)
    const moduleLoader = ctx.createModuleLoader()

    let state: TfState | undefined
    let persister: ReturnType<typeof createStatePersister> | undefined
    async function loadState(noSave = opt?.noSave ?? false) {
        await persister?.dispose()
        persister = undefined

        state = await readState()
        if (state) {
            const stateDest = path.resolve(getDeploymentBuildDirectory(ctx.buildTarget), 'state.json')
            await getFs().writeFile(stateDest, JSON.stringify(state))
            try {
                await session.setState(stateDest)
            } finally {
                await getFs().deleteFile(stateDest)
            }

            //await getServiceRegistry().loadFromState(ctx, state)
        }

        if (!noSave) {
            ensurePersister()
        }

        return state
    }

    // await loadState()

    let templateHash: string
    let optionsHash: string
    async function shouldRun(opt?: DeployOptions) {
        const currentTemplateHash = await ctx.templateService.getTemplateHash()
        
        const currentOptionsHash = getHash(JSON.stringify({ ...opt }), 'base64url')
        if ((optionsHash && currentOptionsHash === optionsHash) && (templateHash && templateHash === currentTemplateHash)) {
            return false
        }

        if (templateHash && templateHash !== currentTemplateHash) {
            await session.reloadConfig()
            // await loadState()
        }

        templateHash = currentTemplateHash
        optionsHash = currentOptionsHash

        return true
    }

    const loadStateOnce = memoize(loadState)

    function ensurePersister() {
        persister ??= createStatePersister(state, programHash!)
    }

    async function finalizeState() {
        const newState = await session.getState()
        newState.lineage = persister?.getLineage() ?? newState.lineage
        newState.serial = persister?.getNextSerial() ?? (newState.serial + 1)
        await persister?.dispose()
        persister = undefined

        return state = newState
    }

    async function apply(opt?: DeployOptions) {
        await loadStateOnce()

        let error: Error | undefined
        if (await shouldRun(opt)) {
            ensurePersister()
            error = await session.apply(opt).catch(e => e)

            return {
                error,
                state: await finalizeState(),
            }
        } else {
            if (!state) {
                throw new Error(`Missing state`)
            }

            getLogger().log('No changes detected, skipping apply')
            // XXX: emit a stub plan to appease UI
            getLogger().emitPlanEvent({ plan: {} })

            return { state }
        }
    }

    async function destroy(opt?: DeployOptions) {
        await loadStateOnce()
        ensurePersister()
        const error = await session.destroy(opt).catch(e => e)

        return {
            error,
            state: await finalizeState(),
        }
    }

    async function plan(opt?: DeployOptions) {
        const state = await loadStateOnce()
        const p = await session.plan(opt)
        const resources: Record<string, any> = {}
        if (state?.resources) {
            for (const r of state?.resources) {
                const key = `${r.type}.${r.name}`
                resources[key] = mapResource(r)?.state
            }    
        }

        return parsePlan(p, resources)
    }


    async function _dispose() {
        getLogger().log('Shutting down session', ctx.buildTarget.deploymentId!)
        sessions.delete(ctx.buildTarget.deploymentId!)
        await session.dispose()
        await persister?.dispose()
    }

    const dispose = memoize(_dispose)

    const lock = createRwMutex()
    function wrapWithLock<T, U extends any[]>(fn: (...args: U) => Promise<T> | T): (...args: U) => Promise<T> {
        return async (...args) => {
            const l = await lock.lockWrite()
        
            try {
                return await fn.apply(undefined, args)
            } finally {
                l.dispose()
            }
        }
    }

    async function setTemplate(template: TfJson) {
        await ctx.templateService.setTemplate(template)
        await session.reloadConfig()
    }

    async function getState() {
        await loadStateOnce()

        return state
    }

    return {
        plan,
        apply: wrapWithLock(apply),
        destroy: wrapWithLock(destroy),
        dispose: wrapWithLock(dispose),
        getState,
        getRefs: session.getRefs,
        setTemplate,
        templateService: ctx.templateService,
        moduleLoader,
    }
}

export function getSession(deploymentId: string, ctx?: SessionContext, opt?: DeployOptions) {
    if (sessions.has(deploymentId)) {
        return sessions.get(deploymentId)!
    }

    async function createWithCtx() {
        return createSession(ctx ?? await createSessionContext(), opt)
    }

    const session = createWithCtx()
    sessions.set(deploymentId, session)

    return session
}

export async function shutdownSessions() {
    for (const [key, session] of sessions.entries()) {
        const s = await session
        await s.dispose()
        sessions.delete(key)
    }
}

