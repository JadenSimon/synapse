import { test, expectEqual } from 'synapse:test'
import { createBucketClient } from 'pkg'

const client = createBucketClient()
const get = client.get
const put = client.put

// `get` and `put` will fail to serialize if `pkg` doesn't export its pointers correctly
test('put and get', async () => {
    await put('foo', 'bar')
    expectEqual(await get('foo'), 'bar')
})

// !commands
// (cd pkg && synapse deploy && synapse publish --archive out/pkg.tgz)
// synapse add pkg/out/pkg.tgz
// synapse test
