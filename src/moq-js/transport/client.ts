import * as Control from "./control"
import * as Stream from './stream'
import { Objects } from "./objects"
import { Connection } from "./connection"
import { ClientSetup, ControlMessageType, ServerSetup } from "./control"
import { ImmutableBytesBuffer, ReadableWritableStreamBuffer } from "./buffer"

type PerformanceWithMemory = Performance & {
	memory?: {
		usedJSHeapSize: number
		totalJSHeapSize: number
		jsHeapSizeLimit: number
	}
}

let memoryLogStarted = false

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatBytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function formatCloseDetails(value: unknown): string {
	if (!value || typeof value !== "object") {
		return `value=${String(value)}`
	}

	const err = value as Record<string, unknown>
	return [
		`name=${String(err.name ?? "")}`,
		`message=${String(err.message ?? "")}`,
		`source=${String(err.source ?? "")}`,
		`closeCode=${String(err.closeCode ?? err.sessionCloseCode ?? err.streamErrorCode ?? "")}`,
		`reason=${String(err.reason ?? "")}`,
		`stack=${String(err.stack ?? "")}`,
	].join(" ")
}

function startMemoryLogging() {
	if (memoryLogStarted) return
	memoryLogStarted = true

	const perf = performance as PerformanceWithMemory
	if (!perf.memory) {
		console.log("[CONNECT] memory stats unavailable in this browser")
		return
	}

	setInterval(() => {
		const memory = perf.memory
		if (!memory) return

		console.log(
			`[CONNECT] memory used=${formatBytes(memory.usedJSHeapSize)} total=${formatBytes(memory.totalJSHeapSize)} limit=${formatBytes(memory.jsHeapSizeLimit)}`,
		)
	}, 15000)
}

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
		startMemoryLogging()
		console.log(`[CONNECT] starting connect url=${this.config.url}`);
	  
		const options: WebTransportOptions = {};
	  
		const fingerprint = await this.#fingerprint;
		if (fingerprint) {
		  console.log("[CONNECT] fingerprint loaded");
		  options.serverCertificateHashes = [fingerprint];
		} else {
		  console.log("[CONNECT] no fingerprint");
		}
	  
		let quic: WebTransport;
	  
		try {
		  console.log(`[CONNECT] creating WebTransport url=${this.config.url}`);
		  quic = new WebTransport(this.config.url, options);
		} catch (e) {
		  console.error("FAILED at STEP 3 (constructor):", e);
		  throw e;
		}

		const rawClose = quic.close.bind(quic)
		quic.close = ((closeInfo?: WebTransportCloseInfo) => {
		  console.log(
			`[CLOSE] WebTransport.close() local=true closeCode=${closeInfo?.closeCode ?? ""} reason=${closeInfo?.reason ?? "<empty>"}`,
		  )
		  return rawClose(closeInfo)
		}) as typeof quic.close

		void quic.closed
		  .then((info) => {
			console.log(`[CLOSE] WebTransport closed ${formatCloseDetails(info)}`);
		  })
		  .catch((err) => {
			console.error(`[CLOSE] WebTransport closed with error ${formatCloseDetails(err)}`);
		  });
	  
		try {
		  console.log("[CONNECT] waiting for quic.ready");
		  await quic.ready;
		  console.log(`[CONNECT] quic.ready resolved url=${this.config.url}`);
		} catch (e) {
		  console.error("FAILED at STEP 4 (ready):", e);
		  throw e;
		}
	  
		let stream;
		let lastStreamError: unknown;
		for (let attempt = 1; attempt <= 3; attempt += 1) {
		  try {
			console.log(`[STREAM] attempt=${attempt}`);
			stream = await quic.createBidirectionalStream({
			  sendOrder: Number.MAX_SAFE_INTEGER,
			});
			console.log(`[STREAM] attempt=${attempt} succeeded`);
			break;
		  } catch (e) {
			lastStreamError = e;
			const err = e as { name?: string; message?: string };
			console.error(
			  `[STREAM] attempt=${attempt} failed name=${String(err?.name ?? "")} message=${String(err?.message ?? e)}`,
			);
			if (attempt < 3) {
			  await sleep(100);
			}
		  }
		}

		if (!stream) {
		  console.error("FAILED at STEP 5 (create stream):", lastStreamError);
		  throw lastStreamError;
		}
	  
		const buffer = new ReadableWritableStreamBuffer(
		  stream.readable,
		  stream.writable
		);
	  
		try {
		  console.log("[CONNECT] sending ClientSetup");
		  const msg: Control.ClientSetup = {
			versions: [Control.Version.DRAFT_14],
			params: new Map(),
		  };
	  
		  const serialized = Control.ClientSetup.serialize(msg);
		  await buffer.write(serialized);
		  console.log(`[CONNECT] ClientSetup sent versions=${msg.versions.join(",")}`);
		} catch (e) {
		  console.error("FAILED at STEP 6 (write setup):", e);
		  throw e;
		}
	  
		try {
		  console.log("[CONNECT] waiting for ServerSetup");
		  const server = await this.readServerSetup(buffer);
		  console.log(
			`[CONNECT] ServerSetup received version=${server.version} params=${server.params.size}`,
		  );
	  
		  if (server.version != Control.Version.DRAFT_14) {
			throw new Error(`unsupported server version: ${server.version}`);
		  }
	  
		  const control = new Stream.ControlStream(buffer);
		  const objects = new Objects(quic);
	  
		  console.log("[CONNECT] connection fully established");
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
