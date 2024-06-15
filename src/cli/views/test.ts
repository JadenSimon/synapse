import { getLogger } from '../..'
import { DeployLogEvent, FailedTestEvent, TestEvent, TestLogEvent } from '../../logging'
import { colorize, format, printLine } from '../ui'
import * as nodeUtil from 'node:util'

// We should output the filename for each suite/test
export function createTestView() {
    const startTimes = new Map<number, Date>()
    function getDuration(id: number, endTime: Date) {
        const startTime = startTimes.get(id)
        if (!startTime) {
            return
        }

        const dur = endTime.getTime() - startTime.getTime()

        return dur < 5 ? 0 : dur
    }

    const indentLevel = new Map<number, number>()
    function getIndent(ev: TestEvent) {
        if (ev.parentId === undefined) {
            indentLevel.set(ev.id, 0)

            return ''
        }

        const parentIndent = indentLevel.get(ev.parentId) ?? -1
        const indent = parentIndent + 1
        indentLevel.set(ev.id, indent)

        return '  '.repeat(indent)
    }

    const l = getLogger().onTest(ev => {
        // TODO: dynamically show # of tests pending when in tty
        if (ev.status === 'pending') {
            return
        }

        if (ev.status === 'running') {
            if (ev.itemType === 'suite') {
                printLine(`${getIndent(ev)}- ${ev.name}`)
            }

            return startTimes.set(ev.id, ev.timestamp)
        }

        if (ev.itemType === 'suite') {
            return
        }

        const duration = ev.status === 'passed' || ev.status === 'failed'
            ? getDuration(ev.id, new Date())
            : undefined

        const durationText = duration ? colorize('gray', ` (${duration}ms)`) : ''

        // We assume that test events come in sequentially
        if (ev.status === 'passed') {
            printLine(getIndent(ev) + colorize('green', `${ev.name}${durationText}`))
        } else {
            printLine(getIndent(ev) + colorize('red', `${ev.name}${durationText}`))
        }
    })

    function showFailures(failures: FailedTestEvent[]) {
        for (const ev of failures) {
            // XXX: don't show test suite failures caused by a child test failing
            if (failures.find(x => x.parentId === ev.id)) {
                continue
            }

            printLine('\n')
            printLine(
                colorize('red', `[FAILED] ${ev.name}`), 
                nodeUtil.formatWithOptions({ colors: process.stdout.isTTY }, ev.reason)
            )
        }
    }

    const testLogs: (TestLogEvent | DeployLogEvent)[] = []

    // getLogger().onTestLog(ev => testLogs.push(ev))
    // TODO: tests always emit deploy logs atm
    // This is OK because we can get the test id from the resource id
    getLogger().onDeployLog(ev => testLogs.push(ev))

    function dispose() {
        l.dispose()
        if (testLogs.length > 0) {
            printLine()
            printLine('Test logs:')
            for (const ev of testLogs) {
                printLine(`    ${format(...ev.args)}`)
            }
        }
    }

    return {
        showFailures,
        dispose,
    }
}