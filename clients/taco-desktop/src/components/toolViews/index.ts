/**
 * Side-effect entry import — a single import here triggers self-registration
 * of every toolViews/* into the registry. main.tsx imports this to guarantee
 * registration runs before App renders.
 *
 * A file may register a body, a summary, or both; see registry.ts for which
 * card regions are overridable.
 */
import "./agentView";
import "./askUserView";
import "./editView";
import "./planExitView";
import "./readView";
import "./searchView";
import "./shellView";
import "./skillView";
import "./taskView";
