import * as pkg1 from 'pkg1'
import { test, expectEqual } from 'synapse:test'

test('line count', () => {
    expectEqual(pkg1.self.split('\n').length, 13)
})