import { Router, Route } from "@solidjs/router";
import { TestCall } from "./TestCall";
import { TestCall2 } from "./TestCall2";

export default function App() {
  return (
    <Router>
      <Route path="/:streamName?" component={TestCall} />
      <Route path="/test-call2" component={TestCall2} />
    </Router>
  );
}
