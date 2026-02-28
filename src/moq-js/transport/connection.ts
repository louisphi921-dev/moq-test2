import * as Control from "./control"
import { Objects } from "./objects"
import { asError } from "../common/error"
import { ControlStream } from "./stream"

import { Publisher } from "./publisher"
import { Subscriber } from "./subscriber"

function formatCloseContext(reason: unknown) {
	if (!reason || typeof reason !== "object") {
		return `value=${String(reason)}`
	}

	const err = reason as Record<string, unknown>
	return [
		`name=${String(err.name ?? "")}`,
		`message=${String(err.message ?? "")}`,
		`closeCode=${String(err.closeCode ?? err.sessionCloseCode ?? "")}`,
		`reason=${String(err.reason ?? "")}`,
		`source=${String(err.source ?? "")}`,
		`stack=${String(err.stack ?? "")}`,
	].join(" ")
}

export class Connection {
	// The established WebTransport session.
	#quic: WebTransport

	// Use to receive/send control messages.
	#controlStream: ControlStream

	// Use to receive/send objects.
	#objects: Objects

	// Module for contributing tracks.
	#publisher: Publisher

	// Module for distributing tracks.
	#subscriber: Subscriber

	// Async work running in the background
	#running: Promise<void>

	constructor(quic: WebTransport, stream: ControlStream, objects: Objects) {
		this.#quic = quic
		this.#controlStream = stream
		this.#objects = objects

		this.#publisher = new Publisher(this.#controlStream, this.#objects)
		this.#subscriber = new Subscriber(this.#controlStream, this.#objects)

		this.#running = this.#run()
	}

	close(code = 0, reason = "") {
		console.log(
			`[CLOSE] Connection.close() local=true code=${code} reason=${reason || "<empty>"}`,
		)
		this.#quic.close({ closeCode: code, reason })
	}

	async #run(): Promise<void> {
		await Promise.all([this.#runControl(), this.#runObjects()])
	}

	publish_namespace(namespace: string[]) {
		return this.#publisher.publish_namespace(namespace)
	}

	publishedNamespaces() {
		return this.#subscriber.publishedNamespaces()
	}

	subscribe(namespace: string[], track: string) {
		return this.#subscriber.subscribe(namespace, track)
	}

	unsubscribe(track: string) {
		return this.#subscriber.unsubscribe(track)
	}

	subscribed() {
		return this.#publisher.subscribed()
	}

	async #runControl() {
		// Receive messages until the connection is closed.
		try {
			console.log("starting control loop")
			for (; ;) {
				const msg = await this.#controlStream.recv()
				await this.#recv(msg)
			}
		} catch (e) {
			console.error(`[CLOSE] Error in control stream: ${formatCloseContext(e)}`)
			throw e
		}
	}

	async #runObjects() {
		try {
			console.log("starting object loop")
			for (; ;) {
				const obj = await this.#objects.recv()
				console.log("object loop got obj", obj)
				if (!obj) break

				await this.#subscriber.recvObject(obj)
			}
		} catch (e) {
			console.error(`[CLOSE] Error in object stream: ${formatCloseContext(e)}`)
			throw e
		}
	}

	async #recv(msg: Control.MessageWithType) {
		if (Control.isPublisher(msg.type)) {
			await this.#subscriber.recv(msg)
		} else {
			await this.#publisher.recv(msg)
		}
	}

	async closed(): Promise<Error> {
		try {
			await this.#running
			return new Error("closed")
		} catch (e) {
			return asError(e)
		}
	}
}
