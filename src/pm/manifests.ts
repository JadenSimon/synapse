import * as path from 'node:path'
import { PackageJson } from './packageJson'
import { keyedMemoize, memoize } from '../utils'
import { getGlobalCacheDirectory } from '../workspaces'
import { createMemento } from '../utils/memento'
import { getFs } from '../execution'
import { createRequester } from '../utils/http'
import { getLogger } from '..'
import { NpmConfig, resolveNpmConfigs } from './compat'

type NpmKeyId = `SHA256:${string}`
export interface PublishedPackageJson extends PackageJson {
    dist: {
        integrity: string
        fileCount?: number
        unpackedSize?: number // bytes
        tarball: string // URL
        // `sig` is generated by signing `${package.name}@${package.version}:${package.dist.integrity}`
        signatures?: { keyid: NpmKeyId; sig: string }[]

        // Synapse only
        isStubPackage?: boolean
        isSynapsePackage?: boolean
    }
}

export interface PackageManifest {
    name: string
    versions: Record<string, PublishedPackageJson>
    'dist-tags'?: Record<string, string>
}

interface NpmKeysResponse {
    readonly keys: {
        expires: null | string // ISO 8601
        keyid: NpmKeyId
        keytype: string // ecdsa-sha2-nistp256
        scheme: string // ecdsa-sha2-nistp256
        key: string // base64 encoded public key
    }[]
}

export interface OptimizedPackageManifest {
    readonly symbolTable: string[]
    readonly tags?: Record<string, string>
    readonly versions: Record<string, OptimizedPublishedPackageJson>
}

interface OptimizedPublishedPackageJson {
    readonly dist: PublishedPackageJson['dist']
    readonly os?: PublishedPackageJson['os']
    readonly cpu?: PublishedPackageJson['cpu']
    readonly dependencies?: PublishedPackageJson['dependencies']
    readonly peerDependencies?: PublishedPackageJson['peerDependencies']
    readonly optionalDependencies?: PublishedPackageJson['optionalDependencies']
    readonly peerDependenciesMeta?: PublishedPackageJson['peerDependenciesMeta']
}


function createKeyDeduper(symbols = new Map<string, string>()) {
    function getId(k: string) {
        const id = symbols.get(k)
        if (id !== undefined) {
            return id
        }

        const newId = `${symbols.size}`
        symbols.set(k, newId)

        return newId
    }

    function dedupe(obj: any): any {
        if (Array.isArray(obj)) {
            return obj.map(dedupe)
        }

        if (typeof obj !== 'object' || !obj) {
            return obj
        }

        const res: any = {}
        for (const [k, v] of Object.entries(obj)) {
            res[getId(k)] = dedupe(v)
        }

        return res
    }

    function getSymbolTable() {
        return [...symbols.entries()].sort((a, b) => Number(a[1]) - Number(b[1])).map(a => a[0])
    }

    return { dedupe, redupe: decodedWithTable, getSymbolTable }
}

function decodedWithTable(obj: any, symbolTable: string[]) {
    function getKey(id: string) {
        const n = Number(id)
        if (isNaN(n)) {
            throw new Error(`Not an entry: ${id}`)
        }

        const k = symbolTable[n]
        if (k === undefined) {
            throw new Error(`Missing key at index: ${n}`)
        }

        return k
    }

    function decode(obj: any): any {
        if (Array.isArray(obj)) {
            return obj.map(decode)
        }

        if (typeof obj !== 'object' || !obj) {
            return obj
        }

        const res: any = {}
        for (const [k, v] of Object.entries(obj)) {
            res[getKey(k)] = decode(v)
        }

        return res
    }

    return decode(obj)
}

// De-dupes and strips out unneeded things
function optimizePackageManfiest(manifest: PackageManifest): OptimizedPackageManifest {
    const deduper = createKeyDeduper()
    const versions: Record<string, OptimizedPublishedPackageJson> = {}
    for (const [k, v] of Object.entries(manifest.versions)) {
        const opt = optimizePublishedPackageJson(v)
        versions[k] = deduper.dedupe(opt)
    }

    return {
        versions,
        tags: manifest['dist-tags'],
        symbolTable: deduper.getSymbolTable(),
    }
}

function hydratePackageJson(name: string, symbolTable: string[], pkgJson: OptimizedPublishedPackageJson) {
    const c = decodedWithTable(pkgJson, symbolTable)
    c.name = name

    return c
}

// TODO: use wyhash for this
// function createRecordHasher() {
//     const hashes = new Map<string, Buffer>()

//     function getStringHash(s: string) {
//         const h = hashes.get(s)
//         if (h) {
//             return h
//         }

//         const h2 = createHash('sha256').update(s).digest()
//         hashes.set(s, h2)

//         return h2
//     }

//     function combineHash(a: Buffer, b: Buffer) {
//         const c = Buffer.allocUnsafe(a.byteLength)
//         for (let i = 0; i < a.byteLength; i += 4) {
//             c.writeUint32LE((a.readUint32LE(i) * 3) + b.readUInt32LE(i), i)
//         }
//         return c
//     }

//     function getHash(obj: Record<string, string>) {
//         // const entries = Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0]))
//         // We don't sort because we will XOR the KV pairs
//         const entries = Object.entries(obj)
//         const z = entries.map(([k, v]) => combineHash(getStringHash(k), getStringHash(v)))
//         const c = z[0]
//         for (let j = 0; j < c.byteLength; j++) {
//             let x = c.readUint32LE(j)
//             for (let i = 1; i < z.length; i++) {
//                 x ^= z[i].readUint32LE(j)
//             }
//             c.writeUint32LE(x, j)
//         }

//         return c
//     }

//     return { getHash }
// }

function optimizePublishedPackageJson(pkgJson: PublishedPackageJson): OptimizedPublishedPackageJson {
    return {
        dist: pkgJson.dist,
        os: pkgJson.os,
        cpu: pkgJson.cpu,
        dependencies: pkgJson.dependencies,
        peerDependencies: pkgJson.peerDependencies,
        optionalDependencies: pkgJson.optionalDependencies,
        peerDependenciesMeta: pkgJson.peerDependenciesMeta,
    }
}

function createManifestCache(registry: string) {
    const dir = path.resolve(getGlobalCacheDirectory(), 'package-manifests', registry)
    const memento = createMemento(getFs(), dir)

    return memento
}

const getManifestCache = keyedMemoize(createManifestCache)

export function createManifestRepo(client = createNpmRegistryClient(), manifestCache = getManifestCache('npm')) {
    const manifestAbortController = new AbortController()

    const events = require('node:events') as typeof import('node:events')
    events.setMaxListeners(50, manifestAbortController.signal)

    const cancelError = new Error('Cancelled')
    function cancelManifestRequests() {
        manifestAbortController.abort(cancelError)
    }

    // Decent amount of time is still spent parsing JSON
    const manifests = new Map<string, Promise<PackageManifest | OptimizedPackageManifest | undefined | void> | OptimizedPackageManifest>()
    async function _getCachedManifest(name: string) {
        const cached = await manifestCache.get<PackageManifest | OptimizedPackageManifest>(name).catch(async e => {
            if ((e as any).name !== 'SyntaxError') {
                throw e
            }

            getLogger().debug(`Removing corrupted cached manifest: ${name}`, e)
            await manifestCache.delete(name)
        })

        return cached
    }

    function getCachedManifest(name: string) {
        if (manifests.has(name)) {
            return manifests.get(name)!
        }

        const cached = _getCachedManifest(name)
        manifests.set(name, cached)

        return cached
    }

    function setCachedManifest(name: string, manifest: PackageManifest) {
        const opt = optimizePackageManfiest(manifest)
        manifests.set(name, opt)
        return manifestCache.set(name, opt)
    }

    async function _getPackageJson(name: string, version: string): Promise<PublishedPackageJson> {
        // We don't need to fetch the entire manifest if we already
        // have the requested version
        const cached = await getCachedManifest(name)
        const cachedPkgData = cached?.versions[version]
        if (cachedPkgData) {
            if ('symbolTable' in cached) {
                return hydratePackageJson(name, cached.symbolTable, cachedPkgData)
            }
    
            return cachedPkgData as PublishedPackageJson
        }

        const m = await getPackageManifest(name)
        const pkgData = m.versions[version]
        if (!pkgData) {
            throw new Error(`Package not found: ${name}@${version}`)
        }

        if ('symbolTable' in m) {
            return hydratePackageJson(name, m.symbolTable, pkgData)
        }

        return pkgData as PublishedPackageJson
    }

    const getPackageJson = keyedMemoize(async (name: string, version: string) => {
        const pkg = await _getPackageJson(name, version)
        if (!pkg) {
            throw new Error(`Package not found: ${name}@${version}`)
        }
        return pkg
    })

    interface ETagManifest {
        [name: string]: {
            eTag?: string
            requestCacheExpirationTime?: number
        }
    }

    const etagsKey = '__etags__'
    const getEtags = memoize(async function () {
        return (await manifestCache.get<ETagManifest>(etagsKey)) ?? {}
    })

    async function setEtag(name: string, value: string, maxAge?: number) {
        const tags = await getEtags()
        const paddedMaxAge = (maxAge ?? 0) + 300 // We'll cache for just a little bit longer
        tags[name] = {
            eTag: value,
            requestCacheExpirationTime: Date.now() + (paddedMaxAge * 1000),
        }
    }

    async function close() {
        cancelManifestRequests()
        const tags = await getEtags()
        await manifestCache.set(etagsKey, tags)
    }

    async function _getPackageManifest(name: string) {
        const etags = await getEtags()
        const cacheTime = etags[name]?.requestCacheExpirationTime
        if (cacheTime && Date.now() <= cacheTime) {
            const cached = await getCachedManifest(name)
            if (cached) {
                return cached
            }
        }

        let resp = await client.getPackageManifest(name, etags[name]?.eTag, manifestAbortController)
        if (!resp.manifest) {
            const cached = await getCachedManifest(name)
            if (cached) {
                if (resp.maxAge) {
                    await setEtag(name, etags[name]!.eTag!, resp.maxAge)
                }

                return cached
            }

            resp = (await client.getPackageManifest(name, undefined, manifestAbortController))
        }

        if (!resp.manifest) {
            throw new Error(`Missing manifest from package registry response. Package name: ${name}`)
        }

        // I've seen this happen once or twice
        if (!resp.manifest.versions) {
            throw new Error(`Corrupted package manifest for package "${name}": ${JSON.stringify(resp.manifest, undefined, 4)}`)
        }

        if (resp.etag) {
            await setEtag(name, resp.etag, resp.maxAge)
        }
    
        await setCachedManifest(name, resp.manifest)

        return resp.manifest
    }

    const getPackageManifest = keyedMemoize(_getPackageManifest)

    async function listVersions(name: string) {
        const m = await getPackageManifest(name)

        return Object.keys(m.versions)
    }

    async function listTags(name: string) {
        const m = await getPackageManifest(name)
        const tags = 'symbolTable' in m ? m.tags : m['dist-tags']

        return tags
    }

    return {
        close,
        listTags,
        listVersions,
        getPackageJson,

        cancelError,
        getPackageManifest,
    }
}

const npmUrl = 'https://registry.npmjs.org/'
const jsrUrl = 'https://npm.jsr.io'

// TODO: add direct support for JSR (if people want it)
// Honestly I'm not so sure about JSR. Looks like they're reinventing the wheel...
//
// https://jsr.io/@<scope>/<package-name>/<version>/<path>
// https://jsr.io/@<scope>/<package-name>/meta.json
// https://jsr.io/@<scope>/<package-name>/<version>_meta.json


// https://registry.npmjs.org/@aws-sdk/client-s3

type RegistryClient = ReturnType<typeof createNpmRegistryClient>
export function createNpmRegistryClient(registryUrl = npmUrl, authToken?: string) {
    const request = createRequester(registryUrl)

    function getHeaders() {
        return { 'authorization': `Bearer ${Buffer.from(authToken!).toString('base64')}` }
    }

    async function getPackageManifest(name: string, etag?: string, abortController?: AbortController): Promise<{ etag?: string; manifest?: PackageManifest; maxAge?: number } > {
        const opt: any = { etag, acceptGzip: true, abortController, headers: authToken ? getHeaders() : undefined }
        const res = await request(`GET /${name}`, undefined, undefined, opt)

        return { etag: opt.etag, manifest: res, maxAge: opt.maxAge }
    }

    async function downloadPackage(tarballUrl: string): Promise<Buffer> {
        return request(`GET ${tarballUrl}`, undefined, true, { headers: authToken ? getHeaders() : undefined  })
    }

    async function getSigningKeys(): Promise<NpmKeysResponse> {
        return request(`GET /-/npm/v1/keys`, undefined, undefined, { headers: authToken ? getHeaders() : undefined  })
    }

    return { getPackageManifest, downloadPackage }
}

function getUrl(packageName: string, config: NpmConfig): string {
    if (!packageName.startsWith('@')) {
        return npmUrl
    }

    const [scope] = packageName.split('/')

    return config.registries[scope] ?? npmUrl
}

// TODO: make caching work with multiple registries (manifests + packages)
export function createMultiRegistryClient(dir: string): RegistryClient {
    const clients = new Map<string, RegistryClient>()
    
    const getConfig = memoize(() => resolveNpmConfigs(dir))


    function getOrCreateClient(url: string, config: NpmConfig | undefined) {
        const client = clients.get(url)
        if (client) {
            return client
        }

        const hostname = url.replace(/^https?:\/\//, '')
        const newClient = createNpmRegistryClient(url, config?.scopedConfig[hostname]?._authToken)
        clients.set(url, newClient)

        return newClient
    }

    async function getPackageManifest(name: string, etag?: string, abortController?: AbortController) {
        const config = await getConfig()
        const url = !config ? npmUrl : getUrl(name, config)

        return getOrCreateClient(url, config).getPackageManifest(name, etag, abortController)
    }

    const getUrls = memoize(async () => {
        const config = await getConfig()
        const set = new Set<string>([npmUrl])
        for (const k of Object.keys(config?.registries ?? {})) {
            set.add(k)
        }
        for (const k of Object.keys(config?.scopedConfig ?? {})) {
            set.add(`https://${k}`)
        }
        return set
    })

    async function findClient(tarballUrl: string) {
        const config = await getConfig()
        for (const k of await getUrls()) {
            if (tarballUrl.startsWith(k)) {
                return getOrCreateClient(k, config)
            }
        }
        return getOrCreateClient(npmUrl, config)
    }

    async function downloadPackage(tarballUrl: string) {
        const client = await findClient(tarballUrl)

        return client.downloadPackage(tarballUrl)
    }

    return { getPackageManifest, downloadPackage }
}

const algs = ['sha256', 'sha512'] as const
type Alg = (typeof algs)[number]

export function assertAlg(s: string): asserts s is Alg {
    if (!algs.includes(s as any)) {
        throw new Error(`Invalid algorithm "${s}". Must be one of: ${algs.join(', ')}`)
    }
}

interface GetPackageDataResponse {
    readonly data: Buffer
    readonly format: '.tar.gz'
    readonly checksum: {
        readonly alg: Alg
        readonly value: string
    }
}

interface GetPackageSignatureResponse {

}

// function parseIntegrityString(integrity: string): GetPackageDataResponse['checksum'] {
//     const match = integrity.match(/^([^-]+)-([^-]+)$/)
//     if (!match) {
//         throw new Error(`Failed to parse integrity string: ${integrity}`)
//     }

//     const [_, alg, value] = match
//     assertAlg(alg)

//     return { alg, value }
// }