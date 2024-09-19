import { Function } from 'synapse:srl/compute'
import { expect } from 'synapse:test'

new Function(() => { expect(1 == 1) })
new Function(() => { expect(2 == 2) })
new Function(() => { expect(3 == 3) })
new Function(() => { expect(4 == 4) })
new Function(() => { expect(5 == 5) })
