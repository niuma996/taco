/**
 * Side-effect entry import — a single import here triggers self-registration
 * of every toolViews/* into the registry. main.tsx imports this to guarantee
 * registration runs before App renders.
 */
import "./agentView";
import "./askUserView";
import "./editView";
import "./planExitView";
import "./shellView";
