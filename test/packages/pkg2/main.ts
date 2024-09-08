import * as pkg1 from 'pkg1'
import { test, expectEqual } from 'synapse:test'

test('line count', () => {
    expectEqual(pkg1.self.text.split('\n').length, 13)
})