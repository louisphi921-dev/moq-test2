import * as Control from "./control"
import * as Stream from './stream'
import { Objects } from "./objects"
import { Connection } from "./connection"
import { ClientSetup, ControlMessageType, ServerSetup } from "./control"
import { ImmutableBytesBuffer, ReadableWritableStreamBuffer } from "./buffer"

export interface ClientConfig {
	url: string
	// If set, the server fingerprint will be fetched from this URL.
	// This is required to use self-signed certificates with Chrome (May 2023)
	fingerprint?: string
}

export class Client {
	#fingerprint: Promise<WebTransportHash | undefined>

	readonly config: ClientConfig

	constructor(config: ClientConfig) {
		this.config = config

		this.#fingerprint = this.#fetchFingerprint(config.fingerprint).catch((e) => {
			console.warn("failed to fetch fingerprint: ", e)
			return undefined
		})
	}

	// async connect(): Promise<Connection> {
	// 	const options: WebTransportOptions = {}

	// 	const fingerprint = await this.#fingerprint
	// 	if (fingerprint) options.serverCertificateHashes = [fingerprint]

	// 	const quic = new WebTransport(this.config.url, options)
	// 	await quic.ready

	// 	const stream = await quic.createBidirectionalStream({ sendOrder: Number.MAX_SAFE_INTEGER })

	// 	const buffer = new ReadableWritableStreamBuffer(stream.readable, stream.writable)

	// 	const msg: Control.ClientSetup = {
	// 		versions: [Control.Version.DRAFT_14],
	// 		params: new Map(),
	// 	}
	// 	const serialized = Control.ClientSetup.serialize(msg)
	// 	await buffer.write(serialized)

	// 	// Receive the setup message.
	// 	// TODO verify the SETUP response.
	// 	const server = await this.readServerSetup(buffer)

	// 	if (server.version != Control.Version.DRAFT_14) {
	// 		throw new Error(`unsupported server version: ${server.version}`)
	// 	}

	// 	const control = new Stream.ControlStream(buffer)
	// 	const objects = new Objects(quic)

	// 	return new Connection(quic, control, objects)
	// }

	async connect(): Promise<Connection> {
		console.log("STEP 1: starting connect to", this.config.url);
	  
		const options: WebTransportOptions = {};
	  
		const fingerprint = await this.#fingerprint;
		if (fingerprint) {
		  console.log("STEP 2: fingerprint loaded");
		  options.serverCertificateHashes = [fingerprint];
		} else {
		  console.log("STEP 2: no fingerprint");
		}
	  
		let quic: WebTransport;
	  
		try {
		  console.log("STEP 3: creating WebTransport");
		  quic = new WebTransport(this.config.url, options);
		} catch (e) {
		  console.error("FAILED at STEP 3 (constructor):", e);
		  throw e;
		}
	  
		try {
		  console.log("STEP 4: waiting for quic.ready");
		  await quic.ready;
		  console.log("STEP 4 SUCCESS: WebTransport ready");
		} catch (e) {
		  console.error("FAILED at STEP 4 (ready):", e);
		  throw e;
		}
	  
		let stream;
		try {
		  console.log("STEP 5: creating bidirectional stream");
		  stream = await quic.createBidirectionalStream({
			sendOrder: Number.MAX_SAFE_INTEGER,
		  });
		  console.log("STEP 5 SUCCESS: stream created");
		} catch (e) {
		  console.error("FAILED at STEP 5 (create stream):", e);
		  throw e;
		}
	  
		const buffer = new ReadableWritableStreamBuffer(
		  stream.readable,
		  stream.writable
		);
	  
		try {
		  console.log("STEP 6: sending ClientSetup");
		  const msg: Control.ClientSetup = {
			versions: [Control.Version.DRAFT_14],
			params: new Map(),
		  };
	  
		  const serialized = Control.ClientSetup.serialize(msg);
		  await buffer.write(serialized);
		  console.log("STEP 6 SUCCESS: ClientSetup sent");
		} catch (e) {
		  console.error("FAILED at STEP 6 (write setup):", e);
		  throw e;
		}
	  
		try {
		  console.log("STEP 7: waiting ServerSetup");
		  const server = await this.readServerSetup(buffer);
		  console.log("STEP 7 SUCCESS: received ServerSetup", server);
	  
		  if (server.version != Control.Version.DRAFT_14) {
			throw new Error(`unsupported server version: ${server.version}`);
		  }
	  
		  const control = new Stream.ControlStream(buffer);
		  const objects = new Objects(quic);
	  
		  console.log("STEP 8: connection fully established");
		  return new Connection(quic, control, objects);
		} catch (e) {
		  console.error("FAILED at STEP 7 (read server setup):", e);
		  throw e;
		}
	  }

	async #fetchFingerprint(url?: string): Promise<WebTransportHash | undefined> {
		if (!url) return

		// TODO remove this fingerprint when Chrome WebTransport accepts the system CA
		const response = await fetch(url)
		const hexString = await response.text()

		const hexBytes = new Uint8Array(hexString.length / 2)
		for (let i = 0; i < hexBytes.length; i += 1) {
			hexBytes[i] = parseInt(hexString.slice(2 * i, 2 * i + 2), 16)
		}

		return {
			algorithm: "sha-256",
			value: hexBytes,
		}
	}

	async readServerSetup(buffer: ReadableWritableStreamBuffer): Promise<ServerSetup> {
		const type: ControlMessageType = await buffer.getNumberVarInt()
		if (type !== ControlMessageType.ServerSetup) throw new Error(`server SETUP type must be ${ControlMessageType.ServerSetup}, got ${type}`)

		const advertisedLength = await buffer.getU16()
		const bufferLen = buffer.byteLength
		if (advertisedLength !== bufferLen) {
			throw new Error(`server SETUP message length mismatch: ${advertisedLength} != ${bufferLen}`)
		}

		const payload = await buffer.read(advertisedLength)
		const bufReader = new ImmutableBytesBuffer(payload)
		const msg = ServerSetup.deserialize(bufReader)

		return msg
	}

	async readClientSetup(buffer: ReadableWritableStreamBuffer): Promise<ClientSetup> {
		const type: ControlMessageType = await buffer.getNumberVarInt()
		if (type !== ControlMessageType.ClientSetup) throw new Error(`client SETUP type must be ${ControlMessageType.ClientSetup}, got ${type}`)

		const advertisedLength = await buffer.getU16()
		const bufferLen = buffer.byteLength
		if (advertisedLength !== bufferLen) {
			throw new Error(`client SETUP message length mismatch: ${advertisedLength} != ${bufferLen}`)
		}

		const payload = await buffer.read(advertisedLength)
		const bufReader = new ImmutableBytesBuffer(payload)
		return ClientSetup.deserialize(bufReader)
	}
}
