import {
  Component,
  createSignal,
  onCleanup,
  For,
  Show,
} from "solid-js";
import { useParams } from "@solidjs/router";
import { PublisherApi } from "./moq-js/publish";
import Player from "./moq-js/playback";
import { Client } from "./moq-js/transport/client";
import { PublishNamespaceRecv } from "./moq-js/transport/subscriber";

import type { DiagEvent } from "./types";
import { diagTime, getOrCreateStreamName } from "./helpers";
import { DebugPanel } from "./DebugPanel";

interface RemoteParticipant {
  id: string;
  player: any; // Using any because Player type might be complex to import depending on moq-js
  canvas: HTMLCanvasElement;
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

  const handleNameChange = (value: string) => {
    const clean = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    setRoomName(clean);
    localStorage.setItem("moq-test-stream-name", clean);
  };

  const broadcastId = crypto.randomUUID().slice(0, 8);

  const [connectionStatus, setConnectionStatus] = createSignal("disconnected");
  
  // Media streams
  const [localStream, setLocalStream] = createSignal<MediaStream | null>(null);
  let localVideoRef: HTMLVideoElement | undefined;

  const [publishingVideo, setPublishingVideo] = createSignal(false);
  const [publishingAudio, setPublishingAudio] = createSignal(false);
  const [speakerOn, setSpeakerOn] = createSignal(false);

  let publisher: any = null;
  let announceClient: any = null;
  let announceConnection: any = null;
  let announceLoopRunning = false;

  const [participants, setParticipants] = createSignal<RemoteParticipant[]>([]);

  // We maintain a local stream for the user
  const ensureLocalStream = async () => {
    if (!localStream()) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 640 }, frameRate: { ideal: 30 } },
          audio: { channelCount: { ideal: 1 }, autoGainControl: { ideal: true }, noiseSuppression: { ideal: true }, echoCancellation: { ideal: true } }
        });
        
        // Start muted/paused locally
        stream.getAudioTracks().forEach(t => t.enabled = false);
        stream.getVideoTracks().forEach(t => t.enabled = false);
        
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

    const relayPath = roomName();
    const url = "https://us-east-1.relay.sylvan-b.com/" + relayPath;
    const namespace = [relayPath, broadcastId];
    log("pub", `Starting publisher to ${url} with namespace ${namespace.join("/")}`);

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

    const audioConfig: AudioEncoderConfig = { 
      codec: "opus", 
      sampleRate, 
      numberOfChannels, 
      bitrate: 64000 
    };

    publisher = new PublisherApi({
      url,
      namespace,
      media: stream,
      video: videoConfig,
      audio: audioConfig,
    });

    try {
      await publisher.publish();
      log("pub", "Publishing active");
    } catch (err) {
      console.log("err", err)
      log("pub", `Publish error: ${err}`);
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
    participants().forEach(p => {
        if (p.player && p.player.mute) {
            p.player.mute(!next);
        }
    });
  };

  // Wait for announces
  const runAnnounced = async (relayPath: string) => {
    announceClient = new Client({ url: "https://us-east-1.relay.sylvan-b.com/" + relayPath });
    try {
        announceConnection = await announceClient.connect();
        log("announced", "Announce connection established. Issuing subscribe for namespace " + relayPath);
        
        // Let's assume the relay lets us subscribe to the base namespace to receive publishes
        // or we check publishedNamespaces()
        const watcher = announceConnection.publishedNamespaces();
        announceLoopRunning = true;

        log("announced", "Starting loop to watch publishedNamespaces");
        const scanNamespaces = async () => {
            while (announceLoopRunning) {
                const [namespaces, next] = watcher.value();
                
                if (namespaces) {
                    for (const ns of (namespaces as PublishNamespaceRecv[])) {
                        const nsString = ns.namespace.join("/");
                        // Skip local broadcast object
                        if (nsString === `${relayPath}/${broadcastId}`) continue;

                        if (!participants().find(p => p.id === nsString)) {
                            log("announced", `Discovered new remote namespace: ${nsString}`);
                            subscribeToParticipant(relayPath, nsString);
                        }
                    }
                }

                if (!next) break;
                await next;
            }
        };

        scanNamespaces();
    } catch(e) {
        log("announced", `Failed to connect announce client: ${e}`);
    }
  };

  const subscribeToParticipant = async (relayPath: string, fullNamespaceStr: string) => {
    const namespace = fullNamespaceStr.split("/");
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 640;
    canvas.className = "w-full h-full object-cover rounded-md bg-gray-800";

    log("sub", `Creating player for ${fullNamespaceStr}...`);
    try {
        const player = await Player.create({
            url: "https://us-east-1.relay.sylvan-b.com/" + relayPath,
            namespace: fullNamespaceStr, // The exact player namespace usually uses the namespace join or specific tracks
            canvas: canvas
        }, 0);

        setParticipants(prev => [...prev, { id: fullNamespaceStr, player, canvas }]);
        
        await player.play();
        await player.mute(!speakerOn());
        
        log("sub", `Subscribed to ${fullNamespaceStr}`);

        // Listen for disconnected events or handle cleanup
        // (Assuming player has a mechanism or we monitor it)
    } catch (err) {
        log("sub", `Failed to subscribe to ${fullNamespaceStr}: ${err}`);
    }
  };


  const [joined, setJoined] = createSignal(false);
  const [joining, setJoining] = createSignal(false);

  const handleJoin = async () => {
    setJoining(true);
    setConnectionStatus("connecting");
    
    // We only start the publisher if they have turned on media, otherwise we just start announce client
    if (publishingAudio() || publishingVideo()) {
        await startPublishing();
    }
    
    await runAnnounced(roomName());

    setConnectionStatus("connected");
    setJoined(true);
    setJoining(false);
  };

  const handleLeave = () => {
    announceLoopRunning = false;
    
    if (publisher) {
        publisher.stop();
        publisher = null;
    }
    if (announceConnection) {
        announceConnection.close();
        announceConnection = null;
    }

    for (const p of participants()) {
      if (p.player && p.player.close) {
          p.player.close();
      }
    }
    setParticipants([]);

    setJoined(false);
    setConnectionStatus("disconnected");
    log("conn", "disconnected");
  };

  onCleanup(() => {
    handleLeave();
    if (localStream()) {
        localStream()?.getTracks().forEach(t => t.stop());
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
          <p class="text-gray-400 text-sm">
            Test streaming via MoQ CDN relay
          </p>
        </div>

        <div class="space-y-2">
          <label class="block text-sm font-medium text-gray-400">
            Stream Name
          </label>
          <input
            type="text"
            value={roomName()}
            onInput={(e) => handleNameChange(e.currentTarget.value)}
            class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
            disabled={joined()}
          />
          <p class="text-xs text-gray-500">
            Connects via MoQ CDN (https://us-east-1.relay.sylvan-b.com/). Share this stream name
            with others to test together.
          </p>
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
                    ref={localVideoRef!}
                    autoplay
                    playsinline
                    muted
                    class="w-full h-full object-cover"
                    style={{ transform: 'scaleX(-1)' }}
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
                      <span class="text-[10px] text-gray-400 break-all">{p.id}</span>
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
