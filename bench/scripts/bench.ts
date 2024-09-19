import * as path from 'node:path'
import { runCommand } from "./util"

export async function main() {
    const synapseCmd = process.env.SYNAPSE_CMD || 'synapse'
    const totalRuns = 25
    const cwd = path.resolve(process.cwd())
    await runCommand(synapseCmd, ['compile', '--target', 'aws'], cwd)

    let total = 0
    for (let i = 0; i < totalRuns; i++) {
        await runCommand(synapseCmd, ['clear-cache', 'compile'], cwd)
        const start = performance.now()
        await runCommand(synapseCmd, ['compile', '--target', 'aws'], cwd)
        const duration = (performance.now() - start)
        console.log(`Took ${Math.round(duration)}ms`)
        total += duration
    }

    const result = Math.round(total / totalRuns)
    console.log(`Average duration: ${result}ms`)
}

