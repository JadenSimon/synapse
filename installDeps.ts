import * as path from 'node:path'
import * as fs from 'node:fs'
import * as child_process from 'node:child_process'
import { homedir } from 'node:os'

const getPipelineDeps = () => {
    const data = process.env.SYNAPSE_PIPELINE_DEPS
    if (!data) {
        return
    }

    return JSON.parse(data) as Record<string, string | { stepKeyHash: string; gitRef?: string; repoUrl?: string }>
}

async function installIntegrations(mapping: Record<string, string>) {
    const synapseDir = process.env['SYNAPSE_INSTALL'] || path.resolve(homedir(), '.synapse')
    const config = await fs.promises.readFile(path.resolve(synapseDir, 'config.json'), 'utf-8').then(JSON.parse)
    const overrides = config.projectOverrides

    for (const [k, v] of Object.entries(mapping)) {
        overrides[k] = v
    }

    await fs.promises.writeFile(
        path.resolve(synapseDir, 'config.json'), 
        JSON.stringify(config, undefined, 4)
    )
}

async function main() {
    const deps = getPipelineDeps()
    if (!deps) {
        console.log('no deps found')
        return
    }

    const depsDir = path.resolve('.deps')
    await fs.promises.mkdir(depsDir, { recursive: true })

    const m: Record<string, string> = {}
    for (const [k, v] of Object.entries(m)) {
        const dest = path.resolve(depsDir, `pkg-${k}.tgz`)
        const args = ['download', `runs/${v}/pkg.tgz`, dest]
        child_process.spawnSync('pipeline-fs', args, { stdio: 'inherit' })
        m[k] = dest
    }

    console.log('result', m)

    await installIntegrations(m)
}

main()

