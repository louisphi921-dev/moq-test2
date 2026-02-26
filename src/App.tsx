import { Router, Route } from "@solidjs/router";
import { TestCall } from "./TestCall";

export default function App() {
  return (
    <Router>
      <Route path="/:streamName?" component={TestCall} />
    </Router>
  );
}
