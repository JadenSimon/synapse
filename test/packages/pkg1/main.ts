import * as fs from 'node:fs/promises'
import { defineResource } from 'synapse:core'

class File extends defineResource({
    create: async (fileName: string) => {
        const text = await fs.readFile(fileName, 'utf-8')

        return { text }
    }
}) {}

export const self = new File(__filename)
export const environment = process.env.SYNAPSE_ENV