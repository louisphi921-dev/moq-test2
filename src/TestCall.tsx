import { Component } from "solid-js";
import { useParams } from "@solidjs/router";

export const TestCall: Component = () => {
  const params = useParams<{ streamName?: string }>();
  return (
    <div class="min-h-screen bg-gray-950 text-white p-6">
      <h1 class="text-2xl font-bold">MoQ Test</h1>
      <p class="text-gray-400">Stream: {params.streamName ?? "none"}</p>
    </div>
  );
};
