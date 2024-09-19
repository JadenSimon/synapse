import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn, ChildProcess } from 'node:child_process'

let shouldUseShell_: boolean | undefined
function shouldUseShell(name: string) {
    if (name !== 'synapse' || !process.env['SYNAPSE_INSTALL']) {
        return false
    }

    return shouldUseShell_ ??= fs.existsSync(path.resolve(process.env['SYNAPSE_INSTALL'], 'bin', 'synapse.cmd'))
}

export async function runCommandPipedInput(name: string, args: string[], input: string | Buffer | ArrayBufferLike, cwd?: string, env?: Record<string, string | undefined>) {
    const p = spawn(name, args, { stdio: ['pipe', 'inherit', 'inherit'], cwd, env })
    const promise = toPromise(p)
    await new Promise<void>((resolve, reject) => {
        if (!p.stdin) {
            p.kill()
            return reject(new Error(`Missing stdin`))
        }
        
        promise.catch(reject)
        p.stdin.write(input, err => {
            if (err) {
                p.kill()
                return reject(err)
            }

            p.stdin!.end(resolve)
        })
    })

    return promise
}

export function runCommand(name: string, args: string[], cwd?: string, env?: Record<string, string | undefined>) {
    const shell = shouldUseShell(name)
    const p = spawn(name, args, { stdio: 'inherit', cwd, shell, env })

    return toPromise(p)
}

export function runCommandPiped(name: string, args: string[], cwd?: string) {
    const p = spawn(name, args, { stdio: 'pipe', cwd })

    return toPromise(p, 'utf-8').then(s => s.stdout as string)
}

function toPromise(proc: ChildProcess, encoding: BufferEncoding = 'utf-8') {
    const stdout: any[] = []
    const stderr: any[] = []
    proc.stdout?.on('data', chunk => stdout.push(chunk))
    proc.stderr?.on('data', chunk => console.warn(chunk))

    function getResult(chunks: any[]) {
        const buf = Buffer.concat(chunks)

        return encoding ? buf.toString(encoding) : buf
    }

    const p = new Promise<{ stdout: string | Buffer; stderr: string | Buffer}>((resolve, reject) => {
        proc.on('error', reject)
        proc.on('close', (code, signal) => {
            if (code !== 0) {
                const err = Object.assign(
                    new Error(`Non-zero exit code: ${code} [signal ${signal}]`), 
                    { code, stdout: getResult(stdout), stderr: getResult(stderr) }
                )

                reject(err)
            } else {
                resolve({ stdout: getResult(stdout), stderr: getResult(stderr) })
            }
        })
    })

    return p
}
