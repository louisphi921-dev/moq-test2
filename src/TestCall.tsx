import {
  Component,
  createSignal,
  onCleanup,
  For,
  Show,
  createEffect,
} from "solid-js";
import { useParams } from "@solidjs/router";
import { PublisherApi } from "./moq-js/publish";
import Player from "./moq-js/playback";
import { Client } from "./moq-js/transport/client";
import { Connection } from "./moq-js/transport/connection";

import type { DiagEvent } from "./types";
import { diagTime, getOrCreateStreamName } from "./helpers";
import { DebugPanel } from "./DebugPanel";
import {
  runWebTransportSmokeTest,
  type WebTransportSmokeSummary,
} from "./wt_smoketest";

interface RemoteParticipant {
  id: string;
  player: any;
  canvas: HTMLCanvasElement;
  state: () => {
    muted: boolean;
    paused: boolean;
    videoTrack: string;
  };
}

const AUTO_TEST_MODE = true;
const VIDEO_ONLY_PUBLISH = true;
const MODE_CONNECT_ONLY = "connect-only";
const MODE_NAMESPACE_ONLY = "namespace-only";
const MODE_VIDEO_PUBLISH = "video-publish";
const TEST_MODE = MODE_CONNECT_ONLY;

function defaultSubscribeTarget(username: string): string {
  return username === "user1" ? "user2" : "user1";
}

export const TestCall: Component = () => {
  const [diagLog, setDiagLog] = createSignal<DiagEvent[]>([]);
  const log = (tag: string, msg: string) => {
    const evt = { t: diagTime(), tag, msg };
    console.log(`[${evt.t}ms] [${tag}] ${msg}`);
    setDiagLog((prev) => [evt, ...prev].slice(0, 50));
  };

  const params = useParams<{ streamName?: string }>();
  const urlStream = () =>
    params.streamName?.toLowerCase().replace(/[^a-z0-9-]/g, "");

  const [roomName, setRoomName] = createSignal(
    urlStream() || getOrCreateStreamName(),
  );
  const [yourUsername, setYourUsername] = createSignal("user1");
  const [participantUsername, setParticipantUsername] = createSignal("user2");
  const shouldAutoSubscribe = () =>
    !AUTO_TEST_MODE || yourUsername().trim() !== "user1";
  const subscribeTarget = () =>
    AUTO_TEST_MODE
      ? defaultSubscribeTarget(yourUsername().trim() || "user1")
      : participantUsername().trim();

  const handleNameChange = (value: string) => {
    const clean = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    setRoomName(clean);
    localStorage.setItem("moq-test-stream-name", clean);
  };

  const [connectionStatus, setConnectionStatus] = createSignal("disconnected");

  // Media streams
  const [localStream, setLocalStream] = createSignal<MediaStream | null>(null);
  let localVideoRef: HTMLVideoElement | undefined;

  const [publishingVideo, setPublishingVideo] = createSignal(false);
  const [publishingAudio, setPublishingAudio] = createSignal(false);
  const [speakerOn, setSpeakerOn] = createSignal(false);

  let publisher: any = null;
  let subscribeInterval: any = null;
  let heartbeatInterval: number | null = null;
  let sharedClient: Client | null = null;
  let sharedConnection: Connection | null = null;

  const [participants, setParticipants] = createSignal<RemoteParticipant[]>([]);
  const [wtSmokeRunning, setWtSmokeRunning] = createSignal(false);
  const [wtSmokeSummary, setWtSmokeSummary] =
    createSignal<WebTransportSmokeSummary | null>(null);

  createEffect(() => {
    const stream = localStream();
    if (stream && localVideoRef) {
      localVideoRef.srcObject = stream;
    }
  });

  const setUsernameWithDefaultTarget = (value: string) => {
    const next = value.trim();
    setYourUsername(next);
    if (AUTO_TEST_MODE && !joined()) {
      setParticipantUsername(defaultSubscribeTarget(next || "user1"));
    }
  };

  const ensureConnection = async () => {
    if (!sharedConnection) {
      const relayPath = `${roomName()}/${yourUsername()}`;
      // const relayUrl = `https://us-east-1.relay.sylvan-b.com/${relayPath}`;
      const relayUrl = `https://us-east-1.relay.sylvan-b.com/`;
      log("conn", `Connecting WebTransport to ${relayUrl}...`);
      sharedClient = new Client({ url: relayUrl });
      try {
        sharedConnection = await sharedClient.connect();
      } catch (err) {
        sharedClient = null;
        sharedConnection = null;
        setConnectionStatus("disconnected");
        throw err;
      }
      setConnectionStatus("connected");
      log("conn", "WebTransport connected successfully.");
      const currentConnection = sharedConnection;
      void currentConnection.closed().then((err) => {
        if (sharedConnection === currentConnection) {
          setConnectionStatus("disconnected");
        }
        log("conn", `[CLOSE] Connection.closed() observed: ${err.message}`);
      });
    }
    return sharedConnection;
  };

  const stopHeartbeat = () => {
    if (heartbeatInterval !== null) {
      window.clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  const startHeartbeat = (label: string) => {
    stopHeartbeat();
    const startedAt = performance.now();
    heartbeatInterval = window.setInterval(() => {
      const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `[HEARTBEAT] mode=${label} connected=${connectionStatus() === "connected"} t=${elapsed}s`,
      );
      if (performance.now() - startedAt >= 10_000) {
        stopHeartbeat();
      }
    }, 1000);
  };

  const runWtSmokeTest = async () => {
    if (wtSmokeRunning()) return;

    setWtSmokeRunning(true);
    setWtSmokeSummary(null);
    log("wt", "[WT] starting sequential smoketest attempts=20 timeout_ms=3000");

    try {
      const result = await runWebTransportSmokeTest((message) =>
        log("wt", message),
      );
      setWtSmokeSummary(result.summary);
    } catch (err) {
      log("wt", `[WT] smoketest runner failed: ${String(err)}`);
    } finally {
      setWtSmokeRunning(false);
    }
  };

  // We maintain a local stream for the user
  const ensureLocalStream = async () => {
    if (!localStream()) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 640 },
            frameRate: { ideal: 30 },
          },
          audio: {
            channelCount: { ideal: 1 },
            autoGainControl: { ideal: true },
            noiseSuppression: { ideal: true },
            echoCancellation: { ideal: true },
          },
        });

        // Start muted/paused locally
        stream.getAudioTracks().forEach((t) => (t.enabled = false));
        stream.getVideoTracks().forEach((t) => (t.enabled = false));

        setLocalStream(stream);
        if (localVideoRef) {
          localVideoRef.srcObject = stream;
        }
      } catch (err) {
        log("media", `Failed to get user media: ${err}`);
      }
    }
    return localStream();
  };

  // Publisher Logic
  const startPublishing = async () => {
    const stream = await ensureLocalStream();
    if (!stream) return;

    if (publisher) {
      publisher.stop();
    }

    let connection: Connection | null = null;
    try {
      connection = await ensureConnection();
    } catch (e) {
      log("pub", `Failed to get connection: ${e}`);
      return;
    }

    const relayPath = `${roomName()}/${yourUsername()}`;
    // const relayUrl = `https://us-east-1.relay.sylvan-b.com/${relayPath}`;
    const relayUrl = `https://us-east-1.relay.sylvan-b.com/`;
    const namespace = ["anon", roomName(), yourUsername()];
    const publishTracks = VIDEO_ONLY_PUBLISH
      ? stream.getVideoTracks()
      : stream.getTracks();
    const publishStream = new MediaStream(publishTracks);
    log(
      "pub",
      `Starting publisher to ${relayUrl} with namespace ${namespace.join("/")}`,
    );
    if (VIDEO_ONLY_PUBLISH) {
      log("pub", "[PUB] video-only publish mode enabled");
    }

    const videoConfig: VideoEncoderConfig = {
      codec: "avc1.42E01E", // H.264
      width: 640,
      height: 640,
      bitrate: 1000000,
      framerate: 30,
    };

    const audioTrack = stream.getAudioTracks()[0];
    const settings = audioTrack?.getSettings();
    const sampleRate = settings?.sampleRate ?? 48000;
    const numberOfChannels = settings?.channelCount ?? 1;

    const audioConfig: AudioEncoderConfig | undefined = VIDEO_ONLY_PUBLISH
      ? undefined
      : {
          codec: "opus",
          sampleRate,
          numberOfChannels,
          bitrate: 64000,
        };

    publisher = new PublisherApi({
      url: relayUrl,
      namespace,
      media: publishStream,
      video: videoConfig,
      audio: audioConfig,
      connection: connection,
    });

    try {
      await publisher.publish();
      console.log(`[PUB] publish started namespace=${namespace.join("/")}`);
      log("pub", `[PUB] publish started namespace=${namespace.join("/")}`);
      // debugCheckSelfSubscribe()
      log("pub", "Publishing active");
    } catch (err) {
      console.log("err", err);
      log("pub", `Publish error: ${err}`);
    }
  };

  const startNamespaceOnly = async () => {
    let connection: Connection | null = null;
    try {
      connection = await ensureConnection();
    } catch (e) {
      log("pub", `Failed to get connection: ${e}`);
      return;
    }

    const namespace = ["anon", roomName(), "user1"];
    log("pub", `[PUB] namespace-only mode starting namespace=${namespace.join("/")}`);

    try {
      const publishedNamespace = await connection.publish_namespace(namespace);
      log("pub", `[PUB] PublishNamespace sent namespace=${namespace.join("/")}`);
      await publishedNamespace.ok();
      log("pub", `[PUB] PublishNamespaceOk received namespace=${namespace.join("/")}`);
    } catch (err) {
      log("pub", `Namespace-only publish error: ${err}`);
    }
  };

  const toggleVideo = async () => {
    const stream = await ensureLocalStream();
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (track) {
      const next = !publishingVideo();
      track.enabled = next;
      setPublishingVideo(next);
      log("track", `video ${next ? "ON" : "OFF"}`);
      // If we joined but haven't published yet
      if (joined() && !publisher && (next || publishingAudio())) {
        startPublishing();
      }
    }
  };

  const toggleAudio = async () => {
    const stream = await ensureLocalStream();
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (track) {
      const next = !publishingAudio();
      track.enabled = next;
      setPublishingAudio(next);
      log("track", `mic ${next ? "ON" : "OFF"}`);
      // If we joined but haven't published yet
      if (joined() && !publisher && (next || publishingVideo())) {
        startPublishing();
      }
    }
  };

  const toggleSpeaker = () => {
    const next = !speakerOn();
    setSpeakerOn(next);
    log("track", `speaker ${next ? "ON" : "OFF"}`);

    // Mute/unmute all participant players
    participants().forEach((p) => {
      if (p.player && p.player.mute) {
        p.player.mute(!next);
      }
    });
  };

  const subscribeToParticipant = async () => {
    const targetUser = subscribeTarget();
    const targetNamespace = ["anon", roomName(), targetUser];
    const fullNamespaceStr = targetNamespace.join("/");

    if (participants().find((p) => p.id === fullNamespaceStr)) {
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 640;
    canvas.className = "w-full h-full object-cover rounded-md bg-gray-800";

    const relayPath = `${roomName()}/${targetUser}`;
    // const relayUrl = `https://us-east-1.relay.sylvan-b.com/${relayPath}`;
    const relayUrl = `https://us-east-1.relay.sylvan-b.com/`;

    let connection: Connection | null = null;
    try {
      connection = await ensureConnection();
    } catch (e) {
      log("sub", `Failed to connect before subscribing: ${e}`);
      return;
    }

      log("sub", `Creating player for ${fullNamespaceStr}...`);

    try {
      const player = await Player.create(
        {
          url: relayUrl,
          namespace: fullNamespaceStr,
          canvas: canvas,
          connection: connection,
        },
        0,
      );

      const [state, setState] = createSignal({
        muted: player.muted,
        paused: player.isPaused(),
        videoTrack: player.videoTrackName,
      });

      player.addEventListener("play", () => {
        setState((s) => ({ ...s, paused: false }));
      });

      player.addEventListener("pause", () => {
        setState((s) => ({ ...s, paused: true }));
      });

      player.addEventListener("volumechange", (e: any) => {
        setState((s) => ({ ...s, muted: e.detail.muted }));
      });

      setParticipants((prev) => [
        ...prev,
        { id: fullNamespaceStr, player, canvas, state },
      ]);

      await player.play();
      await player.mute(!speakerOn());

      log("sub", `Subscribed to ${fullNamespaceStr}`);
    } catch (err: any) {
      if (err?.message?.includes("no catalog data")) {
        log(
          "sub",
          `Participant ${targetUser} has not published yet.`,
        );
      } else {
        log("sub", `Failed to subscribe: ${err}`);
      }
    }
  };
  const [joined, setJoined] = createSignal(false);
  const [joining, setJoining] = createSignal(false);

  const handleJoin = async () => {
    if (!yourUsername() || !subscribeTarget()) {
      alert("Please enter both your username and participant username.");
      return;
    }

    setJoining(true);
    setConnectionStatus("connecting");
    let didConnect = false;

    if (TEST_MODE === MODE_CONNECT_ONLY) {
      try {
        await ensureConnection();
        didConnect = true;
        log("conn", "Connect-only mode ready.");
      } catch (e) {
        setConnectionStatus("disconnected");
        log("conn", `Connect-only error: ${e}`);
      }
    } else if (TEST_MODE === MODE_NAMESPACE_ONLY) {
      await startNamespaceOnly();
    } else if (AUTO_TEST_MODE && yourUsername().trim() === "user1") {
      const stream = await ensureLocalStream();
      if (stream) {
        stream.getAudioTracks().forEach((track) => {
          track.enabled = !VIDEO_ONLY_PUBLISH;
        });
        stream.getVideoTracks().forEach((track) => {
          track.enabled = true;
        });
        setPublishingAudio(!VIDEO_ONLY_PUBLISH);
        setPublishingVideo(true);
      }
      await startPublishing();
    } else if (TEST_MODE === MODE_VIDEO_PUBLISH && (publishingAudio() || publishingVideo())) {
      // We only start the publisher if they have turned on media, otherwise we just start announce client
      await startPublishing();
    }

    if (TEST_MODE === MODE_VIDEO_PUBLISH && shouldAutoSubscribe()) {
      try {
        subscribeToParticipant();
      } catch {
        setTimeout(() => {
          if (joined()) subscribeToParticipant();
        }, 5000);
      }
    } else {
      log("sub", `Mode ${TEST_MODE}: no auto-subscribe.`);
    }

    startHeartbeat(TEST_MODE);
    setJoined(didConnect);
    setJoining(false);
  };

  const debugCheckSelfSubscribe = async () => {
    const namespace = ["anon", roomName(), yourUsername()];
    const full = namespace.join("/");

    try {
      const player = await Player.create(
        {
          url: "",
          namespace: full,
          canvas: document.createElement("canvas"),
          connection: await ensureConnection(),
        },
        0,
      );

      console.log("✅ Relay HAS catalog for", full);
      await player.close();
    } catch (e) {
      console.log("❌ Relay has NO catalog for", full);
    }
  };

  const handleLeave = () => {
    stopHeartbeat();
    if (subscribeInterval) {
      clearInterval(subscribeInterval);
      subscribeInterval = null;
    }
    if (publisher) {
      publisher.stop();
      publisher = null;
    }

    for (const p of participants()) {
      if (p.player && p.player.close) {
        p.player.close();
      }
    }
    setParticipants([]);

    if (sharedConnection) {
      sharedConnection.close();
      sharedConnection = null;
      sharedClient = null;
    }

    setJoined(false);
    setConnectionStatus("disconnected");
    log("conn", "disconnected");
  };

  onCleanup(() => {
    handleLeave();
    if (localStream()) {
      localStream()
        ?.getTracks()
        .forEach((t) => t.stop());
    }
  });

  // RMS Analyzers
  const [pubRms, setPubRms] = createSignal(0);
  const [subRms, setSubRms] = createSignal(0);
  // (Simplified since moq-js abstracts WebCodecs audio, we can't easily hook AnalyserNode to the Publisher side easily without wrapping it before it goes into MediaStream)
  // We'll leave RMS at 0 for now as it's purely diagnostic.

  return (
    <div class="min-h-screen bg-gray-950 text-white p-6">
      <div class="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 class="text-2xl font-bold">MoQ Interop Test</h1>
          <p class="text-gray-400 text-sm">Test streaming via MoQ CDN relay</p>
        </div>

        <div class="space-y-4">
          <div class="space-y-2">
            <label class="block text-sm font-medium text-gray-400">
              Room Name
            </label>
            <input
              type="text"
              value={roomName()}
              onInput={(e) => handleNameChange(e.currentTarget.value)}
              class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
              disabled={joined()}
            />
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <label class="block text-sm font-medium text-gray-400">
                Your Username
              </label>
              <input
                type="text"
                value={yourUsername()}
                onInput={(e) =>
                  setUsernameWithDefaultTarget(e.currentTarget.value)
                }
                class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
                disabled={joined()}
                placeholder="e.g. user1"
              />
            </div>
            <div class="space-y-2">
              <label class="block text-sm font-medium text-gray-400">
                Participant Username
              </label>
              <input
                type="text"
                value={AUTO_TEST_MODE ? subscribeTarget() : participantUsername()}
                onInput={(e) =>
                  setParticipantUsername(e.currentTarget.value.trim())
                }
                class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
                disabled={joined() || AUTO_TEST_MODE}
                placeholder="e.g. user2"
              />
            </div>
          </div>
          <p class="text-xs text-gray-500">
            Test mode: publishing as <code>{yourUsername()}</code>, subscribing
            to{" "}
            <code>{shouldAutoSubscribe() ? subscribeTarget() : "none"}</code>.
          </p>
          <p class="text-xs text-gray-500">
            Bisection mode: <code>{TEST_MODE}</code>
          </p>
          <p class="text-xs text-gray-500">
            Connects via MoQ CDN (https://us-east-1.relay.sylvan-b.com/).
          </p>
          <div class="flex items-center gap-3">
            <button
              class="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={runWtSmokeTest}
              disabled={wtSmokeRunning()}
            >
              {wtSmokeRunning() ? "Running WT Smoketest..." : "Run WT Smoketest"}
            </button>
            <Show when={wtSmokeSummary()}>
              {(summary) => (
                <p class="text-xs text-gray-400">
                  success={summary().successCount} fail={summary().failureCount} avg=
                  {summary().averageLatencyMs ?? "n/a"}ms p95=
                  {summary().p95LatencyMs ?? "n/a"}ms
                </p>
              )}
            </Show>
          </div>
        </div>

        <Show
          when={joined()}
          fallback={
            <button
              class="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              onClick={handleJoin}
              disabled={joining()}
            >
              <Show when={joining()}>
                <span class="loading loading-spinner loading-sm" />
              </Show>
              {joining() ? "Connecting..." : "Join"}
            </button>
          }
        >
          <div class="flex items-center gap-2">
            <button
              class={`px-4 py-2 rounded font-medium text-sm ${
                publishingAudio()
                  ? "bg-green-600 hover:bg-green-700"
                  : "bg-gray-700 hover:bg-gray-600"
              }`}
              onClick={toggleAudio}
            >
              Mic
            </button>
            <button
              class={`px-4 py-2 rounded font-medium text-sm ${
                publishingVideo()
                  ? "bg-green-600 hover:bg-green-700"
                  : "bg-gray-700 hover:bg-gray-600"
              }`}
              onClick={toggleVideo}
            >
              Cam
            </button>
            <button
              class={`px-4 py-2 rounded font-medium text-sm ${
                speakerOn()
                  ? "bg-green-600 hover:bg-green-700"
                  : "bg-gray-700 hover:bg-gray-600"
              }`}
              onClick={toggleSpeaker}
            >
              Spkr
            </button>
            <button
              class="px-4 py-2 bg-red-600 hover:bg-red-700 rounded font-medium text-sm"
              onClick={handleLeave}
            >
              Leave
            </button>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div class="relative aspect-video rounded-md overflow-hidden bg-gray-800">
              <Show
                when={publishingVideo()}
                fallback={
                  <div class="flex items-center justify-center h-full text-gray-500">
                    Video Paused
                  </div>
                }
              >
                <video
                  ref={(el) => {
                    localVideoRef = el;
                    const stream = localStream();
                    if (stream) {
                      el.srcObject = stream;
                      el.play().catch(() => {});
                    }
                  }}
                  autoplay
                  playsinline
                  muted
                  class="w-full h-full object-cover"
                  style={{ transform: "scaleX(-1)" }}
                />
              </Show>
              <div class="absolute bottom-2 left-2 bg-black/60 px-2 py-1 rounded text-xs">
                You
              </div>
            </div>
            <For each={participants()}>
              {(p) => {
                return (
                  <div class="relative aspect-video rounded-md overflow-hidden bg-gray-800">
                    {p.canvas}
                    <div class="absolute bottom-2 left-2 bg-black/60 px-2 py-1 rounded text-xs flex flex-col">
                      <span>Participant</span>

                      <span class="text-[10px] text-gray-400 break-all">
                        {p.id}
                      </span>

                      <span class="text-[10px] text-green-400">
                        Video: {p.state().videoTrack || "none"}
                      </span>

                      <span class="text-[10px] text-yellow-400">
                        Muted: {p.state().muted ? "Yes" : "No"}
                      </span>

                      <span class="text-[10px] text-blue-400">
                        {p.state().paused ? "Paused" : "Playing"}
                      </span>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>

          <DebugPanel
            connectionStatus={() => connectionStatus()}
            roomName={roomName}
            publishingAudio={publishingAudio}
            speakerOn={speakerOn}
            participantCount={() => participants().length}
            pubRms={pubRms}
            subRms={subRms}
            diagLog={diagLog}
          />
        </Show>
      </div>
    </div>
  );
};
