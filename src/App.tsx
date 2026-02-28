import { Router, Route } from "@solidjs/router";
import { TestCall3 } from "./TestCall3";
import { TestCall2 } from "./TestCall2";

export default function App() {
  return (
    <Router>
      <Route path="/test-call-2" component={TestCall2} />
      <Route path="/test-call-3" component={TestCall3} />
    </Router>
  );
}
