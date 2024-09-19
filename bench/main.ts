import { Function } from 'synapse:srl/compute'
import { expect } from 'synapse:test'

for (let i = 0; i < 50; i++) {
    new Function(() => { expect(i == i) })
}
