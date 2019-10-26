import { EventEmitter } from "events"
import { describeAddress, describeTLS } from "./netUtils"
import { Writable, Readable } from "stream"
import { TLSSocket, connect as connectTLS } from "tls"
import { FTPContext, FTPResponse, TaskResolver } from "./FtpContext"
import { ProgressTracker } from "./ProgressTracker"
import { positiveIntermediate, positiveCompletion } from "./parseControlResponse"

export type UploadCommand = "STOR" | "APPE"

/**
 * Prepare a data socket using passive mode over IPv6.
 */
export async function enterPassiveModeIPv6(ftp: FTPContext): Promise<FTPResponse> {
    const res = await ftp.request("EPSV")
    const port = parseEpsvResponse(res.message)
    if (!port) {
        throw new Error("Can't parse EPSV response: " + res.message)
    }
    const controlHost = ftp.socket.remoteAddress
    if (controlHost === undefined) {
        throw new Error("Control socket is disconnected, can't get remote address.")
    }
    await connectForPassiveTransfer(controlHost, port, ftp)
    return res
}

/**
 * Parse an EPSV response. Returns only the port as in EPSV the host of the control connection is used.
 */
export function parseEpsvResponse(message: string): number {
    // Get port from EPSV response, e.g. "229 Entering Extended Passive Mode (|||6446|)"
    // Some FTP Servers such as the one on IBM i (OS/400) use ! instead of | in their EPSV response.
    const groups = message.match(/[|!]{3}(.+)[|!]/)
    if (groups === null || groups[1] === undefined) {
        throw new Error(`Can't parse response to 'EPSV': ${message}`)
    }
    const port = parseInt(groups[1], 10)
    if (Number.isNaN(port)) {
        throw new Error(`Can't parse response to 'EPSV', port is not a number: ${message}`)
    }
    return port
}

/**
 * Prepare a data socket using passive mode over IPv4.
 */
export async function enterPassiveModeIPv4(ftp: FTPContext): Promise<FTPResponse> {
    const res = await ftp.request("PASV")
    const target = parsePasvResponse(res.message)
    if (!target) {
        throw new Error("Can't parse PASV response: " + res.message)
    }
    // If the host in the PASV response has a local address while the control connection hasn't,
    // we assume a NAT issue and use the IP of the control connection as the target for the data connection.
    // We can't always perform this replacement because it's possible (although unlikely) that the FTP server
    // indeed uses a different host for data connections.
    const controlHost = ftp.socket.remoteAddress
    if (ipIsPrivateV4Address(target.host) && controlHost && !ipIsPrivateV4Address(controlHost)) {
        target.host = controlHost
    }
    await connectForPassiveTransfer(target.host, target.port, ftp)
    return res
}

/**
 * Parse a PASV response.
 */
export function parsePasvResponse(message: string): { host: string, port: number } {
    // Get host and port from PASV response, e.g. "227 Entering Passive Mode (192,168,1,100,10,229)"
    const groups = message.match(/([-\d]+,[-\d]+,[-\d]+,[-\d]+),([-\d]+),([-\d]+)/)
    if (groups === null || groups.length !== 4) {
        throw new Error(`Can't parse response to 'PASV': ${message}`)
    }
    return {
        host: groups[1].replace(/,/g, "."),
        port: (parseInt(groups[2], 10) & 255) * 256 + (parseInt(groups[3], 10) & 255)
    }
}

/**
 * Returns true if an IP is a private address according to https://tools.ietf.org/html/rfc1918#section-3.
 * This will handle IPv4-mapped IPv6 addresses correctly but return false for all other IPv6 addresses.
 *
 * @param ip  The IP as a string, e.g. "192.168.0.1"
 */
function ipIsPrivateV4Address(ip = ""): boolean {
    // Handle IPv4-mapped IPv6 addresses like ::ffff:192.168.0.1
    if (ip.startsWith("::ffff:")) {
        ip = ip.substr(7) // Strip ::ffff: prefix
    }
    const octets = ip.split(".").map(o => parseInt(o, 10))
    return octets[0] === 10                                             // 10.0.0.0 - 10.255.255.255
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)    // 172.16.0.0 - 172.31.255.255
        || (octets[0] === 192 && octets[1] === 168)                    // 192.168.0.0 - 192.168.255.255
}

export function connectForPassiveTransfer(host: string, port: number, ftp: FTPContext): Promise<void> {
    return new Promise((resolve, reject) => {
        const handleConnErr = function(err: Error) {
            err.message = "Can't open data connection in passive mode: " + err.message
            reject(err)
        }
        let socket = ftp._newSocket()
        socket.on("error", handleConnErr)
        socket.connect({ port, host, family: ftp.ipFamily }, () => {
            if (ftp.socket instanceof TLSSocket) {
                socket = connectTLS(Object.assign({}, ftp.tlsOptions, {
                    socket,
                    // Reuse the TLS session negotiated earlier when the control connection
                    // was upgraded. Servers expect this because it provides additional
                    // security: If a completely new session would be negotiated, a hacker
                    // could guess the port and connect to the new data connection before we do
                    // by just starting his/her own TLS session.
                    session: ftp.socket.getSession()
                }))
                // It's the responsibility of the transfer task to wait until the
                // TLS socket issued the event 'secureConnect'. We can't do this
                // here because some servers will start upgrading after the
                // specific transfer request has been made. List and download don't
                // have to wait for this event because the server sends whenever it
                // is ready. But for upload this has to be taken into account,
                // see the details in the upload() function below.
            }
            // Let the FTPContext listen to errors from now on, remove local handler.
            socket.removeListener("error", handleConnErr)
            ftp.dataSocket = socket
            resolve()
        })
    })
}

/**
 * Helps resolving/rejecting transfers.
 *
 * This is used internally for all FTP transfers. For example when downloading, the server might confirm
 * with "226 Transfer complete" when in fact the download on the data connection has not finished
 * yet. With all transfers we make sure that a) the result arrived and b) has been confirmed by
 * e.g. the control connection. We just don't know in which order this will happen.
 */
class TransferResolver {

    protected response: FTPResponse | undefined = undefined
    protected dataTransferDone = false

    /**
     * Instantiate a TransferResolver
     */
    constructor(readonly ftp: FTPContext, readonly progress: ProgressTracker) {}

    /**
     * Mark the beginning of a transfer.
     *
     * @param name - Name of the transfer, usually the filename.
     * @param type - Type of transfer, usually "upload" or "download".
     */
    onDataStart(name: string, type: string) {
        // Let the data socket be in charge of tracking timeouts during transfer.
        // The control socket sits idle during this time anyway and might provoke
        // a timeout unnecessarily. The control connection will take care
        // of timeouts again once data transfer is complete or failed.
        if (this.ftp.dataSocket === undefined) {
            throw new Error("Data transfer should start but there is no data connection.")
        }
        this.ftp.socket.setTimeout(0)
        this.ftp.dataSocket.setTimeout(this.ftp.timeout)
        this.progress.start(this.ftp.dataSocket, name, type)
    }

    /**
     * The data connection has finished the transfer.
     */
    onDataDone(task: TaskResolver) {
        this.progress.updateAndStop()
        // Hand-over timeout tracking back to the control connection. It's possible that
        // we don't receive the response over the control connection that the transfer is
        // done. In this case, we want to correctly associate the resulting timeout with
        // the control connection.
        this.ftp.socket.setTimeout(this.ftp.timeout)
        if (this.ftp.dataSocket) {
            this.ftp.dataSocket.setTimeout(0)
        }
        this.dataTransferDone = true
        this.tryResolve(task)
    }

    /**
     * The control connection reports the transfer as finished.
     */
    onControlDone(task: TaskResolver, response: FTPResponse) {
        this.response = response
        this.tryResolve(task)
    }

    /**
     * An error has been reported and the task should be rejected.
     */
    onError(task: TaskResolver, err: Error) {
        this.progress.updateAndStop()
        this.ftp.socket.setTimeout(this.ftp.timeout)
        this.ftp.dataSocket = undefined
        task.reject(err)
    }

    /**
     * Control connection sent an unexpected request requiring a response from our part. We
     * can't provide that (because unknown) and have to close the contrext with an error because
     * the FTP server is now caught up in a state we can't resolve.
     */
    onUnexpectedRequest(response: FTPResponse) {
        const err = new Error(`Unexpected FTP response is requesting an answer: ${response.message}`)
        this.ftp.closeWithError(err)
    }

    protected tryResolve(task: TaskResolver) {
        // To resolve, we need both control and data connection to report that the transfer is done.
        const canResolve = this.dataTransferDone && this.response !== undefined
        if (canResolve) {
            this.ftp.dataSocket = undefined
            task.resolve(this.response)
        }
    }
}

/**
 * Upload stream data as a file. For example:
 *
 * `upload(ftp, fs.createReadStream(localFilePath), remoteFilename)`
 */
export function upload(ftp: FTPContext, progress: ProgressTracker, source: Readable, command: UploadCommand, remoteFilename: string): Promise<FTPResponse> {
    const resolver = new TransferResolver(ftp, progress)
    const fullCommand = `${command} ${remoteFilename}`
    return ftp.handle(fullCommand, (res, task) => {
        if (res instanceof Error) {
            resolver.onError(task, res)
        }
        else if (res.code === 150 || res.code === 125) { // Ready to upload
            const dataSocket = ftp.dataSocket
            if (!dataSocket || !dataSocket.remoteAddress) {
                resolver.onError(task, new Error("Upload should begin but no data connection is available."))
                return
            }
            // If we are using TLS, we have to wait until the dataSocket issued
            // 'secureConnect'. If this hasn't happened yet, getCipher() returns undefined.
            const canUpload = "getCipher" in dataSocket ? dataSocket.getCipher() !== undefined : true
            onConditionOrEvent(canUpload, dataSocket, "secureConnect", () => {
                ftp.log(`Uploading to ${describeAddress(dataSocket)} (${describeTLS(dataSocket)})`)
                resolver.onDataStart(remoteFilename, "upload")
                source.pipe(dataSocket).once("finish", () => {
                    dataSocket.destroy() // Explicitly close/destroy the socket to signal the end.
                    resolver.onDataDone(task)
                })
            })
        }
        else if (positiveCompletion(res.code)) { // Transfer complete
            resolver.onControlDone(task, res)
        }
        else if (positiveIntermediate(res.code)) {
            resolver.onUnexpectedRequest(res)
        }
        // Ignore all other positive preliminary response codes (< 200)
    })
}

/**
 * Download data from the data connection. Used for downloading files and directory listings.
 */
export function download(ftp: FTPContext, progress: ProgressTracker, destination: Writable, command: string, remoteFilename = ""): Promise<FTPResponse> {
    if (!ftp.dataSocket) {
        throw new Error("Download will be initiated but no data connection is available.")
    }
    // It's possible that data transmission begins before the control socket
    // receives the announcement. Start listening for data immediately.
    ftp.dataSocket.pipe(destination)
    const resolver = new TransferResolver(ftp, progress)
    return ftp.handle(command, (res, task) => {
        if (res instanceof Error) {
            resolver.onError(task, res)
        }
        else if (res.code === 150 || res.code === 125) { // Ready to download
            const dataSocket = ftp.dataSocket
            if (!dataSocket || !dataSocket.remoteAddress) {
                resolver.onError(task, new Error("Download should begin but no data connection is available."))
                return
            }
            ftp.log(`Downloading from ${describeAddress(dataSocket)} (${describeTLS(dataSocket)})`)
            resolver.onDataStart(remoteFilename, "download")
            // Confirm the transfer as soon as the data socket transmission ended.
            // It's possible, though, that the data transmission is complete before
            // the control socket receives the accouncement that it will begin.
            // Check if the data socket is not already closed.
            onConditionOrEvent(destination.destroyed, destination, "finish", () => resolver.onDataDone(task))
        }
        else if (res.code === 350) { // Restarting at startAt.
            ftp.send("RETR " + remoteFilename)
        }
        else if (positiveCompletion(res.code)) { // Transfer complete
            resolver.onControlDone(task, res)
        }
        else if (positiveIntermediate(res.code)) {
            resolver.onUnexpectedRequest(res)
        }
        // Ignore all other positive preliminary response codes (< 200)
    })
}

/**
 * Calls a function immediately if a condition is met or subscribes to an event and calls
 * it once the event is emitted.
 *
 * @param condition  The condition to test.
 * @param emitter  The emitter to use if the condition is not met.
 * @param eventName  The event to subscribe to if the condition is not met.
 * @param action  The function to call.
 */
function onConditionOrEvent(condition: boolean, emitter: EventEmitter, eventName: string, action: () => void) {
    if (condition === true) {
        action()
    }
    else {
        emitter.once(eventName, () => action())
    }
}
