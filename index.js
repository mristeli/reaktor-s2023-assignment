import { XMLParser } from 'fast-xml-parser'
import http from 'http'
import fs from 'fs'

let https
try {
    https = await import('node:https')
} catch (err) {
    console.error('https support is disabled!')
    process.exitCode = 1;
    process.exit()
}

const extractDroneInfo = (parsedXml) => {
    const infoExtractor = (timestamp) => ({ serialNumber, positionX, positionY }) => ({
        serialNumber, position: { positionX, positionY }, timestamp
    })
    if (parsedXml?.report?.capture?.drone) {
        const { attr_snapshotTimestamp } = parsedXml.report.capture
        return parsedXml.report.capture.drone.map(infoExtractor(Date.parse(attr_snapshotTimestamp)))
    }
    return []
}

const distance = (x1, y1, x2, y2) => {
    const diffX = x1 - x2, diffY = y1 - y2
    return Math.sqrt(diffX*diffX + diffY*diffY)
}
const distanceToNest = (x, y) => distance(250000, 250000, x, y)

const isInCircle = (originX, originY, radius) => {
    return (droneInfo) => {
        const { positionX, positionY } = droneInfo.position
        return distance(originX, originY, positionX, positionY) < radius
    }
}
const isInNoDroneZone = isInCircle(250000, 250000, 100000)

let badBehavingPilots = [] // entries: name, email, drones, minDistance

const findPilotByDrone = (serialNumber) => {
    return badBehavingPilots.find(({ drones }) => drones.includes(serialNumber))
}

const min = (a, b) => a > b ? b : a
const updatePilotInfo = (pilot, droneInfo) => {
    const { serialNumber, position, timestamp } = droneInfo
    const currentDistanceToNest = distanceToNest(position.positionX, position.positionY)
    badBehavingPilots = badBehavingPilots.map((elem) =>
        elem.pilotId === pilot.pilotId
            ? {
                ...pilot,
                timestamp,
                drones: pilot.drones.includes(serialNumber)
                    ? pilot.drones
                    : [...pilot.drones, serialNumber],
                minDistanceToNest: min(pilot.minDistanceToNest, currentDistanceToNest)
            }
            : elem
    )
}

const addNewPilot = (pilotInfo, droneInfo) => {
    const { pilotId, email, firstName, lastName, phoneNumber } = pilotInfo
    const { serialNumber, position, timestamp } = droneInfo
    const newPilotEntry = {
        pilotId,
        email,
        phoneNumber,
        timestamp,
        name: `${firstName} ${lastName}`,
        drones: [serialNumber],
        minDistanceToNest: distanceToNest(position.positionX, position.positionY)
    }
    badBehavingPilots.push(newPilotEntry)
}

const runPilotUpdate = (droneInfo) => {
    const { serialNumber } = droneInfo
    const maybePilot = findPilotByDrone(serialNumber)
    if (maybePilot) {
        updatePilotInfo(maybePilot, droneInfo)
        return
    }
    https.get(`https://assignments.reaktor.com/birdnest/pilots/${serialNumber}`,
        res => {
            const data = []
            res.on('data', d => {
                data.push(d)
            }).on('end', () => {
                const jsonString = Buffer.concat(data).toString()
                const pilotJson = JSON.parse(jsonString)
                addNewPilot(pilotJson, droneInfo)
            })
        }
    )
}

const DRONE_POLLER_INTERVAL = 500
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: 'attr_' })
const reportDronesInNDZ = () => {
    https.get('https://assignments.reaktor.com/birdnest/drones',
        res => {
            const data = []
            res.on('data', d => {
                data.push(d)
            }).on('end', () => {
                const xmlString = Buffer.concat(data).toString()
                const parsedXml = parser.parse(xmlString)
                const droneInfo = extractDroneInfo(parsedXml)
                droneInfo.filter(isInNoDroneZone).forEach(runPilotUpdate);
                setTimeout(reportDronesInNDZ, DRONE_POLLER_INTERVAL)
            })
        }
    )
}

setTimeout(reportDronesInNDZ, DRONE_POLLER_INTERVAL)

const inLastTenMin = () => {
    const tenMinInMillis = 600000, now = new Date()
    return (pilotInfo) => now - pilotInfo.timestamp < tenMinInMillis
}

const badPilots = function (req, res) {
    if (req.url === '/') {
        res.setHeader("Content-Type", "text/html")
        res.writeHead(200)
        fs.readFile('index.html', function (_err, data) {
            res.end(data)
        })
    } else {
        const pilots = badBehavingPilots
            .filter(inLastTenMin())
            .sort((a, b) => b.timestamp - a.timestamp)
        res.setHeader("Content-Type", "application/json")
        res.writeHead(200);
        res.end(JSON.stringify(pilots));
    }
}
const server = http.createServer(badPilots)
const port = 8000, host = 'localhost'
server.listen(port, host, () => {
    console.log(`Bad behaving pilots are running on http://${host}:${port}`)
})