import { Bucket } from 'synapse:srl/storage'

const bucket = new Bucket()

export function createBucketClient() {
    function get(key: string) {
        return bucket.get(key, 'utf-8')
    }

    function put(key: string, data: string) {
        return bucket.put(key, data)
    }

    return { get, put }
}
